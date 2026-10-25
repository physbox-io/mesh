/**
 * Aluminium extrusion and what joins it: profiles the maker's size, closed
 * and wound outward; a bracket that goes in the corner two profiles make and
 * welds them, or says why not; and, in real MuJoCo, a frame that stays square
 * when dropped and a carriage that stops at both ends of its V-slot.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import * as THREE from 'three';

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
let mj: any;
let X: typeof import('../src/utils/extrusionParts');
let hardwarePartNode: typeof import('../src/utils/hardwareParts').hardwarePartNode;
let HARDWARE_PARTS: typeof import('../src/utils/hardwareParts').HARDWARE_PARTS;
let analyzeMesh: typeof import('../src/utils/meshIntegrity').analyzeMesh;
let compileToMJCF: typeof import('../src/utils/mjcf').compileToMJCF;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  X = await import('../src/utils/extrusionParts');
  ({ hardwarePartNode, HARDWARE_PARTS } = await import('../src/utils/hardwareParts'));
  ({ analyzeMesh } = await import('../src/utils/meshIntegrity'));
  ({ compileToMJCF } = await import('../src/utils/mjcf'));
  mj = await load_mujoco();
}, 60_000);

const find = (id: string) => {
  const walk = (ns: any[]): any => {
    for (const n of ns || []) {
      if (n.id === id) return n;
      const c = walk(n.children);
      if (c) return c;
    }
    return null;
  };
  return walk(useStore.getState().sceneGraph.nodes);
};

// Profile +Z turned onto world X, and onto world Y.
const ALONG_X = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];
const ALONG_Y = [Math.SQRT1_2, -Math.SQRT1_2, 0, 0];

function profile(id: string, size: string, lengthMm: number, pos: number[], quat: number[], free = true) {
  const n = hardwarePartNode({ kind: 'extrusion', size, lengthMm }, id);
  n.name = id; // MuJoCo knows bodies by name
  n.pos = pos;
  n.quat = quat;
  if (!free) n.joints = [];
  return n;
}

describe('profiles', () => {
  it('are the maker\'s size across, with slots the maker\'s width at the face', () => {
    for (const [size, w, h, mouth] of [['2020', 20, 20, 6.2], ['2040', 20, 40, 6.2], ['3030', 30, 30, 8.2], ['4040', 40, 40, 8.2], ['2020V', 20, 20, 9.16]] as const) {
      const { outline } = X.profileSection(size);
      const xs = outline.map(([x]) => x), ys = outline.map(([, y]) => y);
      expect(Math.max(...xs) - Math.min(...xs), size).toBeCloseTo(w, 6);
      expect(Math.max(...ys) - Math.min(...ys), size).toBeCloseTo(h, 6);
      // On the top face, the slot's mouth: two points on the face, mouth apart.
      const onTop = outline.filter(([, y]) => Math.abs(y - h / 2) < 1e-6).map(([x]) => x).filter((x) => Math.abs(x) < w / 2 - 1e-6);
      expect(Math.max(...onTop) - Math.min(...onTop), size).toBeCloseTo(mouth, 6);
      expect(X.sectionAreaMm2(size)).toBeGreaterThan(0);
      expect(X.sectionAreaMm2(size)).toBeLessThan(w * h);
    }
  });

  it('every part of the family is closed and wound outward', () => {
    for (const kind of ['extrusion', 'tnut', 'corner_bracket', 'joint_plate', 'end_tap', 'vslot_carriage'] as const) {
      for (const size of HARDWARE_PARTS[kind].sizes) {
        const node = hardwarePartNode({ kind, size, lengthMm: 250 }, `p_${kind}`);
        expect(node.geoms.length, `${kind} ${size}`).toBeGreaterThan(0);
        for (const geom of node.geoms.filter((x) => x.type === 'mesh')) {
          const a = analyzeMesh(geom.renderVertices!, geom.faces!)!;
          expect(a.closed && a.consistentlyWound && a.volume > 0, `${kind} ${size} ${geom.name}`).toBe(true);
        }
      }
    }
  });

  it('offers its slots to mate snapping, along its length', async () => {
    const { documentAxes } = await import('../src/utils/mateFeatures');
    const n = hardwarePartNode({ kind: 'extrusion', size: '2040', lengthMm: 300 }, 'p');
    const axes = documentAxes(n, { pos: new THREE.Vector3(), rot: new THREE.Matrix3() }).filter((a) => a.label.startsWith('slot'));
    // Two on each long face, one on each short.
    expect(axes).toHaveLength(6);
    for (const a of axes) expect(a.dir).toEqual([0, 0, 1]);
    expect(axes.some((a) => Math.abs(a.point[0] - 0.01) < 1e-9 && Math.abs(a.point[1] - 0.01) < 1e-9)).toBe(true);
  });

  it('weighs what the maker says a metre weighs', () => {
    const n = hardwarePartNode({ kind: 'extrusion', size: '2020', lengthMm: 500 }, 'p');
    const mass = n.geoms.reduce((s, x) => s + (x.mass ?? 0), 0);
    expect(mass).toBeCloseTo(0.245, 6);
  });
});

/** A flat 300 × 300 frame: two rails along X, two sides along Y between them, its plane at z. */
function frame(z: number) {
  return [
    profile('railA', '2020', 300, [0, -0.15, z], ALONG_X),
    profile('railB', '2020', 300, [0, 0.15, z], ALONG_X),
    profile('sideA', '2020', 280, [-0.14, 0, z], ALONG_Y),
    profile('sideB', '2020', 280, [0.14, 0, z], ALONG_Y),
  ];
}

describe('joining two profiles', () => {
  it('puts a bracket in the inside corner, fixed to one and welded to the other', () => {
    useStore.getState().updateScene({ nodes: frame(0.01) });
    const r = useStore.getState().joinProfiles('railA', 'sideA', 'corner_bracket');
    expect('id' in r).toBe(true);
    const id = (r as { id: string }).id;
    // The side's end stands on the rail, so the bracket hangs on the rail.
    expect(find('railA').children.map((c: any) => c.id)).toContain(id);
    const bracket = find(id);
    expect(bracket.weldTargetId).toBe('sideA');
    expect(bracket.hardwarePart).toMatchObject({ kind: 'corner_bracket', size: '20', fastens: 'sideA' });
    // In the corner: its edge on the side's inner face, x = -0.13, on the rail's face, y = -0.14.
    const m = X.meeting(useStore.getState().sceneGraph, 'railA', 'sideA') as any;
    const corner = m.end.clone().addScaledVector(m.alongB, m.halfA);
    expect(corner.x).toBeCloseTo(-0.13, 6);
    expect(corner.y).toBeCloseTo(-0.14, 6);
    // Taking it out takes its weld with it: the weld was the bracket's own.
    useStore.getState().deleteNodes([id]);
    expect(find(id)).toBeNull();
    expect(find('sideA').weldTargetId).toBeUndefined();
  });

  it('refuses two profiles that do not meet, and says why', () => {
    useStore.getState().updateScene({ nodes: frame(0.01) });
    const r = useStore.getState().joinProfiles('railA', 'railB', 'corner_bracket');
    expect('problem' in r && r.problem).toMatch(/do not meet/);
  });

  it('lays a joint plate on the outside face, an L at a corner', () => {
    useStore.getState().updateScene({ nodes: frame(0.01) });
    const r = useStore.getState().joinProfiles('sideA', 'railA', 'joint_plate');
    expect('id' in r).toBe(true);
    expect(find((r as any).id).hardwarePart.size).toBe('L20');
  });

  it('runs an end-tap screw into the end of the profile that meets', () => {
    useStore.getState().updateScene({ nodes: frame(0.01) });
    const r = useStore.getState().joinProfiles('railA', 'sideA', 'end_tap');
    expect('id' in r).toBe(true);
    const screw = find((r as any).id);
    expect(screw.weldTargetId).toBe('sideA');
    expect(screw.hardwarePart.lengthMm).toBeGreaterThanOrEqual(12);
  });
});

function run(xml: string, seconds: number, each?: (model: any, data: any) => void) {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const steps = Math.round(seconds / model.opt.timestep);
  for (let i = 0; i < steps; i++) { each?.(model, data); mj.mj_step(model, data); }
  return { model, data, done: () => { data.delete(); model.delete(); } };
}

const bodyAxis = (model: any, data: any, name: string, k: number) => {
  const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, name);
  const m = data.xmat.slice(id * 9, id * 9 + 9);
  return [m[k], m[3 + k], m[6 + k]];
};

describe('in MuJoCo', () => {
  /** The frame tilted 40° about X, so it lands on an edge and loose pieces would scatter. */
  const tilted = () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (40 * Math.PI) / 180);
    return frame(0).map((n) => {
      const p = new THREE.Vector3(...(n.pos as [number, number, number])).applyQuaternion(q).add(new THREE.Vector3(0, 0, 0.5));
      const own = new THREE.Quaternion(n.quat![1], n.quat![2], n.quat![3], n.quat![0]);
      const turned = q.clone().multiply(own);
      return { ...n, pos: p.toArray(), quat: [turned.w, turned.x, turned.y, turned.z] };
    });
  };
  const CORNERS = [['railA', 'sideA'], ['railA', 'sideB'], ['railB', 'sideA'], ['railB', 'sideB']];
  /** The worst corner's error from square, degrees, and how far apart the corner's two bodies drifted, m. */
  const afterDrop = (bracketed: boolean) => {
    useStore.getState().updateScene({ nodes: tilted() });
    if (bracketed) {
      for (const [rail, side] of CORNERS) {
        const res = useStore.getState().joinProfiles(rail, side, 'corner_bracket');
        expect('id' in res, `${rail} ${side}`).toBe(true);
      }
    }
    const r = run(compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0), 1.5);
    const pos = (name: string) => {
      const id = mj.mj_name2id(r.model, mj.mjtObj.mjOBJ_BODY.value, name);
      return new THREE.Vector3(r.data.xpos[id * 3], r.data.xpos[id * 3 + 1], r.data.xpos[id * 3 + 2]);
    };
    let worst = 0, drift = 0;
    for (const [rail, side] of CORNERS) {
      const a = bodyAxis(r.model, r.data, rail, 2);
      const b = bodyAxis(r.model, r.data, side, 2);
      const deg = (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
      worst = Math.max(worst, Math.abs(deg - 90));
      // A rail's middle and a side's middle start 0.15·√2 m apart.
      drift = Math.max(drift, Math.abs(pos(rail).distanceTo(pos(side)) - Math.hypot(0.14, 0.15)));
    }
    const resting = pos('railA').z < 0.2 && pos('railB').z < 0.2;
    r.done();
    return { worst, drift, resting };
  };

  it('a bracketed frame dropped from half a metre onto an edge lands square', () => {
    const held = afterDrop(true);
    expect(held.resting).toBe(true);
    expect(held.worst).toBeLessThan(1);
    expect(held.drift).toBeLessThan(0.001);
    // And it is the brackets doing it: the same four loose come apart.
    const loose = afterDrop(false);
    expect(Math.max(loose.worst, loose.drift * 1000)).toBeGreaterThan(1);
  }, 60_000);

  it('a V-slot carriage pushed along stops at both ends', () => {
    const rail = profile('vrail', '2020V', 400, [0, 0, 0.1], ALONG_X, false);
    useStore.getState().updateScene({ nodes: [rail] });
    const res = useStore.getState().addCarriage('vrail');
    expect('id' in res).toBe(true);
    const id = (res as any).id;
    const [lo, hi] = find(id).joints[0].range;
    expect(hi).toBeCloseTo(0.2 - X.CARRIAGE_REACH / 1000, 6);
    for (const [push, end] of [[5, hi], [-5, lo]] as const) {
      const r = run(compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0), 2, (model, data) => {
        const j = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, `${id}_slide`);
        data.qfrc_applied[model.jnt_dofadr[j]] = push;
      });
      const j = mj.mj_name2id(r.model, mj.mjtObj.mjOBJ_JOINT.value, `${id}_slide`);
      expect(Math.abs(r.data.qpos[r.model.jnt_qposadr[j]] - end)).toBeLessThan(0.002);
      r.done();
    }
  }, 60_000);

  it('refuses a carriage on anything but V-slot', () => {
    useStore.getState().updateScene({ nodes: [profile('p', '2020', 300, [0, 0, 0.1], ALONG_X)] });
    const r = useStore.getState().addCarriage('p');
    expect('problem' in r && r.problem).toMatch(/V-slot/);
  });
});
