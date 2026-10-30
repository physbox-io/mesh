// physics_run_headless shatters and dents the way the live run does.
//
// A lattice chair (9.7 kg, shatterImpulseNs 8, 10 pieces, seed 3) dropped
// about a metre shattered live at t = 0.46 s and finished whole headless. The
// run now stops at the tick of every blow, asks the same judge the live store
// is (shatterVerdict, the same cut, the same shard graph) and rebuilds around
// the pieces with the state carried by joint name.
//
// The physics worker cannot be loaded here, so this drives its loop from the
// modules it is built from: impactWatch (the blow), headlessLoop (the pause),
// headlessImpacts (the judge), carryState (the rebuild). Keep it in step with
// runHeadless's rebuildMidRun in src/workers/physicsWorker.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import type { ManifoldToplevel } from 'manifold-3d';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildImpactWatches, checkImpacts } from '../src/workers/impactWatch';
import { captureState, copyJointsByName, seedNewBodies } from '../src/workers/carryState';
import { headlessLoop } from '../src/store/physicsWorkerClient';
import { headlessImpacts, type HeadlessImpacts } from '../src/hooks/mcp/headlessImpacts';
import { loadManifold } from '../src/utils/sculptCut';
import { fractureSolid } from '../src/utils/fractureClip';
import { zupToYup } from '../src/utils/runtimeShatter';
import { createLattice, deserializeCage, serializeCage, toSceneGeom, DEFAULT_UNIT } from '../src/utils/latticeMesh';
import { runLatticeOps } from '../src/hooks/mcp/latticeState';
import type { ImpactEvent } from '../src/workers/physicsWorkerProtocol';
import type { SceneGraph, SceneNode } from '../src/types/scene';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
type MjData = InstanceType<Mujoco['MjData']>;

let mj: Mujoco;
let wasm: ManifoldToplevel;
beforeAll(async () => {
  mj = await load_mujoco();
  wasm = await loadManifold();
}, 60_000);

type P = [number, number, number];
function box(min: P, max: P): P[][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
}

/** One mesh geom from cage faces (mm), centred on its centroid, and where that centroid is (m). */
function meshOf(faces: P[][]) {
  const lattice = createLattice(DEFAULT_UNIT);
  runLatticeOps(lattice, [{ op: 'faces', faces }]);
  return toSceneGeom(deserializeCage(serializeCage(lattice)), 0, 0);
}

/** The chair from the report: seat, four legs and a back, fused. */
const chairMesh = () => meshOf([
  ...box([-180, -180, 410], [180, 180, 440]),
  ...box([-180, -180, 0], [-150, -150, 410]),
  ...box([150, -180, 0], [180, -150, 410]),
  ...box([-180, 150, 0], [-150, 180, 410]),
  ...box([150, 150, 0], [180, 180, 410]),
  ...box([-180, 150, 440], [180, 180, 840]),
]);
const CHAIR_KG = 9.684;
/** Leg bottoms this high above the floor. */
const DROP_M = 1;

function chair(over: Partial<SceneNode> = {}): SceneNode {
  const { renderVertices, faces, origin } = chairMesh();
  return {
    id: 'chair', name: 'chair', type: 'body',
    pos: [origin[0], origin[1], origin[2] + DROP_M],
    joints: [{ name: 'chair_free', type: 'free' }],
    children: [],
    geoms: [{
      name: 'chair_geom', type: 'mesh', size: [1], dynamic: true, mass: CHAIR_KG,
      renderVertices, vertices: zupToYup(renderVertices), faces,
    }],
    collision: 'hull',
    shatterImpulseNs: 8, shatterPieces: 10, shatterSeed: 3,
    ...over,
  };
}

interface Frame { time: number; bodies: Record<string, P> }

interface Run {
  frames: Frame[];
  impacts: HeadlessImpacts;
  events: ImpactEvent[];
  /** Mass of every body in the final model, by name. */
  massOf: Record<string, number>;
}

function idMaps(model: MjModel) {
  const body: Record<string, number> = {};
  const joint: Record<string, number> = {};
  for (let i = 1; i < model.nbody; i++) body[mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, i)] = i;
  for (let i = 0; i < model.njnt; i++) joint[mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, i)] = i;
  return { body, joint };
}

/** runHeadless, judged, as the worker runs it. */
async function headlessRun(scene: SceneGraph, seconds: number): Promise<Run> {
  const impacts = headlessImpacts(scene, (g) => compileToMJCF(g, -9.81, 1, 0, 0, 0, 0, { sleep: true }));
  let model: MjModel = mj.MjModel.from_xml_string(compileToMJCF(scene));
  let data: MjData = new mj.MjData(model);
  let graph = scene;
  let ids = idMaps(model);
  let watches = buildImpactWatches(model, graph.nodes, ids.body, ids.joint);
  let dt: number = model.opt.timestep;
  mj.mj_forward(model, data);
  const pending: ImpactEvent[] = [];
  const events: ImpactEvent[] = [];
  const loop = headlessLoop<Frame>({ ticks: Math.round(seconds / dt), stride: 5 }, {
    step: () => {
      mj.mj_step(model, data);
      const found = checkImpacts(watches, model, data, dt);
      pending.push(...found);
      events.push(...found);
    },
    time: () => data.time,
    isBad: () => false,
    sample: () => ({
      time: data.time,
      bodies: Object.fromEntries(Object.entries(ids.body).map(([name, b]) =>
        [name, [data.xipos[b * 3], data.xipos[b * 3 + 1], data.xipos[b * 3 + 2]] as P])),
    }),
    interrupted: () => pending.length > 0,
  });
  let next = loop.next();
  while (!next.done) {
    for (const event of pending.splice(0)) {
      const rebuild = await impacts.judge(event);
      if (!rebuild) continue;
      const carried = captureState(model, data, ids.joint, {})!;
      const nextModel: MjModel = mj.MjModel.from_xml_string(rebuild.xml);
      const nextData: MjData = new mj.MjData(nextModel);
      data.delete();
      model.delete();
      model = nextModel;
      data = nextData;
      graph = rebuild.sceneGraph;
      ids = idMaps(model);
      dt = model.opt.timestep;
      const placed = copyJointsByName(carried, model, data, ids.joint);
      data.time = carried.time;
      mj.mj_forward(model, data);
      if (seedNewBodies(carried, model, data, graph.nodes, ids.joint, placed)) mj.mj_forward(model, data);
      watches = buildImpactWatches(model, graph.nodes, ids.body, ids.joint);
    }
    next = loop.next();
  }
  const massOf = Object.fromEntries(Object.entries(ids.body).map(([name, b]) => [name, model.body_mass[b] as number]));
  data.delete();
  model.delete();
  return { frames: next.value.frames, impacts, events, massOf };
}

/** Centre of mass of the named bodies in one frame. */
function comOf(frame: Frame, names: string[], massOf: Record<string, number>): P {
  let m = 0;
  const c: P = [0, 0, 0];
  for (const n of names) {
    const p = frame.bodies[n];
    if (!p) continue;
    const w = massOf[n] ?? 0;
    m += w;
    for (let i = 0; i < 3; i++) c[i] += p[i] * w;
  }
  return c.map((v) => v / m) as P;
}

describe('physics_run_headless shatters', () => {
  it('breaks a dropped chair at the impact, into the pieces the live cut makes', async () => {
    const run = await headlessRun({ nodes: [chair()] } as SceneGraph, 1.2);
    expect(run.impacts.shattered).toHaveLength(1);
    const [broke] = run.impacts.shattered;
    expect(broke.id).toBe('chair');
    // Free fall from a metre lands at sqrt(2 h / g) = 0.45 s. Live it broke
    // at 0.46 s with about 19 N*s, measured over the same window.
    expect(broke.time).toBeGreaterThan(0.4);
    expect(broke.time).toBeLessThan(0.55);
    expect(broke.impulseNs).toBeGreaterThanOrEqual(8);
    expect(broke.impulseNs).toBeGreaterThan(12);
    expect(broke.impulseNs).toBeLessThan(30);

    // The same pieces the cut gives for that blow: ten cells of the solid,
    // each connected piece its own shard.
    const event = run.events.find((e) => e.nodeId === 'chair')!;
    const { renderVertices, faces } = chairMesh();
    const cells = fractureSolid(wasm, renderVertices, faces, { pieces: 10, seed: 3, focus: event.localPoint as P });
    expect(broke.shards).toHaveLength(cells.length);
    expect(cells.length).toBeGreaterThanOrEqual(10);
    expect(cells.length).toBeLessThanOrEqual(20);
    expect(broke.shards.every((id, i) => id === `chair_shard${i}`)).toBe(true);

    // Together they weigh what the chair weighed, in the model the run went on with.
    const shardMass = broke.shards.reduce((s, id) => s + run.massOf[id], 0);
    expect(shardMass).toBeCloseTo(CHAIR_KG, 6);
    expect(run.massOf.chair).toBeUndefined();

    // The trajectory has the chair until the blow and its pieces after, with
    // time running on across the rebuild.
    const before = run.frames.filter((f) => f.time <= broke.time);
    const after = run.frames.filter((f) => f.time > broke.time);
    expect(before.every((f) => f.bodies.chair && !f.bodies.chair_shard0)).toBe(true);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((f) => !f.bodies.chair && broke.shards.every((id) => f.bodies[id]))).toBe(true);
    for (let i = 1; i < run.frames.length; i++) expect(run.frames[i].time).toBeGreaterThan(run.frames[i - 1].time);

    // And they start where it was: the pieces' centre of mass picks up from
    // the chair's, a frame on, not a jump.
    const last = before[before.length - 1];
    const first = after[0];
    const was = last.bodies.chair;
    const now = comOf(first, broke.shards, run.massOf);
    const gap = Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]);
    expect(gap).toBeLessThan(0.02);
  }, 60_000);

  it('leaves a chair hit under its threshold whole', async () => {
    // The same drop lands with about 19 N*s, so 40 holds.
    const run = await headlessRun({ nodes: [chair({ shatterImpulseNs: 40 })] } as SceneGraph, 1.0);
    expect(run.impacts.shattered).toHaveLength(0);
    expect(run.frames.every((f) => f.bodies.chair)).toBe(true);
    // It did land, whole.
    const end = run.frames[run.frames.length - 1].bodies.chair;
    expect(end[2]).toBeLessThan(0.6);
  }, 60_000);

  it('breaks the same way twice for the same seed, and differently for another', async () => {
    const shardsOf = async (seed: number) => {
      const scene = { nodes: [chair({ shatterSeed: seed })] } as SceneGraph;
      const run = await headlessRun(scene, 0.6);
      return { ids: run.impacts.shattered[0]?.shards, final: run.frames[run.frames.length - 1] };
    };
    const a = await shardsOf(3);
    const b = await shardsOf(3);
    const c = await shardsOf(11);
    expect(a.ids).toEqual(b.ids);
    expect(a.final).toEqual(b.final);
    expect(c.final).not.toEqual(a.final);
  }, 120_000);
});

describe('physics_run_headless dents', () => {
  it('records the crater a dropped weight leaves in a plate', async () => {
    const plateMesh = meshOf(box([-150, -150, 0], [150, 150, 10]));
    const plate: SceneNode = {
      id: 'plate', name: 'plate', type: 'body', pos: plateMesh.origin, joints: [], children: [],
      geoms: [{
        name: 'plate_geom', type: 'mesh', size: [1], mass: 7,
        renderVertices: plateMesh.renderVertices, vertices: zupToYup(plateMesh.renderVertices), faces: plateMesh.faces,
        dentYieldNs: 1,
      }],
    };
    const weight: SceneNode = {
      id: 'weight', name: 'weight', type: 'body', pos: [0, 0, 0.5],
      joints: [{ name: 'weight_free', type: 'free' }], children: [],
      geoms: [{ name: 'weight_geom', type: 'sphere', size: [0.02], mass: 2 }],
    };
    const run = await headlessRun({ nodes: [plate, weight] } as SceneGraph, 0.6);
    expect(run.impacts.shattered).toHaveLength(0);
    const dent = run.impacts.dented.find((d) => d.body === 'plate');
    expect(dent?.geom).toBe('plate_geom');
    expect(dent!.depthMm!).toBeGreaterThan(0);
    // Two kilograms landing at 3 m/s: well over the 1 N*s yield.
    expect(dent!.impulseNs).toBeGreaterThan(1);
    expect(dent!.time).toBeGreaterThan(0.25);
  }, 60_000);
});
