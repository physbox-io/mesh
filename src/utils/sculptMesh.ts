// ---------------------------------------------------------------------------
// Free-form sculpting
// ---------------------------------------------------------------------------
//
// Everything else in this app that makes a shape makes it from parameters: a
// primitive with a size, a boolean of primitives, a heightmap driven by an
// image. Those all share a limitation that has nothing to do with how they are
// implemented — the shape you get is the shape someone could describe. This
// file is the other kind of modelling, where the shape is whatever you pushed
// it into.
//
// The mesh is a plain indexed triangle soup with a bit of bookkeeping around
// it, and three things make it a sculpting mesh rather than a static one:
//
//   * dynamic topology. A brush that only moves existing vertices can never add
//     detail: sculpt a nose out of a coarse sphere and you get a coarse nose.
//     So the brush refines the triangles it touches down to a target edge length
//     and collapses the ones that have bunched up, and detail follows the tool
//     instead of being decided up front by a subdivision level.
//
//   * a spatial hash. Every brush step asks "which vertices are within r of this
//     point", and answering that by scanning 200 k vertices at 60 Hz is the
//     whole performance budget spent on the question rather than the answer.
//
//   * stroke-granular undo that stores what changed rather than the whole mesh.
//     A stroke that moves 300 vertices should cost 300 vertices of history, not
//     a megabyte, or the undo stack has to be kept short enough to be useless.
//
// Coordinates are Z-up metres — `SceneGeom.renderVertices` convention, matching
// utils/stlParser.ts. `toSceneGeom` emits the Y-up copy the renderer wants
// alongside it, so nothing downstream has to know a mesh was sculpted.
// ---------------------------------------------------------------------------

export type BrushType =
  | 'draw'
  | 'inflate'
  | 'smooth'
  | 'flatten'
  | 'pinch'
  | 'grab';

export interface SculptMesh {
  /** xyz per vertex, Z-up metres. Length is capacity; `vertexCount` is truth. */
  positions: Float32Array;
  vertexCount: number;
  /** Three indices per face. Length is capacity; `faceCount` is truth. */
  faces: Uint32Array;
  faceCount: number;
  /** Per-vertex normals, valid after `recomputeNormals`. */
  normals: Float32Array;
  /**
   * Bumped whenever the topology changes, so caches (adjacency, the spatial
   * hash, the render buffer) can tell "the same mesh, moved" from "a different
   * mesh" without comparing anything.
   */
  topologyRevision: number;
  /** Bumped on any change at all, including a pure move. */
  revision: number;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function grow(array: Float32Array, needed: number): Float32Array {
  if (array.length >= needed) return array;
  let size = Math.max(16, array.length);
  while (size < needed) size *= 2;
  const next = new Float32Array(size);
  next.set(array);
  return next;
}

function growU32(array: Uint32Array, needed: number): Uint32Array {
  if (array.length >= needed) return array;
  let size = Math.max(16, array.length);
  while (size < needed) size *= 2;
  const next = new Uint32Array(size);
  next.set(array);
  return next;
}

export function createSculptMesh(positions: ArrayLike<number>, faces: ArrayLike<number>): SculptMesh {
  const mesh: SculptMesh = {
    positions: Float32Array.from(positions),
    vertexCount: Math.floor(positions.length / 3),
    faces: Uint32Array.from(faces),
    faceCount: Math.floor(faces.length / 3),
    normals: new Float32Array(positions.length),
    topologyRevision: 0,
    revision: 0,
  };
  recomputeNormals(mesh);
  return mesh;
}

/** A deep copy, for snapshots and for handing a mesh across a boundary. */
export function cloneSculptMesh(mesh: SculptMesh): SculptMesh {
  return {
    positions: mesh.positions.slice(),
    vertexCount: mesh.vertexCount,
    faces: mesh.faces.slice(),
    faceCount: mesh.faceCount,
    normals: mesh.normals.slice(),
    topologyRevision: mesh.topologyRevision,
    revision: mesh.revision,
  };
}

function addVertex(mesh: SculptMesh, x: number, y: number, z: number): number {
  const i = mesh.vertexCount;
  mesh.positions = grow(mesh.positions, (i + 1) * 3);
  mesh.normals = grow(mesh.normals, (i + 1) * 3);
  mesh.positions[i * 3] = x;
  mesh.positions[i * 3 + 1] = y;
  mesh.positions[i * 3 + 2] = z;
  mesh.vertexCount = i + 1;
  return i;
}

/**
 * A subdivided icosahedron.
 *
 * The starting shape for a sculpt wants triangles of one size all over it, and
 * the icosahedron is the only platonic solid that gives you that on a sphere —
 * subdividing a UV sphere instead crowds the poles, and the crowding shows up
 * the moment a brush crosses one.
 */
export function icosphere(radius: number, subdivisions: number): SculptMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let tris: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const midpoints = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const seen = midpoints.get(key);
      if (seen !== undefined) return seen;
      const va = verts[a];
      const vb = verts[b];
      verts.push([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]);
      const index = verts.length - 1;
      midpoints.set(key, index);
      return index;
    };

    const next: number[][] = [];
    for (const [a, b, c] of tris) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }

  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i];
    const len = Math.hypot(x, y, z) || 1;
    positions[i * 3] = (x / len) * radius;
    positions[i * 3 + 1] = (y / len) * radius;
    positions[i * 3 + 2] = (z / len) * radius;
  }

  return createSculptMesh(positions, tris.flat());
}

// ---------------------------------------------------------------------------
// Normals
// ---------------------------------------------------------------------------

/**
 * Area-weighted vertex normals.
 *
 * The cross product of two triangle edges is already twice the triangle's area
 * in length, so accumulating it unnormalised weights each face by its own area
 * for free — which is what stops a fan of slivers, the thing dynamic topology
 * creates most of, from outvoting the large triangle they sit against.
 */
export function recomputeNormals(mesh: SculptMesh): void {
  const { positions, faces, faceCount, vertexCount } = mesh;
  mesh.normals = grow(mesh.normals, vertexCount * 3);
  const normals = mesh.normals;
  normals.fill(0, 0, vertexCount * 3);

  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3] * 3;
    const b = faces[f * 3 + 1] * 3;
    const c = faces[f * 3 + 2] * 3;

    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }

  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const len = Math.hypot(normals[o], normals[o + 1], normals[o + 2]);
    if (len > 1e-12) {
      normals[o] /= len;
      normals[o + 1] /= len;
      normals[o + 2] /= len;
    }
  }
}

// ---------------------------------------------------------------------------
// Adjacency
// ---------------------------------------------------------------------------

/** Neighbours per vertex, in the compressed form (offsets + flat list). */
export interface Adjacency {
  offsets: Uint32Array;
  neighbours: Uint32Array;
  topologyRevision: number;
}

/**
 * Builds the vertex-to-vertex neighbour lists the smooth brush reads.
 *
 * Compressed rather than an array of arrays: a 200 k-vertex mesh is 200 k
 * JavaScript arrays otherwise, each with its own header and its own place in
 * the heap, and building that every time the topology changes costs more than
 * the smoothing it exists to serve.
 */
export function buildAdjacency(mesh: SculptMesh): Adjacency {
  const { faces, faceCount, vertexCount } = mesh;
  const counts = new Uint32Array(vertexCount + 1);

  // A neighbour reached from two different faces is counted twice here; the
  // duplicate is squeezed out below rather than paying for a Set per vertex.
  for (let f = 0; f < faceCount; f++) {
    counts[faces[f * 3]] += 2;
    counts[faces[f * 3 + 1]] += 2;
    counts[faces[f * 3 + 2]] += 2;
  }

  const offsets = new Uint32Array(vertexCount + 1);
  let total = 0;
  for (let i = 0; i < vertexCount; i++) {
    offsets[i] = total;
    total += counts[i];
  }
  offsets[vertexCount] = total;

  const scratch = new Uint32Array(total);
  const fill = offsets.slice();
  const push = (v: number, n: number) => { scratch[fill[v]++] = n; };

  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3];
    const b = faces[f * 3 + 1];
    const c = faces[f * 3 + 2];
    push(a, b); push(a, c);
    push(b, a); push(b, c);
    push(c, a); push(c, b);
  }

  // Sort each vertex's slice and drop the repeats, compacting as we go.
  const neighbours = new Uint32Array(total);
  const finalOffsets = new Uint32Array(vertexCount + 1);
  let write = 0;
  for (let i = 0; i < vertexCount; i++) {
    finalOffsets[i] = write;
    const from = offsets[i];
    const to = offsets[i + 1];
    if (to > from) {
      const slice = scratch.subarray(from, to);
      slice.sort();
      let prev = -1;
      for (let k = 0; k < slice.length; k++) {
        if (slice[k] !== prev) {
          neighbours[write++] = slice[k];
          prev = slice[k];
        }
      }
    }
  }
  finalOffsets[vertexCount] = write;

  return {
    offsets: finalOffsets,
    neighbours: neighbours.subarray(0, write),
    topologyRevision: mesh.topologyRevision,
  };
}

// ---------------------------------------------------------------------------
// Spatial hash
// ---------------------------------------------------------------------------

export interface SpatialHash {
  cellSize: number;
  /** Cell key -> vertex indices in that cell. */
  cells: Map<number, number[]>;
  topologyRevision: number;
  revision: number;
}

const HASH_SPAN = 1024;

function cellKey(ix: number, iy: number, iz: number): number {
  // Three signed cell indices folded into one number. The span is large enough
  // for any sculpt at a sane cell size and small enough to stay well inside the
  // exact-integer range, so distinct cells never collide.
  return ((ix + HASH_SPAN) * (HASH_SPAN * 2) + (iy + HASH_SPAN)) * (HASH_SPAN * 2) + (iz + HASH_SPAN);
}

export function buildSpatialHash(mesh: SculptMesh, cellSize: number): SpatialHash {
  const size = Math.max(1e-6, cellSize);
  const cells = new Map<number, number[]>();
  const { positions, vertexCount } = mesh;

  for (let i = 0; i < vertexCount; i++) {
    const key = cellKey(
      Math.floor(positions[i * 3] / size),
      Math.floor(positions[i * 3 + 1] / size),
      Math.floor(positions[i * 3 + 2] / size)
    );
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  }

  return { cellSize: size, cells, topologyRevision: mesh.topologyRevision, revision: mesh.revision };
}

/**
 * Vertices within `radius` of a point.
 *
 * The hash is built once per stroke and vertices move while it is in use, so
 * this is a query over where they *were*. The cells searched are padded by one
 * in every direction to cover that drift, and the exact distance test at the
 * end means a stale bucket costs a few wasted comparisons and never a wrong
 * answer.
 */
export function queryRadius(
  mesh: SculptMesh,
  hash: SpatialHash,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: number[] = []
): number[] {
  out.length = 0;
  const { cellSize, cells } = hash;
  const reach = radius + cellSize;
  const minX = Math.floor((x - reach) / cellSize);
  const maxX = Math.floor((x + reach) / cellSize);
  const minY = Math.floor((y - reach) / cellSize);
  const maxY = Math.floor((y + reach) / cellSize);
  const minZ = Math.floor((z - reach) / cellSize);
  const maxZ = Math.floor((z + reach) / cellSize);
  const r2 = radius * radius;
  const { positions, vertexCount } = mesh;

  for (let ix = minX; ix <= maxX; ix++) {
    for (let iy = minY; iy <= maxY; iy++) {
      for (let iz = minZ; iz <= maxZ; iz++) {
        const bucket = cells.get(cellKey(ix, iy, iz));
        if (!bucket) continue;
        for (const i of bucket) {
          if (i >= vertexCount) continue; // a vertex the last decimation removed
          const dx = positions[i * 3] - x;
          const dy = positions[i * 3 + 1] - y;
          const dz = positions[i * 3 + 2] - z;
          if (dx * dx + dy * dy + dz * dz <= r2) out.push(i);
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Dynamic topology
// ---------------------------------------------------------------------------

function edgeKey(a: number, b: number): number {
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

/**
 * Splits every edge longer than `maxEdge` inside the brush, in one pass.
 *
 * Splitting edges one at a time means rebuilding the edge-to-face map after
 * each one, which is linear in the mesh for a change that touches three
 * triangles. Instead every edge to split is chosen first, its midpoint made,
 * and then the face list is rewritten once: each face emits 1, 2, 3 or 4
 * triangles depending on how many of its own edges were split. Because a split
 * edge is shared through the map, both faces on it agree about the midpoint and
 * the result stays conforming — no T-junctions, no cracks.
 *
 * Returns how many edges were split.
 */
export function refineInRadius(
  mesh: SculptMesh,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  maxEdge: number
): number {
  const { faces, faceCount, positions } = mesh;
  const limit2 = maxEdge * maxEdge;
  const reach = radius + maxEdge;
  const reach2 = reach * reach;

  const midpoints = new Map<number, number>();
  const nearBrush = (v: number): boolean => {
    const dx = positions[v * 3] - cx;
    const dy = positions[v * 3 + 1] - cy;
    const dz = positions[v * 3 + 2] - cz;
    return dx * dx + dy * dy + dz * dz <= reach2;
  };
  const edgeLen2 = (a: number, b: number): number => {
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  // Pass one: pick the edges, and make each midpoint exactly once.
  for (let f = 0; f < faceCount; f++) {
    const v = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
    if (!nearBrush(v[0]) && !nearBrush(v[1]) && !nearBrush(v[2])) continue;

    for (let e = 0; e < 3; e++) {
      const a = v[e];
      const b = v[(e + 1) % 3];
      if (edgeLen2(a, b) <= limit2) continue;
      const key = edgeKey(a, b);
      if (midpoints.has(key)) continue;
      midpoints.set(
        key,
        addVertex(
          mesh,
          (mesh.positions[a * 3] + mesh.positions[b * 3]) / 2,
          (mesh.positions[a * 3 + 1] + mesh.positions[b * 3 + 1]) / 2,
          (mesh.positions[a * 3 + 2] + mesh.positions[b * 3 + 2]) / 2
        )
      );
    }
  }

  if (midpoints.size === 0) return 0;

  // Pass two: rewrite the faces around the midpoints that now exist.
  const out: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3];
    const b = faces[f * 3 + 1];
    const c = faces[f * 3 + 2];
    const ab = midpoints.get(edgeKey(a, b));
    const bc = midpoints.get(edgeKey(b, c));
    const ca = midpoints.get(edgeKey(c, a));
    const count = (ab !== undefined ? 1 : 0) + (bc !== undefined ? 1 : 0) + (ca !== undefined ? 1 : 0);

    if (count === 0) {
      out.push(a, b, c);
    } else if (count === 3) {
      out.push(a, ab!, ca!, b, bc!, ab!, c, ca!, bc!, ab!, bc!, ca!);
    } else if (count === 1) {
      // One split: the opposite corner is joined to the new midpoint.
      if (ab !== undefined) out.push(a, ab, c, ab, b, c);
      else if (bc !== undefined) out.push(b, bc, a, bc, c, a);
      else out.push(c, ca!, b, ca!, a, b);
    } else {
      // Two splits: rotate so the unsplit edge is c->a, then fan the quad. The
      // diagonal is chosen as the shorter of the two, which keeps the pair of
      // triangles as close to equilateral as the quad allows.
      let p0 = a, p1 = b, p2 = c, m01 = ab, m12 = bc;
      if (ca === undefined) {
        // already oriented
      } else if (ab === undefined) {
        p0 = b; p1 = c; p2 = a; m01 = bc; m12 = ca;
      } else {
        p0 = c; p1 = a; p2 = b; m01 = ca; m12 = ab;
      }
      out.push(p1, m12!, m01!);
      if (edgeLen2(m01!, p2) <= edgeLen2(m12!, p0)) out.push(p0, m01!, p2, m01!, m12!, p2);
      else out.push(p0, m12!, p2, p0, m01!, m12!);
    }
  }

  mesh.faces = growU32(mesh.faces, out.length);
  mesh.faces.set(out);
  mesh.faceCount = out.length / 3;
  mesh.topologyRevision++;
  mesh.revision++;
  return midpoints.size;
}

/**
 * Collapses edges shorter than `minEdge` inside the brush.
 *
 * Without this a sculpt only ever grows: smoothing and deflating pull vertices
 * together, and every one of them stays, so the triangle count climbs while the
 * detail it is spending itself on falls. Collapse is the half of dynamic
 * topology that keeps the density matched to the shape rather than to the
 * history of how it got there.
 *
 * A collapse is refused unless the two endpoints share exactly the vertices
 * opposite the edge — the "link condition". Collapsing across a pair that share
 * anything else pinches the surface into a non-manifold seam, and a mesh with
 * one of those in it will not slice, will not print, and will not compile to a
 * collision shape.
 */
export function decimateInRadius(
  mesh: SculptMesh,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  minEdge: number,
  /**
   * A neighbour list already built for this topology. Building one is linear in
   * the mesh, so a stroke that rebuilt it per dab would spend more time deciding
   * what to collapse than sculpting. Omit it and one is built here.
   */
  prebuilt?: Adjacency
): number {
  const adjacency =
    prebuilt && prebuilt.topologyRevision === mesh.topologyRevision ? prebuilt : buildAdjacency(mesh);
  const { offsets, neighbours } = adjacency;
  const { positions } = mesh;
  const limit2 = minEdge * minEdge;
  const reach = radius + minEdge;
  const reach2 = reach * reach;

  const neighboursOf = (v: number) => neighbours.subarray(offsets[v], offsets[v + 1]);
  const shares = (v: number, target: number) => {
    const list = neighboursOf(v);
    for (let i = 0; i < list.length; i++) if (list[i] === target) return true;
    return false;
  };

  // A vertex may take part in one collapse per pass: chaining them inside a
  // single pass invalidates the adjacency this is reading from.
  const touched = new Uint8Array(mesh.vertexCount);
  const remap = new Int32Array(mesh.vertexCount);
  for (let i = 0; i < remap.length; i++) remap[i] = i;
  let collapses = 0;

  for (let v = 0; v < mesh.vertexCount; v++) {
    if (touched[v]) continue;
    const dx = positions[v * 3] - cx;
    const dy = positions[v * 3 + 1] - cy;
    const dz = positions[v * 3 + 2] - cz;
    if (dx * dx + dy * dy + dz * dz > reach2) continue;

    const list = neighboursOf(v);
    for (let k = 0; k < list.length; k++) {
      const w = list[k];
      if (w <= v || touched[w]) continue;

      const ex = positions[w * 3] - positions[v * 3];
      const ey = positions[w * 3 + 1] - positions[v * 3 + 1];
      const ez = positions[w * 3 + 2] - positions[v * 3 + 2];
      if (ex * ex + ey * ey + ez * ez > limit2) continue;

      // Link condition: the shared neighbours must be exactly the two vertices
      // opposite the edge, and no more.
      const wList = neighboursOf(w);
      let shared = 0;
      let ok = true;
      for (let j = 0; j < wList.length; j++) {
        if (shares(v, wList[j])) {
          shared++;
          if (shared > 2) { ok = false; break; }
          if (touched[wList[j]]) { ok = false; break; }
        }
      }
      if (!ok || shared !== 2) continue;

      // Both endpoints move to the midpoint, which keeps the surface where it
      // was instead of snapping it onto one of the two.
      positions[v * 3] = (positions[v * 3] + positions[w * 3]) / 2;
      positions[v * 3 + 1] = (positions[v * 3 + 1] + positions[w * 3 + 1]) / 2;
      positions[v * 3 + 2] = (positions[v * 3 + 2] + positions[w * 3 + 2]) / 2;

      remap[w] = v;
      touched[v] = 1;
      touched[w] = 1;
      for (let j = 0; j < wList.length; j++) touched[wList[j]] = 1;
      collapses++;
      break;
    }
  }

  if (collapses === 0) return 0;

  // Rewrite the faces through the remap, dropping the ones that collapsed to a
  // line, then compact the vertices that no face refers to any more.
  const faces = mesh.faces;
  const kept: number[] = [];
  for (let f = 0; f < mesh.faceCount; f++) {
    const a = remap[faces[f * 3]];
    const b = remap[faces[f * 3 + 1]];
    const c = remap[faces[f * 3 + 2]];
    if (a === b || b === c || c === a) continue;
    kept.push(a, b, c);
  }

  const used = new Int32Array(mesh.vertexCount).fill(-1);
  for (const index of kept) used[index] = 0;
  let write = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    if (used[i] !== 0) continue;
    used[i] = write;
    mesh.positions[write * 3] = mesh.positions[i * 3];
    mesh.positions[write * 3 + 1] = mesh.positions[i * 3 + 1];
    mesh.positions[write * 3 + 2] = mesh.positions[i * 3 + 2];
    write++;
  }
  for (let i = 0; i < kept.length; i++) kept[i] = used[kept[i]];

  mesh.vertexCount = write;
  mesh.faces = growU32(mesh.faces, kept.length);
  mesh.faces.set(kept);
  mesh.faceCount = kept.length / 3;
  mesh.topologyRevision++;
  mesh.revision++;
  return collapses;
}

// ---------------------------------------------------------------------------
// Brushes
// ---------------------------------------------------------------------------

export interface BrushSettings {
  type: BrushType;
  /** Brush radius in metres. */
  radius: number;
  /** 0..1. Scaled by the radius inside, so a brush behaves the same at any size. */
  strength: number;
  /** Pull in rather than push out — Ctrl, in every sculpting tool ever made. */
  invert: boolean;
  /** Mirror every stroke across the body's own X = 0 plane. */
  symmetryX: boolean;
  /**
   * Refine and collapse as the brush passes. Off, the brush only moves the
   * vertices that are already there, which is faster and is what you want when
   * the shape is settled and you are only smoothing it.
   */
  dynamicTopology: boolean;
  /** Target edge length as a fraction of the brush radius. */
  detail: number;
  /**
   * A ceiling on how many vertices dynamic topology may create.
   *
   * Refinement is exponential in the detail setting and quadratic in the brush
   * area, so a large brush at a fine detail on a big model will fill memory in
   * a few seconds of dragging if nothing stops it. Past this the brush keeps
   * working and simply stops adding — a sculpt that gets coarser is a far better
   * failure than a tab that stops responding.
   */
  maxVertices: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  type: 'draw',
  radius: 0.04,
  strength: 0.5,
  invert: false,
  symmetryX: false,
  dynamicTopology: true,
  detail: 0.25,
  maxVertices: 250_000,
};

export interface BrushStamp {
  /** Where the brush is, on the surface, in mesh space. */
  x: number;
  y: number;
  z: number;
  /** Surface normal under the brush. Direction for 'draw' and 'flatten'. */
  nx: number;
  ny: number;
  nz: number;
  /** How far the cursor moved since the last stamp. 'grab' is the only user. */
  dx?: number;
  dy?: number;
  dz?: number;
}

/**
 * Smoothstep falloff, from full strength at the centre to nothing at the rim.
 *
 * A linear falloff leaves a visible crease at the edge of the brush, because
 * the *slope* of the displacement jumps there even though the displacement
 * itself does not. Smoothstep has zero derivative at both ends, so consecutive
 * stamps blend into a surface instead of a set of overlapping dents.
 */
function falloff(t: number): number {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const s = 1 - t;
  return s * s * (3 - 2 * s);
}

/** Everything a stroke needs to keep between stamps. */
export interface SculptSession {
  mesh: SculptMesh;
  hash: SpatialHash;
  adjacency: Adjacency;
  /** Vertex index -> its position when the stroke began. */
  undoIndices: number[];
  undoPositions: number[];
  undoSeen: Set<number>;
  /** Set once the stroke adds or removes anything, which delta undo cannot express. */
  topologyChanged: boolean;
  /**
   * The mesh as it was when the stroke began.
   *
   * Only taken for a brush that *can* change the topology, because it is a full
   * copy of every vertex and face — several megabytes on a dense sculpt, on
   * every pointer-down. A brush that only moves vertices is undone from the
   * delta below and never needs it.
   */
  before: SculptMesh | null;
  /** For 'grab': the vertices caught at the start, held for the whole drag. */
  grabbed: number[] | null;
  grabWeights: Float32Array | null;
  /** Dabs so far, so decimation can run on every few rather than every one. */
  stampCount: number;
  /** Set once refinement has been turned away by the vertex budget. */
  hitVertexBudget: boolean;
}

/** How many dabs pass between collapse passes. */
const DECIMATE_EVERY = 4;

export function beginStroke(mesh: SculptMesh, settings: BrushSettings): SculptSession {
  // Grab never refines: it drags the vertices it already caught, so its stroke
  // is pure movement whatever the detail setting says.
  const canChangeTopology = settings.dynamicTopology && settings.type !== 'grab';
  return {
    mesh,
    hash: buildSpatialHash(mesh, Math.max(settings.radius * 0.5, 1e-4)),
    adjacency: buildAdjacency(mesh),
    undoIndices: [],
    undoPositions: [],
    undoSeen: new Set(),
    topologyChanged: false,
    before: canChangeTopology ? cloneSculptMesh(mesh) : null,
    grabbed: null,
    grabWeights: null,
    stampCount: 0,
    hitVertexBudget: false,
  };
}

function recordUndo(session: SculptSession, indices: number[]): void {
  const { positions } = session.mesh;
  for (const i of indices) {
    if (session.undoSeen.has(i)) continue;
    session.undoSeen.add(i);
    session.undoIndices.push(i);
    session.undoPositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  }
}

/**
 * One dab of the brush.
 *
 * A stroke is many of these, one per pointer move, interpolated by the caller
 * so that a fast drag does not leave a dotted line. Everything here is
 * deliberately incremental: the displacement per stamp is small, and the shape
 * comes from stacking them, which is why the brushes have no notion of how long
 * a stroke has been going on.
 */
export function applyBrush(session: SculptSession, settings: BrushSettings, stamp: BrushStamp): void {
  stampOnce(session, settings, stamp);

  if (settings.symmetryX) {
    stampOnce(session, settings, {
      x: -stamp.x,
      y: stamp.y,
      z: stamp.z,
      nx: -stamp.nx,
      ny: stamp.ny,
      nz: stamp.nz,
      dx: stamp.dx === undefined ? undefined : -stamp.dx,
      dy: stamp.dy,
      dz: stamp.dz,
    });
  }
}

function stampOnce(session: SculptSession, settings: BrushSettings, stamp: BrushStamp): void {
  const { mesh } = session;
  const radius = Math.max(1e-5, settings.radius);

  if (settings.dynamicTopology && settings.type !== 'grab') {
    const target = Math.max(1e-5, radius * Math.max(0.05, settings.detail));
    const budget = settings.maxVertices ?? DEFAULT_BRUSH.maxVertices;
    const split =
      mesh.vertexCount >= budget
        ? 0
        : refineInRadius(mesh, stamp.x, stamp.y, stamp.z, radius, target * 1.5);
    if (mesh.vertexCount >= budget) session.hitVertexBudget = true;

    // Collapsing is a tidy-up, not a correctness step, and it costs a pass over
    // the whole mesh. Every few dabs keeps the density in check without paying
    // for it on each one.
    session.stampCount++;
    const merged =
      session.stampCount % DECIMATE_EVERY === 0
        ? decimateInRadius(mesh, stamp.x, stamp.y, stamp.z, radius, target * 0.4, session.adjacency)
        : 0;

    if (split > 0 || merged > 0) {
      session.topologyChanged = true;
      // Both invalidate the caches, and the hash is what the query below reads.
      session.hash = buildSpatialHash(mesh, Math.max(radius * 0.5, 1e-4));
      session.adjacency = buildAdjacency(mesh);
      recomputeNormals(mesh);
    }
  }

  // 'grab' holds the vertices it caught at the start of the drag, so the lump
  // travels with the cursor instead of the brush picking up whatever it happens
  // to be over — which is what makes it feel like pulling clay rather than
  // sanding it.
  let indices: number[];
  let weights: Float32Array;

  if (settings.type === 'grab' && session.grabbed && session.grabWeights) {
    indices = session.grabbed;
    weights = session.grabWeights;
  } else {
    indices = queryRadius(mesh, session.hash, stamp.x, stamp.y, stamp.z, radius);
    weights = new Float32Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const dx = mesh.positions[i * 3] - stamp.x;
      const dy = mesh.positions[i * 3 + 1] - stamp.y;
      const dz = mesh.positions[i * 3 + 2] - stamp.z;
      weights[k] = falloff(Math.hypot(dx, dy, dz) / radius);
    }
    if (settings.type === 'grab') {
      session.grabbed = indices;
      session.grabWeights = weights;
    }
  }

  if (indices.length === 0) return;
  recordUndo(session, indices);

  const sign = settings.invert ? -1 : 1;
  const strength = Math.max(0, Math.min(1, settings.strength));
  // Displacement scales with the brush, so a small brush cannot punch a hole
  // through a shape that a large one only dents.
  const amplitude = radius * 0.18 * strength * sign;
  const positions = mesh.positions;
  const normals = mesh.normals;

  switch (settings.type) {
    case 'draw': {
      // Along the surface normal under the cursor, not each vertex's own: a
      // single direction for the whole dab is what makes a ridge rather than a
      // blister that follows every wobble already in the surface.
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const w = weights[k] * amplitude;
        positions[i * 3] += stamp.nx * w;
        positions[i * 3 + 1] += stamp.ny * w;
        positions[i * 3 + 2] += stamp.nz * w;
      }
      break;
    }

    case 'inflate': {
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const w = weights[k] * amplitude;
        positions[i * 3] += normals[i * 3] * w;
        positions[i * 3 + 1] += normals[i * 3 + 1] * w;
        positions[i * 3 + 2] += normals[i * 3 + 2] * w;
      }
      break;
    }

    case 'smooth': {
      // Towards the average of the neighbours. Read from a copy, because
      // smoothing in place would let a vertex already moved this pass drag its
      // neighbours further than the strength allows.
      const { offsets, neighbours } = session.adjacency;
      const source = positions.slice(0, mesh.vertexCount * 3);
      const rate = weights.length > 0 ? strength : 0;
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const from = offsets[i];
        const to = offsets[i + 1];
        if (to <= from) continue;
        let ax = 0, ay = 0, az = 0;
        for (let j = from; j < to; j++) {
          const n = neighbours[j];
          ax += source[n * 3];
          ay += source[n * 3 + 1];
          az += source[n * 3 + 2];
        }
        const count = to - from;
        const w = weights[k] * rate;
        positions[i * 3] += (ax / count - source[i * 3]) * w;
        positions[i * 3 + 1] += (ay / count - source[i * 3 + 1]) * w;
        positions[i * 3 + 2] += (az / count - source[i * 3 + 2]) * w;
      }
      break;
    }

    case 'flatten': {
      // The plane is the weighted average position under the brush, with the
      // brush normal — so it flattens onto the surface's own local plane rather
      // than onto whatever plane the camera happens to be looking down.
      let px = 0, py = 0, pz = 0, total = 0;
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const w = weights[k];
        px += positions[i * 3] * w;
        py += positions[i * 3 + 1] * w;
        pz += positions[i * 3 + 2] * w;
        total += w;
      }
      if (total < 1e-9) break;
      px /= total; py /= total; pz /= total;

      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const d =
          (px - positions[i * 3]) * stamp.nx +
          (py - positions[i * 3 + 1]) * stamp.ny +
          (pz - positions[i * 3 + 2]) * stamp.nz;
        const w = weights[k] * strength;
        positions[i * 3] += stamp.nx * d * w;
        positions[i * 3 + 1] += stamp.ny * d * w;
        positions[i * 3 + 2] += stamp.nz * d * w;
      }
      break;
    }

    case 'pinch': {
      // Towards the brush axis, in the plane of the surface. Pulling along the
      // normal as well would just be a dent; what sharpens an edge is bringing
      // material in sideways.
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        let vx = stamp.x - positions[i * 3];
        let vy = stamp.y - positions[i * 3 + 1];
        let vz = stamp.z - positions[i * 3 + 2];
        const along = vx * stamp.nx + vy * stamp.ny + vz * stamp.nz;
        vx -= stamp.nx * along;
        vy -= stamp.ny * along;
        vz -= stamp.nz * along;
        const w = weights[k] * strength * 0.5 * sign;
        positions[i * 3] += vx * w;
        positions[i * 3 + 1] += vy * w;
        positions[i * 3 + 2] += vz * w;
      }
      break;
    }

    case 'grab': {
      const gx = stamp.dx ?? 0;
      const gy = stamp.dy ?? 0;
      const gz = stamp.dz ?? 0;
      for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const w = weights[k];
        positions[i * 3] += gx * w;
        positions[i * 3 + 1] += gy * w;
        positions[i * 3 + 2] += gz * w;
      }
      break;
    }
  }

  mesh.revision++;
}

/**
 * A stroke's worth of history.
 *
 * `positions` is the delta form — the vertices the stroke moved, and where they
 * were — which is what a stroke costs when nothing was added or removed.
 * `mesh` is the fallback for a stroke that changed the topology, where there is
 * no index to move back to.
 */
export interface SculptUndoEntry {
  indices: Int32Array | null;
  positions: Float32Array | null;
  mesh: SculptMesh | null;
}

/** Closes a stroke and returns what it would take to put the mesh back. */
export function endStroke(session: SculptSession): SculptUndoEntry | null {
  recomputeNormals(session.mesh);

  if (session.topologyChanged && session.before) {
    return { indices: null, positions: null, mesh: session.before };
  }
  if (session.undoIndices.length === 0) return null;

  return {
    indices: Int32Array.from(session.undoIndices),
    positions: Float32Array.from(session.undoPositions),
    mesh: null,
  };
}

/** Puts a mesh back to before a stroke, and returns the entry that redoes it. */
export function applyUndo(mesh: SculptMesh, entry: SculptUndoEntry): SculptUndoEntry {
  if (entry.mesh) {
    const redo: SculptUndoEntry = { indices: null, positions: null, mesh: cloneSculptMesh(mesh) };
    mesh.positions = entry.mesh.positions.slice();
    mesh.vertexCount = entry.mesh.vertexCount;
    mesh.faces = entry.mesh.faces.slice();
    mesh.faceCount = entry.mesh.faceCount;
    mesh.topologyRevision++;
    mesh.revision++;
    recomputeNormals(mesh);
    return redo;
  }

  const indices = entry.indices!;
  const positions = entry.positions!;
  const redoPositions = new Float32Array(positions.length);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    redoPositions[k * 3] = mesh.positions[i * 3];
    redoPositions[k * 3 + 1] = mesh.positions[i * 3 + 1];
    redoPositions[k * 3 + 2] = mesh.positions[i * 3 + 2];
    mesh.positions[i * 3] = positions[k * 3];
    mesh.positions[i * 3 + 1] = positions[k * 3 + 1];
    mesh.positions[i * 3 + 2] = positions[k * 3 + 2];
  }
  mesh.revision++;
  recomputeNormals(mesh);
  return { indices, positions: redoPositions, mesh: null };
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export interface RayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  face: number;
  distance: number;
}

/**
 * The nearest front-facing triangle a ray enters.
 *
 * The renderer's own raycaster could answer this, but it answers it against the
 * buffer geometry it was handed, which during a stroke is a frame behind the
 * mesh. Asking the mesh directly is what keeps the brush landing where the
 * cursor is rather than where it was.
 */
export function raycastMesh(
  mesh: SculptMesh,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number
): RayHit | null {
  const { positions, faces, faceCount } = mesh;
  let best: RayHit | null = null;

  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3] * 3;
    const b = faces[f * 3 + 1] * 3;
    const c = faces[f * 3 + 2] * 3;

    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];

    // Möller-Trumbore.
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;

    const inv = 1 / det;
    const tx = ox - positions[a];
    const ty = oy - positions[a + 1];
    const tz = oz - positions[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;

    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t <= 1e-7) continue;
    if (best && t >= best.distance) continue;

    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    best = {
      x: ox + dx * t,
      y: oy + dy * t,
      z: oz + dz * t,
      nx, ny, nz,
      face: f,
      distance: t,
    };
  }

  return best;
}

// ---------------------------------------------------------------------------
// Handing the mesh back to the app
// ---------------------------------------------------------------------------

/**
 * The two vertex arrays a `SceneGeom` of type 'mesh' carries.
 *
 * `renderVertices` is the Z-up sculpting space itself; `vertices` is the
 * Three.js Y-up copy (x, z, -y) that the MJCF builder and the static render
 * path expect. Keeping both in step here is what lets a sculpted body go
 * through export, simulation and machining without any of them knowing.
 */
export function toSceneGeom(mesh: SculptMesh): { vertices: number[]; renderVertices: number[]; faces: number[] } {
  const renderVertices: number[] = new Array(mesh.vertexCount * 3);
  const vertices: number[] = new Array(mesh.vertexCount * 3);

  for (let i = 0; i < mesh.vertexCount; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    renderVertices[i * 3] = x;
    renderVertices[i * 3 + 1] = y;
    renderVertices[i * 3 + 2] = z;
    vertices[i * 3] = x;
    vertices[i * 3 + 1] = z;
    vertices[i * 3 + 2] = -y;
  }

  const faces: number[] = new Array(mesh.faceCount * 3);
  for (let i = 0; i < mesh.faceCount * 3; i++) faces[i] = mesh.faces[i];

  return { vertices, renderVertices, faces };
}

/** Rebuilds a sculpting mesh from what a `SceneGeom` stored. */
export function fromSceneGeom(renderVertices: ArrayLike<number>, faces: ArrayLike<number>): SculptMesh {
  return createSculptMesh(renderVertices, faces);
}

/** Axis-aligned bounds, for framing the camera and for reporting size. */
export function meshBounds(mesh: SculptMesh): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.vertexCount; i++) {
    for (let k = 0; k < 3; k++) {
      const value = mesh.positions[i * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }
  if (mesh.vertexCount === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/**
 * Whether the surface is closed — every edge shared by exactly two triangles.
 *
 * A sculpt that fails this cannot be printed or machined from, and the failure
 * is silent everywhere else: the renderer draws an open mesh quite happily, and
 * the first anyone hears of it is a slicer refusing the file. Cheap to check
 * here, so it is checked here.
 */
export function isWatertight(mesh: SculptMesh): boolean {
  const counts = new Map<number, number>();
  for (let f = 0; f < mesh.faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.faces[f * 3 + e];
      const b = mesh.faces[f * 3 + ((e + 1) % 3)];
      const key = edgeKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const count of counts.values()) if (count !== 2) return false;
  return true;
}
