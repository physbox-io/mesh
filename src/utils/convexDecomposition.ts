// Concave collision: deciding when a body's mesh has to be broken into convex
// pieces, and fingerprinting the decision so it is not made twice.
//
// MuJoCo collides a mesh geom as its CONVEX HULL. For a bracket or a boulder
// that is the same answer. For anything that encloses air it is not: a cup, a
// bowl, an open-top box, a funnel or a gearbox housing collides as the solid
// lump it fits inside, so a ball dropped into it lands on an invisible lid at
// the rim and nothing about the scene says why.
//
// utils/csg.ts already solves a narrow version of this for boolean bodies, by
// slicing the result into angular sectors about a hole axis. That only works
// when a negative shape PIERCES the solid — detectHoleAxis says so itself: a
// negative that "only bites into one face is a notch", which is exactly what a
// cup is. And it is only ever reached by a body with csgEnabled, while an
// imported STL, a sculpt, a lattice part and a relief all arrive as one mesh
// with no boolean history at all.
//
// So the decision lives here instead, keyed off the shape rather than off how
// the shape was authored: SOLIDITY, a body's true volume over the volume of its
// hull. A box is 1.0. A sphere is 1.0. A cup is nearer 0.3, and that gap is
// precisely the lie MuJoCo would be telling.
//
// This module is PURE, and deliberately worker-free: the decomposition itself
// needs wasm, but every decision about whether and how to run it does not.
// Vitest runs in plain Node with no Worker, and nothing here may statically
// import the client that spawns one — the compile path reaches it through
// `await import(...)`, the same rule csg.ts follows for ./openscad.

import {
  collisionModeOf, colliderTemplateOf, convexHullOf, hullsToColliderGeoms, isCollidingMeshGeom,
  meshChecksum, meshVolumeAndCentroid, primitiveVolume, type Hull,
} from './csg';
import { authoredQuat } from './bodyOrientation';
import { tidyMesh } from './meshTidy';
import type { CollisionMode, SceneGeom, SceneNode } from '../types/scene';
import { wallThickness, type FilledCavity } from './filledCavities';
import { COLLISION_FLAG, scadProxyHulls, usesCollisionProxies } from './scadColliders';

/**
 * Above this a mesh is convex enough that its hull is the honest answer, and
 * decomposing it would buy nothing but contact pairs. A sphere, a box and a
 * slightly dished plate all land here.
 */
export const SOLIDITY_DECOMPOSE_BELOW = 0.92;

/**
 * Below this there is no concavity to find. A tetrahedron IS its own hull, and
 * so is anything else drawn with a handful of triangles.
 */
export const MIN_DECOMPOSE_TRIANGLES = 24;

/**
 * Above this, decline and say so. A relief or a scanned mesh is hundreds of
 * thousands of triangles; voxelising one is seconds of wall clock, and the
 * result is scenery whose solidity is high anyway. The right answer for a
 * heightmap is MuJoCo's own `hfield` asset, not a convex decomposition — that
 * is worth doing one day, and is not this.
 */
export const MAX_DECOMPOSE_TRIANGLES = 150_000;

/** Fewer surviving hulls than this and the decomposition has not earned itself. */
export const MIN_SURVIVING_HULLS = 2;

/**
 * Hull budget, scaled by how concave the shape turned out to be.
 *
 * The ceiling is where it is because contact cost between two decomposed bodies
 * is QUADRATIC in hull count — 16 against 16 is already 256 pairs — while the
 * accuracy measured in utils/vhacd.ts is flat past about 16. V-HACD saturates
 * whatever budget it is given, so this is the hull count, not a limit it might
 * come in under.
 */
export const MIN_HULLS = 8;
export const MAX_HULLS = 16;

/**
 * What a body may ask for, or be given when the defaults scale up for a long
 * thin part (scaledBudget). A U-channel coaster track 440 mm long, with 3 mm
 * walls, needs about 450 pieces at 400k voxels before nothing but slivers of
 * its channel are filled — V-HACD cuts along the axes, so every piece of a
 * sloping channel that holds a wall and some floor fills the corner between
 * them — and that is a second in the worker.
 */
export const MAX_REQUESTED_HULLS = 512;
export const MIN_RESOLUTION = 10_000;
export const MAX_RESOLUTION = 1_000_000;

/**
 * The most voxels the defaults spend unasked. Time is not the voxel count
 * alone: the track takes 0.7 s at 400k, while a 100 mm cup with 2 mm walls
 * takes 2.6 s at 25k and 37 s at 800k, past the worker's 20 s allowance.
 */
export const AUTO_MAX_RESOLUTION = 400_000;

/**
 * The retry for a part that is not long and thin: the voxels it always had,
 * and pieces up to this many. On that thin cup 64 pieces at 100k voxels leave
 * 2,400 mm³ filled where 16 at 25k left 54,000, in 8 s.
 */
export const RETRY_RESOLUTION = 100_000;
export const RETRY_MAX_HULLS = 64;

/**
 * Length over wall thickness past which a part is long and thin enough that
 * the default budget cannot work, so its first decomposition already uses the
 * scaled one. The coaster track is 130; a 200 mm cup with 20 mm walls is 11,
 * and a 100 mm one with 2 mm walls 50, which the default gets mostly right and
 * the retry gets nearly all the way.
 */
export const SLENDER = 80;

/** A requested voxel count, held to what V-HACD can do in the worker's time. */
export function voxelResolutionOf(requested: number): number {
  return Math.max(MIN_RESOLUTION, Math.min(MAX_RESOLUTION, Math.round(requested)));
}

/**
 * The budget a part's own proportions call for: pieces in proportion to how
 * many wall thicknesses long it is, and voxels small enough that a wall is two
 * of them thick. A compact part gets about what it always did; a long thin one
 * gets what it needs, within MAX_REQUESTED_HULLS and AUTO_MAX_RESOLUTION.
 */
export function scaledBudget(verts: number[], faces: number[]): { maxHulls: number; voxelResolution: number; slenderness: number } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], verts[i + k]); hi[k] = Math.max(hi[k], verts[i + k]); }
  }
  const size = [0, 1, 2].map(k => Math.max(0, hi[k] - lo[k]));
  const length = Math.max(...size);
  const wall = wallThickness(verts, faces);
  if (!(wall > 0) || !(length > 0)) return { maxHulls: 32, voxelResolution: RETRY_RESOLUTION, slenderness: 0 };
  const slenderness = length / wall;
  const boxVolume = size.reduce((v, s) => v * Math.max(s, wall), 1);
  return {
    maxHulls: Math.round(Math.max(32, Math.min(MAX_REQUESTED_HULLS, 4 * slenderness))),
    voxelResolution: Math.round(Math.max(RETRY_RESOLUTION, Math.min(AUTO_MAX_RESOLUTION, boxVolume / (wall / 2) ** 3))),
    slenderness,
  };
}

/** Detail settings, as voxel count and piece budget. Standard leaves both to the defaults. */
export interface CollisionDetail { collisionResolution?: number; collisionHulls?: number }

/**
 * The inspector's Standard / Fine / Finest for a body. Fixed figures for a
 * compact part; for a long thin one each step is finer than the budget its
 * proportions already get by default. Fixed figures there gave Fine and Finest
 * fewer pieces than Standard, and a filled channel back.
 */
export function collisionDetailLevels(meshes: SceneGeom[]): Record<'standard' | 'fine' | 'finest', CollisionDetail> {
  const fixed = {
    standard: {},
    fine: { collisionResolution: 100_000, collisionHulls: 32 },
    finest: { collisionResolution: 300_000, collisionHulls: 48 },
  };
  let budget: ReturnType<typeof scaledBudget> | null = null;
  for (const g of meshes) {
    const { verts, faces } = bodyFrameMesh(colliderSourceOf(g));
    const b = scaledBudget(verts, faces);
    if (!budget || b.slenderness > budget.slenderness) budget = b;
  }
  if (!budget || budget.slenderness < SLENDER) return fixed;
  const step = (voxels: number, hulls: number): CollisionDetail => ({
    collisionResolution: voxelResolutionOf(Math.max(voxels, budget.voxelResolution * (voxels / 100_000 + 0.5))),
    collisionHulls: Math.min(MAX_REQUESTED_HULLS, Math.max(hulls, budget.maxHulls)),
  });
  return { standard: {}, fine: step(100_000, 32), finest: step(300_000, 48) };
}

export type DecompositionStrategy = 'hull' | 'sectors' | 'decompose' | 'primitives';

export interface DecompositionVerdict {
  strategy: DecompositionStrategy;
  /** trueVolume / hullVolume. 1 is convex; a cup is nearer 0.3. */
  solidity: number;
  triangles: number;
  /** How many convex pieces to ask for, when the strategy is 'decompose'. */
  maxHulls: number;
  reason: 'no-mesh' | 'too-coarse' | 'too-dense' | 'convex-enough' | 'concave' | 'forced' | 'scad-proxies';
  warning?: string;
}

/** What a decomposition produced, ready for the store to install. */
export interface ColliderResult {
  hash: string;
  /** The convex collider geoms. Empty when the verdict was to collide as a hull. */
  geoms: SceneGeom[];
  verdict: DecompositionVerdict;
  /** True volume of the source mesh, and of its hull — what solidity was read from. */
  volume: number;
  hullVolume: number;
  /** Total mass shared across the colliders. */
  mass: number;
  warning?: string;
  /** Cavities the colliders still fill in, named by the collider covering each. */
  cavities?: NonNullable<SceneNode['collisionCavities']>;
}

/** The mesh geoms of a body that are solid enough to collide with. */
export function solidMeshGeoms(node: SceneNode): SceneGeom[] {
  return (node.geoms || []).filter(isCollidingMeshGeom);
}

/**
 * The mesh a geom collides as: its separate collider source when it carries
 * one (Split for Print's section before its holes and pegs — see
 * SceneGeom.colliderVertices), and the geom itself otherwise. Decomposing the
 * drilled section instead would fill every hole with a convex piece.
 */
export function colliderSourceOf(g: SceneGeom): SceneGeom {
  return g.colliderFaces?.length && g.colliderVertices?.length
    ? { ...g, renderVertices: g.colliderVertices, vertices: undefined, faces: g.colliderFaces }
    : g;
}

const triangleCount = (geoms: SceneGeom[]) =>
  geoms.reduce((n, g) => n + (colliderSourceOf(g).faces?.length ?? 0) / 3, 0);

/**
 * True volume and hull volume of a mesh geom, in its own space.
 *
 * Hulling a dense point cloud is the expensive half, so callers that already
 * hold both figures (a boolean body stores them as csgVolume/csgHullVolume)
 * should pass them to `verdictFrom` rather than come through here.
 */
export function meshSolidity(g: SceneGeom): { volume: number; hullVolume: number; solidity: number } {
  const verts = g.renderVertices ?? g.vertices ?? [];
  const faces = g.faces ?? [];
  const { volume } = meshVolumeAndCentroid(verts, faces);
  const points: number[][] = [];
  for (let i = 0; i < verts.length; i += 3) points.push([verts[i], verts[i + 1], verts[i + 2]]);
  const hullVolume = convexHullOf(points)?.volume ?? 0;
  return { volume, hullVolume, solidity: solidityOf(volume, hullVolume) };
}

/**
 * A mesh that is inside-out integrates to a negative volume, and one that is
 * open integrates to something meaningless. Either way the ratio is not a
 * solidity, and 1 ("convex, leave it alone") is the safe reading — see the
 * winding trap in CLAUDE.md.
 */
export function solidityOf(volume: number, hullVolume: number): number {
  if (!(hullVolume > 0) || !(volume > 0)) return 1;
  return Math.min(1, volume / hullVolume);
}

/** How many pieces a shape of this solidity is worth breaking into. */
export function hullBudget(solidity: number, requested?: number): number {
  if (requested !== undefined) return Math.max(1, Math.min(MAX_REQUESTED_HULLS, Math.round(requested)));
  const span = MAX_HULLS - MIN_HULLS;
  return Math.round(Math.max(MIN_HULLS, Math.min(MAX_HULLS, MIN_HULLS + span * (1 - solidity))));
}

/**
 * Whether this body's mesh should be decomposed, and into how many pieces.
 *
 * `hasHoleAxis` is the boolean-only question "does a negative pierce this
 * solid?" — when it does, the existing sector slicer is the better answer than a
 * general decomposition, because its error is known exactly (a sector's chord
 * intrudes by inner*(1-cos(pi/N))) instead of approximated.
 */
export function decompositionVerdict(
  node: SceneNode,
  opts: { volume?: number; hullVolume?: number; hasHoleAxis?: boolean; triangles?: number } = {},
): DecompositionVerdict {
  const mode: CollisionMode = collisionModeOf(node);
  const meshes = solidMeshGeoms(node);
  // Measured figures are for one mesh, and so is its triangle count.
  const triangles = opts.triangles ?? triangleCount(meshes);

  if (mode === 'primitives') {
    return { strategy: 'primitives', solidity: 1, triangles, maxHulls: 0, reason: 'forced' };
  }
  if (mode === 'hull') {
    return { strategy: 'hull', solidity: 1, triangles, maxHulls: 0, reason: 'forced' };
  }
  if (meshes.length === 0) {
    // A body of primitives is already a set of convex solids. Nothing to do, and
    // this is the guarantee that no existing primitive scene moves.
    return { strategy: 'hull', solidity: 1, triangles: 0, maxHulls: 0, reason: 'no-mesh' };
  }

  const measured = opts.volume !== undefined && opts.hullVolume !== undefined
    ? { volume: opts.volume, hullVolume: opts.hullVolume, solidity: solidityOf(opts.volume, opts.hullVolume) }
    // Unmeasured, the body is as concave as its most concave mesh: each mesh
    // collides as its own hull, so one cup among boxes is still a cup.
    : meshes.map(g => meshSolidity(colliderSourceOf(g))).reduce((a, b) => (b.solidity < a.solidity ? b : a));
  const { solidity } = measured;
  const maxHulls = hullBudget(solidity, node.collisionHulls);

  if (mode === 'decompose') {
    // Forced: the caps are advice, not a veto. The client time-boxes the run.
    return {
      strategy: opts.hasHoleAxis ? 'sectors' : 'decompose',
      solidity, triangles, maxHulls, reason: 'forced',
    };
  }

  if (triangles < MIN_DECOMPOSE_TRIANGLES) {
    return { strategy: 'hull', solidity, triangles, maxHulls: 0, reason: 'too-coarse' };
  }
  if (solidity >= SOLIDITY_DECOMPOSE_BELOW) {
    return { strategy: 'hull', solidity, triangles, maxHulls: 0, reason: 'convex-enough' };
  }
  if (triangles > MAX_DECOMPOSE_TRIANGLES) {
    return {
      strategy: 'hull', solidity, triangles, maxHulls: 0, reason: 'too-dense',
      warning: `This mesh has ${Math.round(triangles).toLocaleString()} triangles — too many to break into convex pieces automatically, so it collides as its convex hull and any hollow in it is solid. Simplify it, or set Collision to Decompose to force it.`,
    };
  }
  return {
    strategy: opts.hasHoleAxis ? 'sectors' : 'decompose',
    solidity, triangles, maxHulls, reason: 'concave',
  };
}

/**
 * What a decomposed body weighs.
 *
 * The consequential line is `* trueVolume`. Undecomposed, a cup with neither
 * mass nor density set is weighed by MuJoCo at 1000 kg/m³ times its HULL volume
 * — the lump, not the cup. Decomposing weighs it by what is actually there, so a
 * hollow body gets lighter, often by a factor of three. That is the correct
 * number and the same defect `inertia="exact"` was introduced to fix for the oak
 * tree, but it is a visible change, so applyNodeColliders says so.
 */
export function colliderMass(node: SceneNode, template: SceneGeom | undefined, trueVolume: number): number {
  if (node.collisionMass !== undefined) return node.collisionMass;
  if (template?.mass !== undefined) return template.mass;
  const density = template?.density ?? 1000;
  return Math.max(1e-9, density * trueVolume);
}

/**
 * Fingerprints everything the colliders on a NON-boolean body were built from.
 *
 * The boolean counterpart is csgHashOf, and the two are deliberately separate:
 * a boolean body has one question ("is my mesh current?") whose answer already
 * covers the collision decision, while every other body has only this one.
 *
 * Cheap on purpose. This runs on every store update for every body, and a
 * lattice or a sculpt is tens of thousands of numbers — meshChecksum summarises
 * one to a short string rather than serialising it, which is the difference
 * between this and a megabyte of garbage per keystroke.
 *
 * Returns '' when there is nothing to decompose, so "no colliders wanted" and
 * "colliders up to date" are the same cheap comparison.
 */
export function collisionHashOf(node: SceneNode): string {
  if (node.csgEnabled) return '';
  const meshes = solidMeshGeoms(node);
  if (meshes.length === 0) return '';
  const key = JSON.stringify([
    meshes.map(g => [meshChecksum(colliderSourceOf(g)), g.pos ?? null, g.quat ?? null, g.euler ?? null]),
    collisionModeOf(node),
    node.collisionHulls ?? null,
    node.collisionResolution ?? null,
    // A script that draws its own proxies: they can change with the script
    // while the part they collide for stays exactly the same shape.
    usesCollisionProxies(node.scad) ? node.scad : null,
    node.collisionMass ?? null,
    meshes.map(g => [g.mass ?? null, g.density ?? null, g.condim ?? null, g.friction ?? null, g.solref ?? null, g.solimp ?? null, g.contype ?? null, g.conaffinity ?? null]),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `${h.toString(16)}_${key.length}`;
}

/**
 * A mesh geom's collision source in the BODY frame, Z-up: its renderVertices
 * (or its Y-up vertices, turned) moved by the geom's own pos and rotation.
 *
 * The pieces are emitted with no rotation and their centroid as pos, so they
 * land where their vertices say in the body frame. A mesh is placed by MuJoCo
 * (and drawn by SceneLayer) at its geom's pose, so decomposing its raw vertices
 * put every piece where the mesh would be with that pose taken away: two
 * upright rims at y = ±30 mm became one flat ring at y = 0, and a sleeve
 * standing on pos z = 85 mm collided 85 mm into the floor.
 */
export function bodyFrameMesh(g: SceneGeom): { verts: number[]; faces: number[] } {
  const shape = colliderSourceOf(g);
  const faces = shape.faces ?? [];
  let local = shape.renderVertices;
  if (!local) {
    const yUp = shape.vertices ?? [];
    local = new Array<number>(yUp.length);
    for (let i = 0; i < yUp.length; i += 3) {
      local[i] = yUp[i];
      local[i + 1] = -yUp[i + 2];
      local[i + 2] = yUp[i + 1];
    }
  }
  const tx = g.pos?.[0] ?? 0, ty = g.pos?.[1] ?? 0, tz = g.pos?.[2] ?? 0;
  let [w, x, y, z] = authoredQuat(g);
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  const turned = x !== 0 || y !== 0 || z !== 0;
  if (!turned && !tx && !ty && !tz) return { verts: local, faces };
  const verts = new Array<number>(local.length);
  for (let i = 0; i < local.length; i += 3) {
    let vx = local[i], vy = local[i + 1], vz = local[i + 2];
    if (turned) {
      // v + 2w(q x v) + 2 q x (q x v)
      const cx = y * vz - z * vy, cy = z * vx - x * vz, cz = x * vy - y * vx;
      const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
      vx += 2 * (w * cx + dx); vy += 2 * (w * cy + dy); vz += 2 * (w * cz + dz);
    }
    verts[i] = vx + tx;
    verts[i + 1] = vy + ty;
    verts[i + 2] = vz + tz;
  }
  return { verts, faces };
}

/** One mesh's share of a body's decomposition. */
interface MeshColliders {
  source: SceneGeom;
  verdict: DecompositionVerdict;
  volume: number;
  hullVolume: number;
  hulls: Hull[];
  cavities: FilledCavity[];
  warning?: string;
}

/**
 * Decomposes a body's meshes into convex colliders, or decides not to.
 *
 * Each colliding mesh is judged and broken up on its own, because MuJoCo hulls
 * each on its own: a Ferris wheel's two rims are two rings, not one, and a box
 * beside a cup is exact as it is. A mesh that is decomposed stops colliding as
 * itself (resolveCsgGeoms reads `colliderOf`); the others go on as they were.
 *
 * Returns a result with no geoms when no mesh is decomposed — which is still
 * worth installing, because it stamps collisionHash and stops the same mesh
 * being reconsidered on every store update.
 *
 * The wasm is reached through `await import(...)`, never a static import, so
 * this module stays loadable in plain Node and in the test suite. Same rule
 * csg.ts follows for ./openscad, and for the same reason.
 */
export async function decomposeNodeColliders(node: SceneNode): Promise<ColliderResult | null> {
  const hash = collisionHashOf(node);
  if (!hash) return null;

  const meshes = solidMeshGeoms(node);
  const baseName = node.name || node.id;

  // The script's own colliders, when it draws them (utils/scadColliders.ts).
  // They stand for the whole body, so they carry no colliderOf.
  if (usesCollisionProxies(node.scad) && collisionModeOf(node) !== 'hull') {
    const source = meshes[0];
    const { verts, faces } = bodyFrameMesh(source);
    const { volume, hullVolume } = await analyse(verts, faces);
    const verdict = decompositionVerdict(node, { volume, hullVolume });
    const mass = colliderMass(node, source, volume);
    try {
      const proxies = await scadProxyHulls(node.scad!);
      if (proxies.length > 0) {
        const geoms = hullsToColliderGeoms(proxies, baseName, colliderTemplateOf(source, source.rgba ?? [0.3, 0.6, 0.9, 1]), mass);
        return {
          hash, geoms, volume, hullVolume, mass,
          verdict: { ...verdict, strategy: 'decompose', maxHulls: proxies.length, reason: 'scad-proxies' },
        };
      }
      return {
        hash, geoms: [], verdict: { ...verdict, strategy: 'hull' }, volume, hullVolume, mass,
        warning: `The script mentions ${COLLISION_FLAG} but draws nothing when it is true, so it collides as its convex hull. Put the collision shapes in an if (${COLLISION_FLAG}) branch.`,
      };
    } catch (err) {
      return {
        hash, geoms: [], verdict: { ...verdict, strategy: 'hull' }, volume, hullVolume, mass,
        warning: `The collision version of the script did not compile (${err instanceof Error ? err.message : String(err)}), so it collides as its convex hull.`,
      };
    }
  }

  const parts: MeshColliders[] = [];
  for (const source of meshes) parts.push(await decomposeOneMesh(node, source));

  const decomposed = parts.filter(p => p.hulls.length > 0);
  const volume = parts.reduce((v, p) => v + p.volume, 0);
  const hullVolume = parts.reduce((v, p) => v + p.hullVolume, 0);
  // The body's verdict is its most concave mesh's, among those broken up if any were.
  const lead = (decomposed.length ? decomposed : parts).reduce((a, b) => (b.verdict.solidity < a.verdict.solidity ? b : a));
  const verdict: DecompositionVerdict = {
    ...lead.verdict,
    triangles: parts.reduce((t, p) => t + p.verdict.triangles, 0),
    ...(decomposed.length ? { maxHulls: decomposed.reduce((t, p) => t + p.hulls.length, 0) } : {}),
  };
  const notes = parts.map(p => p.warning).filter((w): w is string => !!w);

  if (decomposed.length === 0) {
    const mass = parts.reduce((m, p) => m + colliderMass(node, p.source, p.volume), 0);
    return { hash, geoms: [], verdict, volume, hullVolume, mass, ...(notes.length ? { warning: notes.join(' ') } : {}) };
  }

  // A body-wide collisionMass is shared over what is decomposed, by volume;
  // otherwise each mesh's pieces weigh what that mesh does.
  const decomposedVolume = decomposed.reduce((v, p) => v + p.volume, 0);
  const massOf = (p: MeshColliders) => (node.collisionMass !== undefined
    ? node.collisionMass * (decomposedVolume > 0 ? p.volume / decomposedVolume : 1 / decomposed.length)
    : colliderMass(node, p.source, p.volume));

  const geoms: SceneGeom[] = [];
  const named: NonNullable<ColliderResult['cavities']> = [];
  for (const p of decomposed) {
    const first = geoms.length;
    const template = colliderTemplateOf(p.source, p.source.rgba ?? [0.3, 0.6, 0.9, 1]);
    hullsToColliderGeoms(p.hulls, baseName, template, massOf(p)).forEach((g, i) => {
      geoms.push({ ...g, name: `${baseName}_csg_col${first + i}`, colliderOf: p.source.name });
    });
    for (const c of p.cavities) named.push({ ...c, coveredBy: `${baseName}_csg_col${first + c.coveredBy}` });
  }
  const mass = decomposed.reduce((m, p) => m + massOf(p), 0);
  const warning = [cavityWarning(named) ?? massWarning(node, decomposed), ...notes].filter(Boolean).join(' ');
  return {
    hash, geoms, verdict, volume, hullVolume, mass,
    ...(warning ? { warning } : {}),
    ...(named.length > 0 ? { cavities: named } : {}),
  };
}

/** Volume, hull volume and soundness of a mesh, off the main thread where there is one. */
async function analyse(verts: number[], faces: number[]) {
  // The client runs the worker in a browser and falls back to the module under
  // Node and vite-node, where there is no Worker to run. Measuring goes through
  // it too: hulling every vertex of a dense sculpt hitched the viewport after
  // each stroke when it ran here.
  const { analyseMeshOffThread } = await import('./vhacdWorkerClient');
  try {
    return await analyseMeshOffThread(verts, faces);
  } catch {
    const { analyseMesh } = await import('./meshAnalysis');
    return analyseMesh(verts, faces);
  }
}

/** Judges one mesh of a body, and breaks it into convex pieces if it earns it. */
async function decomposeOneMesh(node: SceneNode, source: SceneGeom): Promise<MeshColliders> {
  const framed = bodyFrameMesh(source);
  const verts = framed.verts;
  // Closed up first: a profile on the axis leaves zero-area triangles, and a
  // polyhedron listed the wrong way round comes out inside out. Neither is
  // ambiguous, and meshes saved before compiles were tidied still carry them.
  const { faces } = tidyMesh(verts, framed.faces);
  const { volume, hullVolume, integrity } = await analyse(verts, faces);
  const verdict = decompositionVerdict(node, { volume, hullVolume, triangles: faces.length / 3 });
  const none = (warning?: string, strategy: DecompositionStrategy = verdict.strategy): MeshColliders => ({
    source, verdict: { ...verdict, strategy }, volume, hullVolume, hulls: [], cavities: [], ...(warning ? { warning } : {}),
  });

  if (verdict.strategy !== 'decompose') return none(verdict.warning);

  // A mesh that is open or wound both ways cannot be flood-filled sensibly: the
  // fill leaks through the gaps and the "inside" it finds is not the inside.
  // Better a hull and a sentence than confident nonsense. See the winding trap
  // in CLAUDE.md, and meshIntegrity.ts for what is actually checked. A closed
  // mesh wound inward throughout was turned the right way out just above.
  if (integrity && !(integrity.closed && integrity.consistentlyWound && integrity.volume > 0)) {
    return none(integrity.closed && !integrity.consistentlyWound
      ? 'This mesh has triangles facing both ways, so its inside cannot be told from its outside — it collides as its convex hull. Fix the winding to decompose it.'
      : 'This mesh has holes in it, so its inside cannot be told from its outside — it collides as its convex hull, and any hollow in it is solid. Close the mesh to decompose it.', 'hull');
  }

  // Asked for, or left to the defaults with one finer try in reserve. The
  // defaults are for a compact part; a long thin one starts from the budget
  // its proportions call for, since the default could only fill its channel.
  const tuned = node.collisionHulls !== undefined || node.collisionResolution !== undefined;
  const resolution = node.collisionResolution !== undefined ? voxelResolutionOf(node.collisionResolution) : undefined;
  const scaled = scaledBudget(verts, faces);
  const slender = !tuned && scaled.slenderness >= SLENDER;

  const { decomposeWithCavitiesOffThread } = await import('./vhacdWorkerClient');
  const run = (params: { maxHulls: number; voxelResolution?: number }) => decomposeWithCavitiesOffThread(verts, faces, params);
  const standard = { maxHulls: verdict.maxHulls, ...(resolution ? { voxelResolution: resolution } : {}) };
  // Timed out, or the worker died. A body still has to collide as something.
  const failed = (err: unknown) => none(`${err instanceof Error ? err.message : String(err)} It collides as its convex hull, so any hollow in it is solid.`, 'hull');

  let first: { hulls: Hull[]; cavities: FilledCavity[] };
  try {
    first = await run(slender ? { maxHulls: scaled.maxHulls, voxelResolution: scaled.voxelResolution } : standard);
  } catch (err) {
    if (!slender) return failed(err);
    // Too slow at the scaled budget: something, at least, at the standard one.
    try { first = await run(standard); } catch (again) { return failed(again); }
  }
  let { hulls, cavities } = first;
  // A piece bridging a slot looks healthy from the outside — "9 convex
  // pieces" — while the slot is solid. When that is found and nobody has
  // tuned this body, try once finer: on the oak tray 100k voxels and 32
  // hulls cleared a filled phone groove and two filled dishes in 2.3 s. A
  // retry that fails keeps the first result rather than throwing it away.
  if (cavities.length > 0 && !tuned && !slender) {
    try {
      const finer = await run({
        maxHulls: Math.max(verdict.maxHulls, Math.min(RETRY_MAX_HULLS, scaled.maxHulls)),
        voxelResolution: RETRY_RESOLUTION,
      });
      const filled = (list: FilledCavity[]) => list.reduce((sum, c) => sum + c.volumeMm3, 0);
      if (finer.hulls.length >= MIN_SURVIVING_HULLS && filled(finer.cavities) < filled(cavities)) {
        ({ hulls, cavities } = finer);
      }
    } catch {
      // Keep the first.
    }
  }

  if (hulls.length < MIN_SURVIVING_HULLS) {
    // Emitting one piece, or none, is not a decomposition — and a mesh with no
    // colliders at all would leave its body falling through the world.
    return none('This shape could not be broken into convex pieces, so it collides as its convex hull and any hollow in it is solid.', 'hull');
  }
  return { source, verdict, volume, hullVolume, hulls, cavities };
}

/** Said when a decomposition still fills something in, naming where and which piece. */
function cavityWarning(cavities: NonNullable<ColliderResult['cavities']>): string | undefined {
  if (cavities.length === 0) return undefined;
  const [c] = cavities;
  const more = cavities.length > 1 ? ` (and ${cavities.length - 1} more)` : '';
  return `A cavity about ${c.extentMm.map((v) => Math.round(v)).join(' x ')} mm around ` +
    `(${c.centerMm.map((v) => Math.round(v)).join(', ')}) mm is filled in by ${c.coveredBy}${more}, so it is ` +
    `solid to contact. Raise Collision Detail (collisionResolution) or the piece count (collisionHulls).`;
}

/**
 * Said once, when it first becomes true: a hollow body that was being weighed by
 * its convex hull now weighs what is actually there, which is lighter — often by
 * a factor of three. Correct, and the same defect inertia="exact" fixed for the
 * oak tree, but not something to change under someone without telling them.
 *
 * Both figures are the WHOLE body's: the geoms that were not decomposed weigh
 * the same either way and are counted in each, so the sentence is about the
 * body someone picks up rather than one of its meshes.
 */
function massWarning(node: SceneNode, decomposed: MeshColliders[]): string | undefined {
  if (node.collisionMass !== undefined) return undefined;
  const hollow = decomposed.filter(p => p.source.mass === undefined && p.volume > 0);
  const volume = hollow.reduce((v, p) => v + p.volume, 0);
  const hullVolume = hollow.reduce((v, p) => v + p.hullVolume, 0);
  if (!(volume > 0) || hullVolume / volume < 1.5) return undefined;
  const before = hollow.reduce((m, p) => m + (p.source.density ?? 1000) * p.hullVolume, 0);
  const after = hollow.reduce((m, p) => m + (p.source.density ?? 1000) * p.volume, 0);
  const sources = new Set(decomposed.map(p => p.source));
  const rest = (node.geoms || [])
    .filter(g => !sources.has(g) && !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && g.type !== 'plane')
    .reduce((m, g) => m + (g.mass ?? (g.density ?? 1000) * primitiveVolume(g)), 0)
    + decomposed.filter(p => !hollow.includes(p)).reduce((m, p) => m + (p.source.mass ?? 0), 0);
  // Not "its hollow": a quadruped or a chair is concave and solid, and the
  // difference is the air between its legs, which its hull counted.
  return `Weighed by its real volume now that it collides as convex pieces, this body weighs ${(rest + after).toFixed(2)} kg rather than the ${(rest + before).toFixed(2)} kg of its convex hull, which counted the space between and inside its parts as solid. Set a mass if you wanted the heavier figure.`;
}

/**
 * True when a body's derived colliders no longer match its mesh.
 *
 * Tests PRESENCE as well as the hash, because a share link strips colliders
 * before serialising — they are regenerable and the budget is 64 kB — so a
 * scene can arrive with a hash that matches and no colliders to show for it.
 */
export function collidersAreStale(node: SceneNode): boolean {
  const hash = collisionHashOf(node);
  if (!hash) return false;
  if (hash !== node.collisionHash) return true;
  // Settled. Everything past here has to stay cheap: this runs for every body
  // on every store update, so it reads the recorded outcome rather than working
  // the verdict out again, which would hull a point cloud per keystroke.
  if (!node.collisionDecomposed) return false;
  return !(node.geoms || []).some(g => g.csgDerived === 'collider');
}
