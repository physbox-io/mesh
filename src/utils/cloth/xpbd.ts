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
import type { ClothMaterialName, ClothPatternPrint } from '../../types/cloth';
import { LayerContacts } from './clothLayers';
import { SelfContacts } from './clothSelf';
import { BoardShapes, type Board } from './clothBoards';
import { contourStep, findCrossings, trianglesNear, untangleMesh, type UntangleMesh } from './clothUntangle';
import { ClothCcd } from './clothCcd';
import { colliderContact, type Collider } from './clothColliders';

/** Substep, seconds. */
/**
 * Substep, seconds. Stiffness in XPBD comes from substeps, not passes: a
 * hanging 3 cm sheet held to 0.1% at 2000 a second, 10% at 300; with strain
 * limits (below), 600 holds a draped shirt to ~1.5% at the 95th percentile
 * for about a second of compute per second simulated.
 */
export const CLOTH_SUBSTEP = 1 / 600;
/** How fast a held point of cloth follows the hand pulling it, m/s. */
const GRAB_SPEED = 1.5;
/**
 * How much heavier a held point is than it was: it leads, and is still pushed
 * by what it meets. Pulling a hood down over the head: 20x could not move it;
 * fixed (no weight), 57 crossings; 200x, 10 over the cloth's own 4.
 */
const GRAB_HEAVY = 200;
/**
 * A zip's slider (ClothModel.zips): how far it reaches up its run from where
 * the teeth meet, holding the two sides apart to its throat at the top, m;
 * how fast teeth it has run together close, m/s; and how near its slider or
 * the pull hanging below it a press takes hold of it, and how far down the
 * pull hangs, m (clothTrims draws the slider about 3 cm long, its pull 5 cm).
 */
const SLIDER_LONG = 0.03, SLIDER_THROAT = 0.01, ZIP_CLOSE_SPEED = 0.5, ZIP_REACH = 0.015, PULL_HANGS = 0.055;
/** After its sew time, how long cloth sewn at the start is let hang before it is first drawn, seconds. */
const PRESEW_REST = 0.5;
/** Its step meanwhile, seconds. */
const PRESEW_STEP = 1 / 200;
/** How long cloth that starts lifted is let fall, seconds, more. */
const DROP_TIME = 0.6;
/** An arrangement: after sewing, how long until points are pulled, how long the pull takes, how long they are held, seconds. */
const PULL_WAIT = 0.2, PULL_TIME = 1.2, PULL_HOLD = 0.4;
/** How far cloth keeps its middle from what it lies on: half its thickness and a little air. */
export const CLOTH_THICKNESS = 0.004;

/** Passes over the stretch constraints each substep (see substep). */
const STRETCH_PASSES = 3;
/** Position-only constraint passes before the first substep, so cut-vs-3D pre-strain does not become velocity. */
const SETTLE_PASSES = 15;
/** Untangling (clothUntangle): how far a contour moves a step, steps per round, rounds, and how near a crossing is re-tested. */
const UNTANGLE_STEP = 0.0005;
const UNTANGLE_STEPS = 300;
const UNTANGLE_ROUNDS = 3;
const UNTANGLE_REACH = 0.05;
/** Untangling at the build: at most this many steps, the whole checked again every so many. */
const UNTANGLE_MAX = 1500, UNTANGLE_CHECK = 25;
/** And for no longer than this at the build, ms: what is left stays free of continuous collision, to come apart as it runs. */
const UNTANGLE_BUDGET = 3000;
/** Continuous collision over this many substeps at a time (each stretch's end is what is kept): every 4, it cost half as much again as the rest of a step; the guarantee is the same at any. */
const CCD_EVERY = 8;

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
  private edges: Int32Array; private edgeRest: Float64Array; private edgeMin: Float64Array; private edgeAlpha: Float64Array;
  private elastics: Int32Array; private elasticFlat: Float64Array; private elasticRest: Float64Array; private elasticAlpha: Float64Array;
  private boards: BoardShapes;
  private grabbed = -1; private grabW = 0; private grabTo: number[] | null = null;
  private bends: Int32Array; private bendWeights: Float64Array; private bendAlpha: Float64Array; private bendRest: Float64Array;
  private limits: Int32Array; private limitRest: Float64Array;
  private stitches: Int32Array; private stitchGap: Float64Array; private stitchSew: Float64Array;
  /** Whether each stitch holds (a zip's pair, only where it is done up), and the gap a zip's pair is closing from (m, down to 0 at ZIP_CLOSE_SPEED). */
  private stitchOn: Uint8Array; private stitchClose: Float64Array;
  /** Each zip: its cloth, its trim, its pairs' stitches and places up the run (0-1), its length (m), how far it is done up and where its slider is being moved to. */
  private zips: { cloth: string; trim: number; stitch: Int32Array; at: Float64Array; length: number; fastened: number; want: number }[] = [];
  private zipGrabbed = -1;
  private rodLinks: Int32Array; private rodLinkRest: Float64Array; private rodBends: Int32Array; private rodBendRest: Float64Array; private rodBendAlpha: Float64Array;
  private tacks: { p: number; a: number; b: number; c: number; w0: number; w1: number; w2: number; offset: number; lift: boolean }[];
  private ties: { name: string; p: number; body: string | null; anchor: number[] | null; anchorWorld: number[] | null; from: number[]; sew: number; lambda: number }[];
  private tris: Int32Array; private triCd: Float64Array;
  private floatUntil: Float64Array;
  private colliders: Collider[];
  private contactN: Float64Array; private contactPush: Float64Array; private contactMu: Float64Array; private contactHeld: Float64Array;
  private world: THREE.Matrix4[]; private inv: THREE.Matrix4[];
  private layers: LayerContacts;
  private self: SelfContacts;
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
  /** Cloth against cloth along each stretch of substeps (clothCcd): where the stretch began, and how many substeps it is. */
  private ccd: ClothCcd | null = null;
  private ccdFrom: Float64Array | null = null;
  private ccdSince = 0;
  /** What continuous collision has done since the build: checks, pairs met, rounds of pushing, checks that needed impact zones, and that fell back to holding. */
  ccdTotals = { calls: 0, met: 0, pushes: 0, zoneCalls: 0, zonePoints: 0, frozen: 0 };
  time = 0;

  constructor(models: ClothModel[], colliders: Collider[]) {
    this.pieces = [];
    let n = 0;
    for (const m of models) { this.pieces.push({ model: m, base: n }); n += m.x0.length / 3; }
    this.n = n;
    this.x = new Float64Array(3 * n); this.prev = new Float64Array(3 * n); this.v = new Float64Array(3 * n);
    this.w = new Float64Array(n); this.ext = new Float64Array(3 * n); this.floatUntil = new Float64Array(n);
    const E: number[] = [], ER: number[] = [], EM: number[] = [], EA: number[] = [], B: number[] = [], BR: number[] = [], BA: number[] = [], BC: number[] = [];
    const EL: number[] = [], ELF: number[] = [], ELR: number[] = [], ELA: number[] = [];
    const RL: number[] = [], RLR: number[] = [], RB: number[] = [], RBR: number[] = [], RBA: number[] = [];
    const S: number[] = [], SS: number[] = [], T: number[] = [], TC: number[] = [], LP: number[] = [], LR: number[] = [];
    this.tacks = [];
    this.ties = [];
    for (const { model: m, base } of this.pieces) {
      this.x.set(m.x0, 3 * base);
      this.w.set(m.invMass, base);
      const mat = m.material;
      // Stretch: an edge's compliance is the inverse of the sheet's stiffness
      // (E t, N/m). Bending: the sheet's rigidity E t^3 / 12 (N m).
      const stretchAlpha = 1 / Math.max(1, mat.young * mat.thickness);
      const bendK = (mat.young * mat.thickness ** 3) / 12;
      for (let k = 0; k < m.edges.length; k += 2) {
        const rest = m.edgeRest[k / 2];
        E.push(base + m.edges[k], base + m.edges[k + 1]);
        ER.push(rest);
        EM.push(m.edgeMin ? m.edgeMin[k / 2] : rest);
        EA.push(stretchAlpha / (m.edgeStiffness?.[k / 2] ?? 1));
      }
      if (m.elastics && m.elasticRest && m.elasticAlpha) {
        for (let k = 0; k < m.elastics.length; k += 2) {
          EL.push(base + m.elastics[k], base + m.elastics[k + 1]);
          ELF.push(m.elasticFlat ? m.elasticFlat[k / 2] : m.elasticRest[k / 2]);
          ELR.push(m.elasticRest[k / 2]);
          ELA.push(m.elasticAlpha[k / 2]);
        }
      }
      if (m.rods) {
        for (let k = 0; k < m.rods.links.length; k++) RL.push(base + m.rods.links[k]);
        for (const v of m.rods.linkRest) RLR.push(v);
        for (let k = 0; k < m.rods.bends.length; k++) RB.push(base + m.rods.bends[k]);
        for (const v of m.rods.bendRest) RBR.push(v);
        for (const v of m.rods.bendAlpha) RBA.push(v);
      }
      if (m.tacks) {
        for (const tk of m.tacks) {
          this.tacks.push({
            p: base + tk.particle,
            a: base + tk.tri[0],
            b: base + tk.tri[1],
            c: base + tk.tri[2],
            w0: tk.bary[0],
            w1: tk.bary[1],
            w2: tk.bary[2],
            offset: tk.offset,
            lift: Boolean(tk.lift),
          });
        }
      }
      // Energy (3 k / A) |sum K_i x_i|^2 / 2 over a stencil of area A, so a
      // constraint |sum K_i x_i| = 0 of compliance A / (3 k).
      for (let k = 0; k < m.bends.length; k++) { B.push(base + m.bends[k]); BR.push(m.bendWeights[k]); }
      m.bendArea.forEach((A, k) => BA.push(A / (3 * Math.max(1e-12, bendK * (m.bendStiffness?.[k] ?? 1)))));
      // Not spread: a gown has more stencils than a worker's stack has room for arguments.
      for (const v of m.bendRest) BC.push(v);
      for (let k = 0; k < m.limits.length; k += 2) { LP.push(base + m.limits[k], base + m.limits[k + 1]); LR.push(m.limitRest[k / 2]); }
      for (let k = 0; k < m.stitches.length; k += 2) {
        S.push(base + m.stitches[k], base + m.stitches[k + 1]);
        SS.push(m.stitchSew ? m.stitchSew[k / 2] : m.sewTime);
      }
      for (let k = 0; k < m.tris.length; k++) T.push(base + m.tris[k]);
      for (let k = 0; k < m.tris.length / 3; k++) TC.push(mat.windCd);
      for (const t of m.ties) if (!t.cloth) this.ties.push({ name: t.name, p: base + t.particle, body: t.body, anchor: t.anchor, anchorWorld: null, from: [], sew: m.sewTime, lambda: 0 });
      // Held weightless while its stitches close, as garment CAD sews: falling
      // meanwhile would drop the pieces before they meet.
      const hasClosingStitches = m.stitches.length > 0 && (!m.stitchSew || m.stitchSew.some((st) => st > 0));
      if (hasClosingStitches) this.floatUntil.fill(m.sewTime, base, base + m.x0.length / 3);
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
    // Zips: every pair along each, held only where it is done up.
    for (const { model: m, base } of this.pieces) for (const z of m.zips ?? []) {
      const first = S.length / 2, count = z.at.length;
      let length = 0;
      for (let k = 0; k < count; k++) {
        S.push(base + z.pairs[2 * k], base + z.pairs[2 * k + 1]); SS.push(z.sew[k]);
        if (k) {
          const a = 3 * (base + z.pairs[2 * k]), b = 3 * (base + z.pairs[2 * k - 2]);
          length += Math.hypot(this.x[a] - this.x[b], this.x[a + 1] - this.x[b + 1], this.x[a + 2] - this.x[b + 2]);
        }
      }
      this.zips.push({ cloth: m.name, trim: z.trim, stitch: Int32Array.from({ length: count }, (_, k) => first + k), at: Float64Array.from(z.at), length, fastened: z.fastened, want: z.fastened });
    }
    this.edges = Int32Array.from(E); this.edgeRest = Float64Array.from(ER); this.edgeMin = Float64Array.from(EM); this.edgeAlpha = Float64Array.from(EA);
    this.rodLinks = Int32Array.from(RL); this.rodLinkRest = Float64Array.from(RLR); this.rodBends = Int32Array.from(RB); this.rodBendRest = Float64Array.from(RBR); this.rodBendAlpha = Float64Array.from(RBA);
    this.elastics = Int32Array.from(EL); this.elasticFlat = Float64Array.from(ELF); this.elasticRest = Float64Array.from(ELR); this.elasticAlpha = Float64Array.from(ELA);
    this.bends = Int32Array.from(B); this.bendWeights = Float64Array.from(BR); this.bendAlpha = Float64Array.from(BA); this.bendRest = Float64Array.from(BC);
    this.limits = Int32Array.from(LP); this.limitRest = Float64Array.from(LR);
    this.stitches = Int32Array.from(S); this.stitchSew = Float64Array.from(SS); this.stitchGap = new Float64Array(S.length / 2);
    this.stitchOn = new Uint8Array(S.length / 2).fill(1); this.stitchClose = new Float64Array(S.length / 2);
    for (const z of this.zips) z.stitch.forEach((k, j) => { this.stitchOn[k] = z.at[j] <= z.fastened + 1e-9 ? 1 : 0; });
    this.tris = Int32Array.from(T); this.triCd = Float64Array.from(TC);
    this.colliders = colliders;
    this.contactN = new Float64Array(3 * n); this.contactPush = new Float64Array(n); this.contactMu = new Float64Array(n); this.contactHeld = new Float64Array(n);
    this.world = colliders.map(() => new THREE.Matrix4());
    this.inv = colliders.map(() => new THREE.Matrix4());
    this.layers = new LayerContacts(this.pieces, this.w);
    this.self = new SelfContacts(this.pieces, this.w, this.stitches, this.x);
    const boards: Board[] = [];
    for (const pc of this.pieces) for (const b of pc.model.boards ?? []) boards.push({ ...b, particles: b.particles.map((q) => pc.base + q) });
    this.boards = new BoardShapes(boards, this.n);
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
      if (++this.ccdSince >= CCD_EVERY) this.collideAlong(this.ccdSince * h);
    }
  }

  /** The continuous collision, built once: every cloth triangle, sewn points joined. */
  private ccdOf(): ClothCcd {
    if (!this.ccd) {
      const m = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches));
      // Tacked points get no exception: one tacked flat onto a triangle (no offset) and let pass it went through it by millimetres, and its edges with it.
      this.ccd = new ClothCcd(this.n, this.tris, m.root);
    }
    return this.ccd;
  }

  /**
   * Nothing through cloth over the substeps since the last look: what met is
   * moved back (clothCcd), and what it moved goes on at the speed of where it
   * ended up from where the stretch began.
   */
  private collideAlong(span: number) {
    const x = this.x, from = this.ccdFrom;
    this.ccdSince = 0;
    if (!from) { this.ccdFrom = Float64Array.from(x); return; }
    const before = Float64Array.from(x);
    const st = this.ccdOf().resolve(from, x, this.w);
    this.ccdTotals.calls++; this.ccdTotals.met += st.met; this.ccdTotals.pushes += st.pushes; this.ccdTotals.zoneCalls += st.zones ? 1 : 0; this.ccdTotals.frozen += st.frozen ? 1 : 0; this.ccdTotals.zonePoints += st.zonePoints;
    if (st.met) {
      const v = this.v;
      for (let i = 0; i < this.n; i++) {
        const k = 3 * i;
        if (x[k] === before[k] && x[k + 1] === before[k + 1] && x[k + 2] === before[k + 2]) continue;
        for (let c = 0; c < 3; c++) v[k + c] = (x[k + c] - from[k + c]) / span;
        this.prev[k] = x[k]; this.prev[k + 1] = x[k + 1]; this.prev[k + 2] = x[k + 2];
      }
    }
    from.set(x);
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

  private settled = false;
  /**
   * The settle, now: once the colliders are posed, so the cloth is first drawn
   * where it rests rather than where it was modelled (a bow's tails started
   * inside the gown and were drawn there until it played).
   */
  settleNow() {
    if (this.settled) return;
    this.settled = true;
    if (this.time !== 0) return;
    // Untangling (clothUntangle) is not run yet: on garments the tacks, which
    // hold layers a fabric's thickness apart, pull back what it parts, and the
    // crossings grew (gathers and pleats 129 -> 711 over 300 steps; with tacks
    // left out of the steps, 129 -> 22). See plans/cloth-garment-rebuild.md.
    // Nothing passes through cloth from here on, not while it settles and is
    // sewn either (continuous collision, clothCcd): only where it was built
    // crossed is it free to move back through. Unguarded, a collar's end
    // pulled open by the wearer was dragged through the neckerchief under
    // it, and a knot's ends falling into place through the collar over them.
    const tangle = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches));
    this.ccdOf().setTangled(findCrossings(this.x, tangle));
    const built = Float64Array.from(this.x);
    this.settle(CLOTH_SUBSTEP);
    this.ccdOf().resolve(built, this.x, this.w);
    this.ccdFrom = Float64Array.from(this.x);
    this.ccdSince = 0;
    // Cloth that starts apart and is sewn together (a piece sewn on, plain
    // cloth sewn up) is sewn before it is first drawn, as a paused scene
    // shows its cloth at rest: run through its sew time and a moment more,
    // then the clock starts with every stitch closed.
    let sewing = 0;
    for (let k = 0; k < this.stitchGap.length; k++) if (this.stitchOn[k] && this.stitchSew[k] > 0 && this.stitchGap[k] > 0.002) sewing = Math.max(sewing, this.stitchSew[k]);
    const dropped: number[] = [], pulls: { p: number; route: number[][]; started: boolean }[] = [];
    for (const pc of this.pieces) for (const i of pc.model.drop ?? []) dropped.push(pc.base + i);
    for (const pc of this.pieces) for (const pl of pc.model.pulls ?? []) pulls.push({ p: pc.base + pl.particle, route: [...(pl.via ?? []), pl.to], started: false });
    if (sewing > 0 || dropped.length || pulls.length) {
      // Only what is being sewn on moves meanwhile: of the two pieces each
      // open stitch joins, the smaller (a piece onto a garment's panel, a
      // bag's side onto its other side); the rest is held still, so the
      // solver passes over it (sewn with all of it free, a scene's start
      // took a minute).
      const n = this.n, root = Int32Array.from({ length: n }, (_, i) => i);
      const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i]; } return i; };
      const T = this.tris;
      for (let t = 0; t < T.length; t += 3) { const a = find(T[t]), b = find(T[t + 1]), c = find(T[t + 2]); root[b] = a; root[c] = a; }
      const size = new Map<number, number>();
      for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) ?? 0) + 1); }
      const moving = new Set<number>();
      for (let k = 0; k < this.stitchGap.length; k++) {
        if (!(this.stitchOn[k] && this.stitchSew[k] > 0 && this.stitchGap[k] > 0.002)) continue;
        const a = find(this.stitches[2 * k]), b = find(this.stitches[2 * k + 1]);
        moving.add((size.get(a) ?? 0) <= (size.get(b) ?? 0) ? a : b);
      }
      for (const i of dropped) moving.add(find(i));
      for (const pl of pulls) moving.add(find(pl.p));
      const held = this.w.slice(), floats = this.floatUntil.slice();
      for (let i = 0; i < n; i++) if (!moving.has(find(i))) this.w[i] = 0;
      // In longer steps than a running scene's: only drawn together and let hang here.
      const env: ClothEnv = { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.2 };
      this.externalForces(env);
      // What moves meanwhile floats until its seams are closed, then falls
      // into place: a hood's crown sewn round the head before it settles on
      // it (falling while sewn, it tipped off backwards).
      for (let i = 0; i < n; i++) if (moving.has(find(i))) this.floatUntil[i] = sewing;
      // No faster than a step's travel under the cloth's thickness, so what
      // falls into place in these long steps cannot pass through cloth (a
      // neckerchief dropped onto a puffer fell in behind its front).
      const vMax = (0.8 * CLOTH_THICKNESS) / PRESEW_STEP, v = this.v;
      // Arranged once it is sewn: each pulled point drawn to its place, held,
      // let go, and the cloth left to settle.
      const pullFrom = sewing + PULL_WAIT, pullTo = pullFrom + PULL_TIME, letGo = pullTo + PULL_HOLD;
      const end = pulls.length ? letGo + PRESEW_REST : sewing + PRESEW_REST + (dropped.length ? DROP_TIME : 0);
      // Its last rest in the running scene's own steps: in long ones a stiff
      // piece is held softer (a cap's peak sagged, and rose again once the
      // scene ran), so it settles here where the scene will hold it.
      const fineFrom = end - PRESEW_REST;
      let span = 0;
      for (let t = 0; t < end;) {
        const h = t >= fineFrom ? CLOTH_SUBSTEP : PRESEW_STEP;
        this.substep(h, env);
        if (pulls.length && t >= letGo && t < letGo + h) for (const pl of pulls) this.w[pl.p] = held[pl.p];
        if (pulls.length && t >= pullFrom && t < letGo) {
          const f = Math.min(1, (t - pullFrom) / PULL_TIME), e = f * f * (3 - 2 * f);
          for (const pl of pulls) {
            const k = 3 * pl.p;
            // Held as a hand holds it: the cloth gives, not the hand (moved
            // with its own mass, the cloth pulled it most of the way back).
            this.w[pl.p] = 0;
            // From where it is, through its route, by length.
            if (!pl.started) { pl.route.unshift([this.x[k], this.x[k + 1], this.x[k + 2]]); pl.started = true; }
            const R = pl.route, cum = [0];
            for (let q = 1; q < R.length; q++) cum.push(cum[q - 1] + Math.hypot(R[q][0] - R[q - 1][0], R[q][1] - R[q - 1][1], R[q][2] - R[q - 1][2]));
            const want = e * cum[cum.length - 1];
            let q = 1;
            while (q < R.length - 1 && cum[q] < want) q++;
            const u = cum[q] > cum[q - 1] ? (want - cum[q - 1]) / (cum[q] - cum[q - 1]) : 1;
            for (let c = 0; c < 3; c++) this.x[k + c] = R[q - 1][c] + (R[q][c] - R[q - 1][c]) * u;
          }
        }
        // Only in the long steps (in the scene's own, as it settles, held back so it was still falling when the scene began).
        if (h === PRESEW_STEP) for (let i = 0; i < n; i++) {
          const k = 3 * i, sp = Math.hypot(v[k], v[k + 1], v[k + 2]);
          if (sp > vMax) { const f = vMax / sp; v[k] *= f; v[k + 1] *= f; v[k + 2] *= f; }
        }
        // Over several of these long steps at a time (CCD_EVERY of them, in
        // the fine ones as long a while): the guarantee is the same at any.
        span += h;
        if (span >= CCD_EVERY * PRESEW_STEP - 1e-9) { this.collideAlong(span); span = 0; }
        t += h;
      }
      if (span > 0) this.collideAlong(span);
      // Let go: what was held weighs again.
      this.w.set(held);
      this.time = 0; this.accumulator = 0;
      // Sewn now: what moved. What was held still (a zip that closes as the
      // scene starts) closes over its sew time from where it is, as before;
      // marked closed too, it snapped shut on the first step and flung what
      // was sewn on beside it.
      const x = this.x;
      for (let k = 0; k < this.stitchGap.length; k++) {
        const a = this.stitches[2 * k], b = this.stitches[2 * k + 1];
        const gap = Math.hypot(x[3 * a] - x[3 * b], x[3 * a + 1] - x[3 * b + 1], x[3 * a + 2] - x[3 * b + 2]);
        if (gap < 0.002 || (moving.has(find(a)) && moving.has(find(b)))) { this.stitchSew[k] = 0; this.stitchGap[k] = 0; } else this.stitchGap[k] = gap;
      }
      for (let i = 0; i < n; i++) this.floatUntil[i] = moving.has(find(i)) ? 0 : floats[i];
      this.v.fill(0); this.prev.set(this.x);
    }
    // Then nothing through cloth before it is first drawn: whatever its
    // builders modelled crossed, untangled, and from here kept so.
    this.untangle();
    this.ccdFrom = Float64Array.from(this.x);
    this.ccdSince = 0;
  }

  /** What the last untangle found and left: crossings before, after, and steps taken. */
  untangled = { before: 0, after: 0, steps: 0 };
  private tangleMesh: UntangleMesh | null = null;

  /**
   * Shrinks every contour where cloth crosses cloth until none is left
   * (clothUntangle), each step guarded by continuous collision (clothCcd) so
   * it makes no new crossing elsewhere: only what lies near a crossing is left
   * free to come back through. Unguarded, a step that parted two sheets in one
   * place pushed them through each other in the next (tailored 11 crossings
   * to 874). The cloth's edges, tacks and closed stitches are held between
   * steps so it keeps its shape (Baraff, Witkin and Kass, "Untangling Cloth", 2003).
   */
  untangle() {
    const m = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches)), was = Float64Array.from(this.x);
    const before = findCrossings(this.x, m).length;
    const r = this.untangleFor(UNTANGLE_BUDGET);
    // Kept only if it is better: on a pleated skirt and a boned gown's
    // spencer it left more than it found (56 to 70, 196 to 212).
    if (r.left > before) { this.x.set(was); const back = findCrossings(this.x, m); this.ccdOf().setTangled(back); r.left = back.length; }
    this.prev.set(this.x);
    this.v.fill(0);
    this.untangled = { before, after: r.left, steps: r.steps };
  }


  /**
   * Untangling steps for up to `budget` ms (see untangle): returns the
   * crossings left and the steps taken, and leaves what is near those free of
   * continuous collision.
   */
  private untangleFor(budget: number): { left: number; steps: number } {
    const m = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches));
    const ccd = this.ccdOf();
    let crossings = findCrossings(this.x, m);
    let steps = 0;
    const dx = new Float64Array(3 * this.n), count = new Float64Array(this.n), x0 = new Float64Array(3 * this.n);
    // Its shape is held as it is now, not drawn to its cut lengths: the
    // modelled shape is not at them (the settle relaxes that), and hundreds of
    // passes toward them with no contact moved cloth through cloth themselves.
    const E = this.edges, X = this.x, held = new Float64Array(E.length / 2);
    for (let k = 0; k < held.length; k++) { const a = 3 * E[2 * k], b = 3 * E[2 * k + 1]; held[k] = Math.hypot(X[a] - X[b], X[a + 1] - X[b + 1], X[a + 2] - X[b + 2]); }
    let near = crossings.length ? trianglesNear(this.x, m, crossings, UNTANGLE_REACH) : null;
    const region = new Uint8Array(this.n);
    const markRegion = () => { region.fill(0); if (near) for (const t of near) for (let q = 0; q < 3; q++) region[this.tris[3 * t + q]] = 1; };
    markRegion();
    const until = performance.now() + budget;
    for (let it = 0; it < UNTANGLE_MAX && crossings.length && performance.now() < until; it++) {
      ccd.setTangled(crossings);
      x0.set(this.x);
      if (!contourStep(this.x, this.w, m, crossings, UNTANGLE_STEP, dx, count)) break;
      for (let k = 0; k < dx.length; k++) this.x[k] += dx[k];
      // Held where it is untangling only: held everywhere, tacks not quite at
      // their places pulled thousands of points each step, all of which then
      // had to be checked for collision (most of a step's cost).
      for (let sp = 0; sp < 2; sp++) {
        for (let k = 0; k < held.length; k++) if (region[E[2 * k]] || region[E[2 * k + 1]]) this.project(E[2 * k], E[2 * k + 1], held[k], 0);
        for (let k = 0; k < this.stitchGap.length; k++) if (this.stitchOn[k] && this.stitchSew[k] <= 0 && (region[this.stitches[2 * k]] || region[this.stitches[2 * k + 1]])) this.project(this.stitches[2 * k], this.stitches[2 * k + 1], 0, 0);
        this.solveTacks(region);
      }
      // What the holding nudged by no more than rounding, put back: else all of it reads as moved, and the collision check below looked over the whole scene each step.
      for (let i = 0; i < this.n; i++) { const k = 3 * i; if (Math.abs(this.x[k] - x0[k]) + Math.abs(this.x[k + 1] - x0[k + 1]) + Math.abs(this.x[k + 2] - x0[k + 2]) < 1e-8) { this.x[k] = x0[k]; this.x[k + 1] = x0[k + 1]; this.x[k + 2] = x0[k + 2]; } }
      ccd.resolve(x0, this.x, this.w);
      steps++;
      // Re-tested near where it crossed; the whole every so often, and the near ones found again.
      if (steps % UNTANGLE_CHECK === 0) { crossings = findCrossings(this.x, m); near = crossings.length ? trianglesNear(this.x, m, crossings, UNTANGLE_REACH) : null; markRegion(); }
      else crossings = findCrossings(this.x, m, near);
    }
    crossings = findCrossings(this.x, m);
    // What could not be untangled stays free of continuous collision, to come apart as it runs.
    ccd.setTangled(crossings);
    return { left: crossings.length, steps };
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
        this.solveDistances(this.edges, this.edgeRest, this.edgeMin, this.edgeAlpha, h2);
        this.solveLimits(h2);
        this.solveRods(h2);
        if (sp === 0) {
          this.solveBends(h2);
        }
        this.boards.solve(this.x, this.w);
        for (let k = 0; k < this.stitchGap.length; k++) {
          if (this.stitchOn[k] && this.stitchSew[k] <= 0) this.project(this.stitches[2 * k], this.stitches[2 * k + 1], 0, 0);
        }
        this.solveTacks();
        this.collide(CLOTH_THICKNESS, false);
      }
      this.collide(CLOTH_THICKNESS, true);
      if (doLayers) {
        this.layers.collide(this.x, this.prev, CLOTH_THICKNESS, this.contactN, this.contactPush, this.contactMu, pass === 0, true);
      }
      if (this.self.active) this.self.collide(this.x, this.prev, pass === 0);
      this.solveTacks();
    }
    this.prev.set(this.x);
    this.v.fill(0);
    this.aim();
  }

  private substep(h: number, env: ClothEnv) {
    if (!this.settled) this.settleNow();
    const { x, prev, v, w, ext, n } = this;
    const [gx, gy, gz] = env.gravity;
    this.time += h;
    const t = this.time;
    // Held by a hand: drawn toward where it is pulled, no faster than a hand
    // pulls cloth, and made heavy rather than fixed, so what it meets still
    // pushes it (fixed, it went through the head and dragged a hood's folds
    // through each other; on a spring, friction on the head held it still).
    if (this.grabbed >= 0 && this.grabTo) {
      const k = 3 * this.grabbed, dx = this.grabTo[0] - x[k], dy = this.grabTo[1] - x[k + 1], dz = this.grabTo[2] - x[k + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz), step = Math.min(1, (GRAB_SPEED * h) / Math.max(d, 1e-12));
      x[k] += dx * step; x[k + 1] += dy * step; x[k + 2] += dz * step;
      v[k] = v[k + 1] = v[k + 2] = 0;
    }
    if (this.zips.length) this.runZips(h);
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
      this.solveDistances(this.edges, this.edgeRest, this.edgeMin, this.edgeAlpha, h2);
      this.solveElastics(h2);
      this.solveLimits(h2);
      this.solveRods(h2);
      // Every pass: once a substep, a stiff piece (a board, heavy leather)
      // bent however stiff its material, held to what one pass could do.
      this.solveBends(h2);
      // Boards held to their shape in their plane, once a substep (a few
      // passes of the rest hold a cloth, not a board; every pass cost a cap
      // a sixth of a second a simulated second and held it no better).
      if (pass === STRETCH_PASSES - 1) this.boards.solve(x, w);
      // Stitches close from their starting gap to nothing over the sew time.
      // A zip's pairs only where it is done up, those its slider has just
      // run together closing from where they were.
      for (let k = 0; k < this.stitchGap.length; k++) {
        if (!this.stitchOn[k]) continue;
        const sew = this.stitchSew[k];
        this.project(this.stitches[2 * k], this.stitches[2 * k + 1], sew <= 0 ? this.stitchClose[k] : this.stitchGap[k] * (1 - Math.min(1, t / sew)), 0);
      }
      if (this.zips.length) this.sliderThroats();
      this.solveTacks();
      this.collide(CLOTH_THICKNESS, false);
      // And on the last pass of every substep: skipped there every other
      // substep, the passes after the first pulled a stiff collar back into
      // the neckerchief under it, and the next substep pushed it out again
      // in one go, back and forth, the collar flickering as it ran.
      if (doLayers && (pass === 0 || pass === STRETCH_PASSES - 1 || this.layerTick === 0)) this.layers.collide(x, prev, CLOTH_THICKNESS, this.contactN, this.contactPush, this.contactMu, pass === 0 && this.layerTick === 0);
      // Once a substep, on the last pass: the constraints have moved the cloth
      // by then, and friction after it holds what this sets.
      if (this.self.active && pass === STRETCH_PASSES - 1) this.self.collide(x, prev, true);
      this.solveTacks();
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
    this.solveTacks();
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

  private solveDistances(pairs: Int32Array, rest: Float64Array, minRest: Float64Array, alpha: Float64Array, h2: number) {
    const { x, w } = this;
    for (let k = 0; k < rest.length; k++) {
      const a = pairs[2 * k], b = pairs[2 * k + 1];
      const ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-12) continue;
      const target = len > rest[k] ? rest[k] : len < minRest[k] ? minRest[k] : len;
      if (target === len) continue;
      const wa = w[a], wb = w[b], ws = wa + wb + alpha[k] / h2;
      if (ws <= 0) continue;
      const c = (len - target) / (ws * len);
      x[ia] -= wa * c * dx; x[ia + 1] -= wa * c * dy; x[ia + 2] -= wa * c * dz;
      x[ib] += wb * c * dx; x[ib + 1] += wb * c * dy; x[ib + 2] += wb * c * dz;
    }
  }

  /**
   * Boning (clothRods): its links held to length, and the length of its
   * curvature vector a + c - 2b at each point toward its modelled one, with
   * compliance h^3 / (E I).
   */
  private solveRods(h2: number) {
    const { x, w } = this, L = this.rodLinks, LR = this.rodLinkRest;
    for (let k = 0; k < LR.length; k++) this.project(L[2 * k], L[2 * k + 1], LR[k], 0);
    const B = this.rodBends, R = this.rodBendRest, A = this.rodBendAlpha;
    for (let k = 0; k < R.length; k++) {
      const a = B[3 * k], b = B[3 * k + 1], c = B[3 * k + 2], ia = 3 * a, ib = 3 * b, ic = 3 * c;
      const vx = x[ia] + x[ic] - 2 * x[ib], vy = x[ia + 1] + x[ic + 1] - 2 * x[ib + 1], vz = x[ia + 2] + x[ic + 2] - 2 * x[ib + 2];
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (len < 1e-12) continue;
      const ws = w[a] + w[c] + 4 * w[b] + A[k] / h2;
      if (ws <= 0) continue;
      const dl = -(len - R[k]) / ws, nx = vx / len, ny = vy / len, nz = vz / len;
      x[ia] += w[a] * dl * nx; x[ia + 1] += w[a] * dl * ny; x[ia + 2] += w[a] * dl * nz;
      x[ic] += w[c] * dl * nx; x[ic + 1] += w[c] * dl * ny; x[ic + 2] += w[c] * dl * nz;
      x[ib] -= 2 * w[b] * dl * nx; x[ib + 1] -= 2 * w[b] * dl * ny; x[ib + 2] -= 2 * w[b] * dl * nz;
    }
  }

  /**
   * Embedded elastic bands: one-sided tension toward the elastic's relaxed
   * length with the band's compliance (rest / stiffness), wound in smoothly
   * over the first 0.35 s so gathered hems and cuffs form soft folds rather
   * than snapping into 1-triangle sawtooth zig-zags on frame 0.
   */
  private solveElastics(h2: number) {
    const { x, w } = this, P = this.elastics, F = this.elasticFlat, R = this.elasticRest, A = this.elasticAlpha;
    const s = Math.min(1, this.time / 0.35);
    for (let k = 0; k < R.length; k++) {
      const a = P[2 * k], b = P[2 * k + 1], ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rest = F[k] + (R[k] - F[k]) * s;
      if (len <= rest || len < 1e-12) continue;
      const wa = w[a], wb = w[b], ws = wa + wb + A[k] / h2;
      if (ws <= 0) continue;
      const c = (len - rest) / (ws * len);
      x[ia] -= wa * c * dx; x[ia + 1] -= wa * c * dy; x[ia + 2] -= wa * c * dz;
      x[ib] += wb * c * dx; x[ib + 1] += wb * c * dy; x[ib + 2] += wb * c * dz;
    }
  }

  /**
   * Tacks: what is sewn onto a garment (pockets, loops, a belt) held at
   * `offset` out along the normal of the garment's triangle under it, at its
   * barycentric point (w0, w1, w2). Both ways, by inverse mass: a belt drawn
   * tight takes the garment in, a pocket's weight hangs on it. A `lift` tack
   * holds only from sliding and from sinking under its offset.
   */
  /** Each tack drawn to its place (only those whose point is in `only`, if given). */
  private solveTacks(only: Uint8Array | null = null) {
    const { x, w } = this, X = this.self.extra;
    for (let i = 0; i < this.tacks.length; i++) {
      const tk = this.tacks[i];
      if (only && !only[tk.p]) continue;
      const ia = 3 * tk.a, ib = 3 * tk.b, ic = 3 * tk.c, ip = 3 * tk.p;
      const ux = x[ib] - x[ia], uy = x[ib + 1] - x[ia + 1], uz = x[ib + 2] - x[ia + 2];
      const vx = x[ic] - x[ia], vy = x[ic + 1] - x[ia + 1], vz = x[ic + 2] - x[ia + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) continue;
      nx /= nl; ny /= nl; nz /= nl;
      // Where it should be, and how far it is from there: its offset, plus
      // the gap the two meshes' sagitta needs (clothSelf), or the layers cross
      // wherever their triangles do not line up.
      const off = tk.offset + X[tk.p] + tk.w0 * X[tk.a] + tk.w1 * X[tk.b] + tk.w2 * X[tk.c];
      const tx = tk.w0 * x[ia] + tk.w1 * x[ib] + tk.w2 * x[ic] + nx * off;
      const ty = tk.w0 * x[ia + 1] + tk.w1 * x[ib + 1] + tk.w2 * x[ic + 1] + ny * off;
      const tz = tk.w0 * x[ia + 2] + tk.w1 * x[ib + 2] + tk.w2 * x[ic + 2] + nz * off;
      let cx = x[ip] - tx, cy = x[ip + 1] - ty, cz = x[ip + 2] - tz;
      if (tk.lift) {
        const out = cx * nx + cy * ny + cz * nz;
        if (out > 0) { cx -= out * nx; cy -= out * ny; cz -= out * nz; }
      }
      const ws = w[tk.p] + tk.w0 * tk.w0 * w[tk.a] + tk.w1 * tk.w1 * w[tk.b] + tk.w2 * tk.w2 * w[tk.c];
      if (ws <= 0) continue;
      const sp = w[tk.p] / ws;
      x[ip] -= sp * cx; x[ip + 1] -= sp * cy; x[ip + 2] -= sp * cz;
      for (const [q, bw] of [[ia, tk.w0], [ib, tk.w1], [ic, tk.w2]] as const) {
        const s = (bw * w[q / 3]) / ws;
        x[q] += s * cx; x[q + 1] += s * cy; x[q + 2] += s * cz;
      }
    }
  }

  /**
   * Strain limits: pairs two edges apart held to at most their flat
   * distance, so stretch cannot spread over a region as the edges alone,
   * each a little over, let it. One-sided: they do nothing when slack.
   * (Compliant up to the fabric's give instead, a shade sail no longer held
   * still in wind, and nothing passed that failed hard: measured 2026-11-07.)
   */
  private solveLimits(h2: number) {
    const { x, w } = this, P = this.limits, R = this.limitRest;
    void h2;
    for (let k = 0; k < R.length; k++) {
      const a = P[2 * k], b = P[2 * k + 1], ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len <= R[k]) continue;
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
  renderLayout(): { name: string; vertadr: number; vertnum: number; elems: number[]; rgba: number[]; material: ClothMaterialName; flat?: FlatPattern; trims?: ClothTrim[]; pattern?: ClothPatternPrint }[] {
    const out: ReturnType<ClothSim['renderLayout']> = [];
    let adr = 0;
    for (const { model } of this.pieces) for (const g of model.groups) {
      out.push({ name: g.name, vertadr: adr, vertnum: g.particles.length, elems: g.tris.slice(), rgba: g.rgba, material: g.material, flat: g.flat, trims: g.trims, pattern: g.pattern });
      adr += g.particles.length;
    }
    return out;
  }

  /**
   * A point of the cloth held and drawn toward `to` (world, metres), as a hand
   * pulls it while the scene runs (a hood pulled down), by its index as drawn
   * (writeRender's order); null lets it go, still.
   */
  grab(renderIndex: number | null, to: number[] | null) {
    let particle = -1;
    if (renderIndex !== null) {
      let o = 0;
      for (const { model, base } of this.pieces) for (const g of model.groups) {
        if (particle < 0 && renderIndex < o + g.particles.length) particle = base + g.particles[renderIndex - o];
        o += g.particles.length;
      }
    }
    if (particle !== this.grabbed) {
      if (this.grabbed >= 0) {
        // Let go where it is, not flung by the last pull.
        const k = 3 * this.grabbed;
        this.w[this.grabbed] = this.grabW;
        this.v[k] = this.v[k + 1] = this.v[k + 2] = 0;
      }
      this.grabbed = particle;
      if (particle >= 0) { this.grabW = this.w[particle]; this.w[particle] = this.grabW / GRAB_HEAVY; }
    }
    this.grabTo = particle >= 0 && to ? to.slice(0, 3) : null;
  }

  /**
   * Zips (ClothModel.zips). Each substep: a slider being moved goes on along
   * its zip toward where it is wanted, no faster than a hand pulls cloth, the
   * teeth it passes shutting under it and opening over it; and the pairs it
   * has run together close.
   */
  private runZips(h: number) {
    for (const z of this.zips) {
      if (z.want !== z.fastened) {
        const step = (GRAB_SPEED * h) / Math.max(z.length, 1e-3);
        z.fastened = z.want > z.fastened ? Math.min(z.want, z.fastened + step) : Math.max(z.want, z.fastened - step);
        this.shutZip(z);
      }
      for (const k of z.stitch) if (this.stitchClose[k] > 0) this.stitchClose[k] = Math.max(0, this.stitchClose[k] - ZIP_CLOSE_SPEED * h);
    }
  }

  /** A zip's pairs held where it is done up and let go above: those newly shut close from where they are. */
  private shutZip(z: ClothSim['zips'][number]) {
    const x = this.x;
    z.stitch.forEach((k, j) => {
      const on = z.at[j] <= z.fastened + 1e-9;
      if (on === !!this.stitchOn[k]) return;
      this.stitchOn[k] = on ? 1 : 0;
      if (!on) { this.stitchClose[k] = 0; return; }
      const a = 3 * this.stitches[2 * k], b = 3 * this.stitches[2 * k + 1];
      this.stitchSew[k] = 0;
      this.stitchClose[k] = Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2]);
    });
  }

  /**
   * The slider's throat: in it, just over where the teeth meet, the two sides
   * held apart, wider toward its top, as a slider's wedge parts them. Above
   * it they hang as they will.
   */
  private sliderThroats() {
    const x = this.x;
    for (const z of this.zips) {
      const reach = SLIDER_LONG / Math.max(z.length, 1e-3);
      z.stitch.forEach((k, j) => {
        const above = z.at[j] - z.fastened;
        if (above <= 1e-9 || above > reach) return;
        const a = this.stitches[2 * k], b = this.stitches[2 * k + 1], ia = 3 * a, ib = 3 * b;
        const apart = SLIDER_THROAT * (above / reach), d = Math.hypot(x[ia] - x[ib], x[ia + 1] - x[ib + 1], x[ia + 2] - x[ib + 2]);
        if (d < apart && d > 1e-9) this.project(a, b, apart, 0);
      });
    }
  }

  /** Where along zip `z` (0-1 up its run) the cloth's line now comes nearest `p`, and how near (m). */
  private alongZip(z: ClothSim['zips'][number], p: number[], from = 0, to = 1): { at: number; d: number } {
    const x = this.x, mid = (j: number, c: number) => (x[3 * this.stitches[2 * z.stitch[j]] + c] + x[3 * this.stitches[2 * z.stitch[j] + 1] + c]) / 2;
    let best = { at: z.fastened, d: Infinity };
    for (let j = 0; j + 1 < z.stitch.length; j++) {
      if (z.at[j + 1] < from || z.at[j] > to) continue;
      const ax = mid(j, 0), ay = mid(j, 1), az = mid(j, 2), ux = mid(j + 1, 0) - ax, uy = mid(j + 1, 1) - ay, uz = mid(j + 1, 2) - az;
      const uu = ux * ux + uy * uy + uz * uz;
      // Not across a gap (two runs of one trim, each its own opening).
      if (uu > 0.05 * 0.05) continue;
      const u = uu > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * ux + (p[1] - ay) * uy + (p[2] - az) * uz) / uu)) : 0;
      const d = Math.hypot(ax + ux * u - p[0], ay + uy * u - p[1], az + uz * u - p[2]);
      if (d < best.d) best = { at: z.at[j] + (z.at[j + 1] - z.at[j]) * u, d };
    }
    return best;
  }

  /**
   * The zip whose slider, or the pull hanging below it, is at `point`
   * (world, m): within ZIP_REACH of its line from the pull's end to the
   * slider's top. -1 if none.
   */
  zipAt(point: number[]): number {
    let best = -1, bd = ZIP_REACH;
    this.zips.forEach((z, i) => {
      const L = Math.max(z.length, 1e-3), { d } = this.alongZip(z, point, z.fastened - PULL_HANGS / L, z.fastened + (0.5 * SLIDER_LONG) / L);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /**
   * Zip `zip`'s slider held and drawn toward `to` (world, m), as a hand pulls
   * it: it moves along the zip to where the cloth's line now comes nearest,
   * not off it; the cloth is not pulled. Null lets it go where it is.
   */
  grabZip(zip: number | null, to: number[] | null) {
    const was = this.zips[this.zipGrabbed];
    if (was && zip !== this.zipGrabbed) was.want = was.fastened;
    this.zipGrabbed = zip ?? -1;
    const z = this.zips[this.zipGrabbed];
    if (!z) return;
    z.want = to ? Math.max(0, Math.min(1, this.alongZip(z, to).at)) : z.fastened;
  }

  /** How far each zip is done up (0-1 from the bottom), by its cloth and its index in the garment's trims. */
  zipState(): { cloth: string; trim: number; fastened: number }[] {
    return this.zips.map((z) => ({ cloth: z.cloth, trim: z.trim, fastened: z.fastened }));
  }

  /** Does a zip up as far as `fastened` (0-1) at once, as it runs; false if the cloth has no such zip. */
  setZip(cloth: string, trim: number, fastened: number): boolean {
    const z = this.zips.find((q) => q.cloth === cloth && q.trim === trim);
    if (!z) return false;
    z.fastened = z.want = Math.max(0, Math.min(1, fastened));
    this.shutZip(z);
    return true;
  }

  renderSize(): number {
    return this.pieces.reduce((s, { model }) => s + model.groups.reduce((t, g) => t + g.particles.length, 0), 0);
  }

  /** The pull on each tie, newtons, as of the last substep. */
  tieLoads(): { name: string; newtons: number }[] {
    return this.ties.map((t) => ({ name: t.name, newtons: t.lambda }));
  }

  /** Positions and velocities, and how far each stitch is sewn, to carry the cloth across a rebuild. */
  state() { return { x: Float64Array.from(this.x), v: Float64Array.from(this.v), time: this.time, stitchSew: Float64Array.from(this.stitchSew), stitchGap: Float64Array.from(this.stitchGap), stitchOn: Uint8Array.from(this.stitchOn), stitchClose: Float64Array.from(this.stitchClose), zips: this.zips.map((z) => z.fastened) }; }
  restore(s: { x: Float64Array; v: Float64Array; time: number; stitchSew?: Float64Array; stitchGap?: Float64Array; stitchOn?: Uint8Array; stitchClose?: Float64Array; zips?: number[] }) {
    if (s.x.length !== this.x.length) return false;
    this.x.set(s.x); this.v.set(s.v); this.prev.set(s.x); this.time = s.time; this.settled = true;
    // Its seams as sewn as they were: carried without, every stitch the
    // settle had sewn shut was held at the gap it started at, and on Run a
    // hood split open over the crown and a neckerchief tore off its band.
    if (s.stitchSew && s.stitchGap && s.stitchSew.length === this.stitchSew.length) { this.stitchSew.set(s.stitchSew); this.stitchGap.set(s.stitchGap); }
    // Its zips as far done up as they were.
    if (s.stitchOn && s.stitchClose && s.zips && s.stitchOn.length === this.stitchOn.length && s.zips.length === this.zips.length) {
      this.stitchOn.set(s.stitchOn); this.stitchClose.set(s.stitchClose);
      this.zips.forEach((z, i) => { z.fastened = z.want = s.zips![i]; });
    }
    this.clearBudget.fill(0);
    // Carried as it was: what it carries crossed (none, once built so) left free to come apart.
    const m = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches)), crossings = findCrossings(this.x, m);
    this.ccdOf().setTangled(crossings);
    this.ccdFrom = Float64Array.from(this.x); this.ccdSince = 0;
    return true;
  }
}
