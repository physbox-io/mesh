// Toy bricks: a shape built from interlocking studded bricks on an 8 mm grid.
//
// Each course is a grid of stud cells; a cell is the shape's if a quarter of
// it is inside the slice, so a thin board still gets a row of bricks. The
// cells are filled biggest brick first from the sizes allowed. Alternate
// courses run the other way and scan from the other side, and a brick whose
// end would sit on a seam in the course below is passed over for one that
// spans it, so the courses lock together as a builder would make them.
//
// Millimetres; no mortar. Each brick is 0.2 mm short of its grid, as real
// ones are, so neighbours do not touch.

import type { PlacedBrick } from './brickwork';

export const TOY_PITCH_MM = 8;
export const TOY_HEIGHT_MM = 9.6;
const TOY_GAP_MM = 0.2;

/** Studs across × studs along. */
export const TOY_SIZES = ['1x1', '1x2', '1x3', '1x4', '1x6', '1x8', '2x2', '2x3', '2x4', '2x6', '2x8'] as const;
export type ToySize = (typeof TOY_SIZES)[number];
export const DEFAULT_TOY_SIZES: ToySize[] = [...TOY_SIZES];

const dims = (s: ToySize): [number, number] => s.split('x').map(Number) as [number, number];

export interface ToyLayout {
  bricks: PlacedBrick[];
  parts: { size: ToySize; count: number }[];
}

/**
 * Lays the courses. `solidAt(c)` is the slice of course c (or null for none);
 * `lo`/`hi` its plan bounds, mm.
 */
export function layToyBricks(args: {
  lo: [number, number];
  hi: [number, number];
  courses: number;
  zBase: number;
  solidAt: (course: number) => ((p: { x: number; y: number }) => boolean) | null;
  sizes: ToySize[];
  maxBricks: number;
}): ToyLayout {
  const P = TOY_PITCH_MM;
  const nx = Math.max(1, Math.ceil((args.hi[0] - args.lo[0]) / P));
  const ny = Math.max(1, Math.ceil((args.hi[1] - args.lo[1]) / P));
  // Always a 1×1 to finish with, whatever was chosen: every cell gets a brick.
  const chosen = args.sizes.filter((s) => TOY_SIZES.includes(s));
  const sizes = [...new Set<ToySize>([...chosen, '1x1'])]
    .map((s) => ({ s, d: dims(s) }))
    .sort((a, b) => b.d[0] * b.d[1] - a.d[0] * a.d[1] || b.d[1] - a.d[1]);

  const bricks: PlacedBrick[] = [];
  const counts = new Map<ToySize, number>();
  let below: Int32Array | null = null;
  let id = 0;

  for (let c = 0; c < args.courses; c++) {
    const inside = args.solidAt(c);
    if (!inside) { below = null; continue; }
    // Which cells are the shape's: a quarter of 4 × 4 samples inside.
    const want = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let hits = 0;
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) {
            if (inside({ x: args.lo[0] + (i + (a + 0.5) / 4) * P, y: args.lo[1] + (j + (b + 0.5) / 4) * P })) hits++;
          }
        }
        if (hits >= 4) want[j * nx + i] = 1;
      }
    }
    const owner = new Int32Array(nx * ny);
    const along = c % 2 === 0; // long side along X on even courses
    const free = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && want[j * nx + i] === 1 && owner[j * nx + i] === 0;
    const seamBelow = (i0: number, j0: number, i1: number, j1: number) =>
      !!below && below[j0 * nx + i0] > 0 && below[j1 * nx + i1] > 0 && below[j0 * nx + i0] !== below[j1 * nx + i1];

    // Even courses scan rows from one side, odd ones columns from the other.
    const cells: [number, number][] = [];
    if (c % 2 === 0) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cells.push([i, j]);
    else for (let i = nx - 1; i >= 0; i--) for (let j = 0; j < ny; j++) cells.push([i, j]);

    for (const [ai, aj] of cells) {
      if (!free(ai, aj)) continue;
      let best: { w: number; h: number; i: number; j: number; size: ToySize; score: number } | null = null;
      for (const { s, d } of sizes) {
        for (const [w, h] of d[0] === d[1] ? [[d[0], d[1]]] : [[d[1], d[0]], [d[0], d[1]]]) {
          // Anchored at the cell, growing away from where the scan came from.
          const i0 = c % 2 === 0 ? ai : ai - w + 1;
          const j0 = aj;
          let ok = true;
          for (let j = j0; ok && j < j0 + h; j++) for (let i = i0; ok && i < i0 + w; i++) if (!free(i, j)) ok = false;
          if (!ok) continue;
          // Ends and sides that land on a seam in the course below.
          let seams = 0;
          for (let j = j0; j < j0 + h; j++) {
            if (seamBelow(i0 - 1, j, i0, j)) seams++;
            if (seamBelow(i0 + w - 1, j, i0 + w, j)) seams++;
          }
          for (let i = i0; i < i0 + w; i++) {
            if (seamBelow(i, j0 - 1, i, j0)) seams++;
            if (seamBelow(i, j0 + h - 1, i, j0 + h)) seams++;
          }
          const preferred = along ? w >= h : h >= w;
          const score = w * h * 10 - seams * 2 + (preferred ? 1 : 0);
          if (!best || score > best.score) best = { w, h, i: i0, j: j0, size: s, score };
        }
      }
      if (!best) continue;
      id++;
      for (let j = best.j; j < best.j + best.h; j++) for (let i = best.i; i < best.i + best.w; i++) owner[j * nx + i] = id;
      bricks.push({
        course: c,
        x: args.lo[0] + (best.i + best.w / 2) * P,
        y: args.lo[1] + (best.j + best.h / 2) * P,
        z: args.zBase + c * TOY_HEIGHT_MM,
        angle: 0,
        lengthMm: best.w * P - TOY_GAP_MM,
        depthMm: best.h * P - TOY_GAP_MM,
        header: false,
        closer: false,
        cut: false,
      });
      counts.set(best.size, (counts.get(best.size) ?? 0) + 1);
      if (bricks.length > args.maxBricks) {
        throw new Error(`That is more than ${args.maxBricks.toLocaleString()} toy bricks. Build one part at a time (select it first), or scale the shape down.`);
      }
    }
    below = owner;
  }

  return {
    bricks,
    parts: TOY_SIZES.filter((s) => counts.has(s)).reverse().map((size) => ({ size, count: counts.get(size)! })),
  };
}
