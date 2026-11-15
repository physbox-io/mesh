/**
 * Boards: pieces stiff enough to keep their shape (a cap's peak, a plastic
 * stiffener), held rigid in their plane by lattice shape matching (Rivers &
 * James, "FastLSM", 2007). Each point's neighbourhood (the ring of its
 * triangles), and the whole board, are matched to the flat pattern by the
 * best rotation, and each point goes to the average of where they put it.
 * Points held by something else (tacked where the board is sewn on) are
 * matched to, not moved: moved, the tacks pulled back and it went unstable.
 *
 * Why: the solver passes over the cloth a few times a step, point to point,
 * which holds a soft cloth but not a board. A peak sewn level to a cap's band
 * swung down 55 deg as a cone, its outer edge crushed a fifth shorter, however
 * stiff its material was set (a hundred times stiffer changed nothing): each
 * pass undid only a row's worth of what its weight did. Matched as a whole
 * and in small neighbourhoods each substep, it keeps its flat shape: a board
 * here rests flat as cut, or as it is set in a curve (a pre-curved peak).
 *
 * Pure: positions in, positions out.
 */

/** A board as the model hands it over: its particles, its shape at rest (metres: its flat pattern, or 3D where it is set in a curve), its triangles (local). */
export interface Board {
  particles: number[];
  rest: number[][];
  tris: number[];
  /** Points held by something else (tacked where it is sewn on): matched to, not moved. */
  held?: number[];
}

/** Bending stiffness (E t^3 / 12, N m) from which a piece is a board: a peak's board is ~0.3, a buckram crown ~0.01. */
export const BOARD_STIFFNESS = 0.05;

/** Each point's neighbourhood: this many rings of triangles round it. */
const RINGS = 1;

interface Cluster { ids: Int32Array; /** Rest offsets from its centre, 3 per point. */ rest: Float64Array; /** Its rest shape is flat (z 0 throughout): its third axis made square to the other two. */ flat: boolean; weight?: Float64Array; /** Its last rotation, a unit quaternion (w, x, y, z): where the next fit starts. */ q: Float64Array }

export class BoardShapes {
  private clusters: Cluster[] = [];
  private goal: Float64Array;
  private count: Float64Array;
  private members: Int32Array;
  private held: Uint8Array;
  private A = new Float64Array(9);
  private R = new Float64Array(9);

  constructor(boards: Board[], n: number) {
    const members = new Set<number>();
    this.held = new Uint8Array(n);
    for (const b of boards) {
      for (const h of b.held ?? []) this.held[b.particles[h]] = 1;
      const m = b.particles.length, nbr: Set<number>[] = Array.from({ length: m }, () => new Set<number>());
      for (let t = 0; t < b.tris.length; t += 3) for (let e = 0; e < 3; e++) for (let f = 0; f < 3; f++) if (e !== f) nbr[b.tris[t + e]].add(b.tris[t + f]);
      // The whole board as one, too: rigid across it at once (by small
      // neighbourhoods alone its weight still swung it down, a little each
      // pass; by the whole alone, as much as with nothing).
      const flat = b.rest.every((q) => !q[2]);
      const restOf = (ids: number[]) => {
        const c = [0, 1, 2].map((k) => ids.reduce((acc, j) => acc + (b.rest[j][k] ?? 0), 0) / ids.length), rest = new Float64Array(3 * ids.length);
        ids.forEach((j, k) => { for (let d = 0; d < 3; d++) rest[3 * k + d] = (b.rest[j][d] ?? 0) - c[d]; });
        return rest;
      };
      if (m >= 3) this.clusters.push({ ids: Int32Array.from(b.particles), rest: restOf(b.particles.map((_, k) => k)), flat, q: Float64Array.of(1, 0, 0, 0) });
      for (let i = 0; i < m; i++) {
        let ring = new Set<number>([i]);
        for (let r = 0; r < RINGS; r++) { const next = new Set(ring); for (const j of ring) for (const k of nbr[j]) next.add(k); ring = next; }
        const ids = [...ring];
        if (ids.length < 3) continue;
        this.clusters.push({ ids: Int32Array.from(ids, (j) => b.particles[j]), rest: restOf(ids), flat, q: Float64Array.of(1, 0, 0, 0) });
        for (const j of ids) members.add(b.particles[j]);
      }
    }
    this.goal = new Float64Array(3 * n);
    this.count = new Float64Array(n);
    this.members = Int32Array.from(members);
  }

  get active() { return this.clusters.length > 0; }

  /** Each board's points moved to where their neighbourhoods, each turned rigidly to fit, put them (points with no weight stay). */
  solve(x: Float64Array, w: Float64Array) {
    if (!this.clusters.length) return;
    const { goal, count } = this;
    const members = this.members, A = this.A, R = this.R;
    for (let k = 0; k < members.length; k++) { const i = members[k]; goal[3 * i] = goal[3 * i + 1] = goal[3 * i + 2] = 0; count[i] = 0; }
    for (let ci = 0; ci < this.clusters.length; ci++) {
      const { ids, rest, weight, q, flat } = this.clusters[ci];
      const m = ids.length;
      let cx = 0, cy = 0, cz = 0, ws = 0;
      for (let k = 0; k < m; k++) { const i = 3 * ids[k], wk = weight ? weight[k] : 1; cx += wk * x[i]; cy += wk * x[i + 1]; cz += wk * x[i + 2]; ws += wk; }
      cx /= ws; cy /= ws; cz /= ws;
      // The flat pattern's centre the same way.
      let ru = 0, rv = 0, rw = 0;
      if (weight) { for (let k = 0; k < m; k++) { ru += weight[k] * rest[3 * k]; rv += weight[k] * rest[3 * k + 1]; rw += weight[k] * rest[3 * k + 2]; } ru /= ws; rv /= ws; rw /= ws; }
      // A = sum (x - c) r^T.
      A.fill(0);
      for (let k = 0; k < m; k++) {
        const wk = weight ? weight[k] : 1, i = 3 * ids[k], dx = wk * (x[i] - cx), dy = wk * (x[i + 1] - cy), dz = wk * (x[i + 2] - cz), u = rest[3 * k] - ru, v = rest[3 * k + 1] - rv, t = rest[3 * k + 2] - rw;
        A[0] += dx * u; A[1] += dx * v; A[2] += dx * t; A[3] += dy * u; A[4] += dy * v; A[5] += dy * t; A[6] += dz * u; A[7] += dz * v; A[8] += dz * t;
      }
      if (flat) {
        // Flat at rest: the third column square to the other two, so the fit is a rotation, not a reflection.
        A[2] = A[3] * A[7] - A[6] * A[4]; A[5] = A[6] * A[1] - A[0] * A[7]; A[8] = A[0] * A[4] - A[3] * A[1];
        const s3 = Math.sqrt(Math.sqrt((A[0] * A[0] + A[3] * A[3] + A[6] * A[6]) * (A[1] * A[1] + A[4] * A[4] + A[7] * A[7])));
        const l3 = Math.sqrt(A[2] * A[2] + A[5] * A[5] + A[8] * A[8]);
        if (l3 < 1e-18 || s3 < 1e-12) continue;
        A[2] *= s3 / l3; A[5] *= s3 / l3; A[8] *= s3 / l3;
      }
      rotationOf(A, q, R);
      for (let k = 0; k < m; k++) {
        const i = ids[k], u = rest[3 * k] - ru, v = rest[3 * k + 1] - rv, t = rest[3 * k + 2] - rw;
        goal[3 * i] += cx + R[0] * u + R[1] * v + R[2] * t;
        goal[3 * i + 1] += cy + R[3] * u + R[4] * v + R[5] * t;
        goal[3 * i + 2] += cz + R[6] * u + R[7] * v + R[8] * t;
        count[i]++;
      }
    }
    for (let k = 0; k < members.length; k++) {
      const i = members[k];
      if (!w[i] || !count[i] || this.held[i]) continue;
      x[3 * i] = goal[3 * i] / count[i]; x[3 * i + 1] = goal[3 * i + 1] / count[i]; x[3 * i + 2] = goal[3 * i + 2] / count[i];
    }
  }
}

/**
 * The rotation part of a 3x3 (row-major) into R, by Mueller et al., "A Robust
 * Method to Extract the Rotational Part of Deformations" (2016): turned from
 * `q` (the last one, a quaternion, updated) a few times toward it. Warm, two
 * turns do; started afresh each time, the polar decomposition took a cluster
 * twenty and the boards half a second a simulated second.
 */
function rotationOf(A: Float64Array, q: Float64Array, R: Float64Array) {
  for (let it = 0; it < 4; it++) {
    const w = q[0], x = q[1], y = q[2], z = q[3];
    R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - w * z); R[2] = 2 * (x * z + w * y);
    R[3] = 2 * (x * y + w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - w * x);
    R[6] = 2 * (x * z - w * y); R[7] = 2 * (y * z + w * x); R[8] = 1 - 2 * (x * x + y * y);
    // Sum over columns i of R_i x A_i, over |sum R_i . A_i|.
    let ox = 0, oy = 0, oz = 0, d = 0;
    for (let c = 0; c < 3; c++) {
      const rx = R[c], ry = R[3 + c], rz = R[6 + c], ax = A[c], ay = A[3 + c], az = A[6 + c];
      ox += ry * az - rz * ay; oy += rz * ax - rx * az; oz += rx * ay - ry * ax;
      d += rx * ax + ry * ay + rz * az;
    }
    const inv = 1 / (Math.abs(d) + 1e-12);
    ox *= inv; oy *= inv; oz *= inv;
    const ang = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (ang < 1e-9) break;
    const sn = Math.sin(ang / 2) / ang, cw = Math.cos(ang / 2), ux = ox * sn, uy = oy * sn, uz = oz * sn;
    // q = turn * q
    const nw = cw * w - ux * x - uy * y - uz * z, nx = cw * x + ux * w + uy * z - uz * y, ny = cw * y - ux * z + uy * w + uz * x, nz = cw * z + ux * y - uy * x + uz * w;
    const l = Math.sqrt(nw * nw + nx * nx + ny * ny + nz * nz);
    q[0] = nw / l; q[1] = nx / l; q[2] = ny / l; q[3] = nz / l;
  }
  const w = q[0], x = q[1], y = q[2], z = q[3];
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - w * z); R[2] = 2 * (x * z + w * y);
  R[3] = 2 * (x * y + w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - w * x);
  R[6] = 2 * (x * z - w * y); R[7] = 2 * (y * z + w * x); R[8] = 1 - 2 * (x * x + y * y);
}
