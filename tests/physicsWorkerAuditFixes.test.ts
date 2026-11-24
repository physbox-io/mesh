import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeInitialVelocity, seedNewBodies, type CarriedState } from '../src/workers/carryState';
import { getSyncedSceneGraph, type SyncMujoco, type SyncData } from '../src/utils/mujocoSync';
import { headlessImpacts } from '../src/hooks/mcp/headlessImpacts';
import { worldToBodyFrame } from '../src/workers/bodyKinematics';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { ImpactEvent } from '../src/workers/physicsWorkerProtocol';
import type { ModelMirror } from '../src/types/sceneLayer';

const WORKER_SRC = readFileSync(resolve(__dirname, '../src/workers/physicsWorker.ts'), 'utf8');

// ---------------------------------------------------------------------------
// Finding #3: Bounded initialVelocity copy & non-finite filtering
// ---------------------------------------------------------------------------
describe('Finding #3: writeInitialVelocity & seedNewBodies clamping', () => {
  it('clamps velocity copy to JOINT_NV for hinge/slide/ball/free and ignores non-finite values', () => {
    // Joint 0: hinge (type 3, nv=1) at dofAdr=0
    // Joint 1: ball  (type 1, nv=3) at dofAdr=1
    // Joint 2: hinge (type 3, nv=1) at dofAdr=4
    const jntType = [3, 1, 3];
    const jntDofadr = [0, 1, 4];
    const qvel = new Float64Array([0, 10, 20, 30, 99]);

    // Overflowing hinge velocity [5, 111, 222, 333] must only write dof 0 and not touch joint 1.
    expect(writeInitialVelocity(jntType, jntDofadr, qvel.length, qvel, 0, [5, 111, 222, 333])).toBe(true);
    expect(Array.from(qvel)).toEqual([5, 10, 20, 30, 99]);

    // Non-finite values in ball joint velocity must be ignored while finite ones are written,
    // and extra elements must not corrupt joint 2 at dofAdr=4.
    expect(writeInitialVelocity(jntType, jntDofadr, qvel.length, qvel, 1, [NaN, 2.5, Infinity, 777])).toBe(true);
    expect(Array.from(qvel)).toEqual([5, 10, 2.5, 30, 99]);

    // All non-finite values returns false and leaves qvel untouched.
    expect(writeInitialVelocity(jntType, jntDofadr, qvel.length, qvel, 2, [-Infinity])).toBe(false);
    expect(qvel[4]).toBe(99);
  });

  it('clamps to nv - dofAdr when a joint sits near the end of qvel', () => {
    const jntType = [0]; // free joint (nv=6)
    const jntDofadr = [2];
    const qvel = new Float64Array(4); // only 2 slots remain from dofAdr=2
    expect(writeInitialVelocity(jntType, jntDofadr, 4, qvel, 0, [1, 2, 3, 4, 5, 6])).toBe(true);
    expect(Array.from(qvel)).toEqual([0, 0, 1, 2]);
  });

  it('seedNewBodies does not overflow into adjacent joints when seeding initialVelocity', () => {
    const carried: CarriedState = {
      nq: 0, nv: 0, nu: 0, time: 0,
      qpos: new Float64Array(0),
      qvel: new Float64Array(0),
      ctrl: new Float64Array(0),
      joints: {},
      actuators: {},
    };
    const newQpos = new Float64Array(2);
    const newQvel = new Float64Array([0, 42]);
    const mockModel = {
      nq: 2,
      nv: 2,
      jnt_type: new Int32Array([3, 3]), // two hinges, nv=1 each
      jnt_qposadr: new Int32Array([0, 1]),
      jnt_dofadr: new Int32Array([0, 1]),
    };
    const mockData = { qpos: newQpos, qvel: newQvel };
    const nodes: SceneNode[] = [
      {
        id: 'hinge_a', name: 'hinge_a', type: 'body', pos: [0, 0, 0], children: [],
        joints: [{ name: 'j_a', type: 'hinge', initialVelocity: [7, 999, 888] }],
      },
      {
        id: 'hinge_b', name: 'hinge_b', type: 'body', pos: [0, 0, 0], children: [],
        joints: [{ name: 'j_b', type: 'hinge', initialVelocity: [NaN] }],
      },
    ];
    const seeded = seedNewBodies(
      carried,
      mockModel as never,
      mockData as never,
      nodes,
      { j_a: 0, j_b: 1 },
      new Set(),
    );
    expect(seeded).toBe(true);
    expect(newQvel[0]).toBe(7);
    expect(newQvel[1]).toBe(42); // untouched by hinge_a overflow and hinge_b NaN
  });
});

// ---------------------------------------------------------------------------
// Finding #5: mujocoSync.ts cloth <frame> offset & empty node.name fallback
// ---------------------------------------------------------------------------
describe('Finding #5: getSyncedSceneGraph cloth frame & empty node.name fallback', () => {
  it('propagates cloth frame offset to child bodies and falls back to node.id when node.name is empty', () => {
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'cloth_frame',
          name: 'cloth_frame',
          type: 'body',
          pos: [1, 2, 3],
          quat: [1, 0, 0, 0],
          cloth: { preset: 'flag' } as unknown as SceneNode['cloth'],
          children: [
            {
              id: 'child_body_id',
              name: '',
              type: 'body',
              pos: [0, 0, 0],
              children: [],
            },
          ],
        },
      ],
    };

    const mockMujoco: SyncMujoco = {
      mjtObj: { mjOBJ_BODY: { value: 1 } },
      mj_name2id: (_model, _type, name) => (name === 'child_body_id' ? 1 : -1),
    };
    const mockData: SyncData = {
      // body 0 (world) at origin, body 1 at world [1.5, 2.25, 3.75]
      xpos: [0, 0, 0, 1.5, 2.25, 3.75],
      xmat: [
        1, 0, 0, 0, 1, 0, 0, 0, 1,
        1, 0, 0, 0, 1, 0, 0, 0, 1,
      ],
    };

    const synced = getSyncedSceneGraph(scene, {} as ModelMirror, mockData, mockMujoco);
    const child = synced.nodes[0].children![0];
    // Local pos relative to cloth_frame [1, 2, 3] must be [0.5, 0.25, 0.75]
    expect(child.pos[0]).toBeCloseTo(0.5, 6);
    expect(child.pos[1]).toBeCloseTo(0.25, 6);
    expect(child.pos[2]).toBeCloseTo(0.75, 6);
  });
});

// ---------------------------------------------------------------------------
// Finding #7: worldToBodyFrame for ball joints
// ---------------------------------------------------------------------------
describe('Finding #7: ball joint worldToBodyFrame conversion', () => {
  it('transforms world angular velocity into rotated body local frame', () => {
    // 90 deg rotation around Z: body X = world Y, body Y = -world X, body Z = world Z
    // R = [[0, -1, 0], [1, 0, 0], [0, 0, 1]] -> R^T * [1, 0, 0] = [0, -1, 0]
    const xmat = new Float64Array([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
      0, -1, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const local = worldToBodyFrame(xmat, 1, [1, 0, 0]);
    expect(local[0]).toBeCloseTo(0, 6);
    expect(local[1]).toBeCloseTo(-1, 6);
    expect(local[2]).toBeCloseTo(0, 6);
  });

  it('uses worldToBodyFrame for ball joints in physicsWorker setAngularVelocity', () => {
    const ballBranch = WORKER_SRC.match(/else if \(joint\.type === 'ball'\) \{[\s\S]*?dat\.qvel\[dofadr \+ 2\] = w\[2\];/);
    expect(ballBranch).not.toBeNull();
    expect(ballBranch![0]).toContain('worldToBodyFrame(dat.xmat, mdl.jnt_bodyid[jId]');
  });
});

// ---------------------------------------------------------------------------
// Finding #8: headlessImpacts evaluates shatterVerdict & mark on otherNodeId
// ---------------------------------------------------------------------------
describe('Finding #8: headlessImpacts evaluates otherNodeId independently', () => {
  const unitBoxMesh = () => ({
    // Simple 8-vertex cube (12 triangles)
    renderVertices: [
      -0.1, -0.1, -0.1,  0.1, -0.1, -0.1,  0.1, 0.1, -0.1, -0.1, 0.1, -0.1,
      -0.1, -0.1,  0.1,  0.1, -0.1,  0.1,  0.1, 0.1,  0.1, -0.1, 0.1,  0.1,
    ],
    faces: [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6,
      0, 4, 7, 0, 7, 3,
      1, 2, 6, 1, 6, 5,
    ],
  });

  it('marks otherNodeId even when primary node shatters, and shatters otherNodeId when primary does not', async () => {
    const { renderVertices, faces } = unitBoxMesh();
    const striker: SceneNode = {
      id: 'striker',
      name: 'striker',
      type: 'body',
      pos: [0, 0, 1],
      joints: [{ name: 'striker_free', type: 'free' }],
      geoms: [{ name: 'striker_g', type: 'mesh', size: [1], mass: 1, renderVertices, faces }],
      shatterImpulseNs: 5,
      shatterPieces: 4,
      shatterSeed: 1,
      children: [],
    };
    const dentablePlate: SceneNode = {
      id: 'plate',
      name: 'plate',
      type: 'body',
      pos: [0, 0, 0.1],
      geoms: [{
        name: 'plate_g', type: 'mesh', size: [1], mass: 2, renderVertices, faces,
        dentYieldNs: 2, dentDepthPerNs: 0.002,
      }],
      children: [],
    };
    const scene: SceneGraph = { nodes: [striker, dentablePlate] };
    const impacts = headlessImpacts(scene, () => '<mujoco/>');

    const event: ImpactEvent = {
      nodeId: 'striker',
      otherNodeId: 'plate',
      otherLocalPoint: [0, 0, 0.1],
      otherLocalNormal: [0, 0, -1],
      time: 0.2,
      impulseNs: 10,
      localPoint: [0, 0, -0.1],
      localNormal: [0, 0, 1],
      pos: [0, 0, 0.2],
      xmat: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      vel: [0, 0, -5],
      angvel: [0, 0, 0],
    };

    const rebuild = await impacts.judge(event);
    expect(rebuild).not.toBeNull();
    expect(impacts.shattered.map((s) => s.id)).toEqual(['striker']);
    // Previously skipped because striker shattered and returned early!
    expect(impacts.dented.some((d) => d.body === 'plate')).toBe(true);
  }, 30_000);

  it('shatters otherNodeId when striker is indestructible and otherNodeId is shatterable', async () => {
    const { renderVertices, faces } = unitBoxMesh();
    const hammer: SceneNode = {
      id: 'hammer',
      name: 'hammer',
      type: 'body',
      pos: [0, 0, 1],
      joints: [{ name: 'hammer_free', type: 'free' }],
      geoms: [{ name: 'hammer_g', type: 'box', size: [0.1, 0.1, 0.1], mass: 5 }],
      children: [],
    };
    const glass: SceneNode = {
      id: 'glass',
      name: 'glass',
      type: 'body',
      pos: [0, 0, 0.1],
      geoms: [{ name: 'glass_g', type: 'mesh', size: [1], mass: 1, renderVertices, faces }],
      shatterImpulseNs: 4,
      shatterPieces: 4,
      shatterSeed: 2,
      children: [],
    };
    const scene: SceneGraph = { nodes: [hammer, glass] };
    const impacts = headlessImpacts(scene, () => '<mujoco/>');

    const event: ImpactEvent = {
      nodeId: 'hammer',
      otherNodeId: 'glass',
      otherLocalPoint: [0, 0, 0.1],
      otherLocalNormal: [0, 0, -1],
      time: 0.3,
      impulseNs: 12,
      localPoint: [0, 0, -0.1],
      localNormal: [0, 0, 1],
      pos: [0, 0, 0.2],
      xmat: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      vel: [0, 0, -4],
      angvel: [0, 0, 0],
    };

    const rebuild = await impacts.judge(event);
    expect(rebuild).not.toBeNull();
    expect(impacts.shattered.map((s) => s.id)).toEqual(['glass']);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Finding #12: Fatal loadMujoco failure triggers client recycle
// ---------------------------------------------------------------------------
describe('Finding #12: fatal BUILT / HEADLESS_RESULT triggers onError(fatal=true)', () => {
  class MockWorker {
    onmessage: ((evt: MessageEvent) => void) | null = null;
    onerror: ((evt: ErrorEvent) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
  }
  let created: MockWorker[] = [];

  beforeEach(() => {
    created = [];
    (globalThis as unknown as { Worker: unknown }).Worker = class {
      constructor() {
        const w = new MockWorker();
        created.push(w);
        return w as unknown as Worker;
      }
    };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Worker;
  });

  it('calls onError with fatal=true and rejects other pending work on fatal BUILT failure', async () => {
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    const onError = vi.fn();
    client.onError = onError;

    const buildP = client.build('<mujoco/>', { nodes: [] }, false);
    const telemP = client.getTelemetry();
    const buildId = (created[0].postMessage.mock.calls[0][0] as { id: string }).id;

    created[0].onmessage!({
      data: { type: 'BUILT', id: buildId, ok: false, error: 'The physics engine failed to load: 404', fatal: true },
    } as MessageEvent);

    const built = await buildP;
    expect(built.ok).toBe(false);
    expect(built.fatal).toBe(true);
    await expect(telemP).rejects.toThrow(/failed to load/);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/failed to load/), true);
    client.terminate();
  });

  it('marks loadMujoco failure fatal in physicsWorker BUILD and RUN_HEADLESS', () => {
    expect(WORKER_SRC).toContain('const fatal = loadFailed || /Aborted|enlarge memory|abort|bad_alloc/i.test(errMsg);');
    expect(WORKER_SRC).toContain("post({ type: 'ERROR', message: errMsg, fatal: true });");
  });
});

// ---------------------------------------------------------------------------
// Findings #1, #2, #4, #6, #9, #10, #11: PhysicsWorker structural invariants
// ---------------------------------------------------------------------------
describe('PhysicsWorker audit invariants (#1, #2, #4, #6, #9, #10, #11)', () => {
  it('#1 & #2: rebuildMidRun detaches threadpool before compiling, cleans up leaks, and re-binds on failure', () => {
    const fnStart = WORKER_SRC.indexOf('const rebuildMidRun = (rebuild: HeadlessRebuild) => {');
    const fnSlice = WORKER_SRC.slice(fnStart, fnStart + 1400);
    const detachIdx = fnSlice.indexOf('mj.mju_threadpool(headlessData, 0)');
    const compileIdx = fnSlice.indexOf('mj.MjModel.from_xml_string(rebuild.xml');
    const rebindIdx = fnSlice.indexOf('mj.mju_threadpool(headlessData, STEP_THREADS)');
    expect(detachIdx).toBeGreaterThan(-1);
    expect(compileIdx).toBeGreaterThan(detachIdx);
    expect(rebindIdx).toBeGreaterThan(compileIdx);
    expect(fnSlice).toContain('nextData.delete()');
    expect(fnSlice).toContain('nextModel.delete()');
  });

  it('#2: doBuild cleans up newData and newModel on partial allocation failure', () => {
    const buildIdx = WORKER_SRC.indexOf('let newModel: MjModel | null = null;');
    expect(buildIdx).toBeGreaterThan(-1);
    const slice = WORKER_SRC.slice(buildIdx, buildIdx + 600);
    expect(slice).toContain('if (newData) { try { newData.delete(); }');
    expect(slice).toContain('if (newModel) { try { newModel.delete(); }');
  });

  it('#4: cold-boot BUILD and RUN_HEADLESS hold and drain incoming messages while loadMujoco awaits', () => {
    expect(WORKER_SRC).toContain('const drainHeldMessages = async () => {');
    expect(WORKER_SRC).toContain('const holds = !mujoco && !heldMessages;');
    expect(WORKER_SRC).toContain('const holds = (!mujoco || judged) && !heldMessages;');
  });

  it('#6: stepOnce checks auto-reset and qpos/qvel finiteness before side effects and resets audio watch state', () => {
    const start = WORKER_SRC.indexOf('const stepOnce = (stepSize: number): boolean => {');
    const end = WORKER_SRC.indexOf('const stepFor =', start);
    const slice = WORKER_SRC.slice(start, end);
    const stepIdx = slice.indexOf('mujoco.mj_step(model, data);');
    const qposCheckIdx = slice.indexOf('NaN or Inf detected in qpos');
    const qvelCheckIdx = slice.indexOf('NaN or Inf detected in qvel');
    const clothIdx = slice.indexOf('stepCloth(stepSize);');
    const syncIdx = slice.indexOf('syncKinematics(mujoco, model, data);');
    expect(stepIdx).toBeGreaterThan(-1);
    expect(qposCheckIdx).toBeGreaterThan(stepIdx);
    expect(qvelCheckIdx).toBeGreaterThan(qposCheckIdx);
    expect(clothIdx).toBeGreaterThan(qvelCheckIdx);
    expect(syncIdx).toBeGreaterThan(clothIdx);
    expect(slice.match(/resetAudioWatchState\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('#9: script applyForce/applyTorque and pose/velocity setters check Number.isFinite', () => {
    const start = WORKER_SRC.indexOf('const _alongAxis =');
    const end = WORKER_SRC.indexOf('getOrientation:', start);
    const slice = WORKER_SRC.slice(start, end);
    expect(slice).toContain('value must be a finite number; nothing was set');
    expect(slice).toContain('all ${n} components must be finite numbers; nothing was set');
    expect(slice).toContain('applyForce: pass [fx, fy, fz] of 3 finite numbers; nothing was applied');
    expect(slice).toContain('applyTorque: pass [tx, ty, tz] of 3 finite numbers; nothing was applied');
  });

  it('#10: runHeadless saves and restores lastNodeStrikeSimTime and pendingAeroSnaps', () => {
    expect(WORKER_SRC).toContain('const savedLastNodeStrike = new Map(lastNodeStrikeSimTime);');
    expect(WORKER_SRC).toContain('const savedPendingAeroSnaps = new Map(pendingAeroSnaps);');
    expect(WORKER_SRC).toContain('for (const [k, v] of savedLastNodeStrike) lastNodeStrikeSimTime.set(k, v);');
    expect(WORKER_SRC).toContain('for (const [k, v] of savedPendingAeroSnaps) pendingAeroSnaps.set(k, v);');
  });

  it('#11: SET_QPOS guards both array and scalar writes with bounds and finiteness checks', () => {
    const start = WORKER_SRC.indexOf("case 'SET_QPOS':");
    const slice = WORKER_SRC.slice(start, start + 1100);
    expect(slice).toContain("typeof msg.value === 'number' && Number.isFinite(msg.value)");
    expect(slice).toContain('idx >= 0 && idx < model.nq');
  });
});
