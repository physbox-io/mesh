// ---------------------------------------------------------------------------
// Will this job fit on this machine?
// ---------------------------------------------------------------------------
//
// The app already reads the controller's own `$$` dump to find out how fast it
// can accelerate. Three more settings in that same dump — `$130`, `$131`,
// `$132` — say how far it can go, and nothing was asking. So a 600 mm sheet
// laid out for a 400 mm machine exported perfectly happily, and the first
// anybody heard about it was the gantry arriving at the end of its rail with
// the spindle still turning.
//
// There are two quite different questions here and they deserve to be kept
// apart:
//
//   Is the job bigger than the machine?  Answerable from the settings alone,
//   certain, and unaffected by where anything is clamped. A job wider than the
//   rail is wrong no matter how it is set up.
//
//   Does the job fit from where the work origin is?  A different and more
//   common failure — the job is small enough, but it has been zeroed too far
//   along the bed for the rest of it to reach. Answering this needs the machine
//   to know where it is, which means homing, which not every machine has.
//
// The first is reported as a hard problem. The second is only attempted when
// the machine can actually support it, and says so when it cannot, because a
// check that quietly does not run reads exactly like a check that passed.

import type { MotionProfile } from './motionProfile';

/** The box a job sweeps, in work coordinates, mm. */
export interface JobExtent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Deepest the tool goes, negative below the work surface. Optional for a laser. */
  minZ?: number;
  /** Highest the tool goes — the safe/retract height. Optional for a laser. */
  maxZ?: number;
}

/** Where the work origin sits in machine coordinates, mm. */
export interface WorkOrigin {
  x: number;
  y: number;
  z: number;
}

export type EnvelopeAxis = 'X' | 'Y' | 'Z';

export interface EnvelopeProblem {
  axis: EnvelopeAxis;
  /**
   * 'too-big' — the job is larger than the axis's whole travel, so no placement
   * saves it. 'runs-off' — it would fit, but not from where it has been zeroed.
   */
  kind: 'too-big' | 'runs-off';
  /** How far past the end of the axis the job reaches, mm. */
  overrunMm: number;
  message: string;
}

export interface EnvelopeVerdict {
  /** False when at least one problem was found. */
  ok: boolean;
  problems: EnvelopeProblem[];
  /**
   * Whether the job's *size* was checked at all. False when the controller
   * never reported its travel, in which case `ok` means "nothing known against
   * it" rather than "it fits".
   */
  sizeChecked: boolean;
  /**
   * Whether the job's *placement* was checked. False when the machine is not
   * homed, or is not connected, or its travel is unknown.
   */
  placementChecked: boolean;
  /** Why the placement check did not run, for saying so in the UI. */
  placementSkippedBecause?: string;
}

function mm(v: number): string {
  return `${v.toFixed(1)} mm`;
}

/**
 * The interval of machine coordinates each axis can reach.
 *
 * GRBL's own convention is that machine zero is the homed corner and travel
 * runs *negative* from it, so an axis with `$130=400` reaches −400 to 0. That
 * is the default and it is what most machines run, but `$23` can invert any
 * axis, and a machine homed to the minimum reads 0 to +400 instead.
 *
 * Rather than parse the direction mask and its per-axis bits, the convention is
 * read off the machine's own position: wherever it currently is, it is by
 * definition inside its own envelope, so a clearly positive coordinate means
 * the axis runs positive and a clearly negative one that it runs negative.
 * The work origin is inside the envelope too, so it is the second witness.
 *
 * Both can sit at exactly 0 — a machine parked where it homed, zeroed there —
 * and 0 is the boundary of either range, so it says nothing. That case returns
 * both ranges and the caller takes whichever the job fits better; it used to
 * read as negative, and failed every job on a positive-space machine at rest.
 */
function axisRanges(travel: number, currentPos: number, origin: number): Array<{ lo: number; hi: number }> {
  const positive = { lo: 0, hi: travel };
  const negative = { lo: -travel, hi: 0 };
  const witness = Math.abs(currentPos) > 1e-6 ? currentPos : origin;
  if (witness > 1e-6) return [positive];
  if (witness < -1e-6) return [negative];
  return [positive, negative];
}

/**
 * Checks a job against a machine.
 *
 * `origin` and `machinePos` are only needed for the placement check and may be
 * omitted; the size check runs on the profile alone. `homed` is whether the
 * machine has homed this session: before it has, machine coordinates are
 * wherever it powered on, and placement is not checked.
 */
export function checkJobEnvelope(
  extent: JobExtent,
  profile: MotionProfile,
  origin?: WorkOrigin,
  machinePos?: WorkOrigin,
  homed = true
): EnvelopeVerdict {
  const problems: EnvelopeProblem[] = [];
  const travel = profile.travel;

  if (!travel) {
    return {
      ok: true,
      problems,
      sizeChecked: false,
      placementChecked: false,
      placementSkippedBecause:
        'The machine has not reported its travel limits ($130–$132), so nothing here has been checked against it.',
    };
  }

  // ---- Is the job bigger than the machine? ----
  const spans: { axis: EnvelopeAxis; span: number; available: number }[] = [
    { axis: 'X', span: extent.maxX - extent.minX, available: travel.x },
    { axis: 'Y', span: extent.maxY - extent.minY, available: travel.y },
  ];
  if (extent.minZ !== undefined && extent.maxZ !== undefined && travel.z > 0) {
    spans.push({ axis: 'Z', span: extent.maxZ - extent.minZ, available: travel.z });
  }

  for (const s of spans) {
    if (s.available > 0 && s.span > s.available) {
      problems.push({
        axis: s.axis,
        kind: 'too-big',
        overrunMm: s.span - s.available,
        message:
          `The job is ${mm(s.span)} along ${s.axis}, and the machine has ${mm(s.available)} of ` +
          `${s.axis} travel. It will not fit however the stock is placed — ` +
          `${mm(s.span - s.available)} too much.`,
      });
    }
  }

  // ---- Does it fit from where it has been zeroed? ----
  if (!profile.homingEnabled) {
    return {
      ok: problems.length === 0,
      problems,
      sizeChecked: true,
      placementChecked: false,
      placementSkippedBecause:
        'Homing is off on this controller ($22=0), so machine coordinates mean nothing until it is ' +
        'homed and where the job lands on the bed cannot be checked. Its size has been.',
    };
  }
  if (!homed) {
    return {
      ok: problems.length === 0,
      problems,
      sizeChecked: true,
      placementChecked: false,
      placementSkippedBecause:
        'The machine has not been homed since it connected, so its coordinates are wherever it ' +
        'powered on and where the job lands on the bed cannot be checked. Home it first. Its size has been checked.',
    };
  }
  if (!origin || !machinePos) {
    return {
      ok: problems.length === 0,
      problems,
      sizeChecked: true,
      placementChecked: false,
      placementSkippedBecause:
        'Nothing is connected, so where the job would land on the bed cannot be checked. Its size has been.',
    };
  }

  const axes: { axis: EnvelopeAxis; lo: number; hi: number; travel: number; pos: number }[] = [
    { axis: 'X', lo: extent.minX, hi: extent.maxX, travel: travel.x, pos: machinePos.x },
    { axis: 'Y', lo: extent.minY, hi: extent.maxY, travel: travel.y, pos: machinePos.y },
  ];
  if (extent.minZ !== undefined && extent.maxZ !== undefined && travel.z > 0) {
    axes.push({ axis: 'Z', lo: extent.minZ, hi: extent.maxZ, travel: travel.z, pos: machinePos.z });
  }

  for (const a of axes) {
    const originOnAxis = a.axis === 'X' ? origin.x : a.axis === 'Y' ? origin.y : origin.z;
    const jobLo = originOnAxis + a.lo;
    const jobHi = originOnAxis + a.hi;
    const overrunIn = (r: { lo: number; hi: number }) => Math.max(r.lo - jobLo, jobHi - r.hi);
    const range = axisRanges(a.travel, a.pos, originOnAxis)
      .reduce((best, r) => (overrunIn(r) < overrunIn(best) ? r : best));

    // Only report the worse end, so one badly-placed job is one message.
    const under = range.lo - jobLo;
    const over = jobHi - range.hi;
    const overrun = Math.max(under, over);
    if (overrun > 1e-3) {
      // A job that is not itself too big has already been reported on if it is,
      // so anything reaching this point is a placement problem.
      const already = problems.some((p) => p.axis === a.axis && p.kind === 'too-big');
      if (already) continue;

      const direction = over > under ? 'past the far end' : 'past the near end';
      problems.push({
        axis: a.axis,
        kind: 'runs-off',
        overrunMm: overrun,
        message:
          `From this work origin the job reaches ${mm(overrun)} ${direction} of ${a.axis} travel. ` +
          `It spans ${mm(jobLo)} to ${mm(jobHi)} in machine coordinates, and the machine can reach ` +
          `${mm(range.lo)} to ${mm(range.hi)}. Move the origin or reclamp the stock.`,
      });
    }
  }

  return { ok: problems.length === 0, problems, sizeChecked: true, placementChecked: true };
}

/** One line summarising a verdict, for a status strip. */
export function describeEnvelope(verdict: EnvelopeVerdict): string {
  if (verdict.problems.length > 0) {
    return verdict.problems.map((p) => p.message).join(' ');
  }
  if (!verdict.sizeChecked) return verdict.placementSkippedBecause ?? 'Not checked against the machine.';
  if (!verdict.placementChecked) {
    return `Fits the machine. ${verdict.placementSkippedBecause ?? ''}`.trim();
  }
  return 'Fits the machine, and fits from this work origin.';
}

/**
 * Computes the work-coordinate bounding box of a G-code program in millimetres.
 *
 * Tracks modal motion (`G0`/`G1`/`G2`/`G3`), distance mode (`G90`/`G91`), and
 * units (`G20`/`G21`), ignores non-work-coordinate commands (`G53`, `G10`,
 * `G28`, `G30`, `G92`), and includes cardinal extrema swept by `G2`/`G3` arcs.
 */
export function measureGcodeBounds(gcode: string): JobExtent | null {
  let modalMotion: 'G0' | 'G1' | 'G2' | 'G3' | null = null;
  let absoluteMode = true;
  let unitScale = 1;
  let curX = 0;
  let curY = 0;
  let curZ = 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let hasXY = false;
  let hasZ = false;

  const includeXY = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    hasXY = true;
  };

  for (const rawLine of gcode.split('\n')) {
    const semi = rawLine.indexOf(';');
    const body = semi < 0 ? rawLine : rawLine.slice(0, semi);
    const code = body.replace(/\([^)]*\)/g, ' ').trim();
    if (!code) continue;

    const tokens = code.toUpperCase().match(/[A-Z][+-]?\d*(?:\.\d+)?/g);
    if (!tokens) continue;

    let nonModalBypass = false;
    let lineMotion: 'G0' | 'G1' | 'G2' | 'G3' | null = null;
    let xVal: number | null = null;
    let yVal: number | null = null;
    let zVal: number | null = null;
    let iVal: number | null = null;
    let jVal: number | null = null;
    let rVal: number | null = null;

    for (const tok of tokens) {
      const letter = tok[0];
      const numStr = tok.slice(1);
      const val = parseFloat(numStr);
      if (!Number.isFinite(val)) continue;

      if (letter === 'G') {
        if (numStr.includes('.')) continue;
        const g = Math.round(val);
        if (g === 90) absoluteMode = true;
        else if (g === 91) absoluteMode = false;
        else if (g === 20) unitScale = 25.4;
        else if (g === 21) unitScale = 1;
        else if (g === 0 || g === 1 || g === 2 || g === 3) {
          lineMotion = `G${g}` as 'G0' | 'G1' | 'G2' | 'G3';
        } else if (g === 53 || g === 10 || g === 28 || g === 30 || g === 92 || g === 4) {
          nonModalBypass = true;
        }
      } else if (letter === 'X') {
        xVal = val;
      } else if (letter === 'Y') {
        yVal = val;
      } else if (letter === 'Z') {
        zVal = val;
      } else if (letter === 'I') {
        iVal = val;
      } else if (letter === 'J') {
        jVal = val;
      } else if (letter === 'R') {
        rVal = val;
      }
    }

    if (nonModalBypass) continue;
    if (lineMotion !== null) modalMotion = lineMotion;
    if (xVal === null && yVal === null && zVal === null) continue;

    if (xVal !== null) xVal *= unitScale;
    if (yVal !== null) yVal *= unitScale;
    if (zVal !== null) zVal *= unitScale;
    if (iVal !== null) iVal *= unitScale;
    if (jVal !== null) jVal *= unitScale;
    if (rVal !== null) rVal *= unitScale;

    const cmd = lineMotion ?? modalMotion ?? 'G0';
    const nx = xVal !== null ? (absoluteMode ? xVal : curX + xVal) : curX;
    const ny = yVal !== null ? (absoluteMode ? yVal : curY + yVal) : curY;
    const nz = zVal !== null ? (absoluteMode ? zVal : curZ + zVal) : curZ;

    if (xVal !== null || yVal !== null) {
      if ((cmd === 'G2' || cmd === 'G3') && (iVal !== null || jVal !== null || rVal !== null)) {
        includeXY(curX, curY);
        includeXY(nx, ny);
        let cx = curX;
        let cy = curY;
        let r = 0;
        if (iVal !== null || jVal !== null) {
          cx = curX + (iVal ?? 0);
          cy = curY + (jVal ?? 0);
          r = Math.hypot(curX - cx, curY - cy);
        } else if (rVal !== null && Math.abs(rVal) > 1e-9) {
          const dx = nx - curX;
          const dy = ny - curY;
          const d = Math.hypot(dx, dy);
          r = Math.abs(rVal);
          if (d > 1e-9 && d <= 2 * r + 1e-6) {
            const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
            const mx = (curX + nx) / 2;
            const my = (curY + ny) / 2;
            const ux = -dy / d;
            const uy = dx / d;
            const sign = (cmd === 'G3') === (rVal > 0) ? 1 : -1;
            cx = mx + sign * h * ux;
            cy = my + sign * h * uy;
          }
        }
        if (r > 1e-9) {
          const fullCircle = Math.hypot(nx - curX, ny - curY) < 1e-6;
          if (fullCircle) {
            includeXY(cx + r, cy);
            includeXY(cx - r, cy);
            includeXY(cx, cy + r);
            includeXY(cx, cy - r);
          } else {
            const startAngle = Math.atan2(curY - cy, curX - cx);
            const endAngle = Math.atan2(ny - cy, nx - cx);
            let sweep = cmd === 'G3' ? endAngle - startAngle : startAngle - endAngle;
            while (sweep <= 1e-9) sweep += 2 * Math.PI;
            while (sweep > 2 * Math.PI + 1e-9) sweep -= 2 * Math.PI;
            for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
              let da = cmd === 'G3' ? a - startAngle : startAngle - a;
              while (da < 0) da += 2 * Math.PI;
              while (da >= 2 * Math.PI) da -= 2 * Math.PI;
              if (da <= sweep + 1e-9) {
                includeXY(cx + r * Math.cos(a), cy + r * Math.sin(a));
              }
            }
          }
        }
      } else {
        includeXY(nx, ny);
      }
    }

    if (zVal !== null) {
      if (nz < minZ) minZ = nz;
      if (nz > maxZ) maxZ = nz;
      hasZ = true;
    }

    curX = nx;
    curY = ny;
    curZ = nz;
  }

  if (!hasXY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    ...(hasZ ? { minZ, maxZ } : {}),
  };
}
