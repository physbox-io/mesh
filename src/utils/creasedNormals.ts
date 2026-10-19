/**
 * Display normals for a mesh that has both flat faces and curved ones.
 *
 * `computeVertexNormals()` on a welded mesh gives each vertex one normal, the
 * average of every face around it. At a box corner or a hole's rim that is an
 * average of faces 90° apart, and the long sliver triangles OpenSCAD and STL
 * exporters fan out from those corners carry the leaning normal right across
 * the flat face: the dark diagonal "X" over enclosure walls and drilled plates.
 * Flat shading hides that but shows every facet of a cylinder.
 *
 * So the faces round a vertex are split into groups: two faces sharing an edge
 * through the vertex are one group when their normals are within the crease
 * angle. Each group gets its own copy of the vertex, and its normal is the
 * average of its own faces weighted by the corner angle there — a sliver meets
 * the vertex at a sliver of an angle, so it adds almost nothing. A box comes out
 * with three normals per corner; a cylinder wall stays one smooth surface.
 *
 * For drawing only. Triangle order is kept, so a raycast's faceIndex means the
 * same triangle as in the welded arrays; the vertex numbering is not kept, so
 * anything keyed to vertex indices (paint) must use the welded geometry.
 * Pure: no three, no store.
 */

import { PairMemo } from './arrayMemo';

/** Faces meeting at more than this are drawn with a hard edge between them. */
export const SHADING_CREASE_DEG = 35;

export interface CreasedGeometry {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
}

const defaultCreaseMemo = new PairMemo<CreasedGeometry>();

export function creasedGeometry(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  creaseDeg = SHADING_CREASE_DEG,
): CreasedGeometry {
  if (creaseDeg === SHADING_CREASE_DEG) {
    return defaultCreaseMemo.get(positions, faces, () => computeCreasedGeometry(positions, faces, creaseDeg));
  }
  return computeCreasedGeometry(positions, faces, creaseDeg);
}

function computeCreasedGeometry(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  creaseDeg: number,
): CreasedGeometry {
  const vertexCount = Math.floor(positions.length / 3);
  const faceCount = Math.floor(faces.length / 3);
  const creaseCos = Math.cos((creaseDeg * Math.PI) / 180);

  // Weld by position, so a builder that already repeats a point along a seam
  // still smooths across it where the surface is smooth.
  const weld = new Int32Array(vertexCount);
  let bucketCount = 1;
  while (bucketCount < vertexCount * 2) bucketCount <<= 1;
  const mask = bucketCount - 1;
  const buckets = new Int32Array(bucketCount).fill(-1);
  const next = new Int32Array(vertexCount);
  const qxArr = new Float64Array(vertexCount);
  const qyArr = new Float64Array(vertexCount);
  const qzArr = new Float64Array(vertexCount);

  for (let i = 0; i < vertexCount; i++) {
    const qx = Math.round(positions[3 * i] * 1e9);
    const qy = Math.round(positions[3 * i + 1] * 1e9);
    const qz = Math.round(positions[3 * i + 2] * 1e9);
    qxArr[i] = qx;
    qyArr[i] = qy;
    qzArr[i] = qz;
    const h = ((Math.imul(qx | 0, 73856093) ^ Math.imul(qy | 0, 19349663) ^ Math.imul(qz | 0, 83492791)) >>> 0) & mask;
    let cur = buckets[h];
    while (cur !== -1) {
      if (qxArr[cur] === qx && qyArr[cur] === qy && qzArr[cur] === qz) break;
      cur = next[cur];
    }
    if (cur === -1) {
      next[i] = buckets[h];
      buckets[h] = i;
      weld[i] = i;
    } else {
      weld[i] = cur;
    }
  }

  // Unit face normals and the angle of each face at each of its corners.
  const faceNormal = new Float64Array(faceCount * 3);
  const cornerAngle = new Float64Array(faceCount * 3);
  const valid = new Uint8Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const ia = faces[3 * f] * 3, ib = faces[3 * f + 1] * 3, ic = faces[3 * f + 2] * 3;
    const abx = positions[ib] - positions[ia], aby = positions[ib + 1] - positions[ia + 1], abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia], acy = positions[ic + 1] - positions[ia + 1], acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-20)) continue;
    valid[f] = 1;
    faceNormal[3 * f] = nx / len; faceNormal[3 * f + 1] = ny / len; faceNormal[3 * f + 2] = nz / len;

    const bcx = positions[ic] - positions[ib], bcy = positions[ic + 1] - positions[ib + 1], bcz = positions[ic + 2] - positions[ib + 2];
    const lenAB = Math.hypot(abx, aby, abz);
    const lenAC = Math.hypot(acx, acy, acz);
    const lenBC = Math.hypot(bcx, bcy, bcz);

    const d0 = (abx * acx + aby * acy + abz * acz) / (lenAB * lenAC || 1);
    const d1 = (-abx * bcx - aby * bcy - abz * bcz) / (lenAB * lenBC || 1);
    const d2 = (acx * bcx + acy * bcy + acz * bcz) / (lenAC * lenBC || 1);
    cornerAngle[3 * f] = Math.acos(Math.max(-1, Math.min(1, d0)));
    cornerAngle[3 * f + 1] = Math.acos(Math.max(-1, Math.min(1, d1)));
    cornerAngle[3 * f + 2] = Math.acos(Math.max(-1, Math.min(1, d2)));
  }

  // The corners at each welded vertex, as indices into `faces`.
  const cornerStart = new Int32Array(vertexCount + 1);
  for (let c = 0; c < faceCount * 3; c++) cornerStart[weld[faces[c]] + 1]++;
  for (let v = 0; v < vertexCount; v++) cornerStart[v + 1] += cornerStart[v];
  const fill = cornerStart.slice(0, vertexCount);
  const corners = new Int32Array(faceCount * 3);
  for (let c = 0; c < faceCount * 3; c++) corners[fill[weld[faces[c]]]++] = c;

  const maxOutVerts = Math.max(vertexCount, faceCount * 3) + 4;
  const outPositions = new Float32Array(maxOutVerts * 3);
  const outNormals = new Float32Array(maxOutVerts * 3);
  let outVertCount = 0;
  const index = new Uint32Array(faceCount * 3);

  let cap = 64;
  let parent = new Int32Array(cap);
  let groupVertex = new Int32Array(cap);
  let sums = new Float64Array(cap * 3);

  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };

  for (let v = 0; v < vertexCount; v++) {
    const start = cornerStart[v], end = cornerStart[v + 1];
    if (start === end) continue;
    const n = end - start;
    if (n > cap) {
      while (cap < n) cap <<= 1;
      parent = new Int32Array(cap);
      groupVertex = new Int32Array(cap);
      sums = new Float64Array(cap * 3);
    }
    for (let i = 0; i < n; i++) {
      parent[i] = i;
      groupVertex[i] = -1;
    }

    // Join two faces round this vertex when they share an edge out of it and
    // bend less than the crease angle across that edge.
    for (let i = 0; i < n; i++) {
      const ci = corners[start + i], fi = (ci / 3) | 0;
      if (!valid[fi]) continue;
      const ki = ci % 3;
      const i1 = weld[faces[3 * fi + (ki + 1) % 3]], i2 = weld[faces[3 * fi + (ki + 2) % 3]];
      for (let j = i + 1; j < n; j++) {
        const cj = corners[start + j], fj = (cj / 3) | 0;
        if (!valid[fj]) continue;
        const kj = cj % 3;
        const j1 = weld[faces[3 * fj + (kj + 1) % 3]], j2 = weld[faces[3 * fj + (kj + 2) % 3]];
        if (i1 !== j1 && i1 !== j2 && i2 !== j1 && i2 !== j2) continue;
        const dot = faceNormal[3 * fi] * faceNormal[3 * fj] + faceNormal[3 * fi + 1] * faceNormal[3 * fj + 1] + faceNormal[3 * fi + 2] * faceNormal[3 * fj + 2];
        if (dot >= creaseCos) parent[find(i)] = find(j);
      }
    }

    // One output vertex per group, normal angle-weighted over its faces.
    const base = outVertCount;
    let groupCount = 0;
    let firstValidGroup = -1;
    const vx = positions[3 * v], vy = positions[3 * v + 1], vz = positions[3 * v + 2];
    for (let i = 0; i < n; i++) {
      const c = corners[start + i], f = (c / 3) | 0;
      if (!valid[f]) continue;
      const root = find(i);
      let out = groupVertex[root];
      if (out < 0) {
        out = outVertCount++;
        groupVertex[root] = out;
        const pOff = out * 3;
        outPositions[pOff] = vx; outPositions[pOff + 1] = vy; outPositions[pOff + 2] = vz;
        const sOff = groupCount * 3;
        sums[sOff] = 0; sums[sOff + 1] = 0; sums[sOff + 2] = 0;
        groupCount++;
        if (firstValidGroup < 0) firstValidGroup = out;
      }
      const s = (out - base) * 3;
      const w = cornerAngle[c];
      sums[s] += faceNormal[3 * f] * w; sums[s + 1] += faceNormal[3 * f + 1] * w; sums[s + 2] += faceNormal[3 * f + 2] * w;
      index[c] = out;
    }
    for (let g = 0; g < groupCount; g++) {
      const s = g * 3;
      const len = Math.hypot(sums[s], sums[s + 1], sums[s + 2]) || 1;
      const nOff = (base + g) * 3;
      outNormals[nOff] = sums[s] / len;
      outNormals[nOff + 1] = sums[s + 1] / len;
      outNormals[nOff + 2] = sums[s + 2] / len;
    }
    // A zero-area triangle has no normal of its own; it borrows a neighbour's
    // copy of the vertex (it covers no pixels either way).
    if (firstValidGroup < 0) {
      firstValidGroup = outVertCount++;
      const pOff = firstValidGroup * 3;
      outPositions[pOff] = vx; outPositions[pOff + 1] = vy; outPositions[pOff + 2] = vz;
      outNormals[pOff] = 0; outNormals[pOff + 1] = 1; outNormals[pOff + 2] = 0;
    }
    for (let i = 0; i < n; i++) {
      const c = corners[start + i];
      if (!valid[(c / 3) | 0]) index[c] = firstValidGroup;
    }
  }

  return {
    positions: outPositions.subarray(0, outVertCount * 3),
    normals: outNormals.subarray(0, outVertCount * 3),
    index,
  };
}
