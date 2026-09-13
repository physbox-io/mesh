import { create } from 'zustand';
import * as THREE from 'three';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, GeomType, CsgOp } from '../types/scene';
import { type CombineOp, cageInFrame, geomsForCombine, nodeWorldMatrix } from '../utils/combineBodies';
import { DEFAULT_BRUSH, toSceneGeom, type BrushSettings } from '../utils/sculptMesh';
import { buildSculptBase, DEFAULT_SCULPT_BASE, type SculptBaseId } from '../utils/sculptBases';
import {
  boxLattice, deserializeCage, faceCount, serializeCage,
  separablePieces, DRAWING_TOOLS, toSceneGeom as latticeToSceneGeom,
  DEFAULT_UNIT as LATTICE_UNIT, type Axis as LatticeAxis, type LatticeCage,
  type SnapMultiple, type LatticeTool,
} from '../utils/latticeMesh';
import { latticeBoolean } from '../utils/latticeBoolean';
import {
  type CsgResult, type CutSpot, CSG_DEFAULT_SECTORS, scadForDisplay,
  cutGeometry, sourcePositiveBounds, reconcileCuts, pickCutSpot,
} from '../utils/csg';
import { insetNegatives } from '../utils/scaleNode';
import type { PaintLayer } from '../utils/vertexPaint';
import { compileToMJCF } from '../utils/mjcf';
import { PRESETS, pendulumPreset, generateGearGeoms } from '../presets/presetScenes';
import { PhysicsWorkerClient, type BuiltResult, type FrameSnapshot } from './physicsWorkerClient';
import { generatePyramidMeshData, generateConeMeshData, generateTorusMeshData, generateTubeMeshData, generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS, getStickyRotation } from '../utils/geom';
import { readUserPreset } from '../utils/userPresets';
import { DEFAULT_MATERIAL, type MaterialId } from '../utils/feedsAndSpeeds';
import { DEFAULT_FILAMENT, type FilamentId } from '../utils/filaments';

/**
 * What is on the bench.
 *
 * `fdm` is the default because it is what most people who open this app own,
 * and saying so is more honest than presenting a router as the assumption. It
 * is not a machine this app drives — see `FdmNotice` — and everything that
 * writes G-code treats it as it treats a router, because the one thing an FDM
 * user does here is export a mesh.
 */
export type MachineTarget = 'fdm' | 'laser' | 'cnc';

/**
 * The scratch fields the rotate helpers keep on a geom and a body between
 * absolute rotations: the unrotated vertices, so repeated rotations compound
 * from the same base rather than accumulating drift. Not part of the saved
 * document, but cloneGeom carries them across an edit.
 */
type WorkingGeom = SceneGeom & { baseVertices?: number[]; baseRenderVertices?: number[] };
type WorkingNode = SceneNode & { basePos?: number[] };

/** Name<->id lookup tables the worker builds; `${type}Rev` maps ids back to names. */
type IdMaps = Record<string, Record<string, number> | Record<number, string> | undefined>;

/** A preset as listed in PRESETS: a scene, and optionally a camera framing and an environment. */
interface Preset {
  name: string;
  emoji?: string;
  scene?: SceneGraph;
  camera?: { position: [number, number, number]; target: [number, number, number] };
  environment?: Partial<{ gravityZ: number; windX: number; windY: number; density: number; floorFriction: number; floorBounce: number }>;
}

/** The globals the viewport and the recompile debounce hang off `window`. */
type PhysicsWindow = Window & {
  _physics_camera?: THREE.Camera;
  _recompileTimeoutId?: ReturnType<typeof setTimeout>;
  _recompileWake?: (() => void) | null;
  DISABLE_USEFRAME?: boolean;
  NO_SELECT?: boolean;
  compiledXML?: string;
};

const initialScene: SceneGraph = pendulumPreset;

// The live MuJoCo module/model/data now live inside a dedicated Worker (see
// src/workers/physicsWorker.ts) so that on unrecoverable WASM memory
// exhaustion the worker can be terminated and a fresh one spawned — a real
// memory reclaim, since a Worker is a separate JS realm, unlike reinstantiating
// a WASM module in place on the main thread (which doesn't reliably return
// abandoned linear memory to the OS). `mujoco`/`model`/`data` in the store are
// now plain-JS mirrors kept in sync via postMessage, not live WASM objects —
// this shim preserves the exact field names/shapes the rest of the app
// (DynamicGeom, PulleyRopesRenderer, MouseDragForceRenderer, getSyncedSceneGraph,
// etc.) already reads, so those call sites need no changes.
const MUJOCO_SHIM = {
  mjtObj: {
    mjOBJ_BODY: { value: 'body' },
    mjOBJ_JOINT: { value: 'joint' },
    mjOBJ_GEOM: { value: 'geom' },
    mjOBJ_ACTUATOR: { value: 'actuator' },
  },
  mj_name2id: (model: ModelMirror | null | undefined, typeVal: string, name: string): number =>
    (model?._idMaps as IdMaps | undefined)?.[typeVal]?.[name] ?? -1,
  mj_id2name: (model: ModelMirror | null | undefined, typeVal: string, id: number): string | null =>
    (model?._idMaps as IdMaps | undefined)?.[`${typeVal}Rev`]?.[id] ?? null,
  // Nothing on the main thread should call these directly anymore — the worker
  // owns stepping/forward-kinematics. Kept as safe no-ops in case of a stray call.
  mj_step: () => {},
  mj_forward: () => {},
};

const buildModelMirror = (built: BuiltResult) => ({
  nq: built.nq, nv: built.nv, nu: built.nu, ngeom: built.ngeom, nbody: built.nbody,
  opt: { timestep: built.timestep },
  geom_size: built.geom_size,
  geom_type: built.geom_type,
  geom_rgba: built.geom_rgba,
  body_mass: built.body_mass,
  body_inertia: built.body_inertia,
  body_dofnum: built.body_dofnum,
  body_parentid: built.body_parentid,
  jnt_qposadr: built.jnt_qposadr,
  jnt_dofadr: built.jnt_dofadr,
  _idMaps: built.idMaps,
});

// A stable object whose typed-array contents get mutated in place on every
// FRAME message (see getPhysicsWorkerClient below) rather than replaced —
// existing per-frame readers (DynamicGeom etc.) already fetch `data` via
// `useStore.getState().data` inside useFrame (not a reactive selector), so
// mutating in place keeps the exact same performance characteristics as the
// original live-WASM-view approach: no React re-render on every physics tick.
const buildDataMirror = (built: BuiltResult | FrameSnapshot) => ({
  time: built.time,
  qpos: built.qpos!, qvel: built.qvel!, ctrl: built.ctrl!,
  xfrc_applied: built.xfrc_applied!, qfrc_applied: built.qfrc_applied!,
  xpos: built.xpos!, xmat: built.xmat!, cvel: built.cvel!,
  geom_xpos: built.geom_xpos!, geom_xmat: built.geom_xmat!,
});
type ModelMirror = ReturnType<typeof buildModelMirror>;
type DataMirror = ReturnType<typeof buildDataMirror>;

// Proactive recycling: WASM linear memory only ever grows within a worker's
// lifetime, and heavy scenes (many dynamic SCAD/mesh bodies) can eat through
// the 2^31-byte ceiling in surprisingly few rebuilds. Rather than wait for a
// hard "enlarge memory" failure, swap in a fresh worker on a schedule so
// exhaustion is never actually reached during normal use — the same
// terminate+respawn mechanism as the reactive recovery path, just run
// preemptively. Any respawn (proactive or reactive) resets this counter.
const RECYCLE_EVERY_N_BUILDS = 4;
/** Orders recompiles so a superseded one can bow out instead of building stale state. */
let recompileToken = 0;
/**
 * How many recompiles have been asked for and not yet landed.
 *
 * The undo history needs this. A snapshot is taken before a change and pushed a
 * tick later, ONLY if the scene actually moved — which is right for the MCP
 * bridge, where most commands change nothing. But `addComponent` and everything
 * like it never write the scene themselves: they hand it to `recompile`, which
 * lands it fifty milliseconds and a build later, long after that tick. The
 * snapshot found the scene unchanged, threw itself away, and adding a body was
 * not undoable at all.
 *
 * So while a recompile is in flight the snapshot is held rather than discarded,
 * and the landing itself pushes it.
 */
let recompilesInFlight = 0;

let buildsSinceRecycle = 0;

let physicsWorkerClientSingleton: PhysicsWorkerClient | null = null;
const recycleWorker = () => {
  physicsWorkerClientSingleton?.terminate();
  physicsWorkerClientSingleton = null;
  buildsSinceRecycle = 0;
};
export const getPhysicsWorkerClient = (): PhysicsWorkerClient => {
  if (!physicsWorkerClientSingleton) {
    const client = new PhysicsWorkerClient();
    client.onFrame = (snap) => {
      const data = useStore.getState().data;
      if (data) {
        data.time = snap.time;
        if (!snap.isShared && snap.qpos && snap.qvel && snap.ctrl && snap.xfrc_applied && snap.qfrc_applied && snap.xpos && snap.xmat && snap.cvel && snap.geom_xpos && snap.geom_xmat) {
          data.qpos.set(snap.qpos); data.qvel.set(snap.qvel); data.ctrl.set(snap.ctrl);
          data.xfrc_applied.set(snap.xfrc_applied); data.qfrc_applied.set(snap.qfrc_applied);
          data.xpos.set(snap.xpos); data.xmat.set(snap.xmat); data.cvel.set(snap.cvel);
          data.geom_xpos.set(snap.geom_xpos); data.geom_xmat.set(snap.geom_xmat);
        }
      }
    };
    client.onError = (message, fatal, lastState) => {
      console.error('[PhysicsWorker]', message);
      if (fatal) {
        useStore.getState().recoverFromFatalWorkerError(message, lastState);
      } else {
        useStore.setState({ isPlaying: false, lastCompileError: message });
      }
    };
    physicsWorkerClientSingleton = client;
  }
  return physicsWorkerClientSingleton;
};

// Returns true if every geom on a node is a mesh (so pos/euler are meaningless for rendering)
const isAllMeshNode = (node: SceneNode) =>
  node.geoms?.length > 0 && node.geoms.every((g: SceneGeom) => g.type === 'mesh');

const isDynamicMesh = (g: SceneGeom) => g.type === 'mesh' && g.dynamic && g.renderVertices;
const isStaticMesh  = (g: SceneGeom) => g.type === 'mesh' && !g.dynamic && g.vertices;

// A mesh geom authored (by hand, by a preset file, or over MCP) without an
// explicit dynamic:true sits in the static render path forever, even once a
// joint makes the body actually move: static meshes render from vertices
// baked once into world space and never re-read data.xpos/data.xmat, so the
// body can drag and simulate correctly while looking frozen in place. Any
// path that gives a node its first joint should flip its mesh geoms over to
// the dynamic path here, deriving renderVertices from vertices (a plain
// Y-up-to-MuJoCo-Z-up swap, (x,y,z)->(x,-z,y)) rather than requiring the
// caller to have supplied it — see californiaRelief.ts / megaBustStudio.ts,
// both of which hit exactly this before this function existed.
const toRenderVertices = (vertices: number[]): number[] => {
  const out = new Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = vertices[i];
    out[i + 1] = -vertices[i + 2];
    out[i + 2] = vertices[i + 1];
  }
  return out;
};

const promoteMeshGeomsToDynamic = (node: SceneNode) => {
  for (const g of node.geoms || []) {
    if (g.type !== 'mesh' || g.dynamic) continue;
    g.dynamic = true;
    if (!g.renderVertices && Array.isArray(g.vertices)) {
      g.renderVertices = toRenderVertices(g.vertices);
    }
  }
};

// The three call sites above (properties panel, MCP UPDATE_OBJECT, MCP
// build/update-scene) all catch the trap at the moment a joint is *added* to
// a node — but a hand-authored preset file can also just ship a body that is
// ALREADY jointed with a mesh geom missing dynamic:true, with no "joint was
// added" event for any of those to hook. Loading a scene graph sweeps for
// that case once, up front, covering every entry point at once instead of
// requiring yet another call site to remember this.
const promoteJointedMeshGeomsDeep = (nodes: SceneNode[], ancestorJointed = false) => {
  if (!nodes) return;
  for (const node of nodes) {
    const jointed = ancestorJointed || (node.joints && node.joints.length > 0);
    if (jointed) promoteMeshGeomsToDynamic(node);
    promoteJointedMeshGeomsDeep(node.children, jointed);
  }
};

// Apply a function to flat vertex array in-place
const mapVerts = (v: number[], fn: (x: number, y: number, z: number) => [number,number,number]) => {
  for (let i = 0; i < v.length; i += 3) {
    const [nx, ny, nz] = fn(v[i], v[i+1], v[i+2]);
    v[i] = nx; v[i+1] = ny; v[i+2] = nz;
  }
  return v;
};

// Translate static mesh geom vertices (Y-up world space)
const translateMeshGeoms = (node: SceneNode, dx: number, dy: number, dz: number) => {
  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      g.vertices = mapVerts([...g.vertices], (x,y,z) => [x+dx, y+dy, z+dz]);
    }
    // Dynamic meshes are positioned via body pos — no vertex transform needed
  }
};

// Rotate static mesh geom vertices around axis (degrees) about their centroid (or origin)
// Dynamic mesh renderVertices are centroid-local
const rotateMeshGeomsAbsolute = (node: WorkingNode, euler: [number, number, number], rotateAroundCOM = true) => {
  const [rx, ry, rz] = euler;
  const radX = (rx * Math.PI) / 180;
  const radY = (ry * Math.PI) / 180;
  const radZ = (rz * Math.PI) / 180;

  // Build 3D rotation matrix for Y-up world space (Euler order: Z * Y * X)
  const matX = new THREE.Matrix4().makeRotationX(radX);
  const matY = new THREE.Matrix4().makeRotationY(radY);
  const matZ = new THREE.Matrix4().makeRotationZ(radZ);
  const rotMat = new THREE.Matrix4().multiplyMatrices(matZ, new THREE.Matrix4().multiplyMatrices(matY, matX));

  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      if (!g.baseVertices) {
        g.baseVertices = [...g.vertices];
      }
      const baseVerts = g.baseVertices as number[];
      const n = baseVerts.length / 3;

      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < baseVerts.length; i += 3) {
        cx += baseVerts[i];
        cy += baseVerts[i + 1];
        cz += baseVerts[i + 2];
      }
      cx /= n; cy /= n; cz /= n;

      const newVerts = new Array(baseVerts.length);
      const v = new THREE.Vector3();

      for (let i = 0; i < baseVerts.length; i += 3) {
        if (rotateAroundCOM) {
          v.set(baseVerts[i] - cx, baseVerts[i + 1] - cy, baseVerts[i + 2] - cz);
          v.applyMatrix4(rotMat);
          newVerts[i] = v.x + cx;
          newVerts[i + 1] = v.y + cy;
          newVerts[i + 2] = v.z + cz;
        } else {
          v.set(baseVerts[i], baseVerts[i + 1], baseVerts[i + 2]);
          v.applyMatrix4(rotMat);
          newVerts[i] = v.x;
          newVerts[i + 1] = v.y;
          newVerts[i + 2] = v.z;
        }
      }
      g.vertices = newVerts;
    }

    if (isDynamicMesh(g)) {
      if (!g.baseRenderVertices) {
        g.baseRenderVertices = [...g.renderVertices];
      }
      const baseRender = g.baseRenderVertices as number[];
      // renderVertices are Z-up space in MuJoCo
      const matXz = new THREE.Matrix4().makeRotationX(radX);
      const matYz = new THREE.Matrix4().makeRotationZ(radY);
      const matZz = new THREE.Matrix4().makeRotationY(-radZ);
      const rotMatZup = new THREE.Matrix4().multiplyMatrices(matZz, new THREE.Matrix4().multiplyMatrices(matYz, matXz));

      const newRender = new Array(baseRender.length);
      const v = new THREE.Vector3();
      for (let i = 0; i < baseRender.length; i += 3) {
        v.set(baseRender[i], baseRender[i + 1], baseRender[i + 2]);
        v.applyMatrix4(rotMatZup);
        newRender[i] = v.x;
        newRender[i + 1] = v.y;
        newRender[i + 2] = v.z;
      }
      g.renderVertices = newRender;

      if (!rotateAroundCOM && node.pos) {
        if (!node.basePos) node.basePos = [...node.pos];
        const bp = node.basePos;
        v.set(bp[0], bp[1], bp[2]).applyMatrix4(rotMat);
        node.pos = [v.x, v.y, v.z];
      }
    }
  }
};

// Scale mesh geoms about their centroid (uniformly or per-axis).
//
// The factors are world (Z-up) axes, the ones the inspector's position and
// rotation rows use. renderVertices are already in that space; the collision
// vertices are Y-up, where (x, y, z) maps to Z-up (x, -z, y), so their factors
// have to be permuted to match. Uniform scaling never noticed the difference,
// and per-axis scaling would silently stretch collision and render geometry
// along different axes without it.
export const scaleMeshGeoms = (node: SceneNode, sx: number, sy: number = sx, sz: number = sx) => {
  const scaleAboutCentroid = (vertices: number[], fx: number, fy: number, fz: number) => {
    const v = [...vertices];
    let cx = 0, cy = 0, cz = 0;
    const n = v.length / 3;
    for (let i = 0; i < v.length; i += 3) { cx += v[i]; cy += v[i+1]; cz += v[i+2]; }
    cx /= n; cy /= n; cz /= n;
    return mapVerts(v, (x,y,z) => [cx+(x-cx)*fx, cy+(y-cy)*fy, cz+(z-cz)*fz]);
  };
  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      g.vertices = scaleAboutCentroid(g.vertices as number[], sx, sz, sy);
    }
    if (isDynamicMesh(g)) {
      // renderVertices are raw Z-up — scale about origin
      g.renderVertices = mapVerts([...g.renderVertices], (x,y,z) => [x*sx, y*sy, z*sz]);
      // Also scale the MuJoCo collision vertices (Y-up world space) about their centroid
      if (g.vertices) g.vertices = scaleAboutCentroid(g.vertices as number[], sx, sz, sy);
    }
  }
};

/**
 * Deep equality for scene-graph data, by reference wherever it can be.
 *
 * The comparison this replaces was `JSON.stringify(a) !== JSON.stringify(b)`,
 * which allocates two copies of every mesh in the scene — megabytes of vertex
 * data — to answer a question that is usually settled by the first `===`:
 * cloneSceneGraph shares those arrays by reference, so an untouched mesh is
 * literally the same array. Only data that genuinely arrived from somewhere
 * else (an MCP payload, a loaded file) is walked element by element.
 */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
};

// Structural clone of a scene graph that SHARES the large mesh arrays
// (vertices/faces/renderVertices) by reference instead of copying them.
// Every code path that changes mesh data replaces these arrays wholesale
// (scaleMeshGeoms, update*Params, scad compile) rather than mutating them in
// place, so sharing is safe — and it turns per-edit cloning from O(mesh bytes)
// into O(node count). This matters: the old JSON.parse(JSON.stringify(...))
// ran on every slider tick / handle drag and every undo snapshot, copying
// potentially megabytes of SCAD mesh data each time.
const cloneGeom = (g: SceneGeom): SceneGeom => {
  // `paint` joins the mesh arrays in being shared rather than copied, for the
  // same reason: it is thousands of numbers, it is replaced wholesale rather
  // than mutated in place, and this clone runs on every slider tick and every
  // undo snapshot.
  const { vertices, faces, renderVertices, baseVertices, baseRenderVertices, paint, ...rest } = g;
  const out: WorkingGeom = JSON.parse(JSON.stringify(rest));
  if (paint !== undefined) out.paint = paint;
  if (vertices !== undefined) out.vertices = vertices;
  if (faces !== undefined) out.faces = faces;
  if (renderVertices !== undefined) out.renderVertices = renderVertices;
  if (baseVertices !== undefined) out.baseVertices = baseVertices;
  if (baseRenderVertices !== undefined) out.baseRenderVertices = baseRenderVertices;
  return out;
};

const cloneNode = (n: SceneNode): SceneNode => {
  const { geoms, children, ...rest } = n;
  const out: SceneNode = JSON.parse(JSON.stringify(rest));
  out.geoms = (geoms || []).map(cloneGeom);
  out.children = (children || []).map(cloneNode);
  return out;
};

export const cloneSceneGraph = (sg: SceneGraph): SceneGraph => ({
  ...sg,
  nodes: (sg.nodes || []).map(cloneNode),
});

const getNodeWorldPos = (nodes: SceneNode[], targetId: string, currentOffset: [number, number, number] = [0, 0, 0]): [number, number, number] | null => {
  for (const node of nodes) {
    const nodeWorld: [number, number, number] = [
      currentOffset[0] + node.pos[0],
      currentOffset[1] + node.pos[1],
      currentOffset[2] + node.pos[2]
    ];
    if (node.id === targetId) return nodeWorld;
    if (node.children) {
      const childResult = getNodeWorldPos(node.children, targetId, nodeWorld);
      if (childResult) return childResult;
    }
  }
  return null;
};

const findNode = (nodes: SceneNode[] | undefined, id: string): SceneNode | null => {
  for (const node of nodes || []) {
    if (node.id === id || node.name === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

/**
 * The spot on a body the camera is looking at, or null when there is no
 * viewport to ask or the look misses.
 *
 * A new hole belongs where you are looking. This is the fallback when nothing
 * has been picked: a ray from the eye to the middle of the part, landing on
 * whatever surface it meets first, facing whichever way that surface faces.
 *
 * The camera is read off the window global the viewport publishes, the same one
 * the screenshot bridge uses: this runs in the store, which is outside the
 * canvas and has no other way to reach it. The body's own rotation is undone
 * first, so the ray is cast in the frame the geoms are written in.
 */
function cutSpotFromCamera(node: SceneNode): CutSpot | null {
  const camera = typeof window !== 'undefined' ? (window as PhysicsWindow)._physics_camera : null;
  const bounds = sourcePositiveBounds(node);
  if (!camera?.position || !bounds) return null;
  try {
    // The viewport is Y-up and MuJoCo is Z-up; the geoms this is cast against
    // are in MuJoCo's axes, so the camera is brought over rather than the other
    // way round.
    const eye = new THREE.Vector3(camera.position.x, -camera.position.z, camera.position.y);
    eye.sub(new THREE.Vector3(node.pos?.[0] ?? 0, node.pos?.[1] ?? 0, node.pos?.[2] ?? 0));
    if (node.quat) {
      eye.applyQuaternion(
        new THREE.Quaternion(node.quat[1], node.quat[2], node.quat[3], node.quat[0]).invert(),
      );
    } else if (node.euler) {
      const rad = (d: number) => (d * Math.PI) / 180;
      const euler = new THREE.Euler(rad(node.euler[0]), rad(node.euler[1]), rad(node.euler[2]), 'XYZ');
      eye.applyQuaternion(new THREE.Quaternion().setFromEuler(euler).invert());
    }
    const middle = [0, 1, 2].map(a => (bounds.min[a] + bounds.max[a]) / 2);
    const dir = new THREE.Vector3(middle[0], middle[1], middle[2]).sub(eye);
    if (dir.lengthSq() < 1e-18) return null;
    return pickCutSpot(node, eye.toArray(), dir.normalize().toArray());
  } catch {
    return null;
  }
}

/**
 * Edits one cut and re-derives the primitive underneath it.
 *
 * Every cut edit is the same three steps — change the intent, work the geometry
 * out again from the part's own surface, publish — and doing them in one place
 * is what keeps `pos`, `quat` and `size` from ever disagreeing with the spot
 * and depth they are supposed to express.
 */
function reshapeCut(
  get: () => PhysicsState,
  set: (partial: Partial<PhysicsState>) => void,
  nodeId: string,
  geomIndex: number,
  kind: string,
  edit: (geom: SceneGeom) => void,
) {
  // Coalesced by kind rather than snapshotted outright: these fields report
  // every keystroke, and one undo step per digit of "6.35" makes Ctrl+Z useless
  // exactly where a typed number is most likely to be a typo.
  get().recordInteraction(kind);
  const newScene = cloneSceneGraph(get().sceneGraph);
  const node = findNode(newScene.nodes, nodeId);
  const geom = node?.geoms?.[geomIndex];
  if (!node || !geom || geom.csg !== 'difference' || geom.csgDerived) return;
  edit(geom);
  const next = cutGeometry(node, geom);
  if (next) Object.assign(geom, next);
  set({ sceneGraph: newScene });
  get().recompile(newScene, nodeId, false);
}

const addChildNode = (nodes: SceneNode[], parentId: string, newNode: SceneNode): boolean => {
  for (const node of nodes) {
    if (node.id === parentId) {
      if (!node.children) node.children = [];
      node.children.push(newNode);
      return true;
    }
    if (node.children && addChildNode(node.children, parentId, newNode)) {
      return true;
    }
  }
  return false;
};

export interface UndoRedoState {
  sceneGraph: SceneGraph;
  gravityZ: number;
  windX: number;
  windY: number;
  density: number;
  floorFriction: number;
  floorBounce: number;
  selectedNodeId: string | null;
  /**
   * Whether the lattice tools were open, and on what.
   *
   * Part of the state an undo restores, because opening them is a thing a
   * person did and undo is how you take a thing you did back. Without it,
   * stepping back past the point where a body was made left the editor open on
   * a body that no longer existed — and the editor holds its own copy of the
   * cage, so it would happily commit the ghost back into the scene.
   */
  latticeNodeId: string | null;
}

/**
 * What the lattice tools should be looking at after stepping to `state`.
 *
 * Clearing the rest of the tools' state alongside it, because they are all
 * about a body that may be gone: stats describing a shape nobody can see, a
 * selection of corners that no longer exist, a cut spot on a missing surface.
 */
function latticeAfterUndo(state: UndoRedoState) {
  const id = state.latticeNodeId;
  const stillThere = id !== null && findNode(state.sceneGraph.nodes, id) !== null;
  if (stillThere) return { latticeNodeId: id };
  return { latticeNodeId: null, latticeStats: null, latticeSelection: null, cutSpot: null };
}

export interface PhysicsState {
  mujoco: typeof MUJOCO_SHIM | null;
  model: ModelMirror | null;
  data: DataMirror | null;
  
  // History State
  undoStack: UndoRedoState[];
  redoStack: UndoRedoState[];
  tempUndoState: UndoRedoState | null;
  historyDebounceTimer: ReturnType<typeof setTimeout> | null;
  lastInteractionType: string | null;

  // History Actions
  undo: () => void;
  redo: () => void;
  recordInteraction: (type: string) => void;
  flushPendingUndo: () => void;
  prepareForDiscreteChange: () => void;
  
  isPlaying: boolean;
  isLoaded: boolean;
  lastCompileError: string | null;
  isSettingsOpen: boolean;
  cameraView: 'perspective' | 'topDown';
  printAnalysisEnabled: boolean;

  // --- Viewport display ---------------------------------------------------
  /** Draw every body as the edges of its triangles rather than a shaded solid. */
  wireframe: boolean;
  toggleWireframe: () => void;
  /** Grid cell size in millimetres — 100mm reads a bench-scale part fine,
   *  but makes a small part (a relief carve, a coin) look tiny by comparison.
   *  Purely a display setting: never touches any body's actual dimensions. */
  gridCellSizeMm: number;
  setGridCellSizeMm: (mm: number) => void;

  // --- Coloring -----------------------------------------------------------
  //
  // Brushed onto part of a surface, not applied to a whole body — see
  // utils/vertexPaint. Purely how the scene looks: a geom's colour has never
  // fed the physics or any exporter.
  /** Whether a drag in the viewport paints bodies instead of selecting them. */
  paintMode: boolean;
  /** The colour the brush is holding, as 0..1 rgb to match a geom's rgba. */
  paintColor: [number, number, number];
  /** Brush radius in metres. */
  paintRadius: number;
  /** Coverage one dab lays down at the centre of the brush, 0..1. */
  paintFlow: number;
  togglePaintMode: () => void;
  setPaintColor: (rgb: [number, number, number]) => void;
  setPaintBrush: (patch: { radius?: number; flow?: number }) => void;
  /** Stores a finished stroke. Passing undefined strips a geom back to bare. */
  setGeomPaint: (nodeId: string, geomName: string, layer: PaintLayer | undefined) => void;
  /** Takes the paint off every geom of the scene. */
  clearAllPaint: () => void;
  /** Sets a body's base colour — one geom by name, or all of them. */
  setGeomColor: (nodeId: string, geomName: string | undefined, rgba: number[]) => void;
  // When set, CameraController points the camera at this explicit pose instead
  // of the cameraView preset. Position/target are in MuJoCo world space (same
  // convention as every other pos field in the app) — CameraController converts
  // to Three.js space itself. Set by the MCP SET_CAMERA bridge command so an
  // agent can frame a specific body without guessing preset rotations.
  cameraOverride: { position: [number, number, number]; target: [number, number, number] } | null;
  /**
   * Bumped whenever the camera should go back to the view it starts in.
   *
   * A token rather than a flag or a call: the camera lives inside the canvas
   * and the thing that wants it moved (loading a preset) is nowhere near it, and
   * "put it back where it starts" is not expressible as a state to be in — the
   * view a person has orbited to is also `perspective`, so nothing changes and
   * no effect re-runs. A number that only goes up always re-runs.
   */
  cameraResetToken: number;
  mcpActiveCount: number;
  scadCompileCount: number;
  
  // Environment
  gravityZ: number;
  windX: number;
  windY: number;
  density: number;
  floorFriction: number;
  floorBounce: number;
  
  // Scene
  sceneGraph: SceneGraph;
  selectedNodeId: string | null;
  recompileId: number;
  parentUnderSelected: boolean;
  activePreset: string;
  
  draggedNodeId: string | null;
  dragTarget: { x: number; y: number; z: number } | null;
  dragDistance: number;
  
  // Actions
  togglePlay: () => void;
  setLoaded: (loaded: boolean) => void;
  setSettingsOpen: (open: boolean) => void;

  /*
   * What is on the bench, and what is on it.
   *
   * These used to be picked separately inside each export modal, so the machine
   * and the material were answered once per operation and could disagree
   * between them — a relief carved for hardwood and a contour slice cut for
   * acrylic, from the same scene, on the same machine, in the same session.
   * They are properties of the workshop rather than of one export, so they live
   * here and every exporter reads them.
   */
  machineTarget: MachineTarget;
  material: MaterialId;
  /**
   * What it would be printed in, kept separate from what it would be cut from.
   *
   * Two lists rather than one widened one: a filament has no surface speed and
   * no chip load, and adding PLA to the table the feeds arithmetic reads from
   * would mean inventing both. Switching the bench between a printer and a
   * router also should not silently reinterpret "PETG" as a milling stock.
   */
  filament: FilamentId;
  isMachineConfigOpen: boolean;
  setMachineTarget: (target: MachineTarget) => void;
  setMaterial: (material: MaterialId) => void;
  setFilament: (filament: FilamentId) => void;
  setMachineConfigOpen: (open: boolean) => void;
  setCameraView: (view: 'perspective' | 'topDown') => void;
  setPrintAnalysisEnabled: (enabled: boolean) => void;
  togglePrintAnalysis: () => void;
  addHardwareComponentNode: (hardwareNode: SceneNode) => void;
  setCameraOverride: (override: { position: [number, number, number]; target: [number, number, number] } | null) => void;
  setEnvironment: (env: Partial<{gravityZ: number, windX: number, windY: number, density: number, floorFriction: number, floorBounce: number}>) => void;
  
  setSelectedNodeId: (id: string | null) => void;
  /**
   * Bodies selected ALONGSIDE selectedNodeId, for operations that take more
   * than one — combining, so far.
   *
   * Kept beside the single selection rather than replacing it, because
   * everything else in the app asks "which body's properties am I showing" and
   * that has exactly one answer. This is the rest of the set; the panel shows
   * the primary, and an operation acts on primary plus these.
   */
  extraSelectedIds: string[];
  /** Adds a body to the selection, or takes it out again. */
  toggleExtraSelected: (id: string) => void;
  /**
   * Merges other bodies into this one and applies a boolean between them.
   *
   * The move the boolean tools were missing. A body's geoms ARE its boolean
   * program, so two separate bodies could never cut each other however they
   * overlapped — the only way to subtract a sphere from a cube was to create
   * the sphere on the cube. This brings the sphere over: its shapes are
   * rewritten into the cube's frame, marked with the operation, and the body
   * they came from is removed.
   *
   * `union` leaves them as ordinary added shapes, which is a compound body and
   * needs no boolean at all. `difference` and `intersection` turn the boolean
   * on, and the result is compiled like any other.
   */
  combineBodies: (targetId: string, sourceIds: string[], op: CombineOp) => void;
  updateScene: (sceneGraph: SceneGraph, skipRecompile?: boolean) => void;
  updateNodePos: (id: string, newPos: [number, number, number]) => void;
  updateNodeGeom: (id: string, updates: Partial<SceneGeom>, geomIndex?: number) => void;
  updateNodeJoint: (id: string, updates: Partial<SceneJoint>) => void;
  updateGearTeeth: (id: string, teeth: number) => void;
  rotateAroundCOM: boolean;
  setRotateAroundCOM: (val: boolean) => void;
  updateNodeRotation: (id: string, axis: 0 | 1 | 2, deg: number, rotateAroundCOM?: boolean) => void;
  updateNodeScript: (id: string, script: string) => void;
  updateNode: (id: string, updates: Partial<SceneNode>) => void;

  renameNode: (id: string, newName: string) => void;
  updateNodeJointsList: (id: string, joints: SceneJoint[]) => void;
  deleteNode: (id: string) => void;
  addPusherPeg: (gearId: string) => void;
  deletePusherPeg: (gearId: string) => void;
  updatePusherPeg: (gearId: string, updates: { offset?: number, size?: [number, number] }) => void;
  
  setDraggedNodeId: (id: string | null) => void;
  setDragTarget: (target: { x: number; y: number; z: number } | null) => void;
  setDragDistance: (distance: number) => void;
  updateWedgeParams: (id: string, params: { width?: number; depth?: number; height?: number; wedgeAngle?: number }) => void;
  updatePyramidParams: (id: string, params: { width?: number; depth?: number; height?: number }) => void;
  updateConeParams: (id: string, params: { radius?: number; height?: number }) => void;
  updateTorusParams: (id: string, params: { majorRadius?: number; tubeRadius?: number }) => void;
  updateTubeParams: (id: string, params: { innerRadius?: number; outerRadius?: number; height?: number }) => void;
  updateCurveParams: (id: string, params: { points?: number[][]; width?: number; thickness?: number; segments?: number; closed?: boolean; bank?: number }) => void;
  updatePulleyParams: (id: string, params: { leftTargetId?: string; rightTargetId?: string; pulleyRadius?: number }) => void;
  updateRopeParams: (id: string, params: { pulleyWheelId?: string; leftTargetId?: string; rightTargetId?: string }) => void;
  updateNodeComposite: (id: string, params: Partial<SceneNode>) => void;
  
  setParentUnderSelected: (val: boolean) => void;
  addComponent: (type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'bob' | 'gear' | 'wedge' | 'pulley_wheel' | 'pulley_rope' | 'mesh' | 'openscad' | 'pyramid' | 'cone' | 'torus' | 'tube' | 'ellipsoid' | 'curve' | 'ring' | 'sculpt' | 'lattice', position: number[]) => void;

  // --- Sculpting ----------------------------------------------------------
  /** The body being sculpted, or null when the sculpt tools are closed. */
  sculptNodeId: string | null;
  /** The brush the sculpt tools are holding. */
  sculptBrush: BrushSettings;
  /** Live vertex/face counts and watertightness of the mesh being sculpted. */
  sculptStats: { vertices: number; faces: number; watertight: boolean; atBudget: boolean } | null;
  setSculptNodeId: (id: string | null) => void;
  setSculptBrush: (patch: Partial<BrushSettings>) => void;
  setSculptStats: (stats: { vertices: number; faces: number; watertight: boolean; atBudget: boolean } | null) => void;
  /** Replaces a sculpt body's mesh with a different base shape, discarding the old one. */
  setSculptBase: (nodeId: string, base: SculptBaseId) => void;

  // --- Lattice modelling ---------------------------------------------------
  //
  // The state here is the state of the TOOL, not of the shape: the shape lives
  // on the node as `latticeCage`, because it has to survive being saved and the
  // tool does not. See utils/latticeMesh.ts.
  /**
   * What the app is in the middle of, in the words a person would use: "Scale
   * 1.25x", "Inset 3.0 mm", "Extrude". Null when nothing modal is running.
   *
   * A gesture that is sized by the pointer has no dialog and no handle to read
   * a number off — the shape follows the mouse and that is the whole interface.
   * That works right up until you want to know WHICH gesture is running and how
   * far it has gone, which is what the status bar reads from here.
   */
  gestureStatus: string | null;
  setGestureStatus: (status: string | null) => void;

  /**
   * The measure tool: 'distance' wants two points, 'angle' wants three, null
   * is not measuring.
   *
   * A mode rather than a gesture, because a measurement is not an edit. Every
   * other modal thing in the app ends by changing the model or putting it back,
   * so it can be transient; this one ends by having told you a number, and the
   * number has to stay on screen while you go and do something about it. It
   * also outranks selection while it is on — a click is a pick, not a
   * selection — which is why it lives beside the tools rather than inside one.
   */
  measureMode: 'distance' | 'angle' | null;
  setMeasureMode: (mode: 'distance' | 'angle' | null) => void;

  /** The body being modelled, or null when the lattice tools are closed. */
  latticeNodeId: string | null;
  latticeTool: LatticeTool;
  /**
   * The slice of the grid that clicks land on. Everything about placing a point
   * in three dimensions with a two-dimensional pointer comes down to this: a
   * ray hits infinitely many grid points, and exactly one plane.
   */
  latticePlane: { axis: LatticeAxis; index: number };
  /** How many grid steps a click snaps to. Powers of two only — see SNAP_MULTIPLES. */
  latticeSnap: SnapMultiple;
  /** Mirror every placement across this axis through the body origin. */
  latticeMirror: LatticeAxis | null;
  /** What the panel shows: counts and whether the surface has closed. */
  latticeStats: { vertices: number; faces: number; quads: number; tris: number; creases: number; inconsistent: number; watertight: boolean; parts: number } | null;
  setLatticeNodeId: (id: string | null) => void;
  setLatticeTool: (tool: LatticeTool) => void;
  setLatticePlane: (plane: { axis: LatticeAxis; index: number }) => void;
  /** Steps the work plane along its own axis. The keyboard's main job here. */
  nudgeLatticePlane: (delta: number) => void;
  setLatticeSnap: (snap: SnapMultiple) => void;
  setLatticeMirror: (axis: LatticeAxis | null) => void;
  /**
   * Whether the pointer is being held to the work plane, for whatever reason:
   * Ctrl held, the hold below switched on, or a drawing tool in hand. Set by
   * the viewport, which is the only thing that knows all three.
   */
  latticePlaneLocked: boolean;
  setLatticePlaneLocked: (locked: boolean) => void;
  /**
   * The work plane held still without a key held down — the panel's lock
   * button, or Caps Lock, whose light then says whether the plane is held.
   *
   * Separate from `latticePlaneLocked` because that is the EFFECT and this is
   * one of its causes: Ctrl is a moment, this is a decision, and a decision has
   * to survive letting go of the keyboard.
   */
  latticePlaneHold: boolean;
  setLatticePlaneHold: (hold: boolean) => void;
  /**
   * Bumped to ask the viewport to turn every face the right way round.
   *
   * A request rather than a scene-graph edit: the editor holds the live cage
   * while it is open, so a repair written straight to the node would either be
   * overwritten by the next commit or force a remount that throws away the
   * undo history the repair most needs to be part of.
   */
  latticeOrientRequest: number;
  requestLatticeOrient: () => void;
  /**
   * What is selected in the editor, measured — the numbers the panel puts in
   * boxes you can type into.
   *
   * Published by the viewport rather than derived from the node, because the
   * selection and the live cage both belong to the editor while it is open; the
   * scene graph only hears about whole operations.
   *
   * Extents and positions are in millimetres on the cage's own grid, which is
   * the frame every lattice tool already speaks. An axis whose extent is zero —
   * a face seen edge-on, a loop lying in a plane — has a position and no size,
   * and the panel says so rather than offering a box that cannot do anything.
   */
  latticeSelection: {
    kind: 'face' | 'faces' | 'edge' | 'loop' | 'corner' | 'corners';
    corners: number;
    minMm: number[];
    maxMm: number[];
  } | null;
  setLatticeSelection: (selection: PhysicsState['latticeSelection']) => void;
  /**
   * Asks the viewport to make the selection a given size, or to put it at a
   * given place, on one axis.
   *
   * A request for the same reason orienting is one: the cage the numbers would
   * be written to is the editor's, not the node's. `nonce` is what makes two
   * identical edits in a row two edits — typing 20 twice on a selection that
   * has drifted has to work the second time.
   */
  latticeResizeRequest: { axis: LatticeAxis; mode: 'size' | 'position'; mm: number; nonce: number } | null;
  requestLatticeResize: (axis: LatticeAxis, mode: 'size' | 'position', mm: number) => void;
  /**
   * How much a chamfer or fillet takes off a selected edge, in millimetres.
   *
   * A setting rather than a gesture. Every other size in the lattice tools is
   * dragged out with the pointer, but a fillet radius is almost always a number
   * somebody already has — it is the cutter they own, or the radius the mating
   * part needs — and dragging until the readout says 3.00 is a poor way to ask
   * for 3 mm. It is also the one number that has to survive between operations,
   * because a part wants the same radius on every edge.
   */
  latticeBevelMm: number;
  setLatticeBevelMm: (mm: number) => void;
  /** Asks the viewport to chamfer or round the edges it has selected. */
  latticeBevelRequest: { mode: 'chamfer' | 'fillet'; mm: number; nonce: number } | null;
  requestLatticeBevel: (mode: 'chamfer' | 'fillet', mm: number) => void;
  /**
   * How many corners the shape tool's ring gets. Zero means "as many as it
   * takes to be round", which is what a circle is on a grid — see circleSides.
   */
  latticeShapeSides: number;
  setLatticeShapeSides: (sides: number) => void;
  /** Asks the viewport to sweep the selected profile about one of the axes. */
  latticeRevolveRequest: { axis: LatticeAxis; degrees: number; nonce: number } | null;
  requestLatticeRevolve: (axis: LatticeAxis, degrees: number) => void;
  /**
   * Where the next cut on this body should go: a point on its surface and the
   * way the surface faces there, both in the BODY's frame.
   *
   * Published by the viewport, because that is where surfaces are picked. Two
   * things feed it — the face selected in the lattice editor, and an ordinary
   * click on any other body, which already raycasts to select it and now says
   * where it landed. Either way a hole goes exactly where you pointed, square
   * to the surface, and that is the same sentence for a lattice, a mesh, an
   * imported STL and a primitive.
   *
   * Not on the cage's grid, unlike the figures in `latticeSelection`: the two
   * differ by however far a lattice mesh was recentred on its centre of mass.
   */
  cutSpot: { nodeId: string; at: number[]; normal: number[] } | null;
  setCutSpot: (spot: { nodeId: string; at: number[]; normal: number[] } | null) => void;
  setLatticeStats: (stats: { vertices: number; faces: number; quads: number; tris: number; creases: number; inconsistent: number; watertight: boolean; parts: number } | null) => void;
  /**
   * Writes a cage to a node and rebuilds its mesh from it, in one go.
   *
   * One action rather than a geom update followed by a node update, because
   * those are two scene-graph writes and therefore two MuJoCo recompiles for
   * what is one edit.
   */
  applyLattice: (nodeId: string, cage: LatticeCage, subdiv?: number, quiet?: boolean) => void;
  /**
   * Applies the cage: the mesh stops being derived and becomes the document.
   *
   * Sculpting is the only thing that asks for this, and it has to ask, because
   * the two tools cannot both own one mesh — see SceneNode.latticeBaked. An
   * ordinary undo step, so the cage comes back with Ctrl+Z.
   */
  bakeLattice: (nodeId: string) => void;
  /**
   * Breaks a lattice that is several separate pieces into one body per piece,
   * each with its own cage, at the same place in the world. The first piece
   * keeps the body; the rest are new bodies beside it. Nothing moves — this
   * is what makes it possible to move one piece against another afterwards,
   * or hand one to the other with Subtract.
   */
  separateLattice: (nodeId: string) => void;
  /** Changes how many smoothing passes a lattice body's mesh is built with. */
  setLatticeSubdiv: (nodeId: string, level: number) => void;
  /** Sets a lattice body's wall thickness in millimetres; 0 leaves it a surface. */
  setLatticeThickness: (nodeId: string, mm: number) => void;
  /**
   * Cuts a shape out of a body — any body, not only a lattice one.
   *
   * This is the missing half of the boolean tools. A body's geoms are its
   * boolean program, and until now nothing in the app could put a geom ON a
   * body: dragging a shape in while one was selected made a CHILD BODY, whose
   * geoms belong to a different program entirely and are invisible to the
   * parent's. So a hole could be authored in a preset, in OpenSCAD or over MCP,
   * and nowhere else.
   *
   * On a lattice body it is also the one thing a grid cannot do. Every corner
   * of a cage is a triple of integers, so every shape it can describe lands on
   * the grid — and a 6.35 mm bore does not, at any step worth modelling at. The
   * cage stays editable underneath: the boolean is re-evaluated from the mesh
   * the cage produces, so moving a face moves the material around the hole.
   *
   * `spot` says where on the surface it goes and which way that surface faces;
   * without one it uses whatever was last picked on this body, and failing that
   * the spot the camera is looking at. Returns the index of the geom it added,
   * or -1.
   */
  addBodyCut: (nodeId: string, shape: 'cylinder' | 'box' | 'sphere', spot?: CutSpot) => number;
  /** Moves a cut to another spot on the part, square to the surface there. */
  moveCutTo: (nodeId: string, geomIndex: number, spot: CutSpot) => void;
  /** Sets how deep a cut goes, in millimetres in from the surface; 0 goes through. */
  setCutDepth: (nodeId: string, geomIndex: number, mm: number) => void;
  /** Resizes a cut's cross-section, in millimetres, and re-derives its length. */
  setCutSection: (nodeId: string, geomIndex: number, section: number[]) => void;
  updateNodeScad: (id: string, scadCode: string, compiledData: { vertices: number[], faces: number[], renderVertices: number[] }, skipRecompile?: boolean) => void;
  // --- CSG (boolean modifiers) ---
  deleteNodeGeom: (nodeId: string, geomIndex: number) => void;
  setGeomCsgOp: (nodeId: string, geomIndex: number, csg: CsgOp) => void;
  /**
   * Puts a scaled copy of a body's own shape inside it, marked as a hole.
   *
   * The shortest path from a solid to a hollow one. Factors are per-axis, and
   * an axis above 1 is how the copy is made to pass right through — a cylinder
   * with a [0.8, 0.8, 1.05] copy of itself subtracted is a pipe, where the same
   * copy shrunk on all three would be a sealed cavity nobody can see.
   */
  insetNodeGeoms: (nodeId: string, factor: [number, number, number]) => void;
  applyNodeCsg: (nodeId: string, result: CsgResult, skipRecompile?: boolean) => void;
  setNodeCsgError: (nodeId: string, error: string | null, hash?: string) => void;
  recompile: (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean, keepPreset?: boolean) => Promise<void>;
  loadPreset: (name: string) => void;
  resetSimulation: () => void;
  recoverFromFatalWorkerError: (message: string, lastState?: { qpos: number[]; qvel: number[]; time: number }) => Promise<void>;
  recycleWorkerSeamlessly: () => Promise<void>;
  incrementMcpActive: () => void;
  decrementMcpActive: () => void;
  resetMcpActive: () => void;
  incrementScadCompile: () => void;
  decrementScadCompile: () => void;
}
export const useStore = create<PhysicsState>()((set, get) => ({
  mujoco: null,
  model: null,
  data: null,
  recompileId: 0,

  // History State
  undoStack: [],
  redoStack: [],
  tempUndoState: null,
  historyDebounceTimer: null,
  lastInteractionType: null,

  // History Actions
  recordInteraction: (type: string) => {
    const state = get();
    if (state.lastInteractionType && state.lastInteractionType !== type) {
      state.flushPendingUndo();
    }

    if (!get().tempUndoState) {
      const snapshot: UndoRedoState = {
        sceneGraph: cloneSceneGraph(get().sceneGraph),
        gravityZ: get().gravityZ,
        windX: get().windX,
        windY: get().windY,
        density: get().density,
        floorFriction: get().floorFriction,
        floorBounce: get().floorBounce,
        selectedNodeId: get().selectedNodeId,
        latticeNodeId: get().latticeNodeId,
      };
      set({
        tempUndoState: snapshot,
        lastInteractionType: type
      });
    }

    if (get().historyDebounceTimer) {
      clearTimeout(get().historyDebounceTimer);
    }

    const timer = setTimeout(() => {
      get().flushPendingUndo();
    }, 800);

    set({ historyDebounceTimer: timer });
  },

  flushPendingUndo: () => {
    const { tempUndoState, undoStack, historyDebounceTimer } = get();
    if (historyDebounceTimer) {
      clearTimeout(historyDebounceTimer);
    }

    if (tempUndoState) {
      const current = get();
      const isDifferent =
        tempUndoState.gravityZ !== current.gravityZ ||
        tempUndoState.windX !== current.windX ||
        tempUndoState.windY !== current.windY ||
        tempUndoState.density !== current.density ||
        tempUndoState.floorFriction !== current.floorFriction ||
        tempUndoState.floorBounce !== current.floorBounce ||
        !sameValue(tempUndoState.sceneGraph, current.sceneGraph);

      if (isDifferent) {
        const newUndoStack = [...undoStack, tempUndoState];
        if (newUndoStack.length > 20) {
          newUndoStack.shift();
        }
        set({
          undoStack: newUndoStack,
          redoStack: [],
          tempUndoState: null,
          lastInteractionType: null,
          historyDebounceTimer: null
        });
      } else if (recompilesInFlight > 0) {
        // Nothing has moved YET. The change is still on its way through the
        // compiler, and the landing calls back here.
        set({ historyDebounceTimer: null });
      } else {
        set({
          tempUndoState: null,
          lastInteractionType: null,
          historyDebounceTimer: null
        });
      }
    }
  },

  /*
   * Snapshot before a change that happens all at once, rather than over a drag.
   *
   * Held for a tick rather than pushed on the spot, and then pushed only if the
   * scene actually moved. Everything that writes to the scene comes through
   * here — including the MCP bridge, which calls updateScene/updateNode for
   * every command an agent sends, whether or not the command changes anything.
   * Pushing unconditionally filled the undo stack with entries that undo to
   * exactly what is already on screen: twenty presses of Ctrl+Z that appear to
   * do nothing, with the edit you wanted back pushed off the end of the stack.
   *
   * The timer is zero, so the entry lands as soon as the change that follows
   * this call has been made — and any further discrete change flushes it first,
   * so a run of them still gets one entry each rather than being swallowed.
   */
  prepareForDiscreteChange: () => {
    get().flushPendingUndo();
    const { sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, latticeNodeId } = get();
    const snapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId,
      latticeNodeId,
    };
    set({
      tempUndoState: snapshot,
      lastInteractionType: 'discrete',
      historyDebounceTimer: setTimeout(() => get().flushPendingUndo(), 0),
    });
  },

  undo: () => {
    get().flushPendingUndo();
    const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, latticeNodeId } = get();
    if (undoStack.length === 0) return;

    const previousState = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);

    const currentStateSnapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId,
      latticeNodeId,
    };

    set({
      sceneGraph: previousState.sceneGraph,
      gravityZ: previousState.gravityZ,
      windX: previousState.windX,
      windY: previousState.windY,
      density: previousState.density,
      floorFriction: previousState.floorFriction,
      floorBounce: previousState.floorBounce,
      selectedNodeId: previousState.selectedNodeId,
      // The tools follow the document back. A body that has just stopped
      // existing cannot be the one being modelled, and the editor holding its
      // own copy of the cage is exactly how a ghost gets committed back in.
      ...latticeAfterUndo(previousState),
      undoStack: newUndoStack,
      redoStack: [...redoStack, currentStateSnapshot],
      isPlaying: false
    });

    get().recompile(previousState.sceneGraph, previousState.selectedNodeId, true, true);
  },

  redo: () => {
    get().flushPendingUndo();
    const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, latticeNodeId } = get();
    if (redoStack.length === 0) return;

    const nextState = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);

    const currentStateSnapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId,
      latticeNodeId,
    };

    set({
      sceneGraph: nextState.sceneGraph,
      gravityZ: nextState.gravityZ,
      windX: nextState.windX,
      windY: nextState.windY,
      density: nextState.density,
      floorFriction: nextState.floorFriction,
      floorBounce: nextState.floorBounce,
      selectedNodeId: nextState.selectedNodeId,
      ...latticeAfterUndo(nextState),
      undoStack: [...undoStack, currentStateSnapshot],
      redoStack: newRedoStack,
      isPlaying: false
    });

    get().recompile(nextState.sceneGraph, nextState.selectedNodeId, true, true);
  },

  isPlaying: false,
  isLoaded: false,
  lastCompileError: null,
  isSettingsOpen: false,
  machineTarget: 'fdm',
  material: DEFAULT_MATERIAL,
  filament: DEFAULT_FILAMENT,
  isMachineConfigOpen: false,
  cameraView: 'perspective',
  printAnalysisEnabled: false,
  cameraOverride: null,
  cameraResetToken: 0,
  mcpActiveCount: 0,
  scadCompileCount: 0,
  
  gravityZ: -9.81,
  windX: 0,
  windY: 0,
  density: 0,
  floorFriction: 1.0,
  floorBounce: 0.0,
  
  rotateAroundCOM: true,
  setRotateAroundCOM: (val) => set({ rotateAroundCOM: val }),
  sceneGraph: initialScene,
  selectedNodeId: null,
  extraSelectedIds: [],
  parentUnderSelected: false,
  activePreset: 'pendulum',
  draggedNodeId: null,
  dragTarget: null,
  dragDistance: 0,

  setParentUnderSelected: (val) => set({ parentUnderSelected: val }),
  incrementMcpActive: () => set((state) => ({ mcpActiveCount: state.mcpActiveCount + 1 })),
  decrementMcpActive: () => set((state) => ({ mcpActiveCount: Math.max(0, state.mcpActiveCount - 1) })),
  resetMcpActive: () => set({ mcpActiveCount: 0 }),
  incrementScadCompile: () => set((state) => ({ scadCompileCount: state.scadCompileCount + 1 })),
  decrementScadCompile: () => set((state) => ({ scadCompileCount: Math.max(0, state.scadCompileCount - 1) })),

  togglePlay: () => set((state) => {
    const isPlaying = !state.isPlaying;
    getPhysicsWorkerClient().setPlaying(isPlaying);
    return { isPlaying };
  }),
  setLoaded: (loaded) => set({ isLoaded: loaded }),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setMachineTarget: (machineTarget) => set({ machineTarget }),
  setFilament: (filament) => set({ filament }),
  setMaterial: (material) => set({ material }),
  setMachineConfigOpen: (isMachineConfigOpen) => set({ isMachineConfigOpen }),
  setCameraView: (view) => set({ cameraView: view, cameraOverride: null }),
  setPrintAnalysisEnabled: (enabled) => set({ printAnalysisEnabled: enabled }),
  togglePrintAnalysis: () => set((state) => ({ printAnalysisEnabled: !state.printAnalysisEnabled })),

  wireframe: false,
  toggleWireframe: () => set((state) => ({ wireframe: !state.wireframe })),
  gridCellSizeMm: 100,
  // The one grid. The lattice used to have its own step beside this, and two
  // controls that both said "grid" and meant different things was one too
  // many: 1 mm on the floor and 10 mm in the lattice looked like a bug in the
  // lattice. Cells are millimetres; lattice steps are tenths, hence the ten.
  setGridCellSizeMm: (mm) => set({ gridCellSizeMm: mm, latticeSnap: (Math.round(mm * 10) || 10) as SnapMultiple }),

  paintMode: false,
  paintColor: [0.91, 0.30, 0.24],
  paintRadius: 0.008,
  paintFlow: 0.35,
  togglePaintMode: () => set((state) => ({ paintMode: !state.paintMode })),
  setPaintColor: (paintColor) => set({ paintColor }),
  setPaintBrush: (patch) => set((state) => ({
    paintRadius: patch.radius ?? state.paintRadius,
    paintFlow: patch.flow ?? state.paintFlow,
  })),

  setGeomPaint: (nodeId, geomName, layer) => {
    const existing = findNode(get().sceneGraph.nodes, nodeId);
    const index = existing?.geoms?.findIndex((geom: SceneGeom) => geom.name === geomName) ?? -1;
    if (index === -1) return;

    get().recordInteraction('paint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.[index]) return;
    if (layer) node.geoms[index].paint = layer;
    else delete node.geoms[index].paint;

    // Deliberately no recompile.
    //
    // Every other geom edit has to rebuild the MJCF and swap the model in the
    // physics worker, because every other geom edit changes something MuJoCo
    // reads. Paint is not one: the emitter names the attributes it writes, no
    // exporter reads vertex colour, and the viewport takes a geom's colour off
    // the scene graph rather than out of the compiled model. Rebuilding here
    // would drop the simulation back to its initial pose once per stroke to
    // change nothing the simulation can see.
    set({ sceneGraph: newScene });
  },

  setGeomColor: (nodeId, geomName, rgba) => {
    get().recordInteraction('node-geom');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.length) return;

    // No name means the whole body, which is what colouring an imported mesh or
    // a boolean body usually means — those arrive as several geoms and leaving
    // some of them the old colour is never what was asked for.
    const targets = geomName ? node.geoms.filter((g: SceneGeom) => g.name === geomName) : node.geoms;
    if (!targets.length) return;
    for (const geom of targets) {
      geom.rgba = [rgba[0] ?? 0.8, rgba[1] ?? 0.8, rgba[2] ?? 0.8, rgba[3] ?? geom.rgba?.[3] ?? 1];
    }

    // Base colour does go into the MJCF, unlike paint, so this one recompiles —
    // once for the whole body rather than once per geom.
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, true);
  },

  clearAllPaint: () => {
    get().recordInteraction('paint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    let found = false;
    const walk = (nodes: SceneNode[]) => {
      for (const node of nodes || []) {
        for (const geom of node.geoms || []) {
          if (geom.paint) { delete geom.paint; found = true; }
        }
        walk(node.children);
      }
    };
    walk(newScene.nodes);
    if (found) set({ sceneGraph: newScene });
  },

  addHardwareComponentNode: (hardwareNode) => {
    get().prepareForDiscreteChange();
    const sceneGraph = get().sceneGraph;
    const newNodes = [...sceneGraph.nodes, hardwareNode];
    const newGraph = { ...sceneGraph, nodes: newNodes };
    get().recompile(newGraph, hardwareNode.id);
  },
  setCameraOverride: (override) => set({ cameraOverride: override }),
  
  resetSimulation: () => {
    getPhysicsWorkerClient().setPlaying(false);
    set({ isPlaying: false });
    get().recompile(undefined, undefined, true, true);
  },
  
  loadPreset: (name) => {
    const prev = get().activePreset;
    get().prepareForDiscreteChange();
    getPhysicsWorkerClient().setPlaying(false);
    if (name.startsWith('user:')) {
      set((state) => ({
        isPlaying: false,
        selectedNodeId: null,
        activePreset: name,
        cameraOverride: null,
        cameraResetToken: state.cameraResetToken + 1,
        latticeNodeId: null,
        latticeStats: null,
        sculptNodeId: null,
        sculptStats: null,
        gestureStatus: null,
      }));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('physics:preset-loaded', { detail: { name, prev } }));
      }
      try {
        const savedScene = readUserPreset(name);
        // A preset with no nodes is a corrupt or half-written entry rather than
        // an empty scene; recompiling it would throw inside the MJCF builder.
        if (savedScene && Array.isArray(savedScene.nodes)) {
          promoteJointedMeshGeomsDeep(savedScene.nodes);
          get().recompile(savedScene as SceneGraph, null, true, true);
        }
      } catch (e) {
        console.error('Failed to load user preset', e);
      }
      return;
    }
    const preset: Preset | undefined = (PRESETS as Record<string, Preset>)[name];
    if (!preset) return;
    // Clone: PRESETS holds module-level objects, and handing one straight to the
    // store makes every later edit an edit of the preset itself — reloading it
    // would then restore the edited scene rather than the original.
    const scene: SceneGraph = name === 'empty'
      ? { nodes: [] }
      : cloneSceneGraph(preset.scene || get().sceneGraph);
    promoteJointedMeshGeomsDeep(scene.nodes);
    /*
     * Most presets rely on the default bench-scale framing, but a small one
     * (california_relief, lattice_bracket) can specify its own so it does not
     * read as a speck at that distance.
     *
     * It is applied AFTER the rebuild, not with the scene. The scene graph
     * changes here and now; the model the viewport draws is built by the worker
     * and arrives later, so moving the camera in this breath framed the OLD
     * scene from 120 mm away — a dark shape filling the window for a frame or
     * two before the new one appeared. Cleared immediately either way, so a
     * stale override from the previous preset cannot leak into one that did not
     * ask for it.
     */
    const framing = preset.camera ?? null;
    set((state) => ({
      isPlaying: false,
      selectedNodeId: null,
      activePreset: name,
      sceneGraph: scene,
      cameraOverride: null,
      // Back to the view every scene starts in. Whatever the camera was doing
      // belonged to the scene that has just gone: a view orbited round a 40 mm
      // part, or zoomed to six millimetres inside a lattice, frames the next
      // preset as a wall of geometry across the window.
      cameraResetToken: state.cameraResetToken + 1,
      // The modelling tools were open on a body that no longer exists.
      latticeNodeId: null,
      latticeStats: null,
      sculptNodeId: null,
      sculptStats: null,
      gestureStatus: null,
    }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('physics:preset-loaded', { detail: { name, prev } }));
    }
    if (preset.environment) {
      set({ windX: 0, windY: 0, floorBounce: 0, ...preset.environment });
    } else {
      set({ windX: 0, windY: 0, floorBounce: 0 });
    }
    void get().recompile(scene, null, true, true).then(() => {
      // Unless something else has been loaded in the meantime, in which case
      // this framing belongs to a scene that is no longer on screen.
      if (framing && get().activePreset === name) set({ cameraOverride: framing });
    });
  },
  
  setEnvironment: (env) => {
    get().recordInteraction('environment');
    set(env);
    get().recompile(get().sceneGraph);
  },
  
  setSelectedNodeId: (id) => set({ selectedNodeId: id, extraSelectedIds: [] }),
  combineBodies: (targetId, sourceIds, op) => {
    const scene = get().sceneGraph;
    const target = findNode(scene.nodes, targetId);
    const sources = sourceIds
      .filter(id => id !== targetId)
      .map(id => findNode(scene.nodes, id))
      .filter(Boolean);
    if (!target || sources.length === 0) return;

    // Every geom is written relative to the body carrying it, so moving one to
    // another body means composing three transforms: the source body's pose,
    // the geom's own, and the inverse of the destination's. This is the first
    // and last of those; utils/combineBodies does the middle one per geom.
    const targetWorld = nodeWorldMatrix(scene.nodes, targetId);
    if (!targetWorld) return;
    const intoTarget = targetWorld.clone().invert();

    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(scene);
    const node = findNode(newScene.nodes, targetId);
    if (!node) return;

    /*
      Two lattice bodies combined become ONE CAGE, not one cage with the other's
      frozen mesh bolted on. The mesh route worked in the sense that the shape
      was there, and failed in the sense that mattered: open the lattice tools
      afterwards and only the first body's corners could be touched, because the
      second was a mesh geom the cage knew nothing about.

      A cage corner lives in its body's frame at `coord * unit - latticeOrigin`
      (the mesh is recentred on its centre of mass; the origin is how far).
      That point goes through the same three transforms as any other geom and
      lands on the target's grid, rounded — so a source turned by something
      other than a right angle comes across as the nearest grid shape, which is
      what the grid means.

      The cages are then put through a real boolean (utils/latticeBoolean),
      which is the difference between a join and a union: concatenating them
      left the surface where the two solids met buried inside the result, along
      with every corner of it. All three operations go this way now — a cage
      cannot carry a 'subtract' marker, but it can be subtracted FROM.
    */
    const merged = node.isLattice && node.latticeCage
      ? deserializeCage(node.latticeCage)
      : null;
    let mergedFaces = 0;
    let mergedResult: ReturnType<typeof deserializeCage> | null = null;

    const taken = new Set<string>((node.geoms || []).map((g: SceneGeom) => g.name).filter(Boolean));
    const brought: SceneGeom[] = [];
    for (const source of sources) {
      const sourceWorld = nodeWorldMatrix(scene.nodes, source.id);
      if (!sourceWorld) continue;
      const relative = intoTarget.clone().multiply(sourceWorld);
      const cage = merged && source.isLattice && source.latticeCage ? deserializeCage(source.latticeCage) : null;
      let combined = false;
      if (cage && merged) {
        // Into a cage of its own rather than straight onto the target's: a
        // boolean compares two solids, and concatenating them first is exactly
        // the join that left a wall buried down the seam.
        const moved = cageInFrame(cage, relative, source.latticeOrigin, node.latticeOrigin, merged.unit);
        const result = latticeBoolean(mergedResult ?? merged, moved, op);
        if (result) {
          mergedResult = result;
          mergedFaces = faceCount(result);
          combined = true;
        }
      }
      // Only the cage went across, so the source's mesh stays behind. If the
      // boolean refused — an open shell, or a difference that removed
      // everything — nothing was combined and the geoms have to come the old
      // way, or the shape would simply vanish.
      brought.push(...geomsForCombine(source, relative, op, taken, combined));
    }
    if (brought.length === 0 && mergedFaces === 0) return;

    node.geoms = [...(node.geoms || []), ...brought];
    if (mergedResult && mergedFaces > 0) {
      node.latticeCage = serializeCage(mergedResult);
      // A new cage is a new document to the editor, which remounts on this.
      node.latticeVersion = (node.latticeVersion ?? 1) + 1;
    }
    // A boolean that happened on the cage has already happened; turning the
    // evaluator on as well would subtract the source a second time.
    if (op !== 'union' && !mergedResult) {
      node.csgEnabled = true;
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
    }

    // The bodies that were merged in are gone: their shapes are on the target
    // now, and leaving the originals behind would draw every one of them twice
    // and simulate them as separate objects that happen to overlap.
    const prune = (list: SceneNode[]): SceneNode[] => list
      .filter(n => !sourceIds.includes(n.id) || n.id === targetId)
      .map(n => ({ ...n, children: prune(n.children || []) }));
    newScene.nodes = prune(newScene.nodes);

    set({ sceneGraph: newScene, extraSelectedIds: [], selectedNodeId: targetId });
    if (mergedResult && mergedFaces > 0) {
      // Rebuilds the mesh from the merged cage, recentres the body on it, and
      // recompiles — the same path an edit in the lattice tools takes.
      get().applyLattice(targetId, node.latticeCage, node.latticeSubdiv);
      return;
    }
    get().recompile(newScene, targetId, true);
  },

  toggleExtraSelected: (id) => set((state) => {
    // The primary is already selected; asking for it again is not a second
    // selection, and letting it into the list would let a body be combined
    // with itself.
    if (!id || id === state.selectedNodeId) return {};
    return state.extraSelectedIds.includes(id)
      ? { extraSelectedIds: state.extraSelectedIds.filter(other => other !== id) }
      : { extraSelectedIds: [...state.extraSelectedIds, id] };
  }),

  sculptNodeId: null,
  sculptBrush: DEFAULT_BRUSH,
  // Sculpting a body that is being simulated means chasing it around the scene,
  // so entering the tools pauses the sim. Leaving them does not restart it —
  // that is the user's call, and starting a sim behind someone's back is how a
  // half-finished shape ends up on the floor.
  sculptStats: null,
  setSculptNodeId: (id) => set(id ? { sculptNodeId: id, latticeNodeId: null, selectedNodeId: id, isPlaying: false } : { sculptNodeId: null, sculptStats: null }),
  setSculptStats: (stats) => set({ sculptStats: stats }),

  // Wholesale replacement, not an edit: the version bump is what tells the
  // viewport to load the new mesh rather than carry on with the one it holds.
  setSculptBase: (nodeId, base) => {
    const mesh = buildSculptBase(base);
    const { vertices, renderVertices, faces } = toSceneGeom(mesh);
    const node = findNode(get().sceneGraph.nodes, nodeId);
    const geomIndex = Math.max(0, (node?.geoms ?? []).findIndex((g: SceneGeom) => g.type === 'mesh'));
    get().updateNodeGeom(nodeId, { vertices, renderVertices, faces }, geomIndex);
    get().updateNode(nodeId, {
      sculptBase: base,
      sculptVersion: (node?.sculptVersion ?? 1) + 1,
      sculptEdited: false,
    });
  },
  setSculptBrush: (patch) => set((state) => ({ sculptBrush: { ...state.sculptBrush, ...patch } })),

  gestureStatus: null,
  setGestureStatus: (status) => set((state) => (state.gestureStatus === status ? {} : { gestureStatus: status })),

  measureMode: null,
  setMeasureMode: (mode) => set((state) => (state.measureMode === mode ? {} : { measureMode: mode })),

  latticeNodeId: null,
  latticeTool: 'place',
  latticePlane: { axis: 'z', index: 0 },
  // 10 mm to start: the step most parts are laid out on, with 0.1 mm available
  // for detail without any of the coarse work having to move.
  latticeSnap: 1000,
  latticeMirror: null,
  latticePlaneLocked: false,
  latticePlaneHold: false,
  latticeOrientRequest: 0,
  latticeStats: null,
  latticeSelection: null,
  latticeResizeRequest: null,
  cutSpot: null,

  // Opening one modelling mode closes the other: both take over the drawing of
  // the body they are on and both bind the pointer, and two of them at once is
  // two components fighting over one mesh.
  setLatticeNodeId: (id) => set(id
    ? { latticeNodeId: id, sculptNodeId: null, selectedNodeId: id, isPlaying: false }
    : { latticeNodeId: null, latticeStats: null, latticeSelection: null, latticePlaneHold: false, cutSpot: null }),
  // Picking up a drawing tool holds the plane, since a stroke is flat; it is
  // the hold that can be let go of again, not a lock the tool insists on.
  setLatticeTool: (tool) => set(DRAWING_TOOLS.has(tool) ? { latticeTool: tool, latticePlaneHold: true } : { latticeTool: tool }),
  setLatticePlane: (plane) => set({ latticePlane: plane }),
  nudgeLatticePlane: (delta) => set((state) => ({
    latticePlane: { ...state.latticePlane, index: state.latticePlane.index + delta },
  })),
  setLatticeSnap: (snap) => set({ latticeSnap: snap }),
  setLatticeMirror: (axis) => set({ latticeMirror: axis }),
  setLatticePlaneLocked: (lockedNow) => set((state) => (
    state.latticePlaneLocked === lockedNow ? {} : { latticePlaneLocked: lockedNow }
  )),
  setLatticePlaneHold: (hold) => set((state) => (state.latticePlaneHold === hold ? {} : { latticePlaneHold: hold })),
  requestLatticeOrient: () => set((state) => ({ latticeOrientRequest: state.latticeOrientRequest + 1 })),
  setLatticeSelection: (selection) => set({ latticeSelection: selection }),
  setCutSpot: (spot) => set({ cutSpot: spot }),
  requestLatticeResize: (axis, mode, mm) => set((state) => ({
    latticeResizeRequest: { axis, mode, mm, nonce: (state.latticeResizeRequest?.nonce ?? 0) + 1 },
  })),
  latticeBevelMm: 1,
  setLatticeBevelMm: (mm) => set({ latticeBevelMm: Math.max(0, mm) }),
  latticeBevelRequest: null,
  requestLatticeBevel: (mode, mm) => set((state) => ({
    latticeBevelRequest: { mode, mm, nonce: (state.latticeBevelRequest?.nonce ?? 0) + 1 },
  })),
  latticeShapeSides: 0,
  setLatticeShapeSides: (sides) => set({ latticeShapeSides: Math.max(0, Math.floor(sides)) }),
  latticeRevolveRequest: null,
  requestLatticeRevolve: (axis, degrees) => set((state) => ({
    latticeRevolveRequest: { axis, degrees, nonce: (state.latticeRevolveRequest?.nonce ?? 0) + 1 },
  })),
  setLatticeStats: (stats) => set({ latticeStats: stats }),

  applyLattice: (nodeId, cage, subdiv, quiet) => {
    get().recordInteraction('lattice');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === nodeId) {
          const level = subdiv ?? node.latticeSubdiv ?? 0;
          const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(
            deserializeCage(cage), level, node.latticeThickness ?? 0,
          );
          /*
            The cage owns ONE geom, and it says so. A lattice body may now carry
            other shapes — a cut to subtract, and the boolean evaluator's own
            output, which is a mesh too — so "the first mesh geom" long ago
            stopped naming one thing. Older saves have no marker, so the first
            mesh that isn't generated is adopted as the cage's and marked.
          */
          const geom = node.geoms?.find((g: SceneGeom) => g.latticeGeom)
            ?? node.geoms?.find((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived)
            ?? node.geoms?.[0];
          if (geom) Object.assign(geom, { vertices, renderVertices, faces, latticeGeom: true });

          /*
            The mesh comes back centred on its own centre of mass, so the body
            spins about the shape rather than swinging it around a point off to
            one side — see latticeMesh.toSceneGeom. The body then has to move by
            however much the shape moved, or extruding away from the origin
            would drag the whole thing across the scene.

            The offset is in the body's own axes, so it is rotated into world
            space by the body's own orientation before it is added to a world
            position. Only the CHANGE is applied: the offset already baked into
            the mesh is remembered on the node, because every commit recomputes
            it from scratch.
          */
          const previous = node.latticeOrigin ?? [0, 0, 0];
          const local = [
            origin[0] - previous[0],
            origin[1] - previous[1],
            origin[2] - previous[2],
          ];
          const delta = new THREE.Vector3(local[0], local[1], local[2]);
          if (delta.lengthSq() > 0) {
            /*
              Everything else on the body is positioned in the body's frame, and
              the recentring below moves the body out from under it. A cut sits
              where it was put ON THE SHAPE — so the shapes that aren't the cage's
              are walked back by the same amount the cage's vertices just moved,
              or extruding a face on one side of a part would drag the hole on
              the other side along with it.
            */
            for (const other of node.geoms ?? []) {
              if (other === geom || other.csgDerived) continue;
              const at = other.pos ?? [0, 0, 0];
              other.pos = [at[0] - local[0], at[1] - local[1], at[2] - local[2]];
            }
            if (node.quat) {
              delta.applyQuaternion(new THREE.Quaternion(node.quat[1], node.quat[2], node.quat[3], node.quat[0]));
            } else if (node.euler) {
              const rad = (d: number) => (d * Math.PI) / 180;
              delta.applyEuler(new THREE.Euler(rad(node.euler[0]), rad(node.euler[1]), rad(node.euler[2]), 'XYZ'));
            }
            node.pos = [
              (node.pos?.[0] ?? 0) + delta.x,
              (node.pos?.[1] ?? 0) + delta.y,
              (node.pos?.[2] ?? 0) + delta.z,
            ];
            // basePos is what the rotation code rewinds to; leaving it behind
            // would teleport the body back to where the shape used to be the
            // next time somebody turned a rotation slider.
            if (node.basePos) node.basePos = [...node.pos];
          }

          /*
            And the cuts follow the shape. The walk-back above keeps a cut where
            it was put ACROSS its face; this puts it back at the right depth
            INTO it, now that the face has moved. Without it, pushing the top of
            a part up leaves a hole sealed inside the material — a void nothing
            in the viewport shows.
          */
          reconcileCuts(node);

          node.latticeOrigin = origin;
          node.latticeCage = cage;
          node.latticeSubdiv = level;
          node.latticeEdited = true;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // `quiet` for all but the last of a batch: several bodies rebuilt in a
      // row each asking for a compile recycles the worker under the earlier
      // ones, which fail, loudly, for nothing.
      if (!quiet) get().recompile(newScene, undefined, true);
    }
  },

  separateLattice: (nodeId) => {
    const node = findNode(get().sceneGraph.nodes, nodeId);
    if (!node?.isLattice || !node.latticeCage) return;
    const pieces = separablePieces(deserializeCage(node.latticeCage));
    if (pieces.length < 2) return;

    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const first = findNode(newScene.nodes, nodeId);
    if (!first) return;
    first.latticeCage = serializeCage(pieces[0]);
    first.latticeVersion = (first.latticeVersion ?? 1) + 1;

    const cageGeom = (first.geoms || []).find((g: SceneGeom) => g.latticeGeom) ?? first.geoms?.[0];
    const ids: string[] = [nodeId];
    // The parent the original hangs from, so the pieces hang there too and
    // the copied pose means the same thing.
    const siblings = (() => {
      const walk = (list: SceneNode[]): SceneNode[] | null => {
        for (const n of list) {
          if (n.id === nodeId) return list;
          const found = walk(n.children || []);
          if (found) return found;
        }
        return null;
      };
      return walk(newScene.nodes) ?? newScene.nodes;
    })();
    pieces.slice(1).forEach((piece) => {
      const id = `lattice_${Math.random().toString(36).substring(2, 10)}`;
      ids.push(id);
      /*
        The same pose and the same cage frame: every piece's coordinates are
        the original cage's, so a copy of the original's origin puts the piece
        exactly where it was drawn, and applyLattice then recentres each body
        on its own piece by the difference — which is how the original works
        after any edit.
      */
      siblings.push({
        id,
        name: id,
        type: 'body',
        pos: [...(first.pos ?? [0, 0, 0])],
        ...(first.quat ? { quat: [...first.quat] } : {}),
        ...(first.euler ? { euler: [...first.euler] } : {}),
        joints: (first.joints || []).map((j: SceneJoint) => ({ ...j, name: `${id}_${String(j.name || 'joint').split('_').pop()}` })),
        isLattice: true,
        latticeCage: serializeCage(piece),
        latticeSubdiv: first.latticeSubdiv ?? 0,
        latticeThickness: first.latticeThickness,
        latticeVersion: 1,
        latticeOrigin: [...(first.latticeOrigin ?? [0, 0, 0])],
        geoms: [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [...(cageGeom?.rgba ?? [0.55, 0.68, 0.85, 1])],
          mass: cageGeom?.mass ?? 1,
          condim: cageGeom?.condim ?? 3,
          dynamic: true,
          vertices: [],
          faces: [],
          renderVertices: [],
          latticeGeom: true,
        }],
        children: [],
      });
    });
    set({ sceneGraph: newScene, extraSelectedIds: [] });
    // Rebuilds each body's mesh from its cage and recentres it; the last one
    // recompiles with all of them in place.
    ids.forEach((id, i) => {
      const n = findNode(get().sceneGraph.nodes, id);
      if (n?.latticeCage) get().applyLattice(id, n.latticeCage, n.latticeSubdiv ?? 0, i < ids.length - 1);
    });
  },

  bakeLattice: (nodeId) => {
    const node = findNode(get().sceneGraph.nodes, nodeId);
    if (!node?.isLattice) return;
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const baked = findNode(newScene.nodes, nodeId);
    if (!baked) return;
    baked.isLattice = false;
    baked.latticeBaked = true;
    // The cage itself is left alone. It costs a few hundred integers, it is
    // the only record of how the shape was built, and undo needs it to be
    // there when it turns `isLattice` back on.
    set({ sceneGraph: newScene });
    if (get().latticeNodeId === nodeId) {
      set({ latticeNodeId: null, latticeStats: null, latticeSelection: null, latticePlaneHold: false, cutSpot: null });
    }
  },

  setLatticeSubdiv: (nodeId, level) => {
    const node = findNode(get().sceneGraph.nodes, nodeId);
    if (!node?.latticeCage) return;
    get().applyLattice(nodeId, node.latticeCage, Math.max(0, Math.min(2, Math.round(level))));
  },

  setLatticeThickness: (nodeId, mm) => {
    const node = findNode(get().sceneGraph.nodes, nodeId);
    if (!node?.latticeCage) return;
    // Written to the node first, because applyLattice reads the thickness off
    // the node when it builds the mesh — the same ordering the version bump
    // needs, and for the same reason.
    get().updateNode(nodeId, { latticeThickness: Math.max(0, mm) / 1000 });
    get().applyLattice(nodeId, node.latticeCage, node.latticeSubdiv ?? 0);
  },

  addBodyCut: (nodeId, shape, spot) => {
    const target = findNode(get().sceneGraph.nodes, nodeId);
    if (!target) return -1;
    const bounds = sourcePositiveBounds(target);
    if (!bounds) return -1;
    const span = [0, 1, 2].map(a => Math.max(1e-4, bounds.max[a] - bounds.min[a]));

    /*
      Where it goes, in order of how much the app actually knows:

        the spot handed in;
        the last surface picked on this body — the face selected in the lattice
        editor, or wherever an ordinary click landed on it;
        the spot the camera is looking at;
        and failing all of that the middle of the top, which is only reached
        with no viewport at all.
    */
    const picked = get().cutSpot;
    const where = spot
      ?? (picked?.nodeId === nodeId ? { at: picked.at, normal: picked.normal } : null)
      ?? cutSpotFromCamera(target)
      ?? {
        at: [0, 1, 2].map(a => +((bounds.min[a] + bounds.max[a]) / 2).toFixed(6)),
        normal: [0, 0, 1],
      };

    // Sized off the part: a hole that arrives at a seventh of the part's width
    // is one typed number from what you wanted, where a fixed 10 mm is off the
    // model entirely on anything small and a speck on anything large.
    const across = Math.min(span[0], span[1], span[2]);

    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return -1;

    const used = (node.geoms || []).filter((g: SceneGeom) => g.csg === 'difference' && !g.csgDerived).length;
    const geom: SceneGeom = {
      name: `${node.id}_cut${used + 1}`,
      type: shape,
      size: shape === 'box'
        ? [+(across * 0.15).toFixed(6), +(across * 0.15).toFixed(6), 0]
        : [+(across * 0.15).toFixed(6), 0],
      csg: 'difference' as const,
      cutAt: where.at.map(v => +v.toFixed(6)),
      cutNormal: where.normal,
      // Straight through to begin with. A hole that goes all the way is the
      // common one, and it is the only starting depth that cannot look like it
      // did nothing.
      cutDepth: 0,
      rgba: [0.9, 0.25, 0.35, 1],
    };
    const derived = cutGeometry(node, geom);
    if (!derived) return -1;
    Object.assign(geom, derived);

    node.geoms = [...(node.geoms || []), geom];
    node.csgEnabled = true;
    if (node.csgCollision === undefined) node.csgCollision = 'auto';
    if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;

    set({ sceneGraph: newScene });
    get().recompile(newScene, nodeId, false);
    return node.geoms.length - 1;
  },

  moveCutTo: (nodeId, geomIndex, spot) => reshapeCut(get, set, nodeId, geomIndex, 'cut-move', (geom) => {
    geom.cutAt = spot.at.map(v => +v.toFixed(6));
    geom.cutNormal = spot.normal;
  }),

  setCutDepth: (nodeId, geomIndex, mm) => reshapeCut(get, set, nodeId, geomIndex, 'cut-depth', (geom) => {
    geom.cutDepth = Math.max(0, mm) / 1000;
  }),

  setCutSection: (nodeId, geomIndex, section) => reshapeCut(get, set, nodeId, geomIndex, 'cut-section', (geom) => {
    const size = [...(geom.size || [])];
    if (geom.type === 'box') {
      // The slot's own width and breadth, in its own frame — they turn with it
      // rather than staying world X and Y.
      size[0] = Math.max(1e-6, section[0] ?? size[0] ?? 0.005);
      size[1] = Math.max(1e-6, section[1] ?? size[1] ?? 0.005);
    } else {
      size[0] = Math.max(1e-6, section[0] ?? size[0] ?? 0.005);
    }
    geom.size = size;
  }),

  setDraggedNodeId: (id) => {
    if (id !== null && get().draggedNodeId === null) {
      get().recordInteraction('drag-node');
    }
    set({ draggedNodeId: id });
    getPhysicsWorkerClient().setDrag(id, get().dragTarget);
  },
  setDragTarget: (target) => {
    set({ dragTarget: target });
    getPhysicsWorkerClient().setDrag(get().draggedNodeId, target);
  },
  setDragDistance: (distance) => set({ dragDistance: distance }),

  updateWedgeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.width !== undefined) {
            node.width = params.width;
            // Recalculate wedgeAngle
            const h = node.height || 0.5;
            node.wedgeAngle = Math.atan(h / node.width) * 180 / Math.PI;
          }
          if (params.height !== undefined) {
            node.height = params.height;
            // Recalculate wedgeAngle
            const w = node.width || 2.0;
            node.wedgeAngle = Math.atan(node.height / w) * 180 / Math.PI;
          }
          if (params.depth !== undefined) {
            node.depth = params.depth;
          }
          if (params.wedgeAngle !== undefined) {
            node.wedgeAngle = params.wedgeAngle;
            // Recalculate height
            const w = node.width || 2.0;
            node.height = w * Math.tan(node.wedgeAngle * Math.PI / 180);
          }
          
          // Update first geom size
          if (node.geoms && node.geoms.length > 0) {
            const w = node.width || 2.0;
            const h = node.height || 0.5;
            const L = Math.sqrt(w * w + h * h);
            const d = node.depth || 1.0;
            node.geoms[0].size = [L / 2, d / 2, 0.025];
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },
  
  updatePyramidParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.width !== undefined) node.width = params.width;
          if (params.depth !== undefined) node.depth = params.depth;
          if (params.height !== undefined) node.height = params.height;
          
          if (node.geoms && node.geoms.length > 0) {
            const w = node.width || 0.5;
            const d = node.depth || 0.5;
            const h = node.height || 0.5;
            const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateConeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.radius !== undefined) node.radius = params.radius;
          if (params.height !== undefined) node.height = params.height;
          
          if (node.geoms && node.geoms.length > 0) {
            const r = node.radius || 0.3;
            const h = node.height || 0.6;
            const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateTorusParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.majorRadius !== undefined) node.majorRadius = params.majorRadius;
          if (params.tubeRadius !== undefined) node.tubeRadius = params.tubeRadius;
          
          if (node.geoms && node.geoms.length > 0) {
            const R = node.majorRadius || 0.4;
            const r = node.tubeRadius || 0.1;
            const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateTubeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.innerRadius !== undefined) node.innerRadius = params.innerRadius;
          if (params.outerRadius !== undefined) node.outerRadius = params.outerRadius;
          if (params.height !== undefined) node.height = params.height;
          
          if (node.geoms && node.geoms.length > 0) {
            const r1 = node.innerRadius || 0.2;
            const r2 = node.outerRadius || 0.3;
            const h = node.height || 0.5;
            const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateCurveParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.points !== undefined) node.curvePoints = params.points.map((p: number[]) => [...p]);
          if (params.width !== undefined) node.curveWidth = params.width;
          if (params.thickness !== undefined) node.curveThickness = params.thickness;
          if (params.segments !== undefined) node.curveSegments = Math.round(params.segments);
          if (params.closed !== undefined) node.curveClosed = params.closed;
          if (params.bank !== undefined) node.curveBank = params.bank;

          const rgba = node.geoms?.[0]?.rgba || [0.85, 0.45, 0.15, 1];
          node.geoms = generateCurveGeoms(
            node.id,
            node.curvePoints || DEFAULT_CURVE_POINTS,
            node.curveWidth || DEFAULT_CURVE_WIDTH,
            node.curveThickness || DEFAULT_CURVE_THICKNESS,
            node.curveSegments || DEFAULT_CURVE_SEGMENTS,
            rgba,
            node.curveClosed === true,
            node.curveBank || 0
          );
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updatePulleyParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.leftTargetId !== undefined) node.leftTargetId = params.leftTargetId;
          if (params.rightTargetId !== undefined) node.rightTargetId = params.rightTargetId;
          if (params.pulleyRadius !== undefined) {
            node.pulleyRadius = params.pulleyRadius;
            if (node.geoms && node.geoms.length === 3) {
              node.geoms[0].size[0] = params.pulleyRadius * 0.8;
              node.geoms[1].size[0] = params.pulleyRadius;
              node.geoms[2].size[0] = params.pulleyRadius;
            } else if (node.geoms && node.geoms.length > 0) {
              node.geoms[0].size[0] = params.pulleyRadius;
            }
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateRopeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.pulleyWheelId !== undefined) node.pulleyWheelId = params.pulleyWheelId;
          if (params.leftTargetId !== undefined) node.leftTargetId = params.leftTargetId;
          if (params.rightTargetId !== undefined) node.rightTargetId = params.rightTargetId;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene, get().selectedNodeId);
  },

  updateNodeComposite: (id, params) => {
    get().recordInteraction('node-composite');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const findAndMutate = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const n of nodes) {
        if (n.id === id) {
          Object.assign(n, params);
          return true;
        }
        if (n.children && findAndMutate(n.children)) return true;
      }
      return false;
    };
    findAndMutate(newScene.nodes);
    get().recompile(newScene, id, false, true);
  },
  
  updateScene: (newScene, skipRecompile) => {
    get().prepareForDiscreteChange();
    set({ sceneGraph: newScene });
    if (!skipRecompile) {
      get().recompile(newScene);
    }
  },
  
  renameNode: (id, newName) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.name = newName;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene);
  },
  
  updateNodePos: (id, newPos) => {
    get().recordInteraction('node-pos');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id) {
          if (isAllMeshNode(node)) {
            // Mesh vertices are baked in world space — translate them directly
            const [ox, oy, oz] = node.pos as number[];
            const dx = newPos[0] - ox, dy = newPos[1] - oy, dz = newPos[2] - oz;
            translateMeshGeoms(node, dx, dy, dz);
            for (const g of node.geoms) {
              if (g.baseVertices) {
                g.baseVertices = mapVerts([...g.baseVertices], (x, y, z) => [x + dx, y + dy, z + dz]);
              }
            }
          }
          node.pos = newPos;
          node.basePos = [...newPos];
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, false);
  },

  updateNodeRotation: (id, axis, deg, rotateAroundCOMOverride) => {
    get().recordInteraction('node-rotation');
    const rotateAroundCOM = rotateAroundCOMOverride ?? get().rotateAroundCOM ?? true;
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          const currentEuler = node.euler ? [...node.euler] : [0, 0, 0];
          currentEuler[axis] = deg;
          node.euler = currentEuler as [number, number, number];
          delete node.quat;

          const stickyEuler = currentEuler.map(a => getStickyRotation(a)) as [number, number, number];

          if (isAllMeshNode(node)) {
            rotateMeshGeomsAbsolute(node, stickyEuler, rotateAroundCOM);
          } else {
            if (!node.basePos && node.pos) {
              node.basePos = [...node.pos];
            }
            if (!rotateAroundCOM && node.basePos) {
              const radX = (stickyEuler[0] * Math.PI) / 180;
              const radY = (stickyEuler[1] * Math.PI) / 180;
              const radZ = (stickyEuler[2] * Math.PI) / 180;
              const matX = new THREE.Matrix4().makeRotationX(radX);
              const matY = new THREE.Matrix4().makeRotationY(radY);
              const matZ = new THREE.Matrix4().makeRotationZ(radZ);
              const rotMat = new THREE.Matrix4().multiplyMatrices(matZ, new THREE.Matrix4().multiplyMatrices(matY, matX));
              const v = new THREE.Vector3(node.basePos[0], node.basePos[1], node.basePos[2]).applyMatrix4(rotMat);
              node.pos = [v.x, v.y, v.z];
            } else if (rotateAroundCOM && node.basePos) {
              node.pos = [...node.basePos];
            }
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      get().recompile(newScene, undefined, true);
    }
  },

  updateNodeGeom: (id, updates, geomIndex) => {
    get().recordInteraction('node-geom');
    /*
     * Whether this edit changes the shape, or only how it behaves on contact.
     *
     * `recompile`'s third argument does two things: it skips the 50ms debounce,
     * and it rebuilds without carrying the simulation state over. Both are right
     * for a change of geometry — the old state may not even be valid against the
     * new model. Both are wrong for a material property: dragging the contact
     * stiffness slider rebuilt MuJoCo on every pixel of travel and threw the
     * world back to its start each time, which is what made those sliders feel
     * like they were fighting the mouse.
     */
    const STRUCTURAL = ['size', 'vertices', 'faces', 'renderVertices', 'type', 'pos', 'euler', 'quat', 'csg'] as const;
    const structural = STRUCTURAL.some(k => (updates as Record<string, unknown>)[k] !== undefined);
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id && node.geoms?.length > 0) {
          if (id.includes('gear')) {
            const centerGeom = node.geoms[0];
            const currentRadius = centerGeom.size[0];
            const currentTeeth = node.geoms.length - 1;
            const currentColor = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
            const currentContype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
            const currentConaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
            
            let newRadius = currentRadius;
            if (updates.size && Array.isArray(updates.size)) {
              newRadius = updates.size[0];
            }
            
            let newColor = currentColor;
            if (updates.rgba) {
              newColor = updates.rgba;
            }

            let newContype = currentContype;
            if (updates.contype !== undefined) {
              newContype = updates.contype;
            }

            let newConaffinity = currentConaffinity;
            if (updates.conaffinity !== undefined) {
              newConaffinity = updates.conaffinity;
            }
            
            const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
            const isSecondGear = gearNum % 2 === 0;
            
            node.geoms = generateGearGeoms(id, newRadius, currentTeeth, newColor, isSecondGear, newContype, newConaffinity);
          } else {
            let targetGeom = node.geoms[0];
            if (geomIndex !== undefined && geomIndex >= 0 && geomIndex < node.geoms.length) {
              targetGeom = node.geoms[geomIndex];
            } else {
              const mainGeom = node.geoms.find((g: SceneGeom) => g.type === 'sphere' || g.type === 'box' || g.type === 'cylinder');
              if (mainGeom) {
                targetGeom = mainGeom;
              }
            }
            if (updates.fromto && targetGeom.fromto) {
              const oldFromto = targetGeom.fromto;
              const newFromto = updates.fromto;
              const oldLen = Math.sqrt((oldFromto[3]-oldFromto[0])**2 + (oldFromto[4]-oldFromto[1])**2 + (oldFromto[5]-oldFromto[2])**2) || 1.0;
              const newLen = Math.sqrt((newFromto[3]-newFromto[0])**2 + (newFromto[4]-newFromto[1])**2 + (newFromto[5]-newFromto[2])**2) || 1.0;
              const ratio = newLen / oldLen;
              if (node.children) {
                node.children.forEach((child: SceneNode) => {
                  child.pos = [child.pos[0] * ratio, child.pos[1] * ratio, child.pos[2] * ratio];
                });
              }
            }
            Object.assign(targetGeom, updates);
            /*
              A cut is stated as a face and a depth, so resizing or moving the
              shape it cuts into has to move the cut with it — a hole 10 mm into
              the top of a block is still 10 mm into the top when the block gets
              taller. Only geoms carrying that intent are touched; a negative
              placed by hand keeps its own numbers. See reconcileCuts.
            */
            if (structural) reconcileCuts(node);
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, structural);
  },

  updateGearTeeth: (id, teeth) => {
    get().recordInteraction('gear-teeth');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id && node.geoms?.length > 0) {
          const centerGeom = node.geoms[0];
          const radius = centerGeom.size[0];
          const color = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
          const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
          const isSecondGear = gearNum % 2 === 0;
          const contype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
          const conaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
          
          node.geoms = generateGearGeoms(id, radius, teeth, color, isSecondGear, contype, conaffinity);
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, id);
    }
  },

  addPusherPeg: (gearId) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === gearId && node.geoms?.length > 0) {
          const hasPeg = node.geoms.some((g: SceneGeom) => g.name.includes('peg'));
          if (!hasPeg) {
            const radius = node.geoms[0].size[0];
            node.geoms.push({
              name: `${gearId}_pusher_peg`,
              type: 'cylinder',
              size: [0.03, 0.08], // radius, half-height
              pos: [radius * 0.8, 0, 0.09], // relative offset
              rgba: [0.9, 0.2, 0.2, 1], // red color
              mass: 0.05,
              condim: 3
            });
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, gearId);
    }
  },

  deletePusherPeg: (gearId) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === gearId && node.geoms?.length > 1) {
          node.geoms = node.geoms.filter((g: SceneGeom) => !g.name.includes('peg'));
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, gearId);
    }
  },

  updatePusherPeg: (gearId, updates) => {
    get().recordInteraction('pusher-peg');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === gearId && node.geoms?.length > 1) {
          const peg = node.geoms.find((g: SceneGeom) => g.name.includes('peg'));
          if (peg) {
            if (updates.offset !== undefined) {
              peg.pos = [updates.offset, 0, peg.pos[2]];
            }
            if (updates.size !== undefined) {
              peg.size = updates.size; // [radius, half_height]
              peg.pos = [peg.pos[0], 0, updates.size[1] + 0.01]; // adjust Z pos dynamically so bottom touches the disc
            }
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, gearId);
    }
  },

  updateNodeJoint: (id, updates) => {
    get().recordInteraction('node-joint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id && node.joints?.length > 0) {
          Object.assign(node.joints[0], updates);
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile();
  },

  updateNodeScript: (id, script) => {
    get().recordInteraction('node-script');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.script = script;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    // Note: Live updates do not force model recompiles to support hot-editing of
    // control gains! The worker keeps its own copy of the scene for script
    // execution, so it needs telling directly rather than via a recompile.
    getPhysicsWorkerClient().updateScript(id, script);
  },

  updateNodeScad: (id, scad, compiledData, skipRecompile) => {
    get().recordInteraction('node-scad');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id || node.name === id) {
          node.scad = scad;
          if (!node.geoms) {
            node.geoms = [];
          }
          let meshGeom = node.geoms.find((g: SceneGeom) => g.type === 'mesh');
          if (!meshGeom && node.geoms.length > 0) {
            meshGeom = node.geoms[0];
          }
          if (!meshGeom) {
            meshGeom = {
              id: `geom_${Math.random().toString(36).substring(2, 8)}`,
              name: `${node.name || id}_mesh`,
              type: 'mesh',
              dynamic: true,
              rgba: [0.3, 0.6, 0.9, 1],
              mass: 1
            };
            node.geoms.push(meshGeom);
          }
          meshGeom.type = 'mesh';
          meshGeom.dynamic = true;
          meshGeom.vertices = compiledData.vertices;
          meshGeom.faces = compiledData.faces;
          meshGeom.renderVertices = compiledData.renderVertices;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Bulk callers (e.g. compiling several scad bodies in sequence) pass
      // skipRecompile: firing a recompile per node here creates overlapping,
      // unawaited MJCF/WASM builds that race - a stale one (compiled before a
      // later node's mesh existed) can finish last and silently overwrite the
      // correct final state. Bulk callers run a single recompile after all
      // nodes are updated instead.
      if (!skipRecompile) {
        get().recompile(newScene, id, true);
      }
    }
  },

  // --- CSG (boolean modifiers) ---------------------------------------------
  // A negative geom is an ordinary primitive with csg:'difference' — it's the
  // node's csgEnabled flag plus that marker that turn the body into a boolean.
  // Shapes get onto a body the ordinary ways (drag-in, presets, MCP); flipping
  // one to 'difference' is what makes it a hole.
  deleteNodeGeom: (nodeId, geomIndex) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node || !node.geoms || geomIndex < 0 || geomIndex >= node.geoms.length) return;
    node.geoms = node.geoms.filter((_: SceneGeom, i: number) => i !== geomIndex);
    // Losing the last boolean operator leaves an ordinary compound body; drop
    // the derived mesh with it so the primitives come back into view.
    if (node.csgEnabled && !node.geoms.some((g: SceneGeom) => !g.csgDerived && (g.csg === 'difference' || g.csg === 'intersection'))) {
      node.geoms = node.geoms.filter((g: SceneGeom) => !g.csgDerived);
      node.csgEnabled = false;
      delete node.csgHash;
    }
    set({ sceneGraph: newScene });
    get().recompile(newScene, nodeId, false);
  },

  insetNodeGeoms: (nodeId, factor) => {
    const target = findNode(get().sceneGraph.nodes, nodeId);
    if (!target || insetNegatives(target, factor).length === 0) return;
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    const copies = insetNegatives(node, factor);
    if (copies.length === 0) return;

    node.geoms = [...node.geoms, ...copies];
    node.csgEnabled = true;
    if (node.csgCollision === undefined) node.csgCollision = 'auto';
    if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;

    set({ sceneGraph: newScene });
    get().recompile(newScene, nodeId, false);
  },

  setGeomCsgOp: (nodeId, geomIndex, csg) => {
    get().recordInteraction('geom-csg-op');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.[geomIndex]) return;
    // There has to be something left to cut into. Subtracting a body's only
    // shape would leave it with no positive geometry at all: nothing to render,
    // nothing to collide, and a MuJoCo body with no geoms. Refuse instead.
    if (csg !== 'union') {
      const positivesLeft = node.geoms.filter((g: SceneGeom, i: number) =>
        !g.csgDerived && i !== geomIndex && (!g.csg || g.csg === 'union')).length;
      if (positivesLeft === 0) return;
    }
    node.geoms[geomIndex].csg = csg;
    const hasOps = node.geoms.some((g: SceneGeom) => !g.csgDerived && (g.csg === 'difference' || g.csg === 'intersection'));
    node.csgEnabled = hasOps;
    if (hasOps) {
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
    } else {
      // Back to an ordinary compound body — the stale boolean mesh would
      // otherwise keep drawing over the primitives.
      node.geoms = node.geoms.filter((g: SceneGeom) => !g.csgDerived);
      delete node.csgHash;
    }
    set({ sceneGraph: newScene });
    get().recompile(newScene, nodeId, false);
  },

  // Installs the output of evaluateNodeCsg: derived geoms replace the previous
  // ones wholesale, source primitives are untouched.
  applyNodeCsg: (nodeId, result, skipRecompile) => {
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    const source = (node.geoms || []).filter((g: SceneGeom) => !g.csgDerived);
    node.geoms = [...source, ...result.geoms];
    node.csgHash = result.hash;
    // Summarized, not stored whole: a lattice mesh operand is megabytes of
    // polyhedron literal, and this field is shown, undone and saved.
    node.csgScad = scadForDisplay(result.scad);
    node.csgVolume = result.volume;
    node.csgHullVolume = result.hullVolume;
    node.csgCentroid = result.centroid;
    node.csgCollision = node.csgCollision ?? 'auto';
    if (result.warning) node.csgWarning = result.warning; else delete node.csgWarning;
    delete node.csgError;
    set({ sceneGraph: newScene });
    // Bulk callers recompile once at the end — see the same note on updateNodeScad.
    if (!skipRecompile) get().recompile(newScene, undefined, false);
  },

  setNodeCsgError: (nodeId, error, hash) => {
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    if (error) node.csgError = error; else delete node.csgError;
    // Record the hash that failed so the auto-compiler doesn't retry the same
    // broken shape on every store update — only a real edit re-arms it.
    if (error && hash) node.csgHash = hash;
    set({ sceneGraph: newScene });
  },

  updateNode: (id, updates) => {
    get().recordInteraction('node');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) {
          Object.assign(node, updates);
          // Same trap as updateNodeJointsList: an update that hands this node
          // its first joint (e.g. an MCP physics_update_object call, not just
          // the properties panel) needs its mesh geoms promoted too, or the
          // body simulates and drags correctly while its render stays frozen.
          if (updates.joints !== undefined && node.joints?.length > 0) {
            promoteMeshGeomsToDynamic(node);
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Recompile so aerodynamics flag propagates to physics loop
      get().recompile(newScene, undefined, false);
    }
  },

  updateNodeJointsList: (id, joints) => {
    get().recordInteraction('node-joints-list');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.joints = joints;
          if (joints.length > 0) promoteMeshGeomsToDynamic(node);
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, id);
    }
  },

  deleteNode: (id) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverseAndRemove = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === id) {
          nodes.splice(i, 1);
          return true;
        }
        if (traverseAndRemove(nodes[i].children)) return true;
      }
      return false;
    };
    if (traverseAndRemove(newScene.nodes)) {
      set({ sceneGraph: newScene, selectedNodeId: null });
      get().recompile(newScene, null);
    }
  },

  addComponent: (type, position) => {
    get().prepareForDiscreteChange();
    const { sceneGraph, selectedNodeId, parentUnderSelected } = get();
    const newScene = cloneSceneGraph(sceneGraph);
    
    // 8-character random unique suffix (no millisecond timestamp)
    const id = `${type}_${Math.random().toString(36).substring(2, 10)}`;
    
    // Determine target local position
    let localPos: [number, number, number] = [position[0], position[1], position[2]];
    
    const isChild = !!(selectedNodeId && parentUnderSelected);
    
    if (isChild && selectedNodeId) {
      // Find parent world position to make drop coordinates relative to parent!
      const parentWorldPos = getNodeWorldPos(newScene.nodes, selectedNodeId);
      if (parentWorldPos) {
        localPos = [
          position[0] - parentWorldPos[0],
          position[1] - parentWorldPos[1],
          position[2] - parentWorldPos[2]
        ];
      }
    }

    let geomType: GeomType = type as GeomType;
    let size: number[] = [0.2];
    let rgba = [0.5, 0.5, 0.5, 1];
    let mass = 1;
    let joints: SceneJoint[] = [];
    let geoms: SceneGeom[] = [];
    
    const isChildJoint = isChild;
    
    if (type === 'gear') {
      const radius = 0.1;
      const teeth = 12;
      const color = [0.5, 0.5, 0.5, 1];
      geoms = generateGearGeoms(id, radius, teeth, color, false);
      joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1], damping: 0.5 }];
    } else if (type === 'pulley_wheel') {
      const r = 0.08;
      const thickness = 0.04;
      const spindle_r = r * 0.8;
      const spindle_h = thickness / 2 - 0.005;
      const flange_h = 0.005;
      
      geoms = [
        { name: `${id}_spindle`, type: 'cylinder', size: [spindle_r, spindle_h], pos: [0, 0, 0], euler: [90, 0, 0], rgba: [0.3, 0.4, 0.6, 1], mass: 0.5 },
        { name: `${id}_flange_l`, type: 'cylinder', size: [r, flange_h], pos: [0, -spindle_h - flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 },
        { name: `${id}_flange_r`, type: 'cylinder', size: [r, flange_h], pos: [0, spindle_h + flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 }
      ];
      joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.2 }];
    } else if (type === 'pulley_rope') {
      geoms = [];
      joints = [];
    } else if (type === 'curve') {
      // Rigid curved track: spline through control points, decomposed into
      // convex box segments so collision follows the real curve.
      geoms = generateCurveGeoms(id, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS);
      joints = []; // static — welded to world like the wedge
      localPos = [localPos[0], localPos[1], 0]; // tracks sit on the ground, not in the air
    } else {
      if (type === 'box') {
        geomType = 'box';
        size = [0.05, 0.05, 0.05];
        rgba = [0.8, 0.2, 0.2, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'sphere') {
        geomType = 'sphere';
        size = [0.05];
        rgba = [0.2, 0.8, 0.2, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'capsule') {
        geomType = 'capsule';
        size = [0.02, 0.15];
        rgba = [0.6, 0.6, 0.6, 1];
        // Standalone poles are free bodies and fall like any other shape; only
        // when nested under a parent does a hinge (pendulum rod) make sense.
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'cylinder') {
        geomType = 'cylinder';
        size = [0.05, 0.04];
        rgba = [0.9, 0.6, 0.1, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'bob') {
        geomType = 'sphere';
        size = [0.06];
        rgba = [0.2, 0.6, 1.0, 1];
        mass = 10.0;
        joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }];
      } else if (type === 'wedge') {
        geomType = 'box';
        size = [0.2, 0.1, 0.08];
        rgba = [0.8, 0.5, 0.2, 1];
        // A wedge is a solid object, not a fixture: it falls and can be tipped
        // over like anything else. Set the joint to Fixed to weld it in place.
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'mesh') {
        // Dynamic icosahedron: radius 0.3, centred at body origin.
        // body pos = localPos handles spawn placement.
        // vertices: Y-up centred at (0,0,0) for the Three.js static render path fallback.
        // renderVertices: Z-up centred at (0,0,0) — icosahedron centroid is exactly (0,0,0).
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.5, 0.7, 0.9, 1],
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices: [-0.1577,0.2552,0,0.1577,0.2552,0,-0.1577,-0.2552,0,0.1577,-0.2552,0,0,-0.1577,0.2552,0,0.1577,0.2552,0,-0.1577,-0.2552,0,0.1577,-0.2552,0.2552,0,-0.1577,0.2552,0,0.1577,-0.2552,0,-0.1577,-0.2552,0,0.1577],
          // renderVertices: raw Z-up (Y↔Z swap only: Y-up (x,y,z)→(x,-z,y)), no centroid subtraction
          renderVertices: [-0.1577,0,0.2552,0.1577,0,0.2552,-0.1577,0,-0.2552,0.1577,0,-0.2552,0,-0.2552,-0.1577,0,-0.2552,0.1577,0,0.2552,-0.1577,0,0.2552,0.1577,0.2552,0.1577,0,0.2552,-0.1577,0,-0.2552,0.1577,0,-0.2552,-0.1577,0],
          faces: [0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1],
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'openscad') {
        // Default cube shape, will compile into a custom CSG mesh on render/edit
        geoms = [{
          name: `${id}_geom`,
          type: 'mesh',
          size: [1],
          rgba: [0.3, 0.6, 0.9, 1], // beautiful blue
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices: [
            -0.25, -0.25, -0.25,
             0.25, -0.25, -0.25,
             0.25,  0.25, -0.25,
            -0.25,  0.25, -0.25,
            -0.25, -0.25,  0.25,
             0.25, -0.25,  0.25,
             0.25,  0.25,  0.25,
            -0.25,  0.25,  0.25
          ],
          renderVertices: [
            -0.25,  0.25, -0.25,
             0.25,  0.25, -0.25,
             0.25,  0.25,  0.25,
            -0.25,  0.25,  0.25,
            -0.25, -0.25, -0.25,
             0.25, -0.25, -0.25,
             0.25, -0.25,  0.25,
            -0.25, -0.25,  0.25
          ],
          faces: [
            0, 2, 1,  0, 3, 2,
            4, 5, 6,  4, 6, 7,
            0, 1, 5,  0, 5, 4,
            1, 2, 6,  1, 6, 5,
            2, 3, 7,  2, 7, 6,
            3, 0, 4,  3, 4, 7
          ]
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'pyramid') {
        const w = 0.2;
        const d = 0.2;
        const h = 0.2;
        const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.85, 0.35, 0.15, 1], // reddish orange
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'cone') {
        const r = 0.1;
        const h = 0.2;
        const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.15, 0.65, 0.85, 1], // cyan blue
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'torus') {
        const R = 0.15;
        const r = 0.04;
        const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.55, 0.35, 0.85, 1], // purple
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'tube') {
        const r1 = 0.06;
        const r2 = 0.1;
        const h = 0.15;
        const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.35, 0.75, 0.35, 1], // green
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'ellipsoid') {
        geomType = 'ellipsoid';
        size = [0.12, 0.08, 0.06];
        rgba = [0.85, 0.55, 0.15, 1]; // yellow/orange
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'sculpt') {
        // A ball of clay: a subdivided icosahedron, uniform enough all over
        // that the first stroke lands the same wherever it is put. Detail is
        // added by the brush as it goes (see utils/sculptMesh.ts), so the base
        // is deliberately coarse — starting dense would only make every stroke
        // slower without making any of them finer.
        const { vertices, renderVertices, faces } = toSceneGeom(buildSculptBase(DEFAULT_SCULPT_BASE));
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.82, 0.72, 0.62, 1], // unfired clay
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices,
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'lattice') {
        // A box on the grid, not a ball of clay: the mode is about placing
        // points exactly, and the first move is nearly always to push a face
        // out. See utils/latticeMesh.ts.
        const cage = serializeCage(boxLattice(LATTICE_UNIT, 200));
        const { vertices, renderVertices, faces } = latticeToSceneGeom(deserializeCage(cage), 0);
        // Centred on the origin already, so the offset it starts with is zero —
        // but it is written down rather than assumed, because applyLattice
        // applies the CHANGE in offset and needs somewhere to start from.
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.55, 0.68, 0.85, 1], // drafting blue, to read as constructed
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices,
          // The cage's own geom, named as such from the start — a body that
          // later carries a cut has more than one mesh on it. See applyLattice.
          latticeGeom: true,
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'ring') {
        // The canonical boolean: a flattened ellipsoid with a slimmer ellipsoid
        // punched through it along Z. The negative is only a little taller than
        // the disc: it has to pierce right through (a flush cut leaves coincident
        // faces), but overshooting by multiples just makes a big outline in the
        // editor for no benefit. Nothing here is special-cased downstream —
        // it's just two ordinary primitives and a csg marker, so every slider in
        // the panel reshapes it and the mesh is regenerated from scratch.
        geoms = [
          { name: `${id}_body`, type: 'ellipsoid', size: [0.12, 0.12, 0.04], mass: 1, rgba: [0.85, 0.65, 0.2, 1], condim: 3 },
          { name: `${id}_hole`, type: 'ellipsoid', size: [0.06, 0.06, 0.07], csg: 'difference', pos: [0, 0, 0], rgba: [0.9, 0.25, 0.35, 1] },
        ];
        joints = [{ name: `${id}_free`, type: 'free' }];
      }
      if (type !== 'mesh' && type !== 'openscad' && type !== 'pyramid' && type !== 'cone' && type !== 'torus' && type !== 'tube' && type !== 'ring' && type !== 'sculpt' && type !== 'lattice') {
        geoms = [{ name: `${id}_geom`, type: geomType, size, mass, rgba }];
      }
    }

    const newNode: SceneNode = {
      id, name: id, type: 'body', pos: localPos,
      joints,
      geoms,
      children: [],
      ...(type === 'wedge' ? {
        isWedge: true,
        width: 2.0,
        depth: 1.0,
        height: 0.5,
        wedgeAngle: 14.036
      } : {}),
      ...(type === 'pyramid' ? {
        isPyramid: true,
        // These must match the mesh built above. They are what the properties
        // panel shows and what a slider regenerates from, so a disagreement
        // makes the shape jump the first time one is touched — and a shape that
        // grows while its body stays put ends up inside the floor, which MuJoCo
        // resolves by ejecting it through.
        width: 0.2,
        depth: 0.2,
        height: 0.2
      } : {}),
      ...(type === 'cone' ? {
        isCone: true,
        radius: 0.1,
        height: 0.2
      } : {}),
      ...(type === 'torus' ? {
        isTorus: true,
        majorRadius: 0.15,
        tubeRadius: 0.04
      } : {}),
      ...(type === 'tube' ? {
        isTube: true,
        innerRadius: 0.06,
        outerRadius: 0.1,
        height: 0.15
      } : {}),
      ...(type === 'pulley_wheel' ? {
        isPulleyWheel: true,
        // Must match the flange geoms above (r = 0.08). It was 0.4, so a
        // dragged-in wheel drew its rope on a 0.4m rim around an 0.08m wheel
        // and coupled the rope kinematics to the wrong radius.
        pulleyRadius: 0.08
      } : {}),
      ...(type === 'pulley_rope' ? {
        isPulleyRope: true,
        pulleyWheelId: '',
        leftTargetId: '',
        rightTargetId: ''
      } : {}),
      ...(type === 'openscad' ? {
        scad: `// Example OpenSCAD Code\ndifference() {\n  cube([0.5, 0.5, 0.5], center=true);\n  sphere(d=0.6, $fn=16);\n}`
      } : {}),
      ...(type === 'ring' ? {
        csgEnabled: true,
        csgCollision: 'auto' as const,
        csgSectors: CSG_DEFAULT_SECTORS,
        csgMass: 1,
      } : {}),
      ...(type === 'sculpt' ? {
        isSculpt: true,
        sculptBase: DEFAULT_SCULPT_BASE,
        sculptVersion: 1,
      } : {}),
      ...(type === 'lattice' ? {
        isLattice: true,
        latticeCage: serializeCage(boxLattice(LATTICE_UNIT, 200)),
        latticeSubdiv: 0,
        latticeVersion: 1,
        latticeOrigin: [0, 0, 0],
      } : {}),
      ...(type === 'curve' ? {
        isCurve: true,
        curvePoints: DEFAULT_CURVE_POINTS.map(p => [...p]),
        curveWidth: DEFAULT_CURVE_WIDTH,
        curveThickness: DEFAULT_CURVE_THICKNESS,
        curveSegments: DEFAULT_CURVE_SEGMENTS
      } : {}),
    };

    if (isChild && selectedNodeId) {
      addChildNode(newScene.nodes, selectedNodeId, newNode);
    } else {
      newScene.nodes.push(newNode);
    }
    
    const selectId = typeof window !== 'undefined' && (window as PhysicsWindow).NO_SELECT ? null : id;
    get().recompile(newScene, selectId);
  },
  
  recompile: async (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean) => {
    /*
     * We only debounce if it's NOT a force reset (which is used by presets/loaders).
     *
     * Superseding a pending recompile used to clear its timer and nothing else,
     * so the `await` inside it was left holding a promise that could never
     * settle: every caller that awaited a debounced recompile which a later one
     * overtook simply hung, forever. Nothing noticed while the callers were
     * fire-and-forget UI handlers, but an MCP command that awaits its own
     * recompile before replying just stops responding.
     *
     * So the superseded call is woken and returns without building — the newer
     * one is about to build the newer scene, and two builds of the same state is
     * the other thing we do not want.
     */
    const token = ++recompileToken;
    // Counted from the CALL, not from the build: the debounce below is fifty
    // milliseconds, and the undo snapshot is offered for flushing on the very
    // next tick. Counting any later and the snapshot is gone before the change
    // it belongs to has even started compiling.
    recompilesInFlight++;
    let counted = true;
    const done = () => { if (counted) { counted = false; recompilesInFlight = Math.max(0, recompilesInFlight - 1); } };
    if (!forceReset) {
      if ((window as PhysicsWindow)._recompileTimeoutId) {
        clearTimeout((window as PhysicsWindow)._recompileTimeoutId);
        (window as PhysicsWindow)._recompileWake?.();
      }
      await new Promise<void>(resolve => {
        (window as PhysicsWindow)._recompileWake = resolve;
        (window as PhysicsWindow)._recompileTimeoutId = setTimeout(resolve, 50);
      });
      (window as PhysicsWindow)._recompileWake = null;
      if (token !== recompileToken) { done(); return; }
    }

    if (typeof window !== 'undefined') {
      (window as PhysicsWindow).DISABLE_USEFRAME = false;
    }
    const { gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    const sceneGraph = overrideScene ?? get().sceneGraph;

    /*
     * What the store held when this build started.
     *
     * The scene is written back below on the next animation frame, from the
     * snapshot this build was given — so any edit made while the build was in
     * flight was thrown away when it landed. Renaming a body immediately after
     * adding one did exactly that: the rename applied, the add's build finished
     * a frame later, and the old name came back with no error anywhere.
     *
     * A build is authoritative about the model it produced, not about every
     * other field of a node, so if the scene has moved on underneath us we keep
     * the newer one and install only the compiled model.
     */
    const graphAtBuildStart = get().sceneGraph;

    const applyBuilt = (built: BuiltResult) => {
      console.log(`[PhysicsWorker] Model built successfully. Shared memory (COOP/COEP) active: ${!!built.isShared}`);
      const updates: Partial<PhysicsState> = {
        mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built),
        sceneGraph, recompileId: Date.now(), lastCompileError: null, isLoaded: true,
      };
      if (overrideSelectedId !== undefined) updates.selectedNodeId = overrideSelectedId;
      requestAnimationFrame(() => {
        if (get().sceneGraph !== graphAtBuildStart && get().sceneGraph !== sceneGraph) {
          delete updates.sceneGraph;
        }
        set(updates);
        done();
        // The scene has moved at last; this is the moment the snapshot taken
        // before it is worth keeping.
        get().flushPendingUndo();
      });
    };

    try {
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
      if (typeof window !== 'undefined') {
        (window as PhysicsWindow).compiledXML = xml;
      }

      // Proactively recycle before the ceiling is ever reached, rather than
      // only reacting to a hard failure — see RECYCLE_EVERY_N_BUILDS comment.
      buildsSinceRecycle++;
      if (buildsSinceRecycle > RECYCLE_EVERY_N_BUILDS) {
        console.warn(`Proactively recycling the physics worker after ${RECYCLE_EVERY_N_BUILDS} builds to stay well clear of the WASM heap ceiling.`);
        recycleWorker();
        buildsSinceRecycle = 1;
      }

      const client = getPhysicsWorkerClient();
      client.setEnv(windX, windY);
      const built = await client.build(xml, sceneGraph, !forceReset);
      if (!built.ok) {
        throw new Error(built.error || 'Unknown physics worker build error');
      }
      applyBuilt(built);
    } catch (e) {
      console.error("Failed to compile MJCF:", e);
      const msg = String(e instanceof Error ? e.message : e);
      if (/Aborted|enlarge memory|abort|bad_alloc/i.test(msg)) {
        // The WASM module's linear memory only ever grows across a session, and
        // the @mujoco/mujoco build has a hard 2^31-byte ceiling it can never
        // exceed. Reinstantiating a module in the SAME worker/realm isn't
        // guaranteed to actually return that memory to the OS, so recover by
        // terminating the whole worker (a separate JS realm) and spawning a
        // fresh one — a real reclaim — then rebuilding the same scene against
        // it. Only reload the page if that also fails.
        try {
          console.warn('MuJoCo WASM heap exhausted — terminating and respawning the physics worker (keeping scene/camera).');
          recycleWorker();
          const freshClient = getPhysicsWorkerClient();
          freshClient.setEnv(windX, windY);
          const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
          const built = await freshClient.build(xml, sceneGraph, false);
          if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error', { cause: e });
          applyBuilt(built);
          return;
        } catch (recoveryError) {
          console.error('Worker respawn recovery failed, falling back to full page reload:', recoveryError);
          alert('The physics engine ran out of memory and could not recover, even after restarting the physics worker.\n\nThe page will reload to free memory — your scene will be lost unless you saved it first.');
          window.location.reload();
          done();
          return;
        }
      }
      // Still update the sceneGraph so the UI reflects the change even if MuJoCo rejects it
      const updates: Partial<PhysicsState> = { sceneGraph, lastCompileError: msg };
      if (overrideSelectedId !== undefined) updates.selectedNodeId = overrideSelectedId;
      set(updates);
      done();
      get().flushPendingUndo();
    }
  },

  recoverFromFatalWorkerError: async (message, lastState) => {
    // Mirrors recompile()'s memory-exhaustion recovery, but triggered from a
    // fatal error reported by the worker mid-simulation (not during a build):
    // terminate the exhausted worker (real memory reclaim) and rebuild the
    // current scene fresh, reseeding the last qpos/qvel/time the worker
    // reported right before it died (best-effort — if that report itself
    // failed to arrive, this falls back to the as-built initial pose).
    console.warn('Fatal physics worker error — terminating and respawning worker:', message);
    const wasPlaying = get().isPlaying;
    recycleWorker();
    set({ isPlaying: false });
    const { sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    try {
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
      const client = getPhysicsWorkerClient();
      client.setEnv(windX, windY);
      const built = await client.build(xml, sceneGraph, false, lastState);
      if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
      set({ mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built), recompileId: Date.now(), lastCompileError: null });
      if (wasPlaying) { client.setPlaying(true); set({ isPlaying: true }); }
    } catch (e) {
      console.error('Recovery rebuild after fatal worker error failed:', e);
    }
  },

  recycleWorkerSeamlessly: async () => {
    // Periodic proactive recycle while actively simulating: MuJoCo's own
    // internal contact/constraint memory can grow over the course of a long
    // play session — not just across explicit rebuilds — and, like
    // everything else in a WASM realm, never shrinks back down on its own.
    // Swap in a fresh worker before that ever becomes a problem, carrying
    // over the exact current qpos/qvel/time (from the live `data` mirror,
    // kept up to date by FRAME messages) so it's invisible rather than a
    // visible reset. See the periodic timer below this store definition.
    // isPlaying is deliberately read later via get(), not destructured here: the
    // await below means the snapshot could be stale by the time it's used.
    const { data, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    if (!data) return;
    // Never recycle on top of a request the worker hasn't answered yet: killing
    // the worker mid-build fails a rebuild that was about to succeed (and an
    // MCP command driving one would be told its scene didn't build). The
    // recycle is purely housekeeping — 20s later is just as good.
    if (getPhysicsWorkerClient().hasPendingWork()) return;
    const seedState = {
      qpos: Array.from(data.qpos as Float64Array),
      qvel: Array.from(data.qvel as Float64Array),
      ctrl: Array.from(data.ctrl as Float64Array),
      time: data.time as number,
    };
    recycleWorker();
    try {
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
      const client = getPhysicsWorkerClient();
      client.setEnv(windX, windY);
      const built = await client.build(xml, sceneGraph, false, seedState);
      if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
      set({ mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built), recompileId: Date.now(), lastCompileError: null });
      if (get().isPlaying) client.setPlaying(true);
    } catch (e) {
      console.error('Seamless proactive worker recycle failed:', e);
    }
  },
}));

if (typeof window !== 'undefined') {
  // Every 20s while actively playing, seamlessly recycle the physics worker
  // (see recycleWorkerSeamlessly above) — this is what actually addresses
  // memory growth from long-running simulation, as opposed to the
  // build-counter recycle in recompile() which only helps across rebuilds.
  setInterval(() => {
    if (useStore.getState().isPlaying) {
      useStore.getState().recycleWorkerSeamlessly();
    }
  }, 20000);
}
