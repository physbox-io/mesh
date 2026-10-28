import type { Hull } from './csg';

/**
 * Where a set of convex colliders fills in space the mesh leaves empty.
 *
 * A decomposition can look healthy — "9 convex pieces" — and still have one
 * of those pieces bridging a groove: the oak tray's 12 mm phone slot came out
 * solid, and the only clue was a phone that would not go in. This finds such
 * places by sampling a grid over the mesh's bounds: a point inside some hull
 * but outside the mesh is filled-in air.
 *
 * Every decomposition overshoots a little — hulls bulge into any concave
 * wall — so there is always some excess. What is reported is excess that
 * fills most of the empty space around it (see the comment at the
 * clustering), or a piece that is mostly deep air (see filledHulls).
 */

export interface FilledCavity {
  /** Middle of the filled region, in the mesh's own frame (MuJoCo Z-up), mm. */
  centerMm: [number, number, number];
  /** Its size along X, Y and Z, mm. */
  extentMm: [number, number, number];
  volumeMm3: number;
  /** Index of the hull holding most of it. */
  coveredBy: number;
}

/** Grid cells along the longest side of the mesh. */
const GRID = 64;

/**
 * The per-piece check below samples finer, at half the part's wall thickness,
 * and this caps what that costs: a few hundred milliseconds in the worker.
 */
const MAX_FINE_CELLS = 1_500_000;

/**
 * A piece at least this much air is filling something in, if that air is deep
 * (HULL_AIR_DEPTH). A piece of a sound decomposition is mostly part: on the
 * cup, the open box and the torus fixtures none is more than 35 % air.
 */
const HULL_AIR_SHARE = 0.5;

/**
 * ...and deep means this many wall thicknesses from the nearest surface. A
 * piece that wraps a wall and a strip of floor fills the corner between them
 * with a fillet of air, a few millimetres deep; one that spans a channel
 * fills it to the middle. On the 32 x 12 mm coaster channel (3 mm walls) the
 * spanning pieces' air reaches 6 mm from any surface.
 */
const HULL_AIR_DEPTH = 1.5;

interface Plane { nx: number; ny: number; nz: number; d: number }

function planesOf(h: Hull): Plane[] {
  const v = h.verts;
  const out: Plane[] = [];
  for (let i = 0; i < h.faces.length; i += 3) {
    const a = h.faces[i] * 3, b = h.faces[i + 1] * 3, c = h.faces[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-18) continue;
    nx /= len; ny /= len; nz /= len;
    out.push({ nx, ny, nz, d: nx * v[a] + ny * v[a + 1] + nz * v[a + 2] });
  }
  return out;
}

interface Bounds { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }

function boundsOf(v: number[]): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i];
    if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1];
    if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2];
    if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * Heights where a vertical line through (x, y) crosses the mesh, sorted, with
 * a ray through a shared edge counted once.
 */
function columnCrossings(verts: number[], faces: number[], tris: number[], x: number, y: number): number[] {
  const hits: number[] = [];
  for (const t of tris) {
    const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], bx = verts[b], by = verts[b + 1], cx = verts[c], cy = verts[c + 1];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (den === 0) continue;
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const w = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    if (u < 0 || w < 0 || u + w > 1) continue;
    hits.push(u * verts[a + 2] + w * verts[b + 2] + (1 - u - w) * verts[c + 2]);
  }
  hits.sort((p, q) => p - q);
  const out: number[] = [];
  for (const h of hits) if (out.length === 0 || h - out[out.length - 1] > 1e-7) out.push(h);
  return out;
}

/** A grid of cells over the mesh's bounds, each marked inside the mesh or not. */
interface Grid {
  nx: number; ny: number; nz: number;
  sx: number; sy: number; sz: number;
  b: Bounds;
  /** 1 where the cell's centre is inside the mesh. */
  solid: Uint8Array;
  solidCells: number;
}

function sampleGrid(verts: number[], faces: number[], b: Bounds, cell: number): Grid {
  const nx = Math.max(1, Math.round((b.maxX - b.minX) / cell));
  const ny = Math.max(1, Math.round((b.maxY - b.minY) / cell));
  const nz = Math.max(1, Math.round((b.maxZ - b.minZ) / cell));
  const sx = (b.maxX - b.minX) / nx, sy = (b.maxY - b.minY) / ny, sz = (b.maxZ - b.minZ) / nz;

  // Triangles bucketed by the columns their plan-view bounds cover.
  const buckets: number[][] = Array.from({ length: nx * ny }, () => []);
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] * 3, bb = faces[t + 1] * 3, c = faces[t + 2] * 3;
    const x0 = Math.min(verts[a], verts[bb], verts[c]), x1 = Math.max(verts[a], verts[bb], verts[c]);
    const y0 = Math.min(verts[a + 1], verts[bb + 1], verts[c + 1]), y1 = Math.max(verts[a + 1], verts[bb + 1], verts[c + 1]);
    const i0 = Math.max(0, Math.ceil((x0 - b.minX) / sx - 0.5)), i1 = Math.min(nx - 1, Math.floor((x1 - b.minX) / sx - 0.5));
    const j0 = Math.max(0, Math.ceil((y0 - b.minY) / sy - 0.5)), j1 = Math.min(ny - 1, Math.floor((y1 - b.minY) / sy - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * nx + i].push(t);
  }

  const solid = new Uint8Array(nx * ny * nz);
  let solidCells = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const crossings = columnCrossings(verts, faces, buckets[j * nx + i], b.minX + (i + 0.5) * sx, b.minY + (j + 0.5) * sy);
      let c = 0;
      for (let k = 0; k < nz; k++) {
        const z = b.minZ + (k + 0.5) * sz;
        while (c < crossings.length && crossings[c] < z) c++;
        // Inside the mesh when an odd number of crossings lie below.
        if (c % 2 === 1) {
          solid[(k * ny + j) * nx + i] = 1;
          solidCells++;
        }
      }
    }
  }
  return { nx, ny, nz, sx, sy, sz, b, solid, solidCells };
}

/** Mesh and hulls in metres, one space. */
export function findFilledCavities(verts: number[], faces: number[], hulls: Hull[]): FilledCavity[] {
  if (hulls.length === 0 || faces.length === 0) return [];
  const b = boundsOf(verts);
  const longest = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
  if (!(longest > 0)) return [];
  const bridged = bridgedCavities(verts, faces, hulls, sampleGrid(verts, faces, b, longest / GRID));
  const named = new Set(bridged.map((c) => c.coveredBy));
  const deep = filledHulls(verts, faces, hulls, b).filter((c) => !named.has(c.coveredBy));
  return [...bridged, ...deep].sort((p, q) => q.volumeMm3 - p.volumeMm3);
}

/**
 * Air the hulls fill that fills most of the empty space around it: a slot, a
 * groove, the whole inside of a cup.
 */
function bridgedCavities(verts: number[], faces: number[], hulls: Hull[], g: Grid): FilledCavity[] {
  const { nx, ny, nz, sx, sy, sz, b, solid } = g;
  const px = (i: number) => b.minX + (i + 0.5) * sx;
  const py = (j: number) => b.minY + (j + 0.5) * sy;
  const pz = (k: number) => b.minZ + (k + 0.5) * sz;

  const hullPlanes = hulls.map(planesOf);
  const hullBounds = hulls.map((h) => boundsOf(h.verts));
  const eps = Math.max(sx, sy, sz) * 0.05;
  const inHull = (x: number, y: number, z: number): number => {
    for (let h = 0; h < hullPlanes.length; h++) {
      const hb = hullBounds[h];
      if (
        x < hb.minX - eps || x > hb.maxX + eps ||
        y < hb.minY - eps || y > hb.maxY + eps ||
        z < hb.minZ - eps || z > hb.maxZ + eps
      ) {
        continue;
      }
      let inside = true;
      for (const p of hullPlanes[h]) {
        if (p.nx * x + p.ny * y + p.nz * z - p.d > eps) { inside = false; break; }
      }
      if (inside) return h;
    }
    return -1;
  };

  // excess[] holds 1 + the hull index for filled-in air, 0 otherwise.
  const excess = new Int16Array(nx * ny * nz);
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (solid[at(i, j, k)]) continue;
    const h = inHull(px(i), py(j), pz(k));
    if (h >= 0) excess[at(i, j, k)] = h + 1;
  }

  // Filled-in air comes in two kinds. Every decomposition leaves a skin of it
  // over each concave wall — sixteen hulls round a 160 mm cup bulge 6 mm into
  // it mid-facet — and the skin, however thick, covers a small share of the
  // air beside it. A hull bridging a slot fills the slot. So each connected
  // region of excess is judged by how much of the empty space inside its own
  // bounds it fills, and must be at least three cells thick every way.
  const seen = new Uint8Array(excess.length);
  const cavities: FilledCavity[] = [];
  const cellVolMm3 = sx * sy * sz * 1e9;
  for (let start = 0; start < excess.length; start++) {
    if (seen[start] || !excess[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let count = 0;
    const lo = [nx, ny, nz], hi = [-1, -1, -1];
    let sumX = 0, sumY = 0, sumZ = 0;
    const votes = new Map<number, number>();
    while (stack.length) {
      const q = stack.pop()!;
      const qi = q % nx, qj = Math.floor(q / nx) % ny, qk = Math.floor(q / (nx * ny));
      count++;
      sumX += px(qi); sumY += py(qj); sumZ += pz(qk);
      lo[0] = Math.min(lo[0], qi); lo[1] = Math.min(lo[1], qj); lo[2] = Math.min(lo[2], qk);
      hi[0] = Math.max(hi[0], qi); hi[1] = Math.max(hi[1], qj); hi[2] = Math.max(hi[2], qk);
      votes.set(excess[q] - 1, (votes.get(excess[q] - 1) ?? 0) + 1);
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const ai = qi + di, aj = qj + dj, ak = qk + dk;
        if (ai < 0 || aj < 0 || ak < 0 || ai >= nx || aj >= ny || ak >= nz) continue;
        const a = at(ai, aj, ak);
        if (seen[a] || !excess[a]) continue;
        seen[a] = 1;
        stack.push(a);
      }
    }
    if (hi[0] - lo[0] < 2 || hi[1] - lo[1] < 2 || hi[2] - lo[2] < 2) continue;
    if (count < g.solidCells * 0.005) continue;
    let air = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      if (!solid[at(i, j, k)]) air++;
    }
    if (count < air * 0.6) continue;
    const coveredBy = [...votes.entries()].sort((p, q) => q[1] - p[1])[0][0];
    const r = (v: number) => Math.round(v * 10000) / 10;
    cavities.push({
      centerMm: [r(sumX / count), r(sumY / count), r(sumZ / count)],
      extentMm: [r((hi[0] - lo[0] + 1) * sx), r((hi[1] - lo[1] + 1) * sy), r((hi[2] - lo[2] + 1) * sz)],
      volumeMm3: Math.round(count * cellVolMm3),
      coveredBy,
    });
  }
  return cavities;
}

/**
 * The part's typical wall thickness: twice its volume over its surface area,
 * which is exact for a wide plate and close for a channel or a shell.
 */
export function wallThickness(verts: number[], faces: number[]): number {
  let volume = 0, area = 0;
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const wx = verts[c] - verts[a], wy = verts[c + 1] - verts[a + 1], wz = verts[c + 2] - verts[a + 2];
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    volume += (verts[a] * (verts[b + 1] * verts[c + 2] - verts[b + 2] * verts[c + 1])
      - verts[a + 1] * (verts[b] * verts[c + 2] - verts[b + 2] * verts[c])
      + verts[a + 2] * (verts[b] * verts[c + 1] - verts[b + 1] * verts[c])) / 6;
  }
  return area > 0 ? (2 * Math.abs(volume)) / area : 0;
}

/**
 * Squared distance from each cell to the nearest solid one, in metres², by
 * the separable exact transform (Felzenszwalb & Huttenlocher), one axis at a
 * time.
 */
function distanceToSolid(g: Grid): Float64Array {
  const { nx, ny, nz, sx, sy, sz, solid } = g;
  const INF = 1e20;
  const d = new Float64Array(solid.length);
  for (let i = 0; i < d.length; i++) d[i] = solid[i] ? 0 : INF;
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n), out = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const pass = (len: number, step: number, s: number, starts: number[]) => {
    for (const base of starts) {
      for (let q = 0; q < len; q++) f[q] = d[base + q * step];
      let k = 0;
      v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let q = 1; q < len; q++) {
        if (f[q] >= INF) continue;
        if (f[v[0]] >= INF) { v[0] = q; continue; }
        let sAt: number;
        for (;;) {
          const p = v[k];
          sAt = ((f[q] + (q * s) ** 2) - (f[p] + (p * s) ** 2)) / (2 * s * (q - p)) / s;
          if (sAt <= z[k] && k > 0) k--;
          else break;
        }
        k++;
        v[k] = q; z[k] = sAt; z[k + 1] = Infinity;
      }
      if (f[v[0]] >= INF) continue;
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        const p = v[k];
        out[q] = ((q - p) * s) ** 2 + f[p];
      }
      for (let q = 0; q < len; q++) d[base + q * step] = out[q];
    }
  };
  const rows: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) rows.push((k * ny + j) * nx);
  pass(nx, 1, sx, rows);
  const cols: number[] = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) cols.push(k * ny * nx + i);
  pass(ny, nx, sy, cols);
  const stacks: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) stacks.push(j * nx + i);
  pass(nz, nx * ny, sz, stacks);
  return d;
}

/**
 * Pieces that are mostly deep air.
 *
 * The clustering above judges a region of filled air by the empty space in
 * its bounding box, which is right for a slot in a tray and wrong for a long
 * channel: a U-section coaster track, sloping and curving, has a box full of
 * open air above it, so a channel filled along its whole length never fills
 * enough of that box to be reported. Here each piece is judged on its own: a
 * piece that is at least HULL_AIR_SHARE air, and whose air reaches
 * HULL_AIR_DEPTH wall thicknesses from any surface, is standing in a cavity
 * rather than hugging a wall.
 */
function filledHulls(verts: number[], faces: number[], hulls: Hull[], b: Bounds): FilledCavity[] {
  const t = wallThickness(verts, faces);
  if (!(t > 0)) return [];
  const dx = b.maxX - b.minX, dy = b.maxY - b.minY, dz = b.maxZ - b.minZ;
  const longest = Math.max(dx, dy, dz);
  // Fine enough that a wall is two cells thick, and no finer than the budget allows.
  const floor = Math.cbrt((Math.max(dx, longest / GRID) * Math.max(dy, longest / GRID) * Math.max(dz, longest / GRID)) / MAX_FINE_CELLS);
  const g = sampleGrid(verts, faces, b, Math.max(floor, Math.min(longest / GRID, t / 2)));
  if (g.solidCells === 0) return [];
  const dist2 = distanceToSolid(g);
  const { nx, ny, nz, sx, sy, sz } = g;
  const cell = Math.max(sx, sy, sz);
  const deepEnough = Math.max(HULL_AIR_DEPTH * t, 2 * cell);
  const cellVolMm3 = sx * sy * sz * 1e9;
  const r = (v: number) => Math.round(v * 10000) / 10;

  const out: FilledCavity[] = [];
  hulls.forEach((h, index) => {
    const planes = planesOf(h);
    const hb = boundsOf(h.verts);
    const i0 = Math.max(0, Math.ceil((hb.minX - b.minX) / sx - 0.5)), i1 = Math.min(nx - 1, Math.floor((hb.maxX - b.minX) / sx - 0.5));
    const j0 = Math.max(0, Math.ceil((hb.minY - b.minY) / sy - 0.5)), j1 = Math.min(ny - 1, Math.floor((hb.maxY - b.minY) / sy - 0.5));
    const k0 = Math.max(0, Math.ceil((hb.minZ - b.minZ) / sz - 0.5)), k1 = Math.min(nz - 1, Math.floor((hb.maxZ - b.minZ) / sz - 0.5));
    let inside = 0, air = 0, deepest = 0;
    let sumX = 0, sumY = 0, sumZ = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = k0; k <= k1; k++) {
      const z = b.minZ + (k + 0.5) * sz;
      for (let j = j0; j <= j1; j++) {
        const y = b.minY + (j + 0.5) * sy;
        for (let i = i0; i <= i1; i++) {
          const x = b.minX + (i + 0.5) * sx;
          let within = true;
          for (const p of planes) {
            if (p.nx * x + p.ny * y + p.nz * z - p.d > 0) { within = false; break; }
          }
          if (!within) continue;
          inside++;
          const c = (k * ny + j) * nx + i;
          if (g.solid[c]) continue;
          air++;
          // From a cell's centre to the nearest solid centre overshoots the
          // surface by about half a cell.
          deepest = Math.max(deepest, Math.sqrt(dist2[c]) - cell / 2);
          sumX += x; sumY += y; sumZ += z;
          lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); lo[2] = Math.min(lo[2], z);
          hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y); hi[2] = Math.max(hi[2], z);
        }
      }
    }
    if (inside < 8 || air < inside * HULL_AIR_SHARE || deepest < deepEnough) return;
    out.push({
      centerMm: [r(sumX / air), r(sumY / air), r(sumZ / air)],
      extentMm: [r(hi[0] - lo[0] + sx), r(hi[1] - lo[1] + sy), r(hi[2] - lo[2] + sz)],
      volumeMm3: Math.round(air * cellVolMm3),
      coveredBy: index,
    });
  });
  return out;
}
