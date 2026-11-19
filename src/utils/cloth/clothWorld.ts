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
import { garmentSettings } from './garments';
import { clothFrame } from './clothFrame';
import { doneUp } from './fastening';
import { meshShape, sceneColliders, sceneMeshGeoms, type Collider } from './clothColliders';
import { ClothSim, type ClothEnv } from './xpbd';

/* eslint-disable @typescript-eslint/no-explicit-any -- the MuJoCo wasm bindings are untyped here */
type Mj = any;
type Model = any;
type Data = any;

const modelCache = new Map<string, ClothModel>();

export interface ClothWorld {
  sim: ClothSim;
  /** What each cloth was built from, to tell whether a rebuild is the same cloth (how far its zips are done up aside: that is done to it as it runs). */
  keys: string[];
  /** Each cloth's model, to carry over to a rebuild that only did a zip up or down. */
  models: ClothModel[];
  /** How far the graph had each zip done up (`<cloth>#<trim>`), to tell whether a rebuild asks for it to move. */
  zipsAsked: Map<string, number>;
  /** Per cloth, which build of its form's geoms it was carried against (null: on no form). */
  formBuilds: (string | null)[];
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
  for (const c of cloths) c.world = clothFrame(scene.nodes, c.node, c.world);
  if (!cloths.length) return null;
  // What each cloth is built from (its spec, where it stands, and the
  // measurements it is cut to), and the build of its form's geoms. A garment
  // let go of its deleted form is the same cloth, cut the same, and is carried
  // over as it is to fall; one whose form's geoms come or change is not: a
  // form added without geoms (built in a worker) gets them a moment later with
  // the same measurements, and cloth carried over from the world without them
  // had fallen through where the form now is.
  // Its own geoms only: the convex pieces it is broken into for contact come
  // a moment after it loads, and counted, every garment on it was modelled and
  // settled over again, a minute before the scene would run.
  const formNode = (n: SceneNode) => {
    const fit = n.cloth?.garment?.fitTo;
    let found: SceneNode | undefined;
    if (fit) walkBodiesWorld(scene.nodes, (m) => { if ((m.name || m.id) === fit && m.bodyForm) found = m; });
    return found;
  };
  const keys: string[] = [], formBuilds: (string | null)[] = [];
  // How far each zip is done up, as the graph asks: done to the cloth as it
  // runs (its slider moved), not built into it.
  const zipsAsked = new Map<string, number>();
  const models = cloths.map(({ node, world }, i) => {
    const draft = node.cloth?.garment, form = formNode(node);
    const cut = draft ? (form?.bodyForm ?? draft.form ?? null) : null;
    const trims = draft ? garmentSettings(draft).trims : undefined;
    trims?.forEach((t, k) => { if (t.kind === 'zipper') zipsAsked.set(`${node.name || node.id}#${k}`, doneUp(t)); });
    const spec = draft ? { ...node.cloth, garment: { ...draft, fitTo: undefined, form: undefined } } : node.cloth;
    const loose = draft ? { ...spec, garment: { ...spec!.garment!, trims: trims?.map((t) => (t.kind === 'zipper' ? { ...t, fastened: undefined } : t)) } } : spec;
    const exact = JSON.stringify([node.name || node.id, spec, Array.from(world.elements), cut]);
    const key = JSON.stringify([node.name || node.id, loose, Array.from(world.elements), cut]);
    keys.push(key);
    formBuilds.push(form ? JSON.stringify([form.bodyFormBuilt ?? null, form.geoms?.filter((g) => g.csgDerived !== 'collider' && !g.colliderOf).length ?? 0]) : null);
    // The same cloth with only a zip moved: the model it runs as now.
    let m = modelCache.get(exact) ?? (carry && previous?.keys[i] === key ? previous.models?.[i] : undefined);
    if (!m) {
      m = clothModel(node, world, scene.nodes);
      if (modelCache.size > 8) modelCache.clear();
      modelCache.set(exact, m);
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
  const sameForm = (i: number) => formBuilds[i] === null || previous!.formBuilds?.[i] === formBuilds[i];
  const carried = carry && previous && previous.keys.length === keys.length && previous.keys.every((k, i) => k === keys[i] && sameForm(i)) && sim.restore(previous.sim.state());
  // A zip the graph now asks to be done up further or less, done so as it
  // runs; otherwise each as it was carried (moved by its slider since).
  for (const [k, f] of zipsAsked) {
    const cut = k.lastIndexOf('#');
    if (!carried || previous!.zipsAsked?.get(k) !== f) sim.setZip(k.slice(0, cut), Number(k.slice(cut + 1)), f);
  }
  // Settled before it is first drawn: a paused scene shows the cloth at rest, not as modelled.
  sim.settleNow();
  const pose = () => sim.setPoses(bodyPose, geomPose);
  return { sim, keys, models, zipsAsked, formBuilds, pose, advance: (dt, env) => { pose(); sim.advance(dt, env); } };
}
