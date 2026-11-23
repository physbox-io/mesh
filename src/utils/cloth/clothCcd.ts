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

/** One meeting: four points, each with its coefficient (+ one side, - the other), and the normal, signed to the side it started on. */
interface Hit { v0: number; v1: number; v2: number; v3: number; c0: number; c1: number; c2: number; c3: number; nx: number; ny: number; nz: number }

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
  private zoneBuf: Int32Array;
  private inZoneBuf: Uint8Array;
  // Per point, triangle and edge: swept boxes, cell ranges, and monotonic stamps, reused.
  private pB = new Float64Array(0); private moved = new Uint8Array(0);
  private tB = new Float64Array(0); private tRange = new Int32Array(0); private tStamp = new Int32Array(0); private tStampGen = 0;
  private eB = new Float64Array(0); private eRange = new Int32Array(0); private eStamp = new Int32Array(0); private eStampGen = 0;

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
    this.zoneBuf = new Int32Array(n);
    this.inZoneBuf = new Uint8Array(n);
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
    const was = this.wasBuf, changed = this.changedBuf, n = this.n;
    was.set(x1);
    const redetect = () => {
      changed.fill(0);
      for (let i = 0; i < n; i++) { const k = 3 * i; if (x1[k] !== was[k] || x1[k + 1] !== was[k + 1] || x1[k + 2] !== was[k + 2]) changed[i] = 1; }
      for (let hi = 0; hi < hits.length; hi++) { const h = hits[hi]; changed[h.v0] = 1; changed[h.v1] = 1; changed[h.v2] = 1; changed[h.v3] = 1; }
      was.set(x1);
      return this.detect(x0, x1, changed);
    };
    for (let round = 0; round < PUSH_ROUNDS && hits.length; round++) {
      for (let hi = 0; hi < hits.length; hi++) this.push(hits[hi], x1, w);
      stats.pushes++;
      hits = redetect();
    }
    if (!hits.length) return stats;
    // Impact zones: what still meets, joined, moved rigidly.
    const zone = this.zoneBuf, inZone = this.inZoneBuf;
    for (let i = 0; i < n; i++) { zone[i] = i; inZone[i] = 0; }
    const find = (i: number): number => { while (zone[i] !== i) { zone[i] = zone[zone[i]]; i = zone[i]; } return i; };
    const members = new Map<number, number[]>();
    for (let round = 0; round < ZONE_ROUNDS && hits.length; round++) {
      for (let hi = 0; hi < hits.length; hi++) {
        const h = hits[hi];
        inZone[h.v0] = 1; inZone[h.v1] = 1; inZone[h.v2] = 1; inZone[h.v3] = 1;
        const r0 = find(h.v0);
        const r1 = find(h.v1); if (r0 !== r1) zone[r1] = r0;
        const r2 = find(h.v2); if (r0 !== r2) zone[r2] = r0;
        const r3 = find(h.v3); if (r0 !== r3) zone[r3] = r0;
      }
      members.clear();
      let zonePoints = 0;
      for (let i = 0; i < n; i++) if (inZone[i]) {
        const r = find(i);
        let list = members.get(r);
        if (!list) { list = []; members.set(r, list); }
        list.push(i);
        zonePoints++;
      }
      for (const pts of members.values()) rigid(pts, x0, x1, w);
      stats.zones = members.size; stats.zonePoints = zonePoints;
      hits = redetect();
    }
    if (hits.length) {
      // The last resort: everything that met, and everything that moved with it, where it began.
      for (let i = 0; i < n; i++) if (inZone[i]) { const k = 3 * i; x1[k] = x0[k]; x1[k + 1] = x0[k + 1]; x1[k + 2] = x0[k + 2]; }
      for (let hi = 0; hi < hits.length; hi++) {
        const h = hits[hi];
        let k = 3 * h.v0; x1[k] = x0[k]; x1[k + 1] = x0[k + 1]; x1[k + 2] = x0[k + 2];
        k = 3 * h.v1; x1[k] = x0[k]; x1[k + 1] = x0[k + 1]; x1[k + 2] = x0[k + 2];
        k = 3 * h.v2; x1[k] = x0[k]; x1[k + 1] = x0[k + 1]; x1[k + 2] = x0[k + 2];
        k = 3 * h.v3; x1[k] = x0[k]; x1[k + 1] = x0[k + 1]; x1[k + 2] = x0[k + 2];
      }
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
    let r0 = Infinity, r1 = Infinity, r2 = Infinity, r3 = -Infinity, r4 = -Infinity, r5 = -Infinity, nMoved = 0;
    for (let i = 0; i < n; i++) {
      const k = 3 * i, o = 6 * i, a0 = x0[k], a1 = x0[k + 1], a2 = x0[k + 2], b0 = x1[k], b1 = x1[k + 1], b2 = x1[k + 2];
      const lo0 = a0 < b0 ? a0 : b0, lo1 = a1 < b1 ? a1 : b1, lo2 = a2 < b2 ? a2 : b2;
      const hi0 = a0 < b0 ? b0 : a0, hi1 = a1 < b1 ? b1 : a1, hi2 = a2 < b2 ? b2 : a2;
      pB[o] = lo0 - ETA; pB[o + 1] = lo1 - ETA; pB[o + 2] = lo2 - ETA; pB[o + 3] = hi0 + ETA; pB[o + 4] = hi1 + ETA; pB[o + 5] = hi2 + ETA;
      // What may meet: what moved over the step; on a second look, what the response moved.
      const mv = only ? only[i] === 1 : a0 !== b0 || a1 !== b1 || a2 !== b2;
      moved[i] = mv ? 1 : 0;
      if (mv) { nMoved++; if (lo0 < r0) r0 = lo0; if (lo1 < r1) r1 = lo1; if (lo2 < r2) r2 = lo2; if (hi0 > r3) r3 = hi0; if (hi1 > r4) r4 = hi1; if (hi2 > r5) r5 = hi2; }
    }
    if (nMoved === 0) return hits;
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
    const invCoarse = 1 / reach;
    const cell = Math.max(CELL, maxEdge / 5), invCell = 1 / cell;
    // Widened by a triangle: a point that did not move can be met by a
    // triangle that did, beside one of its corners that did not (the box
    // round only what moved left that point out, and a shirt's collar went
    // through a jacket's).
    r0 -= reach; r1 -= reach; r2 -= reach; r3 += reach; r4 += reach; r5 += reach;
    let useNear = false;
    let nNearTouched = 0;
    const nearFlags = this.nearFlags, nearTouched = this.nearTouched;
    if (nMoved < n / 4) {
      useNear = true;
      for (let i = 0; i < n; i++) {
        if (!moved[i]) continue;
        const o = 6 * i;
        const ax = Math.floor(pB[o] * invCoarse) - 1, bx = Math.floor(pB[o + 3] * invCoarse) + 1;
        const ay = Math.floor(pB[o + 1] * invCoarse) - 1, by = Math.floor(pB[o + 4] * invCoarse) + 1;
        const az = Math.floor(pB[o + 2] * invCoarse) - 1, bz = Math.floor(pB[o + 5] * invCoarse) + 1;
        for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) {
          const hb = hash(a, b, c, mask);
          if (!nearFlags[hb]) { nearFlags[hb] = 1; nearTouched[nNearTouched++] = hb; }
        }
      }
    }
    if (this.tB.length < 6 * nt) { this.tB = new Float64Array(6 * nt); this.tRange = new Int32Array(6 * nt); this.tStamp = new Int32Array(nt); this.tStampGen = 0; }
    if (this.eB.length < 6 * ne) { this.eB = new Float64Array(6 * ne); this.eRange = new Int32Array(6 * ne); this.eStamp = new Int32Array(ne); this.eStampGen = 0; }
    const tB = this.tB, tRange = this.tRange, eB = this.eB, eRange = this.eRange;
    const start = this.start, cur = this.cur;

    // Fill triangle spatial hash (compute cell ranges once).
    start.fill(0);
    let totalTri = 0;
    for (let t = 0; t < nt; t++) {
      const o = 6 * t, t3 = 3 * t;
      const p0 = 6 * T[t3], p1 = 6 * T[t3 + 1], p2 = 6 * T[t3 + 2];
      let l0 = pB[p0], l1 = pB[p0 + 1], l2 = pB[p0 + 2], h0 = pB[p0 + 3], h1 = pB[p0 + 4], h2 = pB[p0 + 5];
      if (pB[p1] < l0) l0 = pB[p1]; if (pB[p1 + 1] < l1) l1 = pB[p1 + 1]; if (pB[p1 + 2] < l2) l2 = pB[p1 + 2];
      if (pB[p1 + 3] > h0) h0 = pB[p1 + 3]; if (pB[p1 + 4] > h1) h1 = pB[p1 + 4]; if (pB[p1 + 5] > h2) h2 = pB[p1 + 5];
      if (pB[p2] < l0) l0 = pB[p2]; if (pB[p2 + 1] < l1) l1 = pB[p2 + 1]; if (pB[p2 + 2] < l2) l2 = pB[p2 + 2];
      if (pB[p2 + 3] > h0) h0 = pB[p2 + 3]; if (pB[p2 + 4] > h1) h1 = pB[p2 + 4]; if (pB[p2 + 5] > h2) h2 = pB[p2 + 5];
      if (h0 < r0 || h1 < r1 || h2 < r2 || l0 > r3 || l1 > r4 || l2 > r5) { tB[o] = Infinity; continue; }
      if (useNear
        && nearFlags[hash(Math.floor(pB[p0] * invCoarse), Math.floor(pB[p0 + 1] * invCoarse), Math.floor(pB[p0 + 2] * invCoarse), mask)] !== 1
        && nearFlags[hash(Math.floor(pB[p1] * invCoarse), Math.floor(pB[p1 + 1] * invCoarse), Math.floor(pB[p1 + 2] * invCoarse), mask)] !== 1
        && nearFlags[hash(Math.floor(pB[p2] * invCoarse), Math.floor(pB[p2 + 1] * invCoarse), Math.floor(pB[p2 + 2] * invCoarse), mask)] !== 1) {
        tB[o] = Infinity; continue;
      }
      tB[o] = l0; tB[o + 1] = l1; tB[o + 2] = l2; tB[o + 3] = h0; tB[o + 4] = h1; tB[o + 5] = h2;
      const ax = Math.floor(l0 * invCell), bx = Math.floor(h0 * invCell);
      const ay = Math.floor(l1 * invCell), by = Math.floor(h1 * invCell);
      const az = Math.floor(l2 * invCell), bz = Math.floor(h2 * invCell);
      tRange[o] = ax; tRange[o + 1] = ay; tRange[o + 2] = az; tRange[o + 3] = bx; tRange[o + 4] = by; tRange[o + 5] = bz;
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) { start[hash(a, b, c, mask) + 1]++; totalTri++; }
    }
    for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
    if (this.entries.length < totalTri) this.entries = new Int32Array(Math.ceil(totalTri * 1.3));
    const triEntries = this.entries;
    cur.set(start.subarray(0, buckets));
    for (let t = 0; t < nt; t++) {
      const o = 6 * t;
      if (tB[o] === Infinity) continue;
      const ax = tRange[o], ay = tRange[o + 1], az = tRange[o + 2], bx = tRange[o + 3], by = tRange[o + 4], bz = tRange[o + 5];
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) triEntries[cur[hash(a, b, c, mask)]++] = t;
    }

    // Point against triangle.
    const stamp = this.tStamp;
    let tGen = this.tStampGen;
    const onCloth = this.onCloth, root = this.root, anyTangled = this.anyTangled;
    const tangledPoint = this.tangledPoint, tangledTri = this.tangledTri;
    const hasFree = !!this.freePairs;
    for (let p = 0; p < n; p++) {
      if (!onCloth[p]) continue;
      const o = 6 * p;
      const pl0 = pB[o], pl1 = pB[o + 1], pl2 = pB[o + 2], ph0 = pB[o + 3], ph1 = pB[o + 4], ph2 = pB[o + 5];
      if (ph0 < r0 || ph1 < r1 || ph2 < r2 || pl0 > r3 || pl1 > r4 || pl2 > r5) continue;
      if (useNear && nearFlags[hash(Math.floor(pl0 * invCoarse), Math.floor(pl1 * invCoarse), Math.floor(pl2 * invCoarse), mask)] !== 1) continue;
      if (++tGen >= 0x7fffffff) { stamp.fill(0); tGen = 1; }
      const rp = root[p], mvP = moved[p];
      const ax = Math.floor(pl0 * invCell), bx = Math.floor(ph0 * invCell);
      const ay = Math.floor(pl1 * invCell), by = Math.floor(ph1 * invCell);
      const az = Math.floor(pl2 * invCell), bz = Math.floor(ph2 * invCell);
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) {
        const hb = hash(a, b, c, mask);
        for (let e = start[hb], eEnd = start[hb + 1]; e < eEnd; e++) {
          const t = triEntries[e];
          if (stamp[t] === tGen) continue;
          stamp[t] = tGen;
          const t3 = 3 * t, i0 = T[t3], i1 = T[t3 + 1], i2 = T[t3 + 2];
          if (!mvP && !moved[i0] && !moved[i1] && !moved[i2]) continue;
          const q = 6 * t;
          if (ph0 < tB[q] || ph1 < tB[q + 1] || ph2 < tB[q + 2] || pl0 > tB[q + 3] || pl1 > tB[q + 4] || pl2 > tB[q + 5]) continue;
          if (rp === root[i0] || rp === root[i1] || rp === root[i2]) continue;
          if (hasFree && this.freeOf(p, i0)) continue;
          if (anyTangled && tangledPoint[p] && tangledTri[t] && pointTriDist(x0, p, i0, i1, i2) < AT_CROSSING) continue;
          const h = pointTriangle(x0, x1, p, i0, i1, i2);
          if (h) hits.push(h);
        }
      }
    }
    this.tStampGen = tGen;

    // Fill edge spatial hash (compute cell ranges once).
    const eStart = this.eStart;
    eStart.fill(0);
    let totalEdge = 0;
    for (let e = 0; e < ne; e++) {
      const o = 6 * e, p0 = 6 * E[2 * e], p1 = 6 * E[2 * e + 1];
      const l0 = pB[p0] < pB[p1] ? pB[p0] : pB[p1], l1 = pB[p0 + 1] < pB[p1 + 1] ? pB[p0 + 1] : pB[p1 + 1], l2 = pB[p0 + 2] < pB[p1 + 2] ? pB[p0 + 2] : pB[p1 + 2];
      const h0 = pB[p0 + 3] > pB[p1 + 3] ? pB[p0 + 3] : pB[p1 + 3], h1 = pB[p0 + 4] > pB[p1 + 4] ? pB[p0 + 4] : pB[p1 + 4], h2 = pB[p0 + 5] > pB[p1 + 5] ? pB[p0 + 5] : pB[p1 + 5];
      if (h0 < r0 || h1 < r1 || h2 < r2 || l0 > r3 || l1 > r4 || l2 > r5) { eB[o] = Infinity; continue; }
      if (useNear
        && nearFlags[hash(Math.floor(pB[p0] * invCoarse), Math.floor(pB[p0 + 1] * invCoarse), Math.floor(pB[p0 + 2] * invCoarse), mask)] !== 1
        && nearFlags[hash(Math.floor(pB[p1] * invCoarse), Math.floor(pB[p1 + 1] * invCoarse), Math.floor(pB[p1 + 2] * invCoarse), mask)] !== 1) {
        eB[o] = Infinity; continue;
      }
      eB[o] = l0; eB[o + 1] = l1; eB[o + 2] = l2; eB[o + 3] = h0; eB[o + 4] = h1; eB[o + 5] = h2;
      const ax = Math.floor(l0 * invCell), bx = Math.floor(h0 * invCell);
      const ay = Math.floor(l1 * invCell), by = Math.floor(h1 * invCell);
      const az = Math.floor(l2 * invCell), bz = Math.floor(h2 * invCell);
      eRange[o] = ax; eRange[o + 1] = ay; eRange[o + 2] = az; eRange[o + 3] = bx; eRange[o + 4] = by; eRange[o + 5] = bz;
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) { eStart[hash(a, b, c, mask) + 1]++; totalEdge++; }
    }
    for (let b = 0; b < buckets; b++) eStart[b + 1] += eStart[b];
    if (this.eEntries.length < totalEdge) this.eEntries = new Int32Array(Math.ceil(totalEdge * 1.3));
    const edgeEntries = this.eEntries;
    cur.set(eStart.subarray(0, buckets));
    for (let e = 0; e < ne; e++) {
      const o = 6 * e;
      if (eB[o] === Infinity) continue;
      const ax = eRange[o], ay = eRange[o + 1], az = eRange[o + 2], bx = eRange[o + 3], by = eRange[o + 4], bz = eRange[o + 5];
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) edgeEntries[cur[hash(a, b, c, mask)]++] = e;
    }

    // Edge against edge.
    const eStamp = this.eStamp;
    let eGen = this.eStampGen;
    for (let e = 0; e < ne; e++) {
      const o = 6 * e;
      if (eB[o] === Infinity) continue;
      if (++eGen >= 0x7fffffff) { eStamp.fill(0); eGen = 1; }
      const a0 = E[2 * e], a1 = E[2 * e + 1], ra0 = root[a0], ra1 = root[a1];
      const mvA = moved[a0] || moved[a1];
      const el0 = eB[o], el1 = eB[o + 1], el2 = eB[o + 2], eh0 = eB[o + 3], eh1 = eB[o + 4], eh2 = eB[o + 5];
      const ax = eRange[o], ay = eRange[o + 1], az = eRange[o + 2], bx = eRange[o + 3], by = eRange[o + 4], bz = eRange[o + 5];
      for (let a = ax; a <= bx; a++) for (let b = ay; b <= by; b++) for (let c = az; c <= bz; c++) {
        const hb = hash(a, b, c, mask);
        for (let qq = eStart[hb], qEnd = eStart[hb + 1]; qq < qEnd; qq++) {
          const f = edgeEntries[qq];
          if (f <= e || eStamp[f] === eGen) continue;
          eStamp[f] = eGen;
          const b0 = E[2 * f], b1 = E[2 * f + 1];
          if (!mvA && !moved[b0] && !moved[b1]) continue;
          const q = 6 * f;
          if (eh0 < eB[q] || eh1 < eB[q + 1] || eh2 < eB[q + 2] || el0 > eB[q + 3] || el1 > eB[q + 4] || el2 > eB[q + 5]) continue;
          const rb0 = root[b0], rb1 = root[b1];
          if (ra0 === rb0 || ra0 === rb1 || ra1 === rb0 || ra1 === rb1) continue;
          if (hasFree && this.freeOf(a0, b0)) continue;
          if (anyTangled && (tangledPoint[a0] || tangledPoint[a1]) && (tangledPoint[b0] || tangledPoint[b1]) && segDist(x0, a0, a1, b0, b1) < AT_CROSSING) continue;
          const h = edgeEdge(x0, x1, a0, a1, b0, b1);
          if (h) hits.push(h);
        }
      }
    }
    this.eStampGen = eGen;
    for (let k = 0; k < nNearTouched; k++) nearFlags[nearTouched[k]] = 0;
    return hits;
  }

  /** Pushes a meeting pair apart along its normal, to ETA on the side it started on, by inverse masses. */
  private push(h: Hit, x1: Float64Array, w: Float64Array) {
    const i0 = 3 * h.v0, i1 = 3 * h.v1, i2 = 3 * h.v2, i3 = 3 * h.v3;
    const nx = h.nx, ny = h.ny, nz = h.nz;
    const g = h.c0 * (x1[i0] * nx + x1[i0 + 1] * ny + x1[i0 + 2] * nz)
      + h.c1 * (x1[i1] * nx + x1[i1 + 1] * ny + x1[i1 + 2] * nz)
      + h.c2 * (x1[i2] * nx + x1[i2 + 1] * ny + x1[i2 + 2] * nz)
      + h.c3 * (x1[i3] * nx + x1[i3 + 1] * ny + x1[i3 + 2] * nz);
    const w0 = w[h.v0], w1 = w[h.v1], w2 = w[h.v2], w3 = w[h.v3];
    const den = h.c0 * h.c0 * w0 + h.c1 * h.c1 * w1 + h.c2 * h.c2 * w2 + h.c3 * h.c3 * w3;
    // To twice the gap the look takes for meeting: to it exactly, rounding found the pair again every round.
    if (g >= 2 * ETA || den <= 0) return;
    const lam = (2 * ETA - g) / den;
    const s0 = lam * w0 * h.c0, s1 = lam * w1 * h.c1, s2 = lam * w2 * h.c2, s3 = lam * w3 * h.c3;
    x1[i0] += s0 * nx; x1[i0 + 1] += s0 * ny; x1[i0 + 2] += s0 * nz;
    x1[i1] += s1 * nx; x1[i1 + 1] += s1 * ny; x1[i1 + 2] += s1 * nz;
    x1[i2] += s2 * nx; x1[i2 + 1] += s2 * ny; x1[i2 + 2] += s2 * nz;
    x1[i3] += s3 * nx; x1[i3 + 1] += s3 * ny; x1[i3 + 2] += s3 * nz;
  }
}

const RIGID_I = new Float64Array(9);
const RIGID_OM = new Float64Array(3);
const RIGID_R = new Float64Array(9);

/** The points moved rigidly over the step: their mean move and turn about their middle (held still if any is held). */
function rigid(pts: number[], x0: Float64Array, x1: Float64Array, w: Float64Array) {
  for (let pi = 0; pi < pts.length; pi++) {
    if (!(w[pts[pi]] > 0)) {
      for (let q = 0; q < pts.length; q++) { const k = 3 * pts[q]; x1[k] = x0[k]; x1[k + 1] = x0[k + 1]; x1[k + 2] = x0[k + 2]; }
      return;
    }
  }
  let M = 0, c0x = 0, c0y = 0, c0z = 0, c1x = 0, c1y = 0, c1z = 0;
  for (let pi = 0; pi < pts.length; pi++) {
    const i = pts[pi], k = 3 * i, m = 1 / w[i];
    M += m;
    c0x += m * x0[k]; c0y += m * x0[k + 1]; c0z += m * x0[k + 2];
    c1x += m * x1[k]; c1y += m * x1[k + 1]; c1z += m * x1[k + 2];
  }
  const invM = 1 / M;
  c0x *= invM; c0y *= invM; c0z *= invM; c1x *= invM; c1y *= invM; c1z *= invM;
  const dcx = c1x - c0x, dcy = c1y - c0y, dcz = c1z - c0z;
  // Angular momentum over the step, and the inertia, about the middle where it began.
  let lx = 0, ly = 0, lz = 0;
  const I = RIGID_I;
  I.fill(0);
  for (let pi = 0; pi < pts.length; pi++) {
    const i = pts[pi], k = 3 * i, m = 1 / w[i];
    const rx = x0[k] - c0x, ry = x0[k + 1] - c0y, rz = x0[k + 2] - c0z;
    const dx = x1[k] - x0[k] - dcx, dy = x1[k + 1] - x0[k + 1] - dcy, dz = x1[k + 2] - x0[k + 2] - dcz;
    lx += m * (ry * dz - rz * dy); ly += m * (rz * dx - rx * dz); lz += m * (rx * dy - ry * dx);
    const rr = rx * rx + ry * ry + rz * rz;
    I[0] += m * (rr - rx * rx); I[1] -= m * rx * ry; I[2] -= m * rx * rz;
    I[4] += m * (rr - ry * ry); I[5] -= m * ry * rz; I[8] += m * (rr - rz * rz);
  }
  I[3] = I[1]; I[6] = I[2]; I[7] = I[5];
  // A line of points has no inertia about it: a little added, so it turns as a rod does.
  const tr = (I[0] + I[4] + I[8]) || M * 1e-6;
  const reg = 1e-6 * tr;
  I[0] += reg; I[4] += reg; I[8] += reg;
  solve3Into(I, lx, ly, lz, RIGID_OM);
  const th = Math.sqrt(RIGID_OM[0] * RIGID_OM[0] + RIGID_OM[1] * RIGID_OM[1] + RIGID_OM[2] * RIGID_OM[2]);
  rotationInto(RIGID_OM, th, RIGID_R);
  const R = RIGID_R;
  for (let pi = 0; pi < pts.length; pi++) {
    const k = 3 * pts[pi];
    const rx = x0[k] - c0x, ry = x0[k + 1] - c0y, rz = x0[k + 2] - c0z;
    x1[k] = c1x + R[0] * rx + R[1] * ry + R[2] * rz;
    x1[k + 1] = c1y + R[3] * rx + R[4] * ry + R[5] * rz;
    x1[k + 2] = c1z + R[6] * rx + R[7] * ry + R[8] * rz;
  }
}

function solve3Into(A: Float64Array, b0: number, b1v: number, b2: number, out: Float64Array) {
  const a = A[0], b1 = A[1], c = A[2], d = A[3], e = A[4], f = A[5], g = A[6], h = A[7], k = A[8];
  const m0 = e * k - f * h, m1 = c * h - b1 * k, m2 = b1 * f - c * e;
  const m3 = f * g - d * k, m4 = a * k - c * g, m5 = c * d - a * f;
  const m6 = d * h - e * g, m7 = b1 * g - a * h, m8 = a * e - b1 * d;
  const det = a * m0 + b1 * m3 + c * m6;
  if (Math.abs(det) < 1e-30) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
  const inv = 1 / det;
  out[0] = (m0 * b0 + m1 * b1v + m2 * b2) * inv;
  out[1] = (m3 * b0 + m4 * b1v + m5 * b2) * inv;
  out[2] = (m6 * b0 + m7 * b1v + m8 * b2) * inv;
}

/** Rodrigues: the turn by angle `th` about `om` (|om| = th), row-major, into R. */
function rotationInto(om: Float64Array, th: number, R: Float64Array) {
  if (th < 1e-12) { R[0] = 1; R[1] = 0; R[2] = 0; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = 0; R[7] = 0; R[8] = 1; return; }
  const inv = 1 / th, x = om[0] * inv, y = om[1] * inv, z = om[2] * inv, c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  R[0] = c + x * x * C; R[1] = x * y * C - z * s; R[2] = x * z * C + y * s;
  R[3] = y * x * C + z * s; R[4] = c + y * y * C; R[5] = y * z * C - x * s;
  R[6] = z * x * C - y * s; R[7] = z * y * C + x * s; R[8] = c + z * z * C;
}

const ROOT_CUTS = new Float64Array(4);
const ROOT_TS = new Float64Array(5);

/** Zero-allocation roots in [0, 1] of a + b t + c t^2 + d t^3, in order, written into `out`; returns count. */
function cubicRootsInto(a: number, b: number, c: number, d: number, out: Float64Array): number {
  const cuts = ROOT_CUTS;
  let nc = 2;
  cuts[0] = 0; cuts[1] = 1;
  // Turning points: b + 2c t + 3d t^2 = 0.
  const A = 3 * d, B = 2 * c, C = b;
  if (Math.abs(A) > 1e-30) {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc), inv2A = 0.5 / A;
      const t1 = (-B - s) * inv2A, t2 = (-B + s) * inv2A;
      if (t1 > 0 && t1 < 1) cuts[nc++] = t1;
      if (t2 > 0 && t2 < 1) cuts[nc++] = t2;
    }
  } else if (Math.abs(B) > 1e-30) {
    const t = -C / B;
    if (t > 0 && t < 1) cuts[nc++] = t;
  }
  // Inline insertion sort on 2..4 elements.
  for (let i = 1; i < nc; i++) {
    const v = cuts[i];
    let j = i - 1;
    while (j >= 0 && cuts[j] > v) { cuts[j + 1] = cuts[j]; j--; }
    cuts[j + 1] = v;
  }
  let nOut = 0;
  for (let k = 1; k < nc; k++) {
    let lo = cuts[k - 1], hi = cuts[k];
    let flo = a + lo * (b + lo * (c + lo * d));
    const fhi = a + hi * (b + hi * (c + hi * d));
    if (flo === 0) { out[nOut++] = lo; continue; }
    if (flo * fhi > 0) continue;
    for (let it = 0; it < 50; it++) {
      const m = 0.5 * (lo + hi), fm = a + m * (b + m * (c + m * d));
      if (fm === 0) { lo = hi = m; break; }
      if (flo * fm < 0) hi = m; else { lo = m; flo = fm; }
    }
    out[nOut++] = 0.5 * (lo + hi);
  }
  if (a + b + c + d === 0 && (nOut === 0 || out[nOut - 1] !== 1)) out[nOut++] = 1;
  return nOut;
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
  return Math.min(Math.abs(f0), Math.abs(f1)) <= Math.abs(CO[2]) * 0.25 + 0.385 * Math.abs(CO[3]);
}

/** |(q1 - q0) x (q2 - q0)| at the end of the step. */
function crossLen1(x1: Float64Array, q0: number, q1: number, q2: number) {
  const o = 3 * q0, i = 3 * q1, j = 3 * q2;
  const ax = x1[i] - x1[o], ay = x1[i + 1] - x1[o + 1], az = x1[i + 2] - x1[o + 2], bx = x1[j] - x1[o], by = x1[j + 1] - x1[o + 1], bz = x1[j + 2] - x1[o + 2];
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

const at = (x0: Float64Array, x1: Float64Array, q: number, t: number, out: number[]) => {
  const k = 3 * q;
  out[0] = x0[k] + t * (x1[k] - x0[k]);
  out[1] = x0[k + 1] + t * (x1[k + 1] - x0[k + 1]);
  out[2] = x0[k + 2] + t * (x1[k + 2] - x0[k + 2]);
};

/** How far apart the points of a pair moved over the step, at most (the gap between them can close by no more). */
function relMove(x0: Float64Array, x1: Float64Array, a: number, b: number, c: number, d: number) {
  const ka = 3 * a, kb = 3 * b, kc = 3 * c, kd = 3 * d;
  const ax = x1[ka] - x0[ka], ay = x1[ka + 1] - x0[ka + 1], az = x1[ka + 2] - x0[ka + 2];
  const bx = x1[kb] - x0[kb], by = x1[kb + 1] - x0[kb + 1], bz = x1[kb + 2] - x0[kb + 2];
  const cx = x1[kc] - x0[kc], cy = x1[kc + 1] - x0[kc + 1], cz = x1[kc + 2] - x0[kc + 2];
  const dx = x1[kd] - x0[kd], dy = x1[kd + 1] - x0[kd + 1], dz = x1[kd + 2] - x0[kd + 2];
  const sx = Math.max(ax, bx, cx, dx) - Math.min(ax, bx, cx, dx);
  const sy = Math.max(ay, by, cy, dy) - Math.min(ay, by, cy, dy);
  const sz = Math.max(az, bz, cz, dz) - Math.min(az, bz, cz, dz);
  return Math.sqrt(sx * sx + sy * sy + sz * sz);
}

/** Distance from point p to triangle (a, b, c), all at x (Ericson, Real-Time Collision Detection 5.1.5, lazy regions). */
function pointTriDist(x: Float64Array, p: number, a: number, b: number, c: number) {
  const P = 3 * p, A = 3 * a, B = 3 * b, C = 3 * c;
  const px = x[P], py = x[P + 1], pz = x[P + 2];
  const ax = x[A], ay = x[A + 1], az = x[A + 2];
  const abx = x[B] - ax, aby = x[B + 1] - ay, abz = x[B + 2] - az;
  const acx = x[C] - ax, acy = x[C + 1] - ay, acz = x[C + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.sqrt(apx * apx + apy * apy + apz * apz);
  const bpx = px - x[B], bpy = py - x[B + 1], bpz = pz - x[B + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.sqrt(bpx * bpx + bpy * bpy + bpz * bpz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3), dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const cpx = px - x[C], cpy = py - x[C + 1], cpz = pz - x[C + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.sqrt(cpx * cpx + cpy * cpy + cpz * cpz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6), dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const dx = bpx - w * (x[C] - x[B]), dy = bpy - w * (x[C + 1] - x[B + 1]), dz = bpz - w * (x[C + 2] - x[B + 2]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  const dx = apx - abx * v - acx * w, dy = apy - aby * v - acy * w, dz = apz - abz * v - acz * w;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const sP0 = [0, 0, 0], sP1 = [0, 0, 0], sQ0 = [0, 0, 0], sQ1 = [0, 0, 0], sOut = [0, 0, 0, 0, 0];

/** Distance between segments (a0, a1) and (b0, b1) at x. */
function segDist(x: Float64Array, a0: number, a1: number, b0: number, b1: number) {
  sP0[0] = x[3 * a0]; sP0[1] = x[3 * a0 + 1]; sP0[2] = x[3 * a0 + 2];
  sP1[0] = x[3 * a1]; sP1[1] = x[3 * a1 + 1]; sP1[2] = x[3 * a1 + 2];
  sQ0[0] = x[3 * b0]; sQ0[1] = x[3 * b0 + 1]; sQ0[2] = x[3 * b0 + 2];
  sQ1[0] = x[3 * b1]; sQ1[1] = x[3 * b1 + 1]; sQ1[2] = x[3 * b1 + 2];
  return closestSegmentsInto(sP0, sP1, sQ0, sQ1, sOut) ? Math.sqrt(sOut[2] * sOut[2] + sOut[3] * sOut[3] + sOut[4] * sOut[4]) : Infinity;
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
  const nRoots = meet ? cubicRootsInto(CO[0], CO[1], CO[2], CO[3], ROOT_TS) : 0;
  ROOT_TS[nRoots] = 1;
  const nT = nRoots + 1;
  for (let ti = 0; ti < nT; ti++) {
    const t = ROOT_TS[ti];
    at(x0, x1, p, t, ptP); at(x0, x1, i0, t, ptA); at(x0, x1, i1, t, ptB); at(x0, x1, i2, t, ptC);
    const ux = ptB[0] - ptA[0], uy = ptB[1] - ptA[1], uz = ptB[2] - ptA[2];
    const vx = ptC[0] - ptA[0], vy = ptC[1] - ptA[1], vz = ptC[2] - ptA[2];
    const wvx = ptP[0] - ptA[0], wvy = ptP[1] - ptA[1], wvz = ptP[2] - ptA[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
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
    return { v0: p, v1: i0, v2: i1, v3: i2, c0: 1, c1: -b0, c2: -b1, c3: -b2, nx: sg * nx, ny: sg * ny, nz: sg * nz };
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
    const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
    const near = Math.abs(CO[0] + CO[1] + CO[2] + CO[3]) <= ETA * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (!near) return null;
  }
  const nRoots = meet ? cubicRootsInto(CO[0], CO[1], CO[2], CO[3], ROOT_TS) : 0;
  ROOT_TS[nRoots] = 1;
  const nT = nRoots + 1;
  for (let ti = 0; ti < nT; ti++) {
    const t = ROOT_TS[ti];
    at(x0, x1, a0, t, eeP0); at(x0, x1, a1, t, eeP1); at(x0, x1, b0, t, eeQ0); at(x0, x1, b1, t, eeQ1);
    if (!closestSegmentsInto(eeP0, eeP1, eeQ0, eeQ1, eeOut)) continue;
    const s = eeOut[0], u = eeOut[1], dx = eeOut[2], dy = eeOut[3], dz = eeOut[4];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > ETA) continue;
    // Strictly between the ends: at an end it is a point against a triangle, found there.
    if (s <= 1e-9 || s >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) continue;
    const ex0 = eeP1[0] - eeP0[0], ex1 = eeP1[1] - eeP0[1], ex2 = eeP1[2] - eeP0[2];
    const fx0 = eeQ1[0] - eeQ0[0], fx1 = eeQ1[1] - eeQ0[1], fx2 = eeQ1[2] - eeQ0[2];
    let nx = ex1 * fx2 - ex2 * fx1, ny = ex2 * fx0 - ex0 * fx2, nz = ex0 * fx1 - ex1 * fx0;
    let nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-14) { nx = dx; ny = dy; nz = dz; nl = dist; }
    if (nl < 1e-14) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const c0 = 1 - s, c1 = s, c2 = -(1 - u), c3 = -u;
    const ka0 = 3 * a0, ka1 = 3 * a1, kb0 = 3 * b0, kb1 = 3 * b1;
    const s0 = c0 * (x0[ka0] * nx + x0[ka0 + 1] * ny + x0[ka0 + 2] * nz)
      + c1 * (x0[ka1] * nx + x0[ka1 + 1] * ny + x0[ka1 + 2] * nz)
      + c2 * (x0[kb0] * nx + x0[kb0 + 1] * ny + x0[kb0 + 2] * nz)
      + c3 * (x0[kb1] * nx + x0[kb1 + 1] * ny + x0[kb1 + 2] * nz);
    let sg: number;
    if (Math.abs(s0) > 1e-12) {
      sg = s0 > 0 ? 1 : -1;
    } else {
      const s1 = c0 * (x1[ka0] * nx + x1[ka0 + 1] * ny + x1[ka0 + 2] * nz)
        + c1 * (x1[ka1] * nx + x1[ka1 + 1] * ny + x1[ka1 + 2] * nz)
        + c2 * (x1[kb0] * nx + x1[kb0 + 1] * ny + x1[kb0 + 2] * nz)
        + c3 * (x1[kb1] * nx + x1[kb1 + 1] * ny + x1[kb1 + 2] * nz);
      sg = -Math.sign(s1 - s0) || 1;
    }
    return { v0: a0, v1: a1, v2: b0, v3: b1, c0, c1, c2, c3, nx: sg * nx, ny: sg * ny, nz: sg * nz };
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
