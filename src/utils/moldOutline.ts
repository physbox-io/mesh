// ---------------------------------------------------------------------------
// A mold block that follows the part, rather than a box round it
// ---------------------------------------------------------------------------
//
// The rigid mold was always a rectangular block, the part's bounding box plus
// the wall. Round a round part, the corners are plastic doing nothing; for a
// 40 mm part it is about half the print. With `blockShape: 'fit'` the block's
// plan is the part's own silhouette grown by the wall, holes filled (the core
// inside a ring is mold, not air), and the registration pins and pry notches
// move onto it. Everything here is in a half's build frame: the block centred
// on the origin, the parting face at z = 0.

import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import { buildPartManifold, manifoldToTriangles, type Triangle3D } from './moldManifold';

/** Round joins, as smooth as the rest of the mold's curves. */
const SEGMENTS = 64;

/** Plain polygons, not engine objects: nothing to free on any path out of the mold builder. */
export type Outline = SimplePolygon[];

export interface MoldOutlines {
  /** The cavity half's (or open mold's) block plan. */
  base: Outline;
  /** The lid's: the base's mirrored in Y, as the lid closes over it. */
  lid: Outline;
  /** Where the pins go, a ring halfway out into the wall (base frame). */
  pinRing: Outline;
}

/** A section with only its outer boundaries: holes filled, since a ring's core is mold. */
function filled(wasm: ManifoldToplevel, cs: CrossSection): CrossSection {
  const outer = cs.toPolygons().filter((loop) => signedArea(loop) > 0);
  return new wasm.CrossSection(outer, 'Positive');
}

function signedArea(loop: readonly (readonly [number, number] | { x: number; y: number } | number[])[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i] as unknown as number[], q = loop[(i + 1) % loop.length] as unknown as number[];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * The block plans for a part, or null when its silhouette cannot be traced
 * (the part is not a closed solid): the caller keeps the box.
 *
 * `tris` is the part in the sampling frame (mm, 9 per triangle); the base's
 * frame is that frame mirrored in Y when `baseMirrored` (the cavity half
 * holding the part's top). `extraMm` widens the wall for a cavity the draft
 * grows at its foot.
 */
export function moldOutlines(
  wasm: ManifoldToplevel,
  tris: Float64Array,
  solidIds: number[] | undefined,
  opts: { wallMm: number; pinRingMm: number; baseMirrored: boolean; extraMm?: number },
): MoldOutlines | null {
  const { part } = buildPartManifold(wasm, tris, solidIds);
  if (!part) return null;
  const silhouette = part.project();
  part.delete();
  if (silhouette.isEmpty()) {
    silhouette.delete();
    return null;
  }
  let foot = filled(wasm, silhouette);
  silhouette.delete();
  if (opts.baseMirrored) foot = swap(foot, foot.mirror([0, 1]));
  const grow = opts.wallMm + (opts.extraMm ?? 0);
  let base = foot.offset(grow, 'Round', 2, SEGMENTS);
  // Islands far apart are one block still: joined by their hull.
  const islands = base.decompose();
  const apart = islands.length > 1;
  for (const island of islands) island.delete();
  if (apart) base = swap(base, base.hull());
  const ring = foot.offset(Math.min(opts.pinRingMm, grow), 'Round', 2, SEGMENTS);
  foot.delete();
  const lidCs = base.mirror([0, 1]);
  const out = { base: base.toPolygons(), lid: lidCs.toPolygons(), pinRing: ring.toPolygons() };
  base.delete();
  lidCs.delete();
  ring.delete();
  return out;
}

function swap(old: CrossSection, next: CrossSection): CrossSection {
  old.delete();
  return next;
}

/** The outline as a prism spanning z in [zMin, zMax]. */
export function outlinePrism(wasm: ManifoldToplevel, outline: Outline, zMin: number, zMax: number): Manifold {
  const cs = new wasm.CrossSection(outline, 'Positive');
  const prism = wasm.Manifold.extrude(cs, zMax - zMin).translate([0, 0, zMin]);
  cs.delete();
  return prism;
}

/** A block of the box's size cut to the outline (or the box itself when there is none). */
export function fittedBlock(
  wasm: ManifoldToplevel,
  box: Manifold,
  outline: Outline | null | undefined,
  zMin: number,
  zMax: number,
): Manifold {
  if (!outline) return box;
  const prism = outlinePrism(wasm, outline, zMin - 1, zMax + 1);
  const cut = box.intersect(prism);
  box.delete();
  prism.delete();
  return cut;
}

/** A half built as triangles (the heightfield mold) cut to the outline. */
export function trimTriangles(
  wasm: ManifoldToplevel,
  tris: Triangle3D[],
  outline: Outline | null | undefined,
): Triangle3D[] {
  if (!outline || tris.length === 0) return tris;
  const flat = new Float64Array(tris.length * 9);
  let zMin = Infinity, zMax = -Infinity;
  tris.forEach((t, i) => {
    flat.set([...t.a, ...t.b, ...t.c], i * 9);
    zMin = Math.min(zMin, t.a[2], t.b[2], t.c[2]);
    zMax = Math.max(zMax, t.a[2], t.b[2], t.c[2]);
  });
  const { part: half } = buildPartManifold(wasm, flat);
  if (!half) return tris;
  const prism = outlinePrism(wasm, outline, zMin - 1, zMax + 1);
  const cut = half.intersect(prism);
  half.delete();
  prism.delete();
  const out = manifoldToTriangles(cut);
  cut.delete();
  return out.length ? out : tris;
}

/**
 * Four registration pins on the ring, well-spaced around concave or L-shaped
 * outlines as well as convex ones, with one pin shifted along the ring by
 * `keyMm` (while keeping >= `minSepMm` from every other pin) so the halves
 * close one way only.
 */
export function pinsOnRing(ring: Outline, keyMm: number, minSepMm = Math.max(keyMm, (keyMm - 1) * 1.25)): Array<[number, number]> {
  const loop = ring.reduce((best, l) => (Math.abs(signedArea(l)) > Math.abs(signedArea(best)) ? l : best)) as unknown as number[][];
  const n = loop.length;
  if (n < 4) return loop.map((p) => [p[0], p[1]] as [number, number]);
  const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const extreme = (sx: number, sy: number) => {
    let bi = 0, bv = -Infinity;
    loop.forEach((p, i) => {
      const v = sx * p[0] + sy * p[1];
      if (v > bv) { bv = v; bi = i; }
    });
    return bi;
  };
  let picks = [extreme(-1, -1), extreme(1, -1), extreme(1, 1), extreme(-1, 1)];
  const at = (i: number): [number, number] => [loop[i][0], loop[i][1]];

  // On concave L- or T-shapes, two diagonal extremes can land on the same arm tip.
  // Replace any pick closer than 1.5 * minSepMm to an earlier pick with the loop
  // vertex farthest from all kept picks, then sort in ring order.
  const kept: number[] = [];
  for (const idx of picks) {
    if (kept.every((k) => dist(loop[idx], loop[k]) >= minSepMm * 1.5)) kept.push(idx);
  }
  while (kept.length < 4) {
    let bestIdx = 0;
    let bestClear = -1;
    for (let i = 0; i < n; i++) {
      const d = kept.length ? Math.min(...kept.map((k) => dist(loop[i], loop[k]))) : Infinity;
      if (d > bestClear) {
        bestClear = d;
        bestIdx = i;
      }
    }
    kept.push(bestIdx);
  }
  picks = kept.sort((a, b) => a - b);

  const walkBy = (start: number, step: 1 | -1, mm: number): number => {
    let i = start, walked = 0;
    while (walked < mm) {
      const j = (i + step + n) % n;
      walked += dist(loop[j], loop[i]);
      i = j;
      if (i === start) break;
    }
    return i;
  };
  const minPairDist = (pts: Array<[number, number]>) => {
    let m = Infinity;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) m = Math.min(m, dist(pts[a], pts[b]));
    }
    return m;
  };
  const rotMiss = (pts: Array<[number, number]>) =>
    // Keying against 180° reversal about the mold half's origin (0, 0).
    Math.max(...pts.map(([x, y]) => Math.min(...pts.map(([sx, sy]) => Math.hypot(-x - sx, -y - sy)))));

  let bestPts: Array<[number, number]> | null = null;
  let bestClear = -Infinity;
  for (let k = 0; k < 4; k++) {
    for (const dir of [1, -1] as const) {
      const moved = picks.map((idx, m) => at(m === k ? walkBy(idx, dir, keyMm) : idx));
      const clear = minPairDist(moved);
      const asym = rotMiss(moved);
      if (clear >= minSepMm && asym >= keyMm * 0.5) return moved;
      const score = clear + (asym >= keyMm * 0.4 ? 0 : -100);
      if (score > bestClear) {
        bestClear = score;
        bestPts = moved;
      }
    }
  }
  return bestPts ?? picks.map(at);
}

/**
 * Pry notches at the outline's extremes along `axis` ('x' by default; 'y' when
 * separable clamping rails occupy the ±X long edges), 1 mm in from the edge.
 */
export function notchesOnOutline(outline: Outline, axis: 'x' | 'y' = 'x'): Array<[number, number]> {
  const pts = outline.flat() as unknown as number[][];
  const c = axis === 'x' ? 0 : 1;
  let lo = pts[0], hi = pts[0];
  for (const p of pts) {
    if (p[c] < lo[c]) lo = p;
    if (p[c] > hi[c]) hi = p;
  }
  return axis === 'x'
    ? [[hi[0] - 1, hi[1]], [lo[0] + 1, lo[1]]]
    : [[hi[0], hi[1] - 1], [lo[0], lo[1] + 1]];
}
