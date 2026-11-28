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
import type { ClothSpec } from '../../types/cloth';
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

const tinted = (c: number[], k: number) => [c[0] * k, c[1] * k, c[2] * k, c[3] ?? 1];

/** The cloths the last build left out, and why: reported even when none was built. */
let lastFailures: string[] = [];
export const clothBuildFailures = (): string[] => lastFailures;

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
  /** What each cloth's spec names that is not in it, as `<cloth>: <warning>`. */
  warnings: string[];
  /** Pose the colliders from where MuJoCo has every body now. */
  pose: () => void;
  /**
   * The cloth on by `dt`, posed first if a substep is due. With a deadline
   * (performance.now() ms) it may stop between substeps and return false;
   * `finish` then runs the rest, exactly as it would have run.
   */
  advance: (dt: number, env: ClothEnv, deadline?: number) => boolean;
  finish: (deadline?: number) => boolean;
}

/** Write row-major 3x3 and a position into `out` without allocating. */
function writeFromMujoco(out: THREE.Matrix4, r: ArrayLike<number>, o: number, p: ArrayLike<number>, i: number): THREE.Matrix4 {
  return out.set(
    r[o], r[o + 1], r[o + 2], p[3 * i],
    r[o + 3], r[o + 4], r[o + 5], p[3 * i + 1],
    r[o + 6], r[o + 7], r[o + 8], p[3 * i + 2],
    0, 0, 0, 1);
}

/** Strip visual-only colour/print fields from a ClothSpec so purely visual edits preserve `ClothSim` state and skip SDF/ARAP rebuilds. */
function stripVisualClothSpec(spec: ClothSpec | undefined): ClothSpec | undefined {
  if (!spec) return spec;
  const raw = spec as ClothSpec & { rgba?: unknown };
  const { pattern: _p, rgba: _r, ...rest } = raw;
  void _p; void _r;
  return {
    ...rest,
    ...(spec.pieces ? {
      pieces: spec.pieces.map((pc) => {
        const { rgba: _pr, pattern: _pp, trims, ...pcRest } = pc;
        void _pr; void _pp;
        return {
          ...pcRest,
          ...(trims ? { trims: trims.map(({ rgba: _tr, ...trRest }) => { void _tr; return trRest; }) } : {}),
        };
      }),
    } : {}),
    ...(spec.fasten ? {
      fasten: spec.fasten.map((fa) => (fa.trim ? { ...fa, trim: { ...fa.trim, rgba: undefined } } : fa)),
    } : {}),
    ...(spec.garment ? {
      garment: {
        ...spec.garment,
        rgba: undefined,
        pattern: undefined,
        ...(spec.garment.trims ? { trims: spec.garment.trims.map(({ rgba: _gr, ...trRest }) => { void _gr; return trRest; }) } : {}),
        ...(spec.garment.pockets ? { pockets: spec.garment.pockets.map(({ rgba: _pkr, ...pkRest }) => { void _pkr; return pkRest; }) } : {}),
        ...(typeof spec.garment.belt === 'object' && spec.garment.belt ? { belt: { ...spec.garment.belt, rgba: undefined } } : {}),
        ...(spec.garment.collar ? { collar: { ...spec.garment.collar, rgba: undefined } } : {}),
        ...(spec.garment.attached ? { attached: spec.garment.attached.map(({ rgba: _ar, pattern: _ap, ...atRest }) => { void _ar; void _ap; return atRest; }) } : {}),
      },
    } : {}),
  };
}

/**
 * Colliders for the scene's mesh geoms, from MuJoCo's own copy of each mesh,
 * posed by the geom: the worker's graph has no mesh data.
 */
function mujocoMeshColliders(mujoco: Mj, model: Model, nodes: SceneNode[]): Collider[] {
  const out: Collider[] = [];
  const vert = model.mesh_vert, face = model.mesh_face;
  for (const { name, friction } of sceneMeshGeoms(nodes)) {
    let id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, name);
    // Dynamic dense imported STLs drop their high-poly visual geom in MJCF and emit `${name}_collider`.
    if (id < 0) id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, `${name}_collider`);
    if (id < 0) continue;
    const mesh = model.geom_dataid[id];
    if (mesh < 0) continue;
    const va = model.mesh_vertadr[mesh], vn = model.mesh_vertnum[mesh], fa = model.mesh_faceadr[mesh], fn = model.mesh_facenum[mesh];
    out.push({ body: null, geom: id, local: new THREE.Matrix4(), friction, ...meshShape(vert.subarray(3 * va, 3 * (va + vn)), face.subarray(3 * fa, 3 * (fa + fn)), false) });
  }
  return out;
}

/**
 * The scene's cloth, or null if it has none. `previous` is carried over (its
 * particles kept where they are) when `carry` and it is the same cloth.
 */
export function buildClothWorld(
  mujoco: Mj,
  model: Model,
  data: Data,
  scene: SceneGraph,
  previous: ClothWorld | null,
  carry: boolean,
  seedClothState?: Parameters<ClothSim['restore']>[0],
): ClothWorld | null {
  const graphWorlds = new Map<string, THREE.Matrix4>();
  const cloths: { node: SceneNode; world: THREE.Matrix4 }[] = [];
  walkBodiesWorld(scene.nodes, (n, world) => {
    graphWorlds.set(n.name || n.id, world);
    if (n.cloth) cloths.push({ node: n, world });
  });
  for (const c of cloths) c.world = clothFrame(scene.nodes, c.node, c.world);
  lastFailures = [];
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
  const failed: string[] = [];
  const built = cloths.map(({ node, world }, i): ClothModel | null => {
    const draft = node.cloth?.garment, form = formNode(node);
    const cut = draft ? (form?.bodyForm ?? draft.form ?? null) : null;
    const trims = draft ? garmentSettings(draft).trims : undefined;
    trims?.forEach((t, k) => { if (t.kind === 'zipper') zipsAsked.set(`${node.name || node.id}#${k}`, doneUp(t)); });
    const stripped = stripVisualClothSpec(node.cloth);
    const spec = draft && stripped?.garment ? { ...stripped, garment: { ...stripped.garment, fitTo: undefined, form: undefined } } : stripped;
    const cleanTrims = trims?.map(({ rgba: _tr, ...trRest }) => { void _tr; return trRest; });
    const loose = draft && spec?.garment ? { ...spec, garment: { ...spec.garment, trims: cleanTrims?.map((t) => (t.kind === 'zipper' ? { ...t, fastened: undefined } : t)) } } : spec;
    const exact = JSON.stringify([node.name || node.id, node.cloth, Array.from(world.elements), cut]);
    const key = JSON.stringify([node.name || node.id, loose, Array.from(world.elements), cut]);
    keys.push(key);
    formBuilds.push(form ? JSON.stringify([form.bodyFormBuilt ?? null, form.geoms?.filter((g) => g.csgDerived !== 'collider' && !g.colliderOf).length ?? 0]) : null);
    // Exact cache includes visual colours/prints so group FlexInfo stays accurate;
    // `key` strips visual fields and zipper state so carrying across a rebuild preserves ClothSim state!
    let m = modelCache.get(exact);
    if (!m && carry && previous?.keys[i] === key && previous.models?.[i]) {
      const prevExact = JSON.stringify([node.name || node.id, previous.models[i].groups.map((g) => [g.rgba, g.pattern, g.trims?.map((t) => t.rgba)])]);
      const wantVisualChanged = !node.cloth?.garment && !node.cloth?.pieces
        ? false
        : prevExact !== JSON.stringify([
          node.name || node.id,
          previous.models[i].groups.map((g) => {
            const pName = g.name.slice((node.name || node.id).length + 2);
            const pc = node.cloth?.pieces?.find((q) => q.name === pName);
            const rgba = pc ? (pc.rgba ?? [0.25, 0.5, 0.85, 1]) : (node.cloth?.garment && g.tint !== undefined ? tinted(garmentSettings(node.cloth.garment).rgba, g.tint) : g.rgba);
            const pat = pc ? pc.pattern : g.pattern;
            return [rgba, pat, g.trims?.map((t) => t.rgba)];
          }),
        ]);
      if (!wantVisualChanged && !node.cloth?.garment?.trims?.some((t) => t.rgba) && !node.cloth?.garment?.pockets?.some((p) => p.rgba) && !(typeof node.cloth?.garment?.belt === 'object' && node.cloth.garment.belt?.rgba) && !node.cloth?.garment?.collar?.rgba && !node.cloth?.garment?.attached?.some((a) => a.rgba || a.pattern) && !node.cloth?.pieces?.some((p) => p.trims?.some((t) => t.rgba)) && !node.cloth?.fasten?.some((f) => f.trim?.rgba)) {
        m = previous.models[i];
      } else if (!node.cloth?.garment && node.cloth?.pieces) {
        // Fast clone of plain-piece groups with updated piece rgba/pattern when no trim colours changed:
        const hasTrimRgba = node.cloth.pieces.some((p) => p.trims?.some((t) => t.rgba)) || node.cloth.fasten?.some((f) => f.trim?.rgba);
        if (!hasTrimRgba) {
          const prefix = `${node.name || node.id}__`;
          m = {
            ...previous.models[i],
            groups: previous.models[i].groups.map((g) => {
              const pc = node.cloth!.pieces!.find((q) => `${prefix}${q.name}` === g.name);
              return pc ? { ...g, rgba: pc.rgba ?? [0.25, 0.5, 0.85, 1], pattern: pc.pattern } : g;
            }),
          };
        }
      } else if (node.cloth?.garment && !node.cloth.garment.trims?.some((t) => t.rgba) && !node.cloth.garment.pockets?.some((p) => p.rgba) && !(typeof node.cloth.garment.belt === 'object' && node.cloth.garment.belt?.rgba) && !node.cloth.garment.collar?.rgba && !node.cloth.garment.attached?.some((a) => a.rgba || a.pattern)) {
        const gRgba = garmentSettings(node.cloth.garment).rgba ?? [0.28, 0.36, 0.52, 1];
        m = {
          ...previous.models[i],
          // The pieces that take the garment's colour take the new one, shaded as they were; the rest keep their own.
          groups: previous.models[i].groups.map((g) => (g.tint !== undefined ? { ...g, rgba: tinted(gRgba, g.tint) } : g)),
        };
      }
    }
    if (!m) {
      // A cloth that cannot be built (a kind or fabric that is not one, a form
      // that is gone) is left out with a warning, and the rest of the scene's
      // cloth still runs: thrown from here, it took the whole load down.
      try {
        m = clothModel(node, world, scene.nodes);
      } catch (err) {
        failed.push(`${node.name || node.id}: not built: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (modelCache.size > 8) modelCache.clear();
      modelCache.set(exact, m);
    }
    return m;
  });
  const kept = built.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
  if (kept.length < built.length) {
    const k = kept.map((i) => keys[i]), f = kept.map((i) => formBuilds[i]);
    keys.length = 0; keys.push(...k);
    formBuilds.length = 0; formBuilds.push(...f);
  }
  const models = kept.map((i) => built[i]!);
  lastFailures = failed;
  if (!models.length) return null;
  const bodyIdMap = new Map<string, number>();
  const lookupBodyId = (name: string): number => {
    let id = bodyIdMap.get(name);
    if (id === undefined) {
      id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
      bodyIdMap.set(name, id!);
    }
    return id!;
  };
  const bodyScratch = new THREE.Matrix4();
  const geomScratch = new THREE.Matrix4();
  const bodyPose = (name: string): THREE.Matrix4 | null => {
    const id = lookupBodyId(name);
    if (id >= 0) return writeFromMujoco(bodyScratch, data.xmat, 9 * id, data.xpos, id);
    return graphWorlds.get(name) ?? null;
  };
  const geomPose = (id: number): THREE.Matrix4 | null =>
    id >= 0 && id < model.ngeom ? writeFromMujoco(geomScratch, data.geom_xmat, 9 * id, data.geom_xpos, id) : null;
  const sim = new ClothSim(models, [...sceneColliders(scene.nodes, true, true), ...mujocoMeshColliders(mujoco, model, scene.nodes)]);
  sim.setPoses(bodyPose, geomPose);
  const sameForm = (i: number) => formBuilds[i] === null || previous!.formBuilds?.[i] === formBuilds[i];
  const carried = seedClothState
    ? sim.restore(seedClothState)
    : (carry && previous && previous.keys.length === keys.length && previous.keys.every((k, i) => k === keys[i] && sameForm(i)) && sim.restore(previous.sim.state()));
  // A zip the graph now asks to be done up further or less, done so as it
  // runs; otherwise each as it was carried (moved by its slider since).
  for (const [k, f] of zipsAsked) {
    const cut = k.lastIndexOf('#');
    if (!carried || (!seedClothState && previous && previous.zipsAsked?.get(k) !== f)) sim.setZip(k.slice(0, cut), Number(k.slice(cut + 1)), f);
  }
  // Settled before it is first drawn: a paused scene shows the cloth at rest, not as modelled.
  sim.settleNow();
  const pose = () => sim.setPoses(bodyPose, geomPose);
  const warnings = [...failed, ...models.flatMap((m) => (m.warnings ?? []).map((w) => `${m.name}: ${w}`))];
  if (sim.settleCut) warnings.push(sim.settleCut);
  return {
    sim, keys, models, zipsAsked, formBuilds, warnings, pose,
    advance: (dt, env, deadline) => {
      // One owed still runs on its own poses, before these are taken.
      if (sim.busy) sim.finish();
      if (sim.willSubstep(dt)) pose();
      return sim.advance(dt, env, deadline);
    },
    finish: (deadline) => sim.finish(deadline),
  };
}
