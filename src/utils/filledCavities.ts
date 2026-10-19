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
 * fills most of the empty space around it; see the comment at the clustering.
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

/** Mesh and hulls in metres, one space. */
export function findFilledCavities(verts: number[], faces: number[], hulls: Hull[]): FilledCavity[] {
  if (hulls.length === 0 || faces.length === 0) return [];
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity, mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    mnX = Math.min(mnX, verts[i]); mxX = Math.max(mxX, verts[i]);
    mnY = Math.min(mnY, verts[i + 1]); mxY = Math.max(mxY, verts[i + 1]);
    mnZ = Math.min(mnZ, verts[i + 2]); mxZ = Math.max(mxZ, verts[i + 2]);
  }
  const cell = Math.max(mxX - mnX, mxY - mnY, mxZ - mnZ) / GRID;
  if (!(cell > 0)) return [];
  const nx = Math.max(1, Math.round((mxX - mnX) / cell));
  const ny = Math.max(1, Math.round((mxY - mnY) / cell));
  const nz = Math.max(1, Math.round((mxZ - mnZ) / cell));
  const sx = (mxX - mnX) / nx, sy = (mxY - mnY) / ny, sz = (mxZ - mnZ) / nz;
  const px = (i: number) => mnX + (i + 0.5) * sx;
  const py = (j: number) => mnY + (j + 0.5) * sy;
  const pz = (k: number) => mnZ + (k + 0.5) * sz;

  // Triangles bucketed by the columns their plan-view bounds cover.
  const buckets: number[][] = Array.from({ length: nx * ny }, () => []);
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
    const x0 = Math.min(verts[a], verts[b], verts[c]), x1 = Math.max(verts[a], verts[b], verts[c]);
    const y0 = Math.min(verts[a + 1], verts[b + 1], verts[c + 1]), y1 = Math.max(verts[a + 1], verts[b + 1], verts[c + 1]);
    const i0 = Math.max(0, Math.ceil((x0 - mnX) / sx - 0.5)), i1 = Math.min(nx - 1, Math.floor((x1 - mnX) / sx - 0.5));
    const j0 = Math.max(0, Math.ceil((y0 - mnY) / sy - 0.5)), j1 = Math.min(ny - 1, Math.floor((y1 - mnY) / sy - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * nx + i].push(t);
  }

  const hullPlanes = hulls.map(planesOf);
  const hullBounds = hulls.map((h) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const v = h.verts;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < minX) minX = v[i];
      if (v[i] > maxX) maxX = v[i];
      if (v[i + 1] < minY) minY = v[i + 1];
      if (v[i + 1] > maxY) maxY = v[i + 1];
      if (v[i + 2] < minZ) minZ = v[i + 2];
      if (v[i + 2] > maxZ) maxZ = v[i + 2];
    }
    return { minX, maxX, minY, maxY, minZ, maxZ };
  });
  const eps = cell * 0.05;
  const inHull = (x: number, y: number, z: number): number => {
    for (let h = 0; h < hullPlanes.length; h++) {
      const b = hullBounds[h];
      if (
        x < b.minX - eps || x > b.maxX + eps ||
        y < b.minY - eps || y > b.maxY + eps ||
        z < b.minZ - eps || z > b.maxZ + eps
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
  const empty = new Uint8Array(nx * ny * nz);
  let meshCells = 0;
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const crossings = columnCrossings(verts, faces, buckets[j * nx + i], px(i), py(j));
      let c = 0;
      for (let k = 0; k < nz; k++) {
        const z = pz(k);
        while (c < crossings.length && crossings[c] < z) c++;
        // Inside the mesh when an odd number of crossings lie below.
        if (c % 2 === 1) {
          meshCells++;
          continue;
        }
        empty[at(i, j, k)] = 1;
        const h = inHull(px(i), py(j), z);
        if (h >= 0) excess[at(i, j, k)] = h + 1;
      }
    }
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
    if (count < meshCells * 0.005) continue;
    let air = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      if (empty[at(i, j, k)]) air++;
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
  return cavities.sort((p, q) => q.volumeMm3 - p.volumeMm3);
}
