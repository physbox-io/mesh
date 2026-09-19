// ---------------------------------------------------------------------------
// Seeded noise, for the surface pattern generators.
//
// Everything here is deterministic in its seed. That is not a nicety: a plank
// is generated, looked at, adjusted and generated again, and a pattern that
// reshuffled itself on every keystroke would make the preview useless and the
// "same settings, same part" promise false. It is also what lets the tests
// assert on an actual grid rather than on statistics.
//
// Value noise rather than Perlin or simplex: the patterns here are carved at
// a millimetre scale by a cutter with its own radius, which smooths the result
// far more than the difference between the two gradients ever shows. Value
// noise is a dozen lines and has no lattice-direction artefacts worth caring
// about once it is run through `fbm`.
// ---------------------------------------------------------------------------

/**
 * A small deterministic PRNG, so the same seed always gives the same pattern.
 *
 * Shared with `presets/oakTree.ts`, which is where it started.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash a lattice point to 0..1.
 *
 * Integer-only, so it is stable across platforms and needs no table to be
 * allocated or seeded — the seed is just another input. A permutation table
 * would be faster per sample, but these grids are built once per keystroke,
 * not per frame.
 */
export function hash2D(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smoothstep, so the interpolation has no visible lattice creases. */
const fade = (t: number): number => t * t * (3 - 2 * t);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Bilinear value noise at a point in lattice units. Returns 0..1. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const a = hash2D(x0, y0, seed);
  const b = hash2D(x0 + 1, y0, seed);
  const c = hash2D(x0, y0 + 1, seed);
  const d = hash2D(x0 + 1, y0 + 1, seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/**
 * Fractal Brownian motion: octaves of value noise at doubling frequency and
 * halving amplitude, normalised back to 0..1.
 *
 * `octaves` is what decides whether the result reads as a shape or as texture.
 * Past about six the added detail is finer than any cutter can follow, so it
 * costs time and changes nothing in the material.
 */
export function fbm(x: number, y: number, seed: number, octaves = 4, gain = 0.5, lacunarity = 2): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(fx, fy, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Fractional part, always positive — `x % 1` is negative for negative x. */
export const fract = (x: number): number => x - Math.floor(x);

/** Clamp to 0..1, which is the range every pattern's output grid must be in. */
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Rescale a grid so its lowest value is 0 and its highest is 1, in place.
 *
 * Every generator ends with this. The alternative — each pattern reasoning
 * about its own output range — is how one of them ends up carving 2 mm deep
 * when the dialog said 8, because its theoretical maximum is not reachable at
 * the settings in front of you. Depth is set once, by the exporter, from a
 * grid that is known to span the full range.
 *
 * A flat grid (every value equal) is left flat rather than divided by zero.
 */
export function normaliseGrid(grid: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-9) {
    grid.fill(0);
    return grid;
  }
  for (let i = 0; i < grid.length; i++) grid[i] = (grid[i] - min) / span;
  return grid;
}
