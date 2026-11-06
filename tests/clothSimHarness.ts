// Runs cloth exactly as the physics worker does: the scene compiled by the
// real compiler into a real MuJoCo model, the graph stripped of its meshes as
// the app sends it to the worker, and the cloth built by the same
// buildClothWorld (utils/cloth/clothWorld), stepped beside mj_step.

import * as THREE from 'three';
import type { SceneNode } from '../src/types/scene';
import type { ClothModel } from '../src/utils/cloth/clothModel';
import { colliderContact, type Collider } from '../src/utils/cloth/clothColliders';
import type { ClothEnv, ClothSim } from '../src/utils/cloth/xpbd';
import { buildClothWorld } from '../src/utils/cloth/clothWorld';
import { compileToMJCF } from '../src/utils/mjcf';
import { withoutMeshData } from '../src/store/physicsWorkerClient';
import load_mujoco from '@mujoco/mujoco';
import type { SceneGraph } from '../src/types/scene';

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
}

export async function clothRun(scene: SceneNode[]): Promise<ClothRun> {
  const mj = await mujocoReady();
  const graph = { nodes: scene } as SceneGraph;
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
  // MuJoCo steps too, as in the worker: the cloth reads where the bodies are after each.
  const dtMj = model.opt.timestep;
  const run = (seconds: number, e: Partial<ClothEnv> = {}) => {
    const end = sim.time + seconds;
    while (sim.time < end - 1e-9) { mj.mj_step(model, data); world.advance(dtMj, env(e)); }
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
  const strains = () => {
    const out: number[] = [];
    let b = 0;
    for (const m of models) {
      for (let k = 0; k < m.edges.length; k += 2) {
        const i = 3 * (b + m.edges[k]), j = 3 * (b + m.edges[k + 1]);
        out.push(Math.hypot(sim.x[i] - sim.x[j], sim.x[i + 1] - sim.x[j + 1], sim.x[i + 2] - sim.x[j + 2]) / m.edgeRest[k / 2] - 1);
      }
      b += m.invMass.length;
    }
    return out.sort((p, q) => p - q);
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
  return { sim, models, colliders, worlds, run, clearance, strains, speedOver };
}

export const percentile = (sorted: number[], f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * (sorted.length - 1)))];
