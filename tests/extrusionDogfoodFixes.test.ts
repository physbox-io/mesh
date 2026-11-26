/**
 * Regression tests for all 8 Extrusion & Linear Motion dogfooding bugs:
 * 1. vslot_carriage attachment via fixTo / fixToPiece / ADD_HARDWARE
 * 2. Short 2020V, mgn_rail, linear_rod MuJoCo joint range safety
 * 3. Seating linear_rod with custom lengthMm keeps bottom flush on rod_clamp floor
 * 4. joint_plate on mixed profile sizes (refuse stepped, allow & align flush)
 * 5. rideOnRod on dual-rod carriages (coupled bushings + MuJoCo verification)
 * 6. vslot_carriage chamfered V-wheels clear 2020V corners and bevels
 * 7. ADD_HARDWARE drawer_runner returns world posMm, mountedTo, carriageId, weldedTo
 * 8. NEMA23 56 stepper pilot boss radius is 19.05 mm (NEMA17 stays 11 mm)
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setSound() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let mj: any;
let objectCommands: any;
let movingPieceOf: typeof import('../src/hooks/mcp/bodyFeatures').movingPieceOf;
let applySingleCutToBody: typeof import('../src/hooks/mcp/bodyFeatures').applySingleCutToBody;
let X: typeof import('../src/utils/extrusionParts');
let hardwarePartNode: typeof import('../src/utils/hardwareParts').hardwarePartNode;
let documentWorldMatrix: typeof import('../src/utils/hardwareParts').documentWorldMatrix;
let fixToPiece: typeof import('../src/utils/linearPlacement').fixToPiece;
let rideOnRod: typeof import('../src/utils/linearPlacement').rideOnRod;
let analyzeMesh: typeof import('../src/utils/meshIntegrity').analyzeMesh;
let compileToMJCF: typeof import('../src/utils/mjcf').compileToMJCF;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  ({ objectCommands } = await import('../src/hooks/mcp/objectCommands'));
  ({ movingPieceOf, applySingleCutToBody } = await import('../src/hooks/mcp/bodyFeatures'));
  X = await import('../src/utils/extrusionParts');
  ({ hardwarePartNode, documentWorldMatrix } = await import('../src/utils/hardwareParts'));
  ({ fixToPiece, rideOnRod } = await import('../src/utils/linearPlacement'));
  ({ analyzeMesh } = await import('../src/utils/meshIntegrity'));
  ({ compileToMJCF } = await import('../src/utils/mjcf'));
  mj = await load_mujoco();
}, 60_000);

const callAddHardware = async (msg: Record<string, unknown>) => {
  const store = useStore.getState();
  return objectCommands.ADD_HARDWARE(
    { type: 'ADD_HARDWARE', id: 'req_test_1', ...msg },
    { store, toId: (v: unknown) => v },
  );
};

const find = (id: string): SceneNode | null => {
  const walk = (ns: SceneNode[]): SceneNode | null => {
    for (const n of ns || []) {
      if (n.id === id) return n;
      const c = walk(n.children || []);
      if (c) return c;
    }
    return null;
  };
  return walk(useStore.getState().sceneGraph.nodes);
};

function runMj(xml: string, seconds: number, each?: (model: any, data: any) => void) {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const steps = Math.round(seconds / model.opt.timestep);
  for (let i = 0; i < steps; i++) { each?.(model, data); mj.mj_step(model, data); }
  return { model, data, done: () => { data.delete(); model.delete(); } };
}

const ALONG_X = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];

function profile(id: string, size: string, lengthMm: number, pos: number[], quat?: number[], free = false): SceneNode {
  const n = hardwarePartNode({ kind: 'extrusion', size, lengthMm }, id);
  n.name = id;
  n.pos = pos;
  if (quat) n.quat = quat;
  if (!free) n.joints = [];
  return n;
}

function boxBody(id: string, pos: [number, number, number], half: [number, number, number], free = true): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos,
    geoms: [{ name: `${id}_g`, type: 'box', size: half, rgba: [0.2, 0.6, 0.8, 1], mass: 0.2, dynamic: true } as SceneGeom],
    joints: free ? [{ name: `${id}_free`, type: 'free' }] : [],
    children: [],
  };
}

describe('1. vslot_carriage fixTo / fixToPiece attachment', () => {
  it('supports fixToPiece, ADD_HARDWARE fixTo on creation, and ADD_HARDWARE partId+fixTo, and slides with payload in MuJoCo', async () => {
    const rail = profile('vrail', '2020V', 300, [0, 0, 0.1], ALONG_X, false);
    const payloadA = boxBody('payloadA', [0, 0.03, 0.1], [0.02, 0.01, 0.02], true);
    const payloadB = boxBody('payloadB', [0, 0.03, 0.1], [0.02, 0.01, 0.02], true);
    useStore.getState().updateScene({ nodes: [rail, payloadA, payloadB] });

    // Path A: ADD_HARDWARE({ kind: 'vslot_carriage', into, fixTo })
    const resA = await callAddHardware({ kind: 'vslot_carriage', into: 'vrail', fixTo: 'payloadA', partId: 'vc1' });
    expect(resA.ok).toBe(true);
    expect(resA.id).toBe('vc1');
    expect(resA.carriageId).toBe('vc1');
    const carriage = find('vc1')!;
    expect(movingPieceOf(carriage)?.id).toBe('vc1');
    expect(find('payloadA')?.weldTargetId).toBe('vc1');

    // Path B: direct fixToPiece(scene, carriageId, bodyId)
    const cloned = structuredClone(useStore.getState().sceneGraph);
    const fixed = fixToPiece(cloned, 'vc1', 'payloadB');
    expect(fixed.ok).toBe(true);
    const bAfter = cloned.nodes.find((n: SceneNode) => n.id === 'payloadB');
    expect(bAfter?.weldTargetId).toBe('vc1');

    // Path C: ADD_HARDWARE({ partId: carriageId, fixTo: bodyId })
    const resC = await callAddHardware({ partId: 'vc1', fixTo: 'payloadB' });
    expect(resC.ok).toBe(true);
    expect(resC.pieceId).toBe('vc1');
    expect(resC.fixed).toBe('payloadB');
    expect(find('payloadB')?.weldTargetId).toBe('vc1');

    // MuJoCo verification: pushing the carriage carries payloadA along X.
    useStore.getState().updateScene({
      nodes: [
        useStore.getState().sceneGraph.nodes[0], // vrail with vc1 child
        find('payloadA')!,
      ],
    });
    const xml = compileToMJCF(useStore.getState().sceneGraph, 0, 1, 0, 0, 0, 0);
    const r = runMj(xml, 1.0, (model, data) => {
      const j = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'vc1_slide');
      data.qfrc_applied[model.jnt_dofadr[j]] = 4;
    });
    const bodyId = mj.mj_name2id(r.model, mj.mjtObj.mjOBJ_BODY.value, 'payloadA');
    expect(r.data.xpos[bodyId * 3]).toBeGreaterThan(0.08);
    r.done();
  });
});

describe('2. Short 2020V, mgn_rail, and linear_rod MuJoCo range safety', () => {
  it('refuses addCarriage on 2020V <= 60 mm and guarantees valid range in carriageRange / refit', () => {
    const short50 = profile('v50', '2020V', 50, [0, 0, 0.1], ALONG_X, false);
    const short60 = profile('v60', '2020V', 60, [0, 0.1, 0.1], ALONG_X, false);
    useStore.getState().updateScene({ nodes: [short50, short60] });

    const r50 = useStore.getState().addCarriage('v50');
    expect('problem' in r50).toBe(true);
    const r60 = useStore.getState().addCarriage('v60');
    expect('problem' in r60).toBe(true);

    // carriageRange never returns range[0] >= range[1]
    for (const L of [10, 40, 60, 60.05, 100]) {
      const [lo, hi] = X.carriageRange(L, 0);
      expect(lo).toBeLessThan(hi);
    }

    // Shortening a 2020V profile that already has a carriage compiles cleanly in MuJoCo.
    const rail = profile('vlong', '2020V', 200, [0, 0, 0.1], ALONG_X, false);
    useStore.getState().updateScene({ nodes: [rail] });
    const added = useStore.getState().addCarriage('vlong');
    expect('id' in added).toBe(true);
    useStore.getState().setHardwarePart('vlong', { lengthMm: 40 });
    const xml = compileToMJCF(useStore.getState().sceneGraph, -9.81, 1, 0, 0, 0, 0);
    const r = runMj(xml, 0.1);
    r.done();
  });

  it('omits slide joint on short mgn_rail (<= block length) and short linear_rod (<= bushing length) so MuJoCo never crashes', () => {
    const shortRail = hardwarePartNode({ kind: 'mgn_rail', size: 'MGN12', lengthMm: 40 }, 'rail_short');
    shortRail.joints = [];
    const exactRail = hardwarePartNode({ kind: 'mgn_rail', size: 'MGN9', lengthMm: 39.9 }, 'rail_exact');
    exactRail.pos = [0, 0.1, 0];
    exactRail.joints = [];
    const shortRod = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 20 }, 'rod_short');
    shortRod.pos = [0.2, 0, 0.05];
    shortRod.joints = [];
    const exactRod = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 24 }, 'rod_exact');
    exactRod.pos = [0.25, 0, 0.05];
    exactRod.joints = [];

    expect(shortRail.children[0].joints).toHaveLength(0);
    expect(exactRail.children[0].joints).toHaveLength(0);
    expect(shortRod.children[0].joints).toHaveLength(0);
    expect(exactRod.children[0].joints).toHaveLength(0);

    // Normal length still gets a valid slide joint.
    const normalRod = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 200 }, 'rod_ok');
    expect(normalRod.children[0].joints).toHaveLength(1);
    expect(normalRod.children[0].joints[0].range![0]).toBeLessThan(normalRod.children[0].joints[0].range![1]);

    const xml = compileToMJCF({ nodes: [shortRail, exactRail, shortRod, exactRod] }, -9.81, 1, 0, 0, 0, 0);
    const r = runMj(xml, 0.1);
    r.done();
  });
});

describe('3. Seating linear_rod with custom lengthMm via MCP ADD_HARDWARE', () => {
  it('keeps the bottom of a 500 mm and 150 mm linear_rod flush on the rod_clamp floor', async () => {
    // 40×40×30 mm clamp block standing on z = 0 (top face at z = 30 mm, local z = +15 mm).
    const clamp = boxBody('clamp', [0, 0, 0.015], [0.02, 0.02, 0.015], false);
    useStore.getState().updateScene({ nodes: [clamp] });

    const cut1 = applySingleCutToBody('clamp', {
      shape: 'rod_clamp', size: '8', at: [-10, 0, 15], normal: [0, 0, 1], depthMm: 16,
    });
    expect(cut1.ok).toBe(true);
    const cut2 = applySingleCutToBody('clamp', {
      shape: 'rod_clamp', size: '8', at: [10, 0, 15], normal: [0, 0, 1], depthMm: 16,
    });
    expect(cut2.ok).toBe(true);

    // Clamp floor is at local z = 15 - 16 = -1 mm (world z = 14 mm).
    const floorLocalZ = 0.015 - 0.016;

    const r500 = await callAddHardware({
      kind: 'linear_rod', size: '8', lengthMm: 500, into: 'clamp', group: cut1.group, partId: 'rod500',
    });
    expect(r500.ok).toBe(true);
    const rod500 = find('rod500')!;
    expect(rod500.hardwarePart?.lengthMm).toBe(500);
    // Rod centre minus half length must equal clamp floor!
    const bottom500 = rod500.pos[2] - 0.25;
    expect(bottom500).toBeCloseTo(floorLocalZ, 5);

    const r150 = await callAddHardware({
      kind: 'linear_rod', size: '8', lengthMm: 150, into: 'clamp', group: cut2.group, partId: 'rod150',
    });
    expect(r150.ok).toBe(true);
    const rod150 = find('rod150')!;
    expect(rod150.hardwarePart?.lengthMm).toBe(150);
    const bottom150 = rod150.pos[2] - 0.075;
    expect(bottom150).toBeCloseTo(floorLocalZ, 5);
  });
});

describe('4. joint_plate on mixed profile sizes', () => {
  it('refuses joint_plate when 2020 and 2040 outer faces are stepped, and succeeds when aligned flush', () => {
    // 2040 along Z (20 mm X, 40 mm Y), 2020 along X (20 mm Y, 20 mm Z) meeting +X face of 2040.
    // Centered: 2020 Y ∈ [-10, +10], 2040 Y ∈ [-20, +20] -> stepped by 10 mm on both ±Y faces!
    const p2040 = profile('p2040', '2040', 300, [0, 0, 0.15]);
    const p2020Centered = profile('p2020_c', '2020', 200, [0.11, 0, 0.15], ALONG_X);
    useStore.getState().updateScene({ nodes: [p2040, p2020Centered] });

    const stepped = useStore.getState().joinProfiles('p2020_c', 'p2040', 'joint_plate');
    expect('problem' in stepped).toBe(true);
    expect((stepped as { problem: string }).problem).toMatch(/flush outside face/i);

    // Now shift 2020 to y = -10 mm or +10 mm so its outward face is flush with 2040's outer face.
    // First check which way `outward` points for this meeting:
    const mCheck = X.meeting(useStore.getState().sceneGraph, 'p2020_c', 'p2040') as X.Meeting;
    const shiftY = Math.sign(mCheck.outward.y) * 0.01;
    const p2020Flush = profile('p2020_f', '2020', 200, [0.11, shiftY, 0.15], ALONG_X);
    useStore.getState().updateScene({ nodes: [p2040, p2020Flush] });

    const flushed = useStore.getState().joinProfiles('p2020_f', 'p2040', 'joint_plate');
    expect('id' in flushed).toBe(true);
    const plate = find((flushed as { id: string }).id)!;
    // Plate sits at the flush outer face (|y| = 20 mm = 0.02 m), not buried at 0.01 or floating at 0.03!
    expect(Math.abs(plate.pos[1])).toBeCloseTo(0.02, 5);
  });
});

describe('5. rideOnRod on dual-rod carriages', () => {
  it('couples the second parallel rod bushing (same and opposite rod directions) and slides smoothly in MuJoCo', () => {
    for (const flipSecond of [false, true]) {
      const rod1 = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 250 }, 'rod1');
      rod1.pos = [-0.03, 0, 0.125];
      rod1.joints = [];
      // Seated rods in clamps are quieted (contype/conaffinity = 0); here CSG isn't run in Node.
      for (const gm of rod1.geoms) { gm.contype = 0; gm.conaffinity = 0; }
      const rod2 = hardwarePartNode({ kind: 'linear_rod', size: '8', lengthMm: 250 }, 'rod2');
      rod2.pos = [0.03, 0, 0.125];
      if (flipSecond) rod2.quat = [0, 1, 0, 0]; // 180° around X -> local +Z points along -Z
      rod2.joints = [];
      for (const gm of rod2.geoms) { gm.contype = 0; gm.conaffinity = 0; }

      // Carriage centered at z = 0.125, spanning x ∈ [-0.045, +0.045] with two Ø8 lm_housing cuts.
      const carriage = boxBody('carriage', [0, 0, 0.125], [0.045, 0.015, 0.015], true);
      useStore.getState().updateScene({ nodes: [rod1, rod2, carriage] });

      const c1 = applySingleCutToBody('carriage', {
        shape: 'lm_housing', size: '8', at: [-30, 0, 15], normal: [0, 0, 1],
      });
      const c2 = applySingleCutToBody('carriage', {
        shape: 'lm_housing', size: '8', at: [30, 0, 15], normal: [0, 0, 1],
      });
      expect(c1.ok && c2.ok).toBe(true);

      const scene = structuredClone(useStore.getState().sceneGraph);
      const r1 = rideOnRod(scene, 'carriage', c1.group);
      expect(r1.ok).toBe(true);
      const r2 = rideOnRod(scene, 'carriage', c2.group);
      expect(r2.ok).toBe(true);

      const cNode = scene.nodes.find((n: SceneNode) => n.id === 'carriage')!;
      const b1 = scene.nodes.find((n: SceneNode) => n.id === 'rod1')!.children[0];
      const b2 = scene.nodes.find((n: SceneNode) => n.id === 'rod2')!.children[0];
      expect(cNode.weldTargetId).toBe(b1.id);
      expect(b2.coupleTargetId).toBe(b1.id);
      expect(b2.coupleRatio).toBe(flipSecond ? -1 : 1);

      // Verify in MuJoCo: pushing bushing 1 moves both bushings and the carriage together!
      const xml = compileToMJCF(scene, 0, 1, 0, 0, 0, 0);
      const run = runMj(xml, 0.6, (model, data) => {
        const j = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'rod1_travel');
        data.qfrc_applied[model.jnt_dofadr[j]] = 3;
      });
      const j1 = mj.mj_name2id(run.model, mj.mjtObj.mjOBJ_JOINT.value, 'rod1_travel');
      const j2 = mj.mj_name2id(run.model, mj.mjtObj.mjOBJ_JOINT.value, 'rod2_travel');
      const q1 = run.data.qpos[run.model.jnt_qposadr[j1]];
      const q2 = run.data.qpos[run.model.jnt_qposadr[j2]];
      expect(q1).toBeGreaterThan(0.05);
      expect(q2).toBeCloseTo((flipSecond ? -1 : 1) * q1, 3);
      run.done();
    }
  });
});

describe('6. vslot_carriage V-wheels do not penetrate 2020V corners or bevels', () => {
  it('all wheel vertices clear the 2020V solid corners and 45° bevels, and meshes are closed', () => {
    const carriage = hardwarePartNode({ kind: 'vslot_carriage', size: '20', seat: 'rail' }, 'vc_geom');
    const wheels = carriage.geoms.filter((gm) => gm.name.includes('_wheel_'));
    expect(wheels).toHaveLength(3);

    for (const w of wheels) {
      expect(w.type).toBe('mesh');
      const info = analyzeMesh(w.renderVertices!, w.faces!)!;
      expect(info.closed && info.consistentlyWound && info.volume > 0).toBe(true);

      const q = new THREE.Quaternion(w.quat![1], w.quat![2], w.quat![3], w.quat![0]);
      const p = new THREE.Vector3(w.pos![0], w.pos![1], w.pos![2]);
      const verts = w.renderVertices!;
      for (let i = 0; i < verts.length; i += 3) {
        const v = new THREE.Vector3(verts[i], verts[i + 1], verts[i + 2]).applyQuaternion(q).add(p);
        const axMm = Math.abs(v.x) * 1000;
        const ayMm = Math.abs(v.y) * 1000;
        if (ayMm > 4.58) {
          // Solid outer wall of 2020V is at |x| = 10 mm.
          expect(axMm).toBeGreaterThanOrEqual(10.0 - 1e-3);
        } else if (ayMm >= 3.1) {
          // 45° V-bevel of 2020V is at |x| = 5.42 + |y|.
          expect(axMm).toBeGreaterThanOrEqual(5.42 + ayMm - 1e-3);
        }
      }
    }
  });
});

describe('7. ADD_HARDWARE drawer_runner returns world posMm, mountedTo, carriageId, weldedTo', () => {
  it('returns world-space posMm and metadata when cabinet is offset from origin', async () => {
    // Cabinet offset at [0.5, -0.3, 0.2], outer box 440×420×300 mm; drawer inside it.
    const cabinet = boxBody('cab', [0.5, -0.3, 0.2], [0.22, 0.21, 0.15], false);
    const drawer = boxBody('drw', [0.51, -0.3, 0.2], [0.20, 0.18, 0.10], true);
    useStore.getState().updateScene({ nodes: [cabinet, drawer] });

    const res = await callAddHardware({ kind: 'drawer_runner', into: 'drw' });
    expect(res.ok).toBe(true);
    expect(res.runners).toHaveLength(2);

    const scene = useStore.getState().sceneGraph;
    for (const r of res.runners) {
      const m = documentWorldMatrix(scene, r.id)!;
      const wp = new THREE.Vector3().setFromMatrixPosition(m);
      expect(r.posMm[0]).toBeCloseTo(wp.x * 1000, 1);
      expect(r.posMm[1]).toBeCloseTo(wp.y * 1000, 1);
      expect(r.posMm[2]).toBeCloseTo(wp.z * 1000, 1);
      // Confirm it is world space (near x ≈ 310..710 mm, y ≈ -500..-100 mm), not cabinet-local!
      expect(r.posMm[0]).toBeGreaterThan(200);
      expect(r.posMm[1]).toBeLessThan(-50);
      expect(r.mountedTo).toBe('cab');
      expect(r.carriageId).toBe(`${r.id}_carriage`);
    }
    expect(res.runners[0].weldedTo).toBe('drw');
    expect(res.runners[1].coupledTo).toBe(res.runners[0].carriageId);
  });
});

describe('8. NEMA23 56 stepper pilot boss radius', () => {
  it('uses 19.05 mm pilot radius for NEMA23 56 and 11 mm for NEMA17', () => {
    const n23 = hardwarePartNode({ kind: 'stepper', size: 'NEMA23 56' }, 's23');
    const pilot23 = n23.geoms.find((gm) => gm.name === 's23_pilot')!;
    expect(pilot23.size[0]).toBeCloseTo(0.01905, 6);

    const n17 = hardwarePartNode({ kind: 'stepper', size: 'NEMA17 40' }, 's17');
    const pilot17 = n17.geoms.find((gm) => gm.name === 's17_pilot')!;
    expect(pilot17.size[0]).toBeCloseTo(0.011, 6);
  });
});
