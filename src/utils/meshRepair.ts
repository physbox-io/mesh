import { analyzeMesh, type MeshIntegrity } from './meshIntegrity';
import type { SceneGeom, SceneNode } from '../types/scene';

export interface MeshRepairOptions {
  /** Vertex welding tolerance in the mesh's own coordinate units (default: auto = 1e-4 of bbox diagonal, or 1e-5 if 0). */
  weldTolerance?: number;
  /** Whether to fill open boundary loops (holes) with triangulated fans/ear-clipping (default: true). */
  fillHoles?: boolean;
  /** Whether to orient connected shells consistently and ensure positive signed volume (default: true). */
  fixWinding?: boolean;
  /** Whether to strip duplicate and opposite-wound zero-volume face pairs (default: true). */
  removeDuplicates?: boolean;
  /** Whether to strip zero-area degenerate triangles (default: true). */
  removeDegenerates?: boolean;
}

export interface MeshRepairResult {
  positions: number[];
  faces: number[];
  before: MeshIntegrity;
  after: MeshIntegrity;
  weldedVertices: number;
  removedDegenerate: number;
  removedDuplicate: number;
  removedNonManifold: number;
  filledLoops: number;
  flippedShells: number;
}

function emptyIntegrity(): MeshIntegrity {
  return {
    closed: false,
    consistentlyWound: true,
    volume: 0,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    degenerateTriangles: 0,
  };
}

const edgeKey = (u: number, v: number): string => (u < v ? `${u}_${v}` : `${v}_${u}`);

function getPos(positions: number[], idx: number): [number, number, number] {
  const i = idx * 3;
  return [positions[i], positions[i + 1], positions[i + 2]];
}

function distSq(p1: [number, number, number], p2: [number, number, number]): number {
  const dx = p1[0] - p2[0];
  const dy = p1[1] - p2[1];
  const dz = p1[2] - p2[2];
  return dx * dx + dy * dy + dz * dz;
}

function pointInTriangle2D(
  pt: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number]
): boolean {
  const cross1 = (b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]);
  const cross2 = (c[0] - b[0]) * (pt[1] - b[1]) - (c[1] - b[1]) * (pt[0] - b[0]);
  const cross3 = (a[0] - c[0]) * (pt[1] - c[1]) - (a[1] - c[1]) * (pt[0] - c[0]);
  return cross1 > 1e-12 && cross2 > 1e-12 && cross3 > 1e-12;
}

function triArea3D(
  positions: number[],
  idxA: number,
  idxB: number,
  idxC: number
): number {
  const pa = getPos(positions, idxA);
  const pb = getPos(positions, idxB);
  const pc = getPos(positions, idxC);
  const abx = pb[0] - pa[0], aby = pb[1] - pa[1], abz = pb[2] - pa[2];
  const acx = pc[0] - pa[0], acy = pc[1] - pa[1], acz = pc[2] - pa[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function addCentroidFan(
  loop: number[],
  positions: number[],
  manifoldTris: [number, number, number][]
): void {
  const k = loop.length;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < k; i++) {
    const idx = loop[i];
    cx += positions[idx * 3];
    cy += positions[idx * 3 + 1];
    cz += positions[idx * 3 + 2];
  }
  cx /= k; cy /= k; cz /= k;

  const centreIdx = Math.floor(positions.length / 3);
  positions.push(cx, cy, cz);

  for (let i = 0; i < k; i++) {
    const vCurr = loop[i];
    const vNext = loop[(i + 1) % k];
    manifoldTris.push([vNext, vCurr, centreIdx]);
  }
}

function triangulatePolygonEarClipping(
  loop: number[],
  positions: number[],
  manifoldTris: [number, number, number][],
  existingEdges: Set<string>,
  boundaryEdgeKeys: Set<string>
): void {
  const k = loop.length;
  // Reverse loop so triangles have opposite winding to mesh boundary edges
  const P = loop.slice().reverse();

  // Compute Newell normal
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < k; i++) {
    const curr = getPos(positions, P[i]);
    const next = getPos(positions, P[(i + 1) % k]);
    nx += (curr[1] - next[1]) * (curr[2] + next[2]);
    ny += (curr[2] - next[2]) * (curr[0] + next[0]);
    nz += (curr[0] - next[0]) * (curr[1] + next[1]);
  }

  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen < 1e-12) {
    addCentroidFan(loop, positions, manifoldTris);
    return;
  }

  const n: [number, number, number] = [nx / nLen, ny / nLen, nz / nLen];

  // Pick orthogonal axis
  let axis: [number, number, number] = [0, 0, 1];
  const absX = Math.abs(n[0]), absY = Math.abs(n[1]), absZ = Math.abs(n[2]);
  if (absX <= absY && absX <= absZ) axis = [1, 0, 0];
  else if (absY <= absZ) axis = [0, 1, 0];

  // uAxis = normalize(axis x n)
  const ux = axis[1] * n[2] - axis[2] * n[1];
  const uy = axis[2] * n[0] - axis[0] * n[2];
  const uz = axis[0] * n[1] - axis[1] * n[0];
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const uAxis: [number, number, number] = [ux / uLen, uy / uLen, uz / uLen];

  // vAxis = n x uAxis
  const vAxis: [number, number, number] = [
    n[1] * uAxis[2] - n[2] * uAxis[1],
    n[2] * uAxis[0] - n[0] * uAxis[2],
    n[0] * uAxis[1] - n[1] * uAxis[0],
  ];

  // Project vertices to 2D
  const pts2D: [number, number][] = P.map(idx => {
    const p = getPos(positions, idx);
    return [
      p[0] * uAxis[0] + p[1] * uAxis[1] + p[2] * uAxis[2],
      p[0] * vAxis[0] + p[1] * vAxis[1] + p[2] * vAxis[2],
    ];
  });

  // Check 2D signed area to ensure CCW
  let area2D = 0;
  for (let i = 0; i < k; i++) {
    const curr = pts2D[i];
    const next = pts2D[(i + 1) % k];
    area2D += 0.5 * (curr[0] * next[1] - next[0] * curr[1]);
  }
  if (area2D < 0) {
    for (let i = 0; i < k; i++) {
      pts2D[i][1] = -pts2D[i][1];
    }
  }

  const poly = Array.from({ length: k }, (_, i) => i);
  const newTriangles: [number, number, number][] = [];
  let stalled = false;

  while (poly.length > 3) {
    let earFound = false;
    const plen = poly.length;

    for (let i = 0; i < plen; i++) {
      const prevIdx = poly[(i - 1 + plen) % plen];
      const currIdx = poly[i];
      const nextIdx = poly[(i + 1) % plen];

      const prev2D = pts2D[prevIdx];
      const curr2D = pts2D[currIdx];
      const next2D = pts2D[nextIdx];

      // Convex corner test in CCW: (curr - prev) x (next - curr) > 0
      const cross =
        (curr2D[0] - prev2D[0]) * (next2D[1] - curr2D[1]) -
        (curr2D[1] - prev2D[1]) * (next2D[0] - curr2D[0]);
      if (cross <= 1e-12) continue;

      // Ensure no other polygon vertex lies inside candidate ear
      let hasInside = false;
      for (let j = 0; j < plen; j++) {
        const testIdx = poly[j];
        if (testIdx === prevIdx || testIdx === currIdx || testIdx === nextIdx) continue;
        if (pointInTriangle2D(pts2D[testIdx], prev2D, curr2D, next2D)) {
          hasInside = true;
          break;
        }
      }
      if (hasInside) continue;

      // Ensure not degenerate in 3D
      if (triArea3D(positions, P[prevIdx], P[currIdx], P[nextIdx]) <= 1e-18) continue;

      // Ensure interior edge doesn't already exist as a non-boundary edge in the mesh
      const internalEdgeKey = edgeKey(P[prevIdx], P[nextIdx]);
      if (existingEdges.has(internalEdgeKey) && !boundaryEdgeKeys.has(internalEdgeKey)) {
        continue;
      }

      newTriangles.push([P[prevIdx], P[currIdx], P[nextIdx]]);
      poly.splice(i, 1);
      earFound = true;
      break;
    }

    if (!earFound) {
      stalled = true;
      break;
    }
  }

  if (!stalled && poly.length === 3) {
    if (triArea3D(positions, P[poly[0]], P[poly[1]], P[poly[2]]) > 1e-18) {
      newTriangles.push([P[poly[0]], P[poly[1]], P[poly[2]]]);
    } else {
      stalled = true;
    }
  }

  if (stalled) {
    addCentroidFan(loop, positions, manifoldTris);
  } else {
    for (const tri of newTriangles) {
      manifoldTris.push(tri);
    }
  }
}

/**
 * Repairs a triangle mesh by welding seam vertices, removing degenerate and duplicate/folded
 * triangles, cleaning up non-manifold edges, making winding consistent, filling holes, and
 * ensuring outward volume orientation.
 */
export function repairMesh(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  options?: MeshRepairOptions
): MeshRepairResult {
  const posArr = Array.from(positions);
  const faceArr = Array.from(faces);

  const before: MeshIntegrity = analyzeMesh(posArr, faceArr) ?? emptyIntegrity();

  if (posArr.length < 9 || faceArr.length < 3) {
    return {
      positions: [],
      faces: [],
      before,
      after: emptyIntegrity(),
      weldedVertices: 0,
      removedDegenerate: 0,
      removedDuplicate: 0,
      removedNonManifold: 0,
      filledLoops: 0,
      flippedShells: 0,
    };
  }

  // 1. Compute bounding box diagonal
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < posArr.length; i += 3) {
    const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const bdx = maxX - minX, bdy = maxY - minY, bdz = maxZ - minZ;
  const diag = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz);

  const defaultTol = diag > 0 ? Math.max(1e-5, diag * 1e-4) : 1e-5;
  const tol = options?.weldTolerance !== undefined ? options.weldTolerance : defaultTol;

  // 2. Spatial Grid Vertex Welding
  const vCount = Math.floor(posArr.length / 3);
  let weldedPositions: number[] = [];
  const weldRemap = new Int32Array(vCount);
  let weldedVertices: number;

  if (tol > 0) {
    const cellSize = tol;
    const tolSq = tol * tol * 1.000001;
    const grid = new Map<string, number[]>();

    for (let i = 0; i < vCount; i++) {
      const px = posArr[i * 3];
      const py = posArr[i * 3 + 1];
      const pz = posArr[i * 3 + 2];

      const gx = Math.floor((px - minX) / cellSize);
      const gy = Math.floor((py - minY) / cellSize);
      const gz = Math.floor((pz - minZ) / cellSize);

      let matchIdx = -1;

      // Check center cell first
      const centerKey = `${gx},${gy},${gz}`;
      const centerBucket = grid.get(centerKey);
      if (centerBucket) {
        for (const cand of centerBucket) {
          const cx = weldedPositions[cand * 3];
          const cy = weldedPositions[cand * 3 + 1];
          const cz = weldedPositions[cand * 3 + 2];
          const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz);
          if (d2 <= tolSq) {
            matchIdx = cand;
            break;
          }
        }
      }

      // If not in center cell, check 26 neighbor cells
      if (matchIdx === -1) {
        outer: for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const key = `${gx + dx},${gy + dy},${gz + dz}`;
              const bucket = grid.get(key);
              if (!bucket) continue;
              for (const cand of bucket) {
                const cx = weldedPositions[cand * 3];
                const cy = weldedPositions[cand * 3 + 1];
                const cz = weldedPositions[cand * 3 + 2];
                const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz);
                if (d2 <= tolSq) {
                  matchIdx = cand;
                  break outer;
                }
              }
            }
          }
        }
      }

      if (matchIdx !== -1) {
        weldRemap[i] = matchIdx;
      } else {
        const newIdx = Math.floor(weldedPositions.length / 3);
        weldRemap[i] = newIdx;
        weldedPositions.push(px, py, pz);
        if (!centerBucket) {
          grid.set(centerKey, [newIdx]);
        } else {
          centerBucket.push(newIdx);
        }
      }
    }
    weldedVertices = vCount - Math.floor(weldedPositions.length / 3);
  } else {
    weldedPositions = posArr.slice();
    for (let i = 0; i < vCount; i++) weldRemap[i] = i;
    weldedVertices = 0;
  }

  const remappedFaces: number[] = new Array(faceArr.length);
  for (let i = 0; i < faceArr.length; i++) {
    remappedFaces[i] = weldRemap[faceArr[i]];
  }

  // 3. Degenerate & Duplicate / Folded Triangle Removal
  let removedDegenerate = 0;
  let removedDuplicate = 0;

  interface RawTri {
    a: number;
    b: number;
    c: number;
    min: number;
    mid: number;
    max: number;
    parity: number;
  }

  const nonDegenerateTris: RawTri[] = [];
  for (let i = 0; i < remappedFaces.length; i += 3) {
    const a = remappedFaces[i];
    const b = remappedFaces[i + 1];
    const c = remappedFaces[i + 2];

    if (a === b || b === c || a === c) {
      removedDegenerate++;
      continue;
    }

    const area = triArea3D(weldedPositions, a, b, c);
    if (area <= 1e-18) {
      removedDegenerate++;
      continue;
    }

    let min = a, mid = b, max = c;
    if (min > mid) { const t = min; min = mid; mid = t; }
    if (mid > max) { const t = mid; mid = max; max = t; }
    if (min > mid) { const t = min; min = mid; mid = t; }

    const parity =
      (a === min && b === mid && c === max) ||
      (a === mid && b === max && c === min) ||
      (a === max && b === min && c === mid)
        ? 1
        : -1;

    nonDegenerateTris.push({ a, b, c, min, mid, max, parity });
  }

  const edgeTotalCount = new Map<string, number>();
  for (const t of nonDegenerateTris) {
    const e1 = edgeKey(t.a, t.b);
    const e2 = edgeKey(t.b, t.c);
    const e3 = edgeKey(t.c, t.a);
    edgeTotalCount.set(e1, (edgeTotalCount.get(e1) ?? 0) + 1);
    edgeTotalCount.set(e2, (edgeTotalCount.get(e2) ?? 0) + 1);
    edgeTotalCount.set(e3, (edgeTotalCount.get(e3) ?? 0) + 1);
  }

  const triGroups = new Map<string, RawTri[]>();
  for (const t of nonDegenerateTris) {
    const key = `${t.min}_${t.mid}_${t.max}`;
    let grp = triGroups.get(key);
    if (!grp) {
      grp = [];
      triGroups.set(key, grp);
    }
    grp.push(t);
  }

  const keptTris: RawTri[] = [];
  for (const group of triGroups.values()) {
    if (group.length === 1) {
      keptTris.push(group[0]);
      continue;
    }

    const sample = group[0];
    const e01 = edgeKey(sample.min, sample.mid);
    const e12 = edgeKey(sample.mid, sample.max);
    const e02 = edgeKey(sample.min, sample.max);

    const outside01 = (edgeTotalCount.get(e01) ?? 0) - group.length;
    const outside12 = (edgeTotalCount.get(e12) ?? 0) - group.length;
    const outside02 = (edgeTotalCount.get(e02) ?? 0) - group.length;
    const isShared = outside01 > 0 || outside12 > 0 || outside02 > 0;

    let posList: RawTri[] = [];
    let negList: RawTri[] = [];
    for (const t of group) {
      if (t.parity === 1) posList.push(t);
      else negList.push(t);
    }

    if (posList.length > 1) {
      removedDuplicate += posList.length - 1;
      posList = [posList[0]];
    }
    if (negList.length > 1) {
      removedDuplicate += negList.length - 1;
      negList = [negList[0]];
    }

    if (posList.length === 1 && negList.length === 1) {
      if (isShared) {
        // Ear sticking off a manifold edge: drop BOTH triangles
        removedDuplicate += 2;
      } else {
        // Isolated folded pair: keep only one
        keptTris.push(posList[0]);
        removedDuplicate += 1;
      }
    } else if (posList.length === 1) {
      keptTris.push(posList[0]);
    } else if (negList.length === 1) {
      keptTris.push(negList[0]);
    }
  }

  // 4. Non-Manifold Edge Cleanup
  const M = keptTris.length;
  const triAreas = new Float64Array(M);
  const triEdges: [string, string, string][] = new Array(M);

  for (let i = 0; i < M; i++) {
    const t = keptTris[i];
    triAreas[i] = triArea3D(weldedPositions, t.a, t.b, t.c);
    triEdges[i] = [edgeKey(t.a, t.b), edgeKey(t.b, t.c), edgeKey(t.c, t.a)];
  }

  const active = new Uint8Array(M);
  active.fill(1);
  let removedNonManifold = 0;

  const edgeToFaces = new Map<string, Set<number>>();
  for (let i = 0; i < M; i++) {
    for (const e of triEdges[i]) {
      let set = edgeToFaces.get(e);
      if (!set) {
        set = new Set<number>();
        edgeToFaces.set(e, set);
      }
      set.add(i);
    }
  }

  const nonManifoldQueue: string[] = [];
  for (const [e, set] of edgeToFaces.entries()) {
    if (set.size > 2) nonManifoldQueue.push(e);
  }

  while (nonManifoldQueue.length > 0) {
    const e = nonManifoldQueue.pop()!;
    const incidentSet = edgeToFaces.get(e);
    if (!incidentSet || incidentSet.size <= 2) continue;

    const candidates = Array.from(incidentSet);
    let bestCandidate = candidates[0];
    let bestScore = -1; // Highest boundary edge count first
    let bestArea = Infinity; // Smallest area first

    for (const c of candidates) {
      let boundaryCount = 0;
      for (const otherEdge of triEdges[c]) {
        if (otherEdge !== e && edgeToFaces.get(otherEdge)?.size === 1) {
          boundaryCount++;
        }
      }
      const area = triAreas[c];
      if (boundaryCount > bestScore || (boundaryCount === bestScore && area < bestArea)) {
        bestScore = boundaryCount;
        bestArea = area;
        bestCandidate = c;
      }
    }

    active[bestCandidate] = 0;
    removedNonManifold++;
    for (const edge of triEdges[bestCandidate]) {
      const set = edgeToFaces.get(edge);
      if (set) {
        set.delete(bestCandidate);
        if (set.size > 2 && !nonManifoldQueue.includes(edge)) {
          nonManifoldQueue.push(edge);
        }
      }
    }

    if (incidentSet.size > 2) {
      nonManifoldQueue.push(e);
    }
  }

  const manifoldTris: [number, number, number][] = [];
  for (let i = 0; i < M; i++) {
    if (active[i]) {
      manifoldTris.push([keptTris[i].a, keptTris[i].b, keptTris[i].c]);
    }
  }

  // 5. Consistent Winding per Connected Shell
  if (options?.fixWinding !== false && manifoldTris.length > 0) {
    const edgeToTri = new Map<string, number[]>();
    for (let i = 0; i < manifoldTris.length; i++) {
      const tri = manifoldTris[i];
      for (let e = 0; e < 3; e++) {
        const k = edgeKey(tri[e], tri[(e + 1) % 3]);
        let list = edgeToTri.get(k);
        if (!list) {
          list = [];
          edgeToTri.set(k, list);
        }
        list.push(i);
      }
    }

    const visited = new Uint8Array(manifoldTris.length);
    for (let start = 0; start < manifoldTris.length; start++) {
      if (visited[start]) continue;
      visited[start] = 1;
      const queue: number[] = [start];

      while (queue.length > 0) {
        const t1Idx = queue.shift()!;
        const t1 = manifoldTris[t1Idx];

        for (let e = 0; e < 3; e++) {
          const u = t1[e], v = t1[(e + 1) % 3];
          const k = edgeKey(u, v);
          const pair = edgeToTri.get(k);
          if (!pair || pair.length < 2) continue;

          const t2Idx = pair[0] === t1Idx ? pair[1] : pair[0];
          if (visited[t2Idx]) continue;
          visited[t2Idx] = 1;

          const t2 = manifoldTris[t2Idx];
          const walksSameDirection =
            (t2[0] === u && t2[1] === v) ||
            (t2[1] === u && t2[2] === v) ||
            (t2[2] === u && t2[0] === v);

          if (walksSameDirection) {
            const tmp = t2[1];
            t2[1] = t2[2];
            t2[2] = tmp;
          }

          queue.push(t2Idx);
        }
      }
    }
  }

  // 5b. Hole Filling
  let filledLoops = 0;
  const currentPositions = weldedPositions.slice();

  if (options?.fillHoles !== false && manifoldTris.length > 0) {
    const directedEdges = new Set<string>();
    const edgeCount = new Map<string, number>();

    for (const tri of manifoldTris) {
      for (let e = 0; e < 3; e++) {
        const u = tri[e], v = tri[(e + 1) % 3];
        directedEdges.add(`${u}_${v}`);
        const ek = edgeKey(u, v);
        edgeCount.set(ek, (edgeCount.get(ek) ?? 0) + 1);
      }
    }

    const outgoingBoundary = new Map<number, number[]>();
    const boundaryEdgeKeys = new Set<string>();

    for (const [ek, count] of edgeCount.entries()) {
      if (count === 1) {
        boundaryEdgeKeys.add(ek);
        const [uStr, vStr] = ek.split('_');
        const u = parseInt(uStr, 10);
        const v = parseInt(vStr, 10);
        const [from, to] = directedEdges.has(`${u}_${v}`) ? [u, v] : [v, u];
        let list = outgoingBoundary.get(from);
        if (!list) {
          list = [];
          outgoingBoundary.set(from, list);
        }
        list.push(to);
      }
    }

    // Chain directed boundary half-edges into simple closed cycles
    const usedEdges = new Set<string>();
    const loops: number[][] = [];

    for (const [startNode, toList] of outgoingBoundary.entries()) {
      for (const nextNode of toList) {
        const startEdge = `${startNode}_${nextNode}`;
        if (usedEdges.has(startEdge)) continue;

        usedEdges.add(startEdge);
        const path: number[] = [startNode];
        const pathIndexMap = new Map<number, number>();
        pathIndexMap.set(startNode, 0);

        let curr = nextNode;
        while (true) {
          if (pathIndexMap.has(curr)) {
            const cycleStart = pathIndexMap.get(curr)!;
            const cycle = path.slice(cycleStart);
            if (cycle.length >= 3) {
              loops.push(cycle);
            }
            path.length = cycleStart;
            for (const v of cycle) {
              pathIndexMap.delete(v);
            }
            if (path.length === 0) break;
            curr = path[path.length - 1];
          } else {
            pathIndexMap.set(curr, path.length);
            path.push(curr);
          }

          const outgoing = outgoingBoundary.get(curr);
          let foundNext = false;
          if (outgoing) {
            for (const cand of outgoing) {
              const edgeId = `${curr}_${cand}`;
              if (!usedEdges.has(edgeId)) {
                usedEdges.add(edgeId);
                curr = cand;
                foundNext = true;
                break;
              }
            }
          }
          if (!foundNext) {
            break;
          }
        }
      }
    }

    const existingMeshEdges = new Set<string>();
    for (const tri of manifoldTris) {
      existingMeshEdges.add(edgeKey(tri[0], tri[1]));
      existingMeshEdges.add(edgeKey(tri[1], tri[2]));
      existingMeshEdges.add(edgeKey(tri[2], tri[0]));
    }

    for (const loop of loops) {
      const k = loop.length;
      if (k === 3) {
        manifoldTris.push([loop[0], loop[2], loop[1]]);
        filledLoops++;
      } else if (k === 4) {
        const v0 = loop[0], v1 = loop[1], v2 = loop[2], v3 = loop[3];
        const p0 = getPos(currentPositions, v0);
        const p1 = getPos(currentPositions, v1);
        const p2 = getPos(currentPositions, v2);
        const p3 = getPos(currentPositions, v3);

        const d02 = distSq(p0, p2);
        const d13 = distSq(p1, p3);

        if (d02 <= d13) {
          manifoldTris.push([v0, v3, v2]);
          manifoldTris.push([v0, v2, v1]);
        } else {
          manifoldTris.push([v1, v0, v3]);
          manifoldTris.push([v1, v3, v2]);
        }
        filledLoops++;
      } else {
        triangulatePolygonEarClipping(
          loop,
          currentPositions,
          manifoldTris,
          existingMeshEdges,
          boundaryEdgeKeys
        );
        filledLoops++;
      }
    }
  }

  // 6. Outward Volume Orientation
  let flippedShells = 0;
  if (options?.fixWinding !== false && manifoldTris.length > 0) {
    const edgeToTri = new Map<string, number[]>();
    for (let i = 0; i < manifoldTris.length; i++) {
      const tri = manifoldTris[i];
      for (let e = 0; e < 3; e++) {
        const k = edgeKey(tri[e], tri[(e + 1) % 3]);
        let l = edgeToTri.get(k);
        if (!l) {
          l = [];
          edgeToTri.set(k, l);
        }
        l.push(i);
      }
    }

    const visited = new Uint8Array(manifoldTris.length);
    for (let i = 0; i < manifoldTris.length; i++) {
      if (visited[i]) continue;
      const comp: number[] = [i];
      visited[i] = 1;
      const queue = [i];

      while (queue.length > 0) {
        const cur = queue.shift()!;
        const tri = manifoldTris[cur];
        for (let e = 0; e < 3; e++) {
          const k = edgeKey(tri[e], tri[(e + 1) % 3]);
          const neighbors = edgeToTri.get(k);
          if (neighbors) {
            for (const nbr of neighbors) {
              if (!visited[nbr]) {
                visited[nbr] = 1;
                comp.push(nbr);
                queue.push(nbr);
              }
            }
          }
        }
      }

      let shellVolume = 0;
      for (const tIdx of comp) {
        const tri = manifoldTris[tIdx];
        const a = tri[0] * 3, b = tri[1] * 3, c = tri[2] * 3;
        shellVolume += (
          currentPositions[a] * (currentPositions[b + 1] * currentPositions[c + 2] - currentPositions[b + 2] * currentPositions[c + 1])
          - currentPositions[a + 1] * (currentPositions[b] * currentPositions[c + 2] - currentPositions[b + 2] * currentPositions[c])
          + currentPositions[a + 2] * (currentPositions[b] * currentPositions[c + 1] - currentPositions[b + 1] * currentPositions[c])
        ) / 6;
      }

      if (shellVolume < -1e-12) {
        for (const tIdx of comp) {
          const tri = manifoldTris[tIdx];
          const tmp = tri[1];
          tri[1] = tri[2];
          tri[2] = tmp;
        }
        flippedShells++;
      }
    }
  }

  // 7. Compact unused vertices
  const flatFaces: number[] = new Array(manifoldTris.length * 3);
  for (let i = 0; i < manifoldTris.length; i++) {
    flatFaces[i * 3] = manifoldTris[i][0];
    flatFaces[i * 3 + 1] = manifoldTris[i][1];
    flatFaces[i * 3 + 2] = manifoldTris[i][2];
  }

  const vCountTotal = Math.floor(currentPositions.length / 3);
  const used = new Uint8Array(vCountTotal);
  for (let i = 0; i < flatFaces.length; i++) {
    used[flatFaces[i]] = 1;
  }

  const newIndexMap = new Int32Array(vCountTotal).fill(-1);
  const outPositions: number[] = [];
  let nextIdx = 0;

  for (let i = 0; i < vCountTotal; i++) {
    if (used[i]) {
      newIndexMap[i] = nextIdx++;
      outPositions.push(
        currentPositions[i * 3],
        currentPositions[i * 3 + 1],
        currentPositions[i * 3 + 2]
      );
    }
  }

  const outFaces: number[] = new Array(flatFaces.length);
  for (let i = 0; i < flatFaces.length; i++) {
    outFaces[i] = newIndexMap[flatFaces[i]];
  }

  const after: MeshIntegrity = analyzeMesh(outPositions, outFaces) ?? emptyIntegrity();

  return {
    positions: outPositions,
    faces: outFaces,
    before,
    after,
    weldedVertices,
    removedDegenerate,
    removedDuplicate,
    removedNonManifold,
    filledLoops,
    flippedShells,
  };
}

/**
 * Converts Three.js Y-up positions (x, y, z) to MuJoCo Z-up positions (x, -z, y).
 */
export function yupToZup(yup: ArrayLike<number>): number[] {
  const out = new Array<number>(yup.length);
  for (let i = 0; i < yup.length; i += 3) {
    out[i] = yup[i];
    out[i + 1] = -yup[i + 2];
    out[i + 2] = yup[i + 1];
  }
  return out;
}

/**
 * Converts MuJoCo Z-up positions (x, y, z) to Three.js Y-up positions (x, z, -y).
 */
export function zupToYup(zup: ArrayLike<number>): number[] {
  const out = new Array<number>(zup.length);
  for (let i = 0; i < zup.length; i += 3) {
    out[i] = zup[i];
    out[i + 1] = zup[i + 2];
    out[i + 2] = -zup[i + 1];
  }
  return out;
}

/**
 * Repairs a SceneGeom's mesh geometry:
 * - If renderVertices exists (Z-up), repairs it and derives vertices (Y-up).
 * - If renderVertices is absent, converts vertices (Y-up) to Z-up, repairs, and updates both.
 */
export function repairSceneGeom(
  geom: SceneGeom,
  options?: MeshRepairOptions
): { geom: SceneGeom; report: MeshRepairResult } | null {
  if (geom.type !== 'mesh') return null;

  let zupPositions: number[] | null = null;
  if (geom.renderVertices && geom.renderVertices.length > 0) {
    zupPositions = Array.from(geom.renderVertices);
  } else if (geom.vertices && geom.vertices.length > 0) {
    zupPositions = yupToZup(geom.vertices);
  }

  if (!zupPositions || !geom.faces || geom.faces.length === 0) {
    return null;
  }

  const report = repairMesh(zupPositions, geom.faces, {
    weldTolerance: 1e-5,
    ...options,
  });
  const yupVertices = zupToYup(report.positions);

  const updatedGeom: SceneGeom = {
    ...geom,
    renderVertices: report.positions,
    vertices: yupVertices,
    faces: report.faces,
  };

  return { geom: updatedGeom, report };
}

export async function runMcpRepairMesh(params: {
  msg: Record<string, unknown>;
  toId: (s: string) => string;
  nodes: SceneNode[];
  findNodeInScene: (nodes: SceneNode[], id: string) => SceneNode | null;
  updateNode: (id: string, patch: Partial<SceneNode>) => void;
  compileCsgNodes: () => Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const { msg, toId, nodes, findNodeInScene, updateNode, compileCsgNodes } = params;
  const rawId = typeof msg.targetId === 'string'
    ? msg.targetId
    : typeof msg.bodyId === 'string'
      ? msg.bodyId
      : undefined;
  const targetId = rawId ? toId(rawId) : undefined;
  const geomNameFilter = typeof msg.geomName === 'string' ? msg.geomName : undefined;
  const weldTolM = typeof msg.weldToleranceMm === 'number' && msg.weldToleranceMm >= 0
    ? msg.weldToleranceMm / 1000
    : typeof msg.weldTolerance === 'number' && msg.weldTolerance >= 0
      ? msg.weldTolerance
      : 1e-5;
  const fillHoles = msg.fillHoles !== false;
  const fixWinding = msg.fixWinding !== false;
  const removeDuplicates = msg.removeDuplicates !== false;
  const removeDegenerates = msg.removeDegenerates !== false;

  const targets: SceneNode[] = [];
  if (targetId) {
    const found = findNodeInScene(nodes, targetId);
    if (!found) return { ok: false, error: `No object with id '${rawId}'.` };
    targets.push(found);
  } else {
    const collectAll = (list: SceneNode[]) => {
      for (const n of list || []) {
        if ((n.geoms || []).some((g) => g.type === 'mesh' && g.csgDerived !== 'collider')) {
          targets.push(n);
        }
        if (n.children?.length) collectAll(n.children);
      }
    };
    collectAll(nodes);
  }

  if (targets.length === 0) {
    return { ok: false, error: 'No mesh geometry found to repair.' };
  }

  const reports: Array<Record<string, unknown>> = [];
  let touchedCsgNode = false;

  for (const node of targets) {
    const geoms = node.geoms || [];
    let modified = false;
    const nextGeoms = geoms.map((g, idx) => {
      if (g.type !== 'mesh' || g.csgDerived === 'collider') return g;
      if (geomNameFilter && g.name !== geomNameFilter) return g;
      const repaired = repairSceneGeom(g, {
        weldTolerance: weldTolM,
        fillHoles,
        fixWinding,
        removeDuplicates,
        removeDegenerates,
      });
      if (!repaired) return g;
      modified = true;
      const { report } = repaired;
      const fmtStats = (s: MeshIntegrity) => ({
        watertight: s.closed && s.consistentlyWound,
        consistentlyWound: s.consistentlyWound,
        boundaryEdges: s.boundaryEdges,
        nonManifoldEdges: s.nonManifoldEdges,
        degenerateTriangles: s.degenerateTriangles,
        volumeMm3: Math.round(s.volume * 1e9 * 10) / 10,
      });
      reports.push({
        bodyId: node.id,
        bodyName: node.name,
        geomName: g.name || `mesh_${idx}`,
        before: fmtStats(report.before),
        after: fmtStats(report.after),
        weldedVertices: report.weldedVertices,
        removedDegenerate: report.removedDegenerate,
        removedDuplicate: report.removedDuplicate,
        removedNonManifold: report.removedNonManifold,
        filledLoops: report.filledLoops,
        flippedShells: report.flippedShells,
      });
      return repaired.geom;
    });

    if (modified) {
      if (node.csgEnabled) touchedCsgNode = true;
      updateNode(node.id, {
        geoms: nextGeoms,
        ...(node.csgEnabled ? { csgHash: undefined, csgError: undefined } : {}),
      });
    }
  }

  if (reports.length === 0) {
    return {
      ok: false,
      error: geomNameFilter
        ? `No mesh geom named '${geomNameFilter}' found on the target body.`
        : 'No repairable mesh geoms found on the target body.',
    };
  }

  if (touchedCsgNode) {
    await compileCsgNodes();
  }

  return {
    ok: true,
    repairedCount: reports.length,
    meshes: reports,
  };
}
