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

/** Chamfer distance (26 neighbours, a sweep each way) from every cell to the nearest cell where `seedMask[i]` is 1, mm. */
function chamferDistance(d: FillDomain, seedMask: Uint8Array): Float32Array {
  const { cols, rows, layers, cell } = d;
  const plane = cols * rows;
  const n = plane * layers;
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = seedMask[i] ? 0 : Infinity;

  const off = new Int32Array(13);
  const dcArr = new Int32Array(13);
  const drArr = new Int32Array(13);
  const dkArr = new Int32Array(13);
  const wArr = new Float32Array(13);
  let m = 0;
  for (let dk = -1; dk <= 0; dk++) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dk < 0 || dr < 0 || (dr === 0 && dc < 0)) {
          off[m] = dk * plane + dr * cols + dc;
          dcArr[m] = dc;
          drArr[m] = dr;
          dkArr[m] = dk;
          wArr[m] = Math.hypot(dc, dr, dk) * cell;
          m++;
        }
      }
    }
  }

  // Forward sweep
  for (let k = 0; k < layers; k++) {
    const kIn = k > 0 && k < layers - 1;
    const kBase = k * plane;
    for (let r = 0; r < rows; r++) {
      const krIn = kIn && r > 0 && r < rows - 1;
      const rowBase = kBase + r * cols;
      if (krIn && cols > 2) {
        // c = 0 border
        {
          const i = rowBase;
          let best = dist[i];
          if (best !== 0) {
            for (let j = 0; j < 13; j++) {
              const cc = dcArr[j];
              if (cc < 0) continue;
              const v = dist[i + off[j]] + wArr[j];
              if (v < best) best = v;
            }
            dist[i] = best;
          }
        }
        // Fast interior span: zero bounds checks
        const iEnd = rowBase + cols - 1;
        for (let i = rowBase + 1; i < iEnd; i++) {
          let best = dist[i];
          if (best === 0) continue;
          for (let j = 0; j < 13; j++) {
            const v = dist[i + off[j]] + wArr[j];
            if (v < best) best = v;
          }
          dist[i] = best;
        }
        // c = cols - 1 border
        {
          const i = iEnd;
          let best = dist[i];
          if (best !== 0) {
            for (let j = 0; j < 13; j++) {
              const cc = cols - 1 + dcArr[j];
              if (cc >= cols) continue;
              const v = dist[i + off[j]] + wArr[j];
              if (v < best) best = v;
            }
            dist[i] = best;
          }
        }
      } else {
        for (let c = 0; c < cols; c++) {
          const i = rowBase + c;
          let best = dist[i];
          if (best === 0) continue;
          for (let j = 0; j < 13; j++) {
            const cc = c + dcArr[j], rr = r + drArr[j], kk = k + dkArr[j];
            if (cc < 0 || rr < 0 || kk < 0 || cc >= cols || rr >= rows) continue;
            const v = dist[i + off[j]] + wArr[j];
            if (v < best) best = v;
          }
          dist[i] = best;
        }
      }
    }
  }

  // Backward sweep
  for (let k = layers - 1; k >= 0; k--) {
    const kIn = k > 0 && k < layers - 1;
    const kBase = k * plane;
    for (let r = rows - 1; r >= 0; r--) {
      const krIn = kIn && r > 0 && r < rows - 1;
      const rowBase = kBase + r * cols;
      if (krIn && cols > 2) {
        // c = cols - 1 border
        {
          const i = rowBase + cols - 1;
          let best = dist[i];
          if (best !== 0) {
            for (let j = 0; j < 13; j++) {
              const cc = cols - 1 - dcArr[j];
              if (cc >= cols) continue;
              const v = dist[i - off[j]] + wArr[j];
              if (v < best) best = v;
            }
            dist[i] = best;
          }
        }
        // Fast interior span: zero bounds checks
        for (let i = rowBase + cols - 2; i > rowBase; i--) {
          let best = dist[i];
          if (best === 0) continue;
          for (let j = 0; j < 13; j++) {
            const v = dist[i - off[j]] + wArr[j];
            if (v < best) best = v;
          }
          dist[i] = best;
        }
        // c = 0 border
        {
          const i = rowBase;
          let best = dist[i];
          if (best !== 0) {
            for (let j = 0; j < 13; j++) {
              if (-dcArr[j] < 0) continue;
              const v = dist[i - off[j]] + wArr[j];
              if (v < best) best = v;
            }
            dist[i] = best;
          }
        }
      } else {
        for (let c = cols - 1; c >= 0; c--) {
          const i = rowBase + c;
          let best = dist[i];
          if (best === 0) continue;
          for (let j = 0; j < 13; j++) {
            const cc = c - dcArr[j], rr = r - drArr[j], kk = k - dkArr[j];
            if (cc < 0 || rr < 0 || cc >= cols || rr >= rows || kk >= layers) continue;
            const v = dist[i - off[j]] + wArr[j];
            if (v < best) best = v;
          }
          dist[i] = best;
        }
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
  const { inside } = d;
  const n = inside.length;
  const r = bubbleRiseMm / 2;
  const wallSeed = new Uint8Array(n);
  for (let i = 0; i < n; i++) wallSeed[i] = inside[i] === 0 ? 1 : 0;
  const toWall = chamferDistance(d, wallSeed);

  // Centres of balls that fit, then everything within a ball of one.
  const coreSeed = new Uint8Array(n);
  let anyCore = false;
  for (let i = 0; i < n; i++) {
    if (inside[i] === 1 && toWall[i] >= r) {
      coreSeed[i] = 1;
      anyCore = true;
    }
  }
  if (!anyCore) return Uint8Array.from(inside);
  const toCore = chamferDistance(d, coreSeed);
  const narrow = new Uint8Array(n);
  for (let i = 0; i < n; i++) narrow[i] = inside[i] && toCore[i] > r ? 1 : 0;
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
  let total = 0;
  for (let i = 0; i < n; i++) total += inside[i];
  const empty: FillResult = { wet: new Uint8Array(n), filledShare: 0, pockets: [], trappedMm3: 0 };
  if (total === 0) return empty;

  // Precompute 6-neighbour cavity adjacency bitmask per cell so inner BFS loops
  // never divide, modulo, check bounds, or allocate temporary neighbour arrays.
  const adj = new Uint8Array(n);
  for (let k = 0; k < layers; k++) {
    const kBase = k * plane;
    for (let r = 0; r < rows; r++) {
      const rowBase = kBase + r * cols;
      for (let c = 0; c < cols; c++) {
        const i = rowBase + c;
        if (!inside[i]) continue;
        let m = 0;
        if (c > 0 && inside[i - 1]) m |= 1;
        if (c < cols - 1 && inside[i + 1]) m |= 2;
        if (r > 0 && inside[i - cols]) m |= 4;
        if (r < rows - 1 && inside[i + cols]) m |= 8;
        if (k > 0 && inside[i - plane]) m |= 16;
        if (k < layers - 1 && inside[i + plane]) m |= 32;
        adj[i] = m;
      }
    }
  }

  // Openings: cavity reaching the top layer, which is the mold's top face.
  let topK = -1;
  for (let i = n - 1; i >= 0 && topK < 0; i--) if (inside[i]) topK = (i / plane) | 0;
  const opening = new Uint8Array(n);
  const openingList: number[] = [];
  for (let k = Math.max(0, topK - 1); k <= topK; k++) {
    for (let j = 0; j < plane; j++) {
      const i = k * plane + j;
      if (inside[i] && (k === layers - 1 || !inside[i + plane])) {
        opening[i] = 1;
        openingList.push(i);
      }
    }
  }
  const openings = Int32Array.from(openingList);
  const openingCount = openings.length;
  if (openingCount === 0) return empty;

  const bfsQueue = new Int32Array(total + 1);

  // The pour goes in at the widest of them.
  const seen = new Uint8Array(n);
  let entryStart = 0, entryLen = 0;
  const entryBuf = new Int32Array(openingCount);
  let entryWrite = 0;
  for (let idx = 0; idx < openingCount; idx++) {
    const start = openings[idx];
    if (seen[start]) continue;
    const gStart = entryWrite;
    seen[start] = 1;
    let head = 0, tail = 0;
    bfsQueue[tail++] = start;
    while (head < tail) {
      const j = bfsQueue[head++];
      entryBuf[entryWrite++] = j;
      const m = adj[j];
      if ((m & 1) && opening[j - 1] && !seen[j - 1]) { seen[j - 1] = 1; bfsQueue[tail++] = j - 1; }
      if ((m & 2) && opening[j + 1] && !seen[j + 1]) { seen[j + 1] = 1; bfsQueue[tail++] = j + 1; }
      if ((m & 4) && opening[j - cols] && !seen[j - cols]) { seen[j - cols] = 1; bfsQueue[tail++] = j - cols; }
      if ((m & 8) && opening[j + cols] && !seen[j + cols]) { seen[j + cols] = 1; bfsQueue[tail++] = j + cols; }
      if ((m & 16) && opening[j - plane] && !seen[j - plane]) { seen[j - plane] = 1; bfsQueue[tail++] = j - plane; }
      if ((m & 32) && opening[j + plane] && !seen[j + plane]) { seen[j + plane] = 1; bfsQueue[tail++] = j + plane; }
    }
    const gLen = entryWrite - gStart;
    if (gLen > entryLen) {
      entryStart = gStart;
      entryLen = gLen;
    }
  }

  const narrow = narrowCells(d, bubbleRiseMm);
  const state = new Uint8Array(n); // AIR, WET, TRAPPED
  const queued = new Uint8Array(n);

  // Intrusive per-layer stacks (zero per-layer JS array allocations).
  const bucketHead = new Int32Array(layers).fill(-1);
  const bucketNext = new Int32Array(n).fill(-1);
  let low = layers;

  const enqueueCell = (q: number) => {
    if (state[q] !== AIR || queued[q]) return;
    queued[q] = 1;
    const k = (q / plane) | 0;
    bucketNext[q] = bucketHead[k];
    bucketHead[k] = q;
    if (k < low) low = k;
  };

  const push = (from: number) => {
    const m = adj[from];
    if (m & 1) enqueueCell(from - 1);
    if (m & 2) enqueueCell(from + 1);
    if (m & 4) enqueueCell(from - cols);
    if (m & 8) enqueueCell(from + cols);
    if (m & 16) enqueueCell(from - plane);
    if (m & 32) enqueueCell(from + plane);
  };

  // Air that can still get out: through air, to an opening not under liquid.
  const airStamp = new Uint32Array(n);
  let airGen = 0;
  const recomputeAir = () => {
    airGen++;
    let head = 0, tail = 0;
    for (let idx = 0; idx < openingCount; idx++) {
      const o = openings[idx];
      if (state[o] === AIR && airStamp[o] !== airGen) {
        airStamp[o] = airGen;
        bfsQueue[tail++] = o;
      }
    }
    while (head < tail) {
      const j = bfsQueue[head++];
      const m = adj[j];
      if ((m & 1) && state[j - 1] === AIR && airStamp[j - 1] !== airGen) { airStamp[j - 1] = airGen; bfsQueue[tail++] = j - 1; }
      if ((m & 2) && state[j + 1] === AIR && airStamp[j + 1] !== airGen) { airStamp[j + 1] = airGen; bfsQueue[tail++] = j + 1; }
      if ((m & 4) && state[j - cols] === AIR && airStamp[j - cols] !== airGen) { airStamp[j - cols] = airGen; bfsQueue[tail++] = j - cols; }
      if ((m & 8) && state[j + cols] === AIR && airStamp[j + cols] !== airGen) { airStamp[j + cols] = airGen; bfsQueue[tail++] = j + cols; }
      if ((m & 16) && state[j - plane] === AIR && airStamp[j - plane] !== airGen) { airStamp[j - plane] = airGen; bfsQueue[tail++] = j - plane; }
      if ((m & 32) && state[j + plane] === AIR && airStamp[j + plane] !== airGen) { airStamp[j + plane] = airGen; bfsQueue[tail++] = j + plane; }
    }
  };

  let wetCount = 0;
  const markWet = (i: number) => {
    state[i] = WET;
    wetCount++;
  };

  // A stream into the middle of it: the rest of the mouth is air, and lets
  // air out past the stream unless the sprue is too narrow for that, when the
  // liquid fills it across (below).
  let sx = 0, sy = 0;
  for (let idx = 0; idx < entryLen; idx++) {
    const i = entryBuf[entryStart + idx];
    const rem = i % plane;
    sx += rem % cols;
    sy += (rem / cols) | 0;
  }
  sx /= entryLen;
  sy /= entryLen;
  let pourAt = entryBuf[entryStart];
  let bestPourDist = Infinity;
  for (let idx = 0; idx < entryLen; idx++) {
    const i = entryBuf[entryStart + idx];
    const rem = i % plane;
    const dx = (rem % cols) - sx, dy = ((rem / cols) | 0) - sy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestPourDist) {
      bestPourDist = d2;
      pourAt = i;
    }
  }
  markWet(pourAt);
  push(pourAt);

  // A narrow passage fills across its whole width: every narrow air cell
  // within the bubble size of where the liquid came in, through narrow cells.
  const reachCellsSq = (bubbleRiseMm / cell) * (bubbleRiseMm / cell) + 1e-9;
  const frontStamp = new Uint32Array(n);
  let frontGen = 0;
  const qC = new Int32Array(total + 1);
  const qR = new Int32Array(total + 1);
  const qK = new Int32Array(total + 1);
  const addedBuf = new Int32Array(total + 1);

  const front = (start: number): number => {
    frontGen++;
    const sk = (start / plane) | 0;
    const srem = start - sk * plane;
    const sr = (srem / cols) | 0;
    const sc = srem - sr * cols;
    frontStamp[start] = frontGen;
    let head = 0, tail = 0, addedCount = 0;
    bfsQueue[0] = start;
    qC[0] = sc;
    qR[0] = sr;
    qK[0] = sk;
    tail = 1;

    const tryNb = (q: number, c: number, r: number, k: number) => {
      if (frontStamp[q] === frontGen || !narrow[q] || state[q] !== AIR) return;
      // Never above the level it came in at: that would have the liquid
      // close a vent before the air under it is out.
      if (k > sk) return;
      const dc = c - sc, dr = r - sr, dk = k - sk;
      if (dc * dc + dr * dr + dk * dk > reachCellsSq) return;
      frontStamp[q] = frontGen;
      if (airStamp[q] !== airGen) {
        state[q] = TRAPPED;
        return;
      }
      addedBuf[addedCount++] = q;
      bfsQueue[tail] = q;
      qC[tail] = c;
      qR[tail] = r;
      qK[tail] = k;
      tail++;
    };

    while (head < tail) {
      const j = bfsQueue[head];
      const jc = qC[head], jr = qR[head], jk = qK[head];
      head++;
      const m = adj[j];
      if (m & 1) tryNb(j - 1, jc - 1, jr, jk);
      if (m & 2) tryNb(j + 1, jc + 1, jr, jk);
      if (m & 4) tryNb(j - cols, jc, jr - 1, jk);
      if (m & 8) tryNb(j + cols, jc, jr + 1, jk);
      if (m & 16) tryNb(j - plane, jc, jr, jk - 1);
      if (m & 32) tryNb(j + plane, jc, jr, jk + 1);
    }
    return addedCount;
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
  while (low < layers) {
    const i = bucketHead[low];
    if (i < 0) {
      low++;
      continue;
    }
    bucketHead[low] = bucketNext[i];
    queued[i] = 0;
    if (state[i] !== AIR) continue;
    if (airGen === 0 || (sinceAir > 0 && low !== airLayer && (low > airLayer || closed || sinceAir >= every))) {
      recomputeAir();
      sinceAir = 0;
      airLayer = low;
      closed = false;
    } else if (low > airLayer) {
      airLayer = low;
    }
    if (airStamp[i] !== airGen) {
      state[i] = TRAPPED;
      continue;
    }
    markWet(i);
    sinceAir++;
    push(i);
    if (narrow[i]) {
      const addedCount = front(i);
      for (let a = 0; a < addedCount; a++) {
        const q = addedBuf[a];
        if (state[q] !== AIR || airStamp[q] !== airGen) continue;
        markWet(q);
        sinceAir++;
        closed = true;
      }
      for (let a = 0; a < addedCount; a++) {
        const q = addedBuf[a];
        if (state[q] === WET) push(q);
      }
    }
  }

  // What is left is air: pockets of it, by connected piece.
  // Isolated 1–2 cell stair-step pips (< 0.5 mm³) against curved walls are
  // voxelization boundary noise rather than physical bubbles, so absorb them.
  const cellVol = cell * cell * cell;
  const pockets: TrappedPocket[] = [];
  const done = new Uint8Array(n);
  let trappedCells = 0;
  for (let i = 0; i < n; i++) {
    if (!inside[i] || state[i] === WET || done[i]) continue;
    let head = 0, tail = 0, topI = i;
    done[i] = 1;
    bfsQueue[tail++] = i;
    while (head < tail) {
      const j = bfsQueue[head++];
      if (j > topI) topI = j;
      const m = adj[j];
      if ((m & 1) && state[j - 1] !== WET && !done[j - 1]) { done[j - 1] = 1; bfsQueue[tail++] = j - 1; }
      if ((m & 2) && state[j + 1] !== WET && !done[j + 1]) { done[j + 1] = 1; bfsQueue[tail++] = j + 1; }
      if ((m & 4) && state[j - cols] !== WET && !done[j - cols]) { done[j - cols] = 1; bfsQueue[tail++] = j - cols; }
      if ((m & 8) && state[j + cols] !== WET && !done[j + cols]) { done[j + cols] = 1; bfsQueue[tail++] = j + cols; }
      if ((m & 16) && state[j - plane] !== WET && !done[j - plane]) { done[j - plane] = 1; bfsQueue[tail++] = j - plane; }
      if ((m & 32) && state[j + plane] !== WET && !done[j + plane]) { done[j + plane] = 1; bfsQueue[tail++] = j + plane; }
    }
    const volMm3 = tail * cellVol;
    if ((tail <= 2 && volMm3 < 0.5) || volMm3 < 0.1) {
      for (let p = 0; p < tail; p++) {
        state[bfsQueue[p]] = WET;
        wetCount++;
      }
      continue;
    }
    trappedCells += tail;
    const k = (topI / plane) | 0, rem = topI - k * plane, r = (rem / cols) | 0, c = rem - r * cols;
    pockets.push({ topMm: [d.x0 + c * cell, d.y0 + r * cell, d.z0 + k * cell], volumeMm3: volMm3 });
  }
  pockets.sort((a, b) => b.volumeMm3 - a.volumeMm3);
  const wetMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) wetMask[i] = state[i] === WET ? 1 : 0;
  return {
    wet: wetMask,
    filledShare: wetCount / total,
    pockets,
    trappedMm3: trappedCells * cellVol,
  };
}

/**
 * Cell size for a cavity of bounding box `sizeMm` (and optional `cavityVolumeMm3`):
 * keeps <= 0.4–0.5 mm resolution on small/medium molds (~7–9 cells across
 * `bubbleRiseMm = 3.5 mm`) while bounding total grid cells to <= 550,000.
 */
export function fillCellMm(sizeMm: [number, number, number], cavityVolumeMm3?: number): number {
  const [w, d, h] = sizeMm;
  const boxVol = Math.max(0, w) * Math.max(0, d) * Math.max(0, h);
  let cell = Math.max(0.4, Math.cbrt(boxVol / 500_000));
  if (cavityVolumeMm3 !== undefined && cavityVolumeMm3 > 0) {
    cell = Math.max(cell, Math.cbrt(cavityVolumeMm3 / 250_000));
  }
  const gridCells = (c: number) =>
    Math.max(1, Math.ceil(w / c)) * Math.max(1, Math.ceil(d / c)) * Math.max(1, Math.ceil(h / c));
  while (gridCells(cell) > 550_000) cell *= 1.04;
  return cell;
}
