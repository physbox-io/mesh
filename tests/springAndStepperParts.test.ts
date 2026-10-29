/**
 * Springs and steppers from physics_add_hardware:
 * - a spring re-sized after it was added rests at its new free length, with
 *   the builder's range (it kept the default's 30 mm and moved its range up);
 * - a sprung part holds a load on what it stands on (a 1 kg box put a
 *   Ø20×60 spring's 5 g seat through a 10 mm plate in 3 s);
 * - a part placed `at` a point is put there, and `into` a body with no cut
 *   for it is fixed to that body (a stepper arrived free, to be welded by hand).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

import { compileToMJCF } from '../src/utils/mjcf';
import { hardwarePartNode, rebuildPart } from '../src/utils/hardwareParts';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
let useStore: any;
beforeAll(async () => {
  mj = await load_mujoco();
  ({ useStore } = await import('../src/store/useStore'));
}, 60_000);

const find = (ns: SceneNode[], id: string): SceneNode | null => {
  for (const n of ns || []) {
    if (n.id === id) return n;
    const c = find(n.children, id);
    if (c) return c;
  }
  return null;
};

describe('a spring re-sized after it was added', () => {
  it('rests at its new free length with the builder\'s range', () => {
    const spring = hardwarePartNode({ kind: 'spring', size: 'Ø10×30' }, 'sp');
    rebuildPart(spring, { ...spring.hardwarePart!, size: 'Ø20×60' });
    const top = find([spring], 'sp_carriage')!;
    // Was z 0.03 with range [-0.008, 0.033].
    expect(top.pos[2]).toBeCloseTo(0.06, 9);
    expect(top.joints[0].range).toEqual([-0.038, 0.003]);
    expect(top.joints[0].springref).toBe(0);
    // Every turn sits below the top.
    const coils = spring.children.filter((c) => c.id.startsWith('sp_coil'));
    expect(Math.max(...coils.map((c) => c.pos[2]))).toBeLessThan(0.06);
  });

  it('keeps a top moved along its slide where it was moved, from the new rest', () => {
    const spring = hardwarePartNode({ kind: 'spring', size: 'Ø10×30' }, 'sp');
    find([spring], 'sp_carriage')!.pos = [0, 0, 0.025];
    rebuildPart(spring, { ...spring.hardwarePart!, size: 'Ø20×60' });
    const top = find([spring], 'sp_carriage')!;
    expect(top.pos[2]).toBeCloseTo(0.055, 9);
    expect(top.joints[0].range![0]).toBeCloseTo(-0.033, 9);
    expect(top.joints[0].range![1]).toBeCloseTo(0.008, 9);
  });
});

/** A spring standing free on a 10 mm static plate with a box welded to its top; seat height and compression, mm. */
const loaded = (size: string, kg: number) => {
  const spring = hardwarePartNode({ kind: 'spring', size }, 'sp');
  spring.pos = [0, 0, 0.01];
  const top = find([spring], 'sp_carriage')!;
  const plate: SceneNode = { id: 'plate', name: 'plate', type: 'body', pos: [0, 0, 0.005], children: [], joints: [],
    geoms: [{ name: 'plate_g', type: 'box', size: [0.05, 0.05, 0.005] }] };
  const box: SceneNode = { id: 'box', name: 'box', type: 'body', pos: [0, 0, 0.01 + top.pos[2] + 0.01], children: [],
    joints: [{ name: 'box_free', type: 'free' }], geoms: [{ name: 'box_g', type: 'box', size: [0.015, 0.015, 0.01], mass: kg }],
    weldTargetId: 'sp_carriage', weldRigid: true };
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [plate, spring, box] }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    const seat = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, spring.name);
    const joint = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, 'sp_compress');
    let lowest = Infinity;
    for (let i = 0; i < 3000; i++) {
      mj.mj_step(m, d);
      lowest = Math.min(lowest, d.xpos[seat * 3 + 2]);
    }
    return { seatMm: d.xpos[seat * 3 + 2] * 1000, lowestMm: lowest * 1000, compressMm: -d.qpos[m.jnt_qposadr[joint]] * 1000, rate: top.joints[0].stiffness! };
  } finally {
    d.delete(); m.delete();
  }
};

describe('a sprung part under load', () => {
  for (const [size, kg] of [['Ø20×60', 1], ['Ø20×60', 3], ['Ø10×30', 0.5], ['Ø6×20', 0.25]] as const) {
    it(`a ${size} spring holds ${kg} kg on a plate without going through it`, () => {
      const r = loaded(size, kg);
      // Ø20×60 under 1 kg: the seat ended 5 mm into the floor under the plate.
      expect(r.seatMm).toBeGreaterThan(9.8);
      // Dropped onto it from rest, it may dip into the plate as it first takes the load, never through it.
      expect(r.lowestMm).toBeGreaterThan(4);
      // Compressed by load / rate, give or take its last 10% of bounce (the
      // spring's own light damping is still ringing out a 3 kg drop at 3 s).
      const expected = (kg * 9.81 / r.rate) * 1000;
      expect(Math.abs(r.compressMm - expected)).toBeLessThan(0.1 * expected);
    });
  }
});

describe('placing a part through the store', () => {
  it('puts it exactly where asked, and mounts it into a body with no cut for it', () => {
    const s = useStore.getState();
    s.updateScene({ ...s.sceneGraph, nodes: [{ id: 'frame', name: 'frame', type: 'body', pos: [0, 0, 0.005], children: [], joints: [],
      geoms: [{ name: 'frame_g', type: 'box', size: [0.05, 0.05, 0.005] }] }] });
    const free = useStore.getState().addHardwarePart('spring', [0.04, 0, 0.01], null, { exact: true });
    // Was lifted to 20 mm.
    expect(find(useStore.getState().sceneGraph.nodes, free)!.pos).toEqual([0.04, 0, 0.01]);
    const motor = useStore.getState().addHardwarePart('stepper', [0, 0, 0.05], 'frame', { exact: true, mount: true });
    const node = find(useStore.getState().sceneGraph.nodes, motor)!;
    expect(node.weldTargetId).toBe('frame');
    expect(node.weldRigid).toBe(true);
    // Without being asked to mount, a part beside a body stays free of it.
    const loose = useStore.getState().addHardwarePart('stepper', [0.1, 0, 0.05], 'frame');
    expect(find(useStore.getState().sceneGraph.nodes, loose)!.weldTargetId).toBeUndefined();
  });
});
