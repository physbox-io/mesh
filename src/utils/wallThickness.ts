// How thick a body is at the place it was hit.
//
// Glass does not break because it is crushed; it breaks when its surface is
// stretched and a flaw opens. A thick piece takes a blow as a local squeeze,
// which glass is very good at. A thin wall bends instead, and bending stretches
// the surface — so the same blow that bounces off a tumbler's base goes
// through a wine glass's bowl. Averaging thickness over the body would give a
// wine glass one blended figure and no idea its rim is the fragile part, so
// this measures it where the blow landed.
//
// The method: find the surface triangle nearest the contact point, step off it
// along its INWARD normal, and see how far the ray travels before it leaves the
// solid again. That distance is the wall. Starting from the mesh's own face
// rather than the contact normal matters, because the contact normal's sign
// depends on which geom MuJoCo listed first and the contact point sits
// somewhere inside the penetration, not on either surface.
//
// Pure, and O(faces) twice per blow, which for any mesh worth shattering is
// well under a millisecond — it runs once per impact, not per step.

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/**
 * Returns true if the triangle mesh has no unmatched boundary edges (i.e. is
 * closed). First checks indexed edges; if any edge has count 1 (e.g. a
 * non-indexed soup or UV-seamed mesh), welds candidate boundary endpoints by
 * position within `weldTol` and checks whether every rim edge pairs up.
 */
function isClosedMesh(verts: ArrayLike<number>, faces: ArrayLike<number>, nTri: number, weldTol: number): boolean {
  const edgeCounts = new Map<string, number>();
  const addEdge = (u: number, v: number) => {
    if (u === v) return;
    const key = u < v ? `${u}:${v}` : `${v}:${u}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < nTri; t++) {
    const ia = faces[t * 3], ib = faces[t * 3 + 1], ic = faces[t * 3 + 2];
    if (ia === ib || ib === ic || ic === ia) continue;
    const ax = verts[ia * 3], ay = verts[ia * 3 + 1], az = verts[ia * 3 + 2];
    const bx = verts[ib * 3], by = verts[ib * 3 + 1], bz = verts[ib * 3 + 2];
    const cx = verts[ic * 3], cy = verts[ic * 3 + 1], cz = verts[ic * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (!(nx * nx + ny * ny + nz * nz > 1e-36)) continue;
    addEdge(ia, ib);
    addEdge(ib, ic);
    addEdge(ic, ia);
  }
  if (edgeCounts.size === 0) return false;

  const boundary: [number, number][] = [];
  for (const [key, count] of edgeCounts) {
    if (count === 1) {
      const sep = key.indexOf(':');
      boundary.push([Number(key.slice(0, sep)), Number(key.slice(sep + 1))]);
    }
  }
  if (boundary.length === 0) return true;

  // Weld only endpoints of raw boundary edges by 27-neighbour spatial hashing
  // so creased/non-indexed closed meshes and UV-seamed spheres pass without
  // quantization-boundary splits.
  const cell = Math.max(1e-9, weldTol * 2);
  const tol2 = weldTol * weldTol;
  const grid = new Map<string, number[]>();
  const weldedPos: number[] = [];
  const rawToWeld = new Map<number, number>();
  const weldOf = (vi: number): number => {
    const existing = rawToWeld.get(vi);
    if (existing !== undefined) return existing;
    const x = verts[vi * 3], y = verts[vi * 3 + 1], z = verts[vi * 3 + 2];
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!bucket) continue;
          for (const wid of bucket) {
            const wx = weldedPos[wid * 3] - x;
            const wy = weldedPos[wid * 3 + 1] - y;
            const wz = weldedPos[wid * 3 + 2] - z;
            if (wx * wx + wy * wy + wz * wz <= tol2) {
              rawToWeld.set(vi, wid);
              return wid;
            }
          }
        }
      }
    }
    const wid = weldedPos.length / 3;
    weldedPos.push(x, y, z);
    const cellKey = `${gx},${gy},${gz}`;
    let bucket = grid.get(cellKey);
    if (!bucket) { bucket = []; grid.set(cellKey, bucket); }
    bucket.push(wid);
    rawToWeld.set(vi, wid);
    return wid;
  };

  const weldedEdgeCounts = new Map<string, number>();
  for (const [u, v] of boundary) {
    const wu = weldOf(u), wv = weldOf(v);
    if (wu === wv) continue; // Degenerate seam edge collapsed to a point
    const key = wu < wv ? `${wu}:${wv}` : `${wv}:${wu}`;
    weldedEdgeCounts.set(key, (weldedEdgeCounts.get(key) ?? 0) + 1);
  }
  for (const count of weldedEdgeCounts.values()) {
    if (count === 1) return false;
  }
  return true;
}

export interface WallThicknessProbe {
  /** Wall thickness under `point`, in the mesh's own units. */
  thickness: number;
  /** Squared distance from `point` to the nearest surface point on this mesh. */
  dist2: number;
}

/**
 * Like `wallThicknessAt`, also returning the squared distance from `point` to
 * the mesh surface so callers with multi-geom bodies can pick the struck geom.
 */
export function probeWallThickness(
  verts: ArrayLike<number>,
  faces: ArrayLike<number>,
  point: V3,
): WallThicknessProbe | null {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2])) return null;
  const nVert = Math.floor(verts.length / 3);
  const nTri = Math.floor(faces.length / 3);
  if (nVert < 3 || nTri === 0) return null;

  // Validate indices, finiteness, bounds, and signed volume in one pass.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let refX = 0, refY = 0, refZ = 0, hasRef = false;
  let signedVol = 0;
  for (let t = 0; t < nTri; t++) {
    const ia = faces[t * 3], ib = faces[t * 3 + 1], ic = faces[t * 3 + 2];
    if (
      !Number.isInteger(ia) || !Number.isInteger(ib) || !Number.isInteger(ic) ||
      ia < 0 || ib < 0 || ic < 0 || ia >= nVert || ib >= nVert || ic >= nVert
    ) {
      return null;
    }
    const ax = verts[ia * 3], ay = verts[ia * 3 + 1], az = verts[ia * 3 + 2];
    const bx = verts[ib * 3], by = verts[ib * 3 + 1], bz = verts[ib * 3 + 2];
    const cx = verts[ic * 3], cy = verts[ic * 3 + 1], cz = verts[ic * 3 + 2];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) {
      return null;
    }
    if (!hasRef) { refX = ax; refY = ay; refZ = az; hasRef = true; }
    if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
    if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
    if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
    if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
    if (by < minY) minY = by; if (by > maxY) maxY = by;
    if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
    const rax = ax - refX, ray = ay - refY, raz = az - refZ;
    const rbx = bx - refX, rby = by - refY, rbz = bz - refZ;
    const rcx = cx - refX, rcy = cy - refY, rcz = cz - refZ;
    signedVol +=
      rax * (rby * rcz - rbz * rcy) +
      ray * (rbz * rcx - rbx * rcz) +
      raz * (rbx * rcy - rby * rcx);
  }
  if (!(Math.abs(signedVol) >= 1e-18)) return null;
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(diag >= 1e-12)) return null;

  // Reject open/unclosed single-sheet meshes (e.g. an open bowl/hemisphere)
  // so rays never cross an open cavity and report bowl diameter as wall.
  if (!isClosedMesh(verts, faces, nTri, Math.max(1e-8, diag * 1e-5))) return null;

  const outward = signedVol > 0 ? 1 : -1;
  const P = (i: number): V3 => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];

  // Scale-relative epsilon works identically in metres and millimetres.
  const EPS = Math.max(1e-7, diag * 1e-5);
  const tieTol = EPS;
  const tieTol2 = tieTol * tieTol;

  // Pass 1: find closest surface point and distance.
  let best = -1, bestD2 = Infinity;
  let start: V3 = point;
  for (let t = 0; t < nTri; t++) {
    const q = closestOnTriangle(point, P(faces[t * 3]), P(faces[t * 3 + 1]), P(faces[t * 3 + 2]));
    const d = sub(q, point);
    const d2 = dot(d, d);
    if (d2 < bestD2) { bestD2 = d2; best = t; start = q; }
  }
  if (best < 0 || !Number.isFinite(bestD2)) return null;
  const bestD = Math.sqrt(bestD2);

  // Collect all faces tied at `start` (e.g. a sharp edge, corner, 45° chamfer,
  // or thread crest) so we fire along the bisector inward normal instead of
  // grazing/clipping an adjacent face microns away.
  const skipTris = new Set<number>();
  const uniqueNormals: V3[] = [];
  for (let t = 0; t < nTri; t++) {
    const a = P(faces[t * 3]), b = P(faces[t * 3 + 1]), c = P(faces[t * 3 + 2]);
    const q = closestOnTriangle(point, a, b, c);
    const dp = sub(q, point);
    const d = Math.sqrt(dot(dp, dp));
    if (d > bestD + tieTol) continue;
    const dq = sub(q, start);
    if (dot(dq, dq) > tieTol2) continue;
    skipTris.add(t);
    const n = cross(sub(b, a), sub(c, a));
    const nLen = Math.hypot(n[0], n[1], n[2]);
    if (!(nLen >= 1e-18)) continue;
    const un: V3 = [outward * n[0] / nLen, outward * n[1] / nLen, outward * n[2] / nLen];
    if (!uniqueNormals.some((u) => dot(u, un) > 1 - 1e-4)) uniqueNormals.push(un);
  }

  let dirX = 0, dirY = 0, dirZ = 0;
  for (const un of uniqueNormals) {
    dirX -= un[0]; dirY -= un[1]; dirZ -= un[2];
  }
  let dirLen = Math.hypot(dirX, dirY, dirZ);
  if (!(dirLen >= 1e-6)) {
    const a0 = P(faces[best * 3]), b0 = P(faces[best * 3 + 1]), c0 = P(faces[best * 3 + 2]);
    const n0 = cross(sub(b0, a0), sub(c0, a0));
    const len = Math.hypot(n0[0], n0[1], n0[2]);
    if (!(len >= 1e-18)) return null;
    dirX = -outward * n0[0] / len;
    dirY = -outward * n0[1] / len;
    dirZ = -outward * n0[2] / len;
    dirLen = 1;
  }
  const dir: V3 = [dirX / dirLen, dirY / dirLen, dirZ / dirLen];

  // Möller–Trumbore against every non-tied face, tracking exiting vs entering
  // hits by outward normal sign (`dot(dir, outwardNormal) = -outward * det`).
  const BARY_EPS = 1e-7;
  const hits: Array<{ dist: number; delta: number }> = [];
  for (let t = 0; t < nTri; t++) {
    if (skipTris.has(t)) continue;
    const a = P(faces[t * 3]), b = P(faces[t * 3 + 1]), c = P(faces[t * 3 + 2]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(dir, e2);
    const det = dot(e1, h);
    if (!(Math.abs(det) >= 1e-18)) continue;
    const inv = 1 / det;
    const s = sub(start, a);
    const u = dot(s, h) * inv;
    if (u < -BARY_EPS || u > 1 + BARY_EPS) continue;
    const q = cross(s, e1);
    const v = dot(dir, q) * inv;
    if (v < -BARY_EPS || u + v > 1 + BARY_EPS) continue;
    const dist = dot(e2, q) * inv;
    if (!(dist > EPS)) continue;
    // -outward * det = dot(dir, outwardNormal_t): > 0 exits solid, < 0 enters.
    const delta = -outward * det > 0 ? -1 : 1;
    hits.push({ dist, delta });
  }
  if (hits.length === 0) return null;
  hits.sort((p, q) => p.dist - q.dist);

  // Deduplicate shared-edge hits of the same sign within EPS, then track solid
  // nesting depth (starts at 1 inside the solid) so overlapping un-merged shells
  // measure through the combined solid while single shells exit at the first
  // exiting face.
  let depth = 1;
  let lastDist = -Infinity;
  let lastDelta = 0;
  let firstExit = Infinity;
  for (const h of hits) {
    if (h.delta === lastDelta && h.dist - lastDist <= EPS) continue;
    lastDist = h.dist;
    lastDelta = h.delta;
    if (h.delta < 0 && h.dist < firstExit) firstExit = h.dist;
    depth += h.delta;
    if (depth === 0) return { thickness: h.dist, dist2: bestD2 };
  }
  return Number.isFinite(firstExit) ? { thickness: firstExit, dist2: bestD2 } : null;
}

/**
 * The wall thickness under `point`, in the mesh's own units, or null when the
 * mesh has no inside to measure (open, degenerate, or the ray never leaves).
 *
 * `verts`/`faces` are the body's mesh in the same frame as `point` — for a
 * body in the simulation, its renderVertices and the impact's local point.
 * Winding may be either way round; the signed volume says which is outward.
 */
export function wallThicknessAt(verts: ArrayLike<number>, faces: ArrayLike<number>, point: V3): number | null {
  return probeWallThickness(verts, faces, point)?.thickness ?? null;
}
