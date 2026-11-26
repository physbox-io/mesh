// ---------------------------------------------------------------------------
// Timber & Joinery Breakdown — Phase 3 & 3.5: Stock Nesting, Sliding CNC
// Setups, G-Code Generation & Novice-Proof Per-Part Build Guide
// ---------------------------------------------------------------------------

import {
  endAllowanceAlongAxisMm,
  roundTenonCornerRadiusMm,
  type MemberJoineryPart,
  type MortiseSpec,
  type TimberBreakdownResult,
  type ZClipSlotSpec,
} from './timberJoinery';
import type { Vec3 } from './printPlate';
import { DEFAULT_MATERIAL, recommendSpeeds, type MaterialId, type SpindleRange } from './feedsAndSpeeds';
import { commentText } from './gcodeComments';

export interface TimberStockBarSpec {
  /** Nominal cross-section [widthMm, thicknessMm]. */
  widthMm: number;
  thicknessMm: number;
  /** Standard length of one purchased bar/board, mm (default 1800 or 2400). */
  stockLengthMm: number;
}

export interface PackedBarCut {
  partId: string;
  partTitle: string;
  finishedLengthMm: number;
  roughCutLengthMm: number;
  startMm: number;
  endMm: number;
}

export interface PackedStockBar {
  barIndex: number;
  widthMm: number;
  thicknessMm: number;
  stockLengthMm: number;
  usedLengthMm: number;
  offcutMm: number;
  wastePercent: number;
  cuts: PackedBarCut[];
}

export interface CncWindowSetup {
  id: string;
  partId: string;
  partTitle: string;
  windowIndex: number;
  totalWindowsOnFace: number;
  /** Which face of the part faces UP toward the spindle. */
  faceUpLabel: string;
  /** Which reference face is pressed tight against the CNC Y-axis alignment fence. */
  fenceFaceLabel: string;
  /** Distance from the part's Top/Start end to the CNC Y0 reference stop, mm (0 = butt top end against stop). */
  indexOffsetFromTopMm: number;
  /** Length of the part overhanging past the CNC bed that needs level support, mm. */
  overhangMm: number;
  cutterDiaMm: number;
  operationsSummary: string[];
  workholdingNotes: string[];
  /** Ready-to-run GRBL G-code for this window setup. */
  gcode: string;
  estimatedMinutes: number;
}

export type CncAttachmentStatus = 'none' | 'fits_bed' | 'sliding_pass_through' | 'exceeds_cnc';

export interface PartFabricationCard {
  partIndex: number;
  partId: string;
  partTitle: string;
  role: 'leg' | 'rail' | 'panel';
  mirrorOf?: string;
  finishedDimsMm: [number, number, number];
  shoulderToShoulderMm: number;
  roughBlankDimsMm: [number, number, number];
  stockBarRef: string;
  face1Label: string;
  face2Label: string;
  bandsawSteps: string[];
  cncAttachment: CncAttachmentStatus;
  cncFitNote?: string;
  cncSectionTitle: string;
  cncSetups: CncWindowSetup[];
  taperAndProfileSteps: string[];
  fitCheckSteps: string[];
  markdown: string;
}

export interface TimberCutPlan {
  cncBedMm: [number, number, number];
  stockBars: PackedStockBar[];
  hardwareBom: { item: string; quantity: number; note: string }[];
  allCncSetups: CncWindowSetup[];
  partCards: PartFabricationCard[];
  birdsEyeMapMarkdown: string;
  glueUpGuideMarkdown: string;
  /** Complete, self-contained shop manual ready to display or hand to the user. */
  buildGuideMarkdown: string;
}

export interface CutPlanOptions {
  /** CNC work envelope [widthMm, depthMm, heightMm]. Default [300, 300, 60]. */
  cncBedMm?: [number, number, number];
  /** Default stock bar length to buy, mm. Default 1800 mm (6 ft). */
  defaultStockLengthMm?: number;
  /** Bandsaw kerf width, mm. Default 2 mm. */
  sawKerfMm?: number;
  /** Extra rough-crosscut allowance per part for squaring ends, mm. Default 10 mm. */
  roughAllowanceMm?: number;
  /**
   * Spindle RPM for CNC G-code. Derived from the cutter, material and machine
   * when any of `material`, `spindle` or `maxFeedMmMin` is given; 12000
   * otherwise.
   */
  spindleRpm?: number;
  /** XY feedrate in timber, mm/min. Derived as above; 900 otherwise. */
  feedRateMmMin?: number;
  /** Z plunge rate in timber, mm/min. Derived as above; 250 otherwise. */
  plungeRateMmMin?: number;
  /** Max Z stepdown per pass, mm. Derived as above; 2.5 mm otherwise. */
  stepdownMm?: number;
  /** What the timber is, for deriving feeds and speeds. */
  material?: MaterialId;
  /** Flutes on the mortising cutter. Default 2. */
  cutterFlutes?: number;
  /** The controller's spindle range (`$30`/`$31`, or the operator's override). */
  spindle?: SpindleRange | null;
  /** Fastest the gantry tracks while cutting, mm/min — the lower of `$110`/`$111`. */
  maxFeedMmMin?: number;
}

/**
 * Feeds, speeds and stepdown for mortising, worked out from the cutter, the
 * timber and the machine when the caller says what they are.
 *
 * The plan used to cut every mortise at S12000 F900, plunge 250, 2.5 mm a
 * pass, whatever was in the collet: a 3 mm bit in oak at 2.5 mm a pass and
 * full slot width is close to a broken bit, while a 10 mm one barely makes a
 * chip at that feed — and on a `$30=10000` spindle the S12000 was clamped, so
 * every feed ran at 1.2 times the chip load. With nothing said about the
 * machine the old figures stand, so a caller that passes none of this gets
 * the program it always did.
 */
export function mortisingFeeds(cutterDiaMm: number, o: CutPlanOptions) {
  const derive = o.material !== undefined || o.spindle !== undefined || o.maxFeedMmMin !== undefined;
  if (!derive) {
    return {
      spindleRpm: o.spindleRpm ?? 12000,
      feedRate: o.feedRateMmMin ?? 900,
      plungeRate: o.plungeRateMmMin ?? 250,
      stepdownMm: o.stepdownMm ?? 2.5,
    };
  }
  const material = o.material ?? DEFAULT_MATERIAL;
  const dia = Math.max(0.5, cutterDiaMm);
  const rec = recommendSpeeds({
    diameterMm: dia,
    flutes: o.cutterFlutes ?? 2,
    material,
    spindle: o.spindle,
    maxFeedMmMin: o.maxFeedMmMin,
  });
  // A mortise is a slot, so the bite is a fraction of the cutter: the same
  // fractions the relief roughing pass uses at full engagement.
  const fraction = material === 'aluminium' ? 0.1 : material === 'foam' || material === 'softwood' ? 0.4 : 0.3;
  return {
    spindleRpm: o.spindleRpm ?? rec.rpm,
    feedRate: o.feedRateMmMin ?? rec.feedMmMin,
    plungeRate: o.plungeRateMmMin ?? rec.plungeMmMin,
    stepdownMm: o.stepdownMm ?? Math.round(Math.max(0.2, dia * fraction) * 100) / 100,
  };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Physical shoulder bounds `[sLo, sHi]` and finished `+axes[0]` top-end tip
 * coordinate (`topTipCoord`) of a part along `part.member.axes[0]`.
 * Shared across CNC setup planning, Z-clip placement, and `timberSimulation.ts`
 * so the Y0 stop datum is identical everywhere.
 */
export function partShoulderBoundsAlongAxis(part: MemberJoineryPart): {
  sLo: number;
  sHi: number;
  topTipCoord: number;
} {
  const m = part.member;
  const a0 = m.axes[0];
  const tStart = part.tenons.find((t) => t.railEnd === 'start');
  const tEnd = part.tenons.find((t) => t.railEnd === 'end');
  let sLo: number;
  let sHi: number;
  if (tStart && tEnd) {
    sLo = dot(tStart.shoulderCenterMm, a0);
    sHi = dot(tEnd.shoulderCenterMm, a0);
  } else if (tEnd) {
    sHi = dot(tEnd.shoulderCenterMm, a0);
    sLo = sHi - part.shoulderToShoulderMm;
  } else if (tStart) {
    sLo = dot(tStart.shoulderCenterMm, a0);
    sHi = sLo + part.shoulderToShoulderMm;
  } else {
    const mid = dot(m.centerMm, a0);
    sLo = mid - part.shoulderToShoulderMm * 0.5;
    sHi = mid + part.shoulderToShoulderMm * 0.5;
  }
  return {
    sLo,
    sHi,
    topTipCoord: sHi + endAllowanceAlongAxisMm(m, tEnd),
  };
}

function fmt(n: number, d = 3): string {
  return (+n.toFixed(d)).toString();
}

/**
 * Generate GRBL G-code for a single CNC window setup containing rectangular
 * mortises (with optional 4-corner dogbones and glue-relief pocket) and/or
 * Z-clip slots.
 *
 * Coordinate convention (matching `solidMachiningExporter.ts` and the machine panel):
 *   - X0, Y0 is the Top-Left corner of the active window on the workpiece
 *     (X runs across the face width `0..faceWidthMm`; Y runs down the length
 *     of the window `0..windowLengthMm`).
 *   - Z0 is probed on the top surface of the workpiece; cuts go negative Z.
 */
export function generateWindowGcode(params: {
  setupId: string;
  partId: string;
  faceUpLabel: string;
  fenceFaceLabel: string;
  indexOffsetFromTopMm: number;
  cutterDiaMm: number;
  spindleRpm: number;
  feedRate: number;
  plungeRate: number;
  stepdownMm: number;
  mortises: {
    id: string;
    centerXMm: number;
    centerYMm: number;
    /** Mortise span along `uDirXY` (defaults to CNC +Y when `uDirXY` is `[0, 1]`), mm. */
    widthYMm: number;
    /** Mortise span along `vDirXY = [uDirXY[1], -uDirXY[0]]` (defaults to CNC +X), mm. */
    thicknessXMm: number;
    depthMm: number;
    dogbone: boolean;
    /** Unit 2D direction `[ux, uy]` of the mortise's `uAxis` on the CNC `(X, Y)` bed. Default `[0, 1]`. */
    uDirXY?: [number, number];
  }[];
  zClips: {
    id: string;
    centerXMm: number;
    centerYMm: number;
    lengthYMm: number;
    widthXMm: number;
    depthMm: number;
  }[];
}): { gcode: string; estimatedMinutes: number } {
  const {
    setupId,
    partId,
    faceUpLabel,
    fenceFaceLabel,
    indexOffsetFromTopMm,
    cutterDiaMm,
    spindleRpm,
    feedRate,
    plungeRate,
    stepdownMm,
    mortises,
    zClips,
  } = params;

  const safeZ = 6.0;
  const rBit = cutterDiaMm * 0.5;
  const stepover = Math.max(1.0, cutterDiaMm * 0.42);
  const ringStep = stepover * Math.SQRT1_2;
  const lines: string[] = [
    `; Setup: ${commentText(setupId)} — Part ${commentText(partId)}`,
    `; Face UP: ${commentText(faceUpLabel)}`,
    `; Against Y-Axis Fence: ${commentText(fenceFaceLabel)}`,
    `; Index Stop Offset from Top End: ${indexOffsetFromTopMm} mm`,
    `; Tool: ${cutterDiaMm} mm Flat End Mill`,
    `G21 G90 G17`,
    `G0 Z${fmt(safeZ)}`,
    `M3 S${Math.round(spindleRpm)}`,
    // Up to speed before the first plunge. GRBL's M3 returns at once, so the
    // ramp into the first mortise met a spindle still spinning up.
    `G4 P2`,
  ];

  let cuttingDistMm = 0;

  for (const m of mortises) {
    const [rawUx, rawUy] = m.uDirXY ?? [0, 1];
    const uNorm = Math.hypot(rawUx, rawUy) || 1;
    const ux = rawUx / uNorm;
    const uy = rawUy / uNorm;
    const vx = uy;
    const vy = -ux;
    const toXY = (sv: number, su: number): [number, number] => [
      m.centerXMm + sv * vx + su * ux,
      m.centerYMm + sv * vy + su * uy,
    ];

    lines.push(`; Mortise ${commentText(m.id)}: ${m.thicknessXMm} × ${m.widthYMm} × ${m.depthMm} mm`);
    const halfV = Math.max(0, m.thicknessXMm * 0.5 - rBit);
    const halfU = Math.max(0, m.widthYMm * 0.5 - rBit);
    const passes = Math.max(1, Math.ceil(m.depthMm / stepdownMm));

    // Rapid over center of mortise
    lines.push(`G0 X${fmt(m.centerXMm)} Y${fmt(m.centerYMm)}`);

    for (let p = 1; p <= passes; p++) {
      const z = -Math.min(m.depthMm, p * stepdownMm);
      // Ramp plunge along the longer pocket axis, then clear via medial-axis constant-offset rings
      if (halfU >= halfV) {
        const rampHalfU = Math.min(halfU, Math.max(1.5, rBit));
        const [rx0, ry0] = toXY(0, -rampHalfU);
        const [rx1, ry1] = toXY(0, rampHalfU);
        lines.push(`G1 X${fmt(rx0)} Y${fmt(ry0)} Z${fmt(z)} F${Math.round(plungeRate)}`);
        lines.push(`G1 X${fmt(rx1)} Y${fmt(ry1)} F${Math.round(feedRate)}`);
        cuttingDistMm += rampHalfU * 4;

        const spineU = Math.max(0, halfU - halfV);
        if (spineU > rampHalfU + 1e-3) {
          const [sx0, sy0] = toXY(0, -spineU);
          const [sx1, sy1] = toXY(0, spineU);
          lines.push(`G1 X${fmt(sx0)} Y${fmt(sy0)} F${Math.round(feedRate)}`);
          lines.push(`G1 X${fmt(sx1)} Y${fmt(sy1)}`);
          cuttingDistMm += spineU * 3;
        }

        const rings = Math.max(1, Math.ceil(halfV / ringStep));
        for (let r = 1; r <= rings; r++) {
          const frac = r / rings;
          const rv = halfV * frac;
          const ru = spineU + rv;
          const [x0, y0] = toXY(-rv, -ru);
          const [x1, y1] = toXY(rv, -ru);
          const [x2, y2] = toXY(rv, ru);
          const [x3, y3] = toXY(-rv, ru);
          lines.push(`G1 X${fmt(x0)} Y${fmt(y0)} F${Math.round(feedRate)}`);
          lines.push(`G1 X${fmt(x1)} Y${fmt(y1)}`);
          lines.push(`G1 X${fmt(x2)} Y${fmt(y2)}`);
          lines.push(`G1 X${fmt(x3)} Y${fmt(y3)}`);
          lines.push(`G1 X${fmt(x0)} Y${fmt(y0)}`);
          cuttingDistMm += 4 * (rv + ru);
        }
      } else {
        const rampHalfV = Math.min(halfV, Math.max(1.5, rBit));
        const [rx0, ry0] = toXY(-rampHalfV, 0);
        const [rx1, ry1] = toXY(rampHalfV, 0);
        lines.push(`G1 X${fmt(rx0)} Y${fmt(ry0)} Z${fmt(z)} F${Math.round(plungeRate)}`);
        lines.push(`G1 X${fmt(rx1)} Y${fmt(ry1)} F${Math.round(feedRate)}`);
        cuttingDistMm += rampHalfV * 4;

        const spineV = Math.max(0, halfV - halfU);
        if (spineV > rampHalfV + 1e-3) {
          const [sx0, sy0] = toXY(-spineV, 0);
          const [sx1, sy1] = toXY(spineV, 0);
          lines.push(`G1 X${fmt(sx0)} Y${fmt(sy0)} F${Math.round(feedRate)}`);
          lines.push(`G1 X${fmt(sx1)} Y${fmt(sy1)}`);
          cuttingDistMm += spineV * 3;
        }

        const rings = Math.max(1, Math.ceil(halfU / ringStep));
        for (let r = 1; r <= rings; r++) {
          const frac = r / rings;
          const ru = halfU * frac;
          const rv = spineV + ru;
          const [x0, y0] = toXY(-rv, -ru);
          const [x1, y1] = toXY(rv, -ru);
          const [x2, y2] = toXY(rv, ru);
          const [x3, y3] = toXY(-rv, ru);
          lines.push(`G1 X${fmt(x0)} Y${fmt(y0)} F${Math.round(feedRate)}`);
          lines.push(`G1 X${fmt(x1)} Y${fmt(y1)}`);
          lines.push(`G1 X${fmt(x2)} Y${fmt(y2)}`);
          lines.push(`G1 X${fmt(x3)} Y${fmt(y3)}`);
          lines.push(`G1 X${fmt(x0)} Y${fmt(y0)}`);
          cuttingDistMm += 4 * (rv + ru);
        }
      }

      // 4 Dogbone corner relief overcuts so a square bandsawn tenon drops right in
      if (m.dogbone && m.thicknessXMm >= cutterDiaMm && m.widthYMm >= cutterDiaMm) {
        const inset = rBit * Math.SQRT1_2;
        const dv = Math.max(0, m.thicknessXMm * 0.5 - inset);
        const du = Math.max(0, m.widthYMm * 0.5 - inset);
        for (const [sv, su] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          const [cx0, cy0] = toXY(sv * halfV, su * halfU);
          const [dx0, dy0] = toXY(sv * dv, su * du);
          lines.push(`G1 X${fmt(cx0)} Y${fmt(cy0)} F${Math.round(feedRate)}`);
          lines.push(`G1 X${fmt(dx0)} Y${fmt(dy0)} F${Math.round(feedRate * 0.75)}`);
          lines.push(`G1 X${fmt(cx0)} Y${fmt(cy0)}`);
          cuttingDistMm += rBit * 2;
        }
      }
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
  }

  for (const zc of zClips) {
    lines.push(`; Tabletop Z-Clip Expansion Slot ${commentText(zc.id)}: ${zc.lengthYMm} × ${zc.widthXMm} × ${zc.depthMm} mm`);
    const halfX = Math.max(0, zc.widthXMm * 0.5 - rBit);
    const halfY = Math.max(0.5, zc.lengthYMm * 0.5 - rBit);
    const rampHalfY = Math.min(halfY, Math.max(2.0, rBit));
    const passes = Math.max(1, Math.ceil(zc.depthMm / stepdownMm));
    lines.push(`G0 X${fmt(zc.centerXMm - halfX)} Y${fmt(zc.centerYMm - rampHalfY)}`);
    for (let p = 1; p <= passes; p++) {
      const z = -Math.min(zc.depthMm, p * stepdownMm);
      // Linear ramp plunge along slot length (no vertical plunge into solid wood)
      lines.push(`G1 X${fmt(zc.centerXMm - halfX)} Y${fmt(zc.centerYMm + rampHalfY)} Z${fmt(z)} F${Math.round(plungeRate)}`);
      lines.push(`G1 X${fmt(zc.centerXMm - halfX)} Y${fmt(zc.centerYMm - halfY)} F${Math.round(feedRate)}`);
      if (halfX > 1e-3) {
        lines.push(`G1 X${fmt(zc.centerXMm + halfX)} Y${fmt(zc.centerYMm - halfY)}`);
        lines.push(`G1 X${fmt(zc.centerXMm + halfX)} Y${fmt(zc.centerYMm + halfY)}`);
        lines.push(`G1 X${fmt(zc.centerXMm - halfX)} Y${fmt(zc.centerYMm + halfY)}`);
        lines.push(`G1 X${fmt(zc.centerXMm - halfX)} Y${fmt(zc.centerYMm - halfY)}`);
        cuttingDistMm += (halfX + halfY) * 4 + rampHalfY * 2;
      } else {
        lines.push(`G1 X${fmt(zc.centerXMm)} Y${fmt(zc.centerYMm + halfY)}`);
        lines.push(`G1 X${fmt(zc.centerXMm)} Y${fmt(zc.centerYMm - halfY)}`);
        cuttingDistMm += halfY * 4 + rampHalfY * 2;
      }
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
  }

  lines.push(`M5`);
  lines.push(`G0 X0 Y0`);
  lines.push(`M30`);

  const estMin = Math.max(0.5, +(cuttingDistMm / Math.max(200, feedRate) + (mortises.length + zClips.length) * 0.35).toFixed(1));
  return { gcode: lines.join('\n'), estimatedMinutes: estMin };
}

/**
 * Pack 1D timber parts onto standard stock bars using Best-Fit Decreasing (BFD).
 */
function packStockBars(
  parts: MemberJoineryPart[],
  defaultStockLengthMm: number,
  sawKerfMm: number,
  roughAllowanceMm: number,
): { bars: PackedStockBar[]; partBarMap: Map<string, string> } {
  const groups = new Map<string, { widthMm: number; thicknessMm: number; items: { part: MemberJoineryPart; roughLen: number }[] }>();

  for (const p of parts) {
    const w = Math.ceil(p.crossSectionMm[0]);
    const t = Math.ceil(p.crossSectionMm[1]);
    const [hi, lo] = w >= t ? [w, t] : [t, w];
    const key = `${hi}x${lo}`;
    const roughLen = Math.ceil(p.totalFinishedLengthMm + roughAllowanceMm);
    const g = groups.get(key);
    if (g) g.items.push({ part: p, roughLen });
    else groups.set(key, { widthMm: hi, thicknessMm: lo, items: [{ part: p, roughLen }] });
  }

  const bars: PackedStockBar[] = [];
  const partBarMap = new Map<string, string>();
  let globalBarIdx = 1;

  for (const [, group] of groups) {
    // Sort longest parts first (Best-Fit Decreasing)
    const sorted = [...group.items].sort((a, b) => b.roughLen - a.roughLen);
    const longestPart = sorted[0]?.roughLen ?? 0;
    const stockLengthMm = Math.max(defaultStockLengthMm, Math.ceil((longestPart + 50) / 300) * 300);

    const groupBars: PackedStockBar[] = [];
    for (const item of sorted) {
      let bestBar: PackedStockBar | null = null;
      let bestRemaining = Infinity;
      for (const b of groupBars) {
        const needed = (b.cuts.length > 0 ? sawKerfMm : 0) + item.roughLen;
        const rem = b.stockLengthMm - b.usedLengthMm;
        if (rem >= needed && rem - needed < bestRemaining) {
          bestRemaining = rem - needed;
          bestBar = b;
        }
      }
      if (!bestBar) {
        bestBar = {
          barIndex: globalBarIdx++,
          widthMm: group.widthMm,
          thicknessMm: group.thicknessMm,
          stockLengthMm,
          usedLengthMm: 0,
          offcutMm: stockLengthMm,
          wastePercent: 100,
          cuts: [],
        };
        groupBars.push(bestBar);
      }

      const startMm = bestBar.usedLengthMm + (bestBar.cuts.length > 0 ? sawKerfMm : 0);
      const endMm = startMm + item.roughLen;
      bestBar.cuts.push({
        partId: item.part.member.id,
        partTitle: item.part.member.title,
        finishedLengthMm: item.part.totalFinishedLengthMm,
        roughCutLengthMm: item.roughLen,
        startMm,
        endMm,
      });
      bestBar.usedLengthMm = endMm;
      bestBar.offcutMm = Math.max(0, bestBar.stockLengthMm - endMm);
      bestBar.wastePercent = +(((bestBar.stockLengthMm - bestBar.cuts.reduce((s, c) => s + c.roughCutLengthMm, 0)) / bestBar.stockLengthMm) * 100).toFixed(1);
      partBarMap.set(
        item.part.member.id,
        `Bar #${bestBar.barIndex} (${group.thicknessMm}×${group.widthMm}×${stockLengthMm} mm)`,
      );
    }
    bars.push(...groupBars);
  }

  return { bars, partBarMap };
}

/**
 * Map a face normal on a member to its numbered side face (F1..F4):
 *   F1 = +face1.normal, F2 = +face2.normal, F3 = -face1.normal, F4 = -face2.normal.
 */
export function memberFaceNumber(
  member: { face1: { normal: Vec3 }; face2: { normal: Vec3 } },
  normal: Vec3,
): 1 | 2 | 3 | 4 {
  const d1 = dot(normal, member.face1.normal);
  const d2 = dot(normal, member.face2.normal);
  if (Math.abs(d1) >= Math.abs(d2)) {
    return d1 >= 0 ? 1 : 3;
  }
  return d2 >= 0 ? 2 : 4;
}

/**
 * Group a part's mortises and Z-clip slots by which face points UP toward the
 * CNC spindle, and partition long legs (e.g. 915 mm flower stand legs) into
 * sliding CNC windows that fit inside `cncBedMm`.
 */
function buildCncSetupsForPart(
  part: MemberJoineryPart,
  cncBedMm: [number, number, number],
  cutterDiaMm: number,
  spindleRpm: number,
  feedRate: number,
  plungeRate: number,
  stepdownMm: number,
): {
  setups: CncWindowSetup[];
  cncAttachment: CncAttachmentStatus;
  cncFitNote?: string;
} {
  const hasCncFeatures = part.mortises.length > 0 || part.zClipSlots.length > 0;
  if (!hasCncFeatures) {
    return { setups: [], cncAttachment: 'none' };
  }

  const setups: CncWindowSetup[] = [];
  // The auxiliary fence runs along the Y-axis (front-to-back pass-through axis on a desktop CNC
  // so long legs clear the left/right gantry uprights), so window length is bounded by cncBedMm[1].
  const maxWindowLenMm = Math.max(120, cncBedMm[1] - 30);
  const partLenMm = part.totalFinishedLengthMm;

  // Group mortises by their outward face normal
  const faceGroups = new Map<string, { faceNormal: Vec3; mortises: MortiseSpec[]; zClips: ZClipSlotSpec[] }>();
  const keyOf = (n: Vec3) => `${Math.round(n[0] * 10)},${Math.round(n[1] * 10)},${Math.round(n[2] * 10)}`;

  for (const m of part.mortises) {
    const k = keyOf(m.faceNormal);
    const g = faceGroups.get(k);
    if (g) g.mortises.push(m);
    else faceGroups.set(k, { faceNormal: m.faceNormal, mortises: [m], zClips: [] });
  }
  for (const zc of part.zClipSlots) {
    const faceNormal: Vec3 = [-zc.inwardNormal[0], -zc.inwardNormal[1], -zc.inwardNormal[2]];
    const k = keyOf(faceNormal);
    const g = faceGroups.get(k);
    if (g) g.zClips.push(zc);
    else faceGroups.set(k, { faceNormal, mortises: [], zClips: [zc] });
  }

  // Check whether this part can physically be attached to the CNC bed:
  // While lumber of any length can be cut on a saw, attaching a part to the CNC requires its
  // cross-section on the bed (width across X and height under Z gantry) to fit within cncBedMm[0] and cncBedMm[2].
  let maxAcrossWidthMm = 0;
  let maxUpHeightMm = 0;
  for (const [, group] of faceGroups) {
    const upAlongWidthAxis = Math.abs(dot(group.faceNormal, part.member.axes[1])) >= 0.7;
    const acrossWidthMm = upAlongWidthAxis ? part.crossSectionMm[1] : part.crossSectionMm[0];
    const upHeightMm = upAlongWidthAxis ? part.crossSectionMm[0] : part.crossSectionMm[1];
    if (acrossWidthMm > maxAcrossWidthMm) maxAcrossWidthMm = acrossWidthMm;
    if (upHeightMm > maxUpHeightMm) maxUpHeightMm = upHeightMm;
  }

  if (maxAcrossWidthMm > cncBedMm[0] || maxUpHeightMm > cncBedMm[2]) {
    const reasons: string[] = [];
    if (maxAcrossWidthMm > cncBedMm[0]) {
      reasons.push(`width ${maxAcrossWidthMm} mm exceeds CNC X width ${cncBedMm[0]} mm`);
    }
    if (maxUpHeightMm > cncBedMm[2]) {
      reasons.push(`height ${maxUpHeightMm} mm exceeds CNC Z clearance ${cncBedMm[2]} mm`);
    }
    return {
      setups: [],
      cncAttachment: 'exceeds_cnc',
      cncFitNote: `Cannot attach to CNC (${reasons.join('; ')}). Cut these pockets with a hand router or drill press.`,
    };
  }

  // Flag CNC incompatible if the selected end mill is wider than any mortise/dado pocket.
  const narrowMortise = part.mortises.find(
    (m) => cutterDiaMm > m.thicknessMm + 1e-6 || cutterDiaMm > m.widthMm + 1e-6,
  );
  if (narrowMortise) {
    const minPocketMm = Math.min(narrowMortise.thicknessMm, narrowMortise.widthMm);
    return {
      setups: [],
      cncAttachment: 'exceeds_cnc',
      cncFitNote: `CNC bit Ø${cutterDiaMm} mm is wider than pocket ${narrowMortise.id} (${minPocketMm} mm). Use a smaller bit or cut by hand.`,
    };
  }

  const { topTipCoord } = partShoulderBoundsAlongAxis(part);

  for (const [, group] of faceGroups) {
    // Determine which numbered face sits UP and which adjacent face sits against the Y-axis fence.
    // With that face up and the top end against the Y0 stop, the part can only
    // lie one way, so the face at X0 is fixed: machine Y runs down the part
    // from its top end and Z out of the face, so X is Y x Z. Naming a reference
    // face instead put the other side against the fence on half the setups,
    // and an off-centre mortise came out mirrored across the face.
    const faceUpNum = memberFaceNumber(part.member, group.faceNormal);
    const a0 = part.member.axes[0];
    const yDir: Vec3 = [-a0[0], -a0[1], -a0[2]];
    const zDir = group.faceNormal;
    const xDir: Vec3 = [
      yDir[1] * zDir[2] - yDir[2] * zDir[1],
      yDir[2] * zDir[0] - yDir[0] * zDir[2],
      yDir[0] * zDir[1] - yDir[1] * zDir[0],
    ];
    const fenceFaceNum = memberFaceNumber(part.member, [-xDir[0], -xDir[1], -xDir[2]]);
    const fenceFaceLabel = `Face F${fenceFaceNum}`;
    const faceUpLabel = `Face F${faceUpNum}`;
    // Across the face from the fence, mm.
    const acrossMm = part.member.axes.reduce((sum, a, i) => sum + Math.abs(dot(a, xDir)) * part.member.dimsMm[i], 0);
    const fromFence = (p: Vec3) => {
      const x = dot([p[0] - part.member.centerMm[0], p[1] - part.member.centerMm[1], p[2] - part.member.centerMm[2]], xDir) + acrossMm / 2;
      return +x.toFixed(3);
    };

    // Project each mortise's local (uAxis, vAxis) onto the CNC setup's actual (xDir, yDir) bed axes
    // so T-junctions (90°), bookcase dadoes, and compound-splayed legs (arbitrary angle θ) mill aligned!
    const projectMortise = (m: MortiseSpec) => {
      let ux = dot(m.uAxis, xDir);
      let uy = dot(m.uAxis, yDir);
      const len = Math.hypot(ux, uy) || 1;
      ux /= len;
      uy /= len;
      if (uy < -1e-4 || (Math.abs(uy) <= 1e-4 && ux < 0)) {
        ux = -ux;
        uy = -uy;
      }
      if (Math.abs(ux) <= 1e-4) {
        ux = 0;
        uy = 1;
      } else if (Math.abs(uy) <= 1e-4) {
        ux = 1;
        uy = 0;
      }
      const vy = -ux;
      const halfSpanY = 0.5 * (Math.abs(uy) * m.widthMm + Math.abs(vy) * m.thicknessMm);
      const distY = +(topTipCoord - dot(m.centerMm, a0)).toFixed(3);
      return { uDirXY: [ux, uy] as [number, number], halfSpanY, distY };
    };

    const sortedMortises = [...group.mortises]
      .map((m) => ({ m, proj: projectMortise(m) }))
      .sort((a, b) => a.proj.distY - b.proj.distY);

    // A single mortise or dado longer along Y than the CNC bed cannot be cut in one window.
    const oversizedY = sortedMortises.find((item) => 2 * item.proj.halfSpanY > cncBedMm[1]);
    if (oversizedY) {
      const spanYMm = +(2 * oversizedY.proj.halfSpanY).toFixed(1);
      return {
        setups: [],
        cncAttachment: 'exceeds_cnc',
        cncFitNote: `Pocket ${oversizedY.m.id} Y-span (${spanYMm} mm) exceeds CNC Y travel (${cncBedMm[1]} mm). Cut this pocket with a hand router or table saw.`,
      };
    }

    // Partition mortises along the member's length into windows of span <= maxWindowLenMm
    const windows: {
      startOffsetMm: number;
      mortises: { m: MortiseSpec; proj: ReturnType<typeof projectMortise> }[];
      zClips: { zc: ZClipSlotSpec; distY: number }[];
    }[] = [];

    for (const item of sortedMortises) {
      const mTop = Math.max(0, item.proj.distY - item.proj.halfSpanY - 15);
      const mBot = item.proj.distY + item.proj.halfSpanY + 15;
      const last = windows[windows.length - 1];
      if (!last) {
        const startOffset = mBot <= maxWindowLenMm ? 0 : Math.floor(mTop / 10) * 10;
        windows.push({ startOffsetMm: startOffset, mortises: [item], zClips: [] });
      } else if (mBot - last.startOffsetMm <= maxWindowLenMm) {
        last.mortises.push(item);
      } else {
        const startOffset = Math.floor(mTop / 10) * 10;
        windows.push({ startOffsetMm: startOffset, mortises: [item], zClips: [] });
      }
    }

    if (group.zClips.length) {
      const zClipItems = group.zClips.map((zc) => ({
        zc,
        distY: +(topTipCoord - dot(zc.centerMm, a0)).toFixed(3),
      }));
      for (const zItem of zClipItems) {
        const zcTop = Math.max(0, zItem.distY - zItem.zc.slotLengthMm * 0.5 - 15);
        const zcBot = zItem.distY + zItem.zc.slotLengthMm * 0.5 + 15;
        const zcOffset = zcBot <= maxWindowLenMm ? 0 : Math.floor(zcTop / 10) * 10;
        const hostWin = windows.find(
          (w) => zcTop >= w.startOffsetMm && zcBot - w.startOffsetMm <= maxWindowLenMm,
        );
        if (hostWin) {
          hostWin.zClips.push(zItem);
        } else {
          windows.push({ startOffsetMm: zcOffset, mortises: [], zClips: [zItem] });
        }
      }
    }

    windows.forEach((win, wIdx) => {
      const winNum = wIdx + 1;
      const setupId = `${part.member.id}_F${faceUpNum}_W${winNum}`;
      const overhangMm = Math.max(0, Math.round(partLenMm - maxWindowLenMm));

      const opsSummary: string[] = [];
      for (const { m } of win.mortises) {
        const cornerNote = m.dogboneDiaMm
          ? `, Ø${m.dogboneDiaMm} mm dogbone`
          : m.cornerFit === 'chisel_square'
            ? `, chisel corners square after CNC`
            : m.cornerFit === 'round_tenon'
              ? `, R${+roundTenonCornerRadiusMm(m.widthMm, m.thicknessMm, cutterDiaMm).toFixed(2)} mm rounded corners`
              : '';
        opsSummary.push(
          `Mortise for ${m.matingMemberId}: ${m.thicknessMm} × ${m.widthMm} × ${m.depthMm} mm (${m.distFromTopEndMm} mm from top end${cornerNote})`,
        );
      }
      for (const { zc } of win.zClips) {
        opsSummary.push(
          `Tabletop Z-Clip slot: ${zc.slotLengthMm} × ${zc.slotWidthMm} × ${zc.slotDepthMm} mm (${zc.distFromTopEdgeMm} mm from top edge)`,
        );
      }

      const workholdingNotes: string[] = [
        `${faceUpLabel} UP · ${fenceFaceLabel} against Y fence.`,
        win.startOffsetMm === 0
          ? `Butt Top End against Y0 stop.`
          : `Slide Top End ${win.startOffsetMm} mm past Y0 stop${overhangMm > 120 ? ` (support ${overhangMm} mm overhang)` : ''}.`,
      ];

      const gcodeResult = generateWindowGcode({
        setupId,
        partId: part.member.id,
        faceUpLabel,
        fenceFaceLabel,
        indexOffsetFromTopMm: win.startOffsetMm,
        cutterDiaMm,
        spindleRpm,
        feedRate,
        plungeRate,
        stepdownMm,
        mortises: win.mortises.map(({ m, proj }) => ({
          id: m.id,
          centerXMm: fromFence(m.centerMm),
          centerYMm: +(proj.distY - win.startOffsetMm).toFixed(3),
          widthYMm: m.widthMm,
          thicknessXMm: m.thicknessMm,
          depthMm: m.depthMm,
          dogbone: m.cornerFit === 'dogbone',
          uDirXY: proj.uDirXY,
        })),
        zClips: win.zClips.map(({ zc, distY }) => ({
          id: zc.id,
          centerXMm: fromFence(zc.centerMm),
          centerYMm: +(distY - win.startOffsetMm).toFixed(3),
          lengthYMm: zc.slotLengthMm,
          widthXMm: zc.slotWidthMm,
          depthMm: zc.slotDepthMm,
        })),
      });

      setups.push({
        id: setupId,
        partId: part.member.id,
        partTitle: part.member.title,
        windowIndex: winNum,
        totalWindowsOnFace: windows.length,
        faceUpLabel,
        fenceFaceLabel,
        indexOffsetFromTopMm: win.startOffsetMm,
        overhangMm,
        cutterDiaMm,
        operationsSummary: opsSummary,
        workholdingNotes,
        gcode: gcodeResult.gcode,
        estimatedMinutes: gcodeResult.estimatedMinutes,
      });
    });
  }

  const needsPassThrough = partLenMm > cncBedMm[1] || setups.some((s) => s.indexOffsetFromTopMm > 0);
  const cncAttachment: CncAttachmentStatus = needsPassThrough ? 'sliding_pass_through' : 'fits_bed';
  const cncFitNote = needsPassThrough
    ? `Cut part to ${partLenMm} × ${part.crossSectionMm[0]} × ${part.crossSectionMm[1]} mm first. ${maxAcrossWidthMm} × ${maxUpHeightMm} mm profile fits CNC (${cncBedMm[0]} × ${cncBedMm[2]} mm); ${partLenMm} mm length slides along the ${cncBedMm[1]} mm bed.`
    : `Cut part to ${partLenMm} × ${part.crossSectionMm[0]} × ${part.crossSectionMm[1]} mm first; clamps flat inside the ${cncBedMm[0]} × ${cncBedMm[1]} × ${cncBedMm[2]} mm CNC bed.`;

  return { setups, cncAttachment, cncFitNote };
}

/**
 * Build the Bird's-Eye Corner Orientation Map so a beginner never runs the
 * same leg program 4 times without mirroring ("The Four Left Legs Trap").
 */
function buildBirdsEyeMapMarkdown(parts: MemberJoineryPart[]): string {
  const legs = parts.filter((p) => p.member.role === 'leg');
  if (legs.length === 0) return '';

  return [
    `## Corner Leg Orientation Map`,
    ``,
    `> [!IMPORTANT]`,
    `> Each corner leg has mortises on its two **interior** faces ($90^\\circ$ apart) and show faces on the **exterior** corner. Label \`Leg_FL\`, \`Leg_FR\`, \`Leg_BL\`, and \`Leg_BR\` on the top end-grain before cutting.`,
    ``,
    '```text',
    '                    BACK (+Y Show Face)',
    '       ┌───────────────┐           ┌───────────────┐',
    '       │    Leg_BL     │◄─Mortise─►│    Leg_BR     │',
    '       │ (Back-Left)   │  Back     │ (Back-Right)  │',
    '  L    └──────┬────────┘  Rail     └────────┬──────┘    R',
    '  E           ▲                             ▲           I',
    '  F        Mortise                       Mortise        G',
    '  T        Left Rail                     Right Rail     H',
    ' (-X)         ▼                             ▼           T (+X)',
    '       ┌──────┴────────┐  Front    ┌────────┴──────┐',
    '       │    Leg_FL     │◄─Mortise─►│    Leg_FR     │',
    '       │ (Front-Left)  │  Rail     │ (Front-Right) │',
    '       └───────────────┘           └───────────────┘',
    '                   FRONT (-Y Show Face)',
    '```',
  ].join('\n');
}

/**
 * Build the complete Timber Cut Plan, CNC Window Setups, Per-Part Fabrication
 * Cards, and Beginner-Proof Markdown Manual.
 */
export function buildTimberCutPlan(
  breakdown: TimberBreakdownResult,
  rawOptions: CutPlanOptions = {},
): TimberCutPlan {
  const cncBedMm: [number, number, number] = rawOptions.cncBedMm ?? [300, 300, 60];
  const defaultStockLengthMm = rawOptions.defaultStockLengthMm ?? 1800;
  const sawKerfMm = rawOptions.sawKerfMm ?? 2;
  const roughAllowanceMm = rawOptions.roughAllowanceMm ?? 10;
  const { spindleRpm, feedRate, plungeRate, stepdownMm } = mortisingFeeds(breakdown.options.cutterDiaMm, rawOptions);

  const { bars: stockBars, partBarMap } = packStockBars(
    breakdown.parts,
    defaultStockLengthMm,
    sawKerfMm,
    roughAllowanceMm,
  );

  // Compute Hardware BOM
  const isGlueMode = breakdown.options.jointMode === 'butt';
  const isDowelMode = breakdown.options.jointMode === 'dowel';
  const isDadoMode = breakdown.options.jointMode === 'dado';
  const legCount = breakdown.parts.filter((p) => p.member.role === 'leg').length;
  const vertPanelCount = breakdown.parts.filter(
    (p) => p.member.role === 'panel' && Math.abs(p.member.axes[2][2]) < 0.5,
  ).length;
  const isEnclosedCase = vertPanelCount >= 3 || (vertPanelCount >= 2 && legCount < 2);
  const hasAprons = breakdown.parts.some(
    (p) => p.member.role === 'rail' && p.member.id.startsWith('Apron_'),
  );
  const hasTopPanel = breakdown.parts.some(
    (p) => p.member.role === 'panel' && Math.abs(p.member.axes[2][2]) >= 0.7,
  );
  const hardwareBom: { item: string; quantity: number; note: string }[] = [
    {
      item: 'PVA Wood Glue (e.g. Titebond II / III)',
      quantity: 1,
      note: isGlueMode
        ? 'Apply an even coat to mating ends and edges and clamp square.'
        : isDowelMode
          ? 'Apply a thin even coat to dowel holes, fluted pins, and mating joint faces.'
          : !isEnclosedCase && hasTopPanel && hasAprons
            ? 'Apply a thin coat to tenon cheeks and mortise walls (attach tabletop with expansion clips, not glue).'
            : 'Apply a thin coat to mating joinery faces and clamp square.',
    },
  ];
  const totalZClips = breakdown.parts.reduce((acc, p) => acc + p.zClipSlots.length, 0);
  const zClipWidthMm =
    breakdown.parts.find((p) => p.zClipSlots.length > 0)?.zClipSlots[0]?.slotWidthMm ??
    Math.max(4, breakdown.options.cutterDiaMm);
  if (totalZClips > 0) {
    hardwareBom.push({
      item: 'Tabletop Figure-8 / Z-Clip Expansion Fasteners + Wood Screws',
      quantity: totalZClips,
      note: `Hooks into the ${zClipWidthMm} mm apron kerf slots so the solid tabletop can expand/contract across the grain without cracking.`,
    });
  } else if (!isEnclosedCase && legCount >= 1 && hasAprons && hasTopPanel) {
    hardwareBom.push({
      item: 'Figure-8 Desktop Expansion Washers + Wood Screws',
      quantity: 4,
      note: 'Screws to the top edge of the aprons so the solid tabletop can expand/contract across the grain without CNC slots.',
    });
  }
  const dowelJoints = breakdown.joints.filter((j) => j.dowelCentersMm?.length);
  if (dowelJoints.length > 0) {
    const count = dowelJoints.reduce((s, j) => s + (j.dowelCentersMm?.length ?? 0), 0);
    const dia = dowelJoints[0].dowelDiaMm ?? 8;
    const len = dowelJoints[0].dowelLengthMm ?? 30;
    hardwareBom.push({
      item: `Fluted Hardwood Dowel Pins (Ø${dia} × ${len} mm)`,
      quantity: count,
      note: 'For joint/plank alignment.',
    });
  }
  hardwareBom.push({
    item: 'Bar / Pipe Clamps',
    quantity: 4,
    note: 'Minimum 4 clamps needed for the two-stage frame glue-up.',
  });

  const allCncSetups: CncWindowSetup[] = [];
  const partCards: PartFabricationCard[] = [];

  for (const part of breakdown.parts) {
    const m = part.member;
    const roughLen = Math.ceil(part.totalFinishedLengthMm + roughAllowanceMm);
    const roughDims: [number, number, number] = [
      roughLen,
      Math.ceil(part.crossSectionMm[0]),
      Math.ceil(part.crossSectionMm[1]),
    ];
    const finishedDims: [number, number, number] = [
      part.totalFinishedLengthMm,
      part.crossSectionMm[0],
      part.crossSectionMm[1],
    ];
    const stockBarRef = partBarMap.get(m.id) ?? 'Custom Stock';

    const {
      setups: cncSetups,
      cncAttachment,
      cncFitNote,
    } = buildCncSetupsForPart(
      part,
      cncBedMm,
      breakdown.options.cutterDiaMm,
      spindleRpm,
      feedRate,
      plungeRate,
      stepdownMm,
    );
    allCncSetups.push(...cncSetups);

    // Step 1: Saw cuts (dimensions first; no CNC needed for straight cuts)
    const bandsawSteps: string[] = [
      `Cut to ${part.totalFinishedLengthMm} × ${part.crossSectionMm[0]} × ${part.crossSectionMm[1]} mm${part.tenons.length > 0 ? ` (${part.shoulderToShoulderMm} mm between shoulders)` : ''}.`,
    ];

    for (const t of part.tenons) {
      const miterCount = t.miterPlanes?.length ?? (t.miteredTip ? 1 : 0);
      const miterNote =
        miterCount > 1
          ? `, ${miterCount}× 45° mitered tip cheeks`
          : t.miteredTip
            ? `, 45° miter on tip`
            : '';
      const roundNote =
        breakdown.options.tenonCornerFit === 'round_tenon'
          ? `, round corners to R${+roundTenonCornerRadiusMm(t.widthMm, t.thicknessMm, breakdown.options.cutterDiaMm).toFixed(2)} mm`
          : '';
      const featureWord = isDadoMode ? 'Dado tongue' : 'Tenon';
      if (t.cutMethod === 'bandsaw') {
        bandsawSteps.push(
          `${featureWord} on ${t.railEnd} end (into ${t.matingMemberId}): ${t.lengthMm} × ${t.widthMm} × ${t.thicknessMm} mm (${t.shoulderCheekMm} mm shoulder${miterNote}${roundNote}).`,
        );
      } else {
        bandsawSteps.push(
          `Angled ${featureWord.toLowerCase()} on ${t.railEnd} end (${t.shoulderAngleDeg}° into ${t.matingMemberId}): ${t.lengthMm} × ${t.widthMm} × ${t.thicknessMm} mm${miterNote}${roundNote}.`,
        );
      }
    }

    for (const mort of part.mortises) {
      const faceNum = memberFaceNumber(m, mort.faceNormal);
      const featureWord = isDadoMode ? 'Dado slot' : 'Mortise';
      const chiselNote = mort.cornerFit === 'chisel_square' ? ' (square corners with chisel after CNC)' : '';
      bandsawSteps.push(
        `${featureWord} on Face F${faceNum} (for ${mort.matingMemberId}, ${mort.distFromTopEndMm} mm from top end): ${mort.thicknessMm} × ${mort.widthMm} × ${mort.depthMm} mm${chiselNote}.`,
      );
    }

    for (const zc of part.zClipSlots) {
      const faceNormal: Vec3 = [-zc.inwardNormal[0], -zc.inwardNormal[1], -zc.inwardNormal[2]];
      const faceNum = memberFaceNumber(m, faceNormal);
      bandsawSteps.push(
        `Tabletop clip slot on Face F${faceNum} (${zc.distFromTopEdgeMm} mm from top edge): ${zc.slotLengthMm} × ${zc.slotWidthMm} × ${zc.slotDepthMm} mm.`,
      );
    }

    // Dowel hole drilling steps (for frame dowel joints and plank seam dowels)
    const { topTipCoord: partTopCoord } = partShoulderBoundsAlongAxis(part);
    for (const j of breakdown.joints) {
      if (!j.dowelCentersMm?.length) continue;
      const count = j.dowelCentersMm.length;
      const dia = j.dowelDiaMm ?? 8;
      const holeDepth = +((j.dowelLengthMm ?? 30) * 0.5 + 1).toFixed(1);
      if (j.kind === 'dowel') {
        if (j.memberAId === m.id) {
          bandsawSteps.push(
            `Drill ${count}× Ø${dia} × ${holeDepth} mm dowel hole${count > 1 ? 's' : ''} centered in end grain (into ${j.memberBId}).`,
          );
        } else if (j.memberBId === m.id) {
          const faceNormal: Vec3 = [-j.normalAToB[0], -j.normalAToB[1], -j.normalAToB[2]];
          const faceNum = memberFaceNumber(m, faceNormal);
          const distFromTopMm = Math.round((partTopCoord - dot(j.centerMm, m.axes[0])) * 10) / 10;
          bandsawSteps.push(
            `Drill ${count}× Ø${dia} × ${holeDepth} mm dowel hole${count > 1 ? 's' : ''} on Face F${faceNum} (${distFromTopMm} mm from top end, for ${j.memberAId}).`,
          );
        }
      } else if (j.kind === 'plank_dowel' && (j.memberAId === m.id || j.memberBId === m.id)) {
        const otherId = j.memberAId === m.id ? j.memberBId : j.memberAId;
        bandsawSteps.push(
          `Drill ${count}× Ø${dia} × ${holeDepth} mm alignment dowel holes along seam edge (mating with ${otherId}).`,
        );
      }
    }

    // Step 2/3: Taper & Stopped Edge Roundover (only when applicable)
    const taperAndProfileSteps: string[] = [];
    if (m.isTapered && m.taperEndMm) {
      taperAndProfileSteps.push(
        `Taper inner faces from 15 mm below lowest joint to ${m.taperEndMm[0]} × ${m.taperEndMm[1]} mm at foot.`,
      );
    }
    if (part.stoppedEdgeZones.length > 0 && breakdown.options.edgeProfile !== 'square' && breakdown.options.edgeRadiusMm > 0) {
      const spans = part.stoppedEdgeZones.map((z) => `${z.fromMm}–${z.toMm} mm`).join(', ');
      taperAndProfileSteps.push(
        `Stopped ${breakdown.options.edgeProfile === 'roundover' ? 'roundover' : 'chamfer'} (${breakdown.options.edgeRadiusMm} mm) along ${spans}, stopping ${breakdown.options.stopMarginMm} mm clear of joints.`,
      );
    }

    // Dry-Fit Verification
    const fitCheckSteps: string[] = [];
    if (part.tenons.length > 0) {
      fitCheckSteps.push(
        `Dry-fit ${isDadoMode ? 'dado tongues' : 'tenons'} into ${part.tenons.map((t) => t.matingMemberId).join(', ')}.`,
      );
    } else if (isDowelMode) {
      const matingIds = breakdown.joints
        .filter((j) => j.kind === 'dowel' && (j.memberAId === m.id || j.memberBId === m.id))
        .map((j) => (j.memberAId === m.id ? j.memberBId : j.memberAId));
      if (matingIds.length > 0) {
        fitCheckSteps.push(`Dry-fit dowels into ${[...new Set(matingIds)].join(', ')}.`);
      }
    }

    const cncSectionTitle =
      part.mortises.length > 0 && part.zClipSlots.length > 0
        ? isDadoMode
          ? 'CNC Needed: Dadoes & Clip Slots'
          : 'CNC Needed: Mortises & Slots'
        : part.mortises.length > 0
          ? isDadoMode
            ? 'CNC Needed: Dado Slots'
            : 'CNC Needed: Mortises'
          : 'CNC Needed: Tabletop Clip Slots';

    const cardMdLines: string[] = [
      `### Part ${part.member.index + 1}: ${m.title}`,
      `- **Cut Dimensions:** \`${finishedDims[0]} × ${finishedDims[1]} × ${finishedDims[2]} mm\`${part.tenons.length > 0 ? ` *(Shoulder-to-Shoulder: \`${part.shoulderToShoulderMm} mm\`)*` : ''}`,
      `- **Reference Datum Faces:** **Face 1** = ${m.face1.label} · **Face 2** = ${m.face2.label}`,
      ``,
      `#### 1. Cut & Joinery Dimensions`,
      ...bandsawSteps.map((s) => `- [ ] ${s}`),
    ];

    if (cncSetups.length > 0) {
      cardMdLines.push(``, `#### 2. ${cncSectionTitle}`);
      for (const s of cncSetups) {
        cardMdLines.push(
          `- [ ] **Setup \`${s.id}\` (~${s.estimatedMinutes} min, Ø${s.cutterDiaMm} mm end mill):**`,
          ...s.workholdingNotes.map((w) => `  - ${w}`),
          ...s.operationsSummary.map((o) => `  - *Cut:* ${o}`),
        );
      }
    }

    if (taperAndProfileSteps.length > 0) {
      cardMdLines.push(
        ``,
        `#### ${cncSetups.length > 0 ? '3' : '2'}. Tapers & Edge Profiles`,
        ...taperAndProfileSteps.map((s) => `- [ ] ${s}`),
      );
    }

    partCards.push({
      partIndex: part.member.index,
      partId: m.id,
      partTitle: m.title,
      role: m.role,
      mirrorOf: m.mirrorOf,
      finishedDimsMm: finishedDims,
      shoulderToShoulderMm: part.shoulderToShoulderMm,
      roughBlankDimsMm: roughDims,
      stockBarRef,
      face1Label: m.face1.label,
      face2Label: m.face2.label,
      bandsawSteps,
      cncAttachment,
      ...(cncFitNote ? { cncFitNote } : {}),
      cncSectionTitle,
      cncSetups,
      taperAndProfileSteps,
      fitCheckSteps,
      markdown: cardMdLines.join('\n'),
    });
  }

  const birdsEyeMapMarkdown = buildBirdsEyeMapMarkdown(breakdown.parts);

  const glueUpGuideMarkdown = isEnclosedCase
    ? [
        `## Assembly & Squaring Checklist`,
        ``,
        `1. **Edge-glue panels:** Glue and clamp any multi-plank panels flat; allow to cure and scrape squeeze-out.`,
        `2. **Dry-fit carcase:** Assemble sides, front/back, bottom, and any cleats/battens without glue to verify squareness and fit.`,
        `3. **Glue & square carcase:** Glue the carcase joints and clamp across both diagonals ($D_1 = D_2$ within $1\\text{ mm}$).`,
        `4. **Base & lid/top:** Attach plinth/base rails and fit the top/lid panel (hinged or fastened per hardware spec).`,
      ].join('\n')
    : [
        `## Assembly & Squaring Checklist`,
        ``,
        `1. **Dry-fit:** Assemble the frame without glue and verify joint seating and squareness.`,
        `2. **Side sub-assemblies:** Glue and clamp the **Left Frame** (\`Leg_FL\` + \`Leg_BL\` + left rails) and **Right Frame** (\`Leg_FR\` + \`Leg_BR\` + right rails) flat; allow to cure.`,
        `3. **Cross rails & squaring:** Join the cured side frames with the **Front** and **Back** rails; verify corner-to-corner diagonals ($D_1 = D_2$ within $1\\text{ mm}$).`,
        `4. **Tabletop / seat:** Edge-glue planks if split, then secure the top to the aprons using **Z-Clip / Figure-8 expansion fasteners** (do not glue solid wood tops directly to aprons).`,
      ].join('\n');

  const bomLines: string[] = [
    `# Shop Build Guide & Part-by-Part Instructions`,
    ``,
    `## 1. Bill of Materials (Stock to Buy & Hardware)`,
    ``,
    `### Timber Stock Bars (${stockBars.length} bar${stockBars.length === 1 ? '' : 's'})`,
    `| Bar | Stock Cross-Section | Stock Length | Used | Offcut | Cuts Packed |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`,
    ...stockBars.map(
      (b) =>
        `| **Bar #${b.barIndex}** | \`${b.thicknessMm} × ${b.widthMm} mm\` | \`${b.stockLengthMm} mm\` | \`${b.usedLengthMm} mm\` | \`${b.offcutMm} mm\` (${b.wastePercent}% waste) | ${b.cuts.map((c) => `\`${c.partId}\` (${c.roughCutLengthMm} mm)`).join(', ')} |`,
    ),
    ``,
    `### Hardware & Consumables`,
    ...hardwareBom.map((h) => `- **${h.quantity}× ${h.item}** — ${h.note}`),
  ];

  const buildGuideMarkdown = [
    bomLines.join('\n'),
    birdsEyeMapMarkdown,
    `## 2. Per-Part Fabrication Cards (${partCards.length} Parts)`,
    partCards.map((c) => c.markdown).join('\n\n---\n\n'),
    glueUpGuideMarkdown,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  return {
    cncBedMm,
    stockBars,
    hardwareBom,
    allCncSetups,
    partCards,
    birdsEyeMapMarkdown,
    glueUpGuideMarkdown,
    buildGuideMarkdown,
  };
}

