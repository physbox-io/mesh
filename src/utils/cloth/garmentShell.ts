/**
 * A garment modelled in 3D, round a body form: the shape you want to wear,
 * before it is cut. A surface (the fabric's middle) stood off the form by the
 * garment's ease, open at the neck, armholes, hem and cuffs, with seams
 * marked on it where a tailor would put them. Cutting along the seams splits
 * it into panels, each of which is flattened into a piece of cloth to cut
 * (garmentFlatten.ts); draped, the panels are sewn back at the same seams.
 *
 * Body frame of the form (the garment's node stands where the form does),
 * MuJoCo Z-up, metres; the front of the body faces -y.
 */

import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import { bodyFormSection, bodyLandmarks } from './bodyForm';
import { GARMENT_DEFAULTS } from './garments';

export interface GarmentShell {
  /** Points of the fabric's middle surface. */
  points: number[][];
  /** Triangles, wound so their normals face away from the body. */
  tris: number[];
  /** Seams: chains of point indices, each run along the edges between them. */
  seams: { name: string; path: number[] }[];
  /** The surface split along its seams: each panel's triangles (indices into tris / 3). */
  panels: { name: string; tris: number[] }[];
}

const NA = 48; // points round the torso, a multiple of four

/** Radius of a section (radii at even angles round its centre) at angle th, interpolated. */
function radiusAt(radii: number[], th: number): number {
  const n = radii.length, f = (((th / (2 * Math.PI)) % 1) + 1) % 1 * n, i = Math.floor(f), t = f - i;
  return radii[i % n] * (1 - t) + radii[(i + 1) % n] * t;
}

export function garmentShell(draft: GarmentDraft, form: BodyFormMeasurements): GarmentShell {
  const kind = draft.garment;
  const d = { ...GARMENT_DEFAULTS[kind], ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) } as Required<GarmentDraft>;
  const L = bodyLandmarks(form);
  const s = form.height / 1.75;
  // Ease is round the body; as a stand-off it is that over 2 pi, plus the
  // fabric's own clearance.
  const off = d.ease / (2 * Math.PI) + 0.004;
  // A bodice's tube stops at the shoulder points; above that the shoulders
  // slope up to the neck, and the ridge over them follows (below). At the
  // top of the shoulder line the body is only the base of the neck.
  const top = kind === 'skirt' ? L.waistZ : L.shoulderPoint[2] + 0.02 * s;
  const hem = kind === 'tshirt' ? L.hipZ - 0.04 * s
    : L.waistZ - Math.max(L.waistZ - L.hipZ + 0.05, d.length);
  const hipSection = bodyFormSection(form, L.hipZ);
  // Rows from the hem up, about 2.5 cm apart.
  const nRows = Math.max(6, Math.round((top - hem) / 0.025));
  const zs = Array.from({ length: nRows + 1 }, (_, k) => hem + ((top - hem) * k) / nRows);
  const sectionAt = (z: number) => {
    const sec = bodyFormSection(form, z);
    // Below the hips a dress or skirt flares toward its hem.
    if (z < L.hipZ && kind !== 'tshirt') {
      const t = (L.hipZ - z) / Math.max(1e-3, L.hipZ - hem);
      return { centreY: hipSection.centreY, radii: hipSection.radii.map((r) => r * (1 + (d.flare - 1) * t)) };
    }
    return sec;
  };

  const points: number[][] = [];
  const grid: number[][] = []; // grid[row][angle] -> point index
  for (const z of zs) {
    const sec = sectionAt(z);
    grid.push(Array.from({ length: NA }, (_, i) => {
      const th = (2 * Math.PI * i) / NA, r = radiusAt(sec.radii, th) + off;
      points.push([r * Math.cos(th), sec.centreY + r * Math.sin(th), z]);
      return points.length - 1;
    }));
  }
  // A bodice closes over the shoulders in a ridge, where front and back meet:
  // the shoulder seam. Points at angle th and -th share x there, so one.
  const hasRidge = kind !== 'skirt';
  if (hasRidge) {
    const sec = sectionAt(top);
    const ridge: number[] = new Array(NA);
    // Up the shoulder's slope: level with the shoulder point at its end,
    // rising to the top of the shoulder line at the neck.
    const spTop = L.shoulderPoint[2] + 0.045 * s;
    const ridgeZ = (x: number) => {
      const u = Math.min(1, Math.max(0, (Math.abs(x) - L.neckRadius) / Math.max(1e-3, L.shoulderPoint[0] - L.neckRadius)));
      return spTop + (L.hpsZ - spTop) * (1 - u) + off;
    };
    const ridgePt: number[][] = [];
    for (let i = 0; i < NA; i++) {
      const th = (2 * Math.PI * i) / NA, r = radiusAt(sec.radii, th) + off, x = r * Math.cos(th);
      ridgePt.push([x, sec.centreY, ridgeZ(x)]);
    }
    // Rows between the top of the tube and the ridge, each pushed out to
    // clear the body at its own height: joined straight across, the rounded
    // top of the shoulder stood out through them.
    const topRow = grid[grid.length - 1];
    const BETWEEN = 4;
    for (let m = 1; m <= BETWEEN; m++) {
      const t = m / (BETWEEN + 1);
      grid.push(Array.from({ length: NA }, (_, i) => {
        const a = points[topRow[i]], b = ridgePt[i];
        const p = [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * t);
        const sz = sectionAt(p[2]);
        const dx = p[0], dy = p[1] - sz.centreY, rho = Math.hypot(dx, dy) || 1e-9;
        const need = radiusAt(sz.radii, Math.atan2(dy, dx)) + off;
        if (rho < need) { p[0] = (dx / rho) * need; p[1] = sz.centreY + (dy / rho) * need; }
        points.push(p);
        return points.length - 1;
      }));
    }
    for (let i = 0; i <= NA / 2; i++) {
      points.push(ridgePt[i]);
      ridge[i] = points.length - 1;
      if (i > 0 && i < NA / 2) ridge[NA - i] = ridge[i];
    }
    grid.push(ridge);
  }

  // Cells cut away: the neckline, and the armholes where the sleeves (or bare
  // arms) come through.
  const frontDepth = (kind === 'dress' ? 0.13 : 0.09) * s, backDepth = 0.02 * s;
  const neckHalf = L.neckRadius + 0.012 * s;
  const AH = L.hpsZ - 0.735 * form.height + 0.07 * s, uaZ = L.hpsZ - AH;
  const shoulderX = form.shoulderWidth / 2 + 0.01 * s;
  const sideX = (z: number) => radiusAt(sectionAt(z).radii, 0) + off;
  const cut = (x: number, y: number, z: number, cy: number) => {
    if (!hasRidge) return false;
    const front = y < cy;
    const depth = front ? frontDepth : backDepth;
    if (Math.abs(x) < neckHalf) {
      const neckZ = L.hpsZ - depth * Math.sqrt(Math.max(0, 1 - (x / neckHalf) ** 2));
      if (z > neckZ - 1e-6) return true;
    }
    if (z > uaZ) {
      const t = Math.min(1, (z - uaZ) / Math.max(1e-3, L.hpsZ - uaZ));
      const xCut = sideX(uaZ) + (shoulderX - sideX(uaZ)) * Math.sqrt(t);
      if (Math.abs(x) > xCut) return true;
    }
    return false;
  };
  const rows = grid.length;
  const cellCut: boolean[][] = [];
  for (let k = 0; k + 1 < rows; k++) {
    const cy = (sectionAt(zs[Math.min(k, zs.length - 1)]).centreY);
    cellCut.push(Array.from({ length: NA }, (_, i) => {
      const ids = [grid[k][i], grid[k][(i + 1) % NA], grid[k + 1][(i + 1) % NA], grid[k + 1][i]];
      const c = [0, 1, 2].map((a) => ids.reduce((sum, id) => sum + points[id][a], 0) / 4);
      return cut(c[0], c[1], c[2], cy);
    }));
  }

  const tris: number[] = [];
  const triCell: [number, number][] = [];
  for (let k = 0; k + 1 < rows; k++) {
    for (let i = 0; i < NA; i++) {
      if (cellCut[k][i]) continue;
      const a = grid[k][i], b = grid[k][(i + 1) % NA], c = grid[k + 1][(i + 1) % NA], dd = grid[k + 1][i];
      // Counter-clockwise round z, then up: normals face out.
      if (a !== b && b !== c && a !== c) { tris.push(a, b, c); triCell.push([k, i]); }
      if (a !== c && c !== dd && a !== dd) { tris.push(a, c, dd); triCell.push([k, i]); }
    }
  }

  const seams: GarmentShell['seams'] = [];
  // Side seams: angle 0 (+x) and NA/2, from the hem up to where the armhole begins.
  for (const [name, i] of [['sideR', 0], ['sideL', NA / 2]] as const) {
    const path: number[] = [];
    for (let k = 0; k < rows; k++) {
      const left = (i - 1 + NA) % NA;
      const below = k > 0 && !(cellCut[k - 1][i] && cellCut[k - 1][left]);
      const above = k + 1 < rows && !(cellCut[k][i] && cellCut[k][left]);
      if (!below && !above) break;
      if (k > 0 && cellCut[k - 1][i] !== cellCut[k - 1][left]) break;
      path.push(grid[k][i]);
      if (k + 1 < rows && (cellCut[k][i] || cellCut[k][left])) break;
    }
    if (path.length > 1) seams.push({ name, path });
  }
  // Shoulder seams: the ridge, from the neck out to the armhole, each side.
  if (hasRidge) {
    const r = rows - 1;
    for (const [name, range] of [['shoulderR', Array.from({ length: NA / 4 + 1 }, (_, j) => j)], ['shoulderL', Array.from({ length: NA / 4 + 1 }, (_, j) => NA / 2 - j)]] as const) {
      const path: number[] = [];
      for (const i of range) {
        // A ridge point is on the seam if it carries a triangle on both sides.
        const used = (ii: number) => !cellCut[r - 1][ii % NA] || !cellCut[r - 1][(ii - 1 + NA) % NA];
        if (used(i) && used(NA - i)) path.push(grid[r][i]);
      }
      if (path.length > 1) seams.push({ name, path });
    }
  }

  // The open edges: hem, neckline, armholes. Cut from a grid, they step;
  // smoothed along their length, they run as cut edges do.
  const loops = boundaryLoops(points.length, tris);
  for (const loop of loops) {
    const flat = loop.every((id) => Math.abs(points[id][2] - points[loop[0]][2]) < 1e-9);
    if (!flat) smoothLoop(points, loop, 6);
  }
  // Smoothing an edge pulls it across the body's curve, and an armhole's or
  // neckline's points went into the form. Anything nearer the body than the
  // garment stands off goes back out to it.
  for (const p of points) {
    if (p[2] > L.hpsZ) continue;
    const sec = sectionAt(p[2]);
    const dx = p[0], dy = p[1] - sec.centreY, rho = Math.hypot(dx, dy) || 1e-9;
    const need = radiusAt(sec.radii, Math.atan2(dy, dx)) + off;
    if (rho < need) { p[0] = (dx / rho) * need; p[1] = sec.centreY + (dy / rho) * need; }
  }

  // Sleeves: lofted from each armhole down the arm, sharing the armhole's
  // points, so sleeve and body are one surface; the armhole is the seam
  // between them, and a line under the arm the seam that closes the sleeve.
  const sleeveTris = new Set<number>();
  if (hasRidge && d.sleeve > 0.03) {
    for (const side of [1, -1]) {
      const loop = loops
        .filter((lp) => lp.some((id) => points[id][2] > uaZ - 0.02))
        .map((lp) => ({ lp, cx: lp.reduce((a, id) => a + points[id][0], 0) / lp.length }))
        .filter(({ cx }) => side * cx > L.neckRadius * 1.5)
        .sort((a, b) => side * b.cx - side * a.cx)[0]?.lp;
      if (!loop) continue;
      const A = [side * L.armOrigin[0], L.armOrigin[1], L.armOrigin[2]];
      const D = [side * L.armDir[0], 0, L.armDir[2]];
      const sOf = (p: number[]) => (p[0] - A[0]) * D[0] + (p[1] - A[1]) * D[1] + (p[2] - A[2]) * D[2];
      const sLoop = loop.map((id) => sOf(points[id]));
      const sCuff = Math.max(d.sleeve, Math.max(...sLoop) + 0.05 * s);
      const R = Math.max((form.upperArm + 0.12) / (2 * Math.PI), L.deltoidRadius + 0.006);
      const K = Math.max(3, Math.round((sCuff - Math.min(...sLoop)) / 0.03));
      let prev = loop.slice();
      const columns: number[][] = loop.map((id) => [id]);
      for (let k = 1; k <= K; k++) {
        const f = k / K, w = Math.min(1, f / 0.4), blend = w * w * (3 - 2 * w);
        const ring = loop.map((id, j) => {
          const p = points[id], sj = sLoop[j];
          const rho = [0, 1, 2].map((a) => p[a] - A[a] - sj * D[a]);
          const rl = Math.hypot(...rho) || 1;
          const sk = sj + (sCuff - sj) * f;
          const rk = rl + (R * (1 - 0.1 * f) - rl) * blend;
          points.push([0, 1, 2].map((a) => A[a] + sk * D[a] + (rho[a] / rl) * rk));
          columns[j].push(points.length - 1);
          return points.length - 1;
        });
        const first = tris.length;
        for (let j = 0; j < loop.length; j++) {
          const a = prev[j], b = prev[(j + 1) % loop.length], c = ring[(j + 1) % loop.length], dd = ring[j];
          tris.push(a, b, c, a, c, dd);
        }
        for (let t = first / 3; t < tris.length / 3; t++) sleeveTris.add(t);
        prev = ring;
      }
      // Wound out from the arm: check one and turn them all if not.
      const t0 = [...sleeveTris].find((t) => loop.includes(tris[3 * t]))!;
      const [p0, p1, p2] = [0, 1, 2].map((k) => points[tris[3 * t0 + k]]);
      const n = cross(sub(p1, p0), sub(p2, p0)), mid = p0.map((v, a) => (v + p1[a] + p2[a]) / 3);
      const out = sub(mid, A.map((v, a) => v + sOf(mid) * D[a]));
      if (dot(n, out) < 0) for (const t of sleeveTris) { const tmp = tris[3 * t + 1]; tris[3 * t + 1] = tris[3 * t + 2]; tris[3 * t + 2] = tmp; }
      const tag = side > 0 ? 'R' : 'L';
      seams.push({ name: `armhole${tag}`, path: [...loop, loop[0]] });
      const j0 = loop.reduce((best, id, j) => (points[id][2] < points[loop[best]][2] ? j : best), 0);
      seams.push({ name: `underarm${tag}`, path: columns[j0] });
    }
  }

  // Darts: over a bust a close-fitting front cannot lie flat, so each side
  // gets a slit from the side seam toward the bust point, stopping short of
  // it. Flattened, the slit opens into the dart's wedge.
  if (kind === 'dress' && L.bustProminence > 0.01) {
    // Walked on one side, mirrored to the other, so the two are the same dart.
    const side = seams.find((sm) => sm.name === 'sideR');
    if (side) {
      const zStart = L.bustZ - 0.05 * s;
      const start = side.path.reduce((best, id) => (Math.abs(points[id][2] - zStart) < Math.abs(points[best][2] - zStart) ? id : best), side.path[0]);
      const apex = [L.bustPoint[0], L.bustPoint[1] - off, L.bustZ];
      const path = walkToward(points, tris, start, apex, 0.03 * s);
      const mirror = (id: number) => {
        const [x, y, z] = points[id];
        let best = id, bd = Infinity;
        for (let j = 0; j < points.length; j++) {
          const dd = Math.hypot(points[j][0] + x, points[j][1] - y, points[j][2] - z);
          if (dd < bd) { bd = dd; best = j; }
        }
        return best;
      };
      if (path.length > 1) {
        seams.push({ name: 'dartR', path });
        seams.push({ name: 'dartL', path: path.map(mirror) });
      }
      // Waist darts, closed at both ends (fisheye): under the bust point in
      // front, below the shoulder blade behind, each to just above the hip.
      // They take the waist in, which a fitted front otherwise has to be
      // squeezed into.
      const nearest = (target: number[]) => {
        let best = 0, bd = Infinity;
        for (let j = 0; j < points.length; j++) {
          const dd = Math.hypot(points[j][0] - target[0], points[j][1] - target[1], points[j][2] - target[2]);
          if (dd < bd) { bd = dd; best = j; }
        }
        return best;
      };
      const bottomZ = L.hipZ + 0.03 * s;
      for (const [name, y, zTop] of [['waistDartFront', -1, L.bustZ - 0.04 * s], ['waistDartBack', 1, L.bustZ]] as const) {
        const x = L.bustPoint[0] * 0.95;
        const top = nearest([x, y * 0.3, zTop]), bottom = nearest([x, y * 0.3, bottomZ]);
        const pathR = walkToward(points, tris, top, points[bottom], 0);
        if (pathR.length > 2) {
          seams.push({ name: `${name}R`, path: pathR });
          seams.push({ name: `${name}L`, path: pathR.map(mirror) });
        }
      }
    }
  }

  const panels = splitPanels(points.length, tris, seams.map((sm) => sm.path));
  const named = panels.map((p) => {
    const c = p.reduce((acc, t) => { for (let k = 0; k < 3; k++) { const q = points[tris[3 * t + k]]; acc[0] += q[0]; acc[1] += q[1]; } return acc; }, [0, 0]);
    const name = sleeveTris.has(p[0]) ? (c[0] > 0 ? 'sleeveR' : 'sleeveL') : c[1] < 0 ? 'front' : 'back';
    return { name, tris: p };
  });
  return { points, tris, seams, panels: named };
}

/**
 * The surface split into panels along its seams: triangles joined across any
 * edge that is not a seam's, by flood fill.
 */
export function splitPanels(nPoints: number, tris: number[], seamPaths: number[][]): number[][] {
  const key = (a: number, b: number) => (a < b ? a * nPoints + b : b * nPoints + a);
  const seamEdges = new Set<number>();
  for (const path of seamPaths) for (let k = 1; k < path.length; k++) seamEdges.add(key(path[k - 1], path[k]));
  const byEdge = new Map<number, number[]>();
  const nT = tris.length / 3;
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)]);
      if (seamEdges.has(k)) continue;
      (byEdge.get(k) ?? byEdge.set(k, []).get(k)!).push(t);
    }
  }
  const panelOf = new Int32Array(nT).fill(-1);
  const panels: number[][] = [];
  for (let t0 = 0; t0 < nT; t0++) {
    if (panelOf[t0] >= 0) continue;
    const id = panels.length, list: number[] = [], stack = [t0];
    panelOf[t0] = id;
    while (stack.length) {
      const t = stack.pop()!;
      list.push(t);
      for (let e = 0; e < 3; e++) {
        for (const u of byEdge.get(key(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)])) ?? []) {
          if (panelOf[u] < 0) { panelOf[u] = id; stack.push(u); }
        }
      }
    }
    panels.push(list);
  }
  return panels;
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The surface's open edges, as closed loops of point indices. */
export function boundaryLoops(nPoints: number, tris: number[]): number[][] {
  const count = new Map<number, number>();
  const key = (a: number, b: number) => a * nPoints + b;
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) { const a = tris[t + e], b = tris[t + ((e + 1) % 3)]; count.set(key(a, b), (count.get(key(a, b)) ?? 0) + 1); }
  const next = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
      if (!count.has(key(b, a))) next.set(a, b);
    }
  }
  const loops: number[][] = [], seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/** Laplacian smoothing of a closed loop of points, in place. */
function smoothLoop(points: number[][], loop: number[], iterations: number) {
  for (let it = 0; it < iterations; it++) {
    const moved = loop.map((id, j) => {
      const a = points[loop[(j - 1 + loop.length) % loop.length]], b = points[loop[(j + 1) % loop.length]], p = points[id];
      return p.map((v, k) => v + 0.5 * ((a[k] + b[k]) / 2 - v));
    });
    loop.forEach((id, j) => { points[id] = moved[j]; });
  }
}

/**
 * A path along the surface's edges from `start` toward `target`, each step
 * to the neighbour nearest it, stopping `short` of it.
 */
function walkToward(points: number[][], tris: number[], start: number, target: number[], short: number): number[] {
  const nbr = new Map<number, Set<number>>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    (nbr.get(a) ?? nbr.set(a, new Set()).get(a)!).add(b);
    (nbr.get(b) ?? nbr.set(b, new Set()).get(b)!).add(a);
  }
  const dist = (id: number) => Math.hypot(points[id][0] - target[0], points[id][1] - target[1], points[id][2] - target[2]);
  const path = [start];
  let cur = start;
  while (dist(cur) > short) {
    let best = -1, bd = dist(cur);
    for (const n of nbr.get(cur) ?? []) if (dist(n) < bd - 1e-9) { bd = dist(n); best = n; }
    if (best < 0) break;
    path.push(best);
    cur = best;
  }
  return path;
}
