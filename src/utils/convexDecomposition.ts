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
import type { FilledCavity } from './filledCavities';
import { COLLISION_FLAG, scadProxyHulls, usesCollisionProxies } from './scadColliders';

/**
 * Above this a mesh is convex enough that its hull is the honest answer, and
 * decomposing it would buy nothing but contact pairs. A sphere, a box and a
 * slightly dished plate all land here.
 */
export const SOLIDITY_DECOMPOSE_BELOW = 0.92;

/**
 * Below this a mesh convex enough by its solidity is reported as too coarse to
 * have a concavity worth finding. Not a veto on its own: an L-shaped prism is
 * 20 triangles and plainly concave.
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
 * The most pieces a body may ask for, and the most a mesh comes out as when
 * it asks for nothing: a chute cut into chunks and pulled in to its surface
 * (solidDecomposition.ts) uses about 420.
 */
export const MAX_REQUESTED_HULLS = 512;
/**
 * The default for a body on a free joint, which can land in another
 * decomposed body: contact between two is pieces times pieces, and four
 * nesting bowls of 200 to 300 pieces each ran MuJoCo out of its contact
 * memory (mj_stackAlloc) at the first touch. 64 each is what they had, and
 * worked with. The arena is sized to the pieces now (contactArena.ts), but
 * time is the real limit: those bowls stepped at 2 to 3 ms a millisecond step
 * at 64 pieces and 18 to 36 ms at 513. The price is accuracy: at 64 a 74 mm
 * paraboloid bowl's pieces stand 2.3 mm proud, and nested bowls sit ~2.4 mm
 * high a level (tests/nestingBowls.test.ts).
 */
export const MAX_LOOSE_PIECES = 64;
export const MIN_RESOLUTION = 10_000;
export const MAX_RESOLUTION = 1_000_000;

/** A requested voxel count, held to what V-HACD can do in the worker's time. */
export function voxelResolutionOf(requested: number): number {
  return Math.max(MIN_RESOLUTION, Math.min(MAX_RESOLUTION, Math.round(requested)));
}

/** Detail settings, as voxel count and piece budget. Standard leaves both to the defaults. */
export interface CollisionDetail { collisionResolution?: number; collisionHulls?: number }

/**
 * The inspector's Standard / Fine / Finest. Each is voxels per chunk, finer
 * than the 25k a chunk gets by default; none sets a piece count, which would
 * cap the whole part.
 *
 * These used to depend on the part — fixed figures for a compact one, a step
 * above its scaled budget for a long thin one, read off its bounding box — and
 * a two-turn chute's box hid its 750 mm of channel, so it got the compact
 * figures and Fine and Finest filled its channel as Standard did. A part is
 * now cut into chunks until none is long and thin (chunkedDecomposition.ts),
 * each chunk measured afresh, so the same figures suit every part.
 */
export function collisionDetailLevels(): Record<'standard' | 'fine' | 'finest', CollisionDetail> {
  return {
    standard: {},
    fine: { collisionResolution: 50_000 },
    finest: { collisionResolution: 100_000 },
  };
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
  /** How far the colliders stand proud of the surface into the air, at most. */
  intrusion?: NonNullable<SceneNode['collisionIntrusion']>;
  /** How far the surface lies outside every collider, at most: material contact sinks into. */
  uncovered?: NonNullable<SceneNode['collisionUncovered']>;
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

  // Only where the solidity agrees: an L-shaped prism is 20 triangles and
  // two-thirds of its hull, and as a boolean's solid it collided as that hull.
  if (triangles < MIN_DECOMPOSE_TRIANGLES && solidity >= SOLIDITY_DECOMPOSE_BELOW) {
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
 * Which way colliders are made, fingerprinted with everything else: bumped
 * when the method changes enough that colliders saved by the old one should
 * be made again. 2: cut into chunks and pulled in to the surface
 * (solidDecomposition.ts), where 1 was one V-HACD call over the whole part.
 * 3: cut exactly along sharp inside corners first (reflexCuts.ts). 4: the axis
 * put back into lathed sectors, and pieces on the mesh's own faces kept.
 */
export const COLLIDER_RECIPE = 4;

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
    COLLIDER_RECIPE,
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
  /** How far the pieces stand proud of the surface into the air, at most, metres. */
  intrusion?: number;
  intrusionAt?: [number, number, number];
  /** How far the surface lies outside every piece, at most, metres. */
  uncovered?: number;
  uncoveredAt?: [number, number, number];
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
  const proudest = decomposed.reduce<MeshColliders | null>((a, p) => ((p.intrusion ?? 0) > (a?.intrusion ?? 0) ? p : a), null);
  // Under a hundredth of a millimetre is rounding, not a narrowed opening: cut
  // at its corners, a square pocket's exact pieces measure 5e-15 mm.
  const intrusion = proudest?.intrusion !== undefined && +(proudest.intrusion * 1000).toFixed(2) > 0
    ? { mm: +(proudest.intrusion * 1000).toFixed(2), ...(proudest.intrusionAt ? { atMm: proudest.intrusionAt.map(v => +(v * 1000).toFixed(1)) as [number, number, number] } : {}) }
    : undefined;
  const bare = decomposed.reduce<MeshColliders | null>((a, p) => ((p.uncovered ?? 0) > (a?.uncovered ?? 0) ? p : a), null);
  // Under a tenth of a millimetre is within MuJoCo's own contact softness.
  const uncovered = bare?.uncovered !== undefined && +(bare.uncovered * 1000).toFixed(1) >= 0.1
    ? { mm: +(bare.uncovered * 1000).toFixed(1), ...(bare.uncoveredAt ? { atMm: bare.uncoveredAt.map(v => +(v * 1000).toFixed(1)) as [number, number, number] } : {}) }
    : undefined;
  // Reported from a tenth of a millimetre, warned of from UNCOVERED_WARN_MM:
  // V-HACD's voxels leave a millimetre or two of a curved wall bare between
  // pieces, which is worth knowing about but not worth a warning on every bowl.
  const warning = [cavityWarning(named) ?? massWarning(node, decomposed), uncovered && uncovered.mm >= UNCOVERED_WARN_MM ? uncoveredSentence(uncovered) : undefined, ...notes].filter(Boolean).join(' ');
  return {
    hash, geoms, verdict, volume, hullVolume, mass,
    ...(warning ? { warning } : {}),
    ...(named.length > 0 ? { cavities: named } : {}),
    ...(intrusion ? { intrusion } : {}),
    ...(uncovered ? { uncovered } : {}),
  };
}

/**
 * How a body's narrowed openings are put, for the scene summary and the
 * inspector. Not a warning: every inside corner leaves a fillet of a
 * millimetre or so, which matters only to a part fitted that closely — a
 * 0.5 mm-clearance peg stopped at the rim of a bore whose pieces stood
 * 1.65 mm proud, and nothing said why.
 */
export function intrusionSentence(intrusion: NonNullable<SceneNode['collisionIntrusion']>): string {
  const at = intrusion.atMm ? `, most near (${intrusion.atMm.map(v => Math.round(v)).join(', ')}) mm` : '';
  return `Openings narrowed by up to ${intrusion.mm} mm${at}: the convex pieces stand that far proud of the surface, mostly in inside corners, so a part fitted closer than that jams. Collision Detail Fine or Finest tightens them.`;
}

/** Bare surface deeper than this, in millimetres, is a warning as well as a figure in the summary. */
export const UNCOVERED_WARN_MM = 3;

/**
 * Material no convex piece covers, for the scene summary and the inspector.
 * The opposite fault to a narrowed opening, and the worse one: contact goes
 * into the body there, so a part sinks into the floor or a ball drops into
 * a solid; nothing about the part's look gives it away.
 */
export function uncoveredSentence(uncovered: NonNullable<SceneNode['collisionUncovered']>): string {
  const at = uncovered.atMm ? ` near (${uncovered.atMm.map(v => Math.round(v)).join(', ')}) mm` : '';
  return `Part of the surface${at} has no convex piece under it, so contact sinks up to ${uncovered.mm} mm into the body there. Set Collision Detail finer, or report the shape.`;
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

  // Cut into chunks, each decomposed, every piece pulled in to the surface
  // (utils/solidDecomposition.ts). A piece count asked for is the most the
  // whole mesh may come out as; a voxel count asked for is per chunk.
  const loose = (node.joints ?? []).some(j => j.type === 'free');
  const maxPieces = node.collisionHulls !== undefined
    ? hullBudget(verdict.solidity, node.collisionHulls)
    : loose ? MAX_LOOSE_PIECES : MAX_REQUESTED_HULLS;
  const resolution = node.collisionResolution !== undefined ? voxelResolutionOf(node.collisionResolution) : undefined;
  const { decomposeSolidOffThread } = await import('./vhacdWorkerClient');
  let solid: Awaited<ReturnType<typeof decomposeSolidOffThread>>;
  try {
    solid = await decomposeSolidOffThread(verts, faces, { maxPieces, ...(resolution ? { voxelResolution: resolution } : {}) });
  } catch (err) {
    // Timed out, or the worker died. A body still has to collide as something.
    return none(`${err instanceof Error ? err.message : String(err)} It collides as its convex hull, so any hollow in it is solid.`, 'hull');
  }
  const { hulls, cavities } = solid;

  if (hulls.length < MIN_SURVIVING_HULLS) {
    // Emitting one piece, or none, is not a decomposition — and a mesh with no
    // colliders at all would leave its body falling through the world.
    return none('This shape could not be broken into convex pieces, so it collides as its convex hull and any hollow in it is solid.', 'hull');
  }
  return {
    source, verdict, volume, hullVolume, hulls, cavities,
    intrusion: solid.intrusion, ...(solid.intrusionAt ? { intrusionAt: solid.intrusionAt } : {}),
    uncovered: solid.uncovered, ...(solid.uncoveredAt ? { uncoveredAt: solid.uncoveredAt } : {}),
  };
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
