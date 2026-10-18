// ---------------------------------------------------------------------------
// Timber & Joinery Breakdown — Phase 3 & 3.5: Stock Nesting, Sliding CNC
// Setups, G-Code Generation & Novice-Proof Per-Part Build Guide
// ---------------------------------------------------------------------------

import type {
  MemberJoineryPart,
  MortiseSpec,
  TenonSpec,
  TimberBreakdownResult,
  ZClipSlotSpec,
} from './timberJoinery';
import type { Vec3 } from './printPlate';

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
  fileName: string;
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
  /** Ready-to-run GRBL G-code (.nc) for this window setup. */
  gcode: string;
  estimatedMinutes: number;
}

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
  /** Spindle RPM for CNC G-code. Default 12000. */
  spindleRpm?: number;
  /** XY feedrate in timber, mm/min. Default 900. */
  feedRateMmMin?: number;
  /** Z plunge rate in timber, mm/min. Default 250. */
  plungeRateMmMin?: number;
  /** Max Z stepdown per pass, mm. Default 2.5 mm. */
  stepdownMm?: number;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

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
function generateWindowGcode(params: {
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
    widthYMm: number;
    thicknessXMm: number;
    depthMm: number;
    dogbone: boolean;
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
  const lines: string[] = [
    `; Setup: ${setupId} — Part ${partId}`,
    `; Face UP: ${faceUpLabel}`,
    `; Against Y-Axis Fence: ${fenceFaceLabel}`,
    `; Index Stop Offset from Top End: ${indexOffsetFromTopMm} mm`,
    `; Tool: ${cutterDiaMm} mm Flat End Mill`,
    `G21 G90 G17`,
    `G0 Z${fmt(safeZ)}`,
    `M3 S${Math.round(spindleRpm)}`,
  ];

  let cuttingDistMm = 0;

  for (const m of mortises) {
    lines.push(`; Mortise ${m.id}: ${m.thicknessXMm}x${m.widthYMm} mm, ${m.depthMm} mm deep`);
    const halfX = Math.max(0.1, m.thicknessXMm * 0.5 - rBit);
    const halfY = Math.max(0.1, m.widthYMm * 0.5 - rBit);
    const passes = Math.max(1, Math.ceil(m.depthMm / stepdownMm));

    // Rapid over center of mortise
    lines.push(`G0 X${fmt(m.centerXMm)} Y${fmt(m.centerYMm)}`);

    for (let p = 1; p <= passes; p++) {
      const z = -Math.min(m.depthMm, p * stepdownMm);
      // Ramp plunge along centerline Y
      const rampHalfY = Math.min(halfY, Math.max(1.5, rBit));
      lines.push(`G1 X${fmt(m.centerXMm)} Y${fmt(m.centerYMm - rampHalfY)} Z${fmt(z)} F${Math.round(plungeRate)}`);
      lines.push(`G1 X${fmt(m.centerXMm)} Y${fmt(m.centerYMm + rampHalfY)} F${Math.round(feedRate)}`);
      cuttingDistMm += rampHalfY * 4;

      // Offset spiral rings outward to clear the mortise pocket
      const rings = Math.max(1, Math.ceil(Math.max(halfX, halfY) / stepover));
      for (let r = 1; r <= rings; r++) {
        const frac = r / rings;
        const rx = halfX * frac;
        const ry = halfY * frac;
        lines.push(`G1 X${fmt(m.centerXMm - rx)} Y${fmt(m.centerYMm - ry)} F${Math.round(feedRate)}`);
        lines.push(`G1 X${fmt(m.centerXMm + rx)} Y${fmt(m.centerYMm - ry)}`);
        lines.push(`G1 X${fmt(m.centerXMm + rx)} Y${fmt(m.centerYMm + ry)}`);
        lines.push(`G1 X${fmt(m.centerXMm - rx)} Y${fmt(m.centerYMm + ry)}`);
        lines.push(`G1 X${fmt(m.centerXMm - rx)} Y${fmt(m.centerYMm - ry)}`);
        cuttingDistMm += 4 * (rx + ry);
      }

      // 4 Dogbone corner relief overcuts so a square bandsawn tenon drops right in
      if (m.dogbone) {
        const inset = rBit * Math.SQRT1_2;
        const dx = Math.max(0, m.thicknessXMm * 0.5 - inset);
        const dy = Math.max(0, m.widthYMm * 0.5 - inset);
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          lines.push(`G1 X${fmt(m.centerXMm + sx * dx)} Y${fmt(m.centerYMm + sy * dy)} F${Math.round(feedRate * 0.75)}`);
          lines.push(`G1 X${fmt(m.centerXMm + sx * halfX)} Y${fmt(m.centerYMm + sy * halfY)}`);
          cuttingDistMm += rBit * 2;
        }
      }
    }
    lines.push(`G0 Z${fmt(safeZ)}`);
  }

  for (const zc of zClips) {
    lines.push(`; Tabletop Z-Clip Expansion Slot ${zc.id}: ${zc.lengthYMm} mm long, ${zc.depthMm} mm deep`);
    const halfY = Math.max(0.5, zc.lengthYMm * 0.5 - rBit);
    const passes = Math.max(1, Math.ceil(zc.depthMm / stepdownMm));
    lines.push(`G0 X${fmt(zc.centerXMm)} Y${fmt(zc.centerYMm - halfY)}`);
    for (let p = 1; p <= passes; p++) {
      const z = -Math.min(zc.depthMm, p * stepdownMm);
      lines.push(`G1 Z${fmt(z)} F${Math.round(plungeRate)}`);
      lines.push(`G1 X${fmt(zc.centerXMm)} Y${fmt(zc.centerYMm + halfY)} F${Math.round(feedRate)}`);
      lines.push(`G1 X${fmt(zc.centerXMm)} Y${fmt(zc.centerYMm - halfY)}`);
      cuttingDistMm += halfY * 4;
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

function directionLabel(n: Vec3): string {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return n[2] >= 0 ? 'Top (+Z)' : 'Bottom (-Z)';
  if (ay >= ax) return n[1] >= 0 ? 'Back (+Y)' : 'Front (-Y)';
  return n[0] >= 0 ? 'Right (+X)' : 'Left (-X)';
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
): CncWindowSetup[] {
  const setups: CncWindowSetup[] = [];
  const maxWindowLenMm = Math.max(120, Math.max(cncBedMm[0], cncBedMm[1]) - 30);
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

  let faceIdx = 1;
  for (const [, group] of faceGroups) {
    const sortedMortises = [...group.mortises].sort((a, b) => a.distFromTopEndMm - b.distFromTopEndMm);
    // Partition mortises along the member's length into windows of span <= maxWindowLenMm
    const windows: { startOffsetMm: number; mortises: MortiseSpec[]; zClips: ZClipSlotSpec[] }[] = [];

    for (const m of sortedMortises) {
      const mTop = Math.max(0, m.distFromTopEndMm - m.widthMm * 0.5 - 15);
      const mBot = m.distFromTopEndMm + m.widthMm * 0.5 + 15;
      const last = windows[windows.length - 1];
      if (!last) {
        const startOffset = mBot <= maxWindowLenMm ? 0 : Math.floor(mTop / 10) * 10;
        windows.push({ startOffsetMm: startOffset, mortises: [m], zClips: [] });
      } else if (mBot - last.startOffsetMm <= maxWindowLenMm) {
        last.mortises.push(m);
      } else {
        const startOffset = Math.floor(mTop / 10) * 10;
        windows.push({ startOffsetMm: startOffset, mortises: [m], zClips: [] });
      }
    }

    if (group.zClips.length) {
      if (!windows.length) {
        windows.push({ startOffsetMm: 0, mortises: [], zClips: [...group.zClips] });
      } else {
        windows[0].zClips.push(...group.zClips);
      }
    }

    // Determine which marked Reference Face (Face 1 or Face 2) sits against the Y-axis fence
    const alignWithFace1 = Math.abs(dot(group.faceNormal, part.member.face1.normal)) < 0.5;
    const fenceFaceLabel = alignWithFace1
      ? `Face 1 (${part.member.face1.label})`
      : `Face 2 (${part.member.face2.label})`;
    const faceUpLabel = `Interior ${directionLabel(group.faceNormal)} Face`;

    windows.forEach((win, wIdx) => {
      const winNum = wIdx + 1;
      const setupId = `${part.member.id}_F${faceIdx}_W${winNum}`;
      const fileName = `${setupId}.nc`;
      const overhangMm = Math.max(0, Math.round(partLenMm - maxWindowLenMm));

      const opsSummary: string[] = [];
      for (const m of win.mortises) {
        opsSummary.push(
          `Mortise for ${m.matingMemberId}: ${m.thicknessMm} mm wide × ${m.widthMm} mm long × ${m.depthMm} mm deep (at ${m.distFromTopEndMm} mm from top end${m.dogboneDiaMm ? `, Ø${m.dogboneDiaMm} mm dogbone corners` : ''})`,
        );
      }
      for (const zc of win.zClips) {
        opsSummary.push(
          `Tabletop Z-Clip slot: ${zc.slotLengthMm} mm long × ${zc.slotWidthMm} mm wide × ${zc.slotDepthMm} mm deep (${zc.distFromTopEdgeMm} mm below top edge)`,
        );
      }

      const workholdingNotes: string[] = [
        `Clamp a straight auxiliary fence along the CNC Y-axis.`,
        `Place **${faceUpLabel} UP** toward the spindle, and press **${fenceFaceLabel}** tight against the Y-axis fence.`,
      ];
      if (win.startOffsetMm === 0) {
        workholdingNotes.push(
          `Butt the **Top End** of ${part.member.id} squarely against the Y0 physical end-stop.`,
        );
      } else {
        workholdingNotes.push(
          `Slide ${part.member.id} along the Y-axis fence until the Top End is exactly **${win.startOffsetMm} mm** past the Y0 stop (use a ${win.startOffsetMm} mm spacer bar or index pin — do not eyeball a freehand pencil mark).`,
        );
      }
      if (overhangMm > 120) {
        workholdingNotes.push(
          `**Overhang Support (${overhangMm} mm overhanging bed):** Place a level support block or roller stand under the overhanging end of the ${Math.round(partLenMm)} mm blank so it cannot sag or vibrate.`,
        );
      }

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
        mortises: win.mortises.map((m) => ({
          id: m.id,
          centerXMm: m.distFromRefEdgeMm,
          centerYMm: Math.max(m.widthMm * 0.5 + 5, m.distFromTopEndMm - win.startOffsetMm),
          widthYMm: m.widthMm,
          thicknessXMm: m.thicknessMm,
          depthMm: m.depthMm,
          dogbone: m.cornerFit === 'dogbone',
        })),
        zClips: win.zClips.map((zc) => ({
          id: zc.id,
          centerXMm: zc.distFromTopEdgeMm,
          centerYMm: partLenMm * 0.5 - win.startOffsetMm,
          lengthYMm: zc.slotLengthMm,
          widthXMm: zc.slotWidthMm,
          depthMm: zc.slotDepthMm,
        })),
      });

      setups.push({
        id: setupId,
        fileName,
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

    faceIdx++;
  }

  return setups;
}

/**
 * Build the Bird's-Eye Corner Orientation Map so a beginner never runs the
 * same leg program 4 times without mirroring ("The Four Left Legs Trap").
 */
function buildBirdsEyeMapMarkdown(parts: MemberJoineryPart[]): string {
  const legs = parts.filter((p) => p.member.role === 'leg');
  if (legs.length === 0) return '';

  return [
    `## Bird's-Eye Corner Orientation Map (Preventing the "Four Identical Legs" Trap)`,
    ``,
    `> [!IMPORTANT]`,
    `> Each corner leg has mortises on its two **interior** faces ($90^\\circ$ apart) and its stopped roundover/show faces on the **exterior** corner. Mark \`Leg_FL\`, \`Leg_FR\`, \`Leg_BL\`, and \`Leg_BR\` on the top end-grain in pencil before cutting!`,
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
  const spindleRpm = rawOptions.spindleRpm ?? 12000;
  const feedRate = rawOptions.feedRateMmMin ?? 900;
  const plungeRate = rawOptions.plungeRateMmMin ?? 250;
  const stepdownMm = rawOptions.stepdownMm ?? 2.5;

  const { bars: stockBars, partBarMap } = packStockBars(
    breakdown.parts,
    defaultStockLengthMm,
    sawKerfMm,
    roughAllowanceMm,
  );

  // Compute Hardware BOM
  const hardwareBom: { item: string; quantity: number; note: string }[] = [
    {
      item: 'PVA Wood Glue (e.g. Titebond II / III)',
      quantity: 1,
      note: 'Apply a thin even coat to tenon cheeks and mortise walls; never glue the solid tabletop directly to aprons.',
    },
  ];
  const totalZClips = breakdown.parts.reduce((acc, p) => acc + p.zClipSlots.length, 0);
  if (totalZClips > 0) {
    hardwareBom.push({
      item: 'Tabletop Figure-8 / Z-Clip Expansion Fasteners + Wood Screws',
      quantity: totalZClips,
      note: 'Hooks into the 4 mm apron kerf slots so the solid tabletop can expand/contract across the grain without cracking.',
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

    const cncSetups = buildCncSetupsForPart(
      part,
      cncBedMm,
      breakdown.options.cutterDiaMm,
      spindleRpm,
      feedRate,
      plungeRate,
      stepdownMm,
    );
    allCncSetups.push(...cncSetups);

    // Step 1: Bandsaw Blank & Tenon Preparation
    const bandsawSteps: string[] = [
      `Crosscut rough blank to **${roughLen} mm** from **${stockBarRef}** on the bandsaw, then trim both ends square to exact finished blank length **${part.totalFinishedLengthMm} mm**.`,
      `Mark **Face 1 (${m.face1.label})** and **Face 2 (${m.face2.label})** in pencil with a cabinetmaker's triangle ($\\Delta$). Always place these marked faces against the bandsaw fence and CNC stop.`,
    ];

    for (const t of part.tenons) {
      if (t.cutMethod === 'bandsaw') {
        bandsawSteps.push(
          `**Tenon on \`${t.railEnd}\` end (into ${t.matingMemberId}):** Set bandsaw fence to leave a **${t.thicknessMm} mm** thick × **${t.widthMm} mm** wide × **${t.lengthMm} mm** long tenon (cheek setback **${t.shoulderCheekMm} mm**, top/bottom shoulder setback **${t.shoulderTopBotMm} mm**; shoulder-to-shoulder span = **${part.shoulderToShoulderMm} mm**).`,
        );
      } else {
        bandsawSteps.push(
          `**Angled Tenon on \`${t.railEnd}\` end (${t.shoulderAngleDeg}° shoulder into ${t.matingMemberId}):** Cut the ${t.shoulderAngleDeg}° shoulder and ${t.thicknessMm}×${t.widthMm}×${t.lengthMm} mm tenon on the CNC (or with the bandsaw mitre gauge set to ${t.shoulderAngleDeg}°).`,
        );
      }
      if (t.miteredTip) {
        bandsawSteps.push(
          `**Corner Clearance Miter (${t.railEnd} end):** Nip a **$45^\\circ$ miter** off the inside tip of the tenon on the bandsaw so the two meeting corner tenons nest cleanly inside ${t.matingMemberId} without colliding.`,
        );
      }
    }

    // Step 3: Taper & Stopped Edge Roundover (STRICTLY AFTER CNC MORTISES!)
    const taperAndProfileSteps: string[] = [];
    if (m.isTapered && m.taperEndMm) {
      taperAndProfileSteps.push(
        `**ORDER OF OPERATIONS WARNING:** Only cut the leg taper **AFTER** all CNC mortises are finished while the blank is still square!`,
        `**Bandsaw Leg Taper:** Mark the taper on the two interior faces starting $15\\text{ mm}$ below the lowest mortise down to **${m.taperEndMm[0]} × ${m.taperEndMm[1]} mm** at the foot. Saw just outside the pencil line on the bandsaw and smooth with a sanding block or plane.`,
      );
    }
    if (part.stoppedEdgeZones.length > 0) {
      const spans = part.stoppedEdgeZones.map((z) => `${z.fromMm}–${z.toMm} mm`).join(', ');
      taperAndProfileSteps.push(
        `**Stopped ${breakdown.options.edgeProfile === 'roundover' ? 'Roundover' : 'Chamfer'} (${breakdown.options.edgeRadiusMm} mm):** Soften the exposed longitudinal edges over spans **${spans}** (measured from the top/start end), stopping **${breakdown.options.stopMarginMm} mm clear of every mortise and joint shoulder** so the joint faces stay dead flat and crisp.`,
      );
    } else {
      taperAndProfileSteps.push(
        `Break sharp exterior edges lightly with 180-grit sandpaper while keeping all joint shoulders and mortise mouths crisp and flat.`,
      );
    }

    // Step 4: Dry-Fit Verification
    const fitCheckSteps: string[] = [];
    if (part.tenons.length > 0) {
      fitCheckSteps.push(
        `Test-fit each tenon into its mating mortise (${part.tenons.map((t) => t.matingMemberId).join(', ')}) using **firm hand pressure only — never pound a dry tenon in with a hammer** (which can split the leg along the grain). If slightly tight from bandsaw blade ripple, lightly kiss the tenon cheeks with 120-grit sandpaper on a flat block.`,
      );
    }
    if (part.mortises.length > 0) {
      fitCheckSteps.push(
        `Vacuum wood chips out of ${part.mortises.length} mortise pocket(s) and verify the ${breakdown.options.glueReliefMm} mm glue-relief space at the bottom.`,
      );
    }
    fitCheckSteps.push(`Write **${m.id}** in pencil on the hidden end-grain or underside.`);

    const cardMdLines: string[] = [
      `### Part ${part.member.index + 1}: ${m.title}`,
      `- **Role:** \`${m.role}\`${m.mirrorOf ? ` · **Mirror Pair of:** \`${m.mirrorOf}\`` : ''}`,
      `- **Finished Blank Size:** \`${finishedDims[0]} × ${finishedDims[1]} × ${finishedDims[2]} mm\`${m.role === 'rail' ? ` *(Shoulder-to-Shoulder: \`${part.shoulderToShoulderMm} mm\`)*` : ''}`,
      `- **Rough Blank to Cut:** \`${roughDims[0]} × ${roughDims[1]} × ${roughDims[2]} mm\` from **${stockBarRef}**`,
      `- **Reference Datum Faces:** **Face 1** = ${m.face1.label} · **Face 2** = ${m.face2.label}`,
      ``,
      `#### 1. Bandsaw Blank & Tenon Cuts (Self-Cut)`,
      ...bandsawSteps.map((s) => `- [ ] ${s}`),
    ];

    if (cncSetups.length > 0) {
      cardMdLines.push(``, `#### 2. CNC Router Setups (Cut While Blank is Square)`);
      for (const s of cncSetups) {
        cardMdLines.push(
          `- [ ] **Setup \`${s.id}\` (\`${s.fileName}\`, ~${s.estimatedMinutes} min, Ø${s.cutterDiaMm} mm end mill):**`,
          ...s.workholdingNotes.map((w) => `  - ${w}`),
          ...s.operationsSummary.map((o) => `  - *Cut:* ${o}`),
        );
      }
    }

    cardMdLines.push(
      ``,
      `#### ${cncSetups.length > 0 ? '3' : '2'}. Tapers & Stopped Edge Profiles`,
      ...taperAndProfileSteps.map((s) => `- [ ] ${s}`),
      ``,
      `#### ${cncSetups.length > 0 ? '4' : '3'}. Dry-Fit & Labeling`,
      ...fitCheckSteps.map((s) => `- [ ] ${s}`),
    );

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
      cncSetups,
      taperAndProfileSteps,
      fitCheckSteps,
      markdown: cardMdLines.join('\n'),
    });
  }

  const birdsEyeMapMarkdown = buildBirdsEyeMapMarkdown(breakdown.parts);

  const glueUpGuideMarkdown = [
    `## Two-Stage Glue-Up & Squaring Checklist`,
    ``,
    `> [!TIP]`,
    `> PVA wood glue has a 5–10 minute open working time. **Never try to glue all legs, rails, and stretchers in one panicked step.** Build two flat side frames first, let them cure, then join them together.`,
    ``,
    `1. **Complete Full Dry-Fit First (No Glue):** Assemble the entire frame dry, pull the shoulders tight with clamps, and confirm there are no gaps or twisted rails.`,
    `2. **Stage 1 — Glue the Two Flat Side Sub-Assemblies:**`,
    `   - Glue and clamp the **Left Frame** (\`Leg_FL\` + \`Leg_BL\` + Left Apron/Stretchers) flat on your bench.`,
    `   - Glue and clamp the **Right Frame** (\`Leg_FR\` + \`Leg_BR\` + Right Apron/Stretchers) flat on your bench.`,
    `   - Wipe squeezed-out glue with a damp cloth and let cure for 30–45 minutes.`,
    `3. **Stage 2 — Join Left & Right Frames with Front & Back Rails:**`,
    `   - Stand both cured side frames upright on a flat surface and glue the **Front** and **Back** rails/stretchers between them.`,
    `   - **Diagonal Squaring Check:** Measure corner-to-corner diagonals ($D_1$ from \`Leg_FL\` to \`Leg_BR\` vs. $D_2$ from \`Leg_FR\` to \`Leg_BL\`). Adjust clamp pressure until $D_1 = D_2$ within $1\\text{ mm}$.`,
    `4. **Stage 3 — Attach Tabletop / Seat with Expansion Clips (No Glue on Aprons!):**`,
    `   - If the tabletop was split into planks, edge-glue the planks together first using the alignment dowels.`,
    `   - Place the finished tabletop face-down, center the base frame on it, and hook the **Z-Clip expansion fasteners** into the $4\\text{ mm}$ apron slots and screw into the underside of the top. **Do not glue the solid wood top to the aprons.**`,
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

