/**
 * How far a brush may push a surface inward before it meets the other side.
 *
 * An inward stroke (draw or inflate, inverted) moves each vertex a fixed
 * amount per dab, and dabs overlap: ten of them around the top of an 80 mm
 * ball drove the top down through the clay below it. The surface folded
 * through itself, stayed closed and consistently wound, and MuJoCo then
 * refused the whole scene ("eigenvalue of mesh inertia must be positive").
 *
 * So each vertex an inward stroke reaches is measured once: a ray from where
 * it was when the stroke reached it, inward along the stroke's direction there,
 * against the surface as the stroke found it. It may then travel a fraction of
 * that thickness, less a floor of clay kept behind it, and no more in this
 * stroke. A fraction under a half also
 * keeps two walls pushed toward each other from meeting in the middle, and on
 * a ball (thickness = twice the radius of curvature) keeps vertices whose
 * normals converge from passing through their common centre.
 *
 * Measured against the stroke's STARTING surface (a copy), through a BVH built
 * the first time it is asked, so a stroke pays for one build.
 */
import { buildFlatBvh, queryFlatBvhRay, type FlatBvh } from './meshBvh';

/** Of the thickness under it, how far one stroke may push a vertex in. */
export const INWARD_THICKNESS_FRACTION = 0.45;

export interface InwardGuard {
  /** The inward travel allowed from `p0` along `-n0`; Infinity on an open surface with nothing behind. */
  limitFrom(p0: ArrayLike<number>, n0: ArrayLike<number>): number;
}

export function createInwardGuard(
  positions: ArrayLike<number>, vertexCount: number,
  faces: ArrayLike<number>, faceCount: number,
  /**
   * Clay kept between a vertex and what is behind it, in metres. Without one
   * a pit whose walls approach each other closes geometrically, stroke after
   * stroke, until rounding alone puts one wall through the other.
   */
  minGap = 0,
): InwardGuard {
  const p = Float32Array.from({ length: vertexCount * 3 }, (_, i) => positions[i]);
  const f = Uint32Array.from({ length: faceCount * 3 }, (_, i) => faces[i]);
  let bvh: FlatBvh | null = null;
  const candidates: number[] = [];

  return {
    limitFrom(p0, n0) {
      if (!bvh) bvh = buildFlatBvh(p, f);
      const dx = -n0[0], dy = -n0[1], dz = -n0[2];
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 0)) return Infinity;
      const ux = dx / len, uy = dy / len, uz = dz / len;
      const ox = p0[0], oy = p0[1], oz = p0[2];
      candidates.length = 0;
      queryFlatBvhRay(bvh, ox, oy, oz, ux, uy, uz, candidates);
      // Past the faces the vertex itself is a corner of.
      let best = Infinity;
      for (const t of candidates) {
        const a = f[t * 3] * 3, b = f[t * 3 + 1] * 3, c = f[t * 3 + 2] * 3;
        const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
        const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
        const px = uy * e2z - uz * e2y, py = uz * e2x - ux * e2z, pz = ux * e2y - uy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-18) continue;
        const inv = 1 / det;
        const tx = ox - p[a], ty = oy - p[a + 1], tz = oz - p[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (ux * qx + uy * qy + uz * qz) * inv;
        if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (dist > 1e-6 && dist < best) best = dist;
      }
      return best === Infinity ? Infinity : Math.max(0, best - minGap) * INWARD_THICKNESS_FRACTION;
    },
  };
}

/** Each vertex's faces, compressed (offsets into one list), for one topology. */
export interface VertexFaces {
  offsets: Uint32Array;
  faces: Uint32Array;
  topologyRevision: number;
}

export function buildVertexFaces(faces: Uint32Array, faceCount: number, vertexCount: number, topologyRevision: number): VertexFaces {
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < faceCount * 3; i++) offsets[faces[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const fill = offsets.slice(0, vertexCount);
  const list = new Uint32Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    for (let c = 0; c < 3; c++) list[fill[faces[f * 3 + c]]++] = f;
  }
  return { offsets, faces: list, topologyRevision };
}

/**
 * How far past turning over a face may go in one dab before it counts as a
 * fold: its normal reversed against its own from before the dab, or facing
 * clearly away from the brush having faced it. Clearly, as a cosine: a crisp
 * punch (hardness 0.8 with depthMm) is MEANT to stand its wall up sideways,
 * and a wall face going perpendicular is not a fold.
 */
const FOLD_COSINE = -0.25;

/**
 * Takes back as much of a dab as it takes to fold nothing over.
 *
 * The thickness limit stops a dent going through the far wall; it does not stop
 * the dent's own walls folding. Inflate pushes each vertex along its own
 * normal, and inverted inside a dent those normals point at each other and
 * then down under the rim, so three passes round the top of a ball left the
 * walls of the pit passing through one another (still closed, still wound
 * outward). A fold shows up as a face that turns over: one whose normal
 * reverses in a dab, or one that faced the way the brush was pushing from
 * and now faces clearly away (FOLD_COSINE). The dab is halved until none does,
 * and dropped if halving five times does not get there.
 *
 * Only the faces round the moved vertices are looked at, through `around`, so
 * a dab costs what it touches rather than the whole mesh.
 *
 * `before` holds the positions of `indices` before the dab, three per vertex.
 */
export function keepFromFolding(
  positions: Float32Array, faces: Uint32Array, around: VertexFaces,
  indices: number[], before: Float32Array, stampNormal: [number, number, number],
): void {
  if (indices.length === 0) return;
  const slot = new Map<number, number>();
  indices.forEach((v, k) => { slot.set(v, k); });
  const seen = new Set<number>();
  const touched: number[] = [];
  for (const v of indices) {
    for (let i = around.offsets[v]; i < around.offsets[v + 1]; i++) {
      const f = around.faces[i];
      if (!seen.has(f)) { seen.add(f); touched.push(f); }
    }
  }
  const at = (v: number, old: boolean, out: number[], o: number) => {
    const k = old ? slot.get(v) : undefined;
    if (k !== undefined) { out[o] = before[k * 3]; out[o + 1] = before[k * 3 + 1]; out[o + 2] = before[k * 3 + 2]; }
    else { out[o] = positions[v * 3]; out[o + 1] = positions[v * 3 + 1]; out[o + 2] = positions[v * 3 + 2]; }
  };
  const tri = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const normal = (f: number, old: boolean): [number, number, number] => {
    at(faces[f * 3], old, tri, 0); at(faces[f * 3 + 1], old, tri, 3); at(faces[f * 3 + 2], old, tri, 6);
    const ux = tri[3] - tri[0], uy = tri[4] - tri[1], uz = tri[5] - tri[2];
    const vx = tri[6] - tri[0], vy = tri[7] - tri[1], vz = tri[8] - tri[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const [sx, sy, sz] = stampNormal;
  const sl = Math.hypot(sx, sy, sz) || 1;
  const was = touched.map((f) => normal(f, true));
  const folds = () => touched.some((f, k) => {
    const a = was[k];
    const b = normal(f, false);
    const la = Math.hypot(a[0], a[1], a[2]);
    const lb = Math.hypot(b[0], b[1], b[2]);
    if (!(la > 0) || !(lb > 0)) return false;
    if ((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb) < FOLD_COSINE) return true;
    const facedBrush = (a[0] * sx + a[1] * sy + a[2] * sz) / (la * sl) > 0.1;
    return facedBrush && (b[0] * sx + b[1] * sy + b[2] * sz) / (lb * sl) < FOLD_COSINE;
  });
  for (let attempt = 0; attempt <= 5 && folds(); attempt++) {
    const keep = attempt === 5 ? 0 : 0.5;
    indices.forEach((v, k) => {
      for (let a = 0; a < 3; a++) {
        const b0 = before[k * 3 + a];
        positions[v * 3 + a] = b0 + (positions[v * 3 + a] - b0) * keep;
      }
    });
  }
}
