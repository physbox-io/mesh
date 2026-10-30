/**
 * Catches a headless run that blew up without going non-finite.
 *
 * MuJoCo only resets a model whose state passes mjMAXVAL; short of that, a
 * contact solver that pumps energy in looks like a normal run. A box on a
 * frictionless ramp was thrown 1.8 m up spinning at 115 rad/s, a lever's load
 * was launched 283 m, and both replies said `truncated: false` with no
 * warning.
 *
 * The test is the work the constraint forces do. Contacts, joint stops, pins
 * and welds can store a little energy (they are soft) and give it back, and
 * friction takes it away, but they cannot add it: whatever motors, scripts or
 * wind do, `qfrc_constraint . qvel` integrated over a run stays at or below
 * zero, give or take what a squashed contact holds. When it climbs past the
 * energy it would take to lift every moving body a quarter of the scene's size, the
 * solver is making energy, and the run says so. Worker-safe: no store, no DOM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mj = any;
type Model = any;
type Data = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SolverEnergyGain {
  /** Work the constraint forces had done when it passed the limit, in joules. */
  gainedJ: number;
  /** The limit: lifting every moving body through a quarter of the scene's extent, in joules. */
  limitJ: number;
  tick: number;
  timeS: number;
  /** The body moving fastest at that tick. */
  body: string;
  speedMS: number;
}

const round = (v: number, sig = 3) => (Number.isFinite(v) && v !== 0 ? +v.toPrecision(sig) : v);

export function createSolverWorkMonitor(mj: Mj, model: Model) {
  const nv: number = model.nv;
  const nbody: number = model.nbody;
  const weld = model.body_weldid;
  const mass = model.body_mass;
  let movingMass = 0;
  for (let b = 1; b < nbody; b++) if (weld[b] !== 0) movingMass += mass[b];
  let extent = 1;
  try { extent = model.stat?.extent || 1; } catch { /* keep 1 m */ }
  const g = model.opt?.gravity;
  const gravity = g ? Math.hypot(g[0], g[1], g[2]) : 9.81;
  // Lifting everything that moves through a quarter of the scene's size, or
  // (with no gravity) moving it that far in a second. Across every preset the
  // most a run reached was 4% of this, the bouncing balls and the rope bridge.
  const limitJ = (movingMass * (gravity * extent + extent * extent)) / 4;

  const before = new Float64Array(nv);
  let work = 0;
  let tick = 0;
  let found: SolverEnergyGain | null = null;

  const fastestBody = (data: Data) => {
    const cvel = data.cvel;
    let best = 0, id = -1;
    for (let b = 1; b < nbody; b++) {
      const s = Math.hypot(cvel[b * 6 + 3], cvel[b * 6 + 4], cvel[b * 6 + 5]);
      if (s > best) { best = s; id = b; }
    }
    let name = id > 0 ? `body ${id}` : 'none';
    try { if (id > 0) name = mj.mj_id2name(model, mj.mjtObj?.mjOBJ_BODY?.value ?? 1, id) || name; } catch { /* keep */ }
    return { name, speed: best };
  };

  return {
    /** Call just before mj_step. */
    before(data: Data) {
      if (found || nv === 0) return;
      const qvel = data.qvel;
      for (let i = 0; i < nv; i++) before[i] = qvel[i];
    },
    /** Call just after mj_step, with the step's timestep. */
    after(data: Data, dt: number) {
      tick++;
      if (found || nv === 0 || !(movingMass > 0)) return;
      const f = data.qfrc_constraint;
      const qvel = data.qvel;
      let p = 0;
      for (let i = 0; i < nv; i++) p += f[i] * (before[i] + qvel[i]) * 0.5;
      if (!Number.isFinite(p)) return;
      work += p * dt;
      if (work > limitJ) {
        const fast = fastestBody(data);
        found = { gainedJ: round(work), limitJ: round(limitJ), tick, timeS: round(data.time, 4), body: fast.name, speedMS: round(fast.speed) };
      }
    },
    result(): SolverEnergyGain | null { return found; },
  };
}

/** The warning a run with an energy gain carries. */
export function solverEnergyWarning(gain: SolverEnergyGain): string {
  return `The simulation blew up without going non-finite: by tick ${gain.tick} (t=${gain.timeS} s) the contacts and ` +
    `constraints had put ${gain.gainedJ} J into the scene, more than lifting every moving body through a quarter of its size ` +
    `(${gain.limitJ} J), and "${gain.body}" was moving at ${gain.speedMS} m/s. Contacts cannot add energy, so the ` +
    'trajectory from there on is the solver failing, not physics. Usual causes: a friction coefficient at or near 0 ' +
    'with condim 3, bodies that start deeply overlapping, or a part far lighter than what it is pressed against.';
}
