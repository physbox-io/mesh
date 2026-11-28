// Runs cloth exactly as the physics worker does: the scene compiled by the
// real compiler into a real MuJoCo model, the graph stripped of its meshes as
// the app sends it to the worker, and the cloth built by the same
// buildClothWorld (utils/cloth/clothWorld), stepped beside mj_step.

import * as THREE from 'three';
import type { SceneNode } from '../src/types/scene';
import type { ClothModel } from '../src/utils/cloth/clothModel';
import { colliderContact, type Collider } from '../src/utils/cloth/clothColliders';
import { setSettleBudgetMs, setUntangleBudgetMs, type ClothEnv, type ClothSim } from '../src/utils/cloth/xpbd';

// The physics, not the machine's speed: a settle cut short by the wall clock
// leaves crossings a faster machine would have sewn out.
setSettleBudgetMs(Infinity);
setUntangleBudgetMs(Infinity);
import { buildClothWorld } from '../src/utils/cloth/clothWorld';
import { syncKinematics } from '../src/workers/bodyKinematics';
import { clothCrossings, type Crossing } from './clothIntersections';
import { compileToMJCF } from '../src/utils/mjcf';
import { withoutMeshData } from '../src/store/physicsWorkerClient';
import { bodyFormGeoms } from '../src/utils/cloth/bodyForm';
import { bodyFormKey, finishBodyFormGeoms } from '../src/utils/cloth/bodyFormEdit';
import load_mujoco from '@mujoco/mujoco';
import type { SceneGraph } from '../src/types/scene';

/** Ensure lazy preset bodyForm nodes (`geoms: []`) have their geoms built in headless test runs, as `useCsgCompile` does in the app. */
function withBuiltBodyForms(nodes: SceneNode[]): SceneNode[] {
  let changed = false;
  const out = nodes.map((n) => {
    const children = n.children?.length ? withBuiltBodyForms(n.children) : n.children;
    if (n.bodyForm && (!n.geoms || n.geoms.length === 0)) {
      changed = true;
      const built: SceneNode = { ...n, geoms: finishBodyFormGeoms(bodyFormGeoms(n.bodyForm, n.name || n.id)), children };
      built.bodyFormBuilt = bodyFormKey(built);
      return built;
    }
    if (children !== n.children) { changed = true; return { ...n, children }; }
    return n;
  });
  return changed ? out : nodes;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let mjPromise: Promise<any> | null = null;
export const mujocoReady = () => (mjPromise ??= load_mujoco());

export interface ClothRun {
  sim: ClothSim;
  models: ClothModel[];
  colliders: Collider[];
  worlds: Map<string, THREE.Matrix4>;
  run: (seconds: number, env?: Partial<ClothEnv>) => void;
  /** Nearest any moving particle is to any body (not the floor), metres; negative is inside. */
  clearance: () => number;
  /** Edge lengths over their cut lengths, minus one, sorted. */
  strains: () => number[];
  /** Mean particle speed over the last `dt` of a run, m/s. */
  speedOver: (dt: number, env?: Partial<ClothEnv>) => number;
  /** Cloth edges crossing cloth triangles they are not joined to: cloth through cloth (tests/clothIntersections). */
  crossings: () => Crossing[];
  /** The MuJoCo model and data it steps beside. */
  mjModel: any;
  mjData: any;
}

export async function clothRun(scene: SceneNode[]): Promise<ClothRun> {
  const mj = await mujocoReady();
  const graph = { nodes: withBuiltBodyForms(scene) } as SceneGraph;
  const model = mj.MjModel.from_xml_string(compileToMJCF(graph));
  const data = new mj.MjData(model);
  mj.mj_forward(model, data);
  const world = buildClothWorld(mj, model, data, withoutMeshData(graph), null, false);
  if (!world) throw new Error('no cloth in the scene');
  const sim = world.sim;
  const models = (sim as unknown as { pieces: { model: ClothModel }[] }).pieces.map((p) => p.model);
  const colliders = (sim as unknown as { colliders: Collider[] }).colliders;
  const worlds = new Map<string, THREE.Matrix4>();
  const env = (e: Partial<ClothEnv> = {}): ClothEnv => ({ gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.225, ...e });
  // MuJoCo steps too, as in the worker: the cloth reads where the bodies are
  // after each (mj_step leaves xpos at the step's start, so kinematics first).
  const dtMj = model.opt.timestep;
  const run = (seconds: number, e: Partial<ClothEnv> = {}) => {
    const end = sim.time + seconds;
    while (sim.time < end - 1e-9) { mj.mj_step(model, data); syncKinematics(mj, model, data); world.advance(dtMj, env(e)); }
    // Read as it is drawn: collision over the substeps since it last looked.
    sim.collidePending();
  };
  const moving = new Uint8Array(sim.n);
  let base = 0;
  for (const m of models) { for (let i = 0; i < m.invMass.length; i++) moving[base + i] = m.invMass[i] > 0 ? 1 : 0; base += m.invMass.length; }
  // The colliders' current inverse poses, as the solver holds them.
  const inv = (sim as unknown as { inv: THREE.Matrix4[] }).inv;
  const clearance = () => {
    let nearest = Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < sim.n; i++) {
      if (!moving[i]) continue;
      colliders.forEach((c, ci) => {
        if (!c.body && c.geom === undefined) return; // the floor
        p.set(sim.x[3 * i], sim.x[3 * i + 1], sim.x[3 * i + 2]).applyMatrix4(inv[ci]);
        const h = colliderContact(c, [p.x, p.y, p.z]);
        if (h) nearest = Math.min(nearest, h.d);
      });
    }
    return nearest;
  };
  // Each edge's strain, counted for the cloth it stands for (a third of each
  // triangle it bounds, as modelled): a garment's triangles are smaller where
  // it curves, and counted alike, those edges outweighed the cloth they are.
  // Returned as as many evenly weighted samples as there are edges, sorted,
  // for percentile().
  const share = models.map((m) => {
    const n = m.invMass.length, at = new Map<number, number>();
    for (let t = 0; t < m.tris.length; t += 3) {
      const [a, b, c] = [m.tris[t], m.tris[t + 1], m.tris[t + 2]].map((v) => [m.x0[3 * v], m.x0[3 * v + 1], m.x0[3 * v + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const third = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 6;
      for (let e = 0; e < 3; e++) { const p = m.tris[t + e], q = m.tris[t + ((e + 1) % 3)], k = p < q ? p * n + q : q * n + p; at.set(k, (at.get(k) ?? 0) + third); }
    }
    return (p: number, q: number, rest: number) => at.get(p < q ? p * n + q : q * n + p) ?? rest * rest / 4;
  });
  const strains = () => {
    const all: [number, number][] = [];
    let b = 0, whole = 0;
    models.forEach((m, mi) => {
      for (let k = 0; k < m.edges.length; k += 2) {
        const i = 3 * (b + m.edges[k]), j = 3 * (b + m.edges[k + 1]), rest = m.edgeRest[k / 2], wt = share[mi](m.edges[k], m.edges[k + 1], rest);
        all.push([Math.hypot(sim.x[i] - sim.x[j], sim.x[i + 1] - sim.x[j + 1], sim.x[i + 2] - sim.x[j + 2]) / rest - 1, wt]);
        whole += wt;
      }
      b += m.invMass.length;
    });
    all.sort((p, q) => p[0] - q[0]);
    const out: number[] = [];
    for (let k = 0, acc = 0; k < all.length; k++) {
      acc += all[k][1];
      while (out.length < all.length && (out.length + 1) * whole <= acc * all.length * (1 + 1e-12)) out.push(all[k][0]);
    }
    while (out.length < all.length) out.push(all[all.length - 1][0]);
    return out;
  };
  const speedOver = (dt: number, e: Partial<ClothEnv> = {}) => {
    const before = Float64Array.from(sim.x);
    run(dt, e);
    let moved = 0, n = 0;
    for (let i = 0; i < sim.n; i++) {
      if (!moving[i]) continue;
      moved += Math.hypot(sim.x[3 * i] - before[3 * i], sim.x[3 * i + 1] - before[3 * i + 1], sim.x[3 * i + 2] - before[3 * i + 2]);
      n++;
    }
    return moved / Math.max(1, n) / dt;
  };
  const pieceAt: string[] = [];
  for (const m of models) {
    const part = new Array<string>(m.invMass.length).fill(m.name);
    for (const g of m.groups) for (const q of g.particles) part[q] = g.name;
    pieceAt.push(...part);
  }
  const internals = sim as unknown as { tris: Int32Array; stitches: Int32Array };
  const crossings = () => clothCrossings(sim.x, internals.tris, internals.stitches, (i) => pieceAt[i]);
  return { sim, models, colliders, worlds, run, clearance, strains, speedOver, crossings, mjModel: model, mjData: data };
}

export const percentile = (sorted: number[], f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))];
