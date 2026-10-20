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
  datum?: { description: string; touches: { axis: 'x' | 'y' | 'z'; face: string; valueMm: number }[] };
  /** What the operator does before this setup runs, in order. */
  instructions: string[];
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
  stockFor: (partW: number, partD: number, partH: number, opts: SolidMachiningOptions) => { stockW: number; stockD: number; stockT: number };
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
/** How well a bit's side touches off on paper. */
const TOUCH_MM = 0.1;
/** Extra for locating on a face nothing has machined. */
const UNMACHINED_DATUM_MM = 0.3;

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
  const { stockW, stockD, stockT } = steps.stockFor(o.partW, o.partD, o.partH, sized);
  if (stockT < o.partH - 1e-6) return null;
  const topZ = twoSided ? -(stockT - o.partH) / 2 : -(stockT - o.partH);
  const tris = steps.placeInStock(o.oriented, o, stockW / 2, stockD / 2, topZ);
  const partBox: PartBox = {
    minX: stockW / 2 - o.partW / 2,
    maxX: stockW / 2 + o.partW / 2,
    minY: stockD / 2 - o.partD / 2,
    maxY: stockD / 2 + o.partD / 2,
    minZ: topZ - o.partH,
    maxZ: topZ,
  };
  return { up, twoSided, tris, partBox, stock: { widthMm: stockW, depthMm: stockD, thicknessMm: stockT } };
}

/** The cutter a side setup reaches in with, and how far it can. */
function sideTool(opts: SolidMachiningOptions): { dia: number; reach: number } {
  const dia = Math.max(0.1, opts.finishingToolDiaMm);
  const byDiameters = dia * MAX_AVAILABLE_REACH_DIAMETERS;
  // A declared stickout is the bit actually fitted: past 8 D it is a long-reach
  // bit, and the operator has said so by fitting it.
  const reach = opts.toolStickoutMm > 0 ? Math.max(byDiameters, opts.toolStickoutMm - 1) : byDiameters;
  return { dia, reach };
}

function plannerInput(p: Placement, opts: SolidMachiningOptions, only?: BlockFace[]) {
  const tool = sideTool(opts);
  return {
    tris: p.tris,
    partBox: p.partBox,
    stock: p.stock,
    toolDiaMm: tool.dia,
    reachMm: tool.reach,
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
function choose(sceneTris: ArrayLike<number>, opts: SolidMachiningOptions, steps: SolidSteps) {
  const ups = opts.setups === 'auto' && opts.autoOrient !== false ? [opts.up, ...UPS.filter((u) => u !== opts.up)] : [opts.up];
  const only = Array.isArray(opts.setups) ? (opts.setups as BlockFace[]) : undefined;
  let best: { p: Placement; plan: SetupPlan } | null = null;
  for (const up of ups) {
    // Planned on the two-sided block, whose skins are the same top and bottom;
    // the real placement is planned again once the side count is known.
    const p = place(sceneTris, opts, up, true, steps);
    if (!p) continue;
    const plan = planSetups(plannerInput(p, opts, only));
    const margin = up === opts.up ? 0 : ORIENTATION_MARGIN;
    if (!best || plan.cost + margin < best.plan.cost - 1e-9) best = { p, plan };
  }
  return best;
}

/** What to tell the operator a plan leaves, and what would change it. */
function summarise(plan: SetupPlan): SetupPlanSummary {
  const names = plan.order.map((f) => FACE_NAME[f]);
  const text =
    names.length === 1
      ? 'One setup, from the top.'
      : `${names.length} setups: ${names.join(', then ')}. The block is turned between them.`;
  // Only ever what a router always leaves: a plan that left more than that fails instead.
  const mm3 = Math.round(plan.unreachedMm3);
  const remaining = {
    mm3,
    bounds: plan.unreachedBounds,
    text: mm3 < 1 ? 'Every surface of the part is cut.' : 'Inside corners come out rounded, the size of the bit.',
  };
  const sides = plan.order.filter((f) => f !== '+z' && f !== '-z');
  const redesignHint =
    sides.length > 0
      ? `Make the faces that lean over the part upright and it needs ${plan.order.includes('-z') ? 'only the top and the flip' : 'only one setup'}.`
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
      `This part can't be cut with this bit: some of it is deeper than the bit can reach from any ` +
      `side. Use a bit that reaches at least ${plan.longerBit.reachMm} mm from its tip to the holder, ` +
      `or make the part smaller.`
    );
  }
  if (plan.dropped.some((d) => /under the spindle/.test(d.reason))) {
    return (
      `This part can't be cut on this machine: the block would have to stand on end, and it is too ` +
      `tall to fit under the spindle. Make the part smaller, or check Room Under Spindle.`
    );
  }
  return (
    `This part can't be cut on a 3-axis router: some of it can't be reached from the top, the ` +
    `bottom or any side. Change the model so every surface can be seen from one of them.`
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
  warnings: string[]
): Omit<SolidSetupResult, 'index' | 'of' | 'instructions'> | { error: string } {
  const frame = setupFrame(face, p.stock);
  const s = frame.stock;
  const tool = sideTool(opts);
  const r = tool.dia / 2;
  // Wide enough round what the face has to clear for the whole cutter to get
  // down beside it with the turn's skin on the walls (under 2 mm on any part a
  // router takes).
  const need = neededDepth(plan, face, p.stock, p.partBox, tool.dia + 2);

  // The part in this setup's frame.
  const tris = new Float64Array(p.tris.length);
  for (let i = 0; i < p.tris.length; i += 3) {
    const q = frame.toSetup([p.tris[i], p.tris[i + 1], p.tris[i + 2]]);
    tris[i] = q[0]; tris[i + 1] = q[1]; tris[i + 2] = q[2];
  }

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
   * The skin a turned setup leaves for the turn's own error: the touch-off,
   * and a quarter of a degree of tilt over the cutter's depth and over the
   * part's size. Inflated in plan by the same, so a wall is not shaved either.
   * Never below the part: each target is max(part + skin, -needed depth).
   */
  const size = Math.max(p.partBox.maxX - p.partBox.minX, p.partBox.maxY - p.partBox.minY, p.partBox.maxZ - p.partBox.minZ);
  const allowance = TOUCH_MM + deepest * Math.tan(TILT_RAD) + size * Math.tan(TILT_RAD) + UNMACHINED_DATUM_MM;
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
  const surface: Heightmap = { ...window, cols, rows, stepX, stepY, z };
  let depth = 0;
  for (let k = 0; k < z.length; k++) depth = Math.max(depth, -z[k]);

  const header = [
    `; Solid part machining — ${FACE_NAME[face].toUpperCase()} UP`,
    `; Stand the block: ${describeTurn(frame)}`,
    `; Stock as it stands: ${s.widthMm.toFixed(1)} x ${s.depthMm.toFixed(1)} x ${s.thicknessMm.toFixed(1)} mm`,
    '; Origin      : near-left corner of the block as it stands now, top face, Z0',
    `; Skin left   : ${allowance.toFixed(2)} mm on what this setup finishes, for the turn`,
  ];
  const cut = machineSurface(
    {
      surface,
      bounds: { ...window, minZ: -s.thicknessMm, maxZ: 0 },
      depthMm: depth,
      resolution: Math.min(stepX, stepY),
      header,
      noun: 'cut',
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
    datum: {
      description:
        `X on the ${FACE_NAME[left]} (now on your left), Y on the ${FACE_NAME[near]} (now towards you), ` +
        `Z on the ${FACE_NAME[face]} (now on top).`,
      touches: [
        { axis: 'x', face: FACE_NAME[left], valueMm: -r },
        { axis: 'y', face: FACE_NAME[near], valueMm: -r },
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
  dia: number
): Omit<SolidSetupResult, 'index' | 'of' | 'instructions'> {
  const face: BlockFace = side.side === 'A' ? '+z' : '-z';
  const frame = setupFrame(face, result.stock);
  const pins = result.pins.length > 0 && side.side === 'B';
  return {
    ...side,
    upFace: face,
    rotation: frame.rotation,
    translation: frame.translation,
    stock: frame.stock,
    standingHeightMm: frame.stock.thicknessMm,
    locate: pins ? 'pins' : 'knownSpot',
    windowBounds: { minX: 0, minY: 0, maxX: result.stock.widthMm, maxY: result.stock.depthMm },
    clearedMm3: plan?.faces[face]?.clearedMm3 ?? 0,
    depthMm: side.depthMm,
    lengthOverDia: side.depthMm / Math.max(0.1, dia),
    allowanceMm: 0,
    side: side.side,
  };
}

/** What the operator does before a setup, in order. */
function instructionsFor(s: Omit<SolidSetupResult, 'index' | 'of' | 'instructions'>, index: number): string[] {
  // describeTurn reads only the rotation, so the stock as it stands now will do.
  const turn = describeTurn(setupFrame(s.upFace, s.stock));
  const zero = s.datum
    ? `Zero ${s.datum.description}`
    : 'Zero X and Y on the near-left corner of the top, and Z on the top face.';
  if (index === 1) return [s.upFace === '+z' ? 'Clamp the block flat, top up.' : turn, zero];
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
   * A side setup reaches the part through the stock round it: the channel and
   * the frame, 20 mm of it by default, which is most of a small bit's reach.
   * When the block's size is the app's to choose and a side cannot reach, the
   * frame is narrowed (still enough to clamp and to hold the tabs) before the
   * part is refused.
   */
  const autoStock = !(asked.stockWidthMm > 0) && !(asked.stockDepthMm > 0);
  const frames = autoStock
    ? [asked.frameWidthMm, 8, 4].filter((f, i, all) => i === 0 || f < all[0])
    : [asked.frameWidthMm];
  let opts = asked;
  let chosen: ReturnType<typeof choose> = null;
  let exact: Placement | null = null;
  let plan: SetupPlan | null = null;
  let failure: string | null = null;
  for (const frameWidthMm of frames) {
    opts = { ...asked, frameWidthMm };
    chosen = choose(sceneTris, opts, steps);
    if (!chosen) return steps.generateSides(scene, { ...asked, sides: 1 });
    // The plan again on the exact placement the programs will be made on,
    // held to the faces chosen, so its voxels line up with the part.
    exact = place(sceneTris, opts, chosen.p.up, chosen.plan.order.includes('-z'), steps)!;
    plan = planSetups(plannerInput(exact, opts, chosen.plan.order));
    const g = plan.grid;
    let solid = 0;
    for (let i = 0; i < g.solid.length; i++) solid += g.solid[i];
    failure = planFailure(plan, solid * g.cell ** 3);
    // Only reach is helped by a narrower frame.
    if (!failure || !plan.longerBit) break;
  }
  if (!chosen || !exact || !plan) return steps.generateSides(scene, { ...asked, sides: 1 });
  const narrowed = opts.frameWidthMm < asked.frameWidthMm;

  const twoSided = plan.order.includes('-z');
  const sidesOpts: SolidMachiningOptions = { ...opts, up: chosen.p.up, sides: twoSided ? 2 : 1 };
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

  // The two-sided job's own "neither side can see" figure is the old question;
  // what the plan leaves is said in its summary instead.
  const warnings = result.warnings.filter((w) => !/material neither side can see|under a surface the one side cannot see/.test(w));
  const built: Omit<SolidSetupResult, 'index' | 'of' | 'instructions'>[] = [];
  for (const face of plan.order) {
    if (face === '+z') { built.push(asSetup(result.sides[0], result, plan, sidesOpts.finishingToolDiaMm)); continue; }
    if (face === '-z') { built.push(asSetup(result.sides[1], result, plan, sidesOpts.finishingToolDiaMm)); continue; }
    const s = sideSetup(face, exact, plan, sidesOpts, carveOpts, warnings);
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
  const setups: SolidSetupResult[] = built.map((s, i) => ({ ...s, index: i + 1, of, instructions: instructionsFor(s, i + 1) }));
  const summary = summarise(plan);
  if (narrowed) summary.text += ` The frame round the part is ${opts.frameWidthMm} mm, so the bit can reach in from the sides.`;
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
export function sidesAsSetups(result: SolidMachiningResult, opts: SolidMachiningOptions): SolidMachiningResult {
  if (!result.success) return result;
  const built = result.sides.map((side) => asSetup(side, result, null, opts.finishingToolDiaMm));
  const of = built.length;
  return {
    ...result,
    setups: built.map((s, i) => ({ ...s, index: i + 1, of, instructions: instructionsFor(s, i + 1) })),
  };
}
