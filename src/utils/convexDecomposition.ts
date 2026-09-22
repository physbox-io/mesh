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
  collisionModeOf, colliderTemplateOf, convexHullOf, hullsToColliderGeoms,
  meshChecksum, meshVolumeAndCentroid, type Hull,
} from './csg';
import { analyzeMesh } from './meshIntegrity';
import type { CollisionMode, SceneGeom, SceneNode } from '../types/scene';

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

export type DecompositionStrategy = 'hull' | 'sectors' | 'decompose' | 'primitives';

export interface DecompositionVerdict {
  strategy: DecompositionStrategy;
  /** trueVolume / hullVolume. 1 is convex; a cup is nearer 0.3. */
  solidity: number;
  triangles: number;
  /** How many convex pieces to ask for, when the strategy is 'decompose'. */
  maxHulls: number;
  reason: 'no-mesh' | 'too-coarse' | 'too-dense' | 'convex-enough' | 'concave' | 'forced';
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
}

/** The mesh geoms of a body that are solid enough to collide with. */
export function solidMeshGeoms(node: SceneNode): SceneGeom[] {
  return (node.geoms || []).filter(g =>
    g.type === 'mesh' &&
    g.csg !== 'difference' &&
    !g.csgDerived &&
    g.role !== 'visual' &&
    !!g.faces?.length &&
    !!(g.renderVertices?.length || g.vertices?.length));
}

const triangleCount = (geoms: SceneGeom[]) =>
  geoms.reduce((n, g) => n + (g.faces?.length ?? 0) / 3, 0);

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
  if (requested !== undefined) return Math.max(1, Math.min(64, Math.round(requested)));
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
  opts: { volume?: number; hullVolume?: number; hasHoleAxis?: boolean } = {},
): DecompositionVerdict {
  const mode: CollisionMode = collisionModeOf(node);
  const meshes = solidMeshGeoms(node);
  const triangles = triangleCount(meshes);

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
    : meshSolidity(meshes[0]);
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
    meshes.map(g => [meshChecksum(g), g.pos ?? null, g.quat ?? null, g.euler ?? null]),
    collisionModeOf(node),
    node.collisionHulls ?? null,
    node.collisionMass ?? null,
    meshes.map(g => [g.mass ?? null, g.density ?? null, g.condim ?? null, g.friction ?? null, g.solref ?? null, g.solimp ?? null]),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `${h.toString(16)}_${key.length}`;
}

/**
 * Decomposes a body's mesh into convex colliders, or decides not to.
 *
 * Returns a result with no geoms when the verdict is to collide as a hull —
 * which is still worth installing, because it stamps collisionHash and stops the
 * same mesh being reconsidered on every store update.
 *
 * The wasm is reached through `await import(...)`, never a static import, so
 * this module stays loadable in plain Node and in the test suite. Same rule
 * csg.ts follows for ./openscad, and for the same reason.
 */
export async function decomposeNodeColliders(node: SceneNode): Promise<ColliderResult | null> {
  const hash = collisionHashOf(node);
  if (!hash) return null;

  const meshes = solidMeshGeoms(node);
  const source = meshes[0];
  const verts = source.renderVertices ?? source.vertices ?? [];
  const faces = source.faces ?? [];
  const { volume, hullVolume } = meshSolidity(source);
  const verdict = decompositionVerdict(node, { volume, hullVolume });
  const mass = colliderMass(node, source, volume);

  if (verdict.strategy !== 'decompose') {
    return { hash, geoms: [], verdict, volume, hullVolume, mass, warning: verdict.warning };
  }

  // A mesh that is open or wound both ways cannot be flood-filled sensibly: the
  // fill leaks through the gaps and the "inside" it finds is not the inside.
  // Better a hull and a sentence than confident nonsense. See the winding trap
  // in CLAUDE.md, and meshIntegrity.ts for what is actually checked.
  const integrity = analyzeMesh(verts, faces);
  if (integrity && !(integrity.closed && integrity.consistentlyWound && integrity.volume > 0)) {
    return {
      hash, geoms: [], verdict: { ...verdict, strategy: 'hull' }, volume, hullVolume, mass,
      warning: !integrity.closed
        ? 'This mesh has holes in it, so its inside cannot be told from its outside — it collides as its convex hull, and any hollow in it is solid. Close the mesh to decompose it.'
        : 'This mesh has triangles facing both ways, so its inside cannot be told from its outside — it collides as its convex hull. Fix the winding to decompose it.',
    };
  }

  // The client runs the worker in a browser and falls back to the module under
  // Node and vite-node, where there is no Worker to run.
  const { decomposeMeshOffThread } = await import('./vhacdWorkerClient');
  let hulls: Hull[];
  try {
    hulls = await decomposeMeshOffThread(verts, faces, { maxHulls: verdict.maxHulls });
  } catch (err) {
    // Timed out, or the worker died. A body still has to collide as something.
    return {
      hash, geoms: [], verdict: { ...verdict, strategy: 'hull' }, volume, hullVolume, mass,
      warning: `${err instanceof Error ? err.message : String(err)} It collides as its convex hull, so any hollow in it is solid.`,
    };
  }

  if (hulls.length < MIN_SURVIVING_HULLS) {
    // Emitting one piece, or none, is not a decomposition — and a body with no
    // colliders at all would fall through the world.
    return {
      hash, geoms: [], verdict: { ...verdict, strategy: 'hull' }, volume, hullVolume, mass,
      warning: 'This shape could not be broken into convex pieces, so it collides as its convex hull and any hollow in it is solid.',
    };
  }

  const geoms = hullsToColliderGeoms(hulls, node.name || node.id, colliderTemplateOf(source, source.rgba ?? [0.3, 0.6, 0.9, 1]), mass);
  return {
    hash, geoms, verdict, volume, hullVolume, mass,
    warning: massWarning(node, source, volume, hullVolume),
  };
}

/**
 * Said once, when it first becomes true: a hollow body that was being weighed by
 * its convex hull now weighs what is actually there, which is lighter — often by
 * a factor of three. Correct, and the same defect inertia="exact" fixed for the
 * oak tree, but not something to change under someone without telling them.
 */
function massWarning(node: SceneNode, source: SceneGeom, volume: number, hullVolume: number): string | undefined {
  if (node.collisionMass !== undefined || source.mass !== undefined) return undefined;
  if (!(volume > 0) || hullVolume / volume < 1.5) return undefined;
  const density = source.density ?? 1000;
  return `Now that its hollow is real, this body weighs ${(density * volume).toFixed(2)} kg rather than the ${(density * hullVolume).toFixed(2)} kg it was given as a solid lump. Set a mass if you wanted the heavier figure.`;
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
