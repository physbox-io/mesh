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
 * the axis runs positive and anything else means it runs negative. That is
 * exactly the evidence the question needs, and it cannot disagree with the
 * machine the way a decoded setting can.
 */
function axisRange(travel: number, currentPos: number): { lo: number; hi: number } {
  return currentPos > 1e-6 ? { lo: 0, hi: travel } : { lo: -travel, hi: 0 };
}

/**
 * Checks a job against a machine.
 *
 * `origin` and `machinePos` are only needed for the placement check and may be
 * omitted; the size check runs on the profile alone.
 */
export function checkJobEnvelope(
  extent: JobExtent,
  profile: MotionProfile,
  origin?: WorkOrigin,
  machinePos?: WorkOrigin
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
    const range = axisRange(a.travel, a.pos);
    const jobLo = originOnAxis + a.lo;
    const jobHi = originOnAxis + a.hi;

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
