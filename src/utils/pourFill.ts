// ---------------------------------------------------------------------------
// Pouring with air in the mold: what a closed mold actually fills
// ---------------------------------------------------------------------------
//
// The cast simulation filled every connected void, so a mold whose epoxy
// never got past the first layer still simulated a perfect casting. A lined
// gear sculpture did exactly that: poured from the top, the epoxy covered the
// only ways the air under it had out, and the deep half took none at all.
//
// So the cavity is voxelised, standing as it is poured (+z up), and filled
// the way liquid fills it:
//
//  - It goes in at the pour opening (the widest opening on the mold's top,
//    the sprue's funnel) and always to the lowest cell it can reach next:
//    down first, then up as a rising level.
//  - A cell fills only while its air can still get out: air cells connected,
//    through air, to an opening on top that is not itself under liquid.
//    Air cut off from every opening stays, a bubble, and the liquid with it.
//  - Where the cavity is narrower than a bubble can rise through
//    (castMaterials.ts bubbleRiseMm, about 3.5 mm for resin), surface tension
//    makes the liquid advance across the whole passage, not trickle down one
//    side of it, so air cannot slip past it the other way.
//
// Quasi-static and incompressible: a bubble stays the size it was trapped.
// ---------------------------------------------------------------------------

import { castColumnSpans } from './columnSolid';

export interface FillDomain {
  cols: number;
  rows: number;
  layers: number;
  /** Cell edge, mm. */
  cell: number;
  /** Centre of cell (0, 0, 0), mm. */
  x0: number;
  y0: number;
  z0: number;
  /** 1 where the cavity is, index (k * rows + r) * cols + c. */
  inside: Uint8Array;
}

export interface TrappedPocket {
  /** Highest point of the pocket, mm, in the frame the cavity was given in. */
  topMm: [number, number, number];
  volumeMm3: number;
}

export interface FillResult {
  /** 1 where liquid got to. */
  wet: Uint8Array;
  /** Share of the cavity's volume that filled. */
  filledShare: number;
  /** Air left in, largest first. */
  pockets: TrappedPocket[];
  trappedMm3: number;
}

/** The cavity of a closed solid (flat xyz triangles, mm) on cells of `cell` mm. */
export function voxelizeCavity(trisMm: Float64Array, cell: number): FillDomain {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < trisMm.length; i += 3) {
    minX = Math.min(minX, trisMm[i]); maxX = Math.max(maxX, trisMm[i]);
    minY = Math.min(minY, trisMm[i + 1]); maxY = Math.max(maxY, trisMm[i + 1]);
    minZ = Math.min(minZ, trisMm[i + 2]); maxZ = Math.max(maxZ, trisMm[i + 2]);
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell));
  const layers = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const x0 = minX + cell / 2, y0 = minY + cell / 2, z0 = minZ + cell / 2;
  const spans = castColumnSpans(trisMm, { minX: x0, minY: y0, stepX: cell, stepY: cell, cols, rows });
  const inside = new Uint8Array(cols * rows * layers);
  const plane = cols * rows;
  for (let k2 = 0; k2 < plane; k2++) {
    for (let s = spans.offset[k2]; s < spans.offset[k2 + 1]; s += 2) {
      const lo = Math.max(0, Math.ceil((spans.z[s] - z0) / cell));
      const hi = Math.min(layers - 1, Math.floor((spans.z[s + 1] - z0) / cell));
      for (let k = lo; k <= hi; k++) inside[k * plane + k2] = 1;
    }
  }
  return { cols, rows, layers, cell, x0, y0, z0, inside };
}

/** Chamfer distance (26 neighbours, a sweep each way) from every cell to the nearest cell where `seed` is 1, mm. */
function chamferDistance(d: FillDomain, seed: (i: number) => boolean): Float32Array {
  const { cols, rows, layers, cell } = d;
  const plane = cols * rows;
  const n = plane * layers;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = seed(i) ? 0 : Infinity;
  const fwd: Array<[number, number, number, number]> = [];
  for (let dk = -1; dk <= 1; dk++) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dk < 0 || (dk === 0 && (dr < 0 || (dr === 0 && dc < 0)))) fwd.push([dc, dr, dk, Math.hypot(dc, dr, dk) * cell]);
  }
  {
    for (const sign of [1, -1]) {
      for (let s = 0; s < n; s++) {
        const i = sign > 0 ? s : n - 1 - s;
        let best = dist[i];
        if (best === 0) continue;
        const k = Math.floor(i / plane), rem = i - k * plane, r = Math.floor(rem / cols), c = rem - r * cols;
        for (const [dc, dr, dk, w] of fwd) {
          const cc = c + dc * sign, rr = r + dr * sign, kk = k + dk * sign;
          if (cc < 0 || rr < 0 || kk < 0 || cc >= cols || rr >= rows || kk >= layers) continue;
          const v = dist[(kk * rows + rr) * cols + cc] + w;
          if (v < best) best = v;
        }
        dist[i] = best;
      }
    }
  }
  return dist;
}

/**
 * Where a bubble cannot rise: cells of the cavity no ball `bubbleRiseMm` across
 * fits over (the cavity less its morphological opening by that ball).
 */
export function narrowCells(d: FillDomain, bubbleRiseMm: number): Uint8Array {
  const r = bubbleRiseMm / 2;
  const toWall = chamferDistance(d, (i) => d.inside[i] === 0);
  // Centres of balls that fit, then everything within a ball of one.
  const toCore = chamferDistance(d, (i) => d.inside[i] === 1 && toWall[i] >= r);
  const narrow = new Uint8Array(d.inside.length);
  for (let i = 0; i < narrow.length; i++) narrow[i] = d.inside[i] && toCore[i] > r ? 1 : 0;
  return narrow;
}

const AIR = 0, WET = 1, TRAPPED = 2;

/**
 * Pours into the cavity from its widest opening on top and says what fills.
 * `bubbleRiseMm` is the liquid's (castMaterials.ts).
 */
export function simulateFill(d: FillDomain, bubbleRiseMm: number): FillResult {
  const { cols, rows, layers, cell, inside } = d;
  const plane = cols * rows;
  const n = plane * layers;
  const total = inside.reduce((s, v) => s + v, 0);
  const empty: FillResult = { wet: new Uint8Array(n), filledShare: 0, pockets: [], trappedMm3: 0 };
  if (total === 0) return empty;

  // Openings: cavity reaching the top layer, which is the mold's top face.
  let topK = -1;
  for (let i = n - 1; i >= 0 && topK < 0; i--) if (inside[i]) topK = Math.floor(i / plane);
  const opening = new Uint8Array(n);
  for (let k = Math.max(0, topK - 1); k <= topK; k++) {
    for (let j = 0; j < plane; j++) {
      const i = k * plane + j;
      if (inside[i] && (k === layers - 1 || !inside[i + plane])) opening[i] = 1;
    }
  }
  const neighbours = (i: number, out: number[]) => {
    out.length = 0;
    const k = Math.floor(i / plane), rem = i - k * plane, r = Math.floor(rem / cols), c = rem - r * cols;
    if (c > 0) out.push(i - 1);
    if (c < cols - 1) out.push(i + 1);
    if (r > 0) out.push(i - cols);
    if (r < rows - 1) out.push(i + cols);
    if (k > 0) out.push(i - plane);
    if (k < layers - 1) out.push(i + plane);
  };
  const nb: number[] = [];
  const nb2: number[] = [];

  // The pour goes in at the widest of them.
  const seen = new Uint8Array(n);
  let entry: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!opening[i] || seen[i]) continue;
    const group: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      group.push(j);
      neighbours(j, nb2);
      for (const q of nb2) {
        if (seen[q] || !opening[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (group.length > entry.length) entry = group;
  }

  const narrow = narrowCells(d, bubbleRiseMm);
  const state = new Uint8Array(n); // AIR, WET, TRAPPED
  const queued = new Uint8Array(n);
  const airOpen = new Uint8Array(n);
  const buckets: number[][] = Array.from({ length: layers }, () => []);
  let low = layers;

  const push = (from: number) => {
    neighbours(from, nb);
    for (const q of nb) {
      if (!inside[q] || state[q] !== AIR) continue;
      if (queued[q]) continue;
      queued[q] = 1;
      const k = Math.floor(q / plane);
      buckets[k].push(q);
      if (k < low) low = k;
    }
  };

  // Air that can still get out: through air, to an opening not under liquid.
  const recomputeAir = () => {
    airOpen.fill(0);
    const stack: number[] = [];
    for (let i = 0; i < n; i++) if (opening[i] && state[i] === AIR) { airOpen[i] = 1; stack.push(i); }
    while (stack.length) {
      const j = stack.pop()!;
      neighbours(j, nb2);
      for (const q of nb2) {
        if (!inside[q] || airOpen[q] || state[q] !== AIR) continue;
        airOpen[q] = 1;
        stack.push(q);
      }
    }
  };

  let wetCount = 0;
  const wet = (i: number) => {
    state[i] = WET;
    wetCount++;
  };
  // A stream into the middle of it: the rest of the mouth is air, and lets
  // air out past the stream unless the sprue is too narrow for that, when the
  // liquid fills it across (below).
  let sx = 0, sy = 0;
  for (const i of entry) { const rem = i % plane; sx += rem % cols; sy += Math.floor(rem / cols); }
  sx /= entry.length;
  sy /= entry.length;
  const pourAt = entry.reduce((best, i) => {
    const rem = i % plane, bRem = best % plane;
    return Math.hypot((rem % cols) - sx, Math.floor(rem / cols) - sy) < Math.hypot((bRem % cols) - sx, Math.floor(bRem / cols) - sy) ? i : best;
  }, entry[0]);
  wet(pourAt);
  push(pourAt);

  // A narrow passage fills across its whole width: every narrow air cell
  // within the bubble size of where the liquid came in, through narrow cells.
  // A narrow passage is under that across, so this spans it from either wall.
  const reach = bubbleRiseMm;
  const front = (start: number, out: number[]) => {
    const sk = Math.floor(start / plane), srem = start - sk * plane, sr = Math.floor(srem / cols), sc = srem - sr * cols;
    const stack = [start];
    const visited = new Set<number>([start]);
    while (stack.length) {
      const j = stack.pop()!;
      neighbours(j, nb2);
      for (const q of nb2) {
        if (visited.has(q) || !narrow[q] || state[q] !== AIR) continue;
        const k = Math.floor(q / plane), rem = q - k * plane, r = Math.floor(rem / cols), c = rem - r * cols;
        // Never above the level it came in at: that would have the liquid
        // close a vent before the air under it is out.
        if (k > sk || Math.hypot(c - sc, r - sr, k - sk) * cell > reach) continue;
        visited.add(q);
        out.push(q);
        stack.push(q);
      }
    }
  };

  // Which air can still get out is worked out again as the level rises into
  // each layer, never partway through one: liquid rising under a flat ceiling
  // meets it everywhere at once, and deciding cell by cell cut off films of
  // air that in fact squeeze out. Also on moving down a layer once liquid has
  // closed across a narrow passage, or after a good many cells regardless.
  const every = Math.max(200, Math.round(total / 100));
  let sinceAir = 0;
  let airLayer = -1;
  let closed = false;
  const added: number[] = [];
  while (low < layers) {
    const bucket = buckets[low];
    if (bucket.length === 0) {
      low++;
      continue;
    }
    const i = bucket.pop()!;
    queued[i] = 0;
    if (state[i] !== AIR) continue;
    if (low !== airLayer && (low > airLayer || closed || sinceAir >= every)) {
      recomputeAir();
      sinceAir = 0;
      airLayer = low;
      closed = false;
    }
    if (!airOpen[i]) {
      state[i] = TRAPPED;
      continue;
    }
    wet(i);
    sinceAir++;
    push(i);
    if (narrow[i]) {
      added.length = 0;
      front(i, added);
      for (const q of added) {
        // Only air that can still get out is displaced; a sealed bubble stays.
        if (!airOpen[q]) continue;
        wet(q);
        sinceAir++;
        closed = true;
      }
      for (const q of added) if (state[q] === WET) push(q);
    }
  }

  // What is left is air: pockets of it, by connected piece.
  const left = new Uint8Array(n);
  let trappedCells = 0;
  for (let i = 0; i < n; i++) if (inside[i] && state[i] !== WET) { left[i] = 1; trappedCells++; }
  const pockets: TrappedPocket[] = [];
  const done = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!left[i] || done[i]) continue;
    let count = 0, topI = i;
    const stack = [i];
    done[i] = 1;
    while (stack.length) {
      const j = stack.pop()!;
      count++;
      if (j > topI) topI = j;
      neighbours(j, nb2);
      for (const q of nb2) {
        if (!left[q] || done[q]) continue;
        done[q] = 1;
        stack.push(q);
      }
    }
    const k = Math.floor(topI / plane), rem = topI - k * plane, r = Math.floor(rem / cols), c = rem - r * cols;
    pockets.push({ topMm: [d.x0 + c * cell, d.y0 + r * cell, d.z0 + k * cell], volumeMm3: count * cell ** 3 });
  }
  pockets.sort((a, b) => b.volumeMm3 - a.volumeMm3);
  const wetMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) wetMask[i] = state[i] === WET ? 1 : 0;
  return {
    wet: wetMask,
    filledShare: wetCount / total,
    pockets,
    trappedMm3: trappedCells * cell ** 3,
  };
}

/** A cell size for a cavity this big: 0.2 mm, or coarser to stay under about two million cells. */
export function fillCellMm(sizeMm: [number, number, number]): number {
  const [w, d, h] = sizeMm;
  return Math.max(0.2, Math.cbrt((w * d * h) / 2e6));
}
