/**
 * Cloth, simulated by extended position-based dynamics (XPBD): particles
 * moved by gravity and the wind, then pulled back to the lengths the cloth
 * was cut at, bent toward flat, sewn and tied, and kept clear of what they
 * lie on. Small fixed substeps with one pass of the constraints each, which
 * is what makes XPBD both stable and true to its stiffnesses.
 *
 * It replaces MuJoCo's flex for cloth, which collided softly, vertex by
 * vertex, against convex pieces only, and sewed with springs: cloth sank into
 * the form's hollows, leaked between its pieces, never quite closed a seam,
 * and had to step at 1 ms. Here cloth lies on the real surface (an SDF of a
 * mesh), seams are exact, and the step is free of MuJoCo's. The two are
 * coupled one way: cloth reads where every body is each step.
 *
 * World frame, Z-up, metres, seconds.
 */

import * as THREE from 'three';
import type { ClothModel, ClothTrim, FlatPattern } from './clothModel';
import type { ClothMaterialName } from '../../types/cloth';
import { LayerContacts } from './clothLayers';
import { colliderContact, type Collider } from './clothColliders';

/** Substep, seconds. */
/**
 * Substep, seconds. Stiffness in XPBD comes from substeps, not passes: a
 * hanging 3 cm sheet held to 0.1% at 2000 a second, 10% at 300; with strain
 * limits (below), 600 holds a draped shirt to ~1.5% at the 95th percentile
 * for about a second of compute per second simulated.
 */
export const CLOTH_SUBSTEP = 1 / 600;
/** How far cloth keeps its middle from what it lies on: half its thickness and a little air. */
export const CLOTH_THICKNESS = 0.004;

/** Passes over the stretch constraints each substep (see substep). */
const STRETCH_PASSES = 3;
/** Position-only constraint passes before the first substep, so cut-vs-3D pre-strain does not become velocity. */
const SETTLE_PASSES = 15;

const SKIN_FRICTION = 0.02;
const STALL = (15 * Math.PI) / 180, POST_STALL = (30 * Math.PI) / 180;

/**
 * Force square to a sheet, over dynamic pressure times area, with the flow at
 * `alpha` to its plane: a flat plate's, lift-like 5.7 per radian until it
 * stalls at 15 degrees, then easing by 30 onto a bluff plate's cd sin(alpha).
 * `cd` below a solid sheet's 1.2 is an open weave, and scales the whole curve.
 */
export function clothNormalCoefficient(alpha: number, cd: number): number {
  const k = cd / 1.2;
  const bluff = cd * Math.sin(alpha);
  if (alpha <= STALL) return k * 5.7 * alpha;
  if (alpha >= POST_STALL) return bluff;
  const t = (alpha - STALL) / (POST_STALL - STALL);
  return (1 - t) * k * 5.7 * STALL + t * bluff;
}

export interface ClothEnv {
  gravity: [number, number, number];
  wind: [number, number, number];
  airDensity: number;
}

interface Piece {
  model: ClothModel;
  base: number; // first particle
}

export class ClothSim {
  readonly n: number;
  readonly x: Float64Array;
  private prev: Float64Array;
  private v: Float64Array;
  private w: Float64Array;
  private ext: Float64Array;
  private pieces: Piece[];
  private edges: Int32Array; private edgeRest: Float64Array; private edgeAlpha: Float64Array;
  private bends: Int32Array; private bendWeights: Float64Array; private bendAlpha: Float64Array; private bendRest: Float64Array;
  private limits: Int32Array; private limitRest: Float64Array;
  private stitches: Int32Array; private stitchGap: Float64Array; private stitchSew: Float64Array;
  private ties: { name: string; p: number; body: string | null; anchor: number[] | null; anchorWorld: number[] | null; from: number[]; sew: number; lambda: number }[];
  private tris: Int32Array; private triCd: Float64Array;
  private floatUntil: Float64Array;
  private colliders: Collider[];
  private contactN: Float64Array; private contactPush: Float64Array; private contactMu: Float64Array; private contactHeld: Float64Array;
  private world: THREE.Matrix4[]; private inv: THREE.Matrix4[];
  private layers: LayerContacts;
  private layerTick = 0;
  /**
   * How far each particle can move before it could reach a body, from its
   * nearest at the last look; until it has, it is not looked at again. Most
   * of a garment hangs clear of the form most of the time. Reset when any
   * body moves.
   */
  private clearBudget: Float64Array;
  private nearest: Float64Array;
  private skip: Uint8Array;
  private accumulator = 0;
  time = 0;

  constructor(models: ClothModel[], colliders: Collider[]) {
    this.pieces = [];
    let n = 0;
    for (const m of models) { this.pieces.push({ model: m, base: n }); n += m.x0.length / 3; }
    this.n = n;
    this.x = new Float64Array(3 * n); this.prev = new Float64Array(3 * n); this.v = new Float64Array(3 * n);
    this.w = new Float64Array(n); this.ext = new Float64Array(3 * n); this.floatUntil = new Float64Array(n);
    const E: number[] = [], ER: number[] = [], EA: number[] = [], B: number[] = [], BR: number[] = [], BA: number[] = [], BC: number[] = [];
    const S: number[] = [], SS: number[] = [], T: number[] = [], TC: number[] = [], LP: number[] = [], LR: number[] = [];
    this.ties = [];
    for (const { model: m, base } of this.pieces) {
      this.x.set(m.x0, 3 * base);
      this.w.set(m.invMass, base);
      const mat = m.material;
      // Stretch: an edge's compliance is the inverse of the sheet's stiffness
      // (E t, N/m). Bending: the sheet's rigidity E t^3 / 12 (N m).
      const stretchAlpha = 1 / Math.max(1, mat.young * mat.thickness);
      const bendK = (mat.young * mat.thickness ** 3) / 12;
      for (let k = 0; k < m.edges.length; k += 2) { E.push(base + m.edges[k], base + m.edges[k + 1]); ER.push(m.edgeRest[k / 2]); EA.push(stretchAlpha); }
      // Energy (3 k / A) |sum K_i x_i|^2 / 2 over a stencil of area A, so a
      // constraint |sum K_i x_i| = 0 of compliance A / (3 k).
      for (let k = 0; k < m.bends.length; k++) { B.push(base + m.bends[k]); BR.push(m.bendWeights[k]); }
      for (const A of m.bendArea) BA.push(A / (3 * Math.max(1e-12, bendK)));
      BC.push(...m.bendRest);
      for (let k = 0; k < m.limits.length; k += 2) { LP.push(base + m.limits[k], base + m.limits[k + 1]); LR.push(m.limitRest[k / 2]); }
      for (let k = 0; k < m.stitches.length; k += 2) { S.push(base + m.stitches[k], base + m.stitches[k + 1]); SS.push(m.sewTime); }
      for (let k = 0; k < m.tris.length; k++) T.push(base + m.tris[k]);
      for (let k = 0; k < m.tris.length / 3; k++) TC.push(mat.windCd);
      for (const t of m.ties) if (!t.cloth) this.ties.push({ name: t.name, p: base + t.particle, body: t.body, anchor: t.anchor, anchorWorld: null, from: [], sew: m.sewTime, lambda: 0 });
      // Held weightless while its stitches close, as garment CAD sews: falling
      // meanwhile would drop the pieces before they meet.
      if (m.stitches.length) this.floatUntil.fill(m.sewTime, base, base + m.x0.length / 3);
    }
    // Ties to another cloth: sewn to its nearest point where the two start,
    // the stitch closing over the sew time.
    for (const { model: m, base } of this.pieces) {
      for (const t of m.ties) {
        if (!t.cloth) continue;
        const target = this.pieces.find((q) => q.model.name === t.cloth);
        if (!target) continue;
        const i = 3 * (base + t.particle);
        let best = -1, bd = Infinity;
        for (let j = 0; j < target.model.invMass.length; j++) {
          const k = 3 * (target.base + j);
          const d = (this.x[k] - this.x[i]) ** 2 + (this.x[k + 1] - this.x[i + 1]) ** 2 + (this.x[k + 2] - this.x[i + 2]) ** 2;
          if (d < bd && target.model.invMass[j] > 0) { bd = d; best = j; }
        }
        if (best >= 0) { S.push(base + t.particle, target.base + best); SS.push(m.sewTime); }
      }
    }
    this.edges = Int32Array.from(E); this.edgeRest = Float64Array.from(ER); this.edgeAlpha = Float64Array.from(EA);
    this.bends = Int32Array.from(B); this.bendWeights = Float64Array.from(BR); this.bendAlpha = Float64Array.from(BA); this.bendRest = Float64Array.from(BC);
    this.limits = Int32Array.from(LP); this.limitRest = Float64Array.from(LR);
    this.stitches = Int32Array.from(S); this.stitchSew = Float64Array.from(SS); this.stitchGap = new Float64Array(S.length / 2);
    this.tris = Int32Array.from(T); this.triCd = Float64Array.from(TC);
    this.colliders = colliders;
    this.contactN = new Float64Array(3 * n); this.contactPush = new Float64Array(n); this.contactMu = new Float64Array(n); this.contactHeld = new Float64Array(n);
    this.world = colliders.map(() => new THREE.Matrix4());
    this.inv = colliders.map(() => new THREE.Matrix4());
    this.layers = new LayerContacts(this.pieces, this.w);
    this.clearBudget = new Float64Array(n); this.nearest = new Float64Array(n); this.skip = new Uint8Array(n);
    this.prev.set(this.x);
    this.aim();
  }

  /** Each stitch's gap and each tie's start, from where the cloth is now. */
  private aim() {
    const x = this.x;
    for (let k = 0; k < this.stitchGap.length; k++) {
      const a = 3 * this.stitches[2 * k], b = 3 * this.stitches[2 * k + 1];
      this.stitchGap[k] = Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2]);
    }
    for (const t of this.ties) t.from = [x[3 * t.p], x[3 * t.p + 1], x[3 * t.p + 2]];
  }

  /**
   * Where each collider's body is, as a world matrix (null: where it was).
   * Call before advancing; static bodies need it only once.
   */
  setPoses(bodyWorld: (body: string) => THREE.Matrix4 | null, geomWorld: (geom: number) => THREE.Matrix4 | null = () => null) {
    const corner = new THREE.Vector3();
    this.colliders.forEach((c, i) => {
      const bw = c.geom !== undefined ? geomWorld(c.geom) : c.body ? bodyWorld(c.body) : new THREE.Matrix4();
      if (!bw) return;
      const before = this.world[i].elements.slice();
      this.world[i].multiplyMatrices(bw, c.local);
      if (this.world[i].elements.some((v, k) => Math.abs(v - before[k]) > 1e-9)) this.clearBudget?.fill(0);
      this.inv[i].copy(this.world[i]).invert();
      // Its bounds in the world, grown by the cloth's thickness: most points
      // are turned away by six comparisons, not a transform and a distance.
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      const { min, max } = c.bounds;
      const huge = min.some((v) => v < -1e8) || max.some((v) => v > 1e8);
      for (let k = 0; k < 8 && !huge; k++) {
        corner.set(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]).applyMatrix4(this.world[i]);
        lo[0] = Math.min(lo[0], corner.x); lo[1] = Math.min(lo[1], corner.y); lo[2] = Math.min(lo[2], corner.z);
        hi[0] = Math.max(hi[0], corner.x); hi[1] = Math.max(hi[1], corner.y); hi[2] = Math.max(hi[2], corner.z);
      }
      const t = CLOTH_THICKNESS;
      this.worldBox[i] = huge ? [-1e9, -1e9, -1e9, 1e9, 1e9, 1e9] : [lo[0] - t, lo[1] - t, lo[2] - t, hi[0] + t, hi[1] + t, hi[2] + t];
    });
    // Where each tie is drawn to, for this pose.
    const p = new THREE.Vector3();
    for (const tie of this.ties) {
      if (!tie.anchor) continue;
      const bw = tie.body ? bodyWorld(tie.body) : null;
      p.set(tie.anchor[0], tie.anchor[1], tie.anchor[2]);
      if (bw) p.applyMatrix4(bw);
      tie.anchorWorld = [p.x, p.y, p.z];
    }
  }
  private worldBox: number[][] = [];

  /** Moves the cloth on by `dt`, in whole substeps (the remainder carries over). */
  advance(dt: number, env: ClothEnv) {
    this.accumulator += dt;
    if (this.accumulator < CLOTH_SUBSTEP) return;
    this.externalForces(env);
    const h = CLOTH_SUBSTEP;
    while (this.accumulator >= h) {
      this.substep(h, env);
      this.accumulator -= h;
    }
  }

  /** Wind on each triangle, as an acceleration of its corners. */
  private externalForces(env: ClothEnv) {
    this.ext.fill(0);
    const [wx, wy, wz] = env.wind;
    if (!wx && !wy && !wz) return;
    const x = this.x, v = this.v, T = this.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      const area = len / 2; nx /= len; ny /= len; nz /= len;
      const rx = wx - (v[a] + v[b] + v[c]) / 3, ry = wy - (v[a + 1] + v[b + 1] + v[c + 1]) / 3, rz = wz - (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
      const s2 = rx * rx + ry * ry + rz * rz;
      if (s2 < 1e-10) continue;
      const s = Math.sqrt(s2), vn = rx * nx + ry * ny + rz * nz;
      const qa = (0.5 * env.airDensity * s2 * area) / 3;
      const pn = Math.sign(vn) * qa * clothNormalCoefficient(Math.asin(Math.min(1, Math.abs(vn) / s)), this.triCd[t / 3]);
      const tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz, pt = (qa * SKIN_FRICTION) / s;
      for (const i of [T[t], T[t + 1], T[t + 2]]) {
        const w = this.w[i];
        this.ext[3 * i] += w * (pn * nx + pt * tx); this.ext[3 * i + 1] += w * (pn * ny + pt * ty); this.ext[3 * i + 2] += w * (pn * nz + pt * tz);
      }
    }
  }

  /**
   * Relaxes initial 3D-vs-2D rest-length mismatches and contact penetrations
   * in place before the first substep, without turning those corrections into
   * particle velocity.
   */
  private settle(h: number) {
    const h2 = h * h;
    const doLayers = this.layers.active;
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      this.prev.set(this.x);
      this.contactPush.fill(0);
      this.contactHeld.fill(0);
      for (let i = 0; i < this.n; i++) this.skip[i] = !this.w[i] ? 1 : 0;
      for (let sp = 0; sp < STRETCH_PASSES; sp++) {
        this.solveDistances(this.edges, this.edgeRest, this.edgeAlpha, h2);
        this.solveLimits(h2);
        if (sp === 0) {
          this.solveBends(h2);
          for (let k = 0; k < this.stitchGap.length; k++) {
            if (this.stitchSew[k] <= 0) this.project(this.stitches[2 * k], this.stitches[2 * k + 1], 0, 0);
          }
        }
        this.collide(CLOTH_THICKNESS, false);
      }
      this.collide(CLOTH_THICKNESS, true);
      if (doLayers) {
        this.layers.collide(this.x, this.prev, CLOTH_THICKNESS, this.contactN, this.contactPush, this.contactMu, pass === 0);
      }
    }
    this.prev.set(this.x);
    this.v.fill(0);
    this.aim();
  }

  private substep(h: number, env: ClothEnv) {
    if (this.time === 0) this.settle(h);
    const { x, prev, v, w, ext, n } = this;
    const [gx, gy, gz] = env.gravity;
    this.time += h;
    const t = this.time;
    // Predict.
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      const g = t < this.floatUntil[i] ? 0 : 1;
      const k = 3 * i;
      v[k] += h * (g * gx + ext[k]); v[k + 1] += h * (g * gy + ext[k + 1]); v[k + 2] += h * (g * gz + ext[k + 2]);
      prev[k] = x[k]; prev[k + 1] = x[k + 1]; prev[k + 2] = x[k + 2];
      x[k] += h * v[k]; x[k + 1] += h * v[k + 1]; x[k + 2] += h * v[k + 2];
    }
    const h2 = h * h;
    this.contactPush.fill(0);
    this.contactHeld.fill(0);
    for (let i = 0; i < n; i++) this.skip[i] = !w[i] ? 1 : this.clearBudget[i] <= 0 ? 0 : 1;
    const doLayers = this.layers.active;
    this.layerTick = (this.layerTick + 1) % 2;
    // Stretch, then bend: distance constraints with compliance, coupled with
    // contact and Coulomb friction each pass so points held by friction pull
    // their neighbours in subsequent passes rather than stretching the edges
    // between them at the end of the substep.
    for (let pass = 0; pass < STRETCH_PASSES; pass++) {
      this.solveDistances(this.edges, this.edgeRest, this.edgeAlpha, h2);
      this.solveLimits(h2);
      if (pass === 0) {
        this.solveBends(h2);
        // Stitches close from their starting gap to nothing over the sew time.
        for (let k = 0; k < this.stitchGap.length; k++) {
          const s = Math.min(1, t / Math.max(1e-6, this.stitchSew[k]));
          this.project(this.stitches[2 * k], this.stitches[2 * k + 1], this.stitchGap[k] * (1 - s), 0);
        }
      }
      this.collide(CLOTH_THICKNESS, false);
      if (doLayers && (pass === 0 || this.layerTick === 0)) this.layers.collide(x, prev, CLOTH_THICKNESS, this.contactN, this.contactPush, this.contactMu, pass === 0 && this.layerTick === 0);
      for (let i = 0; i < n; i++) {
        if (this.contactPush[i] <= 0) continue;
        const k = 3 * i;
        const nx = this.contactN[k], ny = this.contactN[k + 1], nz = this.contactN[k + 2];
        const dx = x[k] - prev[k], dy = x[k + 1] - prev[k + 1], dz = x[k + 2] - prev[k + 2];
        const dn = dx * nx + dy * ny + dz * nz;
        const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        const rem = this.contactMu[i] * this.contactPush[i] - this.contactHeld[i];
        if (tl > 1e-12 && rem > 0) {
          const take = Math.min(tl, rem), s = take / tl;
          x[k] -= tx * s; x[k + 1] -= ty * s; x[k + 2] -= tz * s;
          this.contactHeld[i] += take;
        }
      }
    }
    // Ties: each point drawn to its anchor (wound in over the sew time).
    for (const tie of this.ties) {
      const i = tie.p, k = 3 * i, f = tie.from, aw = tie.anchorWorld;
      const s = aw ? Math.min(1, t / Math.max(1e-6, tie.sew)) : 0;
      const tx = aw ? f[0] + (aw[0] - f[0]) * s : f[0], ty = aw ? f[1] + (aw[1] - f[1]) * s : f[1], tz = aw ? f[2] + (aw[2] - f[2]) * s : f[2];
      const dx = tx - x[k], dy = ty - x[k + 1], dz = tz - x[k + 2];
      x[k] += dx; x[k + 1] += dy; x[k + 2] += dz;
      // The pull, by Newton: m a over the substep.
      tie.lambda = Math.sqrt(dx * dx + dy * dy + dz * dz) / (h2 * Math.max(1e-12, w[i]));
    }
    this.collide(CLOTH_THICKNESS, true);
    // Velocities from the post-contact, post-friction positions: strongly
    // damped and bounded to terminal free-fall speed over the initial settle
    // window so 3D-vs-2D rest-length reconciliation does not turn into momentum.
    const gMag = Math.hypot(gx, gy, gz);
    const wMag = Math.hypot(env.wind[0], env.wind[1], env.wind[2]);
    const baseDamp = Math.exp(-1.0 * h);
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      let vx = ((x[k] - prev[k]) / h) * baseDamp;
      let vy = ((x[k + 1] - prev[k + 1]) / h) * baseDamp;
      let vz = ((x[k + 2] - prev[k + 2]) / h) * baseDamp;
      const tr = Math.max(0, t - this.floatUntil[i]);
      if (tr < 0.35) {
        const rate = 1 + 40 * Math.exp(-tr / 0.08);
        const extra = Math.exp(-(rate - 1) * h);
        vx *= extra; vy *= extra; vz *= extra;
        const cap = gMag / rate + wMag + 0.25;
        const s = Math.hypot(vx, vy, vz);
        if (s > cap) {
          const sc = cap / s;
          vx *= sc; vy *= sc; vz *= sc;
        }
      }
      v[k] = vx;
      v[k + 1] = vy;
      v[k + 2] = vz;
    }
  }

  private solveDistances(pairs: Int32Array, rest: Float64Array, alpha: Float64Array, h2: number) {
    for (let k = 0; k < rest.length; k++) this.project(pairs[2 * k], pairs[2 * k + 1], rest[k], alpha[k] / h2);
  }

  /**
   * Strain limits: pairs two edges apart held to at most their flat
   * distance, so stretch cannot spread over a region as the edges alone,
   * each a little over, let it. One-sided: they do nothing when slack.
   */
  private solveLimits(h2: number) {
    const { x, w } = this, P = this.limits, R = this.limitRest;
    for (let k = 0; k < R.length; k++) {
      const a = P[2 * k], b = P[2 * k + 1], ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len <= R[k]) continue;
      void h2;
      const ws = w[a] + w[b];
      if (ws <= 0) continue;
      const c = (len - R[k]) / (ws * len);
      x[ia] -= w[a] * c * dx; x[ia + 1] -= w[a] * c * dy; x[ia + 2] -= w[a] * c * dz;
      x[ib] += w[b] * c * dx; x[ib + 1] += w[b] * c * dy; x[ib + 2] += w[b] * c * dz;
    }
  }

  /**
   * Isometric bending: each stencil's curvature, sum K_i x_i, driven to the
   * size it rests at (none, for flat cloth). Unlike a distance across the hinge, which barely changes for a
   * small fold, this resists a fold in proportion to its angle: with the
   * distance, a draped shirt crumpled into facets a triangle across.
   */
  private solveBends(h2: number) {
    const { x, w } = this, Q = this.bends, K = this.bendWeights, A = this.bendAlpha;
    for (let s = 0; s < A.length; s++) {
      let vx = 0, vy = 0, vz = 0, den = 0;
      for (let j = 0; j < 4; j++) {
        const i = Q[4 * s + j], k = K[4 * s + j];
        vx += k * x[3 * i]; vy += k * x[3 * i + 1]; vz += k * x[3 * i + 2];
        den += w[i] * k * k;
      }
      const c = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (c < 1e-12) continue;
      const dl = -(c - this.bendRest[s]) / (den + A[s] / h2);
      const nx = vx / c, ny = vy / c, nz = vz / c;
      for (let j = 0; j < 4; j++) {
        const i = Q[4 * s + j], f = w[i] * K[4 * s + j] * dl;
        x[3 * i] += f * nx; x[3 * i + 1] += f * ny; x[3 * i + 2] += f * nz;
      }
    }
  }

  /**
   * Strain limits: one-sided, between points two edges apart, at their
   * distance on the flat cloth. They act only when the cloth is stretched
   * past it, so it still bends, folds and gathers freely; but stretch now
   * spreads two edges at a time, not one. One pass per substep left a
   * draped shirt with a twentieth of its edges a quarter too long.
   */
  /** One distance constraint, |xa - xb| = rest, with compliance alphaTilde (XPBD, one pass). */
  private project(a: number, b: number, rest: number, alphaTilde: number) {
    const { x, w } = this;
    const wa = w[a], wb = w[b], ws = wa + wb + alphaTilde;
    if (ws <= 0) return;
    const ia = 3 * a, ib = 3 * b;
    const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) return;
    const c = (len - rest) / ws, nx = dx / len, ny = dy / len, nz = dz / len;
    x[ia] -= wa * c * nx; x[ia + 1] -= wa * c * ny; x[ia + 2] -= wa * c * nz;
    x[ib] += wb * c * nx; x[ib + 1] += wb * c * ny; x[ib + 2] += wb * c * nz;
  }

  /** Every particle kept `margin` clear of every collider, with friction. */
  private collide(margin: number, updateBudget = true) {
    const { x, w, n, prev, clearBudget, nearest, skip } = this;
    const nrm = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      if (skip[i]) {
        const k = 3 * i, dx = x[k] - prev[k], dy = x[k + 1] - prev[k + 1], dz = x[k + 2] - prev[k + 2];
        if (clearBudget[i] - Math.sqrt(dx * dx + dy * dy + dz * dz) <= 0) skip[i] = 0;
      }
      if (!skip[i]) nearest[i] = Infinity;
    }
    for (let ci = 0; ci < this.colliders.length; ci++) {
      const c = this.colliders[ci], inv = this.inv[ci], world = this.world[ci];
      const e = inv.elements, box = this.worldBox[ci];
      if (!box) continue;
      const [x0, y0, z0, x1, y1, z1] = box;
      for (let i = 0; i < n; i++) {
        if (!w[i] || skip[i]) continue;
        const k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        if (px < x0 || px > x1 || py < y0 || py > y1 || pz < z0 || pz > z1) {
          // Outside its box (grown by the thickness): at least that far from it, and the thickness more.
          const gx = Math.max(x0 - px, 0, px - x1), gy = Math.max(y0 - py, 0, py - y1), gz = Math.max(z0 - pz, 0, pz - z1);
          const far = Math.sqrt(gx * gx + gy * gy + gz * gz) + CLOTH_THICKNESS;
          if (far < nearest[i]) nearest[i] = far;
          continue;
        }
        // Into the collider's frame (no allocation).
        const lx = e[0] * px + e[4] * py + e[8] * pz + e[12];
        const ly = e[1] * px + e[5] * py + e[9] * pz + e[13];
        const lz = e[2] * px + e[6] * py + e[10] * pz + e[14];
        const hit = colliderContact(c, [lx, ly, lz]);
        // No answer near a body (just outside its exact bounds, say): look again next substep.
        const d = hit ? hit.d : CLOTH_THICKNESS;
        if (d < nearest[i]) nearest[i] = d;
        if (!hit || hit.d >= margin) continue;
        nrm.set(hit.n[0], hit.n[1], hit.n[2]).transformDirection(world);
        const depth = margin - hit.d;
        x[k] += nrm.x * depth; x[k + 1] += nrm.y * depth; x[k + 2] += nrm.z * depth;
        this.contactN[k] = nrm.x; this.contactN[k + 1] = nrm.y; this.contactN[k + 2] = nrm.z;
        this.contactPush[i] += depth; this.contactMu[i] = c.friction;
      }
    }
    // At most a centimetre: a mesh's distance grid is exact only within a
    // band of its surface (beyond, it may read up to a cell long).
    if (updateBudget) {
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        if (skip[i]) {
          const k = 3 * i, dx = x[k] - prev[k], dy = x[k + 1] - prev[k + 1], dz = x[k + 2] - prev[k + 2];
          clearBudget[i] -= Math.sqrt(dx * dx + dy * dy + dz * dz);
        } else {
          clearBudget[i] = Math.min(0.01, nearest[i] - CLOTH_THICKNESS);
        }
      }
    }
  }

  /** Each render group's vertices, in order, into `out` (3 per vertex). */
  writeRender(out: Float64Array) {
    let o = 0;
    for (const { model, base } of this.pieces) {
      for (const g of model.groups) {
        for (const p of g.particles) { const k = 3 * (base + p); out[o++] = this.x[k]; out[o++] = this.x[k + 1]; out[o++] = this.x[k + 2]; }
      }
    }
  }

  /** The render groups, with where each starts in the render buffer. */
  renderLayout(): { name: string; vertadr: number; vertnum: number; elems: number[]; rgba: number[]; material: ClothMaterialName; flat?: FlatPattern; trims?: ClothTrim[] }[] {
    const out: ReturnType<ClothSim['renderLayout']> = [];
    let adr = 0;
    for (const { model } of this.pieces) for (const g of model.groups) {
      out.push({ name: g.name, vertadr: adr, vertnum: g.particles.length, elems: g.tris.slice(), rgba: g.rgba, material: g.material, flat: g.flat, trims: g.trims });
      adr += g.particles.length;
    }
    return out;
  }

  renderSize(): number {
    return this.pieces.reduce((s, { model }) => s + model.groups.reduce((t, g) => t + g.particles.length, 0), 0);
  }

  /** The pull on each tie, newtons, as of the last substep. */
  tieLoads(): { name: string; newtons: number }[] {
    return this.ties.map((t) => ({ name: t.name, newtons: t.lambda }));
  }

  /** Positions and velocities, to carry the cloth across a rebuild. */
  state() { return { x: Float64Array.from(this.x), v: Float64Array.from(this.v), time: this.time }; }
  restore(s: { x: Float64Array; v: Float64Array; time: number }) {
    if (s.x.length !== this.x.length) return false;
    this.x.set(s.x); this.v.set(s.v); this.prev.set(s.x); this.time = s.time;
    this.clearBudget.fill(0);
    return true;
  }
}
