// Where a relief model meets the edge of its footprint, and what that does to the stock edge.

import type { Heightmap } from './reliefHeightmap';
import { OPEN_EDGE_MM, type OpenEdges } from './surfaceJob';

/**
 * The sides where the model ends in a face: nearly every sample along the
 * footprint's edge meets it. A block's end, cut off square, is one, and a
 * groove running off it is open there. A dome's rim, or a letter's outline,
 * touches its footprint's edge at a few samples and is not.
 */
export function endFaces(hm: Heightmap, fp: { minX: number; minY: number; maxX: number; maxY: number }): OpenEdges {
  const { i0, i1, j0, j1 } = footprintCells(hm, fp);
  const share = (start: number, step: number, n: number) => {
    let hit = 0;
    for (let t = 0; t < n; t++) if (hm.z[start + t * step] !== -Infinity) hit++;
    return n > 0 ? hit / n : 0;
  };
  // Read a sample in from the edge, whose own samples can all graze the face.
  const FACE = 0.9;
  if (i1 - i0 < 3 || j1 - j0 < 3) return { minX: false, maxX: false, minY: false, maxY: false };
  return {
    minX: share(j0 * hm.cols + i0 + 1, hm.cols, j1 - j0 + 1) >= FACE,
    maxX: share(j0 * hm.cols + i1 - 1, hm.cols, j1 - j0 + 1) >= FACE,
    minY: share((j0 + 1) * hm.cols + i0, 1, i1 - i0 + 1) >= FACE,
    maxY: share((j1 - 1) * hm.cols + i0, 1, i1 - i0 + 1) >= FACE,
  };
}

/** The columns and rows of `hm` whose samples lie on the footprint. */
function footprintCells(hm: Heightmap, fp: { minX: number; minY: number; maxX: number; maxY: number }) {
  const i0 = Math.max(0, Math.ceil((fp.minX - hm.minX) / (hm.stepX || 1) - 1e-6));
  const i1 = Math.min(hm.cols - 1, Math.floor((fp.maxX - hm.minX) / (hm.stepX || 1) + 1e-6));
  const j0 = Math.max(0, Math.ceil((fp.minY - hm.minY) / (hm.stepY || 1) - 1e-6));
  const j1 = Math.min(hm.rows - 1, Math.floor((fp.maxY - hm.minY) / (hm.stepY || 1) + 1e-6));
  return { i0, i1, j0, j1 };
}

/**
 * A sample on the footprint's own edge casts its ray down the model's end
 * face, and can miss it: read as background, it held the cutter up within a
 * radius of every end. Such a miss takes the height of the sample inward, but
 * only where the surface runs level into the edge (a floor, a top face). A
 * dome's rim misses there too, and the sample inward of it is on a steep
 * flank that does not carry on, so only a side that is a face (`endFaces`)
 * is filled.
 */
export function fillGrazedEdges(
  hm: Heightmap,
  fp: { minX: number; minY: number; maxX: number; maxY: number },
  faces: OpenEdges
): void {
  const { i0, i1, j0, j1 } = footprintCells(hm, fp);
  if (i1 - i0 < 3 || j1 - j0 < 3) return;
  const z = hm.z;
  const take = (k: number, step: number, pitch: number) => {
    const a = z[k + step], b = z[k + 2 * step];
    if (z[k] === -Infinity && a !== -Infinity && b !== -Infinity && Math.abs(a - b) <= pitch) z[k] = a;
  };
  for (let j = j0; j <= j1; j++) {
    if (faces.minX) take(j * hm.cols + i0, 1, hm.stepX);
    if (faces.maxX) take(j * hm.cols + i1, -1, hm.stepX);
  }
  for (let i = i0; i <= i1; i++) {
    if (faces.minY) take(j0 * hm.cols + i, hm.cols, hm.stepY);
    if (faces.maxY) take(j1 * hm.cols + i, -hm.cols, hm.stepY);
  }
}

/**
 * Where the board round a model is left uncut at Z0 (`backgroundMode === 'skip'`),
 * an outer edge roundover or bevel on the model's perimeter drops from the
 * model's Z0 top rim down into the `-Infinity` margin — which, once the margin
 * is filled with Z0, turns that outer roundover into a V-trench all the way
 * round the part. Any narrow perimeter bevel that climbs monotonically inward
 * from the uncut boundary to the model's Z0 top face is bridged level at Z0
 * instead, while features that stay below Z0 into the part (an open groove) or
 * domes without a Z0 rim are left untouched.
 */
export function bridgeOuterEdgeBevel(
  hm: Heightmap,
  carveBounds: { minX: number; minY: number; maxX: number; maxY: number },
  reliefDepthMm: number
): void {
  const { cols, rows, stepX, stepY, z } = hm;
  if (cols < 5 || rows < 5 || !(stepX > 0) || !(stepY > 0)) return;
  const spanMin = Math.min(carveBounds.maxX - carveBounds.minX, carveBounds.maxY - carveBounds.minY);
  const maxBevelMm = Math.min(reliefDepthMm * 0.5, spanMin * 0.05);
  if (!(maxBevelMm > 0)) return;
  const maxDistSq = maxBevelMm * maxBevelMm;
  const nCells = cols * rows;
  const nearC = new Int32Array(nCells).fill(-1);
  const nearR = new Int32Array(nCells).fill(-1);
  const distSq = new Float32Array(nCells).fill(Infinity);
  const inQueue = new Uint8Array(nCells);
  const queue = new Int32Array(nCells);
  let qHead = 0;
  let qTail = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (z[k] !== -Infinity) continue;
      nearC[k] = c;
      nearR[k] = r;
      distSq[k] = 0;
      if (
        (c > 0 && z[k - 1] !== -Infinity) ||
        (c < cols - 1 && z[k + 1] !== -Infinity) ||
        (r > 0 && z[k - cols] !== -Infinity) ||
        (r < rows - 1 && z[k + cols] !== -Infinity)
      ) {
        inQueue[k] = 1;
        queue[qTail++] = k;
      }
    }
  }
  if (qTail === 0) return;

  while (qHead !== qTail) {
    const cur = queue[qHead];
    qHead = (qHead + 1) % nCells;
    inQueue[cur] = 0;
    const c = cur % cols;
    const r = Math.floor(cur / cols);
    const bc = nearC[cur];
    const br = nearR[cur];
    const neighbors = [
      c > 0 ? cur - 1 : -1,
      c < cols - 1 ? cur + 1 : -1,
      r > 0 ? cur - cols : -1,
      r < rows - 1 ? cur + cols : -1,
    ];
    for (const n of neighbors) {
      if (n < 0 || z[n] === -Infinity) continue;
      const nc = n % cols;
      const nr = Math.floor(n / cols);
      const d2 = ((nc - bc) * stepX) ** 2 + ((nr - br) * stepY) ** 2;
      if (d2 <= maxDistSq && d2 < distSq[n] - 1e-6) {
        distSq[n] = d2;
        nearC[n] = bc;
        nearR[n] = br;
        if (!inQueue[n]) {
          inQueue[n] = 1;
          queue[qTail] = n;
          qTail = (qTail + 1) % nCells;
        }
      }
    }
  }

  const pitch = Math.min(stepX, stepY);
  const lift = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!(distSq[k] > 0 && distSq[k] <= maxDistSq) || !(z[k] < -1e-4)) continue;
      const bc = nearC[k];
      const br = nearR[k];
      const vx = (c - bc) * stepX;
      const vy = (r - br) * stepY;
      const d = Math.hypot(vx, vy);
      if (d <= 1e-6) continue;
      const ux = vx / d;
      const uy = vy / d;

      let prevZ = -Infinity;
      let reachesTop = false;
      for (let s = pitch; s <= maxBevelMm + pitch; s += pitch) {
        const sc = Math.round(bc + (ux * s) / stepX);
        const sr = Math.round(br + (uy * s) / stepY);
        if (sc < 0 || sc >= cols || sr < 0 || sr >= rows) break;
        const zv = z[sr * cols + sc];
        if (zv === -Infinity || zv < prevZ - 0.05) break;
        prevZ = Math.max(prevZ, zv);
        if (zv >= -1e-3) {
          // Confirm it lands on a flat Z0 rim rather than a narrow ridge crest.
          const fc = Math.round(bc + (ux * (s + pitch)) / stepX);
          const fr = Math.round(br + (uy * (s + pitch)) / stepY);
          const flatRim =
            fc >= 0 && fc < cols && fr >= 0 && fr < rows && z[fr * cols + fc] >= -1e-3;
          reachesTop = flatRim && d <= s + pitch;
          break;
        }
      }
      if (reachesTop) lift[k] = 1;
    }
  }

  for (let i = 0; i < z.length; i++) {
    if (lift[i]) z[i] = 0;
  }
}

/**
 * Carries the model's edge heights out across the margin round it wherever
 * they are below the top face, so a feature open at the model's edge stays
 * open through a board left uncut. Returns whether anything changed.
 *
 * Only a surface that reaches the edge running level, or near it, is carried
 * on: a groove's floor, a step. A dome's flank meets its footprint's edge at a
 * single deep sample with the surface climbing steeply away from it, and
 * carrying that out would cut a slot across the margin.
 */
export function extendOpenEdges(
  hm: Heightmap,
  fp: { minX: number; minY: number; maxX: number; maxY: number },
  faces: OpenEdges
): boolean {
  const { i0, i1, j0, j1 } = footprintCells(hm, fp);
  if (i1 - i0 < 1 || j1 - j0 < 1 || (i0 === 0 && j0 === 0 && i1 === hm.cols - 1 && j1 === hm.rows - 1)) return false;
  const z = hm.z;
  /** Whether the surface at an edge sample runs on level from the sample inward of it. */
  const level = (k: number, inward: number, step: number) => Math.abs(z[k] - z[inward]) <= step;
  let changed = false;
  for (let r = 0; r < hm.rows; r++) {
    const rj = Math.min(j1, Math.max(j0, r));
    const dy = r < j0 ? 1 : r > j1 ? -1 : 0;
    for (let c = 0; c < hm.cols; c++) {
      if (r === rj && c >= i0 && c <= i1) continue;
      const ci = Math.min(i1, Math.max(i0, c));
      const dx = c < i0 ? 1 : c > i1 ? -1 : 0;
      const src = rj * hm.cols + ci;
      if (dx > 0 ? !faces.minX : dx < 0 ? !faces.maxX : false) continue;
      if (dy > 0 ? !faces.minY : dy < 0 ? !faces.maxY : false) continue;
      if (dx !== 0 && !level(src, src + dx, hm.stepX)) continue;
      if (dy !== 0 && !level(src, src + dy * hm.cols, hm.stepY)) continue;
      const from = z[src];
      const k = r * hm.cols + c;
      if (from < -OPEN_EDGE_MM && from < z[k]) {
        z[k] = from;
        changed = true;
      }
    }
  }
  return changed;
}
