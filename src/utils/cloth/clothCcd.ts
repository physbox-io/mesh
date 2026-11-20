/**
 * Cloth that cannot pass through cloth: continuous collision over a step.
 *
 * Contact by proximity (clothSelf, clothLayers) keeps cloth apart where it
 * is found near cloth at the end of a substep; nothing there stops a point
 * that moves further than the gap in one go, or two edges crossing with no
 * point inside a triangle, and a crossing once made is kept. This closes
 * that: every point against every triangle, and every edge against every
 * edge, along the straight line each moved over the step (from where the
 * step began to where the solver left it), all the cloth in the scene
 * together (Bridson, Fedkiw and Anderson, "Robust treatment of collisions,
 * contact and friction for cloth animation", 2002).
 *
 * If the cloth was not crossed where the step began and nothing meets along
 * those lines, it is not crossed where the step ends, whatever path the
 * solver took between: so this need not run every substep, only over each
 * stretch of them whose end is kept.
 *
 * What meets is pushed back to the side it started on, the pair moving by
 * their inverse masses, a few rounds over; what still meets after that is
 * gathered into impact zones (all the points of pairs that met, joined), each
 * moved rigidly over the step, which cannot cross what it holds; zones that
 * then meet are joined and moved again. At the worst everything that moved is
 * held where it began, which crosses nothing.
 *
 * Pairs that cannot cross: points joined (sewn: one root), and pairs both already in a crossing
 * when the step began (left free, for untangling to bring back).
 *
 * Pure: positions in, positions out.
 */

/** Least gap kept between what met, metres. */
const ETA = 5e-5;
/** A crossed pair is at its crossing within this, metres (a few triangles). */
const AT_CROSSING = 0.03;
/** Rounds of pushing apart before impact zones. */
const PUSH_ROUNDS = 4;
/** Rounds of impact zones before everything that met is held where it began. */
const ZONE_ROUNDS = 40;
/** The hash's cell, metres: about a cloth triangle. */
const CELL = 0.012;
const MIN_REACH = 0.06;

const nextPow2 = (v: number) => {
  let p = 1024;
  while (p < v) p <<= 1;
  return p;
};

const hash = (ix: number, iy: number, iz: number, mask: number) => ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;

export interface CcdStats {
  /** Pairs that met in the first look. */
  met: number;
  /** Rounds of pushing apart. */
  pushes: number;
  /** Impact zones made, and the points in them. */
  zones: number;
  zonePoints: number;
  /** Everything that met held where it began (the last resort). */
  frozen: boolean;
}

/** One meeting: up to four points, each with its coefficient (+ one side, - the other), and the normal, signed to the side it started on. */
interface Hit { v: Int32Array; c: Float64Array; k: number; nx: number; ny: number; nz: number }

export class ClothCcd {
  readonly n: number;
  private tris: Int32Array;
  private root: Int32Array;
  private edges: Int32Array;
  private buckets: number;
  private mask: number;
  /**
   * Points on a triangle: the cloth. A model may carry points on none (a
   * gathered or pleated panel's shell points, left where the shell had them
   * when it is meshed afresh, held still); taken for cloth, the folds were
   * held off them, and the impact zones they joined held still, the cloth
   * round them stretched where it caught (a pleated skirt to 12% at p99).
   */
  private onCloth: Uint8Array;
  /** Per point and per triangle, whether it is in a crossing (both flagged: the pair is left free). */
  tangledPoint: Uint8Array;
  tangledTri: Uint8Array;
  private anyTangled = false;
  // The hash, reused.
  private start: Int32Array;
  private entries = new Int32Array(1 << 14);
  private eStart: Int32Array;
  private eEntries = new Int32Array(1 << 14);
  private cur: Int32Array;
  private nearFlags: Uint8Array;
  private nearTouched: Int32Array;
  private wasBuf: Float64Array;
  private changedBuf: Uint8Array;
  // Per point, triangle and edge: swept boxes and stamps, reused.
  private pB = new Float64Array(0); private moved = new Uint8Array(0);
  private tB = new Float64Array(0); private tStamp = new Int32Array(0);
  private eB = new Float64Array(0); private eStamp = new Int32Array(0);

  /** `root`: each point's representative after joining sewn points (they may meet). */
  constructor(n: number, tris: Int32Array, root: Int32Array) {
    this.n = n; this.tris = tris; this.root = root;
    const seen = new Set<number>(), E: number[] = [];
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
      const p = tris[t + k], q = tris[t + ((k + 1) % 3)], a = Math.min(p, q), b = Math.max(p, q), key = a * n + b;
      if (!seen.has(key)) { seen.add(key); E.push(a, b); }
    }
    this.edges = Int32Array.from(E);
    const nt = tris.length / 3;
    const buckets = nextPow2(Math.max(1024, 2 * Math.max(nt, this.edges.length / 2)));
    this.buckets = buckets;
    this.mask = buckets - 1;
    this.start = new Int32Array(buckets + 1);
    this.eStart = new Int32Array(buckets + 1);
    this.cur = new Int32Array(buckets);
    this.nearFlags = new Uint8Array(buckets);
    this.nearTouched = new Int32Array(buckets);
    this.wasBuf = new Float64Array(3 * n);
    this.changedBuf = new Uint8Array(n);
    this.onCloth = new Uint8Array(n);
    for (let t = 0; t < tris.length; t++) this.onCloth[tris[t]] = 1;
    this.tangledPoint = new Uint8Array(n);
    this.tangledTri = new Uint8Array(nt);
  }

  /**
   * Marks what is in a crossing now, to be left free (none clears it): the
   * points of each crossing's edge and triangle, and every triangle with one
   * of them. No more: a pair is free only if both are in it, so what is
   * crossed can come back through, and nothing round it can cross (left free
   * 2 cm round each, crossings spread as it ran, 335 to 716).
   */
  setTangled(crossings: { a: number; b: number; t: number }[] | null) {
    this.tangledPoint.fill(0); this.tangledTri.fill(0); this.anyTangled = false;
    if (!crossings || !crossings.length) return;
    const T = this.tris;
    for (const c of crossings) { this.tangledPoint[c.a] = 1; this.tangledPoint[c.b] = 1; for (let k = 0; k < 3; k++) this.tangledPoint[T[3 * c.t + k]] = 1; }
    for (let t = 0; t < T.length / 3; t++) if (this.tangledPoint[T[3 * t]] || this.tangledPoint[T[3 * t + 1]] || this.tangledPoint[T[3 * t + 2]]) this.tangledTri[t] = 1;
    this.anyTangled = true;
  }

  private joined(a: number, b: number) { return this.root[a] === this.root[b]; }

  /** Pieces (by `piece`, per point) left free of each other: pairs `a * count + b`, both ways. */
  private freePiece: Int32Array | null = null;
  private freePairs: Set<number> | null = null;
  private freeCount = 0;

  /**
   * Leaves whole pieces free of each other (none for null): the cloth a
   * builder made crossed, while it is still being sewn into place, before
   * it is first drawn. Held to the crossings' own points alone there, a bow
   * modelled through a gown could not be carried out through it by being
   * sewn on. Not for a running scene.
   */
  setFreePieces(piece: Int32Array | null, pairs: [number, number][] = []) {
    if (!piece || !pairs.length) { this.freePiece = null; this.freePairs = null; return; }
    let count = 0;
    for (let i = 0; i < piece.length; i++) count = Math.max(count, piece[i] + 1);
    this.freePiece = piece; this.freeCount = count; this.freePairs = new Set();
    for (const [a, b] of pairs) { this.freePairs.add(a * count + b); this.freePairs.add(b * count + a); }
  }

  private freeOf(a: number, b: number) { return !!this.freePairs && this.freePairs.has(this.freePiece![a] * this.freeCount + this.freePiece![b]); }

  /**
   * The step from `x0` (where it began, not crossed) to `x1` (where the
   * solver left it), made so nothing crosses: `x1` is changed in place.
   * `w`: inverse masses (0 is held: it does not move for this).
   */
  resolve(x0: Float64Array, x1: Float64Array, w: Float64Array): CcdStats {
    const stats: CcdStats = { met: 0, pushes: 0, zones: 0, zonePoints: 0, frozen: false };
    let hits = this.detect(x0, x1, null);
    stats.met = hits.length;
    if (!hits.length) return stats;
    // After the first look only pairs with a point the response moved can
    // meet anew (one that did not meet, its points where they were, still does not).
    const was = this.wasBuf, changed = this.changedBuf;
    was.set(x1);
    const redetect = () => {
      changed.fill(0);
      for (let i = 0; i < this.n; i++) { const k = 3 * i; if (x1[k] !== was[k] || x1[k + 1] !== was[k + 1] || x1[k + 2] !== was[k + 2]) changed[i] = 1; }
      for (const h of hits) for (let q = 0; q < h.k; q++) changed[h.v[q]] = 1;
      was.set(x1);
      return this.detect(x0, x1, changed);
    };
    for (let round = 0; round < PUSH_ROUNDS && hits.length; round++) {
      for (const h of hits) this.push(h, x1, w);
      stats.pushes++;
      hits = redetect();
    }
    if (!hits.length) return stats;
    // Impact zones: what still meets, joined, moved rigidly.
    const zone = Int32Array.from({ length: this.n }, (_, i) => i);
    const find = (i: number): number => { while (zone[i] !== i) { zone[i] = zone[zone[i]]; i = zone[i]; } return i; };
    const inZone = new Uint8Array(this.n);
    for (let round = 0; round < ZONE_ROUNDS && hits.length; round++) {
      for (const h of hits) {
        for (let q = 0; q < h.k; q++) inZone[h.v[q]] = 1;
        for (let q = 1; q < h.k; q++) { const a = find(h.v[0]), b = find(h.v[q]); if (a !== b) zone[a] = b; }
      }
      const members = new Map<number, number[]>();
      for (let i = 0; i < this.n; i++) if (inZone[i]) { const r = find(i); (members.get(r) ?? members.set(r, []).get(r)!).push(i); }
      for (const pts of members.values()) rigid(pts, x0, x1, w);
      stats.zones = members.size; stats.zonePoints = [...members.values()].reduce((s, p) => s + p.length, 0);
      hits = redetect();
    }
    if (hits.length) {
      // The last resort: everything that met, and everything that moved with it, where it began.
      for (let i = 0; i < this.n; i++) if (inZone[i]) for (let c = 0; c < 3; c++) x1[3 * i + c] = x0[3 * i + c];
      for (const h of hits) for (let q = 0; q < h.k; q++) { const i = h.v[q]; for (let c = 0; c < 3; c++) x1[3 * i + c] = x0[3 * i + c]; }
      hits = this.detect(x0, x1, null);
      if (hits.length) x1.set(x0);
      stats.frozen = true;
    }
    return stats;
  }

  /** Every pair that meets along the step. */
  private detect(x0: Float64Array, x1: Float64Array, only: Uint8Array | null): Hit[] {
    const T = this.tris, nt = T.length / 3, E = this.edges, ne = E.length / 2, n = this.n;
    const buckets = this.buckets, mask = this.mask;
    const hits: Hit[] = [];
    // Each point's swept box, once; what moved; and the box round all that
    // moved (only what is near it can meet: an untangling step moves a patch
    // of a garment, and hashing the whole wardrobe for it was most of the cost).
    if (this.pB.length < 6 * n) { this.pB = new Float64Array(6 * n); this.moved = new Uint8Array(n); }
    const pB = this.pB, moved = this.moved;
    let r0 = Infinity, r1 = Infinity, r2 = Infinity, r3 = -Infinity, r4 = -Infinity, r5 = -Infinity, anyMoved = false;
    for (let i = 0; i < n; i++) {
      const k = 3 * i, o = 6 * i, a0 = x0[k], a1 = x0[k + 1], a2 = x0[k + 2], b0 = x1[k], b1 = x1[k + 1], b2 = x1[k + 2];
      const lo0 = a0 < b0 ? a0 : b0, lo1 = a1 < b1 ? a1 : b1, lo2 = a2 < b2 ? a2 : b2, hi0 = a0 < b0 ? b0 : a0, hi1 = a1 < b1 ? b1 : a1, hi2 = a2 < b2 ? b2 : a2;
      pB[o] = lo0 - ETA; pB[o + 1] = lo1 - ETA; pB[o + 2] = lo2 - ETA; pB[o + 3] = hi0 + ETA; pB[o + 4] = hi1 + ETA; pB[o + 5] = hi2 + ETA;
      // What may meet: what moved over the step; on a second look, what the response moved.
      const mv = only ? only[i] === 1 : a0 !== b0 || a1 !== b1 || a2 !== b2;
      moved[i] = mv ? 1 : 0;
      if (mv) { anyMoved = true; if (lo0 < r0) r0 = lo0; if (lo1 < r1) r1 = lo1; if (lo2 < r2) r2 = lo2; if (hi0 > r3) r3 = hi0; if (hi1 > r4) r4 = hi1; if (hi2 > r5) r5 = hi2; }
    }
    if (!anyMoved) return hits;
    // Dynamic reach and coarse cell size from actual max edge length (excluding
    // synthetic far-off test triangles > 2 m that only attach lone points to cloth).
    let maxEdge2 = 0;
    for (let e = 0; e < ne; e++) {
      const a = 3 * E[2 * e], b = 3 * E[2 * e + 1];
      const dx0 = x0[a] - x0[b], dy0 = x0[a + 1] - x0[b + 1], dz0 = x0[a + 2] - x0[b + 2];
      const d0 = dx0 * dx0 + dy0 * dy0 + dz0 * dz0;
      if (d0 <= 4 && d0 > maxEdge2) maxEdge2 = d0;
      const dx1 = x1[a] - x1[b], dy1 = x1[a + 1] - x1[b + 1], dz1 = x1[a + 2] - x1[b + 2];
      const d1 = dx1 * dx1 + dy1 * dy1 + dz1 * dz1;
      if (d1 <= 4 && d1 > maxEdge2) maxEdge2 = d1;
    }
    const maxEdge = Math.sqrt(maxEdge2);
    const reach = Math.max(MIN_REACH, maxEdge + 2 * ETA);
    const coarse = reach;
    const cell = Math.max(CELL, maxEdge / 5);
    // Widened by a triangle: a point that did not move can be met by a
    // triangle that did, beside one of its corners that did not (the box
    // round only what moved left that point out, and a shirt's collar went
    // through a jacket's).
    r0 -= reach; r1 -= reach; r2 -= reach; r3 += reach; r4 += reach; r5 += reach;
    // Where what moved is scattered (untangling several crossings over a
    // garment), the box round it all is most of the scene: only the coarse
    // cells round what moved, then. A primitive is in if any of its points is
    // in or next to one (a primitive is smaller than a coarse cell).
    let useNear = false;
    let nNearTouched = 0;
    const nearFlags = this.nearFlags, nearTouched = this.nearTouched;
    let nMoved = 0;
    for (let i = 0; i < n; i++) nMoved += moved[i];
    if (nMoved < n / 4) {
      useNear = true;
      for (let i = 0; i < n; i++) {
        if (!moved[i]) continue;
        const o = 6 * i;
        const ax = Math.floor(pB[o] / coarse) - 1, bx = Math.floor(pB[o + 3] / coarse) + 1, ay = Math.floor(pB[o + 1] / coarse) - 1, by = Math.floor(pB[o + 4] / coarse) + 1, az = Math.floor(pB[o + 2] / coarse) - 1, bz = Math.floor(pB[o + 5] / coarse) + 1;
        for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) {
          const hb = hash(a, b, c, mask);
          if (!nearFlags[hb]) { nearFlags[hb] = 1; nearTouched[nNearTouched++] = hb; }
        }
      }
    }
    const nearPt = (i: number) => !useNear || nearFlags[hash(Math.floor(pB[6 * i] / coarse), Math.floor(pB[6 * i + 1] / coarse), Math.floor(pB[6 * i + 2] / coarse), mask)] === 1;
    if (this.tB.length < 6 * nt) { this.tB = new Float64Array(6 * nt); this.tStamp = new Int32Array(nt); }
    if (this.eB.length < 6 * ne) { this.eB = new Float64Array(6 * ne); this.eStamp = new Int32Array(ne); }
    const tB = this.tB, eB = this.eB;
    // A box from its points' boxes; marked out (lo = Infinity) when clear of the moved region.
    const boxOf = (ids: Int32Array, from: number, count: number, out: Float64Array, o: number) => {
      let l0 = Infinity, l1 = Infinity, l2 = Infinity, h0 = -Infinity, h1 = -Infinity, h2 = -Infinity;
      for (let q = 0; q < count; q++) {
        const pp = 6 * ids[from + q];
        if (pB[pp] < l0) l0 = pB[pp]; if (pB[pp + 1] < l1) l1 = pB[pp + 1]; if (pB[pp + 2] < l2) l2 = pB[pp + 2];
        if (pB[pp + 3] > h0) h0 = pB[pp + 3]; if (pB[pp + 4] > h1) h1 = pB[pp + 4]; if (pB[pp + 5] > h2) h2 = pB[pp + 5];
      }
      if (h0 < r0 || h1 < r1 || h2 < r2 || l0 > r3 || l1 > r4 || l2 > r5) { out[o] = Infinity; return; }
      if (useNear) { let any = false; for (let q = 0; q < count && !any; q++) any = nearPt(ids[from + q]); if (!any) { out[o] = Infinity; return; } }
      out[o] = l0; out[o + 1] = l1; out[o + 2] = l2; out[o + 3] = h0; out[o + 4] = h1; out[o + 5] = h2;
    };
    const fill = (count: number, per: number, ids: Int32Array, box: Float64Array, start: Int32Array, which: 'tri' | 'edge') => {
      start.fill(0);
      let total = 0;
      for (let i = 0; i < count; i++) {
        const o = 6 * i;
        boxOf(ids, per * i, per, box, o);
        if (box[o] === Infinity) continue;
        const ax = Math.floor(box[o] / cell), bx = Math.floor(box[o + 3] / cell), ay = Math.floor(box[o + 1] / cell), by = Math.floor(box[o + 4] / cell), az = Math.floor(box[o + 2] / cell), bz = Math.floor(box[o + 5] / cell);
        for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) { start[hash(a, b, c, mask) + 1]++; total++; }
      }
      for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
      let entries = which === 'tri' ? this.entries : this.eEntries;
      if (entries.length < total) { entries = new Int32Array(Math.ceil(total * 1.3)); if (which === 'tri') this.entries = entries; else this.eEntries = entries; }
      const cur = this.cur;
      cur.set(start.subarray(0, buckets));
      for (let i = 0; i < count; i++) {
        const o = 6 * i;
        if (box[o] === Infinity) continue;
        const ax = Math.floor(box[o] / cell), bx = Math.floor(box[o + 3] / cell), ay = Math.floor(box[o + 1] / cell), by = Math.floor(box[o + 4] / cell), az = Math.floor(box[o + 2] / cell), bz = Math.floor(box[o + 5] / cell);
        for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) entries[cur[hash(a, b, c, mask)]++] = i;
      }
      return entries;
    };
    // Point against triangle.
    const triEntries = fill(nt, 3, T, tB, this.start, 'tri');
    const stamp = this.tStamp;
    stamp.fill(-1);
    for (let p = 0; p < n; p++) {
      if (!this.onCloth[p]) continue;
      const o = 6 * p;
      if (pB[o + 3] < r0 || pB[o + 4] < r1 || pB[o + 5] < r2 || pB[o] > r3 || pB[o + 1] > r4 || pB[o + 2] > r5) continue;
      if (!nearPt(p)) continue;
      const ax = Math.floor(pB[o] / cell), bx = Math.floor(pB[o + 3] / cell), ay = Math.floor(pB[o + 1] / cell), by = Math.floor(pB[o + 4] / cell), az = Math.floor(pB[o + 2] / cell), bz = Math.floor(pB[o + 5] / cell);
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) {
        const hb = hash(a, b, c, mask);
        for (let e = this.start[hb]; e < this.start[hb + 1]; e++) {
          const t = triEntries[e];
          if (stamp[t] === p) continue;
          stamp[t] = p;
          const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
          if (!moved[p] && !moved[i0] && !moved[i1] && !moved[i2]) continue;
          const q = 6 * t;
          if (pB[o + 3] < tB[q] || pB[o + 4] < tB[q + 1] || pB[o + 5] < tB[q + 2] || pB[o] > tB[q + 3] || pB[o + 1] > tB[q + 4] || pB[o + 2] > tB[q + 5]) continue;
          if (this.joined(p, i0) || this.joined(p, i1) || this.joined(p, i2)) continue;
          if (this.freeOf(p, i0)) continue;
          // Free only where both are in a crossing and at it (flagged both, but
          // apart, a point of the jacket's collar passed through the shirt's
          // where each was crossed somewhere else).
          if (this.anyTangled && this.tangledPoint[p] && this.tangledTri[t] && pointTriDist(x0, p, i0, i1, i2) < AT_CROSSING) continue;
          const h = pointTriangle(x0, x1, p, i0, i1, i2);
          if (h) hits.push(h);
        }
      }
    }
    // Edge against edge.
    const edgeEntries = fill(ne, 2, E, eB, this.eStart, 'edge');
    const eStamp = this.eStamp;
    eStamp.fill(-1);
    for (let e = 0; e < ne; e++) {
      const a0 = E[2 * e], a1 = E[2 * e + 1], o = 6 * e;
      if (eB[o] === Infinity) continue;
      const ax = Math.floor(eB[o] / cell), bx = Math.floor(eB[o + 3] / cell), ay = Math.floor(eB[o + 1] / cell), by = Math.floor(eB[o + 4] / cell), az = Math.floor(eB[o + 2] / cell), bz = Math.floor(eB[o + 5] / cell);
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) {
        const hb = hash(a, b, c, mask);
        for (let qq = this.eStart[hb]; qq < this.eStart[hb + 1]; qq++) {
          const f = edgeEntries[qq];
          if (f <= e || eStamp[f] === e) continue;
          eStamp[f] = e;
          const b0 = E[2 * f], b1 = E[2 * f + 1];
          if (!moved[a0] && !moved[a1] && !moved[b0] && !moved[b1]) continue;
          const q = 6 * f;
          if (eB[o + 3] < eB[q] || eB[o + 4] < eB[q + 1] || eB[o + 5] < eB[q + 2] || eB[o] > eB[q + 3] || eB[o + 1] > eB[q + 4] || eB[o + 2] > eB[q + 5]) continue;
          if (this.joined(a0, b0) || this.joined(a0, b1) || this.joined(a1, b0) || this.joined(a1, b1)) continue;
          if (this.freeOf(a0, b0)) continue;
          if (this.anyTangled && (this.tangledPoint[a0] || this.tangledPoint[a1]) && (this.tangledPoint[b0] || this.tangledPoint[b1]) && segDist(x0, a0, a1, b0, b1) < AT_CROSSING) continue;
          const h = edgeEdge(x0, x1, a0, a1, b0, b1);
          if (h) hits.push(h);
        }
      }
    }
    for (let k = 0; k < nNearTouched; k++) nearFlags[nearTouched[k]] = 0;
    return hits;
  }

  /** Pushes a meeting pair apart along its normal, to ETA on the side it started on, by inverse masses. */
  private push(h: Hit, x1: Float64Array, w: Float64Array) {
    let g = 0, den = 0;
    for (let q = 0; q < h.k; q++) {
      const i = 3 * h.v[q];
      g += h.c[q] * (x1[i] * h.nx + x1[i + 1] * h.ny + x1[i + 2] * h.nz);
      den += h.c[q] * h.c[q] * w[h.v[q]];
    }
    // To twice the gap the look takes for meeting: to it exactly, rounding found the pair again every round.
    if (g >= 2 * ETA || den <= 0) return;
    const lam = (2 * ETA - g) / den;
    for (let q = 0; q < h.k; q++) {
      const i = 3 * h.v[q], s = lam * w[h.v[q]] * h.c[q];
      x1[i] += s * h.nx; x1[i + 1] += s * h.ny; x1[i + 2] += s * h.nz;
    }
  }
}

/** The points moved rigidly over the step: their mean move and turn about their middle (held still if any is held). */
function rigid(pts: number[], x0: Float64Array, x1: Float64Array, w: Float64Array) {
  if (pts.some((i) => !(w[i] > 0))) { for (const i of pts) for (let c = 0; c < 3; c++) x1[3 * i + c] = x0[3 * i + c]; return; }
  let M = 0;
  const c0 = [0, 0, 0], c1 = [0, 0, 0];
  for (const i of pts) { const m = 1 / w[i]; M += m; for (let c = 0; c < 3; c++) { c0[c] += m * x0[3 * i + c]; c1[c] += m * x1[3 * i + c]; } }
  for (let c = 0; c < 3; c++) { c0[c] /= M; c1[c] /= M; }
  // Angular momentum over the step, and the inertia, about the middle where it began.
  const L = [0, 0, 0], I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const i of pts) {
    const m = 1 / w[i], r = [x0[3 * i] - c0[0], x0[3 * i + 1] - c0[1], x0[3 * i + 2] - c0[2]];
    const d = [x1[3 * i] - x0[3 * i] - (c1[0] - c0[0]), x1[3 * i + 1] - x0[3 * i + 1] - (c1[1] - c0[1]), x1[3 * i + 2] - x0[3 * i + 2] - (c1[2] - c0[2])];
    L[0] += m * (r[1] * d[2] - r[2] * d[1]); L[1] += m * (r[2] * d[0] - r[0] * d[2]); L[2] += m * (r[0] * d[1] - r[1] * d[0]);
    const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[3 * a + b] += m * ((a === b ? rr : 0) - r[a] * r[b]);
  }
  // A line of points has no inertia about it: a little added, so it turns as a rod does.
  const tr = (I[0] + I[4] + I[8]) || M * 1e-6;
  for (let a = 0; a < 3; a++) I[4 * a] += 1e-6 * tr;
  const om = solve3(I, L);
  const th = Math.hypot(om[0], om[1], om[2]);
  const R = rotation(om, th);
  for (const i of pts) {
    const r = [x0[3 * i] - c0[0], x0[3 * i + 1] - c0[1], x0[3 * i + 2] - c0[2]];
    for (let a = 0; a < 3; a++) x1[3 * i + a] = c1[a] + R[3 * a] * r[0] + R[3 * a + 1] * r[1] + R[3 * a + 2] * r[2];
  }
}

function solve3(A: number[], b: number[]): number[] {
  const [a, b1, c, d, e, f, g, h, k] = A;
  const det = a * (e * k - f * h) - b1 * (d * k - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-30) return [0, 0, 0];
  const inv = [e * k - f * h, c * h - b1 * k, b1 * f - c * e, f * g - d * k, a * k - c * g, c * d - a * f, d * h - e * g, b1 * g - a * h, a * e - b1 * d];
  return [0, 1, 2].map((r) => (inv[3 * r] * b[0] + inv[3 * r + 1] * b[1] + inv[3 * r + 2] * b[2]) / det);
}

/** Rodrigues: the turn by angle `th` about `om` (|om| = th), row-major. */
function rotation(om: number[], th: number): number[] {
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const x = om[0] / th, y = om[1] / th, z = om[2] / th, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** The roots in [0, 1] of a + b t + c t^2 + d t^3, in order (by its turning points, then halving). */
function cubicRoots(a: number, b: number, c: number, d: number): number[] {
  const f = (t: number) => a + t * (b + t * (c + t * d));
  const cuts = [0, 1];
  // Turning points: b + 2c t + 3d t^2 = 0.
  const A = 3 * d, B = 2 * c, C = b;
  if (Math.abs(A) > 1e-30) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) { const s = Math.sqrt(disc); for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) if (t > 0 && t < 1) cuts.push(t); }
  } else if (Math.abs(B) > 1e-30) { const t = -C / B; if (t > 0 && t < 1) cuts.push(t); }
  cuts.sort((u, v) => u - v);
  const out: number[] = [];
  for (let k = 1; k < cuts.length; k++) {
    let lo = cuts[k - 1], hi = cuts[k], flo = f(lo);
    const fhi = f(hi);
    if (flo === 0) { out.push(lo); continue; }
    if (flo * fhi > 0) continue;
    for (let it = 0; it < 50; it++) { const m = 0.5 * (lo + hi), fm = f(m); if (fm === 0) { lo = hi = m; break; } if (flo * fm < 0) hi = m; else { lo = m; flo = fm; } }
    out.push(0.5 * (lo + hi));
  }
  if (f(1) === 0 && out[out.length - 1] !== 1) out.push(1);
  return out;
}

/** The cubic in t whose roots are when four points moving in lines lie in one plane: det[q1 - q0, q2 - q0, q3 - q0], into CO (constant term first). */
const CO = new Float64Array(4);
function coplanar(x0: Float64Array, x1: Float64Array, q0: number, q1: number, q2: number, q3: number) {
  const o = 3 * q0, i = 3 * q1, j = 3 * q2, k = 3 * q3;
  const v0x = x1[o] - x0[o], v0y = x1[o + 1] - x0[o + 1], v0z = x1[o + 2] - x0[o + 2];
  const ax = x0[i] - x0[o], ay = x0[i + 1] - x0[o + 1], az = x0[i + 2] - x0[o + 2];
  const avx = x1[i] - x0[i] - v0x, avy = x1[i + 1] - x0[i + 1] - v0y, avz = x1[i + 2] - x0[i + 2] - v0z;
  const bx = x0[j] - x0[o], by = x0[j + 1] - x0[o + 1], bz = x0[j + 2] - x0[o + 2];
  const bvx = x1[j] - x0[j] - v0x, bvy = x1[j + 1] - x0[j + 1] - v0y, bvz = x1[j + 2] - x0[j + 2] - v0z;
  const cx = x0[k] - x0[o], cy = x0[k + 1] - x0[o + 1], cz = x0[k + 2] - x0[o + 2];
  const cvx = x1[k] - x0[k] - v0x, cvy = x1[k + 1] - x0[k + 1] - v0y, cvz = x1[k + 2] - x0[k + 2] - v0z;
  // A x B, Av x Bv, and A x Bv + Av x B.
  const p0x = ay * bz - az * by, p0y = az * bx - ax * bz, p0z = ax * by - ay * bx;
  const p2x = avy * bvz - avz * bvy, p2y = avz * bvx - avx * bvz, p2z = avx * bvy - avy * bvx;
  const p1x = ay * bvz - az * bvy + avy * bz - avz * by, p1y = az * bvx - ax * bvz + avz * bx - avx * bz, p1z = ax * bvy - ay * bvx + avx * by - avy * bx;
  CO[0] = p0x * cx + p0y * cy + p0z * cz;
  CO[1] = p0x * cvx + p0y * cvy + p0z * cvz + p1x * cx + p1y * cy + p1z * cz;
  CO[2] = p1x * cvx + p1y * cvy + p1z * cvz + p2x * cx + p2y * cy + p2z * cz;
  CO[3] = p2x * cvx + p2y * cvy + p2z * cvz;
}

/**
 * Whether the four points may lie in one plane during the step (CO set): not
 * if the determinant keeps one sign further from zero at both ends than its
 * curve can bend between them (|t^2 - t| <= 1/4, |t^3 - t| <= 0.385 on [0, 1]).
 */
function mayMeet(): boolean {
  const f0 = CO[0], f1 = CO[0] + CO[1] + CO[2] + CO[3];
  if ((f0 > 0) !== (f1 > 0)) return true;
  return Math.min(Math.abs(f0), Math.abs(f1)) <= Math.abs(CO[2]) / 4 + 0.385 * Math.abs(CO[3]);
}

/** |(q1 - q0) x (q2 - q0)| at the end of the step. */
function crossLen1(x1: Float64Array, q0: number, q1: number, q2: number) {
  const o = 3 * q0, i = 3 * q1, j = 3 * q2;
  const ax = x1[i] - x1[o], ay = x1[i + 1] - x1[o + 1], az = x1[i + 2] - x1[o + 2], bx = x1[j] - x1[o], by = x1[j + 1] - x1[o + 1], bz = x1[j + 2] - x1[o + 2];
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
}

const at = (x0: Float64Array, x1: Float64Array, q: number, t: number, out: number[]) => { for (let c = 0; c < 3; c++) out[c] = x0[3 * q + c] + t * (x1[3 * q + c] - x0[3 * q + c]); };

/** How far apart the points of a pair moved over the step, at most (the gap between them can close by no more). */
function relMove(x0: Float64Array, x1: Float64Array, a: number, b: number, c: number, d: number) {
  const ka = 3 * a, kb = 3 * b, kc = 3 * c, kd = 3 * d;
  const ax = x1[ka] - x0[ka], ay = x1[ka + 1] - x0[ka + 1], az = x1[ka + 2] - x0[ka + 2];
  const bx = x1[kb] - x0[kb], by = x1[kb + 1] - x0[kb + 1], bz = x1[kb + 2] - x0[kb + 2];
  const cx = x1[kc] - x0[kc], cy = x1[kc + 1] - x0[kc + 1], cz = x1[kc + 2] - x0[kc + 2];
  const dx = x1[kd] - x0[kd], dy = x1[kd + 1] - x0[kd + 1], dz = x1[kd + 2] - x0[kd + 2];
  const lo0 = Math.min(ax, bx, cx, dx), hi0 = Math.max(ax, bx, cx, dx);
  const lo1 = Math.min(ay, by, cy, dy), hi1 = Math.max(ay, by, cy, dy);
  const lo2 = Math.min(az, bz, cz, dz), hi2 = Math.max(az, bz, cz, dz);
  return Math.hypot(hi0 - lo0, hi1 - lo1, hi2 - lo2);
}

/** Distance from point p to triangle (a, b, c), all at x (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriDist(x: Float64Array, p: number, a: number, b: number, c: number) {
  const P = 3 * p, A = 3 * a, B = 3 * b, C = 3 * c;
  const abx = x[B] - x[A], aby = x[B + 1] - x[A + 1], abz = x[B + 2] - x[A + 2], acx = x[C] - x[A], acy = x[C + 1] - x[A + 1], acz = x[C + 2] - x[A + 2];
  const apx = x[P] - x[A], apy = x[P + 1] - x[A + 1], apz = x[P + 2] - x[A + 2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  const bpx = x[P] - x[B], bpy = x[P + 1] - x[B + 1], bpz = x[P + 2] - x[B + 2], d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = x[P] - x[C], cpy = x[P + 1] - x[C + 1], cpz = x[P + 2] - x[C + 2], d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) { qx = x[A]; qy = x[A + 1]; qz = x[A + 2]; }
  else if (d3 >= 0 && d4 <= d3) { qx = x[B]; qy = x[B + 1]; qz = x[B + 2]; }
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = x[A] + v * abx; qy = x[A + 1] + v * aby; qz = x[A + 2] + v * abz; }
  else if (d6 >= 0 && d5 <= d6) { qx = x[C]; qy = x[C + 1]; qz = x[C + 2]; }
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = x[A] + w * acx; qy = x[A + 1] + w * acy; qz = x[A + 2] + w * acz; }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); qx = x[B] + w * (x[C] - x[B]); qy = x[B + 1] + w * (x[C + 1] - x[B + 1]); qz = x[B + 2] + w * (x[C + 2] - x[B + 2]); }
  else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; qx = x[A] + abx * v + acx * w; qy = x[A + 1] + aby * v + acy * w; qz = x[A + 2] + abz * v + acz * w; }
  return Math.hypot(x[P] - qx, x[P + 1] - qy, x[P + 2] - qz);
}

const sP0 = [0, 0, 0], sP1 = [0, 0, 0], sQ0 = [0, 0, 0], sQ1 = [0, 0, 0], sOut = [0, 0, 0, 0, 0];

/** Distance between segments (a0, a1) and (b0, b1) at x. */
function segDist(x: Float64Array, a0: number, a1: number, b0: number, b1: number) {
  sP0[0] = x[3 * a0]; sP0[1] = x[3 * a0 + 1]; sP0[2] = x[3 * a0 + 2];
  sP1[0] = x[3 * a1]; sP1[1] = x[3 * a1 + 1]; sP1[2] = x[3 * a1 + 2];
  sQ0[0] = x[3 * b0]; sQ0[1] = x[3 * b0 + 1]; sQ0[2] = x[3 * b0 + 2];
  sQ1[0] = x[3 * b1]; sQ1[1] = x[3 * b1 + 1]; sQ1[2] = x[3 * b1 + 2];
  return closestSegmentsInto(sP0, sP1, sQ0, sQ1, sOut) ? Math.hypot(sOut[2], sOut[3], sOut[4]) : Infinity;
}

const ptP = [0, 0, 0], ptA = [0, 0, 0], ptB = [0, 0, 0], ptC = [0, 0, 0];

/** Point p through triangle (i0, i1, i2) along the step, or ending within ETA of it: the first time it does, as a meeting. */
function pointTriangle(x0: Float64Array, x1: Float64Array, p: number, i0: number, i1: number, i2: number): Hit | null {
  // Further apart where it began than they moved apart: they cannot meet.
  if (pointTriDist(x0, p, i0, i1, i2) > relMove(x0, x1, p, i0, i1, i2) + ETA) return null;
  coplanar(x0, x1, i0, i1, i2, p);
  const meet = mayMeet();
  // Ending within ETA of its plane: the determinant is twice the area's cross times the distance.
  const near = Math.abs(CO[0] + CO[1] + CO[2] + CO[3]) <= ETA * crossLen1(x1, i0, i1, i2);
  if (!meet && !near) return null;
  const ts = meet ? cubicRoots(CO[0], CO[1], CO[2], CO[3]) : [];
  ts.push(1);
  for (let ti = 0; ti < ts.length; ti++) {
    const t = ts[ti];
    at(x0, x1, p, t, ptP); at(x0, x1, i0, t, ptA); at(x0, x1, i1, t, ptB); at(x0, x1, i2, t, ptC);
    const ux = ptB[0] - ptA[0], uy = ptB[1] - ptA[1], uz = ptB[2] - ptA[2];
    const vx = ptC[0] - ptA[0], vy = ptC[1] - ptA[1], vz = ptC[2] - ptA[2];
    const wvx = ptP[0] - ptA[0], wvy = ptP[1] - ptA[1], wvz = ptP[2] - ptA[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-14) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const dist = wvx * nx + wvy * ny + wvz * nz;
    if (Math.abs(dist) > ETA) continue;
    // Over the triangle (barycentric, a hair's tolerance).
    const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
    const d20 = wvx * ux + wvy * uy + wvz * uz, d21 = wvx * vx + wvy * vy + wvz * vz, den = d00 * d11 - d01 * d01;
    if (den <= 0) continue;
    const b1 = (d11 * d20 - d01 * d21) / den, b2 = (d00 * d21 - d01 * d20) / den, b0 = 1 - b1 - b2, tol = -1e-6;
    if (b0 < tol || b1 < tol || b2 < tol) continue;
    // The side it started on, by this normal (moving toward it, if it started on it).
    const s0 = side3(x0, p, i0, i1, i2, b0, b1, b2, nx, ny, nz);
    const sg = Math.abs(s0) > 1e-12 ? Math.sign(s0) : -Math.sign(side3(x1, p, i0, i1, i2, b0, b1, b2, nx, ny, nz) - s0) || 1;
    return { v: Int32Array.of(p, i0, i1, i2), c: Float64Array.of(1, -b0, -b1, -b2), k: 4, nx: sg * nx, ny: sg * ny, nz: sg * nz };
  }
  return null;
}

/** (p - sum b q) . n. */
function side3(x: Float64Array, p: number, q0: number, q1: number, q2: number, b0: number, b1: number, b2: number, nx: number, ny: number, nz: number) {
  return (x[3 * p] - b0 * x[3 * q0] - b1 * x[3 * q1] - b2 * x[3 * q2]) * nx
    + (x[3 * p + 1] - b0 * x[3 * q0 + 1] - b1 * x[3 * q1 + 1] - b2 * x[3 * q2 + 1]) * ny
    + (x[3 * p + 2] - b0 * x[3 * q0 + 2] - b1 * x[3 * q1 + 2] - b2 * x[3 * q2 + 2]) * nz;
}

const eeP0 = [0, 0, 0], eeP1 = [0, 0, 0], eeQ0 = [0, 0, 0], eeQ1 = [0, 0, 0], eeOut = [0, 0, 0, 0, 0];

/** Edge (a0, a1) through edge (b0, b1) along the step, or ending within ETA of it: the first time, as a meeting. */
function edgeEdge(x0: Float64Array, x1: Float64Array, a0: number, a1: number, b0: number, b1: number): Hit | null {
  if (segDist(x0, a0, a1, b0, b1) > relMove(x0, x1, a0, a1, b0, b1) + ETA) return null;
  coplanar(x0, x1, a0, a1, b0, b1);
  const meet = mayMeet();
  // Ending within ETA: the determinant is the two edges' cross times their distance apart, at most.
  if (!meet) {
    const i = 3 * a0, j = 3 * a1, k = 3 * b0, l = 3 * b1;
    const ex = x1[j] - x1[i], ey = x1[j + 1] - x1[i + 1], ez = x1[j + 2] - x1[i + 2], fx = x1[l] - x1[k], fy = x1[l + 1] - x1[k + 1], fz = x1[l + 2] - x1[k + 2];
    const near = Math.abs(CO[0] + CO[1] + CO[2] + CO[3]) <= ETA * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
    if (!near) return null;
  }
  const ts = meet ? cubicRoots(CO[0], CO[1], CO[2], CO[3]) : [];
  ts.push(1);
  for (let ti = 0; ti < ts.length; ti++) {
    const t = ts[ti];
    at(x0, x1, a0, t, eeP0); at(x0, x1, a1, t, eeP1); at(x0, x1, b0, t, eeQ0); at(x0, x1, b1, t, eeQ1);
    if (!closestSegmentsInto(eeP0, eeP1, eeQ0, eeQ1, eeOut)) continue;
    const s = eeOut[0], u = eeOut[1], dx = eeOut[2], dy = eeOut[3], dz = eeOut[4];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > ETA) continue;
    // Strictly between the ends: at an end it is a point against a triangle, found there.
    if (s <= 1e-9 || s >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) continue;
    const ex0 = eeP1[0] - eeP0[0], ex1 = eeP1[1] - eeP0[1], ex2 = eeP1[2] - eeP0[2];
    const fx0 = eeQ1[0] - eeQ0[0], fx1 = eeQ1[1] - eeQ0[1], fx2 = eeQ1[2] - eeQ0[2];
    let nx = ex1 * fx2 - ex2 * fx1, ny = ex2 * fx0 - ex0 * fx2, nz = ex0 * fx1 - ex1 * fx0;
    let nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-14) { nx = dx; ny = dy; nz = dz; nl = dist; }
    if (nl < 1e-14) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const c0 = 1 - s, c1 = s, c2 = -(1 - u), c3 = -u;
    const sideAt = (x: Float64Array) =>
      c0 * (x[3 * a0] * nx + x[3 * a0 + 1] * ny + x[3 * a0 + 2] * nz)
      + c1 * (x[3 * a1] * nx + x[3 * a1 + 1] * ny + x[3 * a1 + 2] * nz)
      + c2 * (x[3 * b0] * nx + x[3 * b0 + 1] * ny + x[3 * b0 + 2] * nz)
      + c3 * (x[3 * b1] * nx + x[3 * b1 + 1] * ny + x[3 * b1 + 2] * nz);
    const s0 = sideAt(x0);
    const sg = Math.abs(s0) > 1e-12 ? Math.sign(s0) : -Math.sign(sideAt(x1) - s0) || 1;
    return { v: Int32Array.of(a0, a1, b0, b1), c: Float64Array.of(c0, c1, c2, c3), k: 4, nx: sg * nx, ny: sg * ny, nz: sg * nz };
  }
  return null;
}

/** The nearest points of two segments into `out`: [s on the first, u on the second, and the gap from the second's to the first's]. */
function closestSegmentsInto(P0: number[], P1: number[], Q0: number[], Q1: number[], out: number[]): boolean {
  const d10 = P1[0] - P0[0], d11 = P1[1] - P0[1], d12 = P1[2] - P0[2];
  const d20 = Q1[0] - Q0[0], d21 = Q1[1] - Q0[1], d22 = Q1[2] - Q0[2];
  const r0 = P0[0] - Q0[0], r1 = P0[1] - Q0[1], r2 = P0[2] - Q0[2];
  const a = d10 * d10 + d11 * d11 + d12 * d12, e = d20 * d20 + d21 * d21 + d22 * d22, f = d20 * r0 + d21 * r1 + d22 * r2;
  if (a < 1e-20 || e < 1e-20) return false;
  const c = d10 * r0 + d11 * r1 + d12 * r2, b = d10 * d20 + d11 * d21 + d12 * d22, den = a * e - b * b;
  let s = den > 1e-20 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
  let u = (b * s + f) / e;
  if (u < 0) { u = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (u > 1) { u = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  out[0] = s;
  out[1] = u;
  out[2] = P0[0] + s * d10 - (Q0[0] + u * d20);
  out[3] = P0[1] + s * d11 - (Q0[1] + u * d21);
  out[4] = P0[2] + s * d12 - (Q0[2] + u * d22);
  return true;
}
