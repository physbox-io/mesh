// ---------------------------------------------------------------------------
// A cross-section through the scene's parts, as numbers
// ---------------------------------------------------------------------------
//
// What a screenshot cannot show: how thick a wall is inside, where a handle
// necks down to nearly nothing where it joins, a pocket that does not reach.
// The parts are cut by a plane square to one world axis, and each piece of
// the cut comes back with its outline, its area, its holes, the widest it is
// (twice the largest circle that fits) and, where it pinches, how wide the
// pinch is (the narrowest neck that, shrunk, parts it in two).
//
// Lengths are millimetres in the world frame, Z up. PURE.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { buildPartManifold } from './moldManifold';

export type SectionAxis = 'x' | 'y' | 'z';

export interface SectionPiece {
  areaMm2: number;
  /** Extent on the plane, in its own two axes (see SectionResult.axes). */
  boundsMm: { u: [number, number]; v: [number, number] };
  holes: number;
  /** Twice the largest circle that fits in it: its thickest, mm. */
  thickestMm: number;
  /** Where it pinches: the narrowest neck that parts it when shrunk, mm. Absent when nothing does. */
  neckMm?: number;
  /** Outer outline then each hole's, as [u, v] points. */
  loops: [number, number][][];
}

export interface SectionResult {
  axis: SectionAxis;
  atMm: number;
  /** The plane's two axes: the world axes [u, v] map to. */
  axes: [SectionAxis, SectionAxis];
  /** The parts' extent along the axis, so a caller can choose where to cut. */
  spanMm: [number, number];
  pieces: SectionPiece[];
  totalAreaMm2: number;
  /** The outlines were simplified to this, mm, to stay readable. */
  toleranceMm: number;
}

/** World axis order for each cut: [u, v, w], w along the cut's normal, a right-handed turn. */
const FRAMES: Record<SectionAxis, [SectionAxis, SectionAxis, SectionAxis]> = {
  z: ['x', 'y', 'z'],
  x: ['y', 'z', 'x'],
  y: ['z', 'x', 'y'],
};
const INDEX: Record<SectionAxis, number> = { x: 0, y: 1, z: 2 };

/**
 * The parts as one closed solid (each solid of a triangle soup, 9 numbers a
 * triangle, mm, joined where they overlap), turned so `axis` is up.
 */
function solidAlong(wasm: ManifoldToplevel, soup: ArrayLike<number>, axis: SectionAxis, solidIds?: number[]): Manifold | null {
  const [u, v, w] = FRAMES[axis].map((a) => INDEX[a]);
  const n = soup.length / 3;
  const turned = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    turned[i * 3] = soup[i * 3 + u];
    turned[i * 3 + 1] = soup[i * 3 + v];
    turned[i * 3 + 2] = soup[i * 3 + w];
  }
  return buildPartManifold(wasm, turned, solidIds).part;
}

const area = (c: readonly (readonly number[])[]) => {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

/** The largest r the piece still has something left at, shrunk by r: half its thickest. */
function inscribed(piece: CrossSection, hi: number): number {
  let lo = 0;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    const s = piece.offset(-mid, 'Round', 2, 24);
    const left = !s.isEmpty();
    s.delete();
    if (left) lo = mid; else hi = mid;
  }
  return lo;
}

/** The smallest r that parts the piece in two when it is shrunk by r, below `max`; null when none does. */
function neck(piece: CrossSection, max: number): number | null {
  const parts = (r: number) => {
    const s = piece.offset(-r, 'Round', 2, 24);
    // A crumb a hair across is the rounding of a corner, not a second piece.
    const n = s.decompose().filter((p) => { const a = p.area(); p.delete(); return a > 1e-3; }).length;
    s.delete();
    return n;
  };
  const steps = 24;
  let prev = 0;
  for (let k = 1; k <= steps; k++) {
    const r = (max * k) / steps;
    if (parts(r) > 1) {
      let lo = prev, hi = r;
      for (let j = 0; j < 14; j++) {
        const mid = (lo + hi) / 2;
        if (parts(mid) > 1) hi = mid; else lo = mid;
      }
      return hi;
    }
    prev = r;
  }
  return null;
}

/**
 * The section of a closed triangle soup (mm, world frame) by the plane square
 * to `axis` at `atMm` along it (default: half way through the parts).
 */
export function sectionOfSoup(
  wasm: ManifoldToplevel,
  soup: ArrayLike<number>,
  axis: SectionAxis = 'z',
  atMm?: number,
  maxPoints = 2000,
  solidIds?: number[],
): SectionResult {
  const solid = solidAlong(wasm, soup, axis, solidIds);
  if (!solid) throw new Error('The parts are not closed solids, so they have no inside to cut through; repair them first.');
  const bin: (Manifold | CrossSection)[] = [solid];
  try {
    if (solid.status() !== 'NoError' || solid.isEmpty()) throw new Error('The parts are not closed solids, so they have no inside to cut through; repair them first.');
    const b = solid.boundingBox();
    const span: [number, number] = [b.min[2], b.max[2]];
    const at = atMm ?? (span[0] + span[1]) / 2;
    const raw = solid.slice(at);
    bin.push(raw);
    // Simplified until the outlines are readable at a glance.
    let tol = 0.02, cut = raw.simplify(tol);
    bin.push(cut);
    const count = (cs: CrossSection) => cs.toPolygons().reduce((s, c) => s + c.length, 0);
    while (count(cut) > maxPoints && tol < 5) {
      tol *= 2.5;
      cut = raw.simplify(tol);
      bin.push(cut);
    }
    const pieces: SectionPiece[] = [];
    for (const piece of cut.decompose()) {
      bin.push(piece);
      const polys = piece.toPolygons();
      const outer = polys.filter((c) => area(c) > 0);
      const holes = polys.filter((c) => area(c) < 0);
      const pb = piece.bounds();
      const half = Math.max(pb.max[0] - pb.min[0], pb.max[1] - pb.min[1]) / 2 + 1;
      const r = inscribed(piece, half);
      const nk = neck(piece, r * 0.98);
      const round = (p: readonly number[]): [number, number] => [+p[0].toFixed(2), +p[1].toFixed(2)];
      pieces.push({
        areaMm2: +piece.area().toFixed(2),
        boundsMm: { u: [+pb.min[0].toFixed(2), +pb.max[0].toFixed(2)], v: [+pb.min[1].toFixed(2), +pb.max[1].toFixed(2)] },
        holes: holes.length,
        thickestMm: +(2 * r).toFixed(2),
        ...(nk !== null ? { neckMm: +(2 * nk).toFixed(2) } : {}),
        loops: [...outer, ...holes].map((c) => c.map(round)),
      });
    }
    pieces.sort((p, q) => q.areaMm2 - p.areaMm2);
    const [u, v] = FRAMES[axis];
    return {
      axis,
      atMm: +at.toFixed(3),
      axes: [u, v],
      spanMm: [+span[0].toFixed(2), +span[1].toFixed(2)],
      pieces,
      totalAreaMm2: +pieces.reduce((s, p) => s + p.areaMm2, 0).toFixed(2),
      toleranceMm: tol,
    };
  } finally {
    for (const o of bin) {
      try { o.delete(); } catch { /* already freed */ }
    }
  }
}
