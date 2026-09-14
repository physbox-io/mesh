// What `physics_run_headless` promises about its frames.
//
// The bug this suite exists for: a 4000-tick run on a scene whose bodies each
// carry a per-tick control script came back claiming ticksSimulated: 4000, but
// its frames only reached t = 0.637s, were ~157 ticks apart instead of the
// requested 1000, and on one run were not even in ascending time order
// (0.001, 0.478, 0.117).
//
// None of that was a cap, a race, or a throwing script. MuJoCo's mj_step calls
// mj_checkPos/mj_checkVel/mj_checkAcc, and when the state exceeds mjMAXVAL those
// call mj_resetData: the model silently goes back to qpos0 and data.time goes
// back to 0, with no exception and no NaN left behind to detect. The old loop
// (src/workers/physicsWorker.ts) kept stepping and kept pushing frames, so the
// trajectory was several restarted runs concatenated — hence repeated and
// decreasing times — while its `ticksSimulated: trajectory.length` was
// technically the requested count and therefore actively misleading.
//
// The first block drives the extracted loop against a fake integrator; the last
// one reproduces the divergence in real MuJoCo.

import { describe, it, expect } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import {
  runHeadlessLoop,
  MAX_HEADLESS_FRAMES,
  type HeadlessLoopHooks,
} from '../src/store/physicsWorkerClient';

/**
 * A fake integrator: advances `time` by dt each step, and can be told to fall
 * over the way MuJoCo does — resetting its clock to 0 at a given tick, or going
 * non-finite.
 */
const fakeSim = (opts: { dt?: number; resetAt?: number; nanAt?: number } = {}) => {
  const dt = opts.dt ?? 0.001;
  let time = 0;
  let tick = 0;
  let bad = false;
  const hooks: HeadlessLoopHooks<{ time: number; tick: number }> = {
    step: () => {
      tick++;
      if (opts.nanAt !== undefined && tick >= opts.nanAt) bad = true;
      if (opts.resetAt !== undefined && tick % opts.resetAt === 0) time = dt;
      else time += dt;
    },
    time: () => time,
    isBad: () => bad,
    sample: () => ({ time, tick }),
  };
  return hooks;
};

describe('runHeadlessLoop — frame spacing', () => {
  it('simulates every requested tick and keeps every frame at stride 1', () => {
    const out = runHeadlessLoop({ ticks: 10 }, fakeSim());
    expect(out.ticksSimulated).toBe(10);
    expect(out.truncated).toBe(false);
    expect(out.frames.map(f => f.tick)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(out.frames.map(f => +f.time.toFixed(3))).toEqual([
      0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.010,
    ]);
  });

  it('keeps frames exactly `stride` ticks apart, plus the final tick', () => {
    const out = runHeadlessLoop({ ticks: 4000, stride: 1000 }, fakeSim());

    expect(out.ticksSimulated).toBe(4000);
    // The reported bug: five frames 157 ticks apart. These are 1000 apart.
    expect(out.frames.map(f => f.tick)).toEqual([1, 1001, 2001, 3001, 4000]);
    const gaps = out.frames.slice(1, -1).map((f, i) => f.tick - out.frames[i].tick);
    expect(new Set(gaps)).toEqual(new Set([1000]));
    // ...and the whole 4000ms of simulated time is actually covered.
    expect(out.frames[out.frames.length - 1].time).toBeCloseTo(4.0, 9);
  });

  it('always includes the final tick even when stride does not divide the run', () => {
    const out = runHeadlessLoop({ ticks: 10, stride: 4 }, fakeSim());
    expect(out.frames.map(f => f.tick)).toEqual([1, 5, 9, 10]);
  });

  it('does not duplicate the final tick when stride lands on it', () => {
    const out = runHeadlessLoop({ ticks: 9, stride: 4 }, fakeSim());
    expect(out.frames.map(f => f.tick)).toEqual([1, 5, 9]);
  });

  it('treats a nonsense stride as 1 rather than dropping every frame', () => {
    for (const stride of [0, -5, NaN, 0.4]) {
      const out = runHeadlessLoop({ ticks: 3, stride }, fakeSim());
      expect(out.frames.map(f => f.tick)).toEqual([1, 2, 3]);
    }
  });

  it('returns nothing at all for a zero-tick run', () => {
    const out = runHeadlessLoop({ ticks: 0 }, fakeSim());
    expect(out).toEqual({ frames: [], ticksSimulated: 0, truncated: false });
  });
});

describe('runHeadlessLoop — time ordering', () => {
  it('emits frames in strictly ascending time order', () => {
    const out = runHeadlessLoop({ ticks: 500, stride: 7 }, fakeSim());
    for (let i = 1; i < out.frames.length; i++) {
      expect(out.frames[i].time).toBeGreaterThan(out.frames[i - 1].time);
    }
  });

  it('stops at the tick where simulated time stops advancing', () => {
    // MuJoCo's auto-reset, exactly: at tick 600 the clock jumps back to dt.
    const out = runHeadlessLoop({ ticks: 4000, stride: 1000 }, fakeSim({ resetAt: 600 }));

    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe('diverged');
    expect(out.truncationDetail).toMatch(/unstable at tick 600/);
    // The honest count: 599 ticks of forward progress, not 4000.
    expect(out.ticksSimulated).toBe(599);
    // And nothing from the restarted run leaked into the frames.
    expect(out.frames.map(f => f.tick)).toEqual([1]);
    for (let i = 1; i < out.frames.length; i++) {
      expect(out.frames[i].time).toBeGreaterThan(out.frames[i - 1].time);
    }
  });

  it('never reports the requested tick count for a run that stopped early', () => {
    const out = runHeadlessLoop({ ticks: 4000 }, fakeSim({ resetAt: 600 }));
    expect(out.ticksSimulated).not.toBe(4000);
    expect(out.ticksSimulated).toBeLessThan(4000);
  });

  it('stops and says so when the state goes non-finite', () => {
    const out = runHeadlessLoop({ ticks: 100, stride: 10 }, fakeSim({ nanAt: 42 }));
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe('nan');
    expect(out.ticksSimulated).toBe(41);
    expect(out.frames.every(f => f.tick <= 41)).toBe(true);
  });
});

describe('runHeadlessLoop — payload cap', () => {
  it('caps kept frames and admits it instead of silently reporting the request', () => {
    const out = runHeadlessLoop({ ticks: 100, maxFrames: 10 }, fakeSim());
    expect(out.frames).toHaveLength(10);
    expect(out.truncated).toBe(true);
    expect(out.truncationReason).toBe('frame-cap');
    expect(out.truncationDetail).toMatch(/stride/);
    expect(out.ticksSimulated).toBe(11);
    expect(out.ticksSimulated).not.toBe(100);
  });

  it('has a default cap a normal run never hits', () => {
    const out = runHeadlessLoop({ ticks: 5000, stride: 10 }, fakeSim());
    expect(out.frames.length).toBeLessThan(MAX_HEADLESS_FRAMES);
    expect(out.truncated).toBe(false);
  });
});

// --- The real thing -------------------------------------------------------

const stableXml = `<mujoco>
  <option integrator="implicitfast" timestep="0.001" gravity="0 0 -9.81"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="ball" pos="0 0 1">
      <freejoint name="fj"/>
      <geom name="ballgeom" type="sphere" size="0.1"/>
    </body>
  </worldbody>
</mujoco>`;

/** Hooks shaped exactly like the worker's, over a real MjModel/MjData. */
const mujocoHooks = async (xml: string, perTickForce?: number) => {
  const mujoco = await load_mujoco();
  const model = mujoco.MjModel.from_xml_string(xml);
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  const hooks: HeadlessLoopHooks<{ time: number }> = {
    step: () => {
      data.xfrc_applied.fill(0);
      data.qfrc_applied.fill(0);
      if (perTickForce) {
        // Stands in for a control script's api.applyForce/applyTorque.
        data.xfrc_applied[1 * 6 + 0] = perTickForce;
        data.xfrc_applied[1 * 6 + 4] = perTickForce;
      }
      mujoco.mj_step(model, data);
    },
    time: () => data.time,
    isBad: () => !Number.isFinite(data.qpos[0]),
    sample: () => ({ time: data.time }),
  };
  return { hooks, dispose: () => { data.delete(); model.delete(); } };
};

describe('runHeadlessLoop over real MuJoCo', () => {
  it('covers the full requested span of a stable scene', async () => {
    const { hooks, dispose } = await mujocoHooks(stableXml);
    try {
      const out = runHeadlessLoop({ ticks: 4000, stride: 1000 }, hooks);
      expect(out.truncated).toBe(false);
      expect(out.ticksSimulated).toBe(4000);
      expect(out.frames).toHaveLength(5);
      expect(out.frames[0].time).toBeCloseTo(0.001, 6);
      expect(out.frames[4].time).toBeCloseTo(4.0, 6);
      for (let i = 1; i < out.frames.length; i++) {
        expect(out.frames[i].time).toBeGreaterThan(out.frames[i - 1].time);
      }
    } finally { dispose(); }
  });

  it('catches MuJoCo silently resetting a diverging scene mid-run', async () => {
    // A per-tick force big enough to blow the integrator up — the shape of the
    // scene that produced the original bug report.
    const { hooks, dispose } = await mujocoHooks(stableXml, 1e12);
    try {
      const out = runHeadlessLoop({ ticks: 4000, stride: 1000 }, hooks);

      // Without the monotonic-time check this returned 4000 "successful" ticks
      // whose times restarted from zero over and over.
      expect(out.truncated).toBe(true);
      expect(out.truncationReason).toBe('diverged');
      expect(out.ticksSimulated).toBeLessThan(4000);
      expect(hooks.isBad()).toBe(false); // the giveaway: no NaN to find
      for (let i = 1; i < out.frames.length; i++) {
        expect(out.frames[i].time).toBeGreaterThan(out.frames[i - 1].time);
      }
    } finally { dispose(); }
  });
});
