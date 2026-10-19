import * as THREE from 'three';

const MIN_BVH_TRIANGLES = 256;
const LEAF_SIZE = 8;
const MAX_DEPTH = 28;

export interface FlatBvh {
  bounds: Float32Array;
  leftOrStart: Int32Array;
  countOrRight: Int32Array;
  triOrder: Uint32Array;
  nodeCount: number;
}

interface CachedEntry {
  posVersion: number;
  idxVersion: number;
  seenAtVersion: number;
  bvh: FlatBvh | null;
}

const bvhCache = new WeakMap<THREE.BufferGeometry, CachedEntry>();

export function buildFlatBvh(positions: ArrayLike<number>, indices: ArrayLike<number>): FlatBvh {
  const triCount = (indices.length / 3) | 0;
  const triOrder = new Uint32Array(triCount);
  const triMinX = new Float32Array(triCount);
  const triMinY = new Float32Array(triCount);
  const triMinZ = new Float32Array(triCount);
  const triMaxX = new Float32Array(triCount);
  const triMaxY = new Float32Array(triCount);
  const triMaxZ = new Float32Array(triCount);
  const triCx = new Float32Array(triCount);
  const triCy = new Float32Array(triCount);
  const triCz = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    triOrder[t] = t;
    const i0 = indices[3 * t] * 3;
    const i1 = indices[3 * t + 1] * 3;
    const i2 = indices[3 * t + 2] * 3;
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
    triMinX[t] = ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx);
    triMinY[t] = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
    triMinZ[t] = az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz);
    triMaxX[t] = ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx);
    triMaxY[t] = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
    triMaxZ[t] = az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz);
    triCx[t] = (ax + bx + cx) * (1 / 3);
    triCy[t] = (ay + by + cy) * (1 / 3);
    triCz[t] = (az + bz + cz) * (1 / 3);
  }

  const maxNodes = Math.max(1, triCount * 2);
  const bounds = new Float32Array(maxNodes * 6);
  const leftOrStart = new Int32Array(maxNodes);
  const countOrRight = new Int32Array(maxNodes);
  let nodeCount = 0;

  const build = (start: number, end: number, depth: number): number => {
    const node = nodeCount++;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;

    for (let i = start; i < end; i++) {
      const t = triOrder[i];
      if (triMinX[t] < minX) minX = triMinX[t];
      if (triMinY[t] < minY) minY = triMinY[t];
      if (triMinZ[t] < minZ) minZ = triMinZ[t];
      if (triMaxX[t] > maxX) maxX = triMaxX[t];
      if (triMaxY[t] > maxY) maxY = triMaxY[t];
      if (triMaxZ[t] > maxZ) maxZ = triMaxZ[t];
      const cx = triCx[t], cy = triCy[t], cz = triCz[t];
      if (cx < cMinX) cMinX = cx;
      if (cx > cMaxX) cMaxX = cx;
      if (cy < cMinY) cMinY = cy;
      if (cy > cMaxY) cMaxY = cy;
      if (cz < cMinZ) cMinZ = cz;
      if (cz > cMaxZ) cMaxZ = cz;
    }

    const b = node * 6;
    bounds[b] = minX; bounds[b + 1] = minY; bounds[b + 2] = minZ;
    bounds[b + 3] = maxX; bounds[b + 4] = maxY; bounds[b + 5] = maxZ;

    const count = end - start;
    if (count <= LEAF_SIZE || depth >= MAX_DEPTH) {
      leftOrStart[node] = start;
      countOrRight[node] = count;
      return node;
    }

    const dx = cMaxX - cMinX;
    const dy = cMaxY - cMinY;
    const dz = cMaxZ - cMinZ;
    const centroids = dx >= dy && dx >= dz ? triCx : dy >= dz ? triCy : triCz;
    const split = dx >= dy && dx >= dz
      ? (cMinX + cMaxX) * 0.5
      : dy >= dz
        ? (cMinY + cMaxY) * 0.5
        : (cMinZ + cMaxZ) * 0.5;

    let i = start;
    let j = end - 1;
    while (i <= j) {
      while (i <= j && centroids[triOrder[i]] < split) i++;
      while (i <= j && centroids[triOrder[j]] >= split) j--;
      if (i < j) {
        const tmp = triOrder[i];
        triOrder[i] = triOrder[j];
        triOrder[j] = tmp;
        i++;
        j--;
      }
    }

    let mid = i;
    if (mid <= start || mid >= end) {
      mid = (start + end) >> 1;
    }

    const left = build(start, mid, depth + 1);
    const right = build(mid, end, depth + 1);
    leftOrStart[node] = left;
    countOrRight[node] = -right;
    return node;
  };

  if (triCount > 0) build(0, triCount, 0);

  return {
    bounds: bounds.subarray(0, nodeCount * 6),
    leftOrStart: leftOrStart.subarray(0, nodeCount),
    countOrRight: countOrRight.subarray(0, nodeCount),
    triOrder,
    nodeCount,
  };
}

export function queryFlatBvhRay(
  bvh: FlatBvh,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  outTriangles: number[],
): void {
  if (bvh.nodeCount === 0) return;
  const invX = 1 / dx;
  const invY = 1 / dy;
  const invZ = 1 / dz;
  const { bounds, leftOrStart, countOrRight, triOrder } = bvh;
  const stack: number[] = [0];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const b = node * 6;
    const tx1 = (bounds[b] - ox) * invX;
    const tx2 = (bounds[b + 3] - ox) * invX;
    let tmin = tx1 < tx2 ? tx1 : tx2;
    let tmax = tx1 > tx2 ? tx1 : tx2;

    const ty1 = (bounds[b + 1] - oy) * invY;
    const ty2 = (bounds[b + 4] - oy) * invY;
    const tyMin = ty1 < ty2 ? ty1 : ty2;
    const tyMax = ty1 > ty2 ? ty1 : ty2;
    if (tmin > tyMax || tyMin > tmax) continue;
    if (tyMin > tmin) tmin = tyMin;
    if (tyMax < tmax) tmax = tyMax;

    const tz1 = (bounds[b + 2] - oz) * invZ;
    const tz2 = (bounds[b + 5] - oz) * invZ;
    const tzMin = tz1 < tz2 ? tz1 : tz2;
    const tzMax = tz1 > tz2 ? tz1 : tz2;
    if (tmin > tzMax || tzMin > tmax) continue;
    if (tzMax < tmax) tmax = tzMax;
    if (tmax < 0) continue;

    const cr = countOrRight[node];
    if (cr > 0) {
      const start = leftOrStart[node];
      const end = start + cr;
      for (let i = start; i < end; i++) outTriangles.push(triOrder[i]);
    } else {
      stack.push(-cr, leftOrStart[node]);
    }
  }
}

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _worldPoint = new THREE.Vector3();
const _candidateTris: number[] = [];

let installed = false;

export function installMeshBvh(): void {
  if (installed) return;
  installed = true;

  const proto = THREE.Mesh.prototype as unknown as {
    raycast: (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => void;
    _computeIntersections: (raycaster: THREE.Raycaster, intersects: THREE.Intersection[], rayLocalSpace: THREE.Ray) => void;
  };

  const origRaycast = proto.raycast;
  const origCompute = proto._computeIntersections;

  proto.raycast = function (this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
    if (this.geometry && this.geometry.boundingBox === null) {
      this.geometry.computeBoundingBox();
    }
    origRaycast.call(this, raycaster, intersects);
  };

  proto._computeIntersections = function (
    this: THREE.Mesh,
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[],
    rayLocalSpace: THREE.Ray,
  ) {
    const geometry = this.geometry;
    const material = this.material;
    const index = geometry.index;
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined;

    if (
      !index ||
      !position ||
      Array.isArray(material) ||
      this.morphTargetInfluences ||
      geometry.drawRange.start !== 0 ||
      geometry.drawRange.count !== Infinity ||
      index.count < MIN_BVH_TRIANGLES * 3
    ) {
      origCompute.call(this, raycaster, intersects, rayLocalSpace);
      return;
    }

    const posVersion = position.version;
    const idxVersion = index.version;
    let entry = bvhCache.get(geometry);
    if (!entry) {
      entry = {
        posVersion,
        idxVersion,
        seenAtVersion: 2,
        bvh: buildFlatBvh(position.array as ArrayLike<number>, index.array as ArrayLike<number>),
      };
      bvhCache.set(geometry, entry);
    } else if (entry.posVersion !== posVersion || entry.idxVersion !== idxVersion) {
      entry.posVersion = posVersion;
      entry.idxVersion = idxVersion;
      entry.seenAtVersion = 1;
      entry.bvh = null;
    } else if (!entry.bvh) {
      entry.seenAtVersion++;
      if (entry.seenAtVersion >= 2) {
        entry.bvh = buildFlatBvh(position.array as ArrayLike<number>, index.array as ArrayLike<number>);
      }
    }

    if (!entry.bvh) {
      origCompute.call(this, raycaster, intersects, rayLocalSpace);
      return;
    }

    _candidateTris.length = 0;
    const orig = rayLocalSpace.origin;
    const dir = rayLocalSpace.direction;
    queryFlatBvhRay(entry.bvh, orig.x, orig.y, orig.z, dir.x, dir.y, dir.z, _candidateTris);
    if (_candidateTris.length === 0) return;

    const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    const uv1 = geometry.attributes.uv1 as THREE.BufferAttribute | undefined;
    const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const side = material.side;
    const backSide = side === THREE.BackSide;
    const backfaceCulling = side === THREE.FrontSide;

    for (let k = 0; k < _candidateTris.length; k++) {
      const f = _candidateTris[k];
      const i = f * 3;
      const a = index.getX(i);
      const b = index.getX(i + 1);
      const c = index.getX(i + 2);

      this.getVertexPosition(a, _vA);
      this.getVertexPosition(b, _vB);
      this.getVertexPosition(c, _vC);

      const hit = backSide
        ? rayLocalSpace.intersectTriangle(_vC, _vB, _vA, true, _hitPoint)
        : rayLocalSpace.intersectTriangle(_vA, _vB, _vC, backfaceCulling, _hitPoint);
      if (hit === null) continue;

      _worldPoint.copy(_hitPoint).applyMatrix4(this.matrixWorld);
      const distance = raycaster.ray.origin.distanceTo(_worldPoint);
      if (distance < raycaster.near || distance > raycaster.far) continue;

      const barycoord = new THREE.Vector3();
      THREE.Triangle.getBarycoord(_hitPoint, _vA, _vB, _vC, barycoord);

      const faceNormal = new THREE.Vector3();
      THREE.Triangle.getNormal(_vA, _vB, _vC, faceNormal);

      const intersection: THREE.Intersection = {
        distance,
        point: _worldPoint.clone(),
        object: this,
        faceIndex: f,
        face: { a, b, c, normal: faceNormal, materialIndex: 0 },
        barycoord,
      };

      if (uv) {
        intersection.uv = THREE.Triangle.getInterpolatedAttribute(uv, a, b, c, barycoord, new THREE.Vector2());
      }
      if (uv1) {
        intersection.uv1 = THREE.Triangle.getInterpolatedAttribute(uv1, a, b, c, barycoord, new THREE.Vector2());
      }
      if (normal) {
        const interpNormal = THREE.Triangle.getInterpolatedAttribute(normal, a, b, c, barycoord, new THREE.Vector3());
        if (interpNormal.dot(rayLocalSpace.direction) > 0) interpNormal.multiplyScalar(-1);
        intersection.normal = interpNormal;
      }

      intersects.push(intersection);
    }
  };
}

