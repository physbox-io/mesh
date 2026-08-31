// ---------------------------------------------------------------------------
// What the machine on the other end of the cable can actually do
// ---------------------------------------------------------------------------
//
// Every time estimate in this app used to rest on two invented numbers: an
// acceleration of 500 mm/s² and a rapid rate of 3000 mm/min. Neither was ever
// asked of the machine, and both are wrong on most of them — a stock GRBL ships
// at 10 mm/s², a belt-driven hobby router that has been tuned runs 200-800, and
// a ballscrew mill runs several thousand. That is a factor of fifty across the
// range, and it lands directly on the estimate, which is the number people use
// to decide whether to start a carve before dinner.
//
// GRBL will simply tell you, and has since 1.1: `$$` dumps every setting, and
// four of them are the whole answer. So the profile below is read off the
// controller the moment it connects, and the invented numbers survive only as
// the fallback for an estimate made with nothing plugged in.
// ---------------------------------------------------------------------------

/** Per-axis quantity, in whatever unit the field it belongs to says. */
export interface AxisTriple {
  x: number;
  y: number;
  z: number;
}

export interface MotionProfile {
  /** Acceleration limit per axis, mm/s². GRBL `$120` / `$121` / `$122`. */
  accel: AxisTriple;
  /** Maximum traverse per axis, mm/min. GRBL `$110` / `$111` / `$112`. */
  maxRate: AxisTriple;
  /**
   * Spindle speed range the controller will scale `S` words across, RPM.
   * GRBL `$31` / `$30`. Null when the controller did not report them.
   */
  spindle: { min: number; max: number } | null;
  /**
   * How far each axis can actually go, mm. GRBL `$130` / `$131` / `$132`.
   *
   * Null when the controller did not report them, which is the honest state to
   * be in: a machine whose travel is unknown cannot be told that a job will not
   * fit on it, and inventing a bed size would produce exactly the false alarm
   * that teaches people to ignore the warning.
   */
  travel: AxisTriple | null;
  /**
   * Whether homing is configured, GRBL `$22`.
   *
   * This is what decides whether machine coordinates mean anything. Without
   * homing, machine zero is wherever the controller happened to power up, so
   * the machine position in a status report says nothing about where the job
   * sits between the limit switches — the size of a job can still be checked
   * against the size of the machine, but where it lands cannot.
   */
  homingEnabled: boolean;
  /**
   * Whether the controller enforces soft limits itself, GRBL `$20`.
   *
   * When it does, a job that runs off the end throws an alarm and stops rather
   * than driving into the stop — worth knowing, because it changes the warning
   * from "this will crash" to "this will halt partway through".
   */
  softLimits: boolean;
  /**
   * Where these came from. A number read off the machine and a number this file
   * made up should never be presented as the same kind of thing — an estimate
   * built on the second is a guess, and the UI says so.
   */
  source: 'machine' | 'assumed';
}

/**
 * What to assume when nothing is connected.
 *
 * The shape of a small belt-driven hobby router or diode laser that has been
 * set up, which is what this app drives. Z is slower and softer than X and Y on
 * every machine of that kind, because it is lifting the spindle against gravity
 * through a leadscrew.
 */
export const DEFAULT_MOTION_PROFILE: MotionProfile = {
  accel: { x: 500, y: 500, z: 200 },
  maxRate: { x: 3000, y: 3000, z: 1000 },
  spindle: null,
  // Deliberately not guessed. Every other field here has a sane default because
  // a wrong acceleration only skews an estimate; a wrong bed size would reject
  // jobs that fit perfectly well.
  travel: null,
  homingEnabled: false,
  softLimits: false,
  source: 'assumed',
};

/** GRBL setting numbers this app reads. */
const SETTING = {
  softLimits: 20,
  homing: 22,
  spindleMax: 30,
  spindleMin: 31,
  maxRateX: 110,
  maxRateY: 111,
  maxRateZ: 112,
  accelX: 120,
  accelY: 121,
  accelZ: 122,
  travelX: 130,
  travelY: 131,
  travelZ: 132,
} as const;

/**
 * Reads a `$$` dump into a settings map.
 *
 * The reply is one `$N=value` per line, interleaved with the `ok`s and status
 * reports of a live connection, so anything that is not that shape is skipped
 * rather than treated as a parse failure.
 */
export function parseGrblSettings(lines: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of lines) {
    const m = /^\$(\d+)\s*=\s*(-?\d*\.?\d+)/.exec(line.trim());
    if (!m) continue;
    const value = parseFloat(m[2]);
    if (Number.isFinite(value)) out.set(parseInt(m[1], 10), value);
  }
  return out;
}

/**
 * Turns a settings map into a motion profile, falling back per field.
 *
 * Per field rather than all-or-nothing, because controllers differ in what they
 * report: grblHAL renumbers some settings, a laser build may have no Z axis
 * configured at all, and a machine with `$30` unset still has perfectly good
 * acceleration figures. Taking the ones that arrived and assuming only the rest
 * is strictly better than throwing the lot away.
 *
 * A zero is treated as absent. GRBL will accept `$120=0` and it means the axis
 * cannot accelerate, which is not a machine — it is a setting nobody finished
 * typing, and dividing by it would put the estimate at infinity.
 */
export function motionProfileFromSettings(settings: Map<number, number>): MotionProfile {
  const read = (key: number, fallback: number) => {
    const v = settings.get(key);
    return v !== undefined && v > 0 ? v : fallback;
  };

  const d = DEFAULT_MOTION_PROFILE;
  // Only claim the profile came off the machine if the numbers that matter did.
  const gotMotion =
    (settings.get(SETTING.accelX) ?? 0) > 0 && (settings.get(SETTING.maxRateX) ?? 0) > 0;

  const spindleMax = settings.get(SETTING.spindleMax);
  const spindleMin = settings.get(SETTING.spindleMin);
  const travelX = settings.get(SETTING.travelX);
  const travelY = settings.get(SETTING.travelY);
  const travelZ = settings.get(SETTING.travelZ);

  return {
    accel: {
      x: read(SETTING.accelX, d.accel.x),
      y: read(SETTING.accelY, read(SETTING.accelX, d.accel.y)),
      z: read(SETTING.accelZ, d.accel.z),
    },
    maxRate: {
      x: read(SETTING.maxRateX, d.maxRate.x),
      y: read(SETTING.maxRateY, read(SETTING.maxRateX, d.maxRate.y)),
      z: read(SETTING.maxRateZ, d.maxRate.z),
    },
    spindle:
      spindleMax !== undefined && spindleMax > 0
        ? { min: spindleMin !== undefined && spindleMin > 0 ? spindleMin : 0, max: spindleMax }
        : null,
    // All three axes or none: a travel figure for X with nothing for Y is far
    // more likely to be a controller that numbers its settings differently than
    // a machine with no Y axis, and half an envelope is worse than none.
    travel: travelX !== undefined && travelX > 0 && travelY !== undefined && travelY > 0
      ? { x: travelX, y: travelY, z: travelZ !== undefined && travelZ > 0 ? travelZ : 0 }
      : null,
    homingEnabled: (settings.get(SETTING.homing) ?? 0) > 0,
    softLimits: (settings.get(SETTING.softLimits) ?? 0) > 0,
    source: gotMotion ? 'machine' : 'assumed',
  };
}

/**
 * The acceleration available to a move in a given direction, mm/s².
 *
 * A controller does not have "an acceleration" — it has one per axis, and a
 * move is limited by whichever axis runs out first. A plunge is governed by Z
 * alone, a 45° diagonal gets each axis's limit divided by 0.707, and a pure X
 * move gets all of X's. Collapsing the three into one scalar would either make
 * every plunge as brisk as an X move or every X move as sluggish as a plunge,
 * and a relief job is full of both.
 *
 * `dir` need not be normalised; only its shape matters.
 */
export function accelAlong(profile: MotionProfile, dx: number, dy: number, dz: number): number {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-12) return profile.accel.x;

  let limit = Infinity;
  const axis = (component: number, available: number) => {
    const share = Math.abs(component) / len;
    if (share > 1e-9) limit = Math.min(limit, available / share);
  };
  axis(dx, profile.accel.x);
  axis(dy, profile.accel.y);
  axis(dz, profile.accel.z);
  return Number.isFinite(limit) ? limit : profile.accel.x;
}

/**
 * The fastest a move in a given direction may go, mm/min — the same per-axis
 * argument as `accelAlong`, applied to the rate limits.
 *
 * This is what a `G0` actually runs at. "The rapid rate" is not a number a GRBL
 * machine has: a rapid along X runs at `$110`, and the same rapid with a Z
 * component in it is dragged down to whatever Z can manage, which on a router
 * is usually a third of it. Retracts between raster passes are exactly that
 * move, and there are tens of thousands of them in a carve.
 */
export function maxRateAlong(profile: MotionProfile, dx: number, dy: number, dz: number): number {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-12) return profile.maxRate.x;

  let limit = Infinity;
  const axis = (component: number, available: number) => {
    const share = Math.abs(component) / len;
    if (share > 1e-9) limit = Math.min(limit, available / share);
  };
  axis(dx, profile.maxRate.x);
  axis(dy, profile.maxRate.y);
  axis(dz, profile.maxRate.z);
  return Number.isFinite(limit) ? limit : profile.maxRate.x;
}

/**
 * One line describing where the estimate's numbers came from.
 *
 * `connected` matters because the two cases read completely differently to
 * whoever is standing at the machine. With nothing plugged in, "connect the
 * machine and this is read from it" is an instruction. With the machine
 * connected and answering everything else, the same sentence is the app telling
 * someone to do a thing they have already done — so it says what is actually
 * true instead: the controller did not answer, and here is the button.
 */
export function describeMotionProfile(profile: MotionProfile, connected = false): string {
  if (profile.source !== 'machine') {
    if (connected) {
      return (
        `Assuming ${profile.accel.x} mm/s² and ${profile.maxRate.x} mm/min rapids. This machine has ` +
        `not answered \`$$\` with figures we recognise, so run times are estimates — try reading them again.`
      );
    }
    return `Assuming ${profile.accel.x} mm/s² and ${profile.maxRate.x} mm/min rapids — connect the machine and this is read from it.`;
  }
  return (
    `From the machine: ${profile.accel.x} mm/s² X, ${profile.accel.y} mm/s² Y, ` +
    `${profile.accel.z} mm/s² Z, rapids ${profile.maxRate.x}/${profile.maxRate.y}/${profile.maxRate.z} mm/min.`
  );
}
