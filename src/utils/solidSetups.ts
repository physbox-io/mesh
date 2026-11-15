/**
 * Solid machining from any face: the setups after (or before) the top.
 *
 * `generateSolidMachining` with `setups: 'auto'` asks the planner which faces
 * a part needs, cuts the top (and the flip) as solid machining always has,
 * and builds a surface job for each side face here: the block stood on that
 * face, the part's first surface seen from it as the floor the cutter may not
 * go below, and only as deep as the material the plan gave that face.
 *
 * The solid exporter's own functions are handed in rather than imported, so
 * this module never imports it at runtime: a circular import between the two
 * is the kind that bundles in tests and breaks the worker build.
 */

import type { SceneGraph } from '../types/scene';
import type {
  DatumNotch,
  PlacedTabPrism,
  SolidMachiningOptions,
  SolidMachiningResult,
  SolidSideResult,
  UpAxis,
} from './solidMachiningExporter';
import {
  machineSurface,
  MAX_AVAILABLE_REACH_DIAMETERS,
  type Heightmap,
  type ReliefCarveOptions,
  type SurfaceMachiningResult,
} from './reliefCarveExporter';
import { collectSceneTriangles } from './contourSliceExporter';
import { castColumnSpans } from './columnSolid';
import { describeTurn, FACE_NAME, setupFrame, type BlockFace } from './orient';
import { simulateMilling } from './cutSimulation';
import { neededDepth, planSetups, type PartBox, type SetupPlan } from './setupPlanner';

/** One setup of a part machined from several faces, in the order they run. */
export interface SolidSetupResult extends SurfaceMachiningResult {
  /** 1-based. */
  index: number;
  of: number;
  /** The face of the block that points at the spindle, named as the block stood for setup 1. */
  upFace: BlockFace;
  /** Setup 1's work frame to this setup's: `work_k = R · work_1 + t`. */
  rotation: number[];
  translation: [number, number, number];
  /** The block as it stands for this setup. */
  stock: { widthMm: number; depthMm: number; thicknessMm: number };
  standingHeightMm: number;
  /** How the block is found again after the turn. */
  locate: 'pins' | 'knownSpot';
  /** Where to touch off, when it is located on the block itself. */
  /**
   * How the setup is zeroed. Each touch is the bit's side against a wall
   * `wallMm` in from the face the axis is measured from (0 for the face
   * itself, a datum notch's size for its wall), and `valueMm` is the work
   * position to set there with the planned bit: `wallMm` less its radius.
   */
  datum?: { description: string; touches: { axis: 'x' | 'y' | 'z'; face: string; valueMm: number; wallMm?: number }[] };
  /** What the operator does before this setup runs, in order. */
  instructions: string[];
  /** The corners this setup cuts a datum notch out of, which a clamp has to stay off. */
  notchCorners?: string[];
  /** Part of the stock this setup cuts in, its own frame. */
  windowBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Material the plan gave this setup, mm³. */
  clearedMm3: number;
  /** Deepest it cuts below its own top face, mm. */
  depthMm: number;
  /** That depth in diameters of the cutter that reaches it. */
  lengthOverDia: number;
  /** Skin left on surfaces this setup finishes, for the turn's error, mm. */
  allowanceMm: number;
  /** The side this is in a one- or two-sided job's terms, for older callers. */
  side?: 'A' | 'B';
}

/** What a plan leaves, said once for the whole job. */
export interface SetupPlanSummary {
  /** One line: how many setups and which faces. */
  text: string;
  /** Material no setup reaches, mm³, where, and why. */
  remaining: { mm3: number; bounds: PartBox | null; text: string };
  /** A change to the model that would save the turns, when there is one. */
  redesignHint?: string;
  dropped: { face: BlockFace; reason: string }[];
}

/** The solid exporter's own steps, handed in. */
export interface SolidSteps {
  generateSides: (scene: SceneGraph, opts: SolidMachiningOptions) => SolidMachiningResult;
  orientPart: (
    sceneTris: ArrayLike<number>,
    up: UpAxis,
    scale: number
  ) => { oriented: Float64Array; mnX: number; mnY: number; mnZ: number; mxX: number; mxY: number; mxZ: number; partW: number; partD: number; partH: number };
  stockFor: (partW: number, partD: number, partH: number, opts: SolidMachiningOptions) => { stockW: number; stockD: number; stockT: number; partCx: number; partCy: number; tooSmall?: string | null };
  placeInStock: (
    oriented: Float64Array,
    b: { mnX: number; mnY: number; mxX: number; mxY: number; mxZ: number },
    stockCx: number,
    stockCy: number,
    topZ: number
  ) => Float64Array;
}

const UPS: UpAxis[] = ['+z', '-z', '+x', '-x', '+y', '-y'];
/** A different orientation has to be this much cheaper than the one asked for to be taken. */
const ORIENTATION_MARGIN = 0.25;

/** Turn error per setup: a quarter of a degree, as a dial indicator on a vise jaw finds it. */
const TILT_RAD = (0.25 * Math.PI) / 180;
/**
 * How far a bit nobody has measured reaches down from the top or the underside,
 * mm: a long catalogue bit in a collet. Past this the part is on end for
 * nothing, since no bit in the rack gets to the bottom of it.
 */
const ASSUMED_STICKOUT_MM = 50;
/** Grid the earlier setups are cut back out on to see what they left of a face, mm. */
const STOOD_CELL_MM = 1;
/** How well a bit's side touches off on paper. */
const TOUCH_MM = 0.1;

/** A cube of waste in the block's first frame (x 0..W, y 0..D, z -T..0), mm. */
export interface NotchBox {
  x0: number; x1: number;
  y0: number; y1: number;
  z0: number; z1: number;
}

/**
 * The datum notch a turned setup is zeroed on, or why it has none.
 *
 * A turned block is zeroed on its own corner, and a sawn block is neither
 * square nor the size it says, so the setup lands as far off as the saw was.
 * The setup that runs first can do better: it cuts a cube out of a corner in
 * the waste, and after a turn two of that cube's walls stand on the new top
 * face at a known distance in from the corner, both cut by this machine in
 * the first setup's frame. Touched off on those, the turned setup lines up
 * with the first to the accuracy of the machine, not of the saw.
 *
 * The corner is where the turned setup's up face, its left or near face and
 * the first setup's face meet, so the first setup's face has to be its left or
 * near one: the notch is cut from that face, and only a wall cut from it is
 * square to it. The bit and a millimetre either side of it each way, so it can
 * get in and touch; no less than 6 mm. Never where the part is, nor within a
 * millimetre of it: the notch is cut as part of the setup's target, so the
 * cutter stays inside the cube and needs no more room than that.
 */
export function planDatumNotch(
  face: BlockFace,
  first: BlockFace,
  p: { tris: Float64Array; stock: { widthMm: number; depthMm: number; thicknessMm: number } },
  toolDiaMm: number
): { box: NotchBox; sizeMm: number } | { why: string } {
  if (face === '-z' || face === first) return { why: 'it is not a turned setup' };
  const { left, near } = setupFrame(face, p.stock).faceAt;
  const other = left === first ? near : near === first ? left : null;
  if (!other) return { why: `its corner is not on the ${FACE_NAME[first]}, which the first setup cuts from` };
  const w = Math.max(6, toolDiaMm + 2);
  const { widthMm: W, depthMm: D, thicknessMm: T } = p.stock;
  if (w + 1 > Math.min(W, D, T)) return { why: 'the block is too small for a notch the bit can get into' };
  const box: Partial<NotchBox> = {};
  for (const f of [face, first, other]) {
    if (f === '+x') Object.assign(box, { x0: W - w, x1: W });
    if (f === '-x') Object.assign(box, { x0: 0, x1: w });
    if (f === '+y') Object.assign(box, { y0: D - w, y1: D });
    if (f === '-y') Object.assign(box, { y0: 0, y1: w });
    if (f === '+z') Object.assign(box, { z0: -w, z1: 0 });
    if (f === '-z') Object.assign(box, { z0: -T, z1: -T + w });
  }
  if ([box.x0, box.y0, box.z0].some((v) => v === undefined)) return { why: 'no corner of the block meets those faces' };
  const b = box as NotchBox;

  // Clear of the part, all round: the solid spans of the part's columns
  // over the notch, padded, may not reach into it.
  const pad = 1;
  const x0 = Math.max(0, b.x0 - pad), x1 = Math.min(W, b.x1 + pad);
  const y0 = Math.max(0, b.y0 - pad), y1 = Math.min(D, b.y1 + pad);
  const step = Math.max(0.25, Math.min(1, w / 12));
  const cols = Math.ceil((x1 - x0) / step) + 1, rows = Math.ceil((y1 - y0) / step) + 1;
  const spans = castColumnSpans(p.tris, {
    minX: x0, minY: y0, stepX: (x1 - x0) / Math.max(1, cols - 1), stepY: (y1 - y0) / Math.max(1, rows - 1), cols, rows,
  });
  for (let k = 0; k < cols * rows; k++) {
    for (let e = spans.offset[k]; e < spans.offset[k + 1]; e += 2) {
      if (spans.z[e + 1] > b.z0 - pad && spans.z[e] < b.z1 + pad) {
        return { why: `the part comes within ${(w + pad).toFixed(0)} mm of that corner of the block, where the notch would go` };
      }
    }
  }
  return { box: b, sizeMm: w };
}

/** A notch box as the top setup's `datumNotches` take it. */
function asTopNotch(b: NotchBox): DatumNotch {
  return { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, depthMm: -b.z0 };
}

/** A way up and its coarse plan, for the fine plan to be made on. */
interface UpCandidate {
  p: Placement;
  plan: SetupPlan;
}

interface Placement {
  up: UpAxis;
  twoSided: boolean;
  tris: Float64Array;
  partBox: PartBox;
  stock: { widthMm: number; depthMm: number; thicknessMm: number };
}

/** Places the part as `generateSides` will for this orientation and side count. */
function place(sceneTris: ArrayLike<number>, opts: SolidMachiningOptions, up: UpAxis, twoSided: boolean, steps: SolidSteps): Placement | null {
  const scale = Math.max(0.01, opts.scalePercent / 100) * 1000;
  const o = steps.orientPart(sceneTris, up, scale);
  if (!(o.partW > 1e-6 && o.partD > 1e-6 && o.partH > 1e-6)) return null;
  const sized = { ...opts, up, sides: (twoSided ? 2 : 1) as 1 | 2 };
  const { stockW, stockD, stockT, partCx, partCy, tooSmall } = steps.stockFor(o.partW, o.partD, o.partH, sized);
  // A way up the board cannot hold is no candidate; if none can, the plan fails saying so.
  if (tooSmall || stockT < o.partH - 1e-6) return null;
  const topZ = twoSided ? -(stockT - o.partH) / 2 : -(stockT - o.partH);
  const tris = steps.placeInStock(o.oriented, o, partCx, partCy, topZ);
  const partBox: PartBox = {
    minX: partCx - o.partW / 2,
    maxX: partCx + o.partW / 2,
    minY: partCy - o.partD / 2,
    maxY: partCy + o.partD / 2,
    minZ: topZ - o.partH,
    maxZ: topZ,
  };
  return { up, twoSided, tris, partBox, stock: { widthMm: stockW, depthMm: stockD, thicknessMm: stockT } };
}

/** The cutter a side setup reaches in with, and how far it can. */
function sideTool(opts: SolidMachiningOptions): { dia: number; reach: number; reachZ: number } {
  const activeDia = opts.finishingEnabled ? opts.finishingToolDiaMm : opts.roughingToolDiaMm;
  const dia = Math.max(0.1, activeDia);
  const byDiameters = dia * MAX_AVAILABLE_REACH_DIAMETERS;
  // A declared stickout is the bit actually fitted: past 8 D it is a long-reach
  // bit, and the operator has said so by fitting it.
  const declared = opts.toolStickoutMm > 0;
  const reach = declared ? Math.max(byDiameters, opts.toolStickoutMm - 1) : byDiameters;
  return { dia, reach, reachZ: declared ? reach : Math.max(byDiameters, ASSUMED_STICKOUT_MM) };
}

/** Largest cutter active in the setup, used to size datum notches so roughing fits safely. */
function maxActiveToolDia(opts: Pick<SolidMachiningOptions, 'roughingEnabled' | 'roughingToolDiaMm' | 'finishingEnabled' | 'finishingToolDiaMm'>): number {
  return Math.max(
    0.1,
    opts.roughingEnabled ? opts.roughingToolDiaMm : 0,
    opts.finishingEnabled ? opts.finishingToolDiaMm : 0
  );
}

/** Tool fitted at the start of a setup when the operator touches off X/Y/Z. */
function touchToolDia(opts: Pick<SolidMachiningOptions, 'roughingEnabled' | 'roughingToolDiaMm' | 'finishingToolDiaMm'>): number {
  return Math.max(0.1, opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm);
}

/**
 * Plans a through-thickness corner notch cut by setup 1 (`+z`) in the near-right
 * corner `[W - w, W] × [0, w] × [-T, 0]`, which flips left-to-right into the
 * near-left corner `[0, w] × [0, w]` of `-z` when dowel pins cannot be used.
 */
function planFlipDatumNotch(
  p: { tris: Float64Array; stock: { widthMm: number; depthMm: number; thicknessMm: number } },
  toolDiaMm: number,
  reachZMm: number
): { box: NotchBox; sizeMm: number } | { why: string } {
  const w = Math.max(6, toolDiaMm + 2);
  const { widthMm: W, depthMm: D, thicknessMm: T } = p.stock;
  if (w + 1 > Math.min(W, D)) return { why: 'the block is too narrow in plan for a through datum notch' };
  if (T > reachZMm + 1e-6) return { why: `the bit's ${reachZMm.toFixed(0)} mm reach cannot cut a datum notch through the ${T.toFixed(0)} mm block` };
  const b: NotchBox = { x0: W - w, x1: W, y0: 0, y1: w, z0: -T, z1: 0 };
  const pad = 1;
  const x0 = Math.max(0, b.x0 - pad), x1 = W;
  const y0 = 0, y1 = Math.min(D, b.y1 + pad);
  const step = Math.max(0.25, Math.min(1, w / 12));
  const cols = Math.ceil((x1 - x0) / step) + 1, rows = Math.ceil((y1 - y0) / step) + 1;
  const spans = castColumnSpans(p.tris, {
    minX: x0, minY: y0, stepX: (x1 - x0) / Math.max(1, cols - 1), stepY: (y1 - y0) / Math.max(1, rows - 1), cols, rows,
  });
  for (let k = 0; k < cols * rows; k++) {
    if (spans.offset[k + 1] > spans.offset[k]) {
      return { why: `the part comes within ${(w + pad).toFixed(0)} mm of the near-right corner` };
    }
  }
  return { box: b, sizeMm: w };
}

/**
 * Fallback datum for `-z` when neither pins nor a through datum notch fit and
 * earlier flush setups milled away `-z`'s default left (`+x`) or near (`-y`) face.
 */
function flipFallbackDatum(
  stock: { widthMm: number; depthMm: number; thicknessMm: number },
  flushed: ReadonlySet<BlockFace>,
  touchRadiusMm: number
): SolidSetupResult['datum'] | undefined {
  if (!flushed.has('+x') && !flushed.has('-y')) return undefined;
  const W = stock.widthMm, D = stock.depthMm;
  const xTouch = !flushed.has('+x')
    ? { axis: 'x' as const, face: FACE_NAME['+x'], valueMm: -touchRadiusMm, wallMm: 0, desc: `X on the ${FACE_NAME['+x']} (left)` }
    : !flushed.has('-x')
      ? { axis: 'x' as const, face: `${FACE_NAME['-x']} (right)`, valueMm: W + touchRadiusMm, wallMm: W, desc: `X on the un-cut ${FACE_NAME['-x']} (right)` }
      : { axis: 'x' as const, face: `machined ${FACE_NAME['+x']} part wall (left)`, valueMm: -touchRadiusMm, wallMm: 0, desc: `X on the machined ${FACE_NAME['+x']} part wall (left)` };
  const yTouch = !flushed.has('-y')
    ? { axis: 'y' as const, face: FACE_NAME['-y'], valueMm: -touchRadiusMm, wallMm: 0, desc: `Y on the ${FACE_NAME['-y']} (near)` }
    : !flushed.has('+y')
      ? { axis: 'y' as const, face: `${FACE_NAME['+y']} (far)`, valueMm: D + touchRadiusMm, wallMm: D, desc: `Y on the un-cut ${FACE_NAME['+y']} (far)` }
      : { axis: 'y' as const, face: `machined ${FACE_NAME['-y']} part wall (near)`, valueMm: -touchRadiusMm, wallMm: 0, desc: `Y on the machined ${FACE_NAME['-y']} part wall (near)` };
  return {
    description: `${xTouch.desc}, ${yTouch.desc}, Z on the ${FACE_NAME['-z']} (top).`,
    touches: [
      { axis: xTouch.axis, face: xTouch.face, valueMm: xTouch.valueMm, wallMm: xTouch.wallMm },
      { axis: yTouch.axis, face: yTouch.face, valueMm: yTouch.valueMm, wallMm: yTouch.wallMm },
      { axis: 'z', face: FACE_NAME['-z'], valueMm: 0 },
    ],
  };
}

/** Converts placed 3D holding-tab bridges (setup 1 frame) into closed mesh triangles. */
function tabPrismTriangles(prisms: PlacedTabPrism[]): Float64Array {
  const valid = prisms.filter((t) => Math.hypot(t.x1 - t.x0, t.y1 - t.y0) > 1e-6 && t.topZ > t.bottomZ + 1e-6);
  if (valid.length === 0) return new Float64Array(0);
  const out = new Float64Array(valid.length * 12 * 9);
  let off = 0;
  const pushTri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    out[off++] = a[0]; out[off++] = a[1]; out[off++] = a[2];
    out[off++] = b[0]; out[off++] = b[1]; out[off++] = b[2];
    out[off++] = c[0]; out[off++] = c[1]; out[off++] = c[2];
  };
  for (const t of valid) {
    const dx = t.x1 - t.x0, dy = t.y1 - t.y0;
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const hw = t.widthMm / 2;
    const xy: [number, number][] = [
      [t.x0 - uy * hw, t.y0 + ux * hw],
      [t.x0 + uy * hw, t.y0 - ux * hw],
      [t.x1 + uy * hw, t.y1 - ux * hw],
      [t.x1 - uy * hw, t.y1 + ux * hw],
    ];
    const b = xy.map(([x, y]): [number, number, number] => [x, y, t.bottomZ]);
    const u = xy.map(([x, y]): [number, number, number] => [x, y, t.topZ]);
    pushTri(u[0], u[1], u[2]); pushTri(u[0], u[2], u[3]);
    pushTri(b[0], b[2], b[1]); pushTri(b[0], b[3], b[2]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      pushTri(b[i], b[j], u[j]);
      pushTri(b[i], u[j], u[i]);
    }
  }
  return out;
}

/**
 * Predicts a side setup's cut envelope and undercut entry footprint in setup 1's
 * frame before `generateSides` runs, so `placeTabs` stays clear of undercut
 * mouths and `+z`/`-z` `chooseTouchSpot` knows where earlier side setups cut.
 */
function previewSideCutInFirst(
  face: BlockFace,
  p: Placement,
  plan: SetupPlan,
  opts: SolidMachiningOptions
): { cutBox: NotchBox; mouthXY: { minX: number; maxX: number; minY: number; maxY: number } | null } | null {
  const frame = setupFrame(face, p.stock);
  const s = frame.stock;
  const tool = sideTool(opts);
  const r = tool.dia / 2;
  const axes = { '+z': [0, 1], '-z': [0, 1], '+x': [1, 2], '-x': [1, 2], '+y': [0, 2], '-y': [0, 2] }[face];
  const needWide = neededDepth(plan, face, p.stock, p.partBox, tool.dia + 2);
  const needExact = neededDepth(plan, face, p.stock, p.partBox, 0);
  const tabT = Math.max(0.5, opts.tabThicknessMm);
  const tabZ0 = p.twoSided ? -p.stock.thicknessMm / 2 - tabT / 2 : -p.stock.thicknessMm;
  const tabZ1 = p.twoSided ? -p.stock.thicknessMm / 2 + tabT / 2 : -p.stock.thicknessMm + tabT;
  const probe = Math.max(0.5, Math.min(2, r / 2));
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, deepest = 0;
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, coreDeep = 0;
  for (let y = probe / 2; y < s.depthMm; y += probe) {
    for (let x = probe / 2; x < s.widthMm; x += probe) {
      const q = frame.toFirst([x, y, 0]);
      const d = needWide(q[axes[0]], q[axes[1]]);
      if (d > 0) {
        wx0 = Math.min(wx0, x); wx1 = Math.max(wx1, x);
        wy0 = Math.min(wy0, y); wy1 = Math.max(wy1, y);
        deepest = Math.max(deepest, d);
      }
      const dc = needExact(q[axes[0]], q[axes[1]]);
      if (dc > 0 && q[2] >= tabZ0 && q[2] <= tabZ1) {
        cx0 = Math.min(cx0, x); cx1 = Math.max(cx1, x);
        cy0 = Math.min(cy0, y); cy1 = Math.max(cy1, y);
        coreDeep = Math.max(coreDeep, dc);
      }
    }
  }
  if (!(deepest > 0)) return null;
  const pad = r + 2;
  const win = {
    minX: Math.max(0, wx0 - pad), minY: Math.max(0, wy0 - pad),
    maxX: Math.min(s.widthMm, wx1 + pad), maxY: Math.min(s.depthMm, wy1 + pad),
  };
  const boxFromSetup = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): NotchBox => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) {
      const q = frame.toFirst([x, y, z]);
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
    }
    return { x0: lo[0], x1: hi[0], y0: lo[1], y1: hi[1], z0: lo[2], z1: hi[2] };
  };
  const cutBox = boxFromSetup(win.minX, win.maxX, win.minY, win.maxY, -deepest, 0);
  const mBox = coreDeep > 0
    ? boxFromSetup(Math.max(0, cx0 - r), Math.min(s.widthMm, cx1 + r), Math.max(0, cy0 - r), Math.min(s.depthMm, cy1 + r), -coreDeep, 0)
    : null;
  return {
    cutBox,
    mouthXY: mBox ? { minX: mBox.x0, maxX: mBox.x1, minY: mBox.y0, maxY: mBox.y1 } : null,
  };
}

function plannerInput(p: Placement, opts: SolidMachiningOptions, only?: BlockFace[], cellMm?: number) {
  const tool = sideTool(opts);
  return {
    cellMm,
    tris: p.tris,
    partBox: p.partBox,
    stock: p.stock,
    toolDiaMm: tool.dia,
    reachMm: tool.reach,
    reachZMm: tool.reachZ,
    maxSetups: Math.max(1, opts.maxSetups ?? 6),
    allowUnderside: only ? only.includes('-z') : true,
    allowSides: only ? only.some((f) => f !== '+z' && f !== '-z') : true,
    onlyFaces: only,
    clearanceMm: opts.clearanceMm ?? 0,
    stickoutMm: opts.toolStickoutMm,
  };
}

/**
 * The orientation and faces for a part: each of the six ways up, planned,
 * the cheapest kept. The way up asked for wins unless another is clearly
 * cheaper, so a part that is fine as it is stays as it was drawn.
 */
function choose(sceneTris: ArrayLike<number>, opts: SolidMachiningOptions, steps: SolidSteps): UpCandidate[] {
  const ups = opts.setups === 'auto' && opts.autoOrient !== false ? [opts.up, ...UPS.filter((u) => u !== opts.up)] : [opts.up];
  const only = Array.isArray(opts.setups) ? (opts.setups as BlockFace[]) : undefined;
  const found: UpCandidate[] = [];
  for (const up of ups) {
    // Planned on the two-sided block, whose skins are the same top and bottom;
    // the real placement is planned again once the side count is known.
    const p = place(sceneTris, opts, up, true, steps);
    if (!p) continue;
    // A coarse grid, a third of the cutter's diameter: a shortlist only. Its
    // costs are not the fine plan's (a thin sliver hardly registers), so the
    // way up asked for and the best of the rest are planned again finely and
    // compared there.
    const size = Math.max(p.partBox.maxX - p.partBox.minX, p.partBox.maxY - p.partBox.minY, p.partBox.maxZ - p.partBox.minZ);
    const plan = planSetups(plannerInput(p, opts, only, Math.max(sideTool(opts).dia / 3, size / 80)));
    found.push({ p, plan });
  }
  const asked = found.find((c) => c.p.up === opts.up);
  const others = found.filter((c) => c !== asked).sort((a, b) => a.plan.cost - b.plan.cost);
  return [asked, others[0]].filter((c): c is UpCandidate => !!c);
}

/** What to tell the operator a plan leaves, and what would change it. */
function summarise(plan: SetupPlan): SetupPlanSummary {
  const names = plan.order.map((f) => FACE_NAME[f]);
  const text =
    names.length === 1
      ? '1 setup (top).'
      : `${names.length} setups: ${names.join(', then ')}.`;
  // Only ever what a router always leaves: a plan that left more than that fails instead.
  const mm3 = Math.round(plan.unreachedMm3);
  const remaining = {
    mm3,
    bounds: plan.unreachedBounds,
    text: mm3 < 1 ? 'All surfaces reached.' : 'Inside corners filleted to cutter radius.',
  };
  const sides = plan.order.filter((f) => f !== '+z' && f !== '-z');
  const redesignHint =
    sides.length > 0
      ? `Removing side undercuts reduces this to ${plan.order.includes('-z') ? '2 setups (top and flip)' : '1 setup'}.`
      : undefined;
  return { text, remaining, redesignHint, dropped: plan.dropped };
}

/**
 * Why a plan cannot make the part, in words a beginner can act on, or null
 * when it can. Corners sharper than the bit come out rounded on any router
 * and are not a reason; anything else left uncut is: a plan that leaves the
 * part wrong is not offered.
 */
function planFailure(plan: SetupPlan, partMm3: number): string | null {
  const leftOver = plan.unreachedMm3 - plan.unreachableAnywhereMm3;
  // Small: a sliver under a lip is small next to the part and still stops a
  // phone going in. Only what is out of this bit's reach counts here, which
  // has none of the voxel noise along every surface.
  if (leftOver <= Math.max(20, 0.0002 * partMm3)) return null;
  if (plan.longerBit) {
    return (
      `Some features exceed tool reach from any side. Use a bit with at least ${plan.longerBit.reachMm} mm stickout, or scale the part down.`
    );
  }
  if (plan.dropped.some((d) => /under the spindle/.test(d.reason))) {
    return (
      `Standing the block on end exceeds spindle Z clearance. Scale the part down or increase Room Under Spindle.`
    );
  }
  return (
    `Internal or undercut features cannot be reached from any of the six block faces.`
  );
}

/**
 * The part's first surface seen down from the top of a turned block: per
 * cell of `grid`, the height of the highest solid, or -Infinity where the
 * column misses the part.
 */
function firstSurface(tris: Float64Array, grid: { minX: number; minY: number; stepX: number; stepY: number; cols: number; rows: number }): Float32Array {
  const spans = castColumnSpans(tris, grid);
  const z = new Float32Array(grid.cols * grid.rows).fill(-Infinity);
  for (let k = 0; k < z.length; k++) {
    const end = spans.offset[k + 1];
    if (end > spans.offset[k]) z[k] = spans.z[end - 1];
  }
  return z;
}

const setupTrisCache = new WeakMap<Float64Array, Map<string, Float64Array>>();

function toSetupTris(
  pTris: Float64Array,
  face: BlockFace,
  frame: ReturnType<typeof setupFrame>
): Float64Array {
  const s = frame.stock;
  const cacheKey = `${face}:${s.widthMm},${s.depthMm},${s.thicknessMm}`;
  let perPlacement = setupTrisCache.get(pTris);
  if (perPlacement) {
    const cached = perPlacement.get(cacheKey);
    if (cached) return cached;
  } else {
    perPlacement = new Map();
    setupTrisCache.set(pTris, perPlacement);
  }
  const tris = new Float64Array(pTris.length);
  for (let i = 0; i < pTris.length; i += 3) {
    const q = frame.toSetup([pTris[i], pTris[i + 1], pTris[i + 2]]);
    tris[i] = q[0]; tris[i + 1] = q[1]; tris[i + 2] = q[2];
  }
  if (perPlacement.size >= 8) {
    const oldest = perPlacement.keys().next().value;
    if (oldest !== undefined) perPlacement.delete(oldest);
  }
  perPlacement.set(cacheKey, tris);
  return tris;
}

/**
 * Whether a point of a turned setup's top face is still there. The earlier
 * setups have been at the block, and a side that ends flush with the part has
 * been cut away wherever the top setup ran off it. Those programs are only run
 * if a tool change asks.
 */
function stoodAfter(
  frame: ReturnType<typeof setupFrame>,
  block: Placement['stock'],
  earlier: { upFace: BlockFace; gcode: string; stock: SolidSetupResult['stock'] }[],
  opts: SolidMachiningOptions
): (x: number, y: number) => boolean {
  let cut: { frame: ReturnType<typeof setupFrame>; at: (x: number, y: number) => number }[] | null = null;
  const finishShape: 'flat' | 'ball' | 'v_bit' =
    opts.finishingToolType === 'ball_nose' ? 'ball' : opts.finishingToolType === 'v_bit' ? 'v_bit' : 'flat';
  return (x, y) => {
    cut ??= earlier.map((e) => ({
      frame: setupFrame(e.upFace, block),
      at: simulateMilling(e.gcode, {
        widthMm: e.stock.widthMm,
        depthMm: e.stock.depthMm,
        cellMm: STOOD_CELL_MM,
        tools: {
          1: { shape: 'flat', diameterMm: opts.roughingToolDiaMm },
          2: { shape: finishShape, diameterMm: opts.finishingToolDiaMm, vAngleDeg: opts.finishingVBitAngleDeg },
        },
        initialTool: opts.roughingEnabled ? 1 : 2,
      }).at,
    }));
    const onBlock = frame.toFirst([x, y, 0]);
    return cut.every((c) => {
      const q = c.frame.toSetup(onBlock);
      return c.at(q[0], q[1]) >= q[2] - STOOD_CELL_MM / 2;
    });
  };
}

/**
 * One side setup: the block stood with `face` up, cut down to the material
 * the plan gave that face and never below the part.
 */
function sideSetup(
  face: BlockFace,
  p: Placement,
  plan: SetupPlan,
  opts: SolidMachiningOptions,
  carveOpts: ReliefCarveOptions,
  warnings: string[],
  notchMm?: number,
  /** Datum notches this setup cuts for the ones after it, in the block's first frame. */
  cutsNotches: NotchBox[] = [],
  /** The setups that run before this one. */
  earlier: { upFace: BlockFace; gcode: string; stock: SolidSetupResult['stock'] }[] = [],
  prevUp?: BlockFace
): Omit<SolidSetupResult, 'index' | 'of' | 'instructions'> | { error: string } {
  const frame = setupFrame(face, p.stock);
  const s = frame.stock;
  const tool = sideTool(opts);
  const r = tool.dia / 2;
  const touchR = touchToolDia(opts) / 2;
  // Wide enough round what the face has to clear for the whole cutter to get
  // down beside it with the turn's skin on the walls (under 2 mm on any part a
  // router takes).
  const need = neededDepth(plan, face, p.stock, p.partBox, tool.dia + 2);

  // The part (plus any holding tabs placed by +z/-z) in this setup's frame.
  const tris = toSetupTris(p.tris, face, frame);

  // Where this setup has anything to do, from a coarse look at what it needs.
  const axes = { '+z': [0, 1], '-z': [0, 1], '+x': [1, 2], '-x': [1, 2], '+y': [0, 2], '-y': [0, 2] }[face];
  const needAt = (x: number, y: number) => {
    const q = frame.toFirst([x, y, 0]);
    return need(q[axes[0]], q[axes[1]]);
  };
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity, deepest = 0;
  const probe = Math.max(0.5, Math.min(2, r / 2));
  for (let y = probe / 2; y < s.depthMm; y += probe) {
    for (let x = probe / 2; x < s.widthMm; x += probe) {
      const d = needAt(x, y);
      if (d <= 0) continue;
      wx0 = Math.min(wx0, x); wx1 = Math.max(wx1, x);
      wy0 = Math.min(wy0, y); wy1 = Math.max(wy1, y);
      deepest = Math.max(deepest, d);
    }
  }
  if (!(deepest > 0)) return { error: `the ${FACE_NAME[face]} has nothing to cut` };
  const pad = r + 2;
  // The notches, turned into this frame: a box on this setup's top face,
  // down to its floor.
  const notches = cutsNotches.map((b) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
      const q = frame.toSetup([x, y, z]);
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
    }
    return { x0: lo[0], x1: hi[0], y0: lo[1], y1: hi[1], depthMm: -lo[2] };
  });
  for (const n of notches) {
    wx0 = Math.min(wx0, n.x0); wx1 = Math.max(wx1, n.x1);
    wy0 = Math.min(wy0, n.y0); wy1 = Math.max(wy1, n.y1);
  }
  const window = {
    minX: Math.max(0, wx0 - pad), minY: Math.max(0, wy0 - pad),
    maxX: Math.min(s.widthMm, wx1 + pad), maxY: Math.min(s.depthMm, wy1 + pad),
  };

  // Sampled finely enough for the cutter, and no more than a heightmap's worth.
  let res = Math.min(0.6, tool.dia / 15);
  const area = (window.maxX - window.minX) * (window.maxY - window.minY);
  res = Math.max(res, Math.sqrt(area / 250_000));
  const cols = Math.ceil((window.maxX - window.minX) / res) + 1;
  const rows = Math.ceil((window.maxY - window.minY) / res) + 1;
  const stepX = (window.maxX - window.minX) / Math.max(1, cols - 1);
  const stepY = (window.maxY - window.minY) / Math.max(1, rows - 1);
  const grid = { minX: window.minX, minY: window.minY, stepX, stepY, cols, rows };
  const partTop = firstSurface(tris, grid);

  /*
   * The skin a turned setup leaves for the turn's own error: the bit touched
   * off on paper, and a quarter of a degree of tilt over the depth it cuts.
   * Inflated in plan by the same, so a wall is not shaved either. Kept to
   * what that error can really be: a feature only this setup cuts keeps the
   * skin for good, and a millimetre of it inside a small part is a wrong
   * part. Never below the part: each target is max(part + skin, -needed depth).
   */
  const allowance = TOUCH_MM + deepest * Math.tan(TILT_RAD);
  const reachCells = Math.ceil(allowance / Math.min(stepX, stepY));
  const z = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const d = needAt(window.minX + i * stepX, window.minY + j * stepY);
      if (d <= 0) { z[k] = 0; continue; }
      let floor = -Infinity;
      for (let dj = -reachCells; dj <= reachCells; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= rows) continue;
        for (let di = -reachCells; di <= reachCells; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= cols) continue;
          if (Math.hypot(di * stepX, dj * stepY) > allowance + 1e-9) continue;
          floor = Math.max(floor, partTop[jj * cols + ii]);
        }
      }
      const kept = floor === -Infinity ? -Infinity : floor + allowance;
      z[k] = Math.min(0, Math.max(-s.thicknessMm, Math.max(kept, -d)));
    }
  }
  for (const n of notches) {
    for (let j = 0; j < rows; j++) {
      const y = window.minY + j * stepY;
      if (y < n.y0 - 1e-9 || y > n.y1 + 1e-9) continue;
      for (let i = 0; i < cols; i++) {
        const x = window.minX + i * stepX;
        if (x < n.x0 - 1e-9 || x > n.x1 + 1e-9) continue;
        z[j * cols + i] = Math.min(z[j * cols + i], -n.depthMm);
      }
    }
  }
  const surface: Heightmap = { ...window, cols, rows, stepX, stepY, z };
  let depth = 0;
  for (let k = 0; k < z.length; k++) depth = Math.max(depth, -z[k]);

  const header = [
    `; Solid part machining — ${FACE_NAME[face].toUpperCase()} UP`,
    `; Stand the block: ${describeTurn(frame, prevUp)}`,
    `; Stock as it stands: ${s.widthMm.toFixed(1)} x ${s.depthMm.toFixed(1)} x ${s.thicknessMm.toFixed(1)} mm`,
    notchMm
      ? `; Origin      : X0 Y0 found from the ${notchMm.toFixed(1)} mm near-left datum notch walls; Z0 on top face`
      : '; Origin      : near-left corner of the block as it stands now, top face, Z0',
    `; Skin left   : ${allowance.toFixed(2)} mm on what this setup finishes, for the turn`,
    ...(notchMm
      ? [`; Zero X, Y   : on the far walls of the ${notchMm.toFixed(1)} mm datum notch setup 1 cut in the near-left corner, not on the sawn faces`]
      : []),
    ...notches.map(
      (n) => `; Datum notch : ${(n.x1 - n.x0).toFixed(1)} mm cube out of the corner at X${n.x0.toFixed(1)}-${n.x1.toFixed(1)} Y${n.y0.toFixed(1)}-${n.y1.toFixed(1)}, the zero for a later turned setup`
    ),
  ];
  const runOff = {
    minX: window.minX <= 1e-6 && notches.some((n) => n.x0 <= 1e-6),
    maxX: window.maxX >= s.widthMm - 1e-6 && notches.some((n) => n.x1 >= s.widthMm - 1e-6),
    minY: window.minY <= 1e-6 && notches.some((n) => n.y0 <= 1e-6),
    maxY: window.maxY >= s.depthMm - 1e-6 && notches.some((n) => n.y1 >= s.depthMm - 1e-6),
  };
  const hasRunOff = runOff.minX || runOff.maxX || runOff.minY || runOff.maxY;
  const cut = machineSurface(
    {
      surface,
      bounds: { ...window, minZ: -s.thicknessMm, maxZ: 0 },
      depthMm: depth,
      resolution: Math.min(stepX, stepY),
      header,
      noun: 'cut',
      touchOff: {
        area: { minX: 0, minY: 0, maxX: s.widthMm, maxY: s.depthMm },
        standsAt: stoodAfter(frame, p.stock, earlier, opts),
      },
      ...(hasRunOff ? { runOff } : {}),
    },
    {
      ...carveOpts,
      stockWidthMm: s.widthMm,
      stockDepthMm: s.depthMm,
      stockThicknessMm: s.thicknessMm,
      carveDepthMm: depth,
      // Probed on the top; this is another face.
      applyMeshLeveling: false,
      meshLevelGrid: null,
    },
    warnings
  );
  if (!cut.success) return { error: cut.error ?? 'no toolpath' };

  const near = frame.faceAt.near, left = frame.faceAt.left;
  return {
    ...cut,
    upFace: face,
    rotation: frame.rotation,
    translation: frame.translation,
    stock: s,
    standingHeightMm: s.thicknessMm,
    locate: 'knownSpot',
    // On the notch the top setup cut, when there is one: its far walls are
    // `notchMm` in from the left and near faces, and the bit touches them
    // from inside the notch, so its middle is a radius short of that.
    datum: notchMm
      ? {
          description:
            `X on the left datum notch wall, Y on the near datum notch wall, Z on the ${FACE_NAME[face]} (top).`,
          touches: [
            { axis: 'x', face: 'datum notch, wall facing left', valueMm: notchMm - touchR, wallMm: notchMm },
            { axis: 'y', face: 'datum notch, wall facing you', valueMm: notchMm - touchR, wallMm: notchMm },
            { axis: 'z', face: FACE_NAME[face], valueMm: 0 },
          ],
        }
      : {
          description:
            `X on the ${FACE_NAME[left]} (left), Y on the ${FACE_NAME[near]} (near), Z on the ${FACE_NAME[face]} (top).`,
          touches: [
            { axis: 'x', face: FACE_NAME[left], valueMm: -touchR, wallMm: 0 },
            { axis: 'y', face: FACE_NAME[near], valueMm: -touchR, wallMm: 0 },
            { axis: 'z', face: FACE_NAME[face], valueMm: 0 },
          ],
        },
    windowBounds: window,
    clearedMm3: plan.faces[face]?.clearedMm3 ?? 0,
    depthMm: depth,
    lengthOverDia: depth / tool.dia,
    allowanceMm: allowance,
  };
}

/** A legacy side as a setup. */
function asSetup(
  side: SolidSideResult,
  result: SolidMachiningResult,
  plan: SetupPlan | null,
  reachDia: number,
  touchDia: number,
  /** The datum notch an earlier setup cut for this one, as in `sideSetup`. */
  notchMm?: number,
  customDatum?: SolidSetupResult['datum']
): Omit<SolidSetupResult, 'index' | 'of' | 'instructions'> {
  const face: BlockFace = side.side === 'A' ? '+z' : '-z';
  const frame = setupFrame(face, result.stock);
  const pins = result.pins.length > 0 && side.side === 'B';
  const touchR = touchDia / 2;
  const patchedGcode = notchMm
    ? `; Zero X, Y   : on the far walls of the ${notchMm.toFixed(1)} mm datum notch setup 1 cut in the near-left corner, not on the sawn faces\n` +
      side.gcode.replace(
        /^; Origin\s*:.*$/m,
        `; Origin      : X0 Y0 found from the ${notchMm.toFixed(1)} mm near-left datum notch walls; Z0 on top face`
      )
    : customDatum
      ? `; Zero X, Y   : ${customDatum.description}\n${side.gcode}`
      : side.gcode;
  return {
    ...side,
    gcode: patchedGcode,
    ...(notchMm
      ? {
          datum: {
            description:
              'X on the datum notch\'s wall facing your left, Y on its wall facing you (the notch is the cut-out in ' +
              'the near-left corner), Z on the top face.',
            touches: [
              { axis: 'x' as const, face: 'datum notch, wall facing left', valueMm: notchMm - touchR, wallMm: notchMm },
              { axis: 'y' as const, face: 'datum notch, wall facing you', valueMm: notchMm - touchR, wallMm: notchMm },
              { axis: 'z' as const, face: FACE_NAME[face], valueMm: 0 },
            ],
          },
        }
      : !pins && customDatum
        ? { datum: customDatum }
        : {}),
    upFace: face,
    rotation: frame.rotation,
    translation: frame.translation,
    stock: frame.stock,
    standingHeightMm: frame.stock.thicknessMm,
    locate: pins ? 'pins' : 'knownSpot',
    windowBounds: { minX: 0, minY: 0, maxX: result.stock.widthMm, maxY: result.stock.depthMm },
    clearedMm3: plan?.faces[face]?.clearedMm3 ?? 0,
    depthMm: side.depthMm,
    lengthOverDia: side.depthMm / Math.max(0.1, reachDia),
    allowanceMm: 0,
    side: side.side,
  };
}

/** What the operator does before a setup, in order. */
function instructionsFor(
  s: Omit<SolidSetupResult, 'index' | 'of' | 'instructions'>,
  index: number,
  prevUp?: BlockFace
): string[] {
  // describeTurn reads only the rotation, so the stock as it stands now will do.
  const turn = describeTurn(setupFrame(s.upFace, s.stock), prevUp);
  const zero = s.datum
    ? `Zero ${s.datum.description}`
    : 'Zero X and Y on the near-left corner of the top, and Z on the top face.';
  if (index === 1) {
    const corners = s.notchCorners ?? [];
    const clear = corners.length > 0 ? `clear of the ${corners.join(' and ')} corner${corners.length > 1 ? 's' : ''}, ` : '';
    return [s.upFace === '+z' ? `Clamp the block flat, ${clear}top up.` : turn, zero];
  }
  const steps = ['Park the spindle high and stop it.', turn];
  if (s.locate === 'pins') {
    steps.push('Drop the block onto the pins, and confirm it is seated.', 'Zero Z on the new top face.');
  } else {
    // A turned block's zero is found again on its own faces, never kept from the last setup.
    steps.push(zero, 'Trace the window with Frame Job before cutting.');
  }
  return steps;
}

/**
 * Solid machining with `setups` other than 1 or 2: the planner chooses the
 * way up and the faces (or is told the faces), the top and flip are cut as
 * before, and each side face gets its own setup.
 */
export function generateSetups(scene: SceneGraph, asked: SolidMachiningOptions, steps: SolidSteps): SolidMachiningResult {
  const { tris: sceneTris } = collectSceneTriangles(scene);
  if (sceneTris.length === 0) return steps.generateSides(scene, { ...asked, sides: 1 });

  /*
   * A side setup reaches the part through whatever stock is round it: the
   * channel and the frame, 15-20 mm of it, most of a small bit's reach. When
   * the block's size is the app's to choose, a side the block is stood on
   * ends flush with the part instead, as a machinist would square a blank to
   * it, and the bit goes straight in. Planned with every side flush (only the
   * reach of a side depends on it), then again with just the chosen ones.
   */
  const autoStock = !(asked.stockWidthMm > 0) && !(asked.stockDepthMm > 0);
  const SIDES: BlockFace[] = ['+x', '-x', '+y', '-y'];
  const withFlush = (faces: BlockFace[], extra?: Partial<SolidMachiningOptions>): SolidMachiningOptions =>
    autoStock ? { ...asked, ...extra, flushFaces: faces } : { ...asked, ...extra };
  type Candidate = { opts: SolidMachiningOptions; chosen: UpCandidate; exact: Placement; plan: SetupPlan; failure: string | null; cost: number };
  const only = Array.isArray(asked.setups) ? (asked.setups as BlockFace[]) : undefined;
  let best: Candidate | null = null;
  let leastFailure: Candidate | null = null;
  const searchOpts = withFlush(SIDES);
  for (const c of choose(sceneTris, searchOpts, steps)) {
    const first = planSetups(plannerInput(place(sceneTris, searchOpts, c.p.up, c.plan.order.includes('-z'), steps)!, searchOpts, only));
    const chosenSides = first.order.filter((f) => f !== '+z' && f !== '-z');
    // Never flush all 4 sides if we can keep frame + holding tabs on at least
    // one pair of opposing sides within cutter reach; otherwise the final
    // through-cut has 0 holding tabs and cuts the part completely loose.
    let o = withFlush(chosenSides);
    let ex = place(sceneTris, o, c.p.up, first.order.includes('-z'), steps)!;
    let pl = planSetups(plannerInput(ex, o, first.order));
    const countSolidMm3 = (planToMeasure: SetupPlan) => {
      let sCount = 0;
      for (let k = 0; k < planToMeasure.grid.solid.length; k++) sCount += planToMeasure.grid.solid[k];
      return sCount * planToMeasure.grid.cell ** 3;
    };
    let fail = planFailure(pl, countSolidMm3(pl));
    if (autoStock && asked.tabCount > 0 && chosenSides.length === 4 && !fail) {
      const compactFrame = Math.min(asked.frameWidthMm, Math.max(6, sideTool(asked).dia));
      let bestTabCand: { o: SolidMachiningOptions; ex: Placement; pl: SetupPlan } | null = null;
      for (const extra of [undefined, { frameWidthMm: compactFrame }] as const) {
        if (bestTabCand) break;
        for (const keepFlush of [['+y', '-y'], ['+x', '-x']] as BlockFace[][]) {
          const oTry = withFlush(keepFlush, extra);
          const exTry = place(sceneTris, oTry, c.p.up, first.order.includes('-z'), steps);
          if (!exTry) continue;
          const plTry = planSetups(plannerInput(exTry, oTry, first.order));
          if (!planFailure(plTry, countSolidMm3(plTry))) {
            if (!bestTabCand || plTry.cost < bestTabCand.pl.cost) {
              bestTabCand = { o: oTry, ex: exTry, pl: plTry };
            }
          }
        }
      }
      if (bestTabCand) {
        o = bestTabCand.o;
        ex = bestTabCand.ex;
        pl = bestTabCand.pl;
        fail = null;
      }
    }
    // The way up asked for unless another is clearly cheaper.
    const cost = pl.cost + (c.p.up === asked.up ? 0 : ORIENTATION_MARGIN);
    const cand: Candidate = { opts: o, chosen: c, exact: ex, plan: pl, failure: fail, cost };
    if (fail) {
      // Of the failures, the one asking least: the most achievable advice.
      const need = (q: Candidate) => q.plan.longerBit?.reachMm ?? Infinity;
      if (!leastFailure || need(cand) < need(leastFailure)) leastFailure = cand;
      continue;
    }
    if (!best || cand.cost < best.cost) best = cand;
  }
  const pick = best ?? leastFailure;
  if (!pick) return steps.generateSides(scene, { ...asked, sides: 1 });
  const { opts, chosen, exact, plan, failure } = pick;

  const twoSided = plan.order.includes('-z');
  // A notch for each turned setup that can have one, cut by the setup that
  // runs first, from its own face. Sized for the largest active cutter so
  // roughing can enter safely in Z layers before finishing cleans the walls.
  const first = plan.order[0];
  const notchToolDia = maxActiveToolDia(opts);
  const notchFor = new Map<BlockFace, number>();
  const notchBoxes: NotchBox[] = [];
  const notchWarnings: string[] = [];
  // The top as well as the ends, when it runs later: it is the setup that
  // cuts the part free, and it has to meet what the turned setups cut.
  for (const face of first === '-z' ? [] : plan.order.slice(1)) {
    if (face === '-z') continue;
    const n = planDatumNotch(face, first, exact, notchToolDia);
    if ('why' in n) {
      notchWarnings.push(`The ${FACE_NAME[face]} setup is zeroed on the block's sawn corner (no datum notch: ${n.why}), so it lines up only as well as the block is square.`);
      continue;
    }
    notchFor.set(face, n.sizeMm);
    if (!notchBoxes.some((m) => m.x0 === n.box.x0 && m.y0 === n.box.y0 && m.z0 === n.box.z0)) notchBoxes.push(n.box);
  }
  // When a two-sided job has flush ends or pins disabled so dowel pins cannot
  // locate `-z`, try cutting a through-thickness datum notch on setup 1 (`+z`)
  // that flips into `-z`'s near-left corner.
  const flushedSet = new Set<BlockFace>(opts.flushFaces ?? []);
  const pinsImpossible = !opts.registrationPins || flushedSet.has('-x') || flushedSet.has('+x');
  if (twoSided && first === '+z' && pinsImpossible) {
    const flipNotch = planFlipDatumNotch(exact, notchToolDia, sideTool(opts).reachZ);
    if (!('why' in flipNotch)) {
      notchFor.set('-z', flipNotch.sizeMm);
      if (!notchBoxes.some((m) => m.x0 === flipNotch.box.x0 && m.y0 === flipNotch.box.y0 && m.z0 === flipNotch.box.z0)) {
        notchBoxes.push(flipNotch.box);
      }
    }
  }

  // Predict side-setup cut envelopes so (a) holding tabs stay out of undercut
  // mouths and (b) +z/-z T2 M6 touch-off avoids pockets milled by earlier setups.
  const idxPlusZ = plan.order.indexOf('+z');
  const idxMinusZ = plan.order.indexOf('-z');
  const earlierCutsA: NotchBox[] = [...notchBoxes];
  const earlierCutsB: NotchBox[] = [...notchBoxes];
  const tabKeepOut: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (let i = 0; i < plan.order.length; i++) {
    const f = plan.order[i];
    if (f === '+z' || f === '-z') continue;
    const prev = previewSideCutInFirst(f, exact, plan, opts);
    if (!prev) continue;
    if (prev.mouthXY) tabKeepOut.push(prev.mouthXY);
    if (idxPlusZ >= 0 && i < idxPlusZ) earlierCutsA.push(prev.cutBox);
    if (idxMinusZ >= 0 && i < idxMinusZ) earlierCutsB.push(prev.cutBox);
  }

  // Guard bed levelling if the probed grid is smaller than the +z stock face
  // (e.g. probed on a narrow side-setup face before turning flat).
  const gridTooSmallForTop =
    !!opts.applyMeshLeveling &&
    !!opts.meshLevelGrid &&
    (opts.meshLevelGrid.maxX < exact.stock.widthMm - 1e-3 || opts.meshLevelGrid.maxY < exact.stock.depthMm - 1e-3);

  const notches = first === '+z' ? notchBoxes.map(asTopNotch) : [];
  const sidesOpts: SolidMachiningOptions = {
    ...opts,
    ...(gridTooSmallForTop ? { applyMeshLeveling: false, meshLevelGrid: null } : {}),
    ...(notches.length > 0 ? { datumNotches: notches } : {}),
    ...(earlierCutsA.length > 0 ? { earlierCuts: earlierCutsA } : {}),
    ...(earlierCutsB.length > 0 ? { earlierCutsB } : {}),
    ...(tabKeepOut.length > 0 ? { tabKeepOut } : {}),
    up: chosen.p.up,
    sides: twoSided ? 2 : 1,
  };
  const result = steps.generateSides(scene, sidesOpts);
  if (!result.success) return result;
  if (failure) return { ...result, success: false, error: failure, warnings: [], setups: undefined };
  const carveOpts: ReliefCarveOptions = {
    ...(sidesOpts as unknown as ReliefCarveOptions),
    verticalScaleMode: 'proportional',
    verticalExaggeration: 1,
    fitMode: 'manual',
    backgroundMode: 'carve',
    invertRelief: false,
  };

  // Include placed holding tabs in the solid geometry sideSetup protects so
  // side-pocket widening (`tool.dia + 2`) never severs +z/-z holding tabs.
  const tabTris = tabPrismTriangles(result.tabPrisms ?? []);
  const exactWithTabs: Placement = tabTris.length > 0
    ? {
        ...exact,
        tris: (() => {
          const merged = new Float64Array(exact.tris.length + tabTris.length);
          merged.set(exact.tris, 0);
          merged.set(tabTris, exact.tris.length);
          return merged;
        })(),
      }
    : exact;

  // The two-sided job's own "neither side can see" figure is the old question;
  // what the plan leaves is said in its summary instead.
  // The probed grid describes the top. A turned setup cuts another face and
  // is levelled by nothing (see asSetup), so it is said for all of them at
  // once, in place of the flip's own side-B sentence.
  const turned = plan.order.some((f) => f !== '+z' && f !== '-z');
  const levelledTopOnly = turned && !!sidesOpts.applyMeshLeveling && !!sidesOpts.meshLevelGrid;
  const warnings = [
    ...result.warnings.filter((w) => !/occluded from both \+Z and -Z|lies beneath overhangs/.test(w)),
    ...notchWarnings,
    ...(gridTooSmallForTop
      ? ['Bed levelling grid is smaller than the top-up setup footprint; all setups are cut without levelling until the top face is probed.']
      : []),
    ...(levelledTopOnly
      ? ['Bed levelling is applied to the top-up setup only. The other setups cut faces the probed grid does not describe, so they are cut without levelling.']
      : []),
  ].filter((w) => !(levelledTopOnly && /^Bed levelling is applied to side A only/.test(w)));

  const reachDia = sideTool(sidesOpts).dia;
  const firstToolDia = touchToolDia(sidesOpts);
  const minusZFallbackDatum =
    twoSided && result.pins.length === 0 && !notchFor.has('-z')
      ? flipFallbackDatum(result.stock, flushedSet, firstToolDia / 2)
      : undefined;

  const built: Omit<SolidSetupResult, 'index' | 'of' | 'instructions'>[] = [];
  for (let idx = 0; idx < plan.order.length; idx++) {
    const face = plan.order[idx];
    const prevUp = idx > 0 ? plan.order[idx - 1] : undefined;
    if (face === '+z') {
      built.push({
        ...asSetup(result.sides[0], result, plan, reachDia, firstToolDia, notchFor.get('+z')),
        ...(notches.length > 0
          ? { notchCorners: [...new Set(notches.map((n) => `${n.y0 <= 0 ? 'near' : 'far'}-${n.x0 <= 0 ? 'left' : 'right'}`))] }
          : {}),
      });
      continue;
    }
    if (face === '-z') {
      built.push(asSetup(result.sides[1], result, plan, reachDia, firstToolDia, notchFor.get('-z'), minusZFallbackDatum));
      continue;
    }
    const s = sideSetup(
      face,
      exactWithTabs,
      plan,
      sidesOpts,
      carveOpts,
      warnings,
      notchFor.get(face),
      face === first ? notchBoxes : [],
      built,
      prevUp
    );
    // A setup the plan needs and cannot have is a part that comes out wrong.
    if ('error' in s) {
      return {
        ...result, success: false, warnings: [], setups: undefined,
        error: `This part can't be cut: the setup with the ${FACE_NAME[face]} up could not be made (${s.error}).`,
      };
    }
    built.push(s);
  }
  const of = built.length;
  const setups: SolidSetupResult[] = built.map((s, i) => ({
    ...s,
    index: i + 1,
    of,
    instructions: instructionsFor(s, i + 1, i > 0 ? built[i - 1].upFace : undefined),
  }));
  const summary = summarise(plan);
  const flushed = opts.flushFaces ?? [];
  if (flushed.length > 0) {
    summary.text += ` The part runs right up to the block's ${flushed.map((f) => FACE_NAME[f]).join(' and ')}.`;
  }
  const seen = new Set<string>();
  return {
    ...result,
    warnings: warnings.filter((w) => !seen.has(w) && (seen.add(w), true)),
    setups,
    plan: summary,
    upChosen: chosen.p.up,
    // What the plan leaves, not what the top and flip alone would.
    unreachablePercent: result.partVolumeMm3 > 0 ? (100 * plan.unreachedMm3) / result.partVolumeMm3 : 0,
    estimatedTimeSeconds: setups.reduce((t, s) => t + s.estimatedTimeSeconds, 0),
    totalCutDistanceMm: setups.reduce((t, s) => t + s.totalCutDistanceMm, 0),
  };
}

/** A planned job's setups as Add Simulation takes them; undefined for a one- or two-sided job. */
export function simulationSetups(
  result: Pick<SolidMachiningResult, 'setups'>
): { gcode: string; rotation: number[]; translation: [number, number, number]; stock: SolidSetupResult['stock'] }[] | undefined {
  return result.setups?.map((s) => ({ gcode: s.gcode, rotation: s.rotation, translation: s.translation, stock: s.stock }));
}

/**
 * A one- or two-sided job's sides as setups, so a caller can treat every
 * solid job alike. The programs are the sides' own, unchanged.
 */
export function sidesAsSetups(
  result: SolidMachiningResult,
  opts: Pick<SolidMachiningOptions, 'finishingToolDiaMm'> &
    Partial<Pick<SolidMachiningOptions, 'roughingEnabled' | 'roughingToolDiaMm' | 'finishingEnabled'>>
): SolidMachiningResult {
  if (!result.success) return result;
  const reachDia = opts.finishingEnabled === false && opts.roughingToolDiaMm ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
  const firstToolDia = opts.roughingEnabled && opts.roughingToolDiaMm ? opts.roughingToolDiaMm : reachDia;
  const built = result.sides.map((side) => asSetup(side, result, null, reachDia, firstToolDia));
  const of = built.length;
  return {
    ...result,
    setups: built.map((s, i) => ({
      ...s,
      index: i + 1,
      of,
      instructions: instructionsFor(s, i + 1, i > 0 ? built[i - 1].upFace : undefined),
    })),
  };
}
