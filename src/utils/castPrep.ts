/**
 * "Prepare for casting": the edge breaks and draft a pattern wants, put onto
 * every part in the scene at once, and taken off again.
 *
 * Two treatments, in this order:
 *
 *   - Edges. Outside edges are chamfered, because a sharp edge on a pattern
 *     leaves a knife-edge of sand that crumbles into the cavity; inside corners
 *     are filleted, because a sharp one is a hot spot the casting cracks at.
 *     They go on as ordinary parametric roundings (node.edgeRounds), so they
 *     stay editable in the Edges card. Sizes are picked per edge so that one
 *     short edge does not hold every other edge on the body down to its size.
 *
 *   - Draft (sand only). Every wall is tapered so the pattern draws from the
 *     ram: walls lean away from the parting plane by `deg`. There is no
 *     parametric form for that, so it is BAKED — each body's drawn shape, edges
 *     and all, becomes mesh geoms — and the shape fields it replaced are kept on
 *     `sceneGraph.castPrep.originals` so switching it off restores them.
 *
 * Everything here is pure: a scene in, a scene (or a plan) out. The async half —
 * finding edges and compiling roundings — is in castPrepRunner.ts.
 */
import * as THREE from 'three';
import type { CastPrep, EdgeRoundFeature, SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { resolveCsgGeoms } from './csg';
import { appendSolidTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { maxSizeFor, sameEdge, suggestedSize, type EdgeCandidate } from './featureEdges';

// ---------------------------------------------------------------------------
// The shape of a body, as prep sees it
// ---------------------------------------------------------------------------

/**
 * The node fields that make up a body's shape — what prep overwrites, so what it
 * keeps and puts back. The generator flags are in here too: a baked wedge that
 * still said it was a wedge would be regenerated from its parameters on the
 * next edit and lose its draft without anybody noticing.
 */
export const SHAPE_KEYS = [
  'geoms',
  'csgEnabled', 'csgCollision', 'csgHash', 'csgScad', 'csgVolume', 'csgHullVolume', 'csgCentroid', 'csgWarning', 'csgError',
  'edgeRounds', 'edgeRoundsLost',
  'collisionHash', 'collisionDecomposed', 'collisionSolidity', 'collisionWarning', 'collisionError',
  'scad', 'isWedge', 'isPyramid', 'isCone', 'isTorus', 'isTube', 'isCurve',
  'isSculpt', 'sculptBase', 'sculptVersion', 'sculptEdited',
  'isLattice', 'latticeCage', 'latticeSubdiv', 'latticeThickness', 'latticeOrigin', 'latticeVersion', 'latticeBaked', 'latticeEdited',
] as const satisfies readonly (keyof SceneNode)[];

/** A body's shape fields, copied deep enough that editing the node cannot reach them. */
export function snapshotShape(node: SceneNode): Partial<SceneNode> {
  const out: Record<string, unknown> = {};
  for (const k of SHAPE_KEYS) {
    if (node[k] === undefined) continue;
    // Vertex arrays are replaced wholesale, never edited in place (cloneGeom
    // relies on the same), so a shallow copy of each geom is enough.
    out[k] = k === 'geoms' ? (node.geoms || []).map((g) => ({ ...g })) : structuredClone(node[k]);
  }
  return out as Partial<SceneNode>;
}

/** Puts a snapshot back: every shape field the node has now goes, the saved ones return. */
export function restoreShape(node: SceneNode, shape: Partial<SceneNode>): void {
  const rec = node as unknown as Record<string, unknown>;
  for (const k of SHAPE_KEYS) delete rec[k];
  // A copy, because the snapshot lives on in the undo history's castPrep.
  Object.assign(node, snapshotShape(shape as SceneNode));
  if (!node.geoms) node.geoms = [];
}

/** A CastPrep whose entries can be edited without touching one shared with the undo history. */
export function copyPrep(prep: CastPrep): CastPrep {
  return {
    ...prep,
    originals: Object.fromEntries(Object.entries(prep.originals).map(([id, e]) => [id, { ...e }])),
    skipped: [...prep.skipped],
  };
}

/** FNV-1a over a run of numbers: enough to notice an edit, cheap on a big mesh. */
function hashNumbers(values: ArrayLike<number> | undefined, h = 0x811c9dc5): number {
  if (!values) return h;
  for (let i = 0; i < values.length; i++) {
    // Rounded to a micron so a float round-trip is not mistaken for an edit.
    const v = Math.round((values[i] || 0) * 1e6) | 0;
    h ^= v & 0xffff; h = Math.imul(h, 0x01000193);
    h ^= v >>> 16; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * What a body's shape is, as a string that changes when anybody edits it.
 *
 * Only AUTHORED geoms count. A boolean's generated mesh and colliders are
 * rewritten every time the compiler lands, and that is not an edit.
 */
export function shapeSignature(node: SceneNode): string {
  const geoms = (node.geoms || []).filter((g) => !g.csgDerived).map((g) => {
    const { vertices, faces, renderVertices, baseVertices: _bv, baseRenderVertices: _brv, paint: _p, ...rest } = g;
    return {
      ...rest,
      mesh: vertices || faces || renderVertices
        ? [vertices?.length ?? 0, faces?.length ?? 0, hashNumbers(renderVertices ?? vertices), hashNumbers(faces)]
        : undefined,
    };
  });
  return JSON.stringify({ geoms, edgeRounds: node.edgeRounds ?? null, scad: node.scad ?? null });
}

// ---------------------------------------------------------------------------
// Which bodies
// ---------------------------------------------------------------------------

/** Bodies that are never part of the casting, whatever they are made of. */
function notAPart(node: SceneNode): string | null {
  if (node.isHardwareComponent) return 'It is a bought-in component, not a cast part.';
  if (node.isPulleyRope) return 'A rope is not a cast part.';
  if (node.isComposite) return 'A cable, rope or cloth is not a cast part.';
  return null;
}

/** Every body in the tree, parents before children, with its world matrix. */
export function eachBody(scene: SceneGraph): { node: SceneNode; world: THREE.Matrix4 }[] {
  const out: { node: SceneNode; world: THREE.Matrix4 }[] = [];
  const walk = (list: SceneNode[], parent?: THREE.Matrix4) => {
    for (const node of list || []) {
      const world = getNodeWorldTransform(node, parent);
      out.push({ node, world });
      walk(node.children || [], world);
    }
  };
  walk(scene.nodes);
  return out;
}

/**
 * A visual-only geom someone put there — a label, trim — which is not cast.
 * NOT a boolean's generated mesh: that is marked visual too once colliders do
 * its colliding, and it is the very shape being cast.
 */
function isDecor(geom: SceneGeom): boolean {
  return geom.role === 'visual' && !geom.csgDerived;
}

/**
 * The triangles a body draws, in world space, one run per solid geom and each
 * wound outward. Empty for a body with nothing solid (the ground plane).
 */
export function bodySolids(node: SceneNode, world: THREE.Matrix4): { geom: SceneGeom; tris: number[] }[] {
  const out: { geom: SceneGeom; tris: number[] }[] = [];
  for (const geom of resolveCsgGeoms(node, 'render')) {
    if (geom.role === 'collision' || isDecor(geom)) continue;
    const tris: number[] = [];
    if (appendSolidTriangles(geom, world, tris) && tris.length > 0) out.push({ geom, tris });
  }
  return out;
}

/** Why prep leaves a body out entirely; null when it treats it. */
export function whyNotPrepped(node: SceneNode, world: THREE.Matrix4): string | null {
  return notAPart(node) ?? (bodySolids(node, world).length === 0 ? 'It has no solid shape.' : null);
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/** Below this an edge break is noise, and the rounding solid costs more than it gives. */
export const MIN_EDGE_BREAK = 0.0003;

export interface EdgePlan {
  /** The body's roundings after prep: what it had, plus the new ones. */
  features: EdgeRoundFeature[];
  /** How many edges were given a break. */
  broken: number;
  /** Edges left sharp because nothing over MIN_EDGE_BREAK fits on them. */
  sharp: number;
  /** The largest chamfer and fillet actually used, metres. */
  chamfer: number;
  fillet: number;
}

/**
 * The chamfer to aim for on a body: the edge-round tool's own suggestion (about
 * 8% of its smallest dimension, on a friendly number), or what was asked for.
 * The inside fillet is half again as big, the usual pattern-maker's ratio — an
 * inside radius smaller than the outside break reads as a crack starter.
 */
export function edgeTargets(smallestDimension: number, sizeMm: number | 'auto'): { chamfer: number; fillet: number } {
  const chamfer = sizeMm === 'auto' ? suggestedSize(smallestDimension, 0) : Math.max(0, sizeMm) / 1000;
  const fillet = Math.round((chamfer * 1.5) / 0.00025) * 0.00025;
  return { chamfer, fillet };
}

/**
 * Plans one body's edge breaks.
 *
 * Every outside edge gets a chamfer and every inside corner a fillet, each as
 * big as the target or as big as fits on that edge, whichever is smaller, on a
 * 0.1 mm grid. A feature carries one size, so edges are grouped by the size
 * they end up with. Edges the body already rounds are left as they are, and
 * `skip` can leave out more (the ones on the parting plane, which must stay
 * sharp or the sand overhangs the break).
 */
export function planEdgeRounds(
  edges: EdgeCandidate[],
  smallestDimension: number,
  sizeMm: number | 'auto',
  existing: EdgeRoundFeature[] = [],
  skip: (e: EdgeCandidate) => boolean = () => false,
): EdgePlan {
  const target = edgeTargets(smallestDimension, sizeMm);
  const groups = new Map<string, EdgeRoundFeature>();
  let broken = 0, sharp = 0, chamfer = 0, fillet = 0;

  for (const e of edges) {
    if (existing.some((f) => f.edges.some((x) => sameEdge(x, e.edge)))) continue;
    if (skip(e)) continue;
    const mode: 'chamfer' | 'fillet' = e.edge.convex ? 'chamfer' : 'fillet';
    const want = mode === 'chamfer' ? target.chamfer : target.fillet;
    const fits = maxSizeFor([e], mode);
    const size = Math.floor(Math.min(want, fits) * 1e4 + 1e-6) / 1e4;
    if (!(size >= MIN_EDGE_BREAK)) { sharp++; continue; }
    const key = `${mode}:${size}`;
    let f = groups.get(key);
    if (!f) { f = { mode, size, edges: [] }; groups.set(key, f); }
    f.edges.push(e.edge);
    broken++;
    if (mode === 'chamfer') chamfer = Math.max(chamfer, size); else fillet = Math.max(fillet, size);
  }

  return { features: [...existing, ...groups.values()], broken, sharp, chamfer, fillet };
}

/**
 * Whether an edge lies in the parting plane. It is the flat back the pattern is
 * rammed on, so breaking it would leave sand overhanging the break.
 */
export function edgeOnPlane(e: EdgeCandidate, bodyWorld: THREE.Matrix4, planeZ: number, tol = 1e-4): boolean {
  const z = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(bodyWorld).z;
  if (e.edge.kind === 'line') return Math.abs(z(e.edge.a) - planeZ) < tol && Math.abs(z(e.edge.b) - planeZ) < tol;
  const axis = new THREE.Vector3(...(e.edge.axis as [number, number, number]))
    .transformDirection(bodyWorld);
  return Math.abs(Math.abs(axis.z) - 1) < 1e-3 && Math.abs(z(e.edge.centre) - planeZ) < tol;
}

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export interface DraftParams {
  /** Taper, degrees from vertical. */
  deg: number;
  /** 'add': the faces furthest from the plane stay put and the walls grow toward it. 'remove': the reverse. */
  mode: 'add' | 'remove';
  /** World Z of the parting plane, metres. */
  partingZ: number;
}

/** Welding tolerance: well under any real feature, well over float noise. */
const WELD = 1e-7;

/**
 * Tapers one closed, outward-wound triangle soup (world, metres, 9 numbers per
 * triangle) and hands it back indexed.
 *
 * Every vertex moves only sideways, by an amount set by its height:
 *
 *   - h = |z − partingZ|, and H the body's furthest reach on that side.
 *   - add:    out by (H − h)·tanθ — far faces nominal, the parting line grows.
 *   - remove: in by h·tanθ — the parting line nominal, the far faces shrink.
 *
 * Moving each point by an amount linear in its height leans every wall by θ,
 * whichever way it faces: an outside wall leans out toward the plane, and a
 * pocket's wall — whose outward normal points into the pocket — closes in
 * toward its floor, which is exactly the draft a pocket needs.
 *
 * Which way a vertex moves is a miter of the walls around it: the d with
 * d·ĥᵢ = 1 for each wall's horizontal normal ĥᵢ, solved in least squares, so a
 * box's faces stay flat and its corners move √2 as far. Faces that are flat to
 * within 3° (tops, floors) have no say. `extents` is the body's z range, so all
 * of its geoms lean from the same top and bottom.
 */
export function draftTriangles(
  tris: ArrayLike<number>,
  p: DraftParams,
  extents?: { minZ: number; maxZ: number },
): { positions: number[]; faces: number[] } {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const faces: number[] = [];
  const vertexOf = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      index.set(key, i);
      positions.push(x, y, z);
    }
    return i;
  };
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const a = vertexOf(tris[t], tris[t + 1], tris[t + 2]);
    const b = vertexOf(tris[t + 3], tris[t + 4], tris[t + 5]);
    const c = vertexOf(tris[t + 6], tris[t + 7], tris[t + 8]);
    if (a === b || b === c || a === c) continue;
    faces.push(a, b, c);
  }

  const n = positions.length / 3;
  let minZ = extents?.minZ ?? Infinity, maxZ = extents?.maxZ ?? -Infinity;
  if (!extents) for (let i = 0; i < n; i++) { minZ = Math.min(minZ, positions[i * 3 + 2]); maxZ = Math.max(maxZ, positions[i * 3 + 2]); }

  // Per vertex: Σ ĥĥᵀ (a11, a12, a22) and Σ ĥ (b1, b2).
  const acc = new Float64Array(n * 5);
  const FLAT = Math.sin((3 * Math.PI) / 180);
  for (let f = 0; f < faces.length; f += 3) {
    const ia = faces[f] * 3, ib = faces[f + 1] * 3, ic = faces[f + 2] * 3;
    const ux = positions[ib] - positions[ia], uy = positions[ib + 1] - positions[ia + 1], uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia], vy = positions[ic + 1] - positions[ia + 1], vz = positions[ic + 2] - positions[ia + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const hl = Math.hypot(nx, ny) / len;
    if (hl < FLAT) continue;
    const hx = nx / (hl * len), hy = ny / (hl * len);
    for (let k = 0; k < 3; k++) {
      const o = faces[f + k] * 5;
      acc[o] += hx * hx; acc[o + 1] += hx * hy; acc[o + 2] += hy * hy;
      acc[o + 3] += hx; acc[o + 4] += hy;
    }
  }

  const tan = Math.tan((p.deg * Math.PI) / 180);
  const upReach = Math.max(0, maxZ - p.partingZ);
  const downReach = Math.max(0, p.partingZ - minZ);
  const out = positions.slice();
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    const a11 = acc[o], a12 = acc[o + 1], a22 = acc[o + 2], b1 = acc[o + 3], b2 = acc[o + 4];
    const trace = a11 + a22;
    if (trace === 0) continue;
    let dx: number, dy: number;
    const det = a11 * a22 - a12 * a12;
    if (det > 1e-6 * trace * trace) {
      dx = (a22 * b1 - a12 * b2) / det;
      dy = (a11 * b2 - a12 * b1) / det;
    } else {
      // Every wall here faces one way (or two opposite ways, which cancel).
      dx = b1 / trace;
      dy = b2 / trace;
    }
    // A knife-edge corner would miter off toward infinity.
    const dl = Math.hypot(dx, dy);
    if (dl > 2) { dx *= 2 / dl; dy *= 2 / dl; }

    const z = positions[i * 3 + 2];
    const h = Math.abs(z - p.partingZ);
    const reach = z >= p.partingZ ? upReach : downReach;
    const offset = p.mode === 'add' ? Math.max(0, reach - h) * tan : -h * tan;
    out[i * 3] += dx * offset;
    out[i * 3 + 1] += dy * offset;
  }
  return { positions: out, faces };
}

/** Z-up to Y-up, as the renderer reads `vertices`. Mirrors combineBodies' private copy. */
function zupToYupFlat(zup: number[]): number[] {
  const out = new Array<number>(zup.length);
  for (let i = 0; i < zup.length; i += 3) {
    out[i] = zup[i];
    out[i + 1] = zup[i + 2];
    out[i + 2] = -zup[i + 1] + 0;
  }
  return out;
}

/** The total mass a body's authored solid geoms state, if they state one. */
function sourceMass(node: SceneNode): number | undefined {
  const masses = (node.geoms || [])
    .filter((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && g.type !== 'plane')
    .map((g) => g.mass);
  if (masses.length === 0 || masses.some((m) => m === undefined)) return undefined;
  return masses.reduce((a, b) => a! + b!, 0);
}

/** Fields of a source geom that describe how it was BUILT, which a baked mesh no longer is. */
const BUILD_FIELDS = ['csg', 'csgDerived', 'fromto', 'quat', 'euler', 'latticeGeom', 'paint', 'baseVertices', 'baseRenderVertices', 'stableMesh', 'id'] as const;

/**
 * One body, drafted: its solid geoms as tapered meshes in its own frame, each
 * keeping the colour, mass and contact settings of the geom it came from.
 * Null when the body has nothing solid to draft.
 */
export function draftBodyGeoms(node: SceneNode, world: THREE.Matrix4, p: DraftParams): SceneGeom[] | null {
  const solids = bodySolids(node, world);
  if (solids.length === 0) return null;
  let minZ = Infinity, maxZ = -Infinity;
  for (const s of solids) for (let i = 2; i < s.tris.length; i += 3) { minZ = Math.min(minZ, s.tris[i]); maxZ = Math.max(maxZ, s.tris[i]); }

  const toLocal = world.clone().invert();
  const v = new THREE.Vector3();
  return solids.map(({ geom, tris }) => {
    const { positions, faces } = draftTriangles(tris, p, { minZ, maxZ });
    const local = new Array<number>(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(toLocal);
      local[i] = +v.x.toFixed(9); local[i + 1] = +v.y.toFixed(9); local[i + 2] = +v.z.toFixed(9);
    }
    const baked: SceneGeom = { ...geom };
    const rec = baked as unknown as Record<string, unknown>;
    for (const k of BUILD_FIELDS) delete rec[k];
    if (geom.csgDerived) {
      // A boolean's mesh hands colliding and weight to its colliders, which
      // are about to go. The baked mesh is the body now, so it takes both back:
      // the boolean's stated mass, or the source primitives', or its volume's.
      delete baked.role;
      const mass = node.csgMass ?? sourceMass(node);
      if (mass !== undefined) baked.mass = mass; else delete baked.mass;
    }
    baked.type = 'mesh';
    baked.size = [1];
    baked.pos = [0, 0, 0];
    baked.renderVertices = local;
    baked.vertices = zupToYupFlat(local);
    baked.faces = faces;
    return baked;
  });
}

/**
 * Bakes draft into every prepped body of `scene`, in place. Bodies that are
 * not in `originals` (left out of prep) are left alone. Returns the ids drafted.
 */
export function bakeDraftInto(scene: SceneGraph, prep: CastPrep, p: DraftParams): string[] {
  const drafted: string[] = [];
  for (const { node, world } of eachBody(scene)) {
    const entry = prep.originals[node.id];
    if (!entry) continue;
    const geoms = draftBodyGeoms(node, world, p);
    if (!geoms) continue;
    // Visual-only geoms (labels, trim) are not cast and are carried over as they are.
    const decor = resolveCsgGeoms(node, 'render').filter(isDecor);
    // Off with everything that would rebuild the body from its old recipe —
    // its roundings, its boolean, its generator — and on with the mesh.
    const rec = node as unknown as Record<string, unknown>;
    for (const k of SHAPE_KEYS) delete rec[k];
    node.geoms = [...geoms, ...decor];
    entry.signature = shapeSignature(node);
    drafted.push(node.id);
  }
  return drafted;
}

/**
 * Takes prep off `scene`, in place: each body whose shape is still what prep
 * left gets its originals back. A body changed since is left as it is, and
 * named in `kept`.
 */
export function unprepScene(scene: SceneGraph): { restored: string[]; kept: { id: string; name: string }[] } {
  const prep = scene.castPrep;
  const restored: string[] = [];
  const kept: { id: string; name: string }[] = [];
  if (!prep) return { restored, kept };
  for (const { node } of eachBody(scene)) {
    const entry = prep.originals[node.id];
    if (!entry) continue;
    if (shapeSignature(node) !== entry.signature) {
      kept.push({ id: node.id, name: node.name });
      continue;
    }
    restoreShape(node, entry.shape);
    restored.push(node.id);
  }
  delete scene.castPrep;
  return { restored, kept };
}

/** Signed volume ×6 of an indexed mesh: positive when it is wound outward. */
export function indexedSignedVolume(positions: number[], faces: number[]): number {
  let v = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return v;
}
