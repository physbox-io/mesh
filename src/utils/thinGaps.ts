// ---------------------------------------------------------------------------
// Gaps in a casting narrower than the printer can line.
//
// Whatever surrounds a casting in its mold (liner, shell, an insert) is as thin
// as the gap between two parts of it. A gear sculpture's stacked gears stood
// 0.03-0.4 mm apart, and the liner between them came out a sub-layer film that
// lifted off the bed and wrapped the nozzle. Found two ways, both exact for the
// prismatic shapes these castings are made of:
//
//  - skins: an upward flat face of the part with a downward one over it,
//    closer than the printer's thinnest skin (one FDM layer);
//  - walls: between flat-face heights the part is prismatic, so a closing of
//    its slice in that band by half the thinnest wall finds every gap narrower
//    than one nozzle line.
//
// Each can be left (and named in a warning), closed (filled with casting: the
// casting gains a web there) or opened (the part trimmed back until the gap is
// printable).
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { PrintLimits } from './printLimits';

export type ThinGapMode = 'leave' | 'close' | 'fix';

export interface ThinGapReport {
  /** Gaps between stacked flat faces thinner than the thinnest skin. */
  skin: { areaMm2: number; thinnestMm: number; atMm: [number, number, number] | null };
  /** Gaps side by side narrower than the thinnest wall. */
  wall: { areaMm2: number; thinnestMm: number; atMm: [number, number, number] | null };
  /** Casting added (close) or taken away (fix), mm³. */
  changedMm3: number;
}

/** Below this a gap is a crumb of numerical noise, not a feature, mm². */
const MIN_GAP_AREA_MM2 = 0.05;
/** Heights closer than this are one flat face, mm. */
const FLAT_SNAP_MM = 1e-3;
/** Irrational sub-cell offsets so sloped-skin rays avoid axis-aligned edges/diagonals. */
const RAY_NUDGE_X = 0.0137;
const RAY_NUDGE_Y = 0.0193;
/** Minimum |nz| for a face to count as a stacked skin rather than a side-by-side wall. */
const SLOPED_SKIN_MIN_NZ = 0.65;

export interface Flats {
  up: Map<number, SimplePolygon[]>;
  down: Map<number, SimplePolygon[]>;
}

interface ZBucket {
  minZ: number;
  maxZ: number;
  sumZ: number;
  polys: SimplePolygon[];
}

/**
 * Merges integer Z buckets whose raw heights are within `FLAT_SNAP_MM` of each
 * other so coplanar faces straddling a `x.xxx5 mm` rounding boundary stay in
 * one `CrossSection`.
 */
function mergeZBuckets(raw: Map<number, ZBucket>): Map<number, SimplePolygon[]> {
  const out = new Map<number, SimplePolygon[]>();
  if (raw.size === 0) return out;
  const sorted = [...raw.entries()].sort((a, b) => a[0] - b[0]);
  let cluster: ZBucket | null = null;
  const flush = () => {
    if (!cluster) return;
    const meanZ = cluster.sumZ / cluster.polys.length;
    out.set(meanZ, cluster.polys);
    cluster = null;
  };
  for (const [, bucket] of sorted) {
    if (cluster && bucket.minZ - cluster.maxZ <= FLAT_SNAP_MM) {
      cluster.maxZ = Math.max(cluster.maxZ, bucket.maxZ);
      cluster.sumZ += bucket.sumZ;
      for (const poly of bucket.polys) cluster.polys.push(poly);
    } else {
      flush();
      cluster = { minZ: bucket.minZ, maxZ: bucket.maxZ, sumZ: bucket.sumZ, polys: [...bucket.polys] };
    }
  }
  flush();
  return out;
}

/** The part's horizontal faces, as polygons by height, upward and downward apart. */
export function flatFaces(part: Manifold): Flats {
  const mesh = part.getMesh();
  const p = mesh.vertProperties;
  const st = mesh.numProp;
  const t = mesh.triVerts;
  const rawUp = new Map<number, ZBucket>();
  const rawDown = new Map<number, ZBucket>();
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * st, t[k + 1] * st, t[k + 2] * st];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
    if (len < 1e-12 || Math.abs(nz / len) < 0.999) continue;
    const avgZ = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    const key = Math.round(avgZ / FLAT_SNAP_MM);
    const tri: SimplePolygon = nz > 0
      ? [[p[a], p[a + 1]], [p[b], p[b + 1]], [p[c], p[c + 1]]]
      : [[p[a], p[a + 1]], [p[c], p[c + 1]], [p[b], p[b + 1]]];
    const m = nz > 0 ? rawUp : rawDown;
    const bucket = m.get(key);
    if (bucket) {
      if (avgZ < bucket.minZ) bucket.minZ = avgZ;
      if (avgZ > bucket.maxZ) bucket.maxZ = avgZ;
      bucket.sumZ += avgZ;
      bucket.polys.push(tri);
    } else {
      m.set(key, { minZ: avgZ, maxZ: avgZ, sumZ: avgZ, polys: [tri] });
    }
  }
  return { up: mergeZBuckets(rawUp), down: mergeZBuckets(rawDown) };
}

/** The point of a cross-section's biggest piece nearest its centre, for saying where a gap is. */
function where(cs: CrossSection, z: number): [number, number, number] {
  const b = cs.bounds();
  return [Math.round(((b.min[0] + b.max[0]) / 2) * 10) / 10, Math.round(((b.min[1] + b.max[1]) / 2) * 10) / 10, Math.round(z * 10) / 10];
}

/** Translates a temporary Manifold and always frees the pre-translation handle. */
function translateAndDelete(m: Manifold, v: [number, number, number]): Manifold {
  try {
    return m.translate(v);
  } finally {
    m.delete();
  }
}

/** Even-odd point-in-polygons test for 2D CrossSection polygons. */
function pointInPolys(x: number, y: number, polys: SimplePolygon[]): boolean {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Shortest Euclidean distance from point (px, py) to segment (ax, ay)-(bx, by). */
function pointToSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-24) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Analyses a morphological-closing gap piece `g` against `slicePolys`:
 * - Distinguishes wall-contact edges (touching the part) from open-air closing arcs.
 * - Filters single-mouth concave V-notches whose walls diverge >= 25° into wide space.
 * - Computes an accurate gap width (exact distance between opposing wall chains on
 *   two-sided pinches, or `2 * area / wallPerimeter` without end-cap bias).
 */
function classifyWallGapPiece(
  gPolys: SimplePolygon[],
  area: number,
  slicePolys: SimplePolygon[],
  r: number,
): { keep: boolean; widthMm: number } {
  const probeEps = Math.min(1e-2, Math.max(1e-4, r * 0.02));
  let wallPerimeter = 0;
  let totalPerimeter = 0;
  let openChainCount = 0;
  const wallChains: Array<Array<{ ax: number; ay: number; bx: number; by: number; nx: number; ny: number; len: number }>> = [];
  let singleOpenStart: [number, number] | null = null;
  let singleOpenEnd: [number, number] | null = null;

  for (const poly of gPolys) {
    const m = poly.length;
    if (m < 3) continue;
    // Signed area tells winding (CCW outer boundary vs CW hole).
    let sArea = 0;
    for (let i = 0; i < m; i++) {
      const p = poly[i], q = poly[(i + 1) % m];
      sArea += p[0] * q[1] - q[0] * p[1];
    }
    const outSign = sArea >= 0 ? 1 : -1;

    const isWall = new Uint8Array(m);
    const edges: Array<{ ax: number; ay: number; bx: number; by: number; nx: number; ny: number; len: number }> = [];
    for (let i = 0; i < m; i++) {
      const p = poly[i], q = poly[(i + 1) % m];
      const dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      totalPerimeter += len;
      // Outward normal of `g` (pointing out of gap into slice or open air).
      const onx = len > 1e-12 ? (outSign * dy) / len : 0;
      const ony = len > 1e-12 ? (-outSign * dx) / len : 0;
      const mx = (p[0] + q[0]) * 0.5 + probeEps * onx;
      const my = (p[1] + q[1]) * 0.5 + probeEps * ony;
      const touchesPart = len > 1e-9 && pointInPolys(mx, my, slicePolys);
      isWall[i] = touchesPart ? 1 : 0;
      if (touchesPart) wallPerimeter += len;
      // Store inward normal (pointing into gap `g` from the wall).
      edges.push({ ax: p[0], ay: p[1], bx: q[0], by: q[1], nx: -onx, ny: -ony, len });
    }

    // Extract maximal contiguous runs of wall edges and count open-air chains.
    let firstWall = -1;
    let firstOpen = -1;
    for (let i = 0; i < m; i++) {
      if (isWall[i] && firstWall < 0) firstWall = i;
      if (!isWall[i] && firstOpen < 0) firstOpen = i;
    }
    if (firstOpen < 0) {
      // Completely enclosed cavity (no open-air edges).
      wallChains.push(edges);
    } else if (firstWall >= 0) {
      // Start scanning right after a transition so chains never wrap awkwardly.
      let startIdx = 0;
      for (let i = 0; i < m; i++) {
        if (isWall[i] !== isWall[(i - 1 + m) % m]) { startIdx = i; break; }
      }
      let idx = 0;
      while (idx < m) {
        const curIdx = (startIdx + idx) % m;
        const kind = isWall[curIdx];
        const run: typeof edges = [];
        while (idx < m && isWall[(startIdx + idx) % m] === kind) {
          run.push(edges[(startIdx + idx) % m]);
          idx++;
        }
        if (kind === 1) {
          wallChains.push(run);
        } else {
          openChainCount++;
          singleOpenStart = [run[0].ax, run[0].ay];
          singleOpenEnd = [run[run.length - 1].bx, run[run.length - 1].by];
        }
      }
    }
  }

  // Reject single-mouth concave V-notches opening wide (>= 25°) to free space:
  // a real narrow slot has either >= 2 open mouths (between two walls/spheres)
  // or parallel walls (angle < 25°) extending deeper than a corner spandrel.
  if (openChainCount === 1 && wallChains.length === 1 && singleOpenStart && singleOpenEnd) {
    const chain = wallChains[0];
    // Average wall inward normals near each end of the single wall chain
    // (skipping tiny rounding bevels < 1e-4 mm at the mouth corners).
    const sampleNormal = (fromStart: boolean): [number, number] | null => {
      let sx = 0, sy = 0, acc = 0;
      const budget = Math.max(r * 0.75, 0.1);
      for (let k = 0; k < chain.length; k++) {
        const e = chain[fromStart ? k : chain.length - 1 - k];
        if (e.len < 1e-5) continue;
        const w = Math.min(e.len, budget - acc);
        sx += e.nx * w; sy += e.ny * w; acc += w;
        if (acc >= budget) break;
      }
      const nLen = Math.hypot(sx, sy);
      return nLen > 1e-9 ? [sx / nLen, sy / nLen] : null;
    };
    const nA = sampleNormal(true);
    const nB = sampleNormal(false);
    if (nA && nB) {
      // dot(nA, nB) = -cos(2α), where 2α is the V-notch opening angle.
      // For parallel walls (2α = 0°), dot = -1.0; for 2α >= 25°, dot > -0.9063.
      const d = nA[0] * nB[0] + nA[1] * nB[1];
      if (d > -0.9063) {
        const sinHalf = Math.sqrt(Math.max(1e-6, (1 + d) * 0.5));
        const cosHalf = Math.sqrt(Math.max(0, (1 - d) * 0.5));
        const spandrelDepth = r * (cosHalf / sinHalf);
        const mx = (singleOpenStart[0] + singleOpenEnd[0]) * 0.5;
        const my = (singleOpenStart[1] + singleOpenEnd[1]) * 0.5;
        let maxDepth = 0;
        for (const e of chain) {
          const dist = Math.hypot(e.ax - mx, e.ay - my);
          if (dist > maxDepth) maxDepth = dist;
        }
        if (maxDepth <= spandrelDepth * 1.3 + r * 0.25) {
          return { keep: false, widthMm: Infinity };
        }
      }
    }
  }

  // Estimate true gap width:
  // - On two-wall gaps (two+ wall chains), measure minimum distance between
  //   opposing chains so short pinch gaps between spheres/cylinders report their
  //   true pinch width rather than an area/perimeter underestimate.
  // - Otherwise use `2 * area / wallPerimeter` (excluding open-air end caps).
  let widthMm = wallPerimeter > 1e-9
    ? (2 * area) / wallPerimeter
    : totalPerimeter > 1e-9 ? (2 * area) / totalPerimeter : 0;

  if (wallChains.length >= 2) {
    let minPairDist = Infinity;
    for (let ci = 0; ci < wallChains.length; ci++) {
      for (let cj = ci + 1; cj < wallChains.length; cj++) {
        const aChain = wallChains[ci], bChain = wallChains[cj];
        const stepA = Math.max(1, Math.floor(aChain.length / 48));
        const stepB = Math.max(1, Math.floor(bChain.length / 48));
        for (let ia = 0; ia < aChain.length; ia += stepA) {
          const ea = aChain[ia];
          const px = (ea.ax + ea.bx) * 0.5, py = (ea.ay + ea.by) * 0.5;
          for (let ib = 0; ib < bChain.length; ib += stepB) {
            const eb = bChain[ib];
            const dist = pointToSegDist(px, py, eb.ax, eb.ay, eb.bx, eb.by);
            if (dist < minPairDist) minPairDist = dist;
          }
        }
      }
    }
    if (Number.isFinite(minPairDist) && minPairDist > 0) {
      widthMm = minPairDist;
    }
  }

  return { keep: true, widthMm };
}

/**
 * Finds the thin gaps in `part` and, for 'close' or 'fix', returns the part
 * with them filled or opened. `part` stays the caller's; the returned part is
 * new unless the mode is 'leave' or nothing was found.
 */
export function treatThinGaps(wasm: ManifoldToplevel, part: Manifold, limits: PrintLimits, mode: ThinGapMode): { part: Manifold; report: ThinGapReport } {
  const report: ThinGapReport = {
    skin: { areaMm2: 0, thinnestMm: Infinity, atMm: null },
    wall: { areaMm2: 0, thinnestMm: Infinity, atMm: null },
    changedMm3: 0,
  };
  const fills: Manifold[] = [];
  const cuts: Manifold[] = [];

  try {
    const { up, down } = flatFaces(part);

    // Skins: an upward face with a downward one just over it.
    let worstSkinArea = 0;
    for (const [h1, upPolys] of up) {
      for (const [h2, downPolys] of down) {
        const gap = h2 - h1;
        if (!(gap > FLAT_SNAP_MM && gap < limits.minSkinMm - 1e-6)) continue;
        let lo: CrossSection | null = null;
        let hi: CrossSection | null = null;
        let both: CrossSection | null = null;
        let prism: Manifold | null = null;
        let space: Manifold | null = null;
        try {
          lo = new wasm.CrossSection(upPolys, 'Positive');
          hi = new wasm.CrossSection(downPolys, 'Positive');
          both = lo.intersect(hi);
          lo.delete(); lo = null;
          hi.delete(); hi = null;
          if (both.area() < MIN_GAP_AREA_MM2) continue;
          // Only where nothing of the part lies between the two faces.
          prism = translateAndDelete(wasm.Manifold.extrude(both, gap), [0, 0, h1]);
          space = prism.subtract(part);
          prism.delete(); prism = null;
          const area = space.volume() / gap;
          if (area >= MIN_GAP_AREA_MM2) {
            report.skin.areaMm2 += area;
            report.skin.thinnestMm = Math.min(report.skin.thinnestMm, gap);
            if (area > worstSkinArea) {
              worstSkinArea = area;
              report.skin.atMm = where(both, (h1 + h2) / 2);
            }
            if (mode === 'close') {
              fills.push(space);
              space = null;
            } else if (mode === 'fix') {
              // Half the shortfall off each face.
              const half = (limits.minSkinMm - gap) / 2;
              cuts.push(translateAndDelete(wasm.Manifold.extrude(both, gap + 2 * half), [0, 0, h1 - half]));
            }
          }
        } finally {
          space?.delete();
          prism?.delete();
          both?.delete();
          hi?.delete();
          lo?.delete();
        }
      }
    }

    // Sloped/curved stacked faces (where |nz| < 0.999 missed flatFaces): ray-cast on
    // an XY grid when the part has non-horizontal, non-vertical faces and minSkinMm > 0.
    const box = part.boundingBox();
    const mesh = part.getMesh();
    const vp = mesh.vertProperties;
    const st = mesh.numProp;
    const tv = mesh.triVerts;
    const triCount = Math.floor(tv.length / 3);
    const triZMin = new Float64Array(triCount);
    const triZMax = new Float64Array(triCount);
    const triNz = new Float64Array(triCount);
    let hasSlopedSkinCandidate = false;
    let hasNonPrismaticFace = false;
    for (let ti = 0; ti < triCount; ti++) {
      const a = tv[ti * 3] * st, b = tv[ti * 3 + 1] * st, c = tv[ti * 3 + 2] * st;
      const z0 = vp[a + 2], z1 = vp[b + 2], z2 = vp[c + 2];
      triZMin[ti] = Math.min(z0, z1, z2);
      triZMax[ti] = Math.max(z0, z1, z2);
      const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = z1 - z0;
      const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = z2 - z0;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      const unz = len > 1e-12 ? nz / len : 0;
      triNz[ti] = unz;
      const anz = Math.abs(unz);
      if (anz > 1e-3 && anz < 0.999) {
        hasNonPrismaticFace = true;
        if (anz > SLOPED_SKIN_MIN_NZ) hasSlopedSkinCandidate = true;
      }
    }

    // Track sloped-skin gap footprints so the wall slice pass never double-counts
    // or double-fills/cuts the exact same tilted-plate region.
    const slopedClaims: Array<{ x0: number; y0: number; x1: number; y1: number; z0: number; z1: number }> = [];

    if (hasSlopedSkinCandidate && limits.minSkinMm > FLAT_SNAP_MM) {
      const spanX = box.max[0] - box.min[0];
      const spanY = box.max[1] - box.min[1];
      if (spanX > 1e-3 && spanY > 1e-3) {
        const ds = Math.max(0.3, Math.min(0.6, Math.max(spanX, spanY) / 72));
        const nx = Math.max(2, Math.ceil(spanX / ds));
        const ny = Math.max(2, Math.ceil(spanY / ds));
        const dx = spanX / nx;
        const dy = spanY / ny;
        const buckets: number[][] = Array.from({ length: nx * ny }, () => []);
        for (let ti = 0; ti < triCount; ti++) {
          if (Math.abs(triNz[ti]) < 1e-4) continue;
          const a = tv[ti * 3] * st, b = tv[ti * 3 + 1] * st, c = tv[ti * 3 + 2] * st;
          const x0 = Math.min(vp[a], vp[b], vp[c]), x1 = Math.max(vp[a], vp[b], vp[c]);
          const y0 = Math.min(vp[a + 1], vp[b + 1], vp[c + 1]), y1 = Math.max(vp[a + 1], vp[b + 1], vp[c + 1]);
          const c0 = Math.max(0, Math.floor((x0 - box.min[0]) / dx));
          const c1 = Math.min(nx - 1, Math.floor((x1 - box.min[0]) / dx));
          const r0 = Math.max(0, Math.floor((y0 - box.min[1]) / dy));
          const r1 = Math.min(ny - 1, Math.floor((y1 - box.min[1]) / dy));
          for (let r = r0; r <= r1; r++) {
            for (let col = c0; col <= c1; col++) buckets[r * nx + col].push(ti);
          }
        }
        let slopedArea = 0;
        let slopedThin = Infinity;
        let slopedWx = 0, slopedWy = 0, slopedWz = 0, slopedW = 0;
        for (let r = 0; r < ny; r++) {
          const y = box.min[1] + (r + 0.5 + RAY_NUDGE_Y) * dy;
          const cellY0 = box.min[1] + r * dy;
          const cellY1 = cellY0 + dy;
          for (let col = 0; col < nx; col++) {
            const cand = buckets[r * nx + col];
            if (cand.length < 4) continue;
            const x = box.min[0] + (col + 0.5 + RAY_NUDGE_X) * dx;
            const cellX0 = box.min[0] + col * dx;
            const cellX1 = cellX0 + dx;
            const hits: Array<{ z: number; nz: number }> = [];
            for (const ti of cand) {
              const a = tv[ti * 3] * st, b = tv[ti * 3 + 1] * st, c = tv[ti * 3 + 2] * st;
              const ax = vp[a], ay = vp[a + 1], bx = vp[b], by = vp[b + 1], cx = vp[c], cy = vp[c + 1];
              const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
              if (Math.abs(det) < 1e-12) continue;
              const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
              const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
              const l3 = 1 - l1 - l2;
              if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
              const z = l1 * vp[a + 2] + l2 * vp[b + 2] + l3 * vp[c + 2];
              hits.push({ z, nz: triNz[ti] });
            }
            if (hits.length < 4) continue;
            hits.sort((p, q) => p.z - q.z);
            // Collapse shared-edge duplicate crossings of the same sign.
            const clean: Array<{ z: number; nz: number }> = [];
            for (const h of hits) {
              const prev = clean[clean.length - 1];
              if (prev && Math.abs(h.z - prev.z) < 1e-4 && Math.sign(h.nz) === Math.sign(prev.nz)) {
                if (Math.abs(h.nz) > Math.abs(prev.nz)) prev.nz = h.nz;
                continue;
              }
              clean.push(h);
            }
            // Pair solid intervals by actual surface normal sign (enter nz < 0,
            // leave nz > 0) so grazing a vertical step never shifts solid into air.
            const spans: Array<{ enter: { z: number; nz: number }; leave: { z: number; nz: number } }> = [];
            let depth = 0;
            let curEnter: { z: number; nz: number } | null = null;
            for (const h of clean) {
              if (h.nz < 0) {
                if (depth === 0) curEnter = h;
                depth++;
              } else if (h.nz > 0) {
                if (depth > 0) {
                  depth--;
                  if (depth === 0 && curEnter && h.z > curEnter.z + 1e-6) {
                    spans.push({ enter: curEnter, leave: h });
                    curEnter = null;
                  }
                }
              }
            }
            for (let s = 0; s + 1 < spans.length; s++) {
              const enterLo = spans[s].enter, leaveLo = spans[s].leave;
              const enterHi = spans[s + 1].enter, leaveHi = spans[s + 1].leave;
              if (!(leaveLo.nz > SLOPED_SKIN_MIN_NZ && enterHi.nz < -SLOPED_SKIN_MIN_NZ)) continue;
              // Purely horizontal flat-to-flat pairs were already measured above.
              if (leaveLo.nz >= 0.999 && enterHi.nz <= -0.999) continue;
              const dz = enterHi.z - leaveLo.z;
              const cosTilt = Math.min(Math.abs(leaveLo.nz), Math.abs(enterHi.nz));
              const gNorm = dz * cosTilt;
              if (!(dz > FLAT_SNAP_MM && gNorm < limits.minSkinMm - 1e-6)) continue;
              const cellArea = (dx * dy) / Math.max(0.5, cosTilt);
              slopedArea += cellArea;
              slopedThin = Math.min(slopedThin, gNorm);
              slopedWx += x * cellArea;
              slopedWy += y * cellArea;
              slopedWz += ((leaveLo.z + enterHi.z) / 2) * cellArea;
              slopedW += cellArea;
              slopedClaims.push({
                x0: cellX0 - 0.02, y0: cellY0 - 0.02,
                x1: cellX1 + 0.02, y1: cellY1 + 0.02,
                z0: leaveLo.z - 0.05, z1: enterHi.z + 0.05,
              });
              if (mode === 'close') {
                const padLo = Math.min(0.15, Math.max(0.02, (leaveLo.z - enterLo.z) * 0.35));
                const padHi = Math.min(0.15, Math.max(0.02, (leaveHi.z - enterHi.z) * 0.35));
                fills.push(
                  translateAndDelete(
                    wasm.Manifold.cube([dx + 0.04, dy + 0.04, dz + padLo + padHi], false),
                    [cellX0 - 0.02, cellY0 - 0.02, leaveLo.z - padLo],
                  ),
                );
              } else if (mode === 'fix') {
                const needDz = limits.minSkinMm / Math.max(0.5, cosTilt);
                const half = Math.max(0.02, (needDz - dz) / 2);
                cuts.push(
                  translateAndDelete(
                    wasm.Manifold.cube([dx + 0.04, dy + 0.04, dz + 2 * half], false),
                    [cellX0 - 0.02, cellY0 - 0.02, leaveLo.z - half],
                  ),
                );
              }
            }
          }
        }
        if (slopedArea >= MIN_GAP_AREA_MM2) {
          report.skin.areaMm2 += slopedArea;
          report.skin.thinnestMm = Math.min(report.skin.thinnestMm, slopedThin);
          if (slopedArea > worstSkinArea && slopedW > 0) {
            report.skin.atMm = [
              Math.round((slopedWx / slopedW) * 10) / 10,
              Math.round((slopedWy / slopedW) * 10) / 10,
              Math.round((slopedWz / slopedW) * 10) / 10,
            ];
          }
        }
      }
    }

    // Walls: the part's slice in each band between flat heights, closed by half a wall.
    // Where a band contains sloped or curved faces, subdivide into thin sub-bands so
    // equatorial/curved gaps are caught and 'close'/'fix' never extrudes vertical fins.
    const r = limits.minWallMm / 2;
    const minWallPieceArea = Math.max(MIN_GAP_AREA_MM2, 0.35 * limits.minWallMm * limits.minWallMm);
    const heights = [...new Set([box.min[2], box.max[2], ...up.keys(), ...down.keys()])].sort((a, b) => a - b);
    let worstWallArea = 0;
    if (r > 1e-6) {
      for (let i = 0; i + 1 < heights.length; i++) {
        const a = heights[i], b = heights[i + 1];
        if (b - a < FLAT_SNAP_MM) continue;
        let bandCurved = false;
        if (hasNonPrismaticFace && b - a > 0.8) {
          for (let ti = 0; ti < triCount; ti++) {
            const anz = Math.abs(triNz[ti]);
            if (anz > 1e-3 && anz < 0.999 && triZMax[ti] > a + FLAT_SNAP_MM && triZMin[ti] < b - FLAT_SNAP_MM) {
              bandCurved = true;
              break;
            }
          }
        }
        const subStep = mode === 'leave' ? 0.8 : 0.5;
        const steps = bandCurved ? Math.min(40, Math.max(1, Math.ceil((b - a) / subStep))) : 1;
        const dh = (b - a) / steps;
        let bandUnion: CrossSection | null = null;
        let bandAtZ = (a + b) / 2;
        let bandMaxSubArea = 0;

        try {
          for (let s = 0; s < steps; s++) {
            const z0 = a + s * dh;
            const z1 = z0 + dh;
            const zMid = (z0 + z1) / 2;
            let slice: CrossSection | null = null;
            let grown: CrossSection | null = null;
            let closed: CrossSection | null = null;
            let gaps: CrossSection | null = null;
            let skinMask: CrossSection | null = null;
            let clipGuard: CrossSection | null = null;
            const pieces: CrossSection[] = [];
            try {
              slice = part.slice(zMid);
              grown = slice.offset(r, 'Round', 2, 24);
              closed = grown.offset(-r, 'Round', 2, 24);
              grown.delete(); grown = null;
              gaps = closed.subtract(slice);
              closed.delete(); closed = null;

              // Subtract any sloped-skin gap footprint at this Z so tilted stacked
              // faces are never double-counted or double-filled as wall gaps.
              if (slopedClaims.length > 0) {
                const claimPolys: SimplePolygon[] = [];
                for (const cl of slopedClaims) {
                  if (zMid >= cl.z0 && zMid <= cl.z1) {
                    claimPolys.push([[cl.x0, cl.y0], [cl.x1, cl.y0], [cl.x1, cl.y1], [cl.x0, cl.y1]]);
                  }
                }
                if (claimPolys.length > 0) {
                  skinMask = new wasm.CrossSection(claimPolys, 'Positive');
                  const trimmedGaps = gaps.subtract(skinMask);
                  gaps.delete();
                  gaps = trimmedGaps;
                  skinMask.delete(); skinMask = null;
                }
              }

              const slicePolys = slice.toPolygons();
              // A closing also rounds every inside corner a hair (~0.054 * minWallMm² for 90°);
              // a real gap between two walls is appreciably larger than a corner fillet and not
              // a wide-opening concave V-notch. Strip Clipper2 zero-width wall whiskers before
              // classifying each piece's open mouths and wall normals.
              const rawPieces = gaps.decompose();
              gaps.delete(); gaps = null;
              const pieceWidths: number[] = [];
              for (const g of rawPieces) {
                const area = g.area();
                if (area < minWallPieceArea) {
                  g.delete();
                  continue;
                }
                let eroded: CrossSection | null = null;
                let cleaned: CrossSection | null = null;
                let classPolys: SimplePolygon[];
                let classArea = area;
                try {
                  const whiskerEps = Math.min(2e-3, r * 0.02);
                  eroded = g.offset(-whiskerEps, 'Miter');
                  if (!eroded.isEmpty()) {
                    cleaned = eroded.offset(whiskerEps, 'Miter');
                    classPolys = cleaned.toPolygons();
                    classArea = cleaned.area();
                  } else {
                    classPolys = g.toPolygons();
                  }
                } finally {
                  cleaned?.delete();
                  eroded?.delete();
                }
                const info = classifyWallGapPiece(classPolys, classArea, slicePolys, r);
                if (!info.keep) {
                  g.delete();
                  continue;
                }
                pieces.push(g);
                pieceWidths.push(info.widthMm);
              }

              // For curved sub-bands in 'close' mode, clip the gap to the intersection of
              // the grown slices near z0 and z1 so the web follows the curve without fins.
              if (bandCurved && mode === 'close' && pieces.length > 0) {
                const eps = Math.min(0.05, dh * 0.15);
                let sLo: CrossSection | null = null, sHi: CrossSection | null = null;
                let gLo: CrossSection | null = null, gHi: CrossSection | null = null;
                try {
                  sLo = part.slice(z0 + eps);
                  sHi = part.slice(z1 - eps);
                  gLo = sLo.offset(r * 1.25, 'Round');
                  gHi = sHi.offset(r * 1.25, 'Round');
                  clipGuard = gLo.intersect(gHi);
                } finally {
                  gHi?.delete();
                  gLo?.delete();
                  sHi?.delete();
                  sLo?.delete();
                }
              }

              for (let pi = 0; pi < pieces.length; pi++) {
                const g = pieces[pi];
                const area = g.area();
                report.wall.thinnestMm = Math.min(report.wall.thinnestMm, pieceWidths[pi]);

                if (!bandCurved) {
                  report.wall.areaMm2 += area;
                  if (area > worstWallArea) {
                    worstWallArea = area;
                    report.wall.atMm = where(g, zMid);
                  }
                } else {
                  if (bandUnion) {
                    const nextUnion: CrossSection = bandUnion.add(g);
                    bandUnion.delete();
                    bandUnion = nextUnion;
                  } else {
                    bandUnion = g.offset(0);
                  }
                  if (area > bandMaxSubArea) {
                    bandMaxSubArea = area;
                    bandAtZ = zMid;
                  }
                }

                if (mode === 'close') {
                  const fillCs = clipGuard ? g.intersect(clipGuard) : g;
                  try {
                    if (!fillCs.isEmpty()) {
                      fills.push(translateAndDelete(wasm.Manifold.extrude(fillCs, dh), [0, 0, z0]));
                    }
                  } finally {
                    if (fillCs !== g) fillCs.delete();
                  }
                } else if (mode === 'fix') {
                  const opened = g.offset(r, 'Round');
                  try {
                    cuts.push(translateAndDelete(wasm.Manifold.extrude(opened, dh), [0, 0, z0]));
                  } finally {
                    opened.delete();
                  }
                }
              }
            } finally {
              for (const g of pieces) g.delete();
              clipGuard?.delete();
              skinMask?.delete();
              gaps?.delete();
              closed?.delete();
              grown?.delete();
              slice?.delete();
            }
          }

          if (bandUnion) {
            const area = bandUnion.area();
            if (area >= MIN_GAP_AREA_MM2) {
              report.wall.areaMm2 += area;
              if (area > worstWallArea) {
                worstWallArea = area;
                report.wall.atMm = where(bandUnion, bandAtZ);
              }
            }
          }
        } finally {
          bandUnion?.delete();
        }
      }
    }

    if (!fills.length && !cuts.length) return { part, report };
    let out = part;
    let tool: Manifold | null = null;
    try {
      if (fills.length) {
        const all = wasm.Manifold.union([out, ...fills]);
        report.changedMm3 += all.volume() - out.volume();
        out = all;
      }
      if (cuts.length) {
        tool = wasm.Manifold.union(cuts);
        const trimmed = out.subtract(tool);
        report.changedMm3 += out.volume() - trimmed.volume();
        if (out !== part) out.delete();
        out = trimmed;
      }
      return { part: out, report };
    } catch (err) {
      if (out !== part) out.delete();
      throw err;
    } finally {
      tool?.delete();
    }
  } finally {
    for (const m of fills) m.delete();
    for (const m of cuts) m.delete();
  }
}

/** One line for the mold's warnings, or null when the casting has no thin gaps. */
export function thinGapWarning(report: ThinGapReport, limits: PrintLimits, mode: ThinGapMode): string | null {
  const parts: string[] = [];
  const at = (p: [number, number, number] | null) => (p ? ` (the biggest near ${p[0]}, ${p[1]}, ${p[2]} mm)` : '');
  if (report.skin.areaMm2 >= MIN_GAP_AREA_MM2) {
    parts.push(`${Math.round(report.skin.areaMm2 * 10) / 10} mm² of stacked faces under ${limits.minSkinMm} mm apart, down to ${report.skin.thinnestMm.toFixed(2)} mm${at(report.skin.atMm)}`);
  }
  if (report.wall.areaMm2 >= MIN_GAP_AREA_MM2) {
    parts.push(`${Math.round(report.wall.areaMm2 * 10) / 10} mm² of side-by-side gaps under ${limits.minWallMm} mm, down to ${report.wall.thinnestMm.toFixed(2)} mm${at(report.wall.atMm)}`);
  }
  if (!parts.length) return null;
  const found = `The casting has ${parts.join(', and ')}.`;
  if (mode === 'close') return `${found} Closed: filled with casting, ${Math.round(report.changedMm3 * 10) / 10} mm³ added, so the mold around them prints.`;
  if (mode === 'fix') return `${found} Opened: the part trimmed back by ${Math.round(report.changedMm3 * 10) / 10} mm³ until each gap prints.`;
  return `${found} The mold there is thinner than the printer makes, and prints as loose film or not at all. Set Thin gaps to Close (fill them with casting) or Fix model (open them up).`;
}
