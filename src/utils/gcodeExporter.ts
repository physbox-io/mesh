// ---------------------------------------------------------------------------
// G-Code Generator Engine for Laser Cutters & CNC Routers
// ---------------------------------------------------------------------------

import type { BlindPocket2D, LaserPanel, Point2D } from './laserCutExporter';
import type { ContourSliceResult } from './contourSliceExporter';
import { estimateGcodeTime } from './timeEstimate';
import { DEFAULT_MOTION_PROFILE, type MotionProfile } from './motionProfile';
import { offsetRegion, offsetNestedLoops, offsetRings, orientForClimb, nestingDepths } from './polygonOffset';
import { clearingRings } from './adaptiveClearing';
import { commentText } from './gcodeComments';
import { measureGcodeBounds } from './workEnvelope';
import { routerStepdownMm } from './sheetCutRecipe';

export interface GcodeExportOptions {
  machineMode: 'laser' | 'cnc';
  /**
   * Controller's maximum S-value, i.e. GRBL's `$30` (default 1000). This is a
   * per-machine setting, not a standard: stock GRBL ships 1000, but plenty of
   * diode-laser boards ship 10000. Sending S1000 to a `$30=10000` machine runs
   * the tube at 10% power, which looks like a weak laser rather than a
   * misconfiguration. Check `$$` on the machine and set this to match.
   */
  laserMaxPower: number;
  /** Laser power for cutting, as an S-value in 0..laserMaxPower. */
  laserPower: number;
  /** Low laser power for guide framing, as an S-value on the $30=1000 scale (default 5 = 0.5%). Rescaled to laserMaxPower on output. */
  laserGuidePower: number;
  /** Number of times the laser retraces each cut path (default 1). */
  laserPasses: number;
  /**
   * Beam power for engraving a panel's surface pattern (LaserPanel.engrave2D),
   * as an S-value in 0..laserMaxPower. Its own number because marking a face
   * and cutting through it are an order of magnitude apart.
   */
  laserEngravePower: number;
  /** Feedrate for engraving, mm/min. Fast: a mark wants a light, even burn. */
  engraveFeedrate: number;
  /** Cut feedrate in mm/min (default 1200). */
  cutFeedrate: number;
  /** Travel rapid move feedrate in mm/min (default 3000). */
  travelFeedrate: number;
  /** CNC Z-axis plunge feedrate in mm/min (default 300). */
  plungeFeedrate: number;
  /** CNC Z safe height above bed in mm (default 5.0). */
  safeZ: number;
  /** Stock depth to cut through in mm for CNC (default 3.0). */
  cutDepthZ: number;
  /**
   * Face stock down to the thickness each panel was drawn at, before cutting
   * its profile. CNC only, and off unless asked for.
   *
   * The answer to having 10 mm in the rack and an 8 mm part in the model. The
   * other direction — stock thinner than drawn — cannot be machined away and is
   * refused by the panel exporter instead.
   *
   * Purely additive: it removes material above the finished face, and the
   * profile cut still goes the full depth of the original stock, cutting air
   * for the first couple of millimetres where the pocket already is.
   */
  faceToThickness?: boolean;
  /**
   * Stock thickness for each sheet index, in mm.
   *
   * Comes from the panel exporter's `sheets`, since only it knows which piece
   * of the rack a sheet was cut from. Without it there is nothing to face down
   * *from* and the pass does nothing.
   */
  sheetStockThicknessMm?: number[];
  /**
   * Each sheet's size, by sheet index, in mm. Only the facing pass reads it,
   * to keep a surfacing bit's edge on the sheet; without it only X0/Y0 bound it.
   */
  sheetSizeMm?: { widthMm: number; heightMm: number }[];
  /**
   * A separate bit for the facing, in mm, when the job genuinely has one (a
   * surfacing cutter). Unset, the facing runs on the job's own end mill
   * (`bitDiameterMm`): a facing pass must never ask for a tool nobody fitted.
   */
  facingBitDiameterMm?: number;
  /** Stepover as a fraction of the facing bit's diameter. */
  facingStepoverFraction: number;
  /** How much depth the facing bit takes per pass, in mm. */
  facingDepthPerPassMm: number;
  /** Depth per pass for CNC in mm (default 3.0). */
  zStepdown: number;
  /** Per-sheet stepdown override for mixed-thickness CNC stock, in mm. */
  sheetZStepdownMm?: number[];
  /** Spindle speed in RPM for CNC (default 12000). */
  spindleRpm: number;
  /**
   * What the machine can accelerate and traverse at, for the run-time estimate.
   * Read off the controller's `$$` when one is connected, assumed otherwise.
   */
  motionProfile?: MotionProfile;
  /** Insert M0 pause between material sheets. */
  pauseBetweenSheets: boolean;
  /** Insert T<N> M6 pause for tool changes. */
  pauseOnToolChange: boolean;
  /**
   * Leave short stretches of every part outline uncut, so finished parts stay
   * held in the stock instead of dropping out mid-job. Nothing to do with the
   * finger/mortise tabs of the joinery — these are sacrificial and get snapped
   * or pared off after the sheet comes off the machine.
   */
  attachmentsEnabled: boolean;
  /** Length of each attachment measured along the cut path, in mm. */
  attachmentWidthMm: number;
  /** Target distance between attachments along a cut path, in mm. */
  attachmentSpacingMm: number;
  /**
   * CNC only: stock left under the cutter as it rides over an attachment, in mm.
   * A laser has no Z, so its attachments are simply gaps in the cut and this is
   * ignored.
   */
  attachmentHeightMm: number;
  /**
   * Whether to run the cutter's edge along the geometry instead of its centre.
   *
   * A laser beam is thin enough that the exporter can treat it as a line and
   * correct for its width only where two parts have to meet. An end mill is a
   * 3 or 6 mm circle, and driving its centre along a part's outline cuts a path
   * a full radius inside that outline — every part undersized, every mortise
   * oversized, by half the bit. So on a router the outline is offset outward by
   * the radius and the holes inward by it, which is what puts the *edge* of the
   * tool on the line the model drew.
   *
   * 'auto' does that whenever the machine is a router. 'off' cuts on the line,
   * which is only right when the geometry has been compensated somewhere else.
   * Ignored entirely in laser mode.
   */
  cutterCompensation: 'auto' | 'off';
  /** Cutter diameter in mm, which is what the compensation is half of. */
  bitDiameterMm: number;
}

export const DEFAULT_GCODE_OPTIONS: GcodeExportOptions = {
  machineMode: 'laser',
  // 10000 is both the commoner diode-board $30 and the safer guess: GRBL clamps an
  // S-value above $30 down to $30, so overshooting a $30=1000 machine still cuts at
  // full power, while undershooting a $30=10000 machine quietly runs it at 10%.
  laserMaxPower: 10000,
  laserPower: 10000,
  laserGuidePower: 5,
  laserPasses: 1,
  // A fifth of full power at 3000 mm/min marks ply and MDF without cutting into
  // it on most diode and CO2 machines; the dialog says to test on scrap.
  laserEngravePower: 2000,
  engraveFeedrate: 3000,
  cutFeedrate: 1200,
  travelFeedrate: 3000,
  plungeFeedrate: 300,
  safeZ: 5.0,
  cutDepthZ: 3.0,
  faceToThickness: false,
  // Facing runs on the profile bit unless a facing bit is given; 60% stepover,
  // 1 mm a pass.
  facingStepoverFraction: 0.6,
  facingDepthPerPassMm: 1.0,
  zStepdown: 3.0,
  spindleRpm: 12000,
  motionProfile: DEFAULT_MOTION_PROFILE,
  pauseBetweenSheets: true,
  pauseOnToolChange: true,
  attachmentsEnabled: false,
  attachmentWidthMm: 4.0,
  attachmentSpacingMm: 80.0,
  attachmentHeightMm: 0.6,
  cutterCompensation: 'auto',
  bitDiameterMm: 3.175,
};

export interface GcodeOperation {
  id: string;
  name: string;
  type: 'framing' | 'cut' | 'engrave' | 'pause_sheet' | 'pause_tool' | 'facing' | 'pocket';
  sheetIndex: number;
  toolNumber?: number;
}

export interface GcodeExportResult {
  success: boolean;
  gcode: string;
  totalCutDistanceMm: number;
  estimatedTimeSeconds: number;
  sheetCount: number;
  operations: GcodeOperation[];
  /** The tool centre's reach. A router's also says how far Z runs, retracts included. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ?: number; maxZ?: number };
  /** How many holding attachments were left across the whole job. */
  attachmentCount: number;
  /**
   * How far the toolpath was offset from the geometry, in mm. Zero on a laser
   * and whenever compensation is off; half the bit diameter otherwise.
   */
  compensationMm: number;
  /**
   * Features the cutter is too fat to enter, and which therefore are not in the
   * output at all. Worth showing rather than swallowing: a panel that quietly
   * comes off the machine with none of its bolt holes is a wasted sheet.
   */
  warnings?: string[];
  error?: string;
}

/** How far a sheet CNC through-cut goes below the stock, as solid machining's `throughCutMm`. */
const SHEET_THROUGH_CUT_MM = 0.2;

function refusedResult(error: string): GcodeExportResult {
  return {
    success: false,
    gcode: '',
    totalCutDistanceMm: 0,
    estimatedTimeSeconds: 0,
    sheetCount: 0,
    operations: [],
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    attachmentCount: 0,
    compensationMm: 0,
    error,
  };
}

/** Why these settings cannot go to a controller, in a sentence, or null. */
function unusableSetting(o: GcodeExportOptions, depthsMm: number[]): string | null {
  const router = o.machineMode === 'cnc';
  const aboveZero: [string, number][] = [['cut feedrate', o.cutFeedrate], ['travel feedrate', o.travelFeedrate]];
  const numbers: [string, number][] = [];
  if (router) {
    aboveZero.push(['plunge feedrate', o.plungeFeedrate]);
    numbers.push(['spindle speed', o.spindleRpm], ['safe height', o.safeZ], ['bit diameter', o.bitDiameterMm], ['stepdown', o.zStepdown]);
  } else {
    aboveZero.push(['engrave speed', o.engraveFeedrate], ['maximum S-value', o.laserMaxPower], ['passes', o.laserPasses]);
    numbers.push(['laser power', o.laserPower], ['engrave power', o.laserEngravePower]);
  }
  for (const [name, value] of aboveZero) {
    if (!(value > 0 && Number.isFinite(value))) return `Set the ${name}: it has to be a number above zero.`;
  }
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value)) return `Set the ${name}: it is not a number.`;
  }
  if (router && depthsMm.some((d) => !(Math.abs(d) > 0 && Number.isFinite(d)))) {
    return 'Set the stock thickness: the cut depth is not above zero.';
  }
  return null;
}

/** The same move with its Z word raised. Text in a comment is left as it is. */
function raiseZ(line: string, mm: number): string {
  const cut = line.search(/[;(]/);
  const code = cut >= 0 ? line.slice(0, cut) : line;
  const rest = cut >= 0 ? line.slice(cut) : '';
  return code.replace(/\bZ(-?[\d.]+)/, (_, z) => `Z${f(parseFloat(z) + mm)}`) + rest;
}

/** Bounds plus the Z range of the finished program, for a router. */
function withZRange(bounds: GcodeExportResult['bounds'], gcode: string): GcodeExportResult['bounds'] {
  const measured = measureGcodeBounds(gcode);
  return measured?.minZ !== undefined ? { ...bounds, minZ: measured.minZ, maxZ: measured.maxZ } : bounds;
}

/** Cut S-value, clamped to the controller's $30 ceiling. */
function laserS(options: GcodeExportOptions): number {
  const ceiling = Math.max(1, Math.round(options.laserMaxPower));
  return Math.max(0, Math.min(ceiling, Math.round(options.laserPower)));
}

function laserEngraveS(options: GcodeExportOptions): number {
  const ceiling = Math.max(1, Math.round(options.laserMaxPower));
  return Math.max(0, Math.min(ceiling, Math.round(options.laserEngravePower)));
}

/** Guide S-value, authored on the $30=1000 scale and rescaled to this machine. */
function laserGuideS(options: GcodeExportOptions): number {
  const ceiling = Math.max(1, Math.round(options.laserMaxPower));
  const scaled = Math.round(options.laserGuidePower * (ceiling / 1000));
  return Math.max(1, Math.min(ceiling, scaled));
}

/** How many times each cut path is traced. Only the laser retraces in XY; CNC steps down in Z instead. */
function laserPassCount(options: GcodeExportOptions): number {
  if (options.machineMode !== 'laser') return 1;
  return Math.max(1, Math.round(options.laserPasses));
}

/**
 * How far the toolpath has to stand off the geometry, in mm.
 *
 * Zero for a laser: the beam's width is already accounted for upstream, where
 * the kerf is folded into the joint geometry itself, and offsetting again here
 * would correct for it twice.
 */
function compensationRadius(options: GcodeExportOptions): number {
  if (options.machineMode !== 'cnc') return 0;
  if (options.cutterCompensation === 'off') return 0;
  return Math.max(0, options.bitDiameterMm / 2);
}

/**
 * The narrow dimension of a loop's bounding box — a good enough answer to "how
 * wide is this feature" for telling someone their bit will not fit into it.
 */
function featureWidth(pts: Point2D[]): number {
  if (!pts || pts.length === 0) return 0;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function polygonPerimeter(pts: Point2D[]): number {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/** Formats a G-code coordinate number to 3 decimal places. */
function f(num: number): string {
  return num.toFixed(3);
}

// ---------------------------------------------------------------------------
// Attachments — the uncut bridges that hold a finished part in the stock
// ---------------------------------------------------------------------------

/**
 * One attachment, as four arc-length marks along its loop.
 *
 * The flat run between `flatStart` and `flatEnd` is the attachment proper. The
 * ramps either side exist because a router cannot climb out of and drop back
 * into its own slot instantly: without them the far edge of every attachment is
 * a full-width plunge into uncut stock. A laser has nothing to lift, so its
 * ramps are zero-length and the two pairs coincide.
 */
interface AttachmentSpan {
  rampInStart: number;
  flatStart: number;
  flatEnd: number;
  rampOutEnd: number;
}

/**
 * Where to leave attachments around a loop of the given perimeter.
 *
 * Count comes from the requested spacing, but is capped so no attachment can
 * take more than half of the run it sits in. A part gets two regardless, since
 * it swings on one and cuts free on none, as long as they leave at least half
 * its outline cut and do not meet: that is what guarantees no span straddles
 * the loop's start point, so the emitters below never have to deal with
 * wrapping. A loop too short for two keeps what the cap allows.
 */
function planAttachments(perimeterMm: number, options: GcodeExportOptions): AttachmentSpan[] {
  if (!options.attachmentsEnabled) return [];
  const baseWidth = Math.max(0.1, options.attachmentWidthMm);
  // On a router the cutter's centre stops a full radius inside either end of the
  // flat span, so the flat has to be a bit-diameter wider to leave the asked-for
  // bridge of stock behind.
  const width = options.machineMode === 'cnc'
    ? baseWidth + Math.max(0, options.bitDiameterMm)
    : baseWidth;
  const ramp = options.machineMode === 'cnc'
    ? Math.max(0.5, options.attachmentHeightMm)
    : 0;
  const span = width + 2 * ramp;
  const spacing = Math.max(span, options.attachmentSpacingMm);

  const maxCount = Math.floor(perimeterMm / (2 * span));
  const wanted = Math.min(maxCount, Math.round(perimeterMm / spacing));
  const count = perimeterMm >= 4 * width && perimeterMm > 2 * span ? Math.max(2, wanted) : wanted;
  if (count < 1) return [];

  const spans: AttachmentSpan[] = [];
  for (let k = 0; k < count; k++) {
    const centre = ((k + 0.5) * perimeterMm) / count;
    spans.push({
      rampInStart: centre - span / 2,
      flatStart: centre - width / 2,
      flatEnd: centre + width / 2,
      rampOutEnd: centre + span / 2,
    });
  }
  return spans;
}

/** A loop vertex tagged with how far around the loop it sits. */
interface LoopPoint { x: number; y: number; s: number }

/**
 * The loop closed back onto its first point, with an extra vertex inserted
 * wherever an attachment starts or ends. Splitting the path up front means the
 * emitters only ever switch state at a vertex.
 */
function resampleLoop(loop: Point2D[], spans: AttachmentSpan[]): LoopPoint[] {
  const cuts: number[] = [];
  for (const sp of spans) cuts.push(sp.rampInStart, sp.flatStart, sp.flatEnd, sp.rampOutEnd);
  cuts.sort((a, b) => a - b);

  const out: LoopPoint[] = [{ x: loop[0].x, y: loop[0].y, s: 0 }];
  let s = 0;
  let next = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const end = s + len;
    while (next < cuts.length && cuts[next] < end - 1e-6) {
      const cut = cuts[next++];
      if (cut <= out[out.length - 1].s + 1e-6 || len <= 1e-9) continue; // already past it, or a zero-length edge
      const t = (cut - s) / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: cut });
    }
    s = end;
    out.push({ x: b.x, y: b.y, s });
  }
  return out;
}

/** Whether an arc-length position falls in the uncut middle of an attachment. */
function inFlat(s: number, spans: AttachmentSpan[]): boolean {
  for (const sp of spans) if (s > sp.flatStart + 1e-6 && s < sp.flatEnd - 1e-6) return true;
  return false;
}

/**
 * Cutting depth at a point on the loop: `cutZ` everywhere except over an
 * attachment, where the tool rises to `topZ` and ramps back down.
 */
function attachmentZ(s: number, spans: AttachmentSpan[], cutZ: number, topZ: number): number {
  for (const sp of spans) {
    if (s <= sp.rampInStart || s >= sp.rampOutEnd) continue;
    if (s >= sp.flatStart && s <= sp.flatEnd) return topZ;
    const t = s < sp.flatStart
      ? (s - sp.rampInStart) / Math.max(1e-9, sp.flatStart - sp.rampInStart)
      : (sp.rampOutEnd - s) / Math.max(1e-9, sp.rampOutEnd - sp.flatEnd);
    return cutZ + (topZ - cutZ) * t;
  }
  return cutZ;
}

/**
 * Generates G-code from 2D LaserCut panels.
 * Interior holes/mortises are cut FIRST, outer polygon outlines are cut LAST.
 */
/**
 * A facing pass over one panel's footprint, taking the stock down to the
 * thickness the panel was drawn at.
 *
 * Per footprint rather than over the whole sheet: on a sparsely packed sheet
 * that is a fraction of the machining, and every panel on a sheet shares one
 * target thickness anyway because the packer groups sheets by it. Footprints
 * that overlap after the margin is added are simply faced twice, the second
 * time through air — cheaper than the bookkeeping to merge them.
 *
 * Serpentine, because lifting and returning across a cleared pocket for every
 * line doubles the travel for nothing.
 *
 * `keepClear` is every other part on the sheet that is not being faced as
 * deep, in sheet coordinates. The footprint is a bounding box, so it can reach
 * over a neighbour (one standing in an L's notch, or simply close by); each
 * row is clipped so the bit's edge stays off them, and a move between two
 * clipped stretches lifts over them rather than ploughing through.
 */
function facingLines(
  panel: LaserPanel,
  removalMm: number,
  options: GcodeExportOptions,
  f: (n: number) => string,
  sheet?: { widthMm: number; heightMm: number },
  keepClear: Point2D[][] = []
): {
  lines: string[];
  distanceMm: number;
  lastPoint: Point2D;
  /** Where the bit's edge reaches, for the job bounds. */
  reach: { minX: number; minY: number; maxX: number; maxY: number };
  /** The margin round the panel is narrower than the facing bit's radius on some side. */
  marginShort: boolean;
} {
  const lines: string[] = [];
  const pos = panel.placedPos2D || { x: 0, y: 0 };
  const bit = facingBitOf(options);
  const r = bit / 2;
  const stepover = Math.max(Math.min(0.5, bit / 2), bit * Math.min(Math.max(options.facingStepoverFraction, 0.05), 1));
  const perPass = Math.max(0.1, options.facingDepthPerPassMm);

  /*
   * How far the bit's centre travels: to the footprint's edge plus the
   * profile's kerf. With the centre on the edge the bit already faces a radius
   * past it; the kerf on top is the slot the profile will cut there, so the
   * strip between the faced area and the profile is faced too and no lip of
   * full-thickness stock is left standing against the part. This used to send
   * the centre a whole radius out, which put the bit's edge a full diameter
   * past the panel — 17 mm off the sheet with the defaults — and only the
   * low side was clamped, at the centre, so even there the edge went a radius
   * past X0/Y0.
   *
   * Clamped so the bit's edge stays on the sheet: centre a radius in from
   * X0/Y0, and from the far edges when the sheet's size is known. The bit
   * still faces right up to the sheet edge there, which covers the footprint
   * because the footprint is on the sheet.
   */
  const kerf = compensationRadius(options) > 0 ? options.bitDiameterMm : options.machineMode === 'cnc' ? options.bitDiameterMm / 2 : 0;
  const w = panel.width2D || 0;
  const h = panel.height2D || 0;
  const maxCx = sheet && sheet.widthMm > 0 ? sheet.widthMm - r : Infinity;
  const maxCy = sheet && sheet.heightMm > 0 ? sheet.heightMm - r : Infinity;
  const x0 = Math.max(r, pos.x - kerf);
  const x1 = Math.max(x0, Math.min(maxCx, pos.x + w + kerf));
  const y0 = Math.max(r, pos.y - kerf);
  const y1 = Math.max(y0, Math.min(maxCy, pos.y + h + kerf));
  const marginShort =
    pos.x < r || pos.y < r ||
    (sheet !== undefined && (sheet.widthMm - (pos.x + w) < r || sheet.heightMm - (pos.y + h) < r));

  /*
   * The box is wider than the work wherever the part is not a rectangle: in an
   * L's notch, a centre further than (kerf + radius) from the part faces only
   * stock that is thrown away. Rows are trimmed to the part grown by that
   * much, which leaves a rectangle's box exactly as it was.
   */
  const region = panel.outerPolygon2D.length >= 3
    ? offsetRegion(panel.outerPolygon2D, [], kerf + r).outer.map((l) => l.map((q) => ({ x: q.x + pos.x, y: q.y + pos.y })))
    : [];

  // Only the neighbours the footprint (plus the bit) can reach matter.
  const near = keepClear.filter((poly) => {
    let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
    for (const p of poly) { ax = Math.min(ax, p.x); ay = Math.min(ay, p.y); bx = Math.max(bx, p.x); by = Math.max(by, p.y); }
    return bx > x0 - r && ax < x1 + r && by > y0 - r && ay < y1 + r;
  });
  // A hair inside the radius, so a stretch ending exactly on the limit counts as clear.
  const clearR = r + 1e-3;

  // Rows evenly spaced from edge to edge, none further apart than the
  // stepover: stepping by the stepover itself stopped short of the far edge.
  const rows = Math.max(1, Math.ceil((y1 - y0) / stepover - 1e-9));
  const pitch = (y1 - y0) / rows;
  const rowSpans: { y: number; spans: [number, number][] }[] = [];
  for (let row = 0; row <= rows; row++) {
    const yy = y0 + row * pitch;
    const inside = region.length ? insideRow(x0, x1, yy, region) : [[x0, x1] as [number, number]];
    const spans = near.length ? inside.flatMap(([a, b]) => clipRow(a, b, yy, near, clearR)) : inside;
    rowSpans.push({ y: yy, spans });
  }

  const passes = Math.ceil(removalMm / perPass);
  let distanceMm = 0;
  let lastPoint: Point2D = { x: x0, y: y0 };
  let rx0 = Infinity, rx1 = -Infinity, ry0 = Infinity, ry1 = -Infinity;

  for (let p = 1; p <= passes; p++) {
    const z = -Math.min(removalMm, p * perPass);
    lines.push(`; Facing pass ${p} of ${passes} at Z${f(z)}`);
    let forward = true;
    let at: Point2D | null = null;
    for (const { y: yy, spans } of rowSpans) {
      if (spans.length === 0) continue;
      const ordered = forward ? spans : [...spans].reverse();
      for (const [sa, sb] of ordered) {
        const from = { x: forward ? sa : sb, y: yy };
        const to = { x: forward ? sb : sa, y: yy };
        if (at && (near.length === 0 || segmentClear(at, from, near, clearR))) {
          lines.push(`G1 X${f(from.x)} Y${f(from.y)} F${Math.round(options.cutFeedrate)}`);
          distanceMm += Math.hypot(from.x - at.x, from.y - at.y);
        } else {
          lines.push(`G0 Z${f(options.safeZ)}`);
          lines.push(`G0 X${f(from.x)} Y${f(from.y)}`);
          lines.push(`G1 Z${f(z)} F${Math.round(options.plungeFeedrate)}`);
        }
        lines.push(`G1 X${f(to.x)} Y${f(to.y)} F${Math.round(options.cutFeedrate)}`);
        distanceMm += Math.abs(to.x - from.x);
        at = to;
        rx0 = Math.min(rx0, sa); rx1 = Math.max(rx1, sb); ry0 = Math.min(ry0, yy); ry1 = Math.max(ry1, yy);
      }
      forward = !forward;
    }
    if (at) lastPoint = at;
    lines.push(`G0 Z${f(options.safeZ)}`);
  }

  if (!isFinite(rx0)) { rx0 = x0; rx1 = x1; ry0 = y0; ry1 = y1; }
  return {
    lines,
    distanceMm,
    lastPoint,
    reach: { minX: rx0 - r, minY: ry0 - r, maxX: rx1 + r, maxY: ry1 + r },
    marginShort,
  };
}

/** The bit a facing pass runs on: a configured facing bit, else the job's own. */
function facingBitOf(options: GcodeExportOptions): number {
  const d = options.facingBitDiameterMm;
  return d !== undefined && d > 0 ? d : options.bitDiameterMm;
}

/**
 * The stretches of the row y = `y`, between `x0` and `x1`, where a bit centre
 * stays at least `r` from every polygon (and outside them). Exact: a point is
 * within r of a polygon when it is inside it or within r of one of its edges,
 * and the set of such points on a line is, per edge, a single interval (the
 * line through a capsule), and, for the inside, the even-odd crossings.
 */
function clipRow(x0: number, x1: number, y: number, polys: Point2D[][], r: number): [number, number][] {
  const blocked: [number, number][] = [];
  for (const poly of polys) {
    const n = poly.length;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const iv = capsuleRow(a, b, y, r);
      if (iv) blocked.push(iv);
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) blocked.push([xs[i], xs[i + 1]]);
  }
  blocked.sort((p, q) => p[0] - q[0]);
  const free: [number, number][] = [];
  let cur = x0;
  for (const [a, b] of blocked) {
    if (b <= cur) continue;
    if (a > cur) free.push([cur, Math.min(a, x1)]);
    cur = Math.max(cur, b);
    if (cur >= x1) break;
  }
  if (cur < x1) free.push([cur, x1]);
  return free.filter(([a, b]) => b - a > 1e-6 && a < x1 && b > x0);
}

/** The stretches of the row y = `y`, between `x0` and `x1`, inside any of `loops` (even-odd per loop). */
function insideRow(x0: number, x1: number, y: number, loops: Point2D[][]): [number, number][] {
  const spans: [number, number][] = [];
  for (const loop of loops) {
    const xs: number[] = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(x0, xs[i]), b = Math.min(x1, xs[i + 1]);
      if (b - a > 1e-6) spans.push([a, b]);
    }
  }
  spans.sort((p, q) => p[0] - q[0]);
  // Loops of one offset never overlap, but merge touching stretches all the same.
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  return merged;
}

/** Where the line y = `y` passes within r of segment ab, as an x interval, or null. */
function capsuleRow(a: Point2D, b: Point2D, y: number, r: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (const c of [a, b]) {
    const dy = y - c.y;
    if (Math.abs(dy) <= r) {
      const dx = Math.sqrt(r * r - dy * dy);
      lo = Math.min(lo, c.x - dx); hi = Math.max(hi, c.x + dx);
    }
  }
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len > 1e-12) {
    // The band either side of the segment: a parallelogram, cut by the line.
    const nx = (-(b.y - a.y) / len) * r, ny = ((b.x - a.x) / len) * r;
    const quad = [
      { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
    ];
    for (let i = 0; i < 4; i++) {
      const p = quad[i], q = quad[(i + 1) % 4];
      if ((p.y - y) * (q.y - y) <= 0 && p.y !== q.y) {
        const x = p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y);
        lo = Math.min(lo, x); hi = Math.max(hi, x);
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Whether a bit of radius r moved from p to q stays clear of (and outside) every polygon. */
function segmentClear(p: Point2D, q: Point2D, polys: Point2D[][], r: number): boolean {
  for (const poly of polys) {
    if (pointInLoop2D(p, poly) || pointInLoop2D(q, poly)) return false;
    for (let i = 0; i < poly.length; i++) {
      if (segmentDistance(p, q, poly[i], poly[(i + 1) % poly.length]) < r - 2e-3) return false;
    }
  }
  return true;
}

function segmentDistance(p: Point2D, q: Point2D, a: Point2D, b: Point2D): number {
  const cross = (o: Point2D, u: Point2D, v: Point2D) => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
  const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  const toSeg = (c: Point2D, u: Point2D, v: Point2D) => {
    const dx = v.x - u.x, dy = v.y - u.y;
    const L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((c.x - u.x) * dx + (c.y - u.y) * dy) / L)) : 0;
    return Math.hypot(c.x - u.x - t * dx, c.y - u.y - t * dy);
  };
  return Math.min(toSeg(p, a, b), toSeg(q, a, b), toSeg(a, p, q), toSeg(b, p, q));
}

function pointInLoop2D(pt: Point2D, loop: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Concentric clearing toolpath for one flat-bottom blind pocket in CNC mode,
 * staying inside `pocket.outer` and outside any raised boss islands in
 * `pocket.holes`, stepping down from `fromDepthMm` to `fromDepthMm + pocket.depthMm`
 * (clamped to `options.cutDepthZ` so a blind pocket never cuts into the spoilboard).
 */
function blindPocketLines(
  pocket: BlindPocket2D,
  offset: Point2D,
  fromDepthMm: number,
  options: GcodeExportOptions,
  head: Point2D
): {
  lines: string[];
  distanceMm: number;
  lastPoint: Point2D;
  tooNarrow: boolean;
} {
  const lines: string[] = [];
  if (pocket.outer.length < 3 || !(pocket.depthMm > 1e-6)) {
    return { lines, distanceMm: 0, lastPoint: head, tooNarrow: false };
  }
  const dia = Math.max(0.2, options.bitDiameterMm);
  const radius = compensationRadius(options);
  const step = Math.max(0.2, dia * 0.5);
  const holes = (pocket.holes ?? []).filter((h) => h.length >= 3);

  let loops: Point2D[][];
  let canStepDirect: (a: Point2D, b: Point2D) => boolean;

  if (holes.length === 0) {
    if (radius > 0) {
      loops = offsetRings(pocket.outer, radius, step);
      if (loops.length === 0) {
        return { lines, distanceMm: 0, lastPoint: head, tooNarrow: true };
      }
    } else {
      loops = [orientForClimb(pocket.outer, 'inside'), ...offsetRings(pocket.outer, step, step)];
    }
    const boundary = loops[0];
    canStepDirect = (a, b) => {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist > step * 1.35) return false;
      for (let s = 1; s < 5; s++) {
        const t = s / 5;
        if (!pointInLoop2D({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, boundary)) return false;
      }
      return true;
    };
  } else {
    const raw = [pocket.outer, ...holes];
    const wall = radius > 0
      ? offsetNestedLoops(raw, -radius)
      : {
          paths: raw.map((l, idx) => orientForClimb(l, idx === 0 ? 'inside' : 'outside')),
          dropped: [] as number[],
          depths: nestingDepths(raw),
        };
    if (wall.dropped.includes(0) || wall.paths.length === 0) {
      return { lines, distanceMm: 0, lastPoint: head, tooNarrow: true };
    }
    const cell = Math.min(0.5, Math.max(0.15, dia / 8));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const l of wall.paths) {
      for (const p of l) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    const origin = { x: minX - cell, y: minY - cell };
    const cols = Math.ceil((maxX - minX) / cell) + 3;
    const rows = Math.ceil((maxY - minY) / cell) + 3;
    const mask = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      const y = origin.y + j * cell;
      const xs: number[] = [];
      for (const l of wall.paths) {
        for (let i = 0; i < l.length; i++) {
          const a = l[i], b = l[(i + 1) % l.length];
          if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - origin.x) / cell));
        const i1 = Math.min(cols - 1, Math.floor((xs[k + 1] - origin.x) / cell));
        for (let i = i0; i <= i1; i++) mask[j * cols + i] = 1;
      }
    }
    const interiorRings = clearingRings({ mask, cols, rows, mmPerCell: cell, originMm: origin }, step, dia)
      .slice(1)
      .flatMap((r) => r.loops)
      .map((l) => dropCollinear(l, cell * 0.05))
      .filter((l) => l.length >= 3);
    loops = [...wall.paths, ...interiorRings];
    canStepDirect = (a, b) => {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist > step * 1.35) return false;
      const steps = Math.max(2, Math.ceil(dist / (cell * 0.5)));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const i = Math.round((a.x + (b.x - a.x) * t - origin.x) / cell);
        const j = Math.round((a.y + (b.y - a.y) * t - origin.y) / cell);
        if (i < 0 || i >= cols || j < 0 || j >= rows || mask[j * cols + i] !== 1) return false;
      }
      return true;
    };
  }

  const totalDepth = Math.abs(options.cutDepthZ);
  const startDepth = Math.min(Math.max(0, fromDepthMm), totalDepth);
  const targetDepth = Math.min(totalDepth, startDepth + pocket.depthMm);
  if (targetDepth - startDepth <= 1e-6) {
    return { lines, distanceMm: 0, lastPoint: head, tooNarrow: false };
  }

  const stepdown = Math.max(0.1, Math.abs(options.zStepdown));
  const passes = Math.max(1, Math.ceil((targetDepth - startDepth) / stepdown - 1e-9));
  let distanceMm = 0;
  let lastPoint = head;

  for (let pass = 1; pass <= passes; pass++) {
    const prevFloorZ = -Math.min(targetDepth, startDepth + (pass - 1) * stepdown);
    const currentZ = -Math.min(targetDepth, startDepth + pass * stepdown);
    lines.push(`; Blind pocket pass ${pass}/${passes} (Z = ${f(currentZ)}mm)`);
    let atLocal: Point2D | null = null;
    for (const rawLoop of loops) {
      if (rawLoop.length < 3) continue;
      const refHead = atLocal ? { x: offset.x + atLocal.x, y: offset.y + atLocal.y } : lastPoint;
      const ordered = startNear(rawLoop, refHead, offset);
      const start = ordered[0];
      if (atLocal && canStepDirect && canStepDirect(atLocal, start)) {
        lines.push(`G1 X${f(offset.x + start.x)} Y${f(offset.y + start.y)} F${Math.round(options.cutFeedrate)}`);
        distanceMm += Math.hypot(start.x - atLocal.x, start.y - atLocal.y);
      } else {
        lines.push(`G0 Z${f(options.safeZ)}`);
        lines.push(`G0 X${f(offset.x + start.x)} Y${f(offset.y + start.y)} F${options.travelFeedrate}`);
        if (prevFloorZ < -0.5) lines.push(`G0 Z${f(prevFloorZ + 0.5)}`);
        lines.push(`G1 Z${f(currentZ)} F${Math.round(options.plungeFeedrate)}`);
      }
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const cur = ordered[i];
        lines.push(`G1 X${f(offset.x + cur.x)} Y${f(offset.y + cur.y)} F${Math.round(options.cutFeedrate)}`);
        distanceMm += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      }
      atLocal = ordered[ordered.length - 1];
      lastPoint = { x: offset.x + atLocal.x, y: offset.y + atLocal.y };
    }
    lines.push(`G0 Z${f(options.safeZ)}`);
  }

  return { lines, distanceMm, lastPoint, tooNarrow: false };
}

export function generateLaserCutGcode(
  panels: LaserPanel[],
  userOptions?: Partial<GcodeExportOptions>
): GcodeExportResult {
  const options: GcodeExportOptions = { ...DEFAULT_GCODE_OPTIONS, ...userOptions };
  if (!panels || panels.length === 0) return refusedResult('No panels provided for G-code generation.');

  // Group by the sheet the packer nested each panel on. Placements are already
  // in sheet-local coordinates: every sheet is loaded against the same machine
  // zero, so sheet 3 cuts in the same square of bed that sheet 1 did.
  const sheetMap = new Map<number, LaserPanel[]>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const p of panels) {
    const pos = p.placedPos2D || { x: 0, y: 0 };
    const sheetIdx = p.sheetIndex || 0;
    if (!sheetMap.has(sheetIdx)) sheetMap.set(sheetIdx, []);
    sheetMap.get(sheetIdx)!.push(p);

    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + (p.width2D || 50));
    maxY = Math.max(maxY, pos.y + (p.height2D || 50));
  }

  const sheetIndices = Array.from(sheetMap.keys()).sort((a, b) => a - b);
  const sheetCount = sheetIndices.length;
  const operations: GcodeOperation[] = [];

  const unusable = unusableSetting(
    options,
    sheetIndices.map((k) => options.sheetStockThicknessMm?.[k] ?? options.cutDepthZ)
  );
  if (unusable) return refusedResult(unusable);

  const radius = compensationRadius(options);
  const warnings: string[] = [];
  // Engraving is traced once whatever the pass count, so it is kept apart from
  // the cut length that the passes multiply.
  let engravedMm = 0;
  const skippedEngraving: string[] = [];
  const skippedBlindPockets: string[] = [];

  const lines: string[] = [];
  lines.push(`; --------------------------------------------------`);
  lines.push(`; PhysBox Generated G-Code (${options.machineMode.toUpperCase()} Mode)`);
  lines.push(`; Date: ${new Date().toISOString()}`);
  lines.push(`; Total Sheets: ${sheetCount}, Total Panels: ${panels.length}`);
  if (options.machineMode === 'laser') {
    lines.push(`; Laser: S${laserS(options)} of $30=${Math.round(options.laserMaxPower)} max, ${laserPassCount(options)} pass(es)`);
  }
  if (options.attachmentsEnabled) {
    lines.push(
      `; Attachments: ${f(options.attachmentWidthMm)}mm every ~${f(options.attachmentSpacingMm)}mm` +
        (options.machineMode === 'cnc' ? `, ${f(options.attachmentHeightMm)}mm of stock left under each` : ` (beam off)`)
    );
  }
  if (radius > 0) {
    lines.push(
      `; Cutter comp: paths offset ${f(radius)}mm for a ${f(options.bitDiameterMm)}mm bit` +
        ` — outlines run outside the line, holes inside it`
    );
  }
  lines.push(`; --------------------------------------------------`);
  lines.push(`G21 ; Units in millimeters`);
  lines.push(`G90 ; Absolute positioning`);
  lines.push(`G17 ; XY Plane selection`);

  if (options.machineMode === 'cnc') {
    lines.push(`G0 Z${f(options.safeZ)} ; Raise spindle to safe height`);
    lines.push(`M3 S${Math.round(options.spindleRpm)} ; Spindle ON`);
    lines.push(`G4 P2 ; Wait 2s for spindle to reach full speed`);
  }

  let totalCutDistanceMm = 0;
  let attachmentCount = 0;

  /*
   * Every sheet rests on the same bed and Z0 stays where it was set, on the
   * first sheet's top, so a thicker sheet's top stands above Z0 and a thinner
   * one's below it. Each sheet's program is written from its own top, then
   * raised by that difference. A tool change is touched off on the sheet then
   * on the bed, which moves Z0 there for everything after it.
   */
  const sheetStock = (key: number) =>
    options.machineMode === 'cnc' ? options.sheetStockThicknessMm?.[key] : undefined;
  let zeroStockMm = sheetStock(sheetIndices[0]);
  const shiftOf = (key: number) => {
    const stock = sheetStock(key);
    return stock !== undefined && zeroStockMm !== undefined ? stock - zeroStockMm : 0;
  };
  let zShift = 0;
  let shiftFrom = lines.length;
  const applyShift = () => {
    if (zShift !== 0) {
      for (let i = shiftFrom; i < lines.length; i++) lines[i] = raiseZ(lines[i], zShift);
    }
    shiftFrom = lines.length;
  };

  /*
   * Facing and profiling are two bits when the facing bit is a surfacing
   * cutter, and the operator swaps between them: M6 parks and holds the job
   * (Mesh's streamer lifts and waits), and the new bit is touched off
   * before it goes on. Whichever is needed first is the one fitted at the start.
   */
  const facingBit = facingBitOf(options);
  const twoBits = options.pauseOnToolChange && Math.abs(facingBit - options.bitDiameterMm) > 0.01;
  let fitted: 'facing' | 'profile' | null = null;
  const fit = (bit: 'facing' | 'profile', sIdx: number) => {
    if (fitted !== null && fitted !== bit && twoBits) {
      const dia = bit === 'facing' ? facingBit : options.bitDiameterMm;
      const what = bit === 'facing' ? 'facing bit' : 'end mill for the profiles';
      const toolNumber = bit === 'facing' ? 1 : 2;
      operations.push({ id: `tool_${operations.length}`, name: `Fit the ${f(dia)}mm ${what}`, type: 'pause_tool', sheetIndex: sIdx, toolNumber });
      const travel = f(Math.max(options.safeZ, 20));
      lines.push(``);
      lines.push(`; --- TOOL CHANGE ---`);
      lines.push(`G0 Z${travel}`);
      lines.push(`M5 ; spindle off for the tool change`);
      lines.push(`G0 X0.000 Y0.000 ; park over the work origin`);
      head = { x: 0, y: 0 };
      lines.push(`T${toolNumber} M6 ; fit the ${f(dia)}mm ${what} and re-zero Z`);
      applyShift();
      // The operator has just touched the new bit off on the work.
      zeroStockMm = sheetStock(sheetIndices[sIdx]);
      zShift = 0;
      lines.push(`G0 Z${travel} ; back to travel height after the change`);
      lines.push(`M3 S${Math.round(options.spindleRpm)}`);
      lines.push(`G4 P2`);
    }
    fitted = bit;
  };
  // How far each faced panel's top now is below Z0, so its profile starts there.
  const facedDownMm = new Map<string, number>();
  // Where the head is, in sheet coordinates, for choosing what to cut next.
  let head: Point2D = { x: 0, y: 0 };
  let faceMinX = Infinity, faceMinY = Infinity, faceMaxX = -Infinity, faceMaxY = -Infinity;

  for (let sIdx = 0; sIdx < sheetIndices.length; sIdx++) {
    const sKey = sheetIndices[sIdx];
    const sheetPanels = sheetMap.get(sKey)!;
    applyShift();
    const sheetShift = shiftOf(sKey);

    if (sIdx > 0 && options.pauseBetweenSheets) {
      operations.push({
        id: `pause_sheet_${sIdx + 1}`,
        name: `Insert Material Sheet ${sIdx + 1} of ${sheetCount}`,
        type: 'pause_sheet',
        sheetIndex: sIdx,
      });

      lines.push(``);
      lines.push(`; --- PAUSE: MATERIAL SHEET SWAP ---`);
      if (options.machineMode === 'laser') lines.push(`M5 ; Laser OFF`);
      else {
        // High enough for the sheet coming on as well as the one going off.
        lines.push(`G0 Z${f(options.safeZ + Math.max(zShift, sheetShift))}`);
        lines.push(`M5 ; Spindle OFF`);
      }
      lines.push(`G0 X0.000 Y0.000 ; Park head at origin`);
      head = { x: 0, y: 0 };
      lines.push(`M0 (PAUSE: Insert Material Sheet ${sIdx + 1} of ${sheetCount})`);
      if (options.machineMode === 'cnc') {
        lines.push(`M3 S${Math.round(options.spindleRpm)}`);
        lines.push(`G4 P2`);
      }
      shiftFrom = lines.length;
    }
    zShift = sheetShift;

    lines.push(``);
    lines.push(`; ==================================================`);
    lines.push(`; SHEET ${sIdx + 1} of ${sheetCount}`);
    lines.push(`; ==================================================`);

    // A mixed rack has sheets of different thicknesses, and a router has to go
    // through each one with a stepdown appropriate for that sheet's stock: the
    // scalar cut depth and stepdown are only right for the first row.
    const sheetStockMm = options.sheetStockThicknessMm?.[sKey];
    const sheetStepdownMm = options.sheetZStepdownMm?.[sKey]
      ?? (sheetStockMm !== undefined && userOptions?.zStepdown === undefined
        ? routerStepdownMm(sheetStockMm, options.bitDiameterMm)
        : undefined);
    const sheetOptions: GcodeExportOptions = options.machineMode === 'cnc' && (sheetStockMm !== undefined || sheetStepdownMm !== undefined)
      ? {
          ...options,
          ...(sheetStockMm !== undefined ? { cutDepthZ: sheetStockMm } : {}),
          ...(sheetStepdownMm !== undefined ? { zStepdown: sheetStepdownMm } : {}),
        }
      : options;

    /*
     * Facing first, and for the whole sheet before any profile is cut. A panel
     * whose neighbour has already been cut free is a panel sitting on a sheet
     * that can shift under a surfacing bit taking a full-width cut.
     */
    if (options.machineMode === 'cnc' && options.faceToThickness) {
      const stockMm = options.sheetStockThicknessMm?.[sKey];
      // Below a tenth of a millimetre there is nothing to take off, and sheet
      // goods are not flat enough for the attempt to mean anything.
      const removalOf = (panel: LaserPanel) => {
        const removal = stockMm !== undefined ? stockMm - panel.thickness * 1000 : 0;
        return removal > 0.1 ? removal : 0;
      };
      const placedOuter = (panel: LaserPanel) => {
        const at = panel.placedPos2D || { x: 0, y: 0 };
        return panel.outerPolygon2D.map((p) => ({ x: p.x + at.x, y: p.y + at.y }));
      };
      for (const panel of sheetPanels) {
        const target = panel.thickness * 1000;
        const removal = removalOf(panel);
        if (!(removal > 0)) continue;

        /*
         * The parts the bit must stay off: every other one on the sheet that
         * is not coming down as far. And if the bit cannot reach this part's
         * own profile slot without touching one of them, there is no right way
         * to face it, so the job is refused rather than left with a lip.
         */
        const keepClear = sheetPanels
          .filter((o) => o !== panel && o.outerPolygon2D.length >= 3 && removalOf(o) < removal - 0.01)
          .map((o) => ({ panel: o, poly: placedOuter(o) }));
        if (keepClear.length > 0 && panel.outerPolygon2D.length >= 3) {
          // The slot's far wall is this far out; the bit's centre has to get
          // within a radius of it, which is how close it then comes to them.
          const at = panel.placedPos2D || { x: 0, y: 0 };
          const slotWall = radius > 0 ? 2 * radius : options.bitDiameterMm / 2;
          const reach = Math.max(0, slotWall - facingBit / 2);
          const slot = (reach > 1e-6 ? offsetRegion(panel.outerPolygon2D, [], reach).outer : [panel.outerPolygon2D])
            .map((l) => l.map((p) => ({ x: p.x + at.x, y: p.y + at.y })));
          for (const { panel: other, poly } of keepClear) {
            const hit = slot.some((loop) =>
              loop.some((p, i) => !segmentClear(p, loop[(i + 1) % loop.length], [poly], facingBit / 2)));
            if (hit) {
              return refusedResult(
                `${panel.name} cannot be faced without cutting into ${other.name}: move them at least ` +
                  `${f(Math.max(slotWall, facingBit / 2))} mm apart, or cut them from separate sheets.`
              );
            }
          }
        }

        fit('facing', sIdx);
        facedDownMm.set(panel.id, removal);
        const faced = facingLines(panel, removal, options, f, options.sheetSizeMm?.[sKey], keepClear.map((k) => k.poly));
        faceMinX = Math.min(faceMinX, faced.reach.minX);
        faceMinY = Math.min(faceMinY, faced.reach.minY);
        faceMaxX = Math.max(faceMaxX, faced.reach.maxX);
        faceMaxY = Math.max(faceMaxY, faced.reach.maxY);
        // The bit faces right to the sheet's edge there, which is where the
        // clamps usually are.
        if (faced.marginShort) {
          warnings.push(
            `${panel.name}: sheet margin is narrower than the ${f(facingBit)} mm facing bit radius; facing extends to the sheet edge.`
          );
        }
        operations.push({
          id: `${panel.id}_facing`,
          name: `${panel.name} — face ${f(stockMm!)}mm down to ${f(target)}mm`,
          type: 'facing',
          sheetIndex: sIdx,
        });
        lines.push(``);
        lines.push(`; --- Facing: ${commentText(panel.name)} (${f(removal)}mm off a ${f(stockMm!)}mm sheet) ---`);
        lines.push(...faced.lines);
        totalCutDistanceMm += faced.distanceMm;
        head = faced.lastPoint;
      }
    }

    const cutPanel = (panel: LaserPanel) => {
      const pos = panel.placedPos2D || { x: 0, y: 0 };
      if (options.machineMode === 'cnc') fit('profile', sIdx);
      lines.push(`; --- Panel: ${commentText(panel.name)} ---`);
      const fromDepthMm = facedDownMm.get(panel.id) ?? 0;

      // What the tool actually follows. On a laser that is the geometry itself;
      // on a router it stands half a bit outside the outline and half a bit
      // inside every hole, so that the cut edge lands on the modelled line.
      let outerPaths: Point2D[][] = panel.outerPolygon2D.length >= 3 ? [panel.outerPolygon2D] : [];
      let holePaths: Point2D[][] = panel.innerCutouts2D.filter((c) => c.length >= 3);

      if (radius > 0) {
        const comp = offsetRegion(panel.outerPolygon2D, holePaths, radius);

        for (const i of comp.droppedHoles) {
          const dropped = holePaths[i];
          warnings.push(
            `${panel.name}: a cutout ${f(featureWidth(dropped))}mm across is narrower than the ` +
              `${f(options.bitDiameterMm)}mm cutter and has been left out of the program.`
          );
        }
        outerPaths = comp.outer;
        holePaths = comp.holes;
        if (panel.outerPolygon2D.length >= 3 && outerPaths.length === 0) {
          warnings.push(
            `${panel.name}: the whole panel is narrower than the ${f(options.bitDiameterMm)}mm ` +
              `cutter and cannot be cut.`
          );
        }
      }

      // 0. Engrave the surface pattern before anything is cut, while the panel
      // is still held flat by the sheet round it. A router cannot draw these
      // lines (its patterns are carved; see Relief carve), so it skips them.
      const engraving = (panel.engrave2D ?? []).filter((l) => l.length >= 2);
      if (engraving.length && options.machineMode === 'laser') {
        operations.push({ id: `${panel.id}_engrave`, name: `${panel.name} Pattern`, type: 'engrave', sheetIndex: sIdx });
        lines.push(`; Engrave pattern (${engraving.length} lines)`);
        const s = laserEngraveS(options);
        const chained = chainLines(engraving, head, pos);
        const last = chained[chained.length - 1];
        head = { x: pos.x + last[last.length - 1].x, y: pos.y + last[last.length - 1].y };
        for (const line of chained) {
          lines.push(`G0 X${f(pos.x + line[0].x)} Y${f(pos.y + line[0].y)} F${options.travelFeedrate}`);
          lines.push(`M4 S${s}`);
          for (let i = 1; i < line.length; i++) {
            lines.push(`G1 X${f(pos.x + line[i].x)} Y${f(pos.y + line[i].y)} F${options.engraveFeedrate}`);
            engravedMm += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
          }
          lines.push(`M5`);
        }
      } else if (engraving.length && !skippedEngraving.includes(panel.name)) {
        skippedEngraving.push(panel.name);
      }

      // 0b. Mill flat-bottom blind pockets while the panel is still anchored in the sheet.
      const blindPockets = (panel.blindPockets2D ?? []).filter((bp) => bp.outer.length >= 3 && bp.depthMm > 1e-6);
      if (blindPockets.length > 0) {
        if (options.machineMode === 'cnc') {
          let undersideCount = 0;
          blindPockets.forEach((bp, bpIdx) => {
            if (bp.under) {
              undersideCount++;
              return;
            }
            const pocketed = blindPocketLines(bp, pos, fromDepthMm, sheetOptions, head);
            if (pocketed.tooNarrow) {
              warnings.push(
                `${panel.name}: a blind pocket ${f(featureWidth(bp.outer))}mm across is narrower than the ` +
                  `${f(options.bitDiameterMm)}mm cutter and has been left out of the program.`
              );
              return;
            }
            if (pocketed.lines.length === 0) return;
            operations.push({
              id: `${panel.id}_pocket_${bpIdx}`,
              name: `${panel.name} Blind Pocket #${bpIdx + 1} (${f(bp.depthMm)}mm)`,
              type: 'pocket',
              sheetIndex: sIdx,
            });
            lines.push(`; Blind pocket #${bpIdx + 1} (${f(bp.depthMm)}mm deep)`);
            lines.push(...pocketed.lines);
            totalCutDistanceMm += pocketed.distanceMm;
            head = pocketed.lastPoint;
          });
          if (undersideCount > 0) {
            warnings.push(
              `${panel.name}: ${undersideCount} underside blind pocket(s) require flipping the part for a second-side setup and were left out of this program.`
            );
          }
        } else if (!skippedBlindPockets.includes(panel.name)) {
          skippedBlindPockets.push(panel.name);
        }
      }

      /*
       * Every loop after all the loops inside it, so nothing is freed before
       * its own features are cut: an island standing in a hole goes before
       * the hole, a hole before the outline round it. Nesting depth among the
       * panel's own paths sets the levels, deepest first; nearest-first
       * within a level. A plain panel is its holes, then its outline(s).
       */
      const own: { kind: 'cutout' | 'outer'; idx: number; path: Point2D[] }[] = [
        ...holePaths.map((path, idx) => ({ kind: 'cutout' as const, idx, path })),
        ...outerPaths.map((path, idx) => ({ kind: 'outer' as const, idx, path })),
      ].filter((l) => l.path.length >= 3);
      const depth = nestingDepths(own.map((l) => l.path));
      const levels = [...new Set(depth)].sort((a, b) => b - a);
      for (const level of levels) {
        const group = own.filter((_, i) => depth[i] === level);
        for (const gi of nearestFirst(group.map((l) => l.path), head, pos)) {
          const { kind, idx, path } = group[gi];
          const loop = startNear(path, head, pos);
          head = { x: pos.x + loop[0].x, y: pos.y + loop[0].y };
          if (kind === 'cutout') {
            operations.push({
              id: `${panel.id}_cutout_${idx}`,
              name: `${panel.name} Cutout #${idx + 1}`,
              type: 'cut',
              sheetIndex: sIdx,
            });
            totalCutDistanceMm += polygonPerimeter(loop) * loopPassCount(sheetOptions, fromDepthMm);
            lines.push(...generateLoopGcode(loop, pos, sheetOptions, [], fromDepthMm));
          } else {
            operations.push({
              id: outerPaths.length > 1 ? `${panel.id}_outer_${idx}` : `${panel.id}_outer`,
              name: outerPaths.length > 1
                ? `${panel.name} Outline (part ${idx + 1} of ${outerPaths.length})`
                : `${panel.name} Outline`,
              type: 'cut',
              sheetIndex: sIdx,
            });
            // Only the outline gets attachments: it is the cut that frees the panel,
            // and a bridge left across a mortise would block the tab meant to enter it.
            const spans = planAttachments(polygonPerimeter(loop), options);
            attachmentCount += spans.length;
            totalCutDistanceMm += polygonPerimeter(loop) * loopPassCount(sheetOptions, fromDepthMm);
            lines.push(...generateLoopGcode(loop, pos, sheetOptions, spans, fromDepthMm));
          }
        }
      }
    };

    /*
     * Parts nest in each other's cutouts (a small part packed into a big
     * one's window, another in its hole): each must be cut out whole before
     * the cutout round it frees the slug it stands on. So a part's nested
     * parts are cut first, nearest first, recursively; parts that do not
     * nest keep the order they came in, exactly as before.
     */
    const placedLoop = (panel: LaserPanel, loop: Point2D[]) => {
      const at = panel.placedPos2D || { x: 0, y: 0 };
      return loop.map((q) => ({ x: q.x + at.x, y: q.y + at.y }));
    };
    const holesOnSheet = new Map(sheetPanels.map((pnl) => [
      pnl, pnl.innerCutouts2D.filter((c) => c.length >= 3).map((c) => placedLoop(pnl, c)),
    ]));
    const nestedIn = (outer: LaserPanel) => sheetPanels.filter((inner) => {
      if (inner === outer || inner.outerPolygon2D.length < 3) return false;
      const probe = placedLoop(inner, [inner.outerPolygon2D[0]])[0];
      return holesOnSheet.get(outer)!.some((hole) => pointInLoop2D(probe, hole));
    });
    const state = new Map<LaserPanel, 'visiting' | 'done'>();
    const visit = (panel: LaserPanel) => {
      if (state.has(panel)) return;
      state.set(panel, 'visiting');
      const inner = nestedIn(panel).filter((q) => !state.has(q));
      if (inner.length) {
        for (const qi of nearestFirst(inner.map((q) => placedLoop(q, q.outerPolygon2D)), head, { x: 0, y: 0 })) visit(inner[qi]);
      }
      cutPanel(panel);
      state.set(panel, 'done');
    };
    for (const panel of sheetPanels) visit(panel);
  }

  // Program End
  lines.push(``);
  lines.push(`; --- PROGRAM END ---`);
  if (options.machineMode === 'laser') {
    lines.push(`M5 ; Laser OFF`);
    lines.push(`G0 X0.000 Y0.000 F${options.travelFeedrate} ; Rapid to origin`);
  } else {
    lines.push(`G0 Z${f(options.safeZ)} ; Retract Z`);
    lines.push(`M5 ; Spindle OFF`);
    lines.push(`G0 X0.000 Y0.000 F${options.travelFeedrate} ; Park X/Y`);
  }
  lines.push(`M30 ; End of program`);
  applyShift();

  // Every laser pass retraces the whole path, so the head really does travel that far.
  totalCutDistanceMm *= laserPassCount(options);
  totalCutDistanceMm += engravedMm;
  if (skippedEngraving.length) {
    warnings.push(
      `${skippedEngraving.join(', ')}: the surface pattern is laser engraving, so a router leaves it out. ` +
        `Carve it with Relief carve instead.`
    );
  }
  if (skippedBlindPockets.length) {
    warnings.push(
      `${skippedBlindPockets.join(', ')}: blind pockets require CNC routing (or raster fill in Etch) and are left out of laser through-cut G-code.`
    );
  }

  if (!operations.some((op) => op.type === 'cut' || op.type === 'engrave' || op.type === 'pocket')) {
    return refusedResult(warnings[0] ?? 'Nothing here for the machine to cut.');
  }

  const gcodeText = tidyModal(lines).join('\n');
  // Planned the way the controller plans it — accelerate, cruise, brake — not
  // as cut length over feedrate. On a sheet of small parts the head spends most
  // of its time getting up to speed and slowing down again for the next corner,
  // and the old arithmetic could not see that at all.
  const estimatedTimeSeconds = Math.round(
    estimateGcodeTime(gcodeText, { profile: options.motionProfile ?? DEFAULT_MOTION_PROFILE }).seconds
  );

  return {
    success: true,
    gcode: gcodeText,
    totalCutDistanceMm: Math.round(totalCutDistanceMm),
    estimatedTimeSeconds,
    sheetCount,
    operations,
    // The tool runs a radius outside the outermost outline, so that is what the
    // job really occupies — which is what the framing trace and the travel
    // check downstream both need to know.
    bounds: withZRange({
      minX: Math.min(minX - radius, faceMinX),
      minY: Math.min(minY - radius, faceMinY),
      maxX: Math.max(maxX + radius, faceMaxX),
      maxY: Math.max(maxY + radius, faceMaxY),
    }, gcodeText),
    attachmentCount,
    compensationMm: radius,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Helper to generate G-code motion lines for a single closed loop.
 *
 * `spans` are the attachments to leave behind, empty for a loop that should be
 * cut clean through. Callers pass them only for loops that free a part — a
 * mortise slug is small enough to be harmless, and a bridge across one would
 * stop its tab entering.
 */
/**
 * A closed loop restarted at the point on it nearest the head, so the head
 * does not cross the part to reach a start chosen by array order. The start
 * is kept off the corners, because a pierce or plunge dwells there twice —
 * once going in and again where the loop closes — and on a corner that is a
 * burn or a gouge in the part's edge rather than along a straight one.
 */
function startNear(loop: Point2D[], head: Point2D, offset: Point2D): Point2D[] {
  if (loop.length < 3) return loop;
  const hx = head.x - offset.x;
  const hy = head.y - offset.y;
  let best = { d: Infinity, i: 0, p: loop[0] };
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    // Clear of either end by 2 mm, or the middle of an edge shorter than that.
    const margin = Math.min(2, len / 2) / len;
    const t = ((hx - a.x) * (b.x - a.x) + (hy - a.y) * (b.y - a.y)) / (len * len);
    const tc = Math.min(1 - margin, Math.max(margin, t));
    const p = { x: a.x + (b.x - a.x) * tc, y: a.y + (b.y - a.y) * tc };
    const d = Math.hypot(p.x - hx, p.y - hy);
    if (d < best.d - 1e-9) best = { d, i, p };
  }
  const n = loop.length;
  const out = [best.p];
  for (let k = 1; k <= n; k++) out.push(loop[(best.i + k) % n]);
  return out;
}

/** Indices of `items` in greedy nearest-first order from `head`. */
function nearestFirst(items: Point2D[][], head: Point2D, offset: Point2D): number[] {
  const left = items.map((_, i) => i);
  const order: number[] = [];
  let at = head;
  while (left.length) {
    let bestK = 0, bestD = Infinity;
    left.forEach((i, k) => {
      for (const p of items[i]) {
        const d = Math.hypot(p.x + offset.x - at.x, p.y + offset.y - at.y);
        if (d < bestD) { bestD = d; bestK = k; }
      }
    });
    const [i] = left.splice(bestK, 1);
    order.push(i);
    // A closed loop ends where it starts, near the point it was reached at.
    const nearest = items[i].reduce((q, p) =>
      Math.hypot(p.x + offset.x - at.x, p.y + offset.y - at.y) < Math.hypot(q.x + offset.x - at.x, q.y + offset.y - at.y) ? p : q);
    at = { x: nearest.x + offset.x, y: nearest.y + offset.y };
  }
  return order;
}

/**
 * Open polylines chained greedily: each next is the one with an end nearest
 * the head, run from that end. Pattern outlines come out of the contourer in
 * grid order, and the head used to fly the length of the panel between two
 * lines that touch.
 */
function chainLines(lines: Point2D[][], head: Point2D, offset: Point2D): Point2D[][] {
  const left = lines.slice();
  const out: Point2D[][] = [];
  let at = head;
  while (left.length) {
    let bestK = 0, bestD = Infinity, flip = false;
    left.forEach((l, k) => {
      const a = l[0], b = l[l.length - 1];
      const da = Math.hypot(a.x + offset.x - at.x, a.y + offset.y - at.y);
      const db = Math.hypot(b.x + offset.x - at.x, b.y + offset.y - at.y);
      if (da < bestD) { bestD = da; bestK = k; flip = false; }
      if (db < bestD) { bestD = db; bestK = k; flip = true; }
    });
    const [l] = left.splice(bestK, 1);
    const run = flip ? l.slice().reverse() : l;
    out.push(run);
    const end = run[run.length - 1];
    at = { x: end.x + offset.x, y: end.y + offset.y };
  }
  return out;
}

/** How many depth passes `generateLoopGcode` makes around one loop. */
function loopPassCount(options: GcodeExportOptions, fromDepthMm = 0): number {
  if (options.machineMode === 'laser') return 1; // the caller multiplies laser passes in once, for everything
  const totalDepth = Math.abs(options.cutDepthZ);
  const stepdown = Math.max(0.1, Math.abs(options.zStepdown));
  const from = Math.min(Math.max(0, fromDepthMm), totalDepth);
  return Math.max(1, Math.ceil((totalDepth - from) / stepdown - 1e-9));
}

/**
 * Modal tidying, applied to a finished program. The feed is modal, so it is
 * sent only when it changes: on every vertex it was a quarter of the bytes
 * going down a 128-byte serial buffer, which is lookahead the planner loses
 * on a dense curve. A rapid carries no F at all (on GRBL it would set the
 * cutting feed). A lift to the height the tool is already at is dropped,
 * except after a pause, where the operator may have moved it.
 */
function tidyModal(lines: string[]): string[] {
  const out: string[] = [];
  let feed: string | null = null;
  let z: string | null = null;
  for (const line of lines) {
    const cut = line.search(/[;(]/);
    let code = cut >= 0 ? line.slice(0, cut) : line;
    const rest = cut >= 0 ? line.slice(cut) : '';
    if (/^\s*M(0|1|2|6|30)\b|\bM6\b/.test(code)) z = null;
    if (/^G0\b/.test(code)) {
      code = code.replace(/\s*F-?[\d.]+/, '');
      const only = /^G0 Z(-?[\d.]+)\s*$/.exec(code);
      if (only && only[1] === z) continue;
    } else if (/^G[123]\b/.test(code)) {
      const m = /\s*F(-?[\d.]+)/.exec(code);
      if (m) {
        if (m[1] === feed) code = code.replace(m[0], '');
        else feed = m[1];
      }
    }
    const zw = /^G[0123]\b.*Z(-?[\d.]+)/.exec(code);
    if (zw) z = zw[1];
    out.push(rest ? `${code.trimEnd()} ${rest}`.replace(/^ /, '') : code.trimEnd());
  }
  return out;
}

function generateLoopGcode(
  loop: Point2D[],
  offset: Point2D,
  options: GcodeExportOptions,
  spans: AttachmentSpan[] = [],
  /** Where the stock's top already is, mm below Z0: a faced sheet starts there. */
  fromDepthMm = 0
): string[] {
  const lines: string[] = [];
  if (loop.length < 3) return lines;

  const startX = offset.x + loop[0].x;
  const startY = offset.y + loop[0].y;
  const path = resampleLoop(loop, spans);

  if (options.machineMode === 'laser') {
    // Laser Mode: G0 to start, M4 S<power>, G1 around loop (once per pass), M5.
    // M4 is GRBL's dynamic power: the beam scales with the head's speed, so it
    // does not dwell at full power while the planner slows into a corner. The
    // beam stays on between passes — the path is closed, so it ends where the
    // next pass begins and there is nothing to re-pierce.
    //
    // An attachment is just the beam going out for its length, by S0 on the
    // move itself. M5/M3 there would stop the head dead either side of every
    // tab (laser mode syncs the planner on them) and scorch both ends. The head
    // keeps moving at the cut feedrate, so the gap really is the length asked
    // for and the beam comes back on already up to speed.
    const passes = laserPassCount(options);
    const power = laserS(options);
    lines.push(`G0 X${f(startX)} Y${f(startY)} F${options.travelFeedrate}`);
    lines.push(`M4 S${power}`);
    let beamOn = true;
    for (let pass = 1; pass <= passes; pass++) {
      if (passes > 1) lines.push(`; Pass ${pass}/${passes}`);
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        // A segment is entirely inside or entirely outside an attachment, so its
        // midpoint decides — the resample already split it at every boundary.
        const gap = spans.length > 0 && inFlat((path[i - 1].s + p.s) / 2, spans);
        const move = `G1 X${f(offset.x + p.x)} Y${f(offset.y + p.y)} F${options.cutFeedrate}`;
        if (gap === beamOn) {
          beamOn = !gap;
          lines.push(gap ? `${move} S0 ; attachment` : `${move} S${power}`);
        } else {
          lines.push(move);
        }
      }
    }
    lines.push(`M5`);
  } else {
    // CNC Mode: Multi-pass depth slicing
    const totalDepth = Math.abs(options.cutDepthZ);
    const stepdown = Math.max(0.1, Math.abs(options.zStepdown));
    const from = Math.min(Math.max(0, fromDepthMm), totalDepth);
    const passes = Math.max(1, Math.ceil((totalDepth - from) / stepdown - 1e-9));
    // The attachment's top surface, measured up from the bottom of the stock. Clamped below the stock surface so a height
    // set at or above the cut depth cannot turn the whole outline into a no-op.
    const attachTopZ = -Math.max(0.1, totalDepth - Math.max(0, options.attachmentHeightMm));

    lines.push(`G0 Z${f(options.safeZ)}`);
    lines.push(`G0 X${f(startX)} Y${f(startY)} F${options.travelFeedrate}`);

    for (let pass = 1; pass <= passes; pass++) {
      const currentZ = pass === passes
        ? -(totalDepth + SHEET_THROUGH_CUT_MM)
        : -Math.min(totalDepth, from + pass * stepdown);
      lines.push(`; Pass ${pass}/${passes} (Z = ${f(currentZ)}mm)`);
      lines.push(`G1 Z${f(currentZ)} F${options.plungeFeedrate}`);

      // Only passes that reach below the attachment tops have to ride over them;
      // shallower ones are still cutting stock the attachment keeps anyway.
      const riding = spans.length > 0 && currentZ < attachTopZ - 1e-6;
      let prevZ = currentZ;
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        const px = f(offset.x + p.x);
        const py = f(offset.y + p.y);
        if (riding) {
          const z = attachmentZ(p.s, spans, currentZ, attachTopZ);
          const ds = Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y, z - prevZ);
          const dz = prevZ - z;
          const feed = dz > 1e-6
            ? Math.min(options.cutFeedrate, Math.max(1, Math.round(options.plungeFeedrate * (ds / dz))))
            : options.cutFeedrate;
          lines.push(`G1 X${px} Y${py} Z${f(z)} F${feed}`);
          prevZ = z;
        } else {
          lines.push(`G1 X${px} Y${py} F${options.cutFeedrate}`);
        }
      }
    }
    lines.push(`G0 Z${f(options.safeZ)}`);
  }

  return lines;
}

/** Generates low-power laser framing G-code trace around a bounding box. */
function formatNum(val: number): string { return val.toFixed(3); }

export function generateFramingGcode(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  userOptions?: Partial<GcodeExportOptions>
): string {
  const options: GcodeExportOptions = { ...DEFAULT_GCODE_OPTIONS, ...userOptions };
  const { minX, minY, maxX, maxY } = bounds;

  const lines: string[] = [
    `; --- LASER FRAMING / GUIDE TRACE ---`,
    `G21 ; mm`,
    `G90 ; absolute`,
  ];
  // A router has usually just been zeroed on the stock: lift before crossing it.
  if (options.machineMode !== 'laser') lines.push(`G0 Z${formatNum(options.safeZ)}`);
  lines.push(`G0 X${formatNum(minX)} Y${formatNum(minY)}`);

  if (options.machineMode === 'laser') {
    lines.push(`M3 S${laserGuideS(options)} ; Low power guide dot`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(minY)} F3000`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(minY)} F3000`);
    lines.push(`M5 S0 ; Laser OFF`);
  } else {
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(minY)} F3000`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(minY)} F3000`);
  }

  return lines.join('\n');
}

/** Generates G-code for Contour Slices (stacked relief map layers). */
/** A closed loop without the points that lie on the line through their neighbours. */
function dropCollinear(loop: Point2D[], tolMm: number): Point2D[] {
  const out: Point2D[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = out.length ? out[out.length - 1] : loop[loop.length - 1];
    const p = loop[i], b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const off = len > 1e-9 ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len : 0;
    if (off > tolMm) out.push(p);
  }
  return out;
}

/**
 * Faces a contour layer down by `removalMm` with the profile bit, before its
 * profile is cut.
 *
 * Only where the profile bit will go, not the layer's whole footprint: the
 * tool centres cover the region inside the compensated cut paths, which takes
 * the face out to a bit's width past the part all round, so the profile's
 * flutes never meet the unfaced sheet above them. A flask wall's hole drops
 * out as a slug, and facing it was most of four extra hours.
 *
 * Concentric rings outermost first (adaptiveClearing), at half the bit's
 * width apart so that no strip is left between the last ring and the middle.
 */
function faceLayerLines(
  cutPaths: Point2D[][],
  offset: Point2D,
  removalMm: number,
  options: GcodeExportOptions
): { lines: string[]; distanceMm: number; lastPoint?: Point2D } {
  const lines: string[] = [];
  const dia = Math.max(0.5, options.bitDiameterMm);
  const paths0 = cutPaths.filter((l) => l.length >= 3);
  if (paths0.length === 0) return { lines, distanceMm: 0 };
  // If cutter compensation was turned off, `cutPaths` are the raw geometry;
  // expand by half the bit so the facing pass still clears the profile kerf.
  const paths = compensationRadius(options) > 0 ? paths0 : offsetNestedLoops(paths0, dia / 2).paths;
  if (paths.length === 0) return { lines, distanceMm: 0 };

  // The region the tool centre may cover, on a grid fine enough for the bit.
  const cell = Math.min(1, Math.max(0.2, dia / 8));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of paths) for (const p of l) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const origin = { x: minX - cell, y: minY - cell };
  const cols = Math.ceil((maxX - minX) / cell) + 3;
  const rows = Math.ceil((maxY - minY) / cell) + 3;
  const mask = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    // Even-odd scanline: the paths nest, so a hole's crossings close the span.
    const y = origin.y + j * cell;
    const xs: number[] = [];
    for (const l of paths) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i], b = l[(i + 1) % l.length];
        if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - origin.x) / cell));
      const i1 = Math.min(cols - 1, Math.floor((xs[k + 1] - origin.x) / cell));
      for (let i = i0; i <= i1; i++) mask[j * cols + i] = 1;
    }
  }
  const rings = clearingRings({ mask, cols, rows, mmPerCell: cell, originMm: origin }, dia * 0.5, dia);
  // Marching squares puts a point in every cell, straight walls included.
  const loops = rings.flatMap((r) => r.loops).map((l) => dropCollinear(l, cell * 0.05)).filter((l) => l.length >= 3);
  if (loops.length === 0) return { lines, distanceMm: 0 };

  // Whether the straight segment between two rings stays inside `mask === 1`
  // (and never cuts across an unfaced hole or island gap).
  const segmentInMask = (a: Point2D, b: Point2D): boolean => {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.ceil(dist / (cell * 0.5)));
    for (let s = 1; s < steps; s++) {
      const t = 0.15 + 0.7 * (s / steps);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const i = Math.round((x - origin.x) / cell);
      const j = Math.round((y - origin.y) / cell);
      if (i < 0 || i >= cols || j < 0 || j >= rows || mask[j * cols + i] !== 1) return false;
    }
    return true;
  };

  const perPass = Math.max(0.1, Math.abs(options.zStepdown));
  const passes = Math.ceil(removalMm / perPass - 1e-9);
  const X = (p: Point2D) => f(offset.x + p.x);
  const Y = (p: Point2D) => f(offset.y + p.y);
  let distanceMm = 0;
  let lastPoint: Point2D | undefined;

  for (let pass = 1; pass <= passes; pass++) {
    const above = -Math.min(removalMm, (pass - 1) * perPass);
    const z = -Math.min(removalMm, pass * perPass);
    lines.push(`; Facing pass ${pass} of ${passes} at Z${f(z)}`);
    let at: Point2D | null = null;
    for (const loop of loops) {
      // Start each ring at its point nearest the tool.
      let s0 = 0;
      if (at) {
        let best = Infinity;
        loop.forEach((p, i) => {
          const d = Math.hypot(p.x - at!.x, p.y - at!.y);
          if (d < best) { best = d; s0 = i; }
        });
      }
      const start = loop[s0];
      const hop = at ? Math.hypot(start.x - at.x, start.y - at.y) : Infinity;
      if (at && hop <= dia && segmentInMask(at, start)) {
        // The next ring in, a stepover away across ground this pass just cut.
        lines.push(`G1 X${X(start)} Y${Y(start)} F${Math.round(options.cutFeedrate)}`);
        distanceMm += hop;
      } else {
        // Anywhere else may be across a hole's slug, still at full height: go
        // over it, then drop to the floor the last pass left and feed in.
        lines.push(`G0 Z${f(options.safeZ)}`);
        lines.push(`G0 X${X(start)} Y${Y(start)}`);
        if (above < 0) lines.push(`G0 Z${f(above + 0.5)}`);
        lines.push(`G1 Z${f(z)} F${Math.round(options.plungeFeedrate)}`);
      }
      for (let k = 1; k <= loop.length; k++) {
        const p = loop[(s0 + k) % loop.length];
        const q = loop[(s0 + k - 1) % loop.length];
        lines.push(`G1 X${X(p)} Y${Y(p)} F${Math.round(options.cutFeedrate)}`);
        distanceMm += Math.hypot(p.x - q.x, p.y - q.y);
      }
      at = start;
      lastPoint = { x: offset.x + start.x, y: offset.y + start.y };
    }
  }
  lines.push(`G0 Z${f(options.safeZ)}`);
  return { lines, distanceMm, lastPoint };
}

export function generateContourSliceGcode(
  result: ContourSliceResult,
  userOptions?: Partial<GcodeExportOptions>
): GcodeExportResult {
  const options: GcodeExportOptions = { ...DEFAULT_GCODE_OPTIONS, ...userOptions };
  if (!result || !result.success || !result.layers) return refusedResult('Invalid contour slice result provided.');
  const unusable = unusableSetting(options, [options.cutDepthZ]);
  if (unusable) return refusedResult(unusable);

  const layers = result.layers;
  const sheetCount = result.sheetCount || layers.length;
  const operations: GcodeOperation[] = [];
  const radius = compensationRadius(options);

  const lines: string[] = [];
  lines.push(`; --------------------------------------------------`);
  lines.push(`; PhysBox Contour Slice Stack G-Code (${options.machineMode.toUpperCase()})`);
  lines.push(`; Layers: ${layers.length}`);
  if (options.machineMode === 'laser') {
    lines.push(`; Laser: S${laserS(options)} of $30=${Math.round(options.laserMaxPower)} max, ${laserPassCount(options)} pass(es)`);
  }
  if (options.attachmentsEnabled) {
    lines.push(
      `; Attachments: ${f(options.attachmentWidthMm)}mm every ~${f(options.attachmentSpacingMm)}mm` +
        (options.machineMode === 'cnc' ? `, ${f(options.attachmentHeightMm)}mm of stock left under each` : ` (beam off)`)
    );
  }
  if (radius > 0) {
    lines.push(
      `; Cutter comp: paths offset ${f(radius)}mm for a ${f(options.bitDiameterMm)}mm bit`
    );
  }
  lines.push(`; --------------------------------------------------`);
  lines.push(`G21 ; mm`);
  lines.push(`G90 ; absolute`);
  lines.push(`G17 ; XY plane`);

  if (options.machineMode === 'cnc') {
    lines.push(`G0 Z${f(options.safeZ)}`);
    lines.push(`M3 S${Math.round(options.spindleRpm)}`);
    lines.push(`G4 P2`);
  }

  let totalCutDistanceMm = 0;
  let attachmentCount = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const warnings: string[] = [];

  // Layers are nested several to a sheet, so the operator swaps material when
  // the sheet changes, not at every layer. An older result without sheets
  // falls back to one layer per sheet.
  const sheetOf = (lIdx: number) => layers[lIdx].sheetIndex ?? lIdx;
  // Where the head is, in sheet coordinates, for choosing what to cut next.
  let head: Point2D = { x: 0, y: 0 };
  for (let lIdx = 0; lIdx < layers.length; lIdx++) {
    const layer = layers[lIdx];
    const loops = layer.loops || [];
    const sheet = sheetOf(lIdx);

    if (lIdx > 0 && sheet !== sheetOf(lIdx - 1) && options.pauseBetweenSheets) {
      operations.push({
        id: `pause_sheet_${sheet + 1}`,
        name: `Insert Sheet ${sheet + 1} of ${sheetCount}`,
        type: 'pause_sheet',
        sheetIndex: sheet,
      });

      lines.push(``);
      lines.push(`; --- PAUSE: SHEET SWAP ---`);
      if (options.machineMode === 'laser') lines.push(`M5`);
      else {
        lines.push(`G0 Z${f(options.safeZ)}`);
        lines.push(`M5`);
      }
      lines.push(`G0 X0.000 Y0.000`);
      head = { x: 0, y: 0 };
      lines.push(`M0 (PAUSE: Insert Sheet ${sheet + 1} of ${sheetCount})`);
      if (options.machineMode === 'cnc') {
        lines.push(`M3 S${Math.round(options.spindleRpm)}`);
        lines.push(`G4 P2`);
      }
    }

    const rawLoops = loops.filter((l) => l.length >= 3);
    if (rawLoops.length === 0) continue;

    lines.push(``);
    lines.push(`; ==================================================`);
    lines.push(`; CONTOUR LAYER ${lIdx + 1} of ${layers.length} on sheet ${sheet + 1} (Z = ${f(layer.z * 1000)}mm)`);
    lines.push(`; ==================================================`);

    // On a router the tool has to stand off each contour by its own radius, and
    // which side to stand off on depends on whether the contour bounds material
    // or a void — which is what the nesting says. Circular dowel / bolt holes
    // whose diameter matches or slightly exceeds the bit are bored analytically
    // (peck plunge when holeDia ≈ bitDia, true circle orbit when holeDia > bitDia)
    // so polygonal apothem shrinkage never drops valid alignment holes.
    const rawDepths = nestingDepths(rawLoops);
    const plungeBores: { cx: number; cy: number; depth: number }[] = [];
    let cutPaths: Point2D[][];
    let depths: number[];

    if (radius > 0) {
      const bitDia = options.bitDiameterMm;
      const polyLoops: Point2D[][] = [];
      const circleBores: { loop: Point2D[]; depth: number }[] = [];

      for (let i = 0; i < rawLoops.length; i++) {
        const d = rawDepths[i];
        const isLeafHole =
          d % 2 === 1 &&
          !rawLoops.some((other, j) => rawDepths[j] === d + 1 && contourPointInPolygon(other[0], rawLoops[i]));
        const circle = isLeafHole ? contourDetectCircularHole(rawLoops[i]) : null;

        if (circle && circle.radiusMm <= radius * 3) {
          const holeDia = circle.radiusMm * 2;
          if (holeDia < bitDia - 1e-3) {
            warnings.push(
              `Layer ${lIdx + 1}: circular hole ⌀${f(holeDia)}mm is smaller than the ` +
                `${f(bitDia)}mm cutter and has been left out of the program ` +
                `(fit a ≤${f(holeDia)}mm bit or set Dowel ⌀ ≥ ${f(bitDia)}mm).`
            );
          } else if (circle.radiusMm - radius <= 0.005) {
            plungeBores.push({ cx: circle.cx, cy: circle.cy, depth: d });
          } else {
            circleBores.push({
              loop: contourClimbCircle(circle.cx, circle.cy, circle.radiusMm - radius, 32),
              depth: d,
            });
          }
        } else {
          polyLoops.push(rawLoops[i]);
        }
      }

      const comp = offsetNestedLoops(polyLoops, radius);
      for (const i of comp.dropped) {
        warnings.push(
          `Layer ${lIdx + 1}: a contour ${f(featureWidth(polyLoops[i]))}mm across is smaller than ` +
            `the ${f(options.bitDiameterMm)}mm cutter and has been left out of the program.`
        );
      }
      cutPaths = [...comp.paths, ...circleBores.map((c) => c.loop)];
      depths = [...comp.depths, ...circleBores.map((c) => c.depth)];
    } else {
      cutPaths = rawLoops;
      depths = rawDepths;
    }

    const rawBounds = contourLoopsBounds(rawLoops);
    const lminX = layer.modelOffset2D ? layer.modelOffset2D.x : rawBounds.minX;
    const lminY =
      layer.modelOffset2D && layer.height2D !== undefined
        ? layer.modelOffset2D.y - layer.height2D
        : rawBounds.minY;
    const offset: Point2D = layer.placedPos2D
      ? { x: layer.placedPos2D.x - lminX, y: layer.placedPos2D.y - lminY }
      : { x: 0, y: 0 };

    // Guard against negative X / Y machine coordinates when cutter compensation
    // or tight margins push a placed (or first-quadrant) layer past work origin.
    if (layer.placedPos2D || (rawBounds.minX >= -1e-6 && rawBounds.minY >= -1e-6)) {
      let reachMinX = Infinity;
      let reachMinY = Infinity;
      for (const path of cutPaths) {
        for (const pt of path) {
          reachMinX = Math.min(reachMinX, offset.x + pt.x);
          reachMinY = Math.min(reachMinY, offset.y + pt.y);
        }
      }
      for (const b of plungeBores) {
        reachMinX = Math.min(reachMinX, offset.x + b.cx);
        reachMinY = Math.min(reachMinY, offset.y + b.cy);
      }
      if (isFinite(reachMinX) && (reachMinX < 0 || reachMinY < 0)) {
        const shiftX = reachMinX < 0 ? -reachMinX : 0;
        const shiftY = reachMinY < 0 ? -reachMinY : 0;
        offset.x += shiftX;
        offset.y += shiftY;
        if (shiftX > 1e-3 || shiftY > 1e-3) {
          warnings.push(
            `Layer ${lIdx + 1}: shifted toolpath by (${f(shiftX)}, ${f(shiftY)})mm so all moves stay at X >= 0, Y >= 0.`
          );
        }
      }
    } else if (rawBounds.minX < -1e-6 || rawBounds.minY < -1e-6) {
      warnings.push(
        `Layer ${lIdx + 1}: unplaced contour extends into negative coordinates (X${f(rawBounds.minX)}, Y${f(rawBounds.minY)}); zero work origin at model centre.`
      );
    }

    /*
     * The top layer of a stack that is not a whole number of sheets finishes
     * thinner than one. A router takes it there itself: a full sheet goes on,
     * the layer's footprint is faced down to the model's top with the bit
     * already in the spindle, and the profile is cut from that face on down.
     * A laser cannot, and the slice's warning says to use thinner stock.
     */
    const sheetMm = Math.abs(options.cutDepthZ);
    const removal =
      options.machineMode === 'cnc' &&
      layer.facedToMm !== undefined &&
      layer.facedToMm > 0 &&
      layer.facedToMm < sheetMm
        ? sheetMm - layer.facedToMm
        : 0;
    if (removal > 0.1) {
      operations.push({
        id: `layer_${lIdx + 1}_facing`,
        name: `Layer ${lIdx + 1} — face ${f(sheetMm)}mm down to ${f(layer.facedToMm!)}mm`,
        type: 'facing',
        sheetIndex: sheet,
      });
      lines.push(`; --- Facing: ${f(removal)}mm off a ${f(sheetMm)}mm sheet, to ${f(layer.facedToMm!)}mm ---`);
      const faced = faceLayerLines(cutPaths, offset, removal, options);
      for (const line of faced.lines) lines.push(line);
      totalCutDistanceMm += faced.distanceMm;
      if (faced.lastPoint) head = faced.lastPoint;
    }
    const fromDepthMm = removal > 0.1 ? removal : 0;

    if (options.machineMode === 'cnc' && !options.attachmentsEnabled && depths.some((d) => d >= 2)) {
      warnings.push(
        `Layer ${lIdx + 1}: nested concentric islands cut on a CNC router without Attachments enabled may break loose into the cutter.`
      );
    }

    // Innermost first: nested islands (depth >= 2) and inner bores are cut and
    // tabbed while the surrounding ring is still anchored, then enclosing holes
    // (depth = 1), and finally the outer boundary (depth = 0).
    const levels = [...new Set([...depths, ...plungeBores.map((b) => b.depth)])].sort((a, b) => b - a);
    let cCounter = 0;
    let bCounter = 0;

    for (const level of levels) {
      const levelBores = plungeBores.filter((b) => b.depth === level);
      if (levelBores.length > 0) {
        const borePts = levelBores.map((b) => [{ x: b.cx, y: b.cy }]);
        for (const bi of nearestFirst(borePts, head, offset)) {
          const bore = levelBores[bi];
          const px = offset.x + bore.cx;
          const py = offset.y + bore.cy;
          head = { x: px, y: py };
          minX = Math.min(minX, px);
          minY = Math.min(minY, py);
          maxX = Math.max(maxX, px);
          maxY = Math.max(maxY, py);

          operations.push({
            id: `layer_${lIdx + 1}_bore_${bCounter}`,
            name: `Layer ${lIdx + 1} Pin Bore #${bCounter + 1}`,
            type: 'cut',
            sheetIndex: sheet,
          });
          bCounter++;

          const drilled = contourPlungeBoreGcode(px, py, options, fromDepthMm);
          totalCutDistanceMm += drilled.distanceMm;
          lines.push(...drilled.lines);
        }
      }

      const groupIndices: number[] = [];
      for (let i = 0; i < cutPaths.length; i++) {
        if (depths[i] === level && cutPaths[i].length >= 3) groupIndices.push(i);
      }
      const group = groupIndices.map((i) => cutPaths[i]);
      for (const gi of nearestFirst(group, head, offset)) {
        const origIdx = groupIndices[gi];
        const contour = startNear(group[gi], head, offset);
        head = { x: offset.x + contour[0].x, y: offset.y + contour[0].y };

        operations.push({
          id: `layer_${lIdx + 1}_contour_${cCounter}`,
          name: `Layer ${lIdx + 1} Contour #${cCounter + 1}`,
          type: 'cut',
          sheetIndex: sheet,
        });
        cCounter++;

        for (const pt of contour) {
          const px = offset.x + pt.x;
          const py = offset.y + pt.y;
          minX = Math.min(minX, px);
          minY = Math.min(minY, py);
          maxX = Math.max(maxX, px);
          maxY = Math.max(maxY, py);
        }

        // Even-depth outlines bound solid islands and are held with tabs. Odd-depth
        // holes are cut free *unless* they enclose an inner solid island (depth + 1),
        // in which case the moat ring must also be tabbed to the outer wall so the
        // waste ring + inner island cannot break free into a spinning router bit.
        const enclosesIsland =
          level % 2 === 1 &&
          cutPaths.some(
            (other, j) => depths[j] === level + 1 && other.length >= 3 && contourPointInPolygon(other[0], cutPaths[origIdx]),
          );
        const holdContour = level % 2 === 0 || (options.machineMode === 'cnc' && enclosesIsland);
        const spans = holdContour ? planAttachments(polygonPerimeter(contour), options) : [];
        attachmentCount += spans.length;
        totalCutDistanceMm += polygonPerimeter(contour) * loopPassCount(options, fromDepthMm);
        lines.push(...generateLoopGcode(contour, offset, options, spans, fromDepthMm));
      }
    }
  }

  lines.push(``);
  lines.push(`; --- PROGRAM END ---`);
  if (options.machineMode === 'laser') lines.push(`M5`, `G0 X0.000 Y0.000`);
  else lines.push(`G0 Z${f(options.safeZ)}`, `M5`, `G0 X0.000 Y0.000`);
  lines.push(`M30`);

  totalCutDistanceMm *= laserPassCount(options);

  if (!operations.some((op) => op.type === 'cut')) {
    return refusedResult(warnings[0] ?? 'Nothing here for the machine to cut.');
  }

  const gcodeText = tidyModal(lines).join('\n');
  const estimatedTimeSeconds = Math.round(
    estimateGcodeTime(gcodeText, { profile: options.motionProfile ?? DEFAULT_MOTION_PROFILE }).seconds
  );

  return {
    success: true,
    gcode: gcodeText,
    totalCutDistanceMm: Math.round(totalCutDistanceMm),
    estimatedTimeSeconds,
    sheetCount,
    operations,
    bounds: withZRange(
      { minX: isFinite(minX) ? minX : 0, minY: isFinite(minY) ? minY : 0, maxX: isFinite(maxX) ? maxX : 0, maxY: isFinite(maxY) ? maxY : 0 },
      gcodeText
    ),
    attachmentCount,
    compensationMm: radius,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function contourPointInPolygon(p: Point2D, loop: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function contourLoopsBounds(loops: Point2D[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loop of loops) {
    for (const p of loop) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/** Recognises discretized circular holes (`>= 12` vertices) and returns their true circumscribed radius. */
function contourDetectCircularHole(loop: Point2D[]): { cx: number; cy: number; radiusMm: number } | null {
  if (loop.length < 12) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 1e-6 || h <= 1e-6) return null;
  if (Math.abs(w - h) > Math.max(0.12, Math.max(w, h) * 0.06)) return null;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let rMin = Infinity;
  let rMax = -Infinity;
  for (const p of loop) {
    const r = Math.hypot(p.x - cx, p.y - cy);
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  if (rMax <= 1e-6 || rMax - rMin > Math.max(0.08, rMax * 0.05)) return null;

  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const mr = Math.hypot((a.x + b.x) / 2 - cx, (a.y + b.y) / 2 - cy);
    if (mr < rMax * 0.94 - 0.05) return null;
  }
  return { cx, cy, radiusMm: rMax };
}

/** Exact CCW tool-centre orbit for climb-milling a circular bore on a CW spindle. */
function contourClimbCircle(cx: number, cy: number, radiusMm: number, segments: number): Point2D[] {
  const pts: Point2D[] = [];
  for (let k = 0; k < segments; k++) {
    const ang = (k / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(ang) * radiusMm, y: cy + Math.sin(ang) * radiusMm });
  }
  return pts;
}

/** Multi-peck CNC plunge bore for holes whose diameter matches the fitted end mill (`holeDia ≈ bitDia`). */
function contourPlungeBoreGcode(
  px: number,
  py: number,
  options: GcodeExportOptions,
  fromDepthMm = 0,
): { lines: string[]; distanceMm: number } {
  const lines: string[] = [];
  const totalDepth = Math.abs(options.cutDepthZ);
  const stepdown = Math.max(0.1, Math.abs(options.zStepdown));
  const from = Math.min(Math.max(0, fromDepthMm), totalDepth);
  const passes = Math.max(1, Math.ceil((totalDepth - from) / stepdown - 1e-9));
  const clearZ = Math.min(options.safeZ, 0.5);

  lines.push(`G0 Z${f(options.safeZ)}`);
  lines.push(`G0 X${f(px)} Y${f(py)} F${options.travelFeedrate}`);

  let prevBottom = -from;
  let distanceMm = 0;
  for (let pass = 1; pass <= passes; pass++) {
    const targetZ =
      pass === passes
        ? -(totalDepth + SHEET_THROUGH_CUT_MM)
        : -Math.min(totalDepth, from + pass * stepdown);
    lines.push(`; Bore peck ${pass}/${passes} (Z = ${f(targetZ)}mm)`);
    if (pass > 1) {
      lines.push(`G0 Z${f(clearZ)}`);
      if (prevBottom < -0.5) lines.push(`G0 Z${f(prevBottom + 0.5)}`);
    } else if (from > 0.5) {
      lines.push(`G0 Z${f(-from + 0.5)}`);
    }
    lines.push(`G1 Z${f(targetZ)} F${options.plungeFeedrate}`);
    distanceMm += Math.max(0, prevBottom - targetZ);
    prevBottom = targetZ;
  }

  lines.push(`G0 Z${f(options.safeZ)}`);
  return { lines, distanceMm };
}
