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
 * not reachable, so it fills in solid, and that is the right physics answer too:
 * nothing can get into it.
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
    messages: 'none',
  };

  const out = vhacd.computeConvexHulls(
    { positions: Float64Array.from(verts), indices: Uint32Array.from(faces) },
    options,
  );

  const hulls: Hull[] = [];
  for (const m of out) {
    const hv: number[] = new Array(m.positions.length);
    for (let i = 0; i < m.positions.length; i++) hv[i] = Math.round(m.positions[i] * QUANTUM) / QUANTUM;
    const hf = Array.from(m.indices);
    const { volume, centroid } = meshVolumeAndCentroid(hv, hf);
    // V-HACD can hand back a hull wound inward; its volume then integrates
    // negative and every share of the mass computed from it would be negative
    // too. The magnitude is still the hull's, so take it and move on.
    hulls.push({ verts: hv, faces: hf, volume: Math.abs(volume), centroid });
  }
  return usableColliderHulls(hulls);
}
