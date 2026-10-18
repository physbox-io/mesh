// ---------------------------------------------------------------------------
// Job time estimation
// ---------------------------------------------------------------------------
// Every exporter in this app used to estimate its run time the same way:
// cut length divided by feedrate, plus a fudge for the rapids. That is not an
// estimate of anything a controller does. It says a job of forty thousand
// 0.05 mm raster steps at 1500 mm/min takes exactly as long as one 2 m straight
// line at 1500 mm/min, when in practice the first never gets within a factor of
// five of its feedrate and runs for hours rather than the minutes it promised.
//
// That error is worst on exactly the jobs people most want a number for — a
// relief finishing raster is nothing *but* short reversing moves — so this
// replaces it with the same trapezoidal planner the controller itself runs:
// accelerate, cruise, decelerate, and carry through a corner only as much speed
// as the corner can hold.
//
// The limits it plans against come off the machine (see `motionProfile.ts`),
// per axis, because that is how a controller holds them. A plunge is governed
// by Z's acceleration alone and a retract by Z's maximum rate, and both are
// several times slower than X and Y on every hobby router — which is why a
// raster job's retracts are a bigger share of its clock than its cutting.
// ---------------------------------------------------------------------------

import {
  DEFAULT_MOTION_PROFILE,
  accelAlong,
  maxRateAlong,
  type MotionProfile,
} from './motionProfile';
import { splitGcodeComments } from './gcodeComments';

/**
 * GRBL's junction deviation, mm. How far off a corner the machine is allowed to
 * cut in exchange for carrying speed through it — the corner is taken at the
 * speed a circular arc of that sagitta could hold.
 *
 * `$11` on the controller, and read from it when there is one; this is GRBL's
 * own default for when there is not.
 */
export const DEFAULT_JUNCTION_DEVIATION_MM = 0.01;

/**
 * Blocks per second the controller can accept, plan and execute.
 *
 * The floor under a move's time, and the thing that actually governs a dense
 * raster: past this rate the machine is waiting for its next instruction, not
 * for its axes. A conservative figure for GRBL over a 115200 serial link.
 */
const BLOCKS_PER_SECOND = 450;

/** One planned move: where it goes, and how fast it is allowed to get there. */
export interface TimedMove {
  x1: number; y1: number; z1: number;
  x2: number; y2: number; z2: number;
  /**
   * Programmed feed in mm/min, or 0 for a rapid — a rapid has no F word, it
   * runs at whatever the axes involved can manage, which the profile decides.
   */
  feed: number;
  rapid: boolean;
}

interface Vec { x: number; y: number; z: number }

/**
 * The speed the machine can carry through the corner between two moves.
 *
 * Straight through it keeps everything; into a right angle it keeps almost
 * nothing. This is GRBL's own centripetal rule rather than a guess, so the
 * estimate slows down in the places the machine actually slows down — which on
 * a raster is at the end of every single scanline.
 *
 * The acceleration is the one available in the direction being turned into,
 * not a global scalar: a corner that turns into a plunge is held back by Z.
 */
function junctionSpeed(
  prev: Vec | null,
  next: Vec | null,
  accel: number,
  junctionDeviationMm: number
): number {
  if (!prev || !next) return 0;
  const cosTheta = prev.x * next.x + prev.y * next.y + prev.z * next.z;
  // Doubling back is a full stop, and the formula below divides by zero there.
  if (cosTheta <= -0.999999) return 0;
  if (cosTheta >= 0.999999) return Infinity;
  const sinHalf = Math.sqrt((1 - cosTheta) / 2);
  return Math.sqrt((accel * junctionDeviationMm * sinHalf) / (1 - sinHalf));
}

/**
 * How long a move of `distance` takes, entering at `vIn`, leaving at `vOut`,
 * never exceeding `vMax`, under acceleration `a`. Speeds mm/s, distance mm,
 * result seconds.
 *
 * Trapezoidal: accelerate, hold, decelerate. A move too short to reach `vMax`
 * gets a triangular profile with the peak solved for — which is the case that
 * matters, because on a dense raster every move is that case.
 */
export function moveSeconds(
  distance: number,
  vIn: number,
  vOut: number,
  vMax: number,
  a: number = DEFAULT_MOTION_PROFILE.accel.x
): number {
  if (distance <= 0) return 0;
  if (a <= 0) return Infinity;

  const vPeak = Math.min(
    vMax,
    Math.sqrt(Math.max(0, (2 * a * distance + vIn * vIn + vOut * vOut) / 2))
  );

  const dAccel = Math.max(0, (vPeak * vPeak - vIn * vIn) / (2 * a));
  const dDecel = Math.max(0, (vPeak * vPeak - vOut * vOut) / (2 * a));
  const dCruise = Math.max(0, distance - dAccel - dDecel);

  const tAccel = Math.max(0, (vPeak - vIn) / a);
  const tDecel = Math.max(0, (vPeak - vOut) / a);
  const tCruise = vPeak > 1e-9 ? dCruise / vPeak : 0;

  return tAccel + tDecel + tCruise;
}

/** Per-move limits, worked out once from the profile and the move's direction. */
interface MoveLimits {
  /** Length in mm. */
  dist: number;
  /** Ceiling speed in mm/s: the programmed feed, capped by what the axes allow. */
  vLimit: number;
  /** Acceleration available along this move, mm/s². */
  accel: number;
  /** Unit direction, or null for a zero-length move. */
  dir: Vec | null;
}

function limitsFor(m: TimedMove, profile: MotionProfile): MoveLimits {
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const dz = m.z2 - m.z1;
  const len = Math.hypot(dx, dy, dz);

  // What the axes will allow in this direction, whatever the program asked for.
  const axisCeiling = maxRateAlong(profile, dx, dy, dz);
  // A rapid has no programmed feed: it runs at the axis ceiling. A cut is
  // capped by it — GRBL will not exceed `$110` because an F word said so.
  const commanded = m.rapid || m.feed <= 0 ? axisCeiling : Math.min(m.feed, axisCeiling);

  return {
    dist: len,
    vLimit: Math.max(1, commanded) / 60,
    accel: accelAlong(profile, dx, dy, dz),
    dir: len < 1e-9 ? null : { x: dx / len, y: dy / len, z: dz / len },
  };
}

/**
 * Entry and exit speeds for every move, mm/s.
 *
 * Backward pass first: a move can only enter as fast as it can still brake to
 * whatever the next one will accept. Then forward: it can only leave as fast as
 * it managed to accelerate to. Running them in that order is what makes a run
 * of short moves come out slow — each one is already braking for the next
 * before it has finished speeding up for itself, which is precisely why a dense
 * raster never reaches its programmed feed.
 */
function planSpeeds(
  limits: MoveLimits[],
  junctionDeviationMm: number
): Array<{ vIn: number; vOut: number }> {
  const n = limits.length;

  // The speed each junction can hold, capped by both neighbours' ceilings.
  const junction = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) {
    junction[i] = Math.min(
      junctionSpeed(
        limits[i - 1].dir,
        limits[i].dir,
        Math.min(limits[i - 1].accel, limits[i].accel),
        junctionDeviationMm
      ),
      limits[i - 1].vLimit,
      limits[i].vLimit
    );
  }

  for (let i = n - 1; i >= 0; i--) {
    const reachable = Math.sqrt(
      junction[i + 1] * junction[i + 1] + 2 * limits[i].accel * limits[i].dist
    );
    if (junction[i] > reachable) junction[i] = reachable;
  }
  for (let i = 0; i < n; i++) {
    const reachable = Math.sqrt(
      junction[i] * junction[i] + 2 * limits[i].accel * limits[i].dist
    );
    if (junction[i + 1] > reachable) junction[i + 1] = reachable;
  }

  const out: Array<{ vIn: number; vOut: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      vIn: Math.min(junction[i], limits[i].vLimit),
      vOut: Math.min(junction[i + 1], limits[i].vLimit),
    };
  }
  return out;
}

/** A move with the job clock attached, in seconds from the start of the program. */
export interface ClockedMove extends TimedMove {
  t0: number;
  t1: number;
}

export interface TimingOptions {
  /** What the machine can do. Defaults to the assumed hobby-router profile. */
  profile?: MotionProfile;
  /**
   * GRBL `$11`, mm. Defaults to the profile's own, which is the machine's when
   * the profile was read off one.
   *
   * Here only so a caller can ask what a job *would* cost at another setting —
   * which is the honest way to show someone that their corner tolerance, not
   * their feed, is what the job is waiting on. Nothing should pass it to supply
   * a value the profile already carries.
   */
  junctionDeviationMm?: number;
}

/**
 * Puts a list of moves on the clock.
 *
 * The result is what a preview animation should be played back against: the
 * point of doing the acceleration arithmetic is that the tool then crawls
 * through the dense parts of a job and flies through the open ones, exactly as
 * it will on the machine, instead of sliding along at a constant rate that
 * makes an hour of raster look like thirty seconds of scribble.
 */
export function clockMoves<M extends TimedMove>(moves: M[], opts: TimingOptions = {}): Array<M & ClockedMove> {
  if (moves.length === 0) return [];
  const profile = opts.profile ?? DEFAULT_MOTION_PROFILE;
  const jd = opts.junctionDeviationMm ?? profile.junctionDeviation;

  const limits = moves.map((m) => limitsFor(m, profile));
  const speeds = planSpeeds(limits, jd);

  // Spread, so whatever else a caller tagged its moves with rides along.
  const out: Array<M & ClockedMove> = new Array(moves.length);
  let t = 0;
  for (let i = 0; i < moves.length; i++) {
    // Never quicker than the controller can take the instruction: on a raster
    // decimated to sub-millimetre steps this floor, not the axes, is the limit.
    const dt = Math.max(
      moveSeconds(limits[i].dist, speeds[i].vIn, speeds[i].vOut, limits[i].vLimit, limits[i].accel),
      1 / BLOCKS_PER_SECOND
    );
    out[i] = { ...moves[i], t0: t, t1: t + dt };
    t += dt;
  }
  return out;
}

/** Seconds of machine motion for a list of moves. */
export function estimateMoveSeconds(moves: TimedMove[], opts: TimingOptions = {}): number {
  const clocked = clockMoves(moves, opts);
  return clocked.length === 0 ? 0 : clocked[clocked.length - 1].t1;
}

export interface GcodeEstimate {
  /** Seconds of machine motion, dwells included. */
  seconds: number;
  /** Millimetres travelled under G1. */
  cutDistanceMm: number;
  /** Millimetres travelled under G0. */
  rapidDistanceMm: number;
  /** Moves the program makes. Useful for a preview that wants the same clock. */
  moves: TimedMove[];
  /**
   * Number of `M0`/`M1`/`M6` stops. Each is however long the operator takes,
   * which is not a thing to guess at, so they are counted rather than timed.
   */
  operatorStops: number;
  /** Every distinct `S` word the program commands with the spindle on, in order. */
  spindleSpeeds: number[];
  /** Whether the limits came off a real machine or were assumed. */
  source: MotionProfile['source'];
}

/**
 * Walks a finished G-code program and times it.
 *
 * Estimating from the program rather than from the path-building code is what
 * keeps the number honest: it counts the lead-in ramps, the retracts between
 * scanlines and the mesh-levelling subdivision, all of which are real moves the
 * machine makes and none of which the old `distance / feedrate` arithmetic in
 * the exporters ever saw.
 *
 * Understood: modal G0/G1, G2/G3 arcs in the XY plane (as points along the
 * arc; in G18/G19 as the chord), G90/G91, G20/G21 and G4 dwells. Lines that
 * set offsets or home (G10, G92, G28, G30, G53) and probe cycles are not moves.
 */
export function estimateGcodeTime(gcode: string, opts: TimingOptions = {}): GcodeEstimate {
  const profile = opts.profile ?? DEFAULT_MOTION_PROFILE;
  const read = readProgram(gcode.split('\n'));
  const dwellSeconds = read.dwells.reduce((sum, d) => sum + d.seconds, 0);

  return {
    seconds: estimateMoveSeconds(read.moves, opts) + dwellSeconds,
    cutDistanceMm: read.cutDistanceMm,
    rapidDistanceMm: read.rapidDistanceMm,
    moves: read.moves,
    operatorStops: read.operatorStops,
    spindleSpeeds: read.spindleSpeeds,
    source: profile.source,
  };
}

/** A move tagged with the program line that commanded it. */
export interface LineMove extends TimedMove {
  /** Index into the lines the program was read from. */
  line: number;
}

/**
 * The motion in a list of G-code lines, each move tagged with its line.
 *
 * Shared by the whole-program estimate and the per-line timeline, so the two
 * cannot read the same program differently.
 */
function readProgram(lines: string[]) {
  const moves: LineMove[] = [];
  const dwells: Array<{ line: number; seconds: number }> = [];
  let x = 0, y = 0, z = 0;
  let feed = 0;
  let absolute = true;
  let unitScale = 1; // G20 (inches) multiplies coordinates up to mm
  let cutDistanceMm = 0;
  let rapidDistanceMm = 0;
  let operatorStops = 0;
  const spindleSpeeds: number[] = [];
  let lastS: number | null = null;

  /*
   * The motion mode is modal: after `G1 X10 F500`, a bare `X20` is another
   * feed move. It used to be reset on every line, so a program that leaves
   * out repeated G words lost those moves from its clock and its playhead.
   * `null` is a mode with no move to count (G80, or a probe cycle).
   */
  let motion: 0 | 1 | 2 | 3 | null = null;
  // Arcs are read in XY (G17) only; in G18/G19 they count as their chord.
  let xyPlane = true;

  const push = (nx: number, ny: number, nz: number, index: number, rapid: boolean) => {
    const d = Math.hypot(nx - x, ny - y, nz - z);
    if (d <= 0) return;
    if (rapid) rapidDistanceMm += d;
    else cutDistanceMm += d;
    moves.push({
      x1: x, y1: y, z1: z,
      x2: nx, y2: ny, z2: nz,
      feed: rapid ? 0 : feed,
      rapid,
      line: index,
    });
    x = nx; y = ny; z = nz;
  };

  for (let index = 0; index < lines.length; index++) {
    // Both comment syntaxes, so the `Z-2.0` in `(Pass 1 of 3: Z-2.0mm)` is not a move.
    const line = splitGcodeComments(lines[index]).code.toUpperCase();
    if (!line) continue;

    // Words, so `G1X10Y20F500` reads the same as `G1 X10 Y20 F500`.
    const words = line.match(/[A-Z]-?\d*\.?\d*/g);
    if (!words) continue;

    let tx: number | null = null;
    let ty: number | null = null;
    let tz: number | null = null;
    let ti: number | null = null;
    let tj: number | null = null;
    let tr: number | null = null;
    let tf: number | null = null;
    let lineMotion: 0 | 1 | 2 | 3 | null | undefined = undefined;
    let spindleOn = false;
    // G4, G10, G28, G30, G53, G92: the axis words on these lines are not a
    // move in the current mode (an offset, a dwell, a homing waypoint).
    let nonModal = false;

    for (const w of words) {
      const letter = w[0];
      const value = parseFloat(w.slice(1));

      switch (letter) {
        case 'G':
          if (value === 0 || value === 1 || value === 2 || value === 3) lineMotion = value as 0 | 1 | 2 | 3;
          else if (value === 80 || (value >= 38 && value < 39)) lineMotion = null;
          else if (value === 90) absolute = true;
          else if (value === 91) absolute = false;
          else if (value === 17) xyPlane = true;
          else if (value === 18 || value === 19) xyPlane = false;
          else if (value === 20) unitScale = 25.4;
          else if (value === 21) unitScale = 1;
          else if ([4, 10, 28, 30, 53, 92].includes(value)) nonModal = true;
          break;
        case 'X': if (Number.isFinite(value)) tx = value; break;
        case 'Y': if (Number.isFinite(value)) ty = value; break;
        case 'Z': if (Number.isFinite(value)) tz = value; break;
        case 'I': if (Number.isFinite(value)) ti = value; break;
        case 'J': if (Number.isFinite(value)) tj = value; break;
        case 'R': if (Number.isFinite(value)) tr = value; break;
        case 'F': if (Number.isFinite(value) && value > 0) tf = value; break;
        case 'S': if (Number.isFinite(value)) lastS = value; break;
        case 'M':
          if (value === 0 || value === 1 || value === 6) operatorStops++;
          // M3/M4 start the spindle; whatever S is current is what it runs at,
          // and on a router without closed-loop control that is a dial someone
          // has to turn by hand before pressing start.
          if (value === 3 || value === 4) spindleOn = true;
          break;
      }
    }

    if (lineMotion !== undefined && !nonModal) motion = lineMotion;
    if (tf !== null) feed = tf * unitScale;
    if (tx !== null) tx *= unitScale;
    if (ty !== null) ty *= unitScale;
    if (tz !== null) tz *= unitScale;
    if (ti !== null) ti *= unitScale;
    if (tj !== null) tj *= unitScale;
    if (tr !== null) tr *= unitScale;

    if (spindleOn && lastS !== null && lastS > 0 && !spindleSpeeds.includes(lastS)) {
      spindleSpeeds.push(lastS);
    }

    if (/\bG0*4\b/.test(line)) {
      const p = line.match(/P(-?\d*\.?\d+)/);
      if (p) dwells.push({ line: index, seconds: Math.max(0, parseFloat(p[1])) });
    }

    if (nonModal || motion === null || (tx === null && ty === null && tz === null)) continue;

    const nx = tx === null ? x : absolute ? tx : x + tx;
    const ny = ty === null ? y : absolute ? ty : y + ty;
    const nz = tz === null ? z : absolute ? tz : z + tz;

    if ((motion === 2 || motion === 3) && xyPlane) {
      for (const p of arcPoints(x, y, z, nx, ny, nz, ti, tj, tr, motion === 2)) {
        push(p[0], p[1], p[2], index, false);
      }
    } else {
      push(nx, ny, nz, index, motion === 0);
    }
  }

  return { moves, dwells, cutDistanceMm, rapidDistanceMm, operatorStops, spindleSpeeds };
}

/**
 * An XY-plane arc (G17) as points along it, ending at the arc's end point.
 *
 * Centre from I/J (offsets from the start) or from R, where a negative R asks
 * for the long way round. Without either it degrades to the chord. Points are
 * spaced so the chord sags no more than 0.01 mm off the arc, capped at a few
 * hundred, which is finer than any status report and keeps a big circle cheap.
 */
function arcPoints(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  i: number | null, j: number | null, r: number | null,
  clockwise: boolean,
): Array<[number, number, number]> {
  let cx: number, cy: number;
  if (i !== null || j !== null) {
    cx = x0 + (i ?? 0);
    cy = y0 + (j ?? 0);
  } else if (r !== null && r !== 0) {
    const dx = x1 - x0, dy = y1 - y0;
    const chord = Math.hypot(dx, dy);
    const radius = Math.abs(r);
    if (chord === 0 || chord > 2 * radius + 1e-6) return [[x1, y1, z1]];
    const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
    // Which side of the chord the centre lies on: the short arc for R > 0.
    const side = (clockwise ? -1 : 1) * (r > 0 ? 1 : -1);
    cx = x0 + dx / 2 - (side * h * dy) / chord;
    cy = y0 + dy / 2 + (side * h * dx) / chord;
  } else {
    return [[x1, y1, z1]];
  }

  const radius = Math.hypot(x0 - cx, y0 - cy);
  if (radius === 0) return [[x1, y1, z1]];
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const a1 = Math.atan2(y1 - cy, x1 - cx);
  let sweep = a1 - a0;
  if (clockwise) { if (sweep >= -1e-9) sweep -= 2 * Math.PI; }
  else if (sweep <= 1e-9) sweep += 2 * Math.PI;

  const sagitta = 0.01;
  const step = radius > sagitta ? 2 * Math.acos(1 - sagitta / radius) : Math.PI / 2;
  const n = Math.min(360, Math.max(1, Math.ceil(Math.abs(sweep) / step)));
  const out: Array<[number, number, number]> = [];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const a = a0 + sweep * t;
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a), z0 + (z1 - z0) * t]);
  }
  out.push([x1, y1, z1]);
  return out;
}

/** A program on the clock, line by line. See `programTimeline`. */
export interface ProgramTimeline {
  /** Seconds into the program at which each line has finished running. */
  lineEnd: Float64Array;
  /** Seconds for the whole program; the same figure `estimateGcodeTime` gives. */
  total: number;
  /** The program's moves on that clock, each tagged with its line, dwells included. */
  moves: Array<ClockedMove & { line: number }>;
  /**
   * Index into `moves` of the first move on or after each line, with one extra
   * entry at the end. `moveStart[n]` is how many moves lines `0..n-1` make.
   */
  moveStart: Int32Array;
}

/**
 * When, in seconds from the start, each line of a program has finished.
 *
 * The estimate says how long the whole job takes; this says how far through
 * that time any one line is, which is what turns "the machine is on line 9,000"
 * into a progress figure. A line is not a unit of time — a rapid across the
 * stock is one line and a fraction of a second, a run of 0.2 mm raster steps is
 * hundreds of lines and barely moves — so the line number alone can't be one.
 *
 * Pass it the lines exactly as they are streamed (`prepareJobLines`), so its
 * indexes are the streamer's program-line numbers. Dwells are put on the clock
 * at the line that commands them rather than added on at the end. Lines that
 * don't move finish when the line before them did.
 */
export function programTimeline(lines: string[], opts: TimingOptions = {}): ProgramTimeline {
  const read = readProgram(lines);
  const clocked = clockMoves(read.moves, opts) as Array<ClockedMove & { line: number }>;

  const lineEnd = new Float64Array(lines.length);
  const moveStart = new Int32Array(lines.length + 1);
  let offset = 0;
  let end = 0;
  let m = 0;
  let d = 0;
  for (let i = 0; i < lines.length; i++) {
    moveStart[i] = m;
    for (; m < clocked.length && clocked[m].line === i; m++) {
      clocked[m].t0 += offset;
      clocked[m].t1 += offset;
      end = clocked[m].t1;
    }
    for (; d < read.dwells.length && read.dwells[d].line === i; d++) {
      offset += read.dwells[d].seconds;
      end += read.dwells[d].seconds;
    }
    lineEnd[i] = end;
  }
  moveStart[lines.length] = clocked.length;

  return { lineEnd, total: end, moves: clocked, moveStart };
}

/** "2 h 14 min", "7 min", "40 s" — a duration someone can plan an afternoon around. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export { DEFAULT_MOTION_PROFILE, type MotionProfile } from './motionProfile';
