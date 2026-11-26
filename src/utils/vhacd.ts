// The decomposer itself: a mesh in, convex hulls out.
//
// Split from convexDecomposition.ts on purpose. That module decides WHETHER to
// decompose and is pure; this one does the work and owns the wasm. Keeping them
// apart is what lets the policy be unit-tested in plain Node, and what stops a
// wasm module being pulled into anything that only wanted the arithmetic.
//
// It is also deliberately Worker-free. The vendored build embeds its binary as a
// data URL (see src/vendor/vhacd/PROVENANCE.md), so it instantiates the same way
// under Node as in a browser — which means the tests can run the real thing
// rather than a fixture, and scripts/export-presets.ts can decompose under
// vite-node where no Worker exists. utils/vhacdWorkerClient.ts wraps this for
// the browser, where a few hundred milliseconds on the main thread is a frozen
// viewport.

import { ConvexMeshDecomposition, type Options as VhacdOptions } from '../vendor/vhacd/vhacd.js';
import { meshVolumeAndCentroid, usableColliderHulls, type Hull } from './csg';

export interface DecomposeParams {
  maxHulls: number;
  maxVerticesPerHull: number;
  voxelResolution: number;
  minVolumePercentError: number;
  fillMode: 'flood' | 'surface' | 'raycast';
  /**
   * How many times V-HACD may halve before it merges back down to maxHulls.
   * Its own default is 10 — up to 1024 candidates merged pairwise — and on a
   * cup that merge is two thirds of the time: 2.5 s at 10, 0.9 s at 5, for
   * the same 16 pieces. A chunk (chunkedDecomposition.ts) is small enough for 6.
   */
  maxRecursionDepth?: number;
}

/**
 * Pinned, not tuned per call.
 *
 * V-HACD is a voxel method and its output moves with its parameters, so every
 * one of these is part of what collisionHashOf fingerprints indirectly: change a
 * default and every decomposed body in every saved scene is silently different.
 *
 * `fillMode: 'flood'` is the one with meaning rather than a number. Flood fill
 * marks everything reachable from outside the bounding box as empty, so an open
 * cup's cavity stays a cavity — which is the entire feature. A SEALED void is
 * not reachable, so it fills in solid. That is wrong whenever something starts
 * inside it — a tumbler's stones, a rattle, a ball in a cage: a closed drum came
 * back as one hull and threw its dice out. Raycast and surface fill do the
 * same. So the hollow is opened by cutting the mesh in two before this sees it
 * (chunkedDecomposition.ts): each half is a cup, which flood fill gets right.
 *
 * The rest are a speed/accuracy trade measured on the 100 mm cup fixture, which
 * is about as hard as an authored container gets (2 mm walls). Wall-clock, and
 * the summed hull volume over the cup's true volume — 1.00 would be exact, and
 * the overshoot is the hulls bulging slightly into the cavity:
 *
 *     resolution  error%  hulls    time    volume
 *        100,000      1     24    8.0 s      —
 *         50,000      5     16    4.7 s     1.20
 *         25,000      1     24    3.2 s     1.17
 *         25,000      5     24    2.9 s     1.14
 *         25,000      5     12    3.0 s     1.21
 *         25,000     10     24    2.0 s     1.14
 *
 * So V-HACD's own 400k default, and even 100k, buy nothing here but seconds:
 * 25k voxels already resolves a 2 mm wall. Accuracy past ~16 hulls is flat while
 * contact cost between two decomposed bodies is quadratic in hull count, which
 * is why the budget in convexDecomposition.ts caps where it does.
 */
export const DEFAULT_DECOMPOSE_PARAMS: DecomposeParams = {
  maxHulls: 16,
  maxVerticesPerHull: 64,
  voxelResolution: 25_000,
  minVolumePercentError: 5,
  fillMode: 'flood',
};

/** Rounded to the micron, so V-HACD's float noise cannot churn a scene's hash. */
const QUANTUM = 1e6;

let decomposer: Promise<ConvexMeshDecomposition> | null = null;

/** Instantiates the wasm once and keeps it. Safe to call repeatedly. */
export function loadDecomposer(): Promise<ConvexMeshDecomposition> {
  if (!decomposer) {
    decomposer = ConvexMeshDecomposition.create().catch(err => {
      // Don't cache a failed load: a transient instantiation error should not
      // disable decomposition for the rest of the session.
      decomposer = null;
      throw err;
    });
  }
  return decomposer;
}

export function isDecomposerReady(): boolean {
  return decomposer !== null;
}

/**
 * Breaks a mesh into convex hulls, in the space the mesh was given in.
 *
 * Callers pass Z-up `renderVertices`, which is the space geom positions live in,
 * so the hull centroids come back usable as `pos` directly.
 *
 * Slivers are dropped here rather than by the caller, because emitting one is
 * not a cosmetic mistake: qhull aborts on it inside MuJoCo and takes the whole
 * wasm heap with it. Everything that survives is measured, so the caller has the
 * volumes it needs to share mass out.
 */
export async function decomposeMesh(
  verts: number[],
  faces: number[],
  params: Partial<DecomposeParams> = {},
): Promise<Hull[]> {
  if (!verts.length || !faces.length) return [];
  const p = { ...DEFAULT_DECOMPOSE_PARAMS, ...params };
  const vhacd = await loadDecomposer();

  const options: VhacdOptions = {
    maxHulls: p.maxHulls,
    maxVerticesPerHull: p.maxVerticesPerHull,
    voxelResolution: p.voxelResolution,
    minVolumePercentError: p.minVolumePercentError,
    fillMode: p.fillMode,
    ...(p.maxRecursionDepth !== undefined ? { maxRecursionDepth: p.maxRecursionDepth } : {}),
    messages: 'none',
  };

  // High-aspect-ratio meshes (e.g. a 22:1 extruded V-bar) get only 1-2 cubic
  // voxels across their thin cross-section in V-HACD. Positive per-axis scaling
  // preserves convexity, planes, and flood-fill topology exactly, so normalize
  // extreme aspect ratios (> 8:1) to <= 4:1 before voxelization and unscale back.
  let loX = Infinity, loY = Infinity, loZ = Infinity;
  let hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < loX) loX = x; if (x > hiX) hiX = x;
    if (y < loY) loY = y; if (y > hiY) hiY = y;
    if (z < loZ) loZ = z; if (z > hiZ) hiZ = z;
  }
  const ext = [hiX - loX, hiY - loY, hiZ - loZ];
  const maxExt = Math.max(ext[0], ext[1], ext[2]);
  const minExt = Math.min(ext[0], ext[1], ext[2]);
  const mid = [(loX + hiX) / 2, (loY + hiY) / 2, (loZ + hiZ) / 2];
  const scale: [number, number, number] = [1, 1, 1];
  let normalized = false;
  if (minExt > 1e-6 && maxExt / minExt > 8) {
    const targetMin = maxExt / 4;
    for (let k = 0; k < 3; k++) {
      if (ext[k] < targetMin) {
        scale[k] = targetMin / ext[k];
        normalized = true;
      }
    }
  }
  const positions = Float64Array.from(verts);
  if (normalized) {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = mid[0] + (positions[i] - mid[0]) * scale[0];
      positions[i + 1] = mid[1] + (positions[i + 1] - mid[1]) * scale[1];
      positions[i + 2] = mid[2] + (positions[i + 2] - mid[2]) * scale[2];
    }
  }

  const out = vhacd.computeConvexHulls(
    { positions, indices: Uint32Array.from(faces) },
    options,
  );

  const hulls: Hull[] = [];
  for (const m of out) {
    const hv: number[] = new Array(m.positions.length);
    if (normalized) {
      for (let i = 0; i < m.positions.length; i += 3) {
        hv[i] = Math.round((mid[0] + (m.positions[i] - mid[0]) / scale[0]) * QUANTUM) / QUANTUM;
        hv[i + 1] = Math.round((mid[1] + (m.positions[i + 1] - mid[1]) / scale[1]) * QUANTUM) / QUANTUM;
        hv[i + 2] = Math.round((mid[2] + (m.positions[i + 2] - mid[2]) / scale[2]) * QUANTUM) / QUANTUM;
      }
    } else {
      for (let i = 0; i < m.positions.length; i++) hv[i] = Math.round(m.positions[i] * QUANTUM) / QUANTUM;
    }
    const hf = Array.from(m.indices);
    const { volume, centroid } = meshVolumeAndCentroid(hv, hf);
    // V-HACD can hand back a hull wound inward; its volume then integrates
    // negative and every share of the mass computed from it would be negative
    // too. The magnitude is still the hull's, so take it and move on.
    hulls.push({ verts: hv, faces: hf, volume: Math.abs(volume), centroid });
  }
  return usableColliderHulls(hulls);
}
