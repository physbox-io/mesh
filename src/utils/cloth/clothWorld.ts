/**
 * A scene's cloth, set up beside a MuJoCo model: what the physics worker
 * runs, and what the cloth tests run, from the same inputs (a compiled model
 * and data, and the scene graph as the worker gets it, meshes stripped). One
 * path for both, so a test cannot pass on something the app never does: the
 * first time they differed, the tests built the form's torso from the
 * graph's mesh, the worker had no mesh, and cloth fell through the form.
 */

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../../types/scene';
import { walkBodiesWorld } from '../bodyWorld';
import { clothModel, type ClothModel } from './clothModel';
import { meshShape, sceneColliders, sceneMeshGeoms, type Collider } from './clothColliders';
import { ClothSim, type ClothEnv } from './xpbd';

/* eslint-disable @typescript-eslint/no-explicit-any -- the MuJoCo wasm bindings are untyped here */
type Mj = any;
type Model = any;
type Data = any;

const modelCache = new Map<string, ClothModel>();

export interface ClothWorld {
  sim: ClothSim;
  /** What each cloth was built from, to tell whether a rebuild is the same cloth. */
  keys: string[];
  /** Pose the colliders from where MuJoCo has every body now. */
  pose: () => void;
  advance: (dt: number, env: ClothEnv) => void;
}

/** Row-major 3x3 and a position into a matrix. */
function fromMujoco(r: ArrayLike<number>, o: number, p: ArrayLike<number>, i: number): THREE.Matrix4 {
  return new THREE.Matrix4().set(
    r[o], r[o + 1], r[o + 2], p[3 * i],
    r[o + 3], r[o + 4], r[o + 5], p[3 * i + 1],
    r[o + 6], r[o + 7], r[o + 8], p[3 * i + 2],
    0, 0, 0, 1);
}

/**
 * Colliders for the scene's mesh geoms, from MuJoCo's own copy of each mesh,
 * posed by the geom: the worker's graph has no mesh data.
 */
function mujocoMeshColliders(mujoco: Mj, model: Model, nodes: SceneNode[]): Collider[] {
  const out: Collider[] = [];
  const vert = model.mesh_vert, face = model.mesh_face;
  for (const { name, friction } of sceneMeshGeoms(nodes)) {
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, name);
    if (id < 0) continue;
    const mesh = model.geom_dataid[id];
    if (mesh < 0) continue;
    const va = model.mesh_vertadr[mesh], vn = model.mesh_vertnum[mesh], fa = model.mesh_faceadr[mesh], fn = model.mesh_facenum[mesh];
    out.push({ body: null, geom: id, local: new THREE.Matrix4(), friction, ...meshShape(vert.slice(3 * va, 3 * (va + vn)), face.slice(3 * fa, 3 * (fa + fn)), false) });
  }
  return out;
}

/**
 * The scene's cloth, or null if it has none. `previous` is carried over (its
 * particles kept where they are) when `carry` and it is the same cloth.
 */
export function buildClothWorld(mujoco: Mj, model: Model, data: Data, scene: SceneGraph, previous: ClothWorld | null, carry: boolean): ClothWorld | null {
  const graphWorlds = new Map<string, THREE.Matrix4>();
  const cloths: { node: SceneNode; world: THREE.Matrix4 }[] = [];
  walkBodiesWorld(scene.nodes, (n, world) => {
    graphWorlds.set(n.name || n.id, world);
    if (n.cloth) cloths.push({ node: n, world });
  });
  if (!cloths.length) return null;
  const formOf = (n: SceneNode) => {
    const fit = n.cloth?.garment?.fitTo;
    let found: SceneNode | undefined;
    walkBodiesWorld(scene.nodes, (m) => { if ((m.name || m.id) === fit) found = m; });
    return found?.bodyForm ?? null;
  };
  const keys: string[] = [];
  const models = cloths.map(({ node, world }) => {
    const key = JSON.stringify([node.name || node.id, node.cloth, Array.from(world.elements), formOf(node)]);
    keys.push(key);
    let m = modelCache.get(key);
    if (!m) {
      m = clothModel(node, world, scene.nodes);
      if (modelCache.size > 8) modelCache.clear();
      modelCache.set(key, m);
    }
    return m;
  });
  const bodyPose = (name: string): THREE.Matrix4 | null => {
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
    if (id >= 0) return fromMujoco(data.xmat, 9 * id, data.xpos, id);
    return graphWorlds.get(name) ?? null;
  };
  const geomPose = (id: number): THREE.Matrix4 | null => fromMujoco(data.geom_xmat, 9 * id, data.geom_xpos, id);
  const sim = new ClothSim(models, [...sceneColliders(scene.nodes), ...mujocoMeshColliders(mujoco, model, scene.nodes)]);
  sim.setPoses(bodyPose, geomPose);
  if (carry && previous && previous.keys.length === keys.length && previous.keys.every((k, i) => k === keys[i])) sim.restore(previous.sim.state());
  const pose = () => sim.setPoses(bodyPose, geomPose);
  return { sim, keys, pose, advance: (dt, env) => { pose(); sim.advance(dt, env); } };
}
