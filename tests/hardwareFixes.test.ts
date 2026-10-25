/**
 * Edits a user makes after a part is in place — resizing it, lengthening a
 * rail, deleting what something is welded to — each leaving a scene MuJoCo
 * still takes, with every coupling and weld it should still have. Through
 * the store, against a fake worker client, and compiled in real MuJoCo.
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

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let presets: any;
let compileToMJCF: any;
let hardwarePartNode: any;
let mj: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  presets = await import('../src/presets/hardwarePresets');
  ({ compileToMJCF } = await import('../src/utils/mjcf'));
  ({ hardwarePartNode } = await import('../src/utils/hardwareParts'));
  mj = await load_mujoco();
}, 60_000);

const find = (id: string) => {
  const walk = (ns: any[]): any => { for (const n of ns || []) { if (n.id === id) return n; const c = walk(n.children); if (c) return c; } return null; };
  return walk(useStore.getState().sceneGraph.nodes);
};
const load = (scene: any) => useStore.getState().updateScene(structuredClone(scene));
/** Throws, as the app's build would fail, when MuJoCo will not take the scene. */
const compiles = () => {
  const model = mj.MjModel.from_xml_string(compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0));
  model.delete();
  return true;
};

describe('resizing a part fixed inside another body', () => {
  it('keeps the turntable motor fixed and still driving the bearing', () => {
    load(presets.stepperTurntablePreset);
    useStore.getState().setHardwarePart('motor', { size: 'NEMA23 56' });
    expect(find('motor').joints).toEqual([]);
    expect(find('motor_shaft').coupleTargetId).toBe('bearing_inner');
    expect(compiles()).toBe(true);
  });

  it('keeps the launcher spring fixed in its base', () => {
    load(presets.springLauncherPreset);
    useStore.getState().setHardwarePart('spring', { size: 'Ø20×60' });
    expect(find('spring').joints).toEqual([]);
    // What is fixed on its top is still there.
    expect(find('spring_carriage').children.map((c: any) => c.id)).toContain('cup');
    expect(compiles()).toBe(true);
  });

  it('keeps a resized drawer runner following its pair', () => {
    load(presets.chestOfDrawersPreset);
    useStore.getState().setHardwarePart('drawer_1_runner_1', { size: '350' });
    expect(find('drawer_1_runner_1').joints).toEqual([]);
    expect(find('drawer_1_runner_1_carriage').coupleTargetId).toBe('drawer_1_runner_0_carriage');
    expect(find('drawer_1_runner_1_middle').coupleTargetId).toBe('drawer_1_runner_0_middle');
    expect(compiles()).toBe(true);
  });
});

describe('a bushing moved to its housing', () => {
  it('stays there when its rod is lengthened, with its travel shifted to match', () => {
    useStore.getState().updateScene({ nodes: [] });
    const rod = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 300 }, 'rod');
    rod.children[0].pos = [0, 0, 0.05];
    rod.children[0].joints[0].range = [-0.138 - 0.05, 0.138 - 0.05];
    useStore.getState().updateScene({ nodes: [rod] });
    useStore.getState().setHardwarePart('rod', { lengthMm: 400 });
    const bush = find('rod_carriage');
    expect(bush.pos[2]).toBeCloseTo(0.05, 9);
    const travel = (400 - 24) / 2000;
    expect(bush.joints[0].range[0]).toBeCloseTo(-travel - 0.05, 6);
    expect(bush.joints[0].range[1]).toBeCloseTo(travel - 0.05, 6);
  });
});

describe('lengthening a seated rail', () => {
  it('lengthens its seat, and the rail stays the seat\'s length', () => {
    load(presets.xyPlotterPreset);
    useStore.getState().setHardwarePart('x_rail', { lengthMm: 300 });
    const seat = find('base').geoms.find((x: any) => x.hardware?.group === 'x_seat' && x.hardware.part === 'channel');
    expect(seat.hardware.length * 1000).toBeCloseTo(300, 6);
    expect(find('x_rail').hardwarePart.lengthMm).toBe(300);
  });
});

describe('a bearing resized with a shaft through it', () => {
  it('takes the shaft to its new bore', () => {
    useStore.getState().updateScene({ nodes: [] });
    const id = useStore.getState().addHardwarePart('bearing', [0, 0, 0.05], null);
    const shaft = useStore.getState().addHardwarePart('shaft', [0, 0, 0], id);
    useStore.getState().setHardwarePart(id, { size: '6001' });
    expect(find(shaft).hardwarePart.size).toBe('12');
  });
});

describe('bought parts and the collider decomposition', () => {
  it('collide as their hull, so a ring is never split into pieces', () => {
    for (const kind of ['bearing', 'nut', 'oring', 'linear_rod', 'spring']) {
      const part = hardwarePartNode({ kind, size: kind === 'oring' ? '20×2' : undefined }, 'p');
      const all = (n: any): any[] => [n, ...(n.children || []).filter((c: any) => c.hardwarePart?.piece).flatMap(all)];
      for (const body of all(part)) expect(body.collision, `${kind} ${body.id}`).toBe('hull');
    }
  });
});

describe('deleting what something is welded to', () => {
  it('leaves the frame compiling when a profile goes', () => {
    load(presets.extrusionFramePreset);
    useStore.getState().deleteNodes(['bottom_left']);
    expect(compiles()).toBe(true);
  });

  it('lets the pen head go when the rail it rode is deleted', () => {
    load(presets.xyPlotterPreset);
    useStore.getState().deleteNodes(['y_rail']);
    expect(find('pen_head').weldTargetId).toBeUndefined();
    expect(find('pen_head').weldRigid).toBeUndefined();
    expect(compiles()).toBe(true);
  });
});
