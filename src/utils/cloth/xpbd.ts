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
import type { AeroSnapEvent, AeroVoiceTelemetry, ClothTieImpactEvent } from '../../workers/physicsWorkerProtocol';
import { LayerContacts } from './clothLayers';
import { SelfContacts } from './clothSelf';
import { BoardShapes, type Board } from './clothBoards';
import { contourStep, findCrossings, trianglesNear, untangleMesh, type UntangleMesh } from './clothUntangle';
import { ClothCcd } from './clothCcd';
import { colliderContactInto, colliderLipschitz, type Collider, type ContactOut } from './clothColliders';
import { clothBendRigidity } from './clothMesh';

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
/** How near (m, box to box) a cloth carried over a rebuild must be to one that changed to be let move as that settles (carryCloths). */
const CARRY_REACH = 0.03;
/**
 * The most wall-clock time the sewing and settling before the first frame may
 * take, ms. A garment built badly through itself (a ruffle sewn in a spiral
 * tighter than it is wide, every turn hanging through the next) kept
 * continuous collision busy for 25 minutes and the worker answered nothing;
 * past this, what is not yet sewn finishes sewing as the scene runs.
 */
let SETTLE_BUDGET_MS = 20000;

/**
 * How long the settle before the first frame may run, in wall-clock ms. The
 * browser keeps 20 s so a tab stays responsive; the tests set Infinity, because
 * a wall-clock cut makes what they measure depend on how busy the machine is
 * (urban_collection settled on an idle machine and not on a loaded CI runner).
 */
export function setSettleBudgetMs(ms: number): void {
  SETTLE_BUDGET_MS = ms;
}

/**
 * How long the untangle after the settle may run, in wall-clock ms (it also
 * stops at UNTANGLE_MAX passes). Tests set Infinity for the same reason as the
 * settle: a 3 s cut gave a CI runner fewer passes than a desk machine, and
 * collar and dart measures landed either side of their bounds.
 */
export function setUntangleBudgetMs(ms: number): void {
  UNTANGLE_BUDGET = ms;
}
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
/** Untangling (clothUntangle): how far a contour moves a step, and how near a crossing is re-tested. */
const UNTANGLE_STEP = 0.0005;
const UNTANGLE_REACH = 0.05;
/** Untangling at the build: at most this many steps, the whole checked again every so many, stopping when global crossings stop falling for `UNTANGLE_STALL` steps. */
const UNTANGLE_MAX = 1500, UNTANGLE_CHECK = 25, UNTANGLE_STALL = 150;
/** And for no longer than this at the build, ms: what is left stays free of continuous collision, to come apart as it runs. */
let UNTANGLE_BUDGET = 3000;
/**
 * Continuous collision over this many substeps at a time (each stretch's end
 * is what is kept), and whatever is left before the cloth is drawn or read
 * (collidePending), so no state is shown that it has not passed. Read between looks, a
 * pleated skirt showed up to 16 crossings that the next look then undid.
 * (An unpressed pleated skirt once blew up at 8: its panels' unused shell
 * points, fixed and on no triangle, were taken for cloth and held impact
 * zones still; clothCcd now looks at cloth points only.)
 */
const CCD_EVERY = 8;

const SKIN_FRICTION = 0.02;

/**
 * Force square to a sheet, over dynamic pressure times area, with the flow at
 * `alpha` to its plane: smooth monotonic Kirchhoff/Hoerner normal force rising
 * linearly like a thin membrane at small angles and saturating smoothly to the
 * bluff-plate `cd * sin(alpha)` at 90 degrees without a negative-slope stall kink.
 * `cd` below a solid sheet's 1.2 is an open weave, and scales the whole curve.
 */
export function clothNormalCoefficient(alpha: number, cd: number): number {
  const s = Math.sin(Math.max(0, Math.min(Math.PI / 2, alpha)));
  // Smooth Hoerner/Rayleigh flat-plate normal coefficient: ~2*pi*alpha/(1 + ...)
  // monotonically rising from 0 to cd at 90 deg with zero negative slope.
  return cd * ((2.2 * s) / (1 + 1.2 * s));
}

export interface ClothEnv {
  gravity: [number, number, number];
  wind: [number, number, number];
  airDensity: number;
  /** Optional spatially varying gust wind sampler `(wx, wy, x, y, z, t) => [gx, gy, gz]`. */
  gustAt?: (wx: number, wy: number, x: number, y: number, z: number, timeSec: number) => [number, number, number];
}

interface Piece {
  model: ClothModel;
  base: number; // first particle
}

interface SlenderWakeCylinder {
  ci: number;
  diam: number;
  axLocal: [number, number, number];
  bxLocal: [number, number, number];
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
}

export class ClothSim {
  readonly n: number;
  readonly x: Float64Array;
  private prev: Float64Array;
  private v: Float64Array;
  private w: Float64Array;
  private ext: Float64Array;
  private pieces: Piece[];
  private edges: Int32Array; private edgeRest: Float64Array; private edgeMin: Float64Array; private edgeAlpha: Float64Array; private edgeLambda: Float64Array;
  private elastics: Int32Array; private elasticFlat: Float64Array; private elasticRest: Float64Array; private elasticAlpha: Float64Array; private elasticLambda: Float64Array;
  private boards: BoardShapes;
  private grabbed = -1; private grabTo: number[] | null = null;
  private grabPatch: { p: number; origW: number; wt: number }[] = [];
  private bends: Int32Array; private bendWeights: Float64Array; private bendAlpha: Float64Array; private bendRest: Float64Array; private bendSign: Int8Array;
  /** Each bend's Lagrange multiplier over a substep's passes (XPBD), so passes converge on its compliance instead of each adding its own correction. */
  private bendLambda: Float64Array;
  private limits: Int32Array; private limitRest: Float64Array;
  private stitches: Int32Array; private stitchGap: Float64Array; private stitchSew: Float64Array;
  /** Whether each stitch holds (a zip's pair, only where it is done up), and the gap a zip's pair is closing from (m, down to 0 at ZIP_CLOSE_SPEED). */
  private stitchOn: Uint8Array; private stitchClose: Float64Array;
  /** Each cloth's own stitches, [from, to) in `stitches`; and the stitches of ties from one cloth to another, which come after them. */
  private pieceStitchFrom: Int32Array; private pieceStitchTo: Int32Array;
  private tieStitches: { k: number; from: number; to: number }[] = [];
  /**
   * Set by `carryCloths`: which particles were carried over as they were
   * (held still while the rest is sewn and settled unless `carryFree`), and
   * the clock and accumulator the carried cloth was at.
   */
  private carryHeld: Uint8Array | null = null;
  private carryFree: Uint8Array | null = null;
  private carryPiece: Uint8Array | null = null;
  private carryStitch: Uint8Array | null = null;
  /** Which cloths a settle after carrying (carryCloths) needs: what moves, and what it can meet. */
  private carryInvolved: boolean[] | null = null;
  /** The lookups the colliders and ties were last posed from (setPoses), to pose a sim of some of this cloth alike. */
  private posedBy: [(body: string) => THREE.Matrix4 | null, (geom: number) => THREE.Matrix4 | null] | null = null;
  private carryClock = 0; private carryAccumulator = 0;
  /** Each zip: its cloth, its trim, its pairs' stitches and places up the run (0-1), its length (m), how far it is done up and where its slider is being moved to. */
  private zips: { cloth: string; trim: number; stitch: Int32Array; at: Float64Array; length: number; fastened: number; want: number }[] = [];
  private zipGrabbed = -1;
  private rodLinks: Int32Array; private rodLinkRest: Float64Array; private rodBends: Int32Array; private rodBendRest: Float64Array; private rodBendAlpha: Float64Array; private rodBendLambda: Float64Array; private rodBendDir: Float64Array;
  private tackP: Int32Array; private tackA: Int32Array; private tackB: Int32Array; private tackC: Int32Array;
  private tackW0: Float64Array; private tackW1: Float64Array; private tackW2: Float64Array; private tackOff: Float64Array; private tackLift: Uint8Array;
  private ties: { name: string; p: number; body: string | null; anchor: number[] | null; anchorWorld: number[] | null; from: number[]; sew: number; lambda: number }[];
  private tris: Int32Array; private triCd: Float64Array; private triPiece: Int32Array;
  private edgePiece: Int32Array; private edgePrevLen: Float64Array;
  private bendPiece: Int32Array; private bendSpanInv: Float64Array; private bendPrevC: Float64Array; private bendCurC: Float64Array;
  private wakeCylinders: SlenderWakeCylinder[] = [];
  private pieceFlatArea: Float64Array;
  private pieceChord: Float64Array;
  private pieceAccForceSum: Float64Array;
  private pieceAccRelSpeedAreaSum: Float64Array;
  private pieceAccAlphaAreaSum: Float64Array;
  private pieceAccAreaSum: Float64Array;
  private pieceAccTipMax: Float64Array;
  private pieceAccBendRateSum: Float64Array;
  private pieceAccBendCount: Int32Array;
  private pieceAccStrainRateSum: Float64Array;
  private pieceAccStrainCount: Int32Array;
  private pieceSubstepsCounted: Int32Array;
  private witnessParticles: Int32Array;
  private witnessPiece: Int32Array;
  private witnessEffMass: Float64Array;
  private witnessTris: Int32Array;
  private witnessTriOffsets: Int32Array;
  private witnessEdges: Int32Array;
  private witnessEdgeOffsets: Int32Array;
  private witnessPrevVNorm: Float64Array;
  private witnessPrevSpeedSq: Float64Array;
  private witnessPrevTension: Float64Array;
  private witnessPrevRelSpeed: Float64Array;
  private witnessLastSnapTime: Float64Array;
  private witnessInit: Uint8Array;
  private snapSeqCounter = 0;
  private pendingSnaps: AeroSnapEvent[] = [];
  private tiePrevLambda: Float64Array;
  private tieFastLambda: Float64Array;
  private tieAvgLambda: Float64Array;
  private tieMinLambdaWindow: Float64Array;
  private tieLastImpactTime: Float64Array;
  private tieInit: Uint8Array;
  private pendingTieImpacts: ClothTieImpactEvent[] = [];
  private floatUntil: Float64Array;
  private maxFloatUntil = 0;
  private colliders: Collider[];
  private contactN: Float64Array; private contactPush: Float64Array; private contactMu: Float64Array; private contactHeld: Float64Array; private contactDisp: Float64Array;
  private world: THREE.Matrix4[]; private inv: THREE.Matrix4[];
  private prevWorld: THREE.Matrix4[]; private worldInit: Uint8Array;
  private substepMoveScale = 1;
  private worldBox: Float64Array;
  private poseCorner = new THREE.Vector3();
  private posePoint = new THREE.Vector3();
  private poseIdentity = new THREE.Matrix4();
  private hitScratch: ContactOut = { d: 0, nx: 0, ny: 0, nz: 0 };
  private layers: LayerContacts;
  private self: SelfContacts;
  private layerTick = 0;
  /**
   * How far each particle can move before it could reach a body, from its
   * nearest at the last look; until it has, it is not looked at again. Most
   * of a garment hangs clear of the form most of the time.
   */
  private clearBudget: Float64Array;
  private nearest: Float64Array;
  private skip: Uint8Array;
  private activeCollideIdx: Int32Array;
  /**
   * Per particle and collider, the distance it read last, where the particle
   * was, and the collider's pose then (colGen; -1 none): a point that cannot
   * have come within the margin since (the distance changes no faster than
   * colLip per metre) is not asked again in a pass that only pushes. Null
   * where the table would be too large.
   */
  private colD: Float64Array | null = null;
  private colP: Float64Array | null = null;
  private colAt: Int32Array | null = null;
  private colGen: Int32Array;
  private colLip: Float64Array;
  private accumulator = 0;
  /** Cloth against cloth along each stretch of substeps (clothCcd): where the stretch began, and how many substeps it is. */
  private ccd: ClothCcd | null = null;
  private ccdFrom: Float64Array | null = null;
  private ccdBefore: Float64Array;
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
    const E: number[] = [], ER: number[] = [], EM: number[] = [], EA: number[] = [], EP: number[] = [];
    const B: number[] = [], BR: number[] = [], BA: number[] = [], BC: number[] = [], BS: (number | undefined)[] = [], BP: number[] = [], BSI: number[] = [];
    const EL: number[] = [], ELF: number[] = [], ELR: number[] = [], ELA: number[] = [];
    const RL: number[] = [], RLR: number[] = [], RB: number[] = [], RBR: number[] = [], RBA: number[] = [];
    const S: number[] = [], SS: number[] = [], T: number[] = [], TC: number[] = [], TP: number[] = [], LP: number[] = [], LR: number[] = [];
    const tacksList: { p: number; a: number; b: number; c: number; w0: number; w1: number; w2: number; offset: number; lift: boolean }[] = [];
    this.ties = [];
    const nPieces = this.pieces.length;
    this.pieceStitchFrom = new Int32Array(nPieces); this.pieceStitchTo = new Int32Array(nPieces);
    this.pieceFlatArea = new Float64Array(nPieces);
    this.pieceChord = new Float64Array(nPieces);
    this.pieceAccForceSum = new Float64Array(nPieces);
    this.pieceAccRelSpeedAreaSum = new Float64Array(nPieces);
    this.pieceAccAlphaAreaSum = new Float64Array(nPieces);
    this.pieceAccAreaSum = new Float64Array(nPieces);
    this.pieceAccTipMax = new Float64Array(nPieces);
    this.pieceAccBendRateSum = new Float64Array(nPieces);
    this.pieceAccBendCount = new Int32Array(nPieces);
    this.pieceAccStrainRateSum = new Float64Array(nPieces);
    this.pieceAccStrainCount = new Int32Array(nPieces);
    this.pieceSubstepsCounted = new Int32Array(nPieces);

    for (let pi = 0; pi < nPieces; pi++) {
      const { model: m, base } = this.pieces[pi];
      this.x.set(m.x0, 3 * base);
      this.w.set(m.invMass, base);
      const mat = m.material;
      // Stretch: an edge's compliance is the inverse of the sheet's stiffness
      // (E t, N/m). Bending: the sheet's flexural rigidity (N m).
      const stretchAlpha = 1 / Math.max(1, mat.young * mat.thickness);
      const bendK = clothBendRigidity(mat);
      for (let k = 0; k < m.edges.length; k += 2) {
        const rest = m.edgeRest[k / 2];
        E.push(base + m.edges[k], base + m.edges[k + 1]);
        ER.push(rest);
        EM.push(m.edgeMin ? m.edgeMin[k / 2] : rest);
        EA.push(stretchAlpha / (m.edgeStiffness?.[k / 2] ?? 1));
        EP.push(pi);
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
          tacksList.push({
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
      m.bendArea.forEach((A, k) => {
        BA.push(A / (3 * Math.max(1e-12, bendK * (m.bendStiffness?.[k] ?? 1))));
        BP.push(pi);
        BSI.push(1 / Math.max(0.008, Math.sqrt(Math.max(1e-6, A))));
      });
      // Not spread: a gown has more stencils than a worker's stack has room for arguments.
      for (let k = 0; k < m.bendRest.length; k++) {
        BC.push(m.bendRest[k]);
        BS.push(m.bendSign ? m.bendSign[k] : undefined);
      }
      for (let k = 0; k < m.limits.length; k += 2) { LP.push(base + m.limits[k], base + m.limits[k + 1]); LR.push(m.limitRest[k / 2]); }
      this.pieceStitchFrom[pi] = S.length / 2;
      for (let k = 0; k < m.stitches.length; k += 2) {
        S.push(base + m.stitches[k], base + m.stitches[k + 1]);
        SS.push(m.stitchSew ? m.stitchSew[k / 2] : m.sewTime);
      }
      this.pieceStitchTo[pi] = S.length / 2;
      let flatArea = 0;
      let minX0 = Infinity, maxX0 = -Infinity, minY0 = Infinity, maxY0 = -Infinity, minZ0 = Infinity, maxZ0 = -Infinity;
      for (let vp = 0; vp < m.x0.length; vp += 3) {
        const px = m.x0[vp], py = m.x0[vp + 1], pz = m.x0[vp + 2];
        if (px < minX0) minX0 = px; if (px > maxX0) maxX0 = px;
        if (py < minY0) minY0 = py; if (py > maxY0) maxY0 = py;
        if (pz < minZ0) minZ0 = pz; if (pz > maxZ0) maxZ0 = pz;
      }
      for (let k = 0; k < m.tris.length; k += 3) {
        const ia = m.tris[k], ib = m.tris[k + 1], ic = m.tris[k + 2];
        T.push(base + ia, base + ib, base + ic);
        TC.push(mat.windCd);
        TP.push(pi);
        const ux = m.x0[3 * ib] - m.x0[3 * ia], uy = m.x0[3 * ib + 1] - m.x0[3 * ia + 1], uz = m.x0[3 * ib + 2] - m.x0[3 * ia + 2];
        const vx = m.x0[3 * ic] - m.x0[3 * ia], vy = m.x0[3 * ic + 1] - m.x0[3 * ia + 1], vz = m.x0[3 * ic + 2] - m.x0[3 * ia + 2];
        flatArea += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      }
      this.pieceFlatArea[pi] = Math.max(1e-5, flatArea);
      const spanHoriz = Math.hypot(maxX0 - minX0, maxY0 - minY0);
      const spanMax = Math.max(spanHoriz, maxZ0 - minZ0);
      this.pieceChord[pi] = Math.max(0.04, spanHoriz > 0.05 ? spanHoriz : Math.sqrt(Math.max(1e-4, flatArea)) || spanMax);
      for (const t of m.ties) if (!t.cloth) this.ties.push({ name: t.name, p: base + t.particle, body: t.body, anchor: t.anchor, anchorWorld: null, from: [], sew: m.sewTime, lambda: 0 });
      // Held weightless while its stitches close, as garment CAD sews: falling
      // meanwhile would drop the pieces before they meet.
      const hasClosingStitches = m.stitches.length > 0 && (!m.stitchSew || m.stitchSew.some((st) => st > 0));
      if (hasClosingStitches) {
        this.floatUntil.fill(m.sewTime, base, base + m.x0.length / 3);
        if (m.sewTime > this.maxFloatUntil) this.maxFloatUntil = m.sewTime;
      }
    }
    const nTacks = tacksList.length;
    this.tackP = new Int32Array(nTacks); this.tackA = new Int32Array(nTacks); this.tackB = new Int32Array(nTacks); this.tackC = new Int32Array(nTacks);
    this.tackW0 = new Float64Array(nTacks); this.tackW1 = new Float64Array(nTacks); this.tackW2 = new Float64Array(nTacks);
    this.tackOff = new Float64Array(nTacks); this.tackLift = new Uint8Array(nTacks);
    for (let i = 0; i < nTacks; i++) {
      const tk = tacksList[i];
      this.tackP[i] = tk.p; this.tackA[i] = tk.a; this.tackB[i] = tk.b; this.tackC[i] = tk.c;
      this.tackW0[i] = tk.w0; this.tackW1[i] = tk.w1; this.tackW2[i] = tk.w2;
      this.tackOff[i] = tk.offset; this.tackLift[i] = tk.lift ? 1 : 0;
    }
    // Ties to another cloth: sewn to its nearest point where the two start,
    // the stitch closing over the sew time.
    for (const [pi, { model: m, base }] of this.pieces.entries()) {
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
        if (best >= 0) { this.tieStitches.push({ k: S.length / 2, from: pi, to: this.pieces.indexOf(target) }); S.push(base + t.particle, target.base + best); SS.push(m.sewTime); }
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
    this.edges = Int32Array.from(E); this.edgeRest = Float64Array.from(ER); this.edgeMin = Float64Array.from(EM); this.edgeAlpha = Float64Array.from(EA); this.edgeLambda = new Float64Array(ER.length);
    this.edgePiece = Int32Array.from(EP); this.edgePrevLen = Float64Array.from(ER);
    this.rodLinks = Int32Array.from(RL); this.rodLinkRest = Float64Array.from(RLR); this.rodBends = Int32Array.from(RB); this.rodBendRest = Float64Array.from(RBR); this.rodBendAlpha = Float64Array.from(RBA); this.rodBendLambda = new Float64Array(RBR.length);
    this.rodBendDir = new Float64Array(3 * RBR.length);
    for (let k = 0; k < RBR.length; k++) {
      if (RBR[k] <= 1e-9) continue;
      const ia = 3 * this.rodBends[3 * k], ib = 3 * this.rodBends[3 * k + 1], ic = 3 * this.rodBends[3 * k + 2];
      const vx = this.x[ia] + this.x[ic] - 2 * this.x[ib], vy = this.x[ia + 1] + this.x[ic + 1] - 2 * this.x[ib + 1], vz = this.x[ia + 2] + this.x[ic + 2] - 2 * this.x[ib + 2];
      const l = Math.hypot(vx, vy, vz);
      if (l > 1e-12) { this.rodBendDir[3 * k] = vx / l; this.rodBendDir[3 * k + 1] = vy / l; this.rodBendDir[3 * k + 2] = vz / l; }
    }
    this.elastics = Int32Array.from(EL); this.elasticFlat = Float64Array.from(ELF); this.elasticRest = Float64Array.from(ELR); this.elasticAlpha = Float64Array.from(ELA); this.elasticLambda = new Float64Array(ELR.length);
    this.bends = Int32Array.from(B); this.bendWeights = Float64Array.from(BR); this.bendAlpha = Float64Array.from(BA); this.bendRest = Float64Array.from(BC); this.bendLambda = new Float64Array(BA.length);
    this.bendPiece = Int32Array.from(BP); this.bendSpanInv = Float64Array.from(BSI);
    this.bendPrevC = Float64Array.from(BC); this.bendCurC = Float64Array.from(BC);
    this.bendSign = new Int8Array(BA.length);
    for (let s = 0; s < BA.length; s++) {
      if (this.bendRest[s] <= 1e-9) continue;
      if (BS[s] !== undefined) {
        this.bendSign[s] = BS[s]!;
        continue;
      }
      const i0 = 3 * this.bends[4 * s], i1 = 3 * this.bends[4 * s + 1], i2 = 3 * this.bends[4 * s + 2], i3 = 3 * this.bends[4 * s + 3];
      const e0x = this.x[i1] - this.x[i0], e0y = this.x[i1 + 1] - this.x[i0 + 1], e0z = this.x[i1 + 2] - this.x[i0 + 2];
      const e1x = this.x[i2] - this.x[i0], e1y = this.x[i2 + 1] - this.x[i0 + 1], e1z = this.x[i2 + 2] - this.x[i0 + 2];
      const e2x = this.x[i3] - this.x[i0], e2y = this.x[i3 + 1] - this.x[i0 + 1], e2z = this.x[i3 + 2] - this.x[i0 + 2];
      // Oriented hinge bisector: n_tri(0,1,2) + n_tri(0,3,1) = e0 x (e1 - e2).
      const d12x = e1x - e2x, d12y = e1y - e2y, d12z = e1z - e2z;
      const hx = e0y * d12z - e0z * d12y, hy = e0z * d12x - e0x * d12z, hz = e0x * d12y - e0y * d12x;
      let vx = 0, vy = 0, vz = 0;
      for (let j = 0; j < 4; j++) {
        const idx = 3 * this.bends[4 * s + j], kw = this.bendWeights[4 * s + j];
        vx += kw * this.x[idx]; vy += kw * this.x[idx + 1]; vz += kw * this.x[idx + 2];
      }
      const dot = vx * hx + vy * hy + vz * hz;
      if (Math.abs(dot) > 1e-18) this.bendSign[s] = dot >= 0 ? 1 : -1;
    }
    this.limits = Int32Array.from(LP); this.limitRest = Float64Array.from(LR);
    this.stitches = Int32Array.from(S); this.stitchSew = Float64Array.from(SS); this.stitchGap = new Float64Array(S.length / 2);
    this.stitchOn = new Uint8Array(S.length / 2).fill(1); this.stitchClose = new Float64Array(S.length / 2);
    for (const z of this.zips) z.stitch.forEach((k, j) => { this.stitchOn[k] = z.at[j] <= z.fastened + 1e-9 ? 1 : 0; });
    this.tris = Int32Array.from(T); this.triCd = Float64Array.from(TC); this.triPiece = Int32Array.from(TP);
    this.colliders = colliders;
    this.wakeCylinders = [];
    for (let ci = 0; ci < colliders.length; ci++) {
      const sh = colliders[ci].shape;
      if (sh.kind !== 'cylinder' && sh.kind !== 'capsule') continue;
      const diam = 2 * sh.r;
      if (diam < 0.01 || diam > 0.25) continue;
      const lenAxis = Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1], sh.b[2] - sh.a[2]);
      const fullLen = sh.kind === 'capsule' ? lenAxis + diam : lenAxis;
      if (fullLen / diam < 5) continue;
      this.wakeCylinders.push({
        ci,
        diam,
        axLocal: [sh.a[0], sh.a[1], sh.a[2]],
        bxLocal: [sh.b[0], sh.b[1], sh.b[2]],
        ax: sh.a[0], ay: sh.a[1], az: sh.a[2],
        bx: sh.b[0], by: sh.b[1], bz: sh.b[2],
      });
    }
    this.contactN = new Float64Array(3 * n); this.contactPush = new Float64Array(n); this.contactMu = new Float64Array(n); this.contactHeld = new Float64Array(n); this.contactDisp = new Float64Array(3 * n);
    this.world = colliders.map(() => new THREE.Matrix4());
    this.prevWorld = colliders.map(() => new THREE.Matrix4());
    this.worldInit = new Uint8Array(colliders.length);
    this.inv = colliders.map(() => new THREE.Matrix4());
    this.worldBox = new Float64Array(6 * colliders.length);
    this.ccdBefore = new Float64Array(3 * n);
    this.layers = new LayerContacts(this.pieces, this.w);
    this.self = new SelfContacts(this.pieces, this.w, this.stitches, this.x);
    const boards: Board[] = [];
    for (const pc of this.pieces) for (const b of pc.model.boards ?? []) boards.push({ ...b, particles: b.particles.map((q) => pc.base + q) });
    this.boards = new BoardShapes(boards, this.n);
    this.clearBudget = new Float64Array(n); this.nearest = new Float64Array(n); this.skip = new Uint8Array(n); this.activeCollideIdx = new Int32Array(n);
    this.colGen = new Int32Array(colliders.length);
    this.colLip = Float64Array.from(colliders, (c) => colliderLipschitz(c));
    if (n * colliders.length <= 4_000_000) {
      this.colD = new Float64Array(n * colliders.length);
      this.colP = new Float64Array(3 * n * colliders.length);
      this.colAt = new Int32Array(n * colliders.length).fill(-1);
    }
    this.tiePrevLambda = new Float64Array(this.ties.length);
    this.tieFastLambda = new Float64Array(this.ties.length);
    this.tieAvgLambda = new Float64Array(this.ties.length);
    this.tieMinLambdaWindow = new Float64Array(this.ties.length);
    this.tieLastImpactTime = new Float64Array(this.ties.length).fill(-1);
    this.tieInit = new Uint8Array(this.ties.length);
    this.witnessParticles = new Int32Array(0);
    this.witnessPiece = new Int32Array(0);
    this.witnessEffMass = new Float64Array(0);
    this.witnessTris = new Int32Array(0);
    this.witnessTriOffsets = new Int32Array(1);
    this.witnessEdges = new Int32Array(0);
    this.witnessEdgeOffsets = new Int32Array(1);
    this.witnessPrevVNorm = new Float64Array(0);
    this.witnessPrevSpeedSq = new Float64Array(0);
    this.witnessPrevTension = new Float64Array(0);
    this.witnessPrevRelSpeed = new Float64Array(0);
    this.witnessLastSnapTime = new Float64Array(0);
    this.witnessInit = new Uint8Array(0);
    this.initAeroWitnesses();
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

  /** Whether adding `dt` will trigger at least one substep in `advance(dt)`. */
  willSubstep(dt: number): boolean {
    return this.accumulator + dt >= CLOTH_SUBSTEP;
  }

  private static poseNext = new THREE.Matrix4();

  /**
   * Where each collider's body is, as a world matrix (null: where it was).
   * Call before advancing; static bodies need it only once.
   */
  setPoses(bodyWorld: (body: string) => THREE.Matrix4 | null, geomWorld: (geom: number) => THREE.Matrix4 | null = () => null) {
    this.posedBy = [bodyWorld, geomWorld];
    const corner = this.poseCorner;
    const nextMat = ClothSim.poseNext;
    let maxStepDisp = 0;
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      const bw = c.geom !== undefined ? geomWorld(c.geom) : c.body ? bodyWorld(c.body) : this.poseIdentity;
      if (!bw) continue;
      nextMat.multiplyMatrices(bw, c.local);
      const ne = nextMat.elements, cur = this.world[i].elements;
      if (this.worldInit[i]) {
        let changed = false;
        for (let k = 0; k < 16; k++) {
          if (Math.abs(ne[k] - cur[k]) > 1e-9) { changed = true; break; }
        }
        if (!changed) continue;
        // Upper bound on point displacement inside c.bounds from ΔM = next - cur.
        const { min, max } = c.bounds;
        const rx = Math.max(Math.abs(min[0]), Math.abs(max[0]));
        const ry = Math.max(Math.abs(min[1]), Math.abs(max[1]));
        const rz = Math.max(Math.abs(min[2]), Math.abs(max[2]));
        if (rx < 1e6 && ry < 1e6 && rz < 1e6) {
          const dtx = Math.hypot(ne[12] - cur[12], ne[13] - cur[13], ne[14] - cur[14]);
          const drx = Math.hypot(ne[0] - cur[0], ne[1] - cur[1], ne[2] - cur[2]) * rx;
          const dry = Math.hypot(ne[4] - cur[4], ne[5] - cur[5], ne[6] - cur[6]) * ry;
          const drz = Math.hypot(ne[8] - cur[8], ne[9] - cur[9], ne[10] - cur[10]) * rz;
          const disp = dtx + drx + dry + drz;
          if (disp > maxStepDisp) maxStepDisp = disp;
        } else {
          maxStepDisp = 1;
        }
      } else {
        this.worldInit[i] = 1;
        this.prevWorld[i].copy(nextMat);
      }
      this.world[i].copy(nextMat);
      this.inv[i].copy(nextMat).invert();
      // A new pose: what each point read of it before no longer holds.
      this.colGen[i]++;
      // Its bounds in the world, grown by the cloth's thickness: most points
      // are turned away by six comparisons, not a transform and a distance.
      let lo0 = Infinity, lo1 = Infinity, lo2 = Infinity, hi0 = -Infinity, hi1 = -Infinity, hi2 = -Infinity;
      const { min, max } = c.bounds;
      const huge = min[0] < -1e8 || min[1] < -1e8 || min[2] < -1e8 || max[0] > 1e8 || max[1] > 1e8 || max[2] > 1e8;
      for (let k = 0; k < 8 && !huge; k++) {
        corner.set(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]).applyMatrix4(nextMat);
        if (corner.x < lo0) lo0 = corner.x; if (corner.y < lo1) lo1 = corner.y; if (corner.z < lo2) lo2 = corner.z;
        if (corner.x > hi0) hi0 = corner.x; if (corner.y > hi1) hi1 = corner.y; if (corner.z > hi2) hi2 = corner.z;
      }
      const t = CLOTH_THICKNESS, bo = 6 * i, B = this.worldBox;
      if (huge) {
        B[bo] = -1e9; B[bo + 1] = -1e9; B[bo + 2] = -1e9; B[bo + 3] = 1e9; B[bo + 4] = 1e9; B[bo + 5] = 1e9;
      } else {
        B[bo] = lo0 - t; B[bo + 1] = lo1 - t; B[bo + 2] = lo2 - t; B[bo + 3] = hi0 + t; B[bo + 4] = hi1 + t; B[bo + 5] = hi2 + t;
      }
    }
    if (maxStepDisp > 0) {
      const cb = this.clearBudget;
      for (let i = 0; i < this.n; i++) cb[i] -= maxStepDisp;
    }
    // Where each tie is drawn to, for this pose.
    const p = this.posePoint;
    for (let ti = 0; ti < this.ties.length; ti++) {
      const tie = this.ties[ti];
      if (!tie.anchor) continue;
      const bw = tie.body ? bodyWorld(tie.body) : null;
      p.set(tie.anchor[0], tie.anchor[1], tie.anchor[2]);
      if (bw) p.applyMatrix4(bw);
      if (tie.anchorWorld) { tie.anchorWorld[0] = p.x; tie.anchorWorld[1] = p.y; tie.anchorWorld[2] = p.z; }
      else tie.anchorWorld = [p.x, p.y, p.z];
    }
    // Update cached world endpoints for slender cylindrical/capsule colliders (Kármán wake street).
    for (let wi = 0; wi < this.wakeCylinders.length; wi++) {
      const wc = this.wakeCylinders[wi];
      if (!this.worldInit[wc.ci]) continue;
      const we = this.world[wc.ci].elements;
      const a0 = wc.axLocal[0], a1 = wc.axLocal[1], a2 = wc.axLocal[2];
      const b0 = wc.bxLocal[0], b1 = wc.bxLocal[1], b2 = wc.bxLocal[2];
      wc.ax = we[0] * a0 + we[4] * a1 + we[8] * a2 + we[12];
      wc.ay = we[1] * a0 + we[5] * a1 + we[9] * a2 + we[13];
      wc.az = we[2] * a0 + we[6] * a1 + we[10] * a2 + we[14];
      wc.bx = we[0] * b0 + we[4] * b1 + we[8] * b2 + we[12];
      wc.by = we[1] * b0 + we[5] * b1 + we[9] * b2 + we[13];
      wc.bz = we[2] * b0 + we[6] * b1 + we[10] * b2 + we[14];
    }
  }

  /** The env of an advance not yet finished (`finish`), and whether its continuous collision is due before its next substep. */
  private owedEnv: ClothEnv | null = null;
  private ccdOwed = false;

  /** Whether an advance stopped at its deadline with work left (`finish` runs it). */
  get busy() { return this.owedEnv !== null; }

  /**
   * Moves the cloth on by `dt`, in whole substeps (the remainder carries
   * over). Past `deadline` (performance.now() ms) it stops between two pieces
   * of work (a substep, a continuous-collision pass) and returns false, for
   * `finish` to run the rest exactly as it would have: same poses, same env,
   * same order. One piece always runs.
   */
  advance(dt: number, env: ClothEnv, deadline = Infinity): boolean {
    // One owed still: done first, so nothing runs out of order.
    if (this.owedEnv) this.finish();
    this.accumulator += dt;
    if (this.accumulator < CLOTH_SUBSTEP) return true;
    const h = CLOTH_SUBSTEP;
    let steps = 0;
    let total = this.accumulator;
    while (total >= h) { steps++; total -= h; }
    this.substepMoveScale = 1 / steps;
    this.owedEnv = env;
    return this.finish(deadline);
  }

  /** Runs what an advance stopped at its deadline left; true once it is all done. */
  finish(deadline = Infinity): boolean {
    const env = this.owedEnv;
    if (!env) return true;
    const h = CLOTH_SUBSTEP, timed = deadline !== Infinity;
    let worked = false;
    for (;;) {
      if (this.ccdOwed) {
        if (worked && timed && performance.now() > deadline) return false;
        this.collideAlong(this.ccdSince * h);
        worked = true;
      }
      if (this.accumulator < h) break;
      if (worked && timed && performance.now() > deadline) return false;
      this.externalForces(env);
      this.substep(h, env);
      this.accumulator -= h;
      worked = true;
      if (++this.ccdSince >= CCD_EVERY) this.ccdOwed = true;
    }
    this.owedEnv = null;
    this.substepMoveScale = 1;
    for (let ci = 0; ci < this.colliders.length; ci++) {
      if (this.worldInit[ci]) this.prevWorld[ci].copy(this.world[ci]);
    }
    return true;
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
    this.ccdOwed = false;
    if (!from) { this.ccdFrom = Float64Array.from(x); return; }
    const before = this.ccdBefore;
    before.set(x);
    const st = this.ccdOf().resolve(from, x, this.w);
    this.ccdTotals.calls++; this.ccdTotals.met += st.met; this.ccdTotals.pushes += st.pushes; this.ccdTotals.zoneCalls += st.zones ? 1 : 0; this.ccdTotals.frozen += st.frozen ? 1 : 0; this.ccdTotals.zonePoints += st.zonePoints;
    if (st.met) {
      const v = this.v;
      for (let i = 0; i < this.n; i++) {
        const k = 3 * i;
        if (x[k] === before[k] && x[k + 1] === before[k + 1] && x[k + 2] === before[k + 2]) continue;
        // Damp velocity derived from CCD pushbacks (0.5x) so post-contact/tack re-projections
        // and CCD impact responses never pump energy into a permanent limit cycle.
        for (let c = 0; c < 3; c++) v[k + c] = 0.5 * ((x[k + c] - from[k + c]) / span);
        this.prev[k] = x[k]; this.prev[k + 1] = x[k + 1]; this.prev[k + 2] = x[k + 2];
      }
    }
    from.set(x);
  }

  /** Wind and still-air aerodynamic drag on each triangle, as an acceleration of its corners. */
  private externalForces(env: ClothEnv) {
    this.ext.fill(0);
    if (env.airDensity <= 0) return;
    const [wx0, wy0, wz0] = env.wind;
    const meanSpeed = Math.hypot(wx0, wy0, wz0);
    const hasMeanWind = meanSpeed > 0;
    const horizSpeed = Math.hypot(wx0, wy0);
    const doTurbulence = this.settled && meanSpeed >= 0.5 && horizSpeed >= 1e-4;
    const uxWind = horizSpeed >= 1e-4 ? wx0 / horizSpeed : 1;
    const uyWind = horizSpeed >= 1e-4 ? wy0 / horizSpeed : 0;
    const gustAt = hasMeanWind ? env.gustAt : undefined;
    const wakeCyls = doTurbulence ? this.wakeCylinders : null;
    const nWake = wakeCyls ? wakeCyls.length : 0;
    const simTime = this.time;
    const kaimalMod = doTurbulence
      ? 1.0 +
        0.14 * Math.sin(2 * Math.PI * 0.33 * simTime + 0.4) +
        0.08 * Math.sin(2 * Math.PI * 0.79 * simTime + 1.9)
      : 1.0;
    const recordAero = this.settled;
    if (recordAero) {
      for (let pi = 0; pi < this.pieces.length; pi++) this.pieceSubstepsCounted[pi]++;
    }
    const x = this.x, v = this.v, T = this.tris, W = this.w, ext = this.ext;
    // Passive explicit-Euler cap per substep: aerodynamic force cannot reverse
    // relative air velocity within a single substep.
    const maxAccelPerSpeed = 0.35 / CLOTH_SUBSTEP;
    for (let t = 0; t < T.length; t += 3) {
      const i0 = T[t], i1 = T[t + 1], i2 = T[t + 2];
      const a = 3 * i0, b = 3 * i1, c = 3 * i2;
      const vtx = (v[a] + v[b] + v[c]) / 3, vty = (v[a + 1] + v[b + 1] + v[c + 1]) / 3, vtz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
      if (!hasMeanWind && vtx * vtx + vty * vty + vtz * vtz < 1e-8) continue;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-12) continue;
      const area = len / 2; nx /= len; ny /= len; nz /= len;
      let wx = wx0, wy = wy0, wz = wz0;
      const needCentroid = !!gustAt || doTurbulence;
      const cx = needCentroid ? (x[a] + x[b] + x[c]) / 3 : 0;
      const cy = needCentroid ? (x[a + 1] + x[b + 1] + x[c + 1]) / 3 : 0;
      const cz = needCentroid ? (x[a + 2] + x[b + 2] + x[c + 2]) / 3 : 0;
      if (gustAt) {
        const g = gustAt(wx0, wy0, cx, cy, cz, simTime);
        wx = g[0] * kaimalMod; wy = g[1] * kaimalMod; wz = g[2] * kaimalMod;
      } else if (doTurbulence) {
        const sAdv = cx * uxWind + cy * uyWind - 0.72 * meanSpeed * simTime;
        const sLat = -cx * uyWind + cy * uxWind;
        const eddy1 = Math.sin(4.7 * sAdv + 6.1 * cz + 1.9 * simTime);
        const eddy2 = Math.cos(8.3 * sAdv - 5.3 * sLat + 3.7 * simTime);
        const longMod = kaimalMod * (1.0 + 0.075 * eddy1 + 0.03 * eddy2);
        const latMod = meanSpeed * (0.065 * eddy2 + 0.035 * Math.sin(11.9 * cz + 7.1 * sLat - 4.3 * simTime));
        wx = wx0 * longMod - uyWind * latMod;
        wy = wy0 * longMod + uxWind * latMod;
        wz = wz0 * kaimalMod + meanSpeed * 0.03 * Math.sin(6.4 * sAdv + 2.8 * simTime);
      }
      if (nWake > 0 && wakeCyls) {
        const triIdx = t / 3;
        const chordRef = this.pieceChord[this.triPiece[triIdx]] || 0.5;
        for (let wi = 0; wi < nWake; wi++) {
          const wc = wakeCyls[wi];
          if (!this.worldInit[wc.ci]) continue;
          const abx = wc.bx - wc.ax, aby = wc.by - wc.ay, abz = wc.bz - wc.az;
          const ab2 = abx * abx + aby * aby + abz * abz;
          if (ab2 < 1e-10) continue;
          const tSeg = Math.max(0, Math.min(1, ((cx - wc.ax) * abx + (cy - wc.ay) * aby + (cz - wc.az) * abz) / ab2));
          const px = wc.ax + abx * tSeg, py = wc.ay + aby * tSeg, pz = wc.az + abz * tSeg;
          const dx = cx - px, dy = cy - py, dz = cz - pz;
          const D = wc.diam;
          if (Math.abs(dz) > 2.5 * D + 0.04 && Math.abs(abz) > 0.5 * Math.sqrt(ab2)) continue;
          const sStream = dx * uxWind + dy * uyWind;
          if (sStream <= 0 || sStream >= 16 * D) continue;
          const sCross = -dx * uyWind + dy * uxWind;
          if (Math.abs(sCross) >= 3.2 * D) continue;
          const abLen = Math.sqrt(ab2);
          const axUx = abx / abLen, axUy = aby / abLen, axUz = abz / abLen;
          // Transverse wake velocity direction: wind × cylinder_axis (perpendicular to both flow and mast)
          let pvx = uyWind * axUz, pvy = -uxWind * axUz, pvz = uxWind * axUy - uyWind * axUx;
          const pvLen = Math.hypot(pvx, pvy, pvz);
          if (pvLen > 1e-6) {
            pvx /= pvLen; pvy /= pvLen; pvz /= pvLen;
          } else {
            pvx = -uyWind; pvy = uxWind; pvz = 0;
          }
          const dEff = Math.max(D, Math.min(0.28 * chordRef, 3.2 * D));
          const fWake = Math.max(2.5, Math.min(14.0, (0.20 * meanSpeed) / dEff));
          const envStream = Math.exp(-sStream / (14 * D));
          const ratioCross = sCross / (2.2 * D);
          const envCross = Math.exp(-ratioCross * ratioCross);
          const phase = 2 * Math.PI * fWake * (simTime - sStream / (0.72 * meanSpeed)) + 0.8 * cz;
          const uWake = 0.36 * meanSpeed * envStream * envCross * Math.sin(phase);
          wx += pvx * uWake;
          wy += pvy * uWake;
          wz += pvz * uWake;
        }
      }
      const rx = wx - vtx, ry = wy - vty, rz = wz - vtz;
      const s2 = rx * rx + ry * ry + rz * rz;
      if (s2 < 1e-8) continue;
      const s = Math.sqrt(s2), vn = rx * nx + ry * ny + rz * nz;
      const sinAlpha = Math.min(1, Math.abs(vn) / s);
      const triIdx = t / 3;
      const qa = (0.5 * env.airDensity * s2 * area) / 3;
      // Direct Hoerner/Rayleigh normal coefficient without redundant sin(asin(sinAlpha)) round-trip.
      const cn = this.triCd[triIdx] * ((2.2 * sinAlpha) / (1 + 1.2 * sinAlpha));
      const pn = (vn >= 0 ? 1 : -1) * qa * cn;
      const tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz, pt = (qa * SKIN_FRICTION) / s;
      const fx = pn * nx + pt * tx, fy = pn * ny + pt * ty, fz = pn * nz + pt * tz;
      const fMag = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (recordAero) {
        const pi = this.triPiece[triIdx];
        // Total force across all 3 corners of this triangle is 3 * fMag
        this.pieceAccForceSum[pi] += 3 * fMag;
        this.pieceAccRelSpeedAreaSum[pi] += s * area;
        this.pieceAccAlphaAreaSum[pi] += ((Math.asin(sinAlpha) * 180) / Math.PI) * area;
        this.pieceAccAreaSum[pi] += area;
        const vTriMag = Math.sqrt(vtx * vtx + vty * vty + vtz * vtz);
        const effTip = Math.max(s, vTriMag);
        if (effTip > this.pieceAccTipMax[pi]) this.pieceAccTipMax[pi] = effTip;
      }
      const maxAccel = maxAccelPerSpeed * s;
      const applyCorner = (idx: number, k3: number) => {
        const wi = W[idx];
        if (!wi) return;
        const aMag = wi * fMag;
        const sc = aMag > maxAccel ? maxAccel / aMag : 1;
        ext[k3] += wi * sc * fx; ext[k3 + 1] += wi * sc * fy; ext[k3 + 2] += wi * sc * fz;
      };
      applyCorner(i0, a); applyCorner(i1, b); applyCorner(i2, c);
    }
  }

  private settled = false;
  /** Set when the settle before the first frame ran out of time (SETTLE_BUDGET_MS): why, for the cloth's warnings. */
  settleCut: string | null = null;
  /**
   * The settle, now: once the colliders are posed, so the cloth is first drawn
   * where it rests rather than where it was modelled (a bow's tails started
   * inside the gown and were drawn there until it played).
   */
  settleNow() {
    if (this.settled) return;
    if (this.time !== 0) {
      this.settled = true;
      return;
    }
    if (this.settleInvolved()) return;
    // Cloth carried over a rebuild (carryCloths) as it was: held still while
    // the rest is sewn and settled, its seams as sewn as they were.
    const carryHeld = this.carryHeld, carryFree = this.carryFree, carryStitch = this.carryStitch;
    const isCarried = (i: number) => Boolean(carryHeld?.[i] || carryFree?.[i]);
    const fullW = carryHeld ? this.w.slice() : null;
    const carriedSew = carryStitch ? this.stitchSew.slice() : null, carriedGap = carryStitch ? this.stitchGap.slice() : null;
    const carriedV = carryHeld ? this.v.slice() : null;
    if (carryHeld) for (let i = 0; i < this.n; i++) if (carryHeld[i]) this.w[i] = 0;
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
    const builtCrossed = findCrossings(this.x, tangle);
    this.ccdOf().setTangled(builtCrossed);
    // And while it is sewn into place, two pieces a builder made through each
    // other free of each other wholly: being sewn on is what carries a piece
    // out (a bow modelled through a gown's back).
    {
      const piece = new Int32Array(this.n);
      let k = 0;
      for (const pc of this.pieces) for (const g of pc.model.groups) { for (const i of g.particles) piece[pc.base + i] = k; k++; }
      // Two pieces, not a piece and itself: a pleat folded through itself is held at its crossings, as running.
      this.ccdOf().setFreePieces(piece, builtCrossed.map((c) => [piece[c.a], piece[this.tris[3 * c.t]]] as [number, number]).filter(([a, b]) => a !== b));
    }
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
    // Not what was carried over still closing: it goes on closing as the scene runs, as it was.
    const open = (k: number) => this.stitchOn[k] && this.stitchSew[k] > 0 && this.stitchGap[k] > 0.002 && !carryStitch?.[k];
    for (let k = 0; k < this.stitchGap.length; k++) if (open(k)) sewing = Math.max(sewing, this.stitchSew[k]);
    const dropped: number[] = [], pulls: { p: number; route: number[][]; started: boolean }[] = [];
    // Not what was carried over: dropped and pulled into place already.
    this.pieces.forEach((pc, pi) => { if (!this.carryPiece?.[pi]) for (const i of pc.model.drop ?? []) dropped.push(pc.base + i); });
    this.pieces.forEach((pc, pi) => { if (!this.carryPiece?.[pi]) for (const pl of pc.model.pulls ?? []) pulls.push({ p: pc.base + pl.particle, route: [...(pl.via ?? []), pl.to], started: false }); });
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
        if (!open(k)) continue;
        const pa = this.stitches[2 * k], pb = this.stitches[2 * k + 1], a = find(pa), b = find(pb);
        // Never what was carried over, sewn already: what is sewn onto it moves.
        const ca = isCarried(pa), cb = isCarried(pb);
        moving.add(ca !== cb ? (ca ? b : a) : (size.get(a) ?? 0) <= (size.get(b) ?? 0) ? a : b);
      }
      for (const i of dropped) moving.add(find(i));
      for (const pl of pulls) moving.add(find(pl.p));
      const held = this.w.slice(), floats = this.floatUntil.slice();
      for (let i = 0; i < n; i++) if (!moving.has(find(i)) && !carryFree?.[i]) this.w[i] = 0;
      // In longer steps than a running scene's: only drawn together and let hang here.
      const env: ClothEnv = { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.2 };
      this.externalForces(env);
      // What moves meanwhile floats until its seams are closed, then falls
      // into place: a hood's crown sewn round the head before it settles on
      // it (falling while sewn, it tipped off backwards).
      for (let i = 0; i < n; i++) if (moving.has(find(i))) this.floatUntil[i] = sewing;
      this.recomputeMaxFloatUntil();
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
      const started = performance.now();
      for (let t = 0; t < end;) {
        if (performance.now() - started > SETTLE_BUDGET_MS) {
          this.settleCut = `sewing and settling stopped after ${SETTLE_BUDGET_MS / 1000} s, ${t.toFixed(2)} of ${end.toFixed(2)} s in; the rest is sewn as the scene runs. It starts through itself or other cloth in ${builtCrossed.length} places: pieces sewn on placed through each other, or layers drawn inside one another.`;
          break;
        }
        const h = t >= fineFrom ? CLOTH_SUBSTEP : PRESEW_STEP;
        this.substep(h, env, true);
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
      this.recomputeMaxFloatUntil();
      this.v.fill(0); this.prev.set(this.x);
    }
    this.ccdOf().setFreePieces(null);
    // Then nothing through cloth before it is first drawn: whatever its
    // builders modelled crossed, untangled, and from here kept so.
    this.untangle();
    this.ccdFrom = Float64Array.from(this.x);
    this.ccdSince = 0;
    if (fullW) this.w.set(fullW);
    // Moving as it was, if it was: held still here, it was not stopped.
    if (carryHeld && carriedV) for (let i = 0; i < this.n; i++) if (carryHeld[i]) for (let c = 0; c < 3; c++) this.v[3 * i + c] = carriedV[3 * i + c];
    if (carryStitch && carriedSew && carriedGap) for (let k = 0; k < carryStitch.length; k++) if (carryStitch[k]) { this.stitchSew[k] = carriedSew[k]; this.stitchGap[k] = carriedGap[k]; }
    if (carryHeld) this.rebaseCarried();
    this.syncAeroBaselines();
    this.settled = true;
  }

  /**
   * After a settle that carried cloth over (carryCloths): the clock goes on
   * from where the carried cloth was, and what was sewn and settled new has
   * its sewing, floating and ties put off by as long, so it carries on from
   * where it is as it would have from 0.
   */
  private rebaseCarried() {
    const T = this.carryClock, held = this.carryHeld!, free = this.carryFree!, carriedStitch = this.carryStitch!;
    this.carryHeld = this.carryFree = this.carryPiece = this.carryStitch = null; this.carryInvolved = null;
    if (T <= 0) return;
    for (let i = 0; i < this.n; i++) if (!held[i] && !free[i] && this.floatUntil[i] > 0) this.floatUntil[i] += T;
    for (let k = 0; k < carriedStitch.length; k++) {
      const sew = this.stitchSew[k];
      if (carriedStitch[k] || sew <= 0) continue;
      // gap (1 - (t - T) / sew) as gap' (1 - t / sew').
      this.stitchGap[k] *= (sew + T) / sew; this.stitchSew[k] = sew + T;
    }
    for (const tie of this.ties) {
      if (held[tie.p] || free[tie.p]) continue;
      const aw = tie.anchorWorld, sew = Math.max(1e-6, tie.sew);
      if (aw) tie.from = tie.from.map((f, c) => (f * (sew + T) - aw[c] * T) / sew);
      tie.sew = sew + T;
    }
    this.time = T; this.accumulator = this.carryAccumulator;
    this.recomputeMaxFloatUntil();
  }

  /** Synchronizes rest/current bend & edge baselines after settle/untangle/restore so frame 1 reports zero false strain jump. */
  private syncAeroBaselines() {
    const x = this.x;
    for (let k = 0; k < this.edgeRest.length; k++) {
      const a = 3 * this.edges[2 * k], b = 3 * this.edges[2 * k + 1];
      this.edgePrevLen[k] = Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2]);
    }
    this.bendPrevC.set(this.bendCurC);
    this.witnessInit.fill(0);
    this.witnessLastSnapTime.fill(-1);
    this.tieInit.fill(0);
    this.tieLastImpactTime.fill(-1);
    this.consumeAeroTelemetry(0, true);
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
    let best = crossings.length;
    const bestX = Float64Array.from(this.x);
    let sinceBest = 0;
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
      if (steps % UNTANGLE_CHECK === 0) {
        crossings = findCrossings(this.x, m);
        if (crossings.length < best) {
          best = crossings.length;
          bestX.set(this.x);
          sinceBest = 0;
        } else {
          sinceBest += UNTANGLE_CHECK;
          if (sinceBest >= UNTANGLE_STALL) {
            this.x.set(bestX);
            break;
          }
        }
        near = crossings.length ? trianglesNear(this.x, m, crossings, UNTANGLE_REACH) : null;
        markRegion();
      } else {
        crossings = findCrossings(this.x, m, near);
      }
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
      this.edgeLambda.fill(0);
      this.elasticLambda.fill(0);
      this.rodBendLambda.fill(0);
      this.bendLambda.fill(0);
      this.contactPush.fill(0);
      this.contactMu.fill(0);
      this.contactN.fill(0);
      this.contactDisp.fill(0);
      this.contactHeld.fill(0);
      for (let i = 0; i < this.n; i++) this.skip[i] = !this.w[i] ? 1 : 0;
      for (let sp = 0; sp < STRETCH_PASSES; sp++) {
        this.solveDistances(this.edges, this.edgeRest, this.edgeMin, this.edgeAlpha, this.edgeLambda, h2);
        this.solveLimits(h2);
        this.solveRods(h2);
        this.solveBends(h2);
        this.boards.solve(this.x, this.w);
        for (let k = 0; k < this.stitchGap.length; k++) {
          if (this.stitchOn[k] && this.stitchSew[k] <= 0) this.project(this.stitches[2 * k], this.stitches[2 * k + 1], 0, 0);
        }
        this.solveTacks();
        this.collide(CLOTH_THICKNESS, false);
      }
      this.collide(CLOTH_THICKNESS, true);
      if (doLayers) {
        this.layers.collide(this.x, this.prev, CLOTH_THICKNESS, this.contactN, this.contactPush, this.contactMu, this.contactDisp, pass === 0, true);
      }
      if (this.self.active) this.self.collide(this.x, this.prev, pass === 0);
      this.solveTacks();
    }
    this.prev.set(this.x);
    this.v.fill(0);
    for (let ci = 0; ci < this.colliders.length; ci++) {
      if (this.worldInit[ci]) this.prevWorld[ci].copy(this.world[ci]);
    }
    this.aim();
  }

  private applyFriction() {
    const { x, prev, n, contactPush, contactN, contactMu, contactDisp, contactHeld } = this;
    for (let i = 0; i < n; i++) {
      const push = contactPush[i];
      if (push <= 0) continue;
      const k = 3 * i;
      let nx = contactN[k], ny = contactN[k + 1], nz = contactN[k + 2];
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) continue;
      nx /= nl; ny /= nl; nz /= nl;
      // Relative slip against impulse-weighted collider/layer surface displacement.
      const invPush = 1 / push;
      const dx = (x[k] - prev[k]) - contactDisp[k] * invPush;
      const dy = (x[k + 1] - prev[k + 1]) - contactDisp[k + 1] * invPush;
      const dz = (x[k + 2] - prev[k + 2]) - contactDisp[k + 2] * invPush;
      const dn = dx * nx + dy * ny + dz * nz;
      const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz;
      const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      // contactMu[i] holds sum(mu * depth), so total Coulomb tangential budget is contactMu[i].
      const rem = contactMu[i] - contactHeld[i];
      if (tl > 1e-12 && rem > 0) {
        const take = Math.min(tl, rem), s = take / tl;
        x[k] -= tx * s; x[k + 1] -= ty * s; x[k + 2] -= tz * s;
        contactHeld[i] += take;
      }
    }
  }

  private substep(h: number, env: ClothEnv, skipSettleCheck = false) {
    if (!skipSettleCheck && !this.settled) this.settleNow();
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
      for (let gi = 0; gi < this.grabPatch.length; gi++) {
        const gp = this.grabPatch[gi], gk = 3 * gp.p, s = step * gp.wt;
        x[gk] += dx * s; x[gk + 1] += dy * s; x[gk + 2] += dz * s;
        const keep = 1 - gp.wt;
        v[gk] *= keep; v[gk + 1] *= keep; v[gk + 2] *= keep;
      }
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
    this.contactMu.fill(0);
    this.contactN.fill(0);
    this.contactDisp.fill(0);
    this.contactHeld.fill(0);
    for (let i = 0; i < n; i++) this.skip[i] = !w[i] ? 1 : this.clearBudget[i] <= 0 ? 0 : 1;
    const doLayers = this.layers.active;
    this.layerTick = (this.layerTick + 1) % 2;
    // Stretch, then bend: distance constraints with compliance, coupled with
    // contact and Coulomb friction each pass so points held by friction pull
    // their neighbours in subsequent passes rather than stretching the edges
    // between them at the end of the substep.
    this.edgeLambda.fill(0);
    this.elasticLambda.fill(0);
    this.rodBendLambda.fill(0);
    this.bendLambda.fill(0);
    for (let ti = 0; ti < this.ties.length; ti++) this.ties[ti].lambda = 0;
    for (let pass = 0; pass < STRETCH_PASSES; pass++) {
      this.solveDistances(this.edges, this.edgeRest, this.edgeMin, this.edgeAlpha, this.edgeLambda, h2);
      this.solveElastics(h2);
      this.solveLimits(h2);
      this.solveRods(h2);
      // Every pass: once a substep, a stiff piece (a board, heavy leather)
      // bent however stiff its material, held to what one pass could do.
      this.solveBends(h2);
      // Boards held to their shape in their plane, once a substep (a few
      // passes of the rest hold a cloth, not a board; every pass cost a cap
      // a sixth of a second a simulated second and held it no better).
      if (pass === STRETCH_PASSES - 1 && this.boards.active) { this.solveTacks(); this.boards.solve(x, w); }
      // Stitches close from their starting gap to nothing over the sew time.
      // A zip's pairs only where it is done up, those its slider has just
      // run together closing from where they were.
      for (let k = 0; k < this.stitchGap.length; k++) {
        if (!this.stitchOn[k]) continue;
        const sew = this.stitchSew[k];
        this.project(this.stitches[2 * k], this.stitches[2 * k + 1], sew <= 0 ? this.stitchClose[k] : this.stitchGap[k] * (1 - Math.min(1, t / sew)), 0);
      }
      if (this.zips.length) this.sliderThroats();
      // Ties: project inside each pass so incident edges converge against the
      // true anchored position without inflating tieLoads() by STRETCH_PASSES.
      for (let ti = 0; ti < this.ties.length; ti++) {
        const tie = this.ties[ti];
        const i = tie.p, k = 3 * i, f = tie.from, aw = tie.anchorWorld;
        const s = aw ? Math.min(1, t / Math.max(1e-6, tie.sew)) : 0;
        const tx = aw ? f[0] + (aw[0] - f[0]) * s : f[0], ty = aw ? f[1] + (aw[1] - f[1]) * s : f[1], tz = aw ? f[2] + (aw[2] - f[2]) * s : f[2];
        const dx = tx - x[k], dy = ty - x[k + 1], dz = tz - x[k + 2];
        x[k] += dx; x[k + 1] += dy; x[k + 2] += dz;
        tie.lambda += Math.sqrt(dx * dx + dy * dy + dz * dz) / (h2 * Math.max(1e-12, w[i]));
      }
      this.solveTacks();
      this.collide(CLOTH_THICKNESS, false);
      // And on the last pass of every substep: pass === 0 steps the rebuild
      // counter once per substep so LayerContacts rebuilds every 4 substeps.
      if (doLayers && (pass === 0 || pass === STRETCH_PASSES - 1 || this.layerTick === 0)) {
        this.layers.collide(x, prev, CLOTH_THICKNESS, this.contactN, this.contactPush, this.contactMu, this.contactDisp, pass === 0, false, this.settled);
      }
      // Once a substep, on the last pass: the constraints have moved the cloth
      // by then, and friction after it holds what this sets.
      if (this.self.active && pass === STRETCH_PASSES - 1) this.self.collide(x, prev, true, this.settled);
      this.solveTacks();
      this.applyFriction();
    }
    this.collide(CLOTH_THICKNESS, true);
    this.solveTacks();
    this.applyFriction();
    this.collide(CLOTH_THICKNESS, false);
    // Velocities from the post-contact, post-friction positions: strongly
    // damped and bounded to terminal free-fall speed over the post-float release
    // window so 3D-vs-2D rest-length reconciliation does not turn into momentum.
    const gMag = Math.sqrt(gx * gx + gy * gy + gz * gz);
    const wMag = Math.sqrt(env.wind[0] * env.wind[0] + env.wind[1] * env.wind[1] + env.wind[2] * env.wind[2]);
    const invHDamp = Math.exp(-1.0 * h) / h;
    const checkFloat = this.maxFloatUntil > 0 && t < this.maxFloatUntil + 0.35;
    if (!checkFloat) {
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        v[k] = (x[k] - prev[k]) * invHDamp;
        v[k + 1] = (x[k + 1] - prev[k + 1]) * invHDamp;
        v[k + 2] = (x[k + 2] - prev[k + 2]) * invHDamp;
      }
    } else {
      const fu = this.floatUntil;
      for (let i = 0; i < n; i++) {
        const k = 3 * i;
        let vx = (x[k] - prev[k]) * invHDamp;
        let vy = (x[k + 1] - prev[k + 1]) * invHDamp;
        let vz = (x[k + 2] - prev[k + 2]) * invHDamp;
        // Apply post-float velocity cap only to particles that actually floated while sewing (`floatUntil[i] > 0`).
        const fui = fu[i];
        if (fui > 0) {
          const tr = t > fui ? t - fui : 0;
          if (tr < 0.35) {
            const rate = 1 + 40 * Math.exp(-tr / 0.08);
            const extra = Math.exp(-(rate - 1) * h);
            vx *= extra; vy *= extra; vz *= extra;
            const cap = gMag / rate + wMag + 0.25;
            const s2 = vx * vx + vy * vy + vz * vz;
            if (s2 > cap * cap) {
              const sc = cap / Math.sqrt(s2);
              vx *= sc; vy *= sc; vz *= sc;
            }
          }
        }
        v[k] = vx;
        v[k + 1] = vy;
        v[k + 2] = vz;
      }
    }
    if (this.settled && env.airDensity > 0) {
      this.sampleSubstepAeroTelemetry(h, env);
    }
  }

  private recomputeMaxFloatUntil() {
    let m = 0;
    const fu = this.floatUntil;
    for (let i = 0; i < fu.length; i++) if (fu[i] > m) m = fu[i];
    this.maxFloatUntil = m;
  }

  private solveDistances(
    pairs: Int32Array,
    rest: Float64Array,
    minRest: Float64Array,
    alpha: Float64Array,
    lambda: Float64Array,
    h2: number,
  ) {
    const { x, w } = this, invH2 = 1 / h2, nEdges = rest.length;
    for (let k = 0; k < nEdges; k++) {
      const a = pairs[2 * k], b = pairs[2 * k + 1];
      const wa = w[a], wb = w[b], wSum = wa + wb;
      if (wSum <= 0) continue;
      const ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-12) continue;
      const rk = rest[k], mk = minRest[k];
      const target = len > rk ? rk : len < mk ? mk : len;
      const lam = lambda[k];
      if (target === len && lam === 0) continue;
      const at = alpha[k] * invH2;
      let dl = (-(len - target) - at * lam) / (wSum + at);
      // Slack dead-band between minRest and rest: unilateral in each direction,
      // so tension multiplier >= 0 (or <= 0 in XPBD sign convention) cannot push when slack.
      if (mk < rk && len >= mk && len <= rk && lam * (lam + dl) <= 0) dl = -lam;
      lambda[k] = lam + dl;
      const s = dl / len, sa = wa * s, sb = wb * s;
      x[ia] += sa * dx; x[ia + 1] += sa * dy; x[ia + 2] += sa * dz;
      x[ib] -= sb * dx; x[ib + 1] -= sb * dy; x[ib + 2] -= sb * dz;
    }
  }

  /**
   * Boning (clothRods): its links held to length, and its curvature vector
   * a + c - 2b at each point driven toward its modelled shape with XPBD
   * compliance h^3 / (E I) and signed curvature preservation.
   */
  private solveRods(h2: number) {
    const { x, w } = this, L = this.rodLinks, LR = this.rodLinkRest;
    for (let k = 0; k < LR.length; k++) this.project(L[2 * k], L[2 * k + 1], LR[k], 0);
    const B = this.rodBends, R = this.rodBendRest, A = this.rodBendAlpha, lam = this.rodBendLambda, D = this.rodBendDir;
    for (let k = 0; k < R.length; k++) {
      const a = B[3 * k], b = B[3 * k + 1], c = B[3 * k + 2], ia = 3 * a, ib = 3 * b, ic = 3 * c;
      const wSum = w[a] + w[c] + 4 * w[b];
      if (wSum <= 0) continue;
      const vx = x[ia] + x[ic] - 2 * x[ib], vy = x[ia + 1] + x[ic + 1] - 2 * x[ib + 1], vz = x[ia + 2] + x[ic + 2] - 2 * x[ib + 2];
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const rest = R[k];
      let nx: number, ny: number, nz: number, cVal: number;
      if (rest > 1e-9) {
        // Parallel-transport / align initial rest bend direction into current chord plane (orthogonal to c - a).
        const chx = x[ic] - x[ia], chy = x[ic + 1] - x[ia + 1], chz = x[ic + 2] - x[ia + 2];
        const ch2 = chx * chx + chy * chy + chz * chz;
        let dx = D[3 * k], dy = D[3 * k + 1], dz = D[3 * k + 2];
        if (ch2 > 1e-12) {
          const proj = (dx * chx + dy * chy + dz * chz) / ch2;
          dx -= proj * chx; dy -= proj * chy; dz -= proj * chz;
        }
        const dlDir = Math.hypot(dx, dy, dz);
        if (dlDir > 1e-9) {
          dx /= dlDir; dy /= dlDir; dz /= dlDir;
          // Update tracked bend normal smoothly when clearly bent on the positive side so rotating garments carry their rod frame!
          if (len > 0.25 * rest && vx * dx + vy * dy + vz * dz > 0) {
            D[3 * k] = vx / len; D[3 * k + 1] = vy / len; D[3 * k + 2] = vz / len;
          }
          if (len > 1e-9 && vx * dx + vy * dy + vz * dz >= 0) {
            nx = vx / len; ny = vy / len; nz = vz / len;
            cVal = len;
          } else {
            // Rod bent flat or inverted past flat: push back along +d with signed curvature cVal <= 0!
            nx = dx; ny = dy; nz = dz;
            cVal = vx * dx + vy * dy + vz * dz;
          }
        } else {
          if (len < 1e-12) continue;
          nx = vx / len; ny = vy / len; nz = vz / len;
          cVal = len;
        }
      } else {
        if (len < 1e-12) continue;
        nx = vx / len; ny = vy / len; nz = vz / len;
        cVal = len;
      }
      const at = A[k] / h2;
      const dl = (-(cVal - rest) - at * lam[k]) / (wSum + at);
      lam[k] += dl;
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
    const { x, w } = this, P = this.elastics, F = this.elasticFlat, R = this.elasticRest, A = this.elasticAlpha, lam = this.elasticLambda;
    const s = Math.min(1, this.time / 0.35);
    for (let k = 0; k < R.length; k++) {
      const a = P[2 * k], b = P[2 * k + 1], ia = 3 * a, ib = 3 * b;
      const wa = w[a], wb = w[b];
      if (wa + wb <= 0) continue;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-12) continue;
      const rest = F[k] + (R[k] - F[k]) * s;
      if (len <= rest && lam[k] === 0) continue;
      const at = A[k] / h2;
      let dl = (-(len - rest) - at * lam[k]) / (wa + wb + at);
      // One-sided tension only: elastic multiplier lam <= 0 cannot push apart.
      if (lam[k] + dl > 0) dl = -lam[k];
      if (dl === 0) continue;
      lam[k] += dl;
      const invLen = 1 / len;
      x[ia] += wa * dl * dx * invLen; x[ia + 1] += wa * dl * dy * invLen; x[ia + 2] += wa * dl * dz * invLen;
      x[ib] -= wb * dl * dx * invLen; x[ib + 1] -= wb * dl * dy * invLen; x[ib + 2] -= wb * dl * dz * invLen;
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
    const nTacks = this.tackP.length;
    if (nTacks === 0) return;
    const { x, w, tackP, tackA, tackB, tackC, tackW0, tackW1, tackW2, tackOff, tackLift } = this;
    const X = this.self.extra;
    for (let i = 0; i < nTacks; i++) {
      const p = tackP[i];
      if (only && !only[p]) continue;
      const a = tackA[i], b = tackB[i], c = tackC[i];
      const ia = 3 * a, ib = 3 * b, ic = 3 * c, ip = 3 * p;
      const ux = x[ib] - x[ia], uy = x[ib + 1] - x[ia + 1], uz = x[ib + 2] - x[ia + 2];
      const vx = x[ic] - x[ia], vy = x[ic + 1] - x[ia + 1], vz = x[ic + 2] - x[ia + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nl < 1e-12) continue;
      const invNl = 1 / nl;
      nx *= invNl; ny *= invNl; nz *= invNl;
      const w0 = tackW0[i], w1 = tackW1[i], w2 = tackW2[i];
      const off = tackOff[i] + X[p] + w0 * X[a] + w1 * X[b] + w2 * X[c];
      const tx = w0 * x[ia] + w1 * x[ib] + w2 * x[ic] + nx * off;
      const ty = w0 * x[ia + 1] + w1 * x[ib + 1] + w2 * x[ic + 1] + ny * off;
      const tz = w0 * x[ia + 2] + w1 * x[ib + 2] + w2 * x[ic + 2] + nz * off;
      let cx = x[ip] - tx, cy = x[ip + 1] - ty, cz = x[ip + 2] - tz;
      if (tackLift[i]) {
        const out = cx * nx + cy * ny + cz * nz;
        if (out > 0) { cx -= out * nx; cy -= out * ny; cz -= out * nz; }
      }
      const wp = w[p], wa = w[a], wb = w[b], wc = w[c];
      const ws = wp + w0 * w0 * wa + w1 * w1 * wb + w2 * w2 * wc;
      if (ws <= 0) continue;
      const invWs = 1 / ws, sp = wp * invWs;
      x[ip] -= sp * cx; x[ip + 1] -= sp * cy; x[ip + 2] -= sp * cz;
      const s0 = w0 * wa * invWs, s1 = w1 * wb * invWs, s2 = w2 * wc * invWs;
      x[ia] += s0 * cx; x[ia + 1] += s0 * cy; x[ia + 2] += s0 * cz;
      x[ib] += s1 * cx; x[ib + 1] += s1 * cy; x[ib + 2] += s1 * cz;
      x[ic] += s2 * cx; x[ic + 1] += s2 * cy; x[ic + 2] += s2 * cz;
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
    const { x, w } = this, P = this.limits, R = this.limitRest, nLim = R.length;
    void h2;
    for (let k = 0; k < nLim; k++) {
      const a = P[2 * k], b = P[2 * k + 1], ia = 3 * a, ib = 3 * b;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const r = R[k], len2 = dx * dx + dy * dy + dz * dz;
      if (len2 <= r * r) continue;
      const wa = w[a], wb = w[b], ws = wa + wb;
      if (ws <= 0) continue;
      const len = Math.sqrt(len2);
      const c = (len - r) / (ws * len), sa = wa * c, sb = wb * c;
      x[ia] -= sa * dx; x[ia + 1] -= sa * dy; x[ia + 2] -= sa * dz;
      x[ib] += sb * dx; x[ib + 1] += sb * dy; x[ib + 2] += sb * dz;
    }
  }

  /**
   * Isometric bending: each stencil's curvature, sum K_i x_i, driven to the
   * size (and dihedral sign, when non-zero) it rests at. Unlike a distance
   * across the hinge, which barely changes for a small fold, this resists a
   * fold in proportion to its angle: with the distance, a draped shirt
   * crumpled into facets a triangle across.
   */
  private solveBends(h2: number) {
    const { x, w } = this, Q = this.bends, K = this.bendWeights, A = this.bendAlpha, S = this.bendSign;
    const BR = this.bendRest, BL = this.bendLambda, BC = this.bendCurC;
    const invH2 = 1 / h2, nBends = A.length;
    for (let s = 0; s < nBends; s++) {
      const s4 = 4 * s;
      const q0 = Q[s4], q1 = Q[s4 + 1], q2 = Q[s4 + 2], q3 = Q[s4 + 3];
      const k0 = K[s4], k1 = K[s4 + 1], k2 = K[s4 + 2], k3 = K[s4 + 3];
      const w0 = w[q0], w1 = w[q1], w2 = w[q2], w3 = w[q3];
      const den = w0 * k0 * k0 + w1 * k1 * k1 + w2 * k2 * k2 + w3 * k3 * k3;
      if (den <= 0) continue;
      const i0 = 3 * q0, i1 = 3 * q1, i2 = 3 * q2, i3 = 3 * q3;
      const vx = k0 * x[i0] + k1 * x[i1] + k2 * x[i2] + k3 * x[i3];
      const vy = k0 * x[i0 + 1] + k1 * x[i1 + 1] + k2 * x[i2 + 1] + k3 * x[i3 + 1];
      const vz = k0 * x[i0 + 2] + k1 * x[i1 + 2] + k2 * x[i2 + 2] + k3 * x[i3 + 2];
      const cMag = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const sgn = S[s];
      let nx: number, ny: number, nz: number, cVal: number;
      if (sgn !== 0) {
        // Intrinsic hinge normal from current triangle pair (0,1,2) and (0,3,1): h = e0 x (e1 - e2).
        const e0x = x[i1] - x[i0], e0y = x[i1 + 1] - x[i0 + 1], e0z = x[i1 + 2] - x[i0 + 2];
        const d12x = x[i2] - x[i3], d12y = x[i2 + 1] - x[i3 + 1], d12z = x[i2 + 2] - x[i3 + 2];
        let hx = (e0y * d12z - e0z * d12y) * sgn;
        let hy = (e0z * d12x - e0x * d12z) * sgn;
        let hz = (e0x * d12y - e0y * d12x) * sgn;
        const hl = Math.sqrt(hx * hx + hy * hy + hz * hz);
        if (hl > 1e-12) {
          const invHl = 1 / hl;
          hx *= invHl; hy *= invHl; hz *= invHl;
          const dot = vx * hx + vy * hy + vz * hz;
          if (cMag > 1e-9 && dot >= 0) {
            const invC = 1 / cMag;
            nx = vx * invC; ny = vy * invC; nz = vz * invC;
            cVal = cMag;
          } else {
            // Hinge flattened or snapped inside-out (-theta_0): restore along +h so it unfolds back through flat!
            nx = hx; ny = hy; nz = hz;
            cVal = dot;
          }
        } else {
          if (cMag < 1e-12) continue;
          const invC = 1 / cMag;
          nx = vx * invC; ny = vy * invC; nz = vz * invC;
          cVal = cMag;
        }
      } else {
        if (cMag < 1e-12) continue;
        const invC = 1 / cMag;
        nx = vx * invC; ny = vy * invC; nz = vz * invC;
        cVal = cMag;
      }
      const at = A[s] * invH2, dl = (-(cVal - BR[s]) - at * BL[s]) / (den + at);
      BC[s] = cVal;
      BL[s] += dl;
      const f0 = w0 * k0 * dl, f1 = w1 * k1 * dl, f2 = w2 * k2 * dl, f3 = w3 * k3 * dl;
      x[i0] += f0 * nx; x[i0 + 1] += f0 * ny; x[i0 + 2] += f0 * nz;
      x[i1] += f1 * nx; x[i1 + 1] += f1 * ny; x[i1 + 2] += f1 * nz;
      x[i2] += f2 * nx; x[i2 + 1] += f2 * ny; x[i2 + 2] += f2 * nz;
      x[i3] += f3 * nx; x[i3 + 1] += f3 * ny; x[i3 + 2] += f3 * nz;
    }
  }

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

  /** Every particle kept `margin` clear of every collider, recording impulse-weighted normals, friction, and surface displacement. */
  private collide(margin: number, updateBudget = true) {
    const { x, w, n, prev, clearBudget, nearest, skip, activeCollideIdx, worldBox, hitScratch, contactN, contactDisp, contactPush, contactMu } = this;
    const maxBudgetNear = 0.01 + CLOTH_THICKNESS;
    let nActive = 0;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity;
    let cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      const k = 3 * i;
      if (skip[i]) {
        const cb = clearBudget[i];
        const dx = x[k] - prev[k], dy = x[k + 1] - prev[k + 1], dz = x[k + 2] - prev[k + 2];
        if (cb <= 0 || dx * dx + dy * dy + dz * dz >= cb * cb) skip[i] = 0;
        else continue;
      }
      activeCollideIdx[nActive++] = i;
      if (updateBudget) nearest[i] = maxBudgetNear;
      const px = x[k], py = x[k + 1], pz = x[k + 2];
      if (px < cx0) cx0 = px; if (px > cx1) cx1 = px;
      if (py < cy0) cy0 = py; if (py > cy1) cy1 = py;
      if (pz < cz0) cz0 = pz; if (pz > cz1) cz1 = pz;
    }
    const nCol = this.colliders.length;
    const pad = updateBudget ? 0.01 : 0;
    if (nActive > 0) for (let ci = 0; ci < nCol; ci++) {
      if (!this.worldInit[ci]) continue;
      const bo = 6 * ci;
      const x0 = worldBox[bo], y0 = worldBox[bo + 1], z0 = worldBox[bo + 2];
      const x1 = worldBox[bo + 3], y1 = worldBox[bo + 4], z1 = worldBox[bo + 5];
      if (cx1 < x0 - pad || cx0 > x1 + pad || cy1 < y0 - pad || cy0 > y1 + pad || cz1 < z0 - pad || cz0 > z1 + pad) continue;
      const c = this.colliders[ci], inv = this.inv[ci], world = this.world[ci], prevW = this.prevWorld[ci];
      const e = inv.elements, we = world.elements, pe = prevW.elements;
      const ms = this.substepMoveScale;
      const d0 = (we[0] - pe[0]) * ms, d1 = (we[1] - pe[1]) * ms, d2 = (we[2] - pe[2]) * ms;
      const d4 = (we[4] - pe[4]) * ms, d5 = (we[5] - pe[5]) * ms, d6 = (we[6] - pe[6]) * ms;
      const d8 = (we[8] - pe[8]) * ms, d9 = (we[9] - pe[9]) * ms, d10 = (we[10] - pe[10]) * ms;
      const d12 = (we[12] - pe[12]) * ms, d13 = (we[13] - pe[13]) * ms, d14 = (we[14] - pe[14]) * ms;
      const moved = Math.abs(d12) + Math.abs(d13) + Math.abs(d14) + Math.abs(d0) + Math.abs(d5) + Math.abs(d10) > 1e-12;
      const mu = c.friction;
      const lip = this.colLip[ci], gen = this.colGen[ci], colD = this.colD, colP = this.colP, colAt = this.colAt;
      const cache = colD !== null && lip < Infinity;
      for (let ai = 0; ai < nActive; ai++) {
        const i = activeCollideIdx[ai];
        const k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        if (px < x0 || px > x1 || py < y0 || py > y1 || pz < z0 || pz > z1) {
          if (updateBudget) {
            const lim = nearest[i] - CLOTH_THICKNESS;
            if (lim > 0) {
              // Outside its box (grown by the thickness): at least that far from it, and the thickness more.
              const gx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
              const gy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
              const gz = pz < z0 ? z0 - pz : pz > z1 ? pz - z1 : 0;
              const g2 = gx * gx + gy * gy + gz * gz;
              if (g2 < lim * lim) nearest[i] = Math.sqrt(g2) + CLOTH_THICKNESS;
            }
          }
          continue;
        }
        const slot = i * nCol + ci;
        // Not near enough to it at the last read to have reached the margin
        // since: it would read no contact. A pass that measures each point's
        // clearance (updateBudget) still reads every one.
        if (cache && !updateBudget && colAt![slot] === gen) {
          const s3 = 3 * slot, mx = px - colP![s3], my = py - colP![s3 + 1], mz = pz - colP![s3 + 2];
          if (colD![slot] - lip * Math.sqrt(mx * mx + my * my + mz * mz) - 1e-9 >= margin) continue;
        }
        // Into the collider's frame (no allocation).
        const lx = e[0] * px + e[4] * py + e[8] * pz + e[12];
        const ly = e[1] * px + e[5] * py + e[9] * pz + e[13];
        const lz = e[2] * px + e[6] * py + e[10] * pz + e[14];
        const ok = colliderContactInto(c, lx, ly, lz, hitScratch);
        if (cache) {
          if (ok) { colD![slot] = hitScratch.d; const s3 = 3 * slot; colP![s3] = px; colP![s3 + 1] = py; colP![s3 + 2] = pz; colAt![slot] = gen; }
          else colAt![slot] = -1;
        }
        if (updateBudget) {
          // No answer near a body (just outside its exact bounds, say): look again next substep.
          const d = ok ? hitScratch.d : CLOTH_THICKNESS;
          if (d < nearest[i]) nearest[i] = d;
        }
        if (!ok || hitScratch.d >= margin) continue;
        let wx = we[0] * hitScratch.nx + we[4] * hitScratch.ny + we[8] * hitScratch.nz;
        let wy = we[1] * hitScratch.nx + we[5] * hitScratch.ny + we[9] * hitScratch.nz;
        let wz = we[2] * hitScratch.nx + we[6] * hitScratch.ny + we[10] * hitScratch.nz;
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (wl < 1e-12) continue;
        const invWl = 1 / wl;
        wx *= invWl; wy *= invWl; wz *= invWl;
        const depth = margin - hitScratch.d;
        x[k] += wx * depth; x[k + 1] += wy * depth; x[k + 2] += wz * depth;
        contactN[k] += wx * depth; contactN[k + 1] += wy * depth; contactN[k + 2] += wz * depth;
        if (moved) {
          const bdx = d0 * lx + d4 * ly + d8 * lz + d12;
          const bdy = d1 * lx + d5 * ly + d9 * lz + d13;
          const bdz = d2 * lx + d6 * ly + d10 * lz + d14;
          contactDisp[k] += bdx * depth; contactDisp[k + 1] += bdy * depth; contactDisp[k + 2] += bdz * depth;
        }
        contactPush[i] += depth;
        contactMu[i] += mu * depth;
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

  /** Continuous collision over the substeps since it last looked (for deterministic test synchronization, never called by writeRender). */
  collidePending() { if (this.ccdSince) this.collideAlong(this.ccdSince * CLOTH_SUBSTEP); }

  /** Strictly read-only render vertex copy: never mutates physics or CCD state! */
  writeRender(out: Float64Array) {
    let o = 0;
    for (const { model, base } of this.pieces) {
      for (const g of model.groups) {
        for (const p of g.particles) { const k = 3 * (base + p); out[o++] = this.x[k]; out[o++] = this.x[k + 1]; out[o++] = this.x[k + 2]; }
      }
    }
  }

  /** The render groups, with where each starts in the render buffer. */
  renderLayout(): { name: string; vertadr: number; vertnum: number; elems: number[]; rgba: number[]; tint?: number; material: ClothMaterialName; flat?: FlatPattern; trims?: ClothTrim[]; pattern?: ClothPatternPrint }[] {
    const out: ReturnType<ClothSim['renderLayout']> = [];
    let adr = 0;
    for (const { model } of this.pieces) for (const g of model.groups) {
      out.push({ name: g.name, vertadr: adr, vertnum: g.particles.length, elems: g.tris.slice(), rgba: g.rgba, ...(g.tint !== undefined ? { tint: g.tint } : {}), material: g.material, flat: g.flat, trims: g.trims, pattern: g.pattern });
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
      if (this.grabPatch.length) {
        // Let go where it is, not flung by the last pull.
        for (const gp of this.grabPatch) {
          const k = 3 * gp.p;
          this.w[gp.p] = gp.origW;
          this.v[k] = this.v[k + 1] = this.v[k + 2] = 0;
        }
        this.grabPatch = [];
      }
      this.grabbed = particle;
      if (particle >= 0 && this.w[particle] > 0) {
        // Spread the finger pinch onto the immediate 1-ring edge neighbours so
        // tugging stiff cloth does not concentrate all impulse on one vertex.
        const patch = new Map<number, number>([[particle, 1]]);
        for (let e = 0; e < this.edges.length; e += 2) {
          const a = this.edges[e], b = this.edges[e + 1];
          const q = a === particle ? b : b === particle ? a : -1;
          if (q < 0 || !this.w[q]) continue;
          const rest = this.edgeRest[e >> 1];
          if (rest > 0.04) continue;
          const wt = 0.55 * Math.max(0.35, 1 - rest / 0.05);
          if (wt > (patch.get(q) ?? 0)) patch.set(q, wt);
        }
        for (const [p, wt] of patch) {
          const origW = this.w[p];
          const heavy = 1 + (GRAB_HEAVY - 1) * wt * wt;
          this.w[p] = origW / heavy;
          this.grabPatch.push({ p, origW, wt });
        }
      }
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

  /**
   * Detects free boundary witness vertices (up to 4 per ClothModel, prioritizing
   * sharp free outline corners > 35° plus mid-leech) from `tris`, `stitches`, and `ties`.
   */
  private initAeroWitnesses() {
    const sewn = new Uint8Array(this.n);
    for (let k = 0; k < this.stitches.length; k++) sewn[this.stitches[k]] = 1;
    const tied = new Uint8Array(this.n);
    for (const t of this.ties) tied[t.p] = 1;

    // Global incident triangle and distance-edge adjacency per particle
    const globalTrisByVert: number[][] = Array.from({ length: this.n }, () => []);
    for (let t = 0; t < this.tris.length; t += 3) {
      const triIdx = t / 3;
      globalTrisByVert[this.tris[t]].push(triIdx);
      globalTrisByVert[this.tris[t + 1]].push(triIdx);
      globalTrisByVert[this.tris[t + 2]].push(triIdx);
    }
    const globalEdgesByVert: number[][] = Array.from({ length: this.n }, () => []);
    for (let k = 0; k < this.edges.length; k += 2) {
      const edgeIdx = k / 2;
      globalEdgesByVert[this.edges[k]].push(edgeIdx);
      globalEdgesByVert[this.edges[k + 1]].push(edgeIdx);
    }

    const wParticles: number[] = [];
    const wPiece: number[] = [];
    const wEffMass: number[] = [];
    const wTrisFlat: number[] = [];
    const wTriOffsets: number[] = [0];
    const wEdgesFlat: number[] = [];
    const wEdgeOffsets: number[] = [0];

    for (let pi = 0; pi < this.pieces.length; pi++) {
      const { model: m, base } = this.pieces[pi];
      const nv = m.invMass.length;
      if (nv === 0 || m.tris.length < 3) continue;

      // Count undirected triangle-edge shares within main cloth triangles (excluding tacked overlays)
      const triEnd = m.overlayTrisStart !== undefined ? m.overlayTrisStart : m.tris.length;
      const edgeShare = new Map<number, { a: number; b: number; count: number; dirA: number; dirB: number }>();
      for (let t = 0; t < triEnd; t += 3) {
        for (let e = 0; e < 3; e++) {
          const la = m.tris[t + e], lb = m.tris[t + ((e + 1) % 3)];
          const lo = la < lb ? la : lb, hi = la < lb ? lb : la;
          const key = lo * nv + hi;
          const cur = edgeShare.get(key);
          if (cur) cur.count++;
          else edgeShare.set(key, { a: lo, b: hi, count: 1, dirA: la, dirB: lb });
        }
      }

      // Build directed free boundary adjacency (unshared, unsewn)
      const outNext = new Map<number, number[]>();
      const inPrev = new Map<number, number[]>();
      for (const entry of edgeShare.values()) {
        if (entry.count !== 1) continue;
        const ga = base + entry.dirA, gb = base + entry.dirB;
        if (sewn[ga] && sewn[gb]) continue;
        (outNext.get(ga) ?? outNext.set(ga, []).get(ga)!).push(gb);
        (inPrev.get(gb) ?? inPrev.set(gb, []).get(gb)!).push(ga);
      }

      // Compute distance of each vertex in this piece to nearest pinned/tied anchor (preferring free fly edge!)
      const anchorPts: number[] = [];
      for (let lv = 0; lv < nv; lv++) {
        const gp = base + lv;
        if (tied[gp] || this.w[gp] <= 0) anchorPts.push(gp);
      }

      interface CandidateWitness {
        gp: number;
        turnDeg: number;
        anchorDist: number;
        score: number;
      }
      const sharpCorners: CandidateWitness[] = [];
      const smoothFree: CandidateWitness[] = [];

      for (let lv = 0; lv < nv; lv++) {
        const gp = base + lv;
        if (this.w[gp] <= 0 || tied[gp] || sewn[gp]) continue;
        const prevs = inPrev.get(gp);
        const nexts = outNext.get(gp);
        if (!prevs?.length && !nexts?.length) continue;

        let minAnchorDist = 0.25;
        if (anchorPts.length > 0) {
          let bestD = Infinity;
          const px = this.x[3 * gp], py = this.x[3 * gp + 1], pz = this.x[3 * gp + 2];
          for (let ai = 0; ai < anchorPts.length; ai++) {
            const ap = anchorPts[ai];
            const d = Math.hypot(px - this.x[3 * ap], py - this.x[3 * ap + 1], pz - this.x[3 * ap + 2]);
            if (d < bestD) bestD = d;
          }
          minAnchorDist = bestD;
        }
        // Skip vertices practically sitting right on top of a grommet/tie (< 1.5 cm)
        if (anchorPts.length > 0 && minAnchorDist < 0.015) continue;

        let turnDeg = 0;
        if (prevs?.length && nexts?.length) {
          const p0 = prevs[0], p2 = nexts[0];
          const t1x = this.x[3 * gp] - this.x[3 * p0], t1y = this.x[3 * gp + 1] - this.x[3 * p0 + 1], t1z = this.x[3 * gp + 2] - this.x[3 * p0 + 2];
          const t2x = this.x[3 * p2] - this.x[3 * gp], t2y = this.x[3 * p2 + 1] - this.x[3 * gp + 1], t2z = this.x[3 * p2 + 2] - this.x[3 * gp + 2];
          const l1 = Math.hypot(t1x, t1y, t1z), l2 = Math.hypot(t2x, t2y, t2z);
          if (l1 > 1e-9 && l2 > 1e-9) {
            const cosTurn = Math.max(-1, Math.min(1, (t1x * t2x + t1y * t2y + t1z * t2z) / (l1 * l2)));
            turnDeg = (Math.acos(cosTurn) * 180) / Math.PI;
          }
        } else {
          turnDeg = 90;
        }

        const cand: CandidateWitness = {
          gp,
          turnDeg,
          anchorDist: minAnchorDist,
          score: minAnchorDist * (1 + turnDeg / 90),
        };
        if (turnDeg > 35) sharpCorners.push(cand);
        else smoothFree.push(cand);
      }

      sharpCorners.sort((a, b) => b.score - a.score);
      smoothFree.sort((a, b) => b.anchorDist - a.anchorDist);

      const chosen: number[] = [];
      const minSep = Math.max(0.035, 0.14 * (this.pieceChord[pi] || 0.4));
      const tryPick = (gp: number, sep: number): boolean => {
        if (chosen.includes(gp)) return false;
        const px = this.x[3 * gp], py = this.x[3 * gp + 1], pz = this.x[3 * gp + 2];
        for (const c of chosen) {
          if (Math.hypot(px - this.x[3 * c], py - this.x[3 * c + 1], pz - this.x[3 * c + 2]) < sep) return false;
        }
        if (globalTrisByVert[gp].length === 0) return false;
        chosen.push(gp);
        return true;
      };

      // Prioritize sharp free corners (> 35°, e.g. upper & lower fly corners), then mid-leech
      for (const sc of sharpCorners) {
        if (chosen.length >= 3) break;
        tryPick(sc.gp, minSep);
      }
      for (const sf of smoothFree) {
        if (chosen.length >= 4) break;
        tryPick(sf.gp, minSep);
      }
      for (const sc of sharpCorners) {
        if (chosen.length >= 4) break;
        tryPick(sc.gp, minSep * 0.5);
      }

      const avgTriArea = this.pieceFlatArea[pi] / Math.max(1, triEnd / 3);
      const effMass = Math.max(0.0015, 4 * m.material.arealDensity * avgTriArea);

      for (const gp of chosen) {
        wParticles.push(gp);
        wPiece.push(pi);
        wEffMass.push(effMass);
        for (const ti of globalTrisByVert[gp]) wTrisFlat.push(ti);
        wTriOffsets.push(wTrisFlat.length);
        for (const ei of globalEdgesByVert[gp]) wEdgesFlat.push(ei);
        wEdgeOffsets.push(wEdgesFlat.length);
      }
    }

    const nw = wParticles.length;
    this.witnessParticles = Int32Array.from(wParticles);
    this.witnessPiece = Int32Array.from(wPiece);
    this.witnessEffMass = Float64Array.from(wEffMass);
    this.witnessTris = Int32Array.from(wTrisFlat);
    this.witnessTriOffsets = Int32Array.from(wTriOffsets);
    this.witnessEdges = Int32Array.from(wEdgesFlat);
    this.witnessEdgeOffsets = Int32Array.from(wEdgeOffsets);
    this.witnessPrevVNorm = new Float64Array(nw);
    this.witnessPrevSpeedSq = new Float64Array(nw);
    this.witnessPrevTension = new Float64Array(nw);
    this.witnessPrevRelSpeed = new Float64Array(nw);
    this.witnessLastSnapTime = new Float64Array(nw).fill(-1);
    this.witnessInit = new Uint8Array(nw);
  }

  /**
   * Zero-allocation per-substep aeroacoustic witness, strain/bend rate, and tie-jerk sampler.
   */
  private sampleSubstepAeroTelemetry(h: number, env: ClothEnv) {
    const invH = 1 / h;
    const invH2 = invH * invH;
    const x = this.x, v = this.v, T = this.tris;
    const [wx0, wy0, wz0] = env.wind;
    const t = this.time;

    // 1. Accumulate hinge bend angular rate |c_val - c_prev| / h normalized by stencil span
    const nBends = this.bendAlpha.length;
    for (let s = 0; s < nBends; s++) {
      const curC = this.bendCurC[s];
      const dThetaDt = Math.abs(curC - this.bendPrevC[s]) * invH * this.bendSpanInv[s];
      this.bendPrevC[s] = curC;
      const pi = this.bendPiece[s];
      this.pieceAccBendRateSum[pi] += dThetaDt;
      this.pieceAccBendCount[pi]++;
    }

    // 2. Accumulate mean tensile strain rate |eps_dot| across distance edges (sampled stride-4 on dense meshes for <5 us cost)
    const nEdges = this.edgeRest.length;
    const edgeStride = nEdges > 600 ? 4 : 1;
    const startEdge = ((Math.round(t * invH) % edgeStride) + edgeStride) % edgeStride;
    for (let k = startEdge; k < nEdges; k += edgeStride) {
      const a = 3 * this.edges[2 * k], b = 3 * this.edges[2 * k + 1];
      const ex = x[a] - x[b], ey = x[a + 1] - x[b + 1], ez = x[a + 2] - x[b + 2];
      const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const rest = this.edgeRest[k];
      const prevLen = this.edgePrevLen[k];
      this.edgePrevLen[k] = len;
      if (rest > 1e-6) {
        const epsDot = Math.abs(len - prevLen) * (invH / (rest * edgeStride));
        const pi = this.edgePiece[k];
        this.pieceAccStrainRateSum[pi] += epsDot;
        this.pieceAccStrainCount[pi]++;
      }
    }

    // 3. Per-witness trailing-edge / free-corner whip-snap detector
    const nw = this.witnessParticles.length;
    for (let wi = 0; wi < nw; wi++) {
      const gp = this.witnessParticles[wi];
      if (t < this.floatUntil[gp] + 0.05) continue;
      const p3 = 3 * gp;
      const vx = v[p3], vy = v[p3 + 1], vz = v[p3 + 2];
      const speedSq = vx * vx + vy * vy + vz * vz;

      // Area-weighted vertex normal from incident triangles
      let nx = 0, ny = 0, nz = 0;
      const tStart = this.witnessTriOffsets[wi], tEnd = this.witnessTriOffsets[wi + 1];
      for (let ti = tStart; ti < tEnd; ti++) {
        const triOff = 3 * this.witnessTris[ti];
        const ia = 3 * T[triOff], ib = 3 * T[triOff + 1], ic = 3 * T[triOff + 2];
        const ux = x[ib] - x[ia], uy = x[ib + 1] - x[ia + 1], uz = x[ib + 2] - x[ia + 2];
        const wxv = x[ic] - x[ia], wyv = x[ic + 1] - x[ia + 1], wzv = x[ic + 2] - x[ia + 2];
        nx += uy * wzv - uz * wyv;
        ny += uz * wxv - ux * wzv;
        nz += ux * wyv - uy * wxv;
      }
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) continue;
      nx /= nl; ny /= nl; nz /= nl;

      const vNorm = vx * nx + vy * ny + vz * nz;

      // Incident XPBD membrane tension T_p = sum_{e ni p} |lambda_e| / h^2 (N)
      let tensionN = 0;
      const eStart = this.witnessEdgeOffsets[wi], eEnd = this.witnessEdgeOffsets[wi + 1];
      for (let ei = eStart; ei < eEnd; ei++) {
        tensionN += Math.abs(this.edgeLambda[this.witnessEdges[ei]]) * invH2;
      }

      const relSpeed = Math.hypot(vx - wx0, vy - wy0, vz - wz0);

      if (!this.witnessInit[wi]) {
        this.witnessPrevVNorm[wi] = vNorm;
        this.witnessPrevSpeedSq[wi] = speedSq;
        this.witnessPrevTension[wi] = tensionN;
        this.witnessPrevRelSpeed[wi] = relSpeed;
        this.witnessInit[wi] = 1;
        continue;
      }

      const prevVN = this.witnessPrevVNorm[wi];
      const prevSpSq = this.witnessPrevSpeedSq[wi];
      const prevTen = this.witnessPrevTension[wi];
      const prevRel = this.witnessPrevRelSpeed[wi];

      const dvNorm = Math.abs(vNorm - prevVN);
      const accelNorm = dvNorm * invH;
      const effRel = Math.max(relSpeed, prevRel);
      const isReversal = vNorm * prevVN <= 0.02 || speedSq < 0.70 * prevSpSq;
      const isTensionSpike = tensionN > 1.12 * prevTen + 0.08 || accelNorm > 75.0;

      this.witnessPrevVNorm[wi] = vNorm;
      this.witnessPrevSpeedSq[wi] = speedSq;
      this.witnessPrevTension[wi] = tensionN;
      this.witnessPrevRelSpeed[wi] = relSpeed;

      if (
        effRel >= 1.2 &&
        accelNorm > 32.0 &&
        isReversal &&
        isTensionSpike &&
        t - this.witnessLastSnapTime[wi] >= 0.065
      ) {
        this.witnessLastSnapTime[wi] = t;
        const deltaT = Math.max(0, tensionN - prevTen);
        const impulseNs = Math.max(0, Math.min(0.65, this.witnessEffMass[wi] * dvNorm + 0.0012 * deltaT));
        if (impulseNs >= 0.0005 && this.pendingSnaps.length < 16) {
          const pi = this.witnessPiece[wi];
          const m = this.pieces[pi].model;
          this.pendingSnaps.push({
            nodeId: m.name,
            impulseNs: +impulseNs.toFixed(5),
            arealDensityKgM2: m.material.arealDensity,
            relSpeedMps: +effRel.toFixed(3),
            worldPos: [+x[p3].toFixed(4), +x[p3 + 1].toFixed(4), +x[p3 + 2].toFixed(4)],
            seq: ++this.snapSeqCounter,
          });
        }
      }
    }

    // 4. Mast / rigid-body tie tension jerk -> ClothTieImpactEvent
    //    Tracks both single-substep tension jerk `(T - T_prev)/h > 160 N/s` AND ~5 ms wave-arrival
    //    tension rise `T - T_fast >= 0.45 N` (since a traveling membrane wave builds grommet tension
    //    over 2–4 substeps = 3–6 ms at 600 Hz!).
    for (let ti = 0; ti < this.ties.length; ti++) {
      const tie = this.ties[ti];
      if (!tie.body) continue;
      const curT = tie.lambda;
      if (!this.tieInit[ti] || t <= tie.sew + 0.05) {
        this.tiePrevLambda[ti] = curT;
        this.tieFastLambda[ti] = curT;
        this.tieAvgLambda[ti] = curT;
        this.tieMinLambdaWindow[ti] = curT;
        this.tieInit[ti] = 1;
        continue;
      }
      const prevT = this.tiePrevLambda[ti];
      const fastT = this.tieFastLambda[ti];
      const avgT = this.tieAvgLambda[ti];
      const minWin = this.tieMinLambdaWindow[ti];

      const dSub = curT - prevT;
      const dWave = curT - fastT;
      const dT = Math.max(dSub, dWave);
      const dTdt = Math.max(dSub * invH, dWave / 0.0022);

      // Update ~20 ms wave-trough baseline, ~110 ms EMA tension baseline, and sliding slack minimum
      this.tiePrevLambda[ti] = curT;
      this.tieFastLambda[ti] = fastT + 0.08 * (curT - fastT);
      this.tieAvgLambda[ti] = avgT + 0.015 * (curT - avgT);
      this.tieMinLambdaWindow[ti] = curT < minWin ? curT : minWin + 0.008 * (curT - minWin);

      if (dTdt > 160.0 && dT >= 0.45 && t - this.tieLastImpactTime[ti] >= 0.075) {
        this.tieLastImpactTime[ti] = t;
        this.tieFastLambda[ti] = curT;
        const isSlackSnap = minWin < 0.35 * avgT || minWin < 0.6;
        // Reset slack window after snap so a single arrest does not double-count as slack
        this.tieMinLambdaWindow[ti] = curT;
        const impulseNs = Math.max(0.002, Math.min(0.25, 0.0028 * dT * (isSlackSnap ? 1.8 : 1.0)));
        if (this.pendingTieImpacts.length < 16) {
          this.pendingTieImpacts.push({
            bodyName: tie.body,
            anchorLocal: tie.anchor && tie.anchor.length >= 3 ? [tie.anchor[0], tie.anchor[1], tie.anchor[2]] : null,
            impulseNs: +impulseNs.toFixed(5),
            isGrommetClink: isSlackSnap,
          });
        }
      }
    }
  }

  /**
   * Drains accumulated per-piece continuous `AeroVoiceTelemetry`, trailing-edge `AeroSnapEvent`s,
   * and rigid-body `ClothTieImpactEvent`s since the previous read, resetting all accumulators cleanly.
   */
  consumeAeroTelemetry(
    airDensity: number,
    isVacuum: boolean,
  ): {
    voices: AeroVoiceTelemetry[];
    snaps: AeroSnapEvent[];
    tieImpacts: ClothTieImpactEvent[];
  } {
    const nPieces = this.pieces.length;
    if (isVacuum || !(airDensity > 0)) {
      this.pieceAccForceSum.fill(0);
      this.pieceAccRelSpeedAreaSum.fill(0);
      this.pieceAccAlphaAreaSum.fill(0);
      this.pieceAccAreaSum.fill(0);
      this.pieceAccTipMax.fill(0);
      this.pieceAccBendRateSum.fill(0);
      this.pieceAccBendCount.fill(0);
      this.pieceAccStrainRateSum.fill(0);
      this.pieceAccStrainCount.fill(0);
      this.pieceSubstepsCounted.fill(0);
      this.pendingSnaps.length = 0;
      this.pendingTieImpacts.length = 0;
      return { voices: [], snaps: [], tieImpacts: [] };
    }

    const voices: AeroVoiceTelemetry[] = [];
    const x = this.x;

    for (let pi = 0; pi < nPieces; pi++) {
      const substeps = this.pieceSubstepsCounted[pi];
      const areaSum = this.pieceAccAreaSum[pi];
      const forceSum = this.pieceAccForceSum[pi];
      const relAreaSum = this.pieceAccRelSpeedAreaSum[pi];
      const alphaAreaSum = this.pieceAccAlphaAreaSum[pi];
      const tipMax = this.pieceAccTipMax[pi];
      const bendSum = this.pieceAccBendRateSum[pi];
      const bendCnt = this.pieceAccBendCount[pi];
      const strainSum = this.pieceAccStrainRateSum[pi];
      const strainCnt = this.pieceAccStrainCount[pi];

      this.pieceAccForceSum[pi] = 0;
      this.pieceAccRelSpeedAreaSum[pi] = 0;
      this.pieceAccAlphaAreaSum[pi] = 0;
      this.pieceAccAreaSum[pi] = 0;
      this.pieceAccTipMax[pi] = 0;
      this.pieceAccBendRateSum[pi] = 0;
      this.pieceAccBendCount[pi] = 0;
      this.pieceAccStrainRateSum[pi] = 0;
      this.pieceAccStrainCount[pi] = 0;
      this.pieceSubstepsCounted[pi] = 0;

      if (substeps <= 0) continue;

      const { model: m, base } = this.pieces[pi];
      const relSpeedMps = areaSum > 1e-8 ? relAreaSum / areaSum : 0;
      const alphaDeg = areaSum > 1e-8 ? alphaAreaSum / areaSum : 0;
      const aeroForceN = forceSum / substeps;
      const meanBendRate = bendCnt > 0 ? bendSum / bendCnt : 0;
      const meanStrainRate = strainCnt > 0 ? strainSum / strainCnt : 0;
      const bendRateRadPerSec = meanBendRate + 8.0 * meanStrainRate;

      // Calm / resting cloth guard: emit zero voices when effectively motionless in still air
      // (a free sheet dropped from horizontal in still air takes several seconds for gravity pendulum
      // swing to damp out; require actual flow speed >= 0.45 m/s or rapid flapping bendRate >= 2.2 rad/s).
      if (relSpeedMps < 0.45 && (tipMax < 0.85 || aeroForceN < 0.015) && bendRateRadPerSec < 2.2) continue;

      const nv = m.invMass.length;
      let cx = 0, cy = 0, cz = 0;
      if (nv > 0) {
        for (let lv = 0; lv < nv; lv++) {
          const k = 3 * (base + lv);
          cx += x[k]; cy += x[k + 1]; cz += x[k + 2];
        }
        cx /= nv; cy /= nv; cz /= nv;
      }

      voices.push({
        hubOrBodyId: m.name,
        bladeCount: 0,
        omegaRadPerSec: 0,
        tipSpeedMps: +tipMax.toFixed(4),
        relSpeedMps: +relSpeedMps.toFixed(4),
        alphaDeg: +alphaDeg.toFixed(3),
        areaM2: +this.pieceFlatArea[pi].toFixed(5),
        chordM: +this.pieceChord[pi].toFixed(4),
        thicknessM: +Math.max(0.0002, m.material.thickness).toFixed(5),
        aeroForceN: +aeroForceN.toFixed(4),
        arealDensityKgM2: +m.material.arealDensity.toFixed(4),
        bendRateRadPerSec: +bendRateRadPerSec.toFixed(4),
        isCloth: true,
        worldPos: [+cx.toFixed(4), +cy.toFixed(4), +cz.toFixed(4)],
      });
    }

    const snaps = this.pendingSnaps.length > 0 ? this.pendingSnaps.splice(0) : [];
    const tieImpacts = this.pendingTieImpacts.length > 0 ? this.pendingTieImpacts.splice(0) : [];

    return { voices, snaps, tieImpacts };
  }

  /** Positions, velocities, accumulator, float timers, board quaternions, and zipper/stitch state to carry cloth across a rebuild or worker recycle. */
  state() {
    return {
      x: Float64Array.from(this.x),
      v: Float64Array.from(this.v),
      time: this.time,
      accumulator: this.accumulator,
      floatUntil: Float64Array.from(this.floatUntil),
      boardsQ: this.boards.quats(),
      stitchSew: Float64Array.from(this.stitchSew),
      stitchGap: Float64Array.from(this.stitchGap),
      stitchOn: Uint8Array.from(this.stitchOn),
      stitchClose: Float64Array.from(this.stitchClose),
      zips: this.zips.map((z) => z.fastened),
      zipWants: this.zips.map((z) => z.want),
    };
  }
  restore(s: {
    x: ArrayLike<number>;
    v: ArrayLike<number>;
    time: number;
    accumulator?: number;
    floatUntil?: ArrayLike<number>;
    boardsQ?: ArrayLike<number>;
    stitchSew?: ArrayLike<number>;
    stitchGap?: ArrayLike<number>;
    stitchOn?: ArrayLike<number>;
    stitchClose?: ArrayLike<number>;
    zips?: ArrayLike<number>;
    zipWants?: ArrayLike<number>;
  }) {
    if (s.x.length !== this.x.length) return false;
    this.grab(null, null);
    this.x.set(s.x); this.v.set(s.v); this.prev.set(s.x); this.time = s.time;
    this.accumulator = s.accumulator ?? 0;
    if (s.floatUntil && s.floatUntil.length === this.floatUntil.length) {
      this.floatUntil.set(s.floatUntil);
      this.recomputeMaxFloatUntil();
    }
    if (s.boardsQ) this.boards.restoreQuats(s.boardsQ);
    else this.boards.resetWarm();
    this.settled = true;
    // Its seams as sewn as they were: carried without, every stitch the
    // settle had sewn shut was held at the gap it started at, and on Run a
    // hood split open over the crown and a neckerchief tore off its band.
    if (s.stitchSew && s.stitchGap && s.stitchSew.length === this.stitchSew.length) { this.stitchSew.set(s.stitchSew); this.stitchGap.set(s.stitchGap); }
    // Its zips as far done up as they were.
    if (s.stitchOn && s.stitchClose && s.zips && s.stitchOn.length === this.stitchOn.length && s.zips.length === this.zips.length) {
      this.stitchOn.set(s.stitchOn); this.stitchClose.set(s.stitchClose);
      this.zips.forEach((z, i) => {
        z.fastened = s.zips![i];
        z.want = s.zipWants && s.zipWants.length === s.zips!.length ? s.zipWants[i] : s.zips![i];
      });
    } else if (s.zips && s.zips.length === this.zips.length) {
      this.zips.forEach((z, i) => {
        z.fastened = s.zips![i];
        z.want = s.zipWants && s.zipWants.length === s.zips!.length ? s.zipWants[i] : s.zips![i];
        this.shutZip(z);
      });
    }
    this.clearBudget.fill(0);
    // Carried as it was: what it carries crossed (none, once built so) left free to come apart.
    const m = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches)), crossings = findCrossings(this.x, m);
    this.ccdOf().setTangled(crossings);
    this.ccdFrom = Float64Array.from(this.x); this.ccdSince = 0;
    // An advance left owed belonged to the state just replaced.
    this.owedEnv = null; this.ccdOwed = false; this.substepMoveScale = 1;
    this.syncAeroBaselines();
    return true;
  }

  /**
   * Copies cloths' state from `from` into this sim, cloth by cloth (`pairs`
   * maps a cloth here to the same cloth there; one whose particles or
   * stitches do not match is skipped): where each particle is and how fast
   * it moves, how long it floats, its seams, ties and zips as far sewn and
   * done up as they are. Its stitches are marked in `stitchMask` (each closed
   * tie between two copied cloths too). Returns which cloths here were copied.
   */
  private copyCloths(from: ClothSim, pairs: [number, number][], stitchMask: Uint8Array): boolean[] {
    const copied = new Array<boolean>(this.pieces.length).fill(false);
    const copyStitch = (ka: number, kb: number) => {
      stitchMask[ka] = 1;
      this.stitchSew[ka] = from.stitchSew[kb]; this.stitchGap[ka] = from.stitchGap[kb];
      this.stitchOn[ka] = from.stitchOn[kb]; this.stitchClose[ka] = from.stitchClose[kb];
    };
    for (const [pi, pj] of pairs) {
      const a = this.pieces[pi], b = from.pieces[pj];
      if (!a || !b) continue;
      const n = a.model.x0.length / 3;
      const sa = this.pieceStitchTo[pi] - this.pieceStitchFrom[pi], sb = from.pieceStitchTo[pj] - from.pieceStitchFrom[pj];
      if (b.model.x0.length / 3 !== n || sa !== sb) continue;
      copied[pi] = true;
      this.x.set(from.x.subarray(3 * b.base, 3 * (b.base + n)), 3 * a.base);
      this.prev.set(from.x.subarray(3 * b.base, 3 * (b.base + n)), 3 * a.base);
      this.v.set(from.v.subarray(3 * b.base, 3 * (b.base + n)), 3 * a.base);
      this.floatUntil.set(from.floatUntil.subarray(b.base, b.base + n), a.base);
      for (let k = 0; k < sa; k++) copyStitch(this.pieceStitchFrom[pi] + k, from.pieceStitchFrom[pj] + k);
    }
    const toFrom = new Map(pairs.filter(([pi]) => copied[pi]));
    // A tie from one cloth to another, when both ends are copied: in order among the ties between the same two.
    const tieGroups = (ts: { k: number; from: number; to: number }[], key: (t: { from: number; to: number }) => string) => {
      const g = new Map<string, number[]>();
      for (const t of ts) { const q = key(t); if (!g.has(q)) g.set(q, []); g.get(q)!.push(t.k); }
      return g;
    };
    const theirs = tieGroups(from.tieStitches, (t) => `${t.from}>${t.to}`);
    for (const [q, ks] of tieGroups(this.tieStitches.filter((t) => copied[t.from] && copied[t.to]), (t) => `${toFrom.get(t.from)}>${toFrom.get(t.to)}`)) {
      const kb = theirs.get(q);
      if (kb && kb.length === ks.length) ks.forEach((ka, i) => copyStitch(ka, kb[i]));
    }
    // Ties to bodies, by cloth and particle.
    const pieceOf = (sim: ClothSim, p: number) => sim.pieces.findIndex((pc) => p >= pc.base && p < pc.base + pc.model.x0.length / 3);
    const fromTies = new Map(from.ties.map((t) => { const pj = pieceOf(from, t.p); return [`${pj}:${t.p - from.pieces[pj].base}`, t]; }));
    for (const t of this.ties) {
      const pi = pieceOf(this, t.p);
      if (!copied[pi]) continue;
      const o = fromTies.get(`${toFrom.get(pi)}:${t.p - this.pieces[pi].base}`);
      if (o) { t.from = o.from.slice(); t.sew = o.sew; t.anchorWorld = o.anchorWorld && o.anchorWorld.slice(); }
    }
    const fromZips = new Map(from.zips.map((z) => [`${z.cloth}#${z.trim}`, z]));
    for (const z of this.zips) {
      const pi = this.pieces.findIndex((pc) => pc.model.name === z.cloth);
      const o = fromZips.get(`${z.cloth}#${z.trim}`);
      if (pi < 0 || !copied[pi] || !o || o.stitch.length !== z.stitch.length) continue;
      z.fastened = o.fastened; z.want = o.want;
      z.stitch.forEach((ka, i) => copyStitch(ka, o.stitch[i]));
    }
    this.recomputeMaxFloatUntil();
    return copied;
  }

  /**
   * Carries some cloths over from `from` (a build of the same scene before an
   * edit) as they were (copyCloths). The rest are new or changed and are
   * sewn and settled by `settleNow` from where they were modelled, with the
   * carried ones held still, except what lies over or against them: a carried
   * cloth of the same or a higher layer near a changed one (or tied to it) is
   * let move as it settles, so a changed inner garment pushes what is worn
   * over it out rather than coming through it. Cloth near none of what moves
   * is left out of the settle altogether. Returns which cloths were carried.
   */
  carryCloths(from: ClothSim, pairs: [number, number][]): boolean[] {
    if (this.time !== 0 || this.settled) return new Array<boolean>(this.pieces.length).fill(false);
    const stitchMask = new Uint8Array(this.stitchGap.length);
    const carried = this.copyCloths(from, pairs, stitchMask);
    if (!carried.some(Boolean)) return carried;
    // What lies over or against what changed moves as it settles (and so on
    // outward, from what that moves): the layers keep an outer cloth off an
    // inner, not the other way, so held still it would be come through.
    const boxes = this.pieces.map(({ base, model }) => {
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = base; i < base + model.x0.length / 3; i++) for (let c = 0; c < 3; c++) {
        const v = this.x[3 * i + c];
        if (v < b[c]) b[c] = v; if (v > b[3 + c]) b[3 + c] = v;
      }
      return b;
    });
    const near = (p: number, q: number) => [0, 1, 2].every((c) => boxes[p][c] - CARRY_REACH <= boxes[q][3 + c] && boxes[q][c] - CARRY_REACH <= boxes[p][3 + c]);
    const tied = (p: number, q: number) => this.pieces[p].model.ties.some((t) => t.cloth === this.pieces[q].model.name);
    const moves = carried.map((c) => !c);
    for (let grew = true; grew;) {
      grew = false;
      for (let d = 0; d < this.pieces.length; d++) {
        if (moves[d]) continue;
        const D = this.pieces[d].model;
        for (let c = 0; c < this.pieces.length && !moves[d]; c++) {
          if (moves[c] && c !== d && ((D.layer >= this.pieces[c].model.layer && near(c, d)) || tied(d, c))) { moves[d] = true; grew = true; }
        }
      }
    }
    // Held still, it is only in the settle for what moves to meet.
    this.carryInvolved = this.pieces.map((_, d) => moves[d] || moves.some((m, c) => m && (near(c, d) || tied(c, d) || tied(d, c))));
    this.carryPiece = Uint8Array.from(carried, Number);
    this.carryStitch = stitchMask;
    this.carryHeld = new Uint8Array(this.n); this.carryFree = new Uint8Array(this.n);
    this.pieces.forEach(({ base, model }, pi) => { if (carried[pi]) (moves[pi] ? this.carryFree! : this.carryHeld!).fill(1, base, base + model.x0.length / 3); });
    this.carryClock = from.time; this.carryAccumulator = from.accumulator;
    return carried;
  }

  /**
   * The settle after carrying cloth over (carryCloths), when some of the
   * cloth is near none of what moves: run on a sim of only what is, posed
   * as here, and copied back. Cloth anywhere in the scene
   * costs a settle's every substep, held still or not.
   */
  private settleInvolved(): boolean {
    const involved = this.carryInvolved;
    if (!involved || involved.every(Boolean)) return false;
    const idx = involved.flatMap((v, pi) => (v ? [pi] : []));
    const sub = new ClothSim(idx.map((pi) => this.pieces[pi].model), this.colliders);
    // Posed as this is (its colliders and its ties' anchors), from the same lookups.
    if (this.posedBy) sub.setPoses(...this.posedBy);
    const into = idx.map((pi, si) => [si, pi] as [number, number]);
    const carriedHere = idx.map((pi) => this.carryPiece![pi] === 1);
    // Into it as carried (only the carried), held or free as here.
    const subStitch = new Uint8Array(sub.stitchGap.length);
    sub.copyCloths(this, into.filter(([si]) => carriedHere[si]), subStitch);
    sub.carryPiece = Uint8Array.from(carriedHere, Number);
    sub.carryStitch = subStitch;
    sub.carryHeld = new Uint8Array(sub.n); sub.carryFree = new Uint8Array(sub.n);
    idx.forEach((pi, si) => {
      const a = this.pieces[pi], b = sub.pieces[si], n = a.model.x0.length / 3;
      sub.carryHeld!.set(this.carryHeld!.subarray(a.base, a.base + n), b.base);
      sub.carryFree!.set(this.carryFree!.subarray(a.base, a.base + n), b.base);
    });
    sub.carryClock = this.carryClock; sub.carryAccumulator = this.carryAccumulator;
    sub.settleNow();
    // And back, settled.
    this.copyCloths(sub, idx.map((pi, si) => [pi, si] as [number, number]), new Uint8Array(this.stitchGap.length));
    this.time = sub.time; this.accumulator = sub.accumulator;
    this.settleCut = sub.settleCut; this.untangled = sub.untangled;
    this.carryHeld = this.carryFree = this.carryPiece = this.carryStitch = null; this.carryInvolved = null;
    this.prev.set(this.x);
    this.boards.resetWarm();
    const m = (this.tangleMesh ??= untangleMesh(this.n, this.tris, this.stitches));
    this.ccdOf().setTangled(findCrossings(this.x, m));
    this.ccdFrom = Float64Array.from(this.x); this.ccdSince = 0;
    this.clearBudget.fill(0);
    this.syncAeroBaselines();
    this.settled = true;
    return true;
  }
}
