import type { HistoryEntry } from '../workers/physicsWorkerProtocol';

/**
 * How a headless run ended, body by body, so a caller does not have to read
 * the trajectory to find out.
 *
 * The question an agent asks of a run is nearly always "did it come to rest,
 * and how": a phone leaning in a stand, a ball in a cup. The trajectory holds
 * the answer but has to be read through, and the first stable-looking frame is
 * easily one swing of something still rocking. So the last half second is
 * judged here: a body has settled when it moved less than 1 mm/s and turned
 * less than 0.5 °/s throughout it, and is rocking when its tilt turned round
 * at least twice in the last second by more than a fifth of a degree.
 *
 * It is judged as the run goes, frame by frame (TrajectoryAccumulator), so a
 * headless run feeds it every tick and `final` does not depend on the stride
 * the trajectory was kept at: at stride 500 a ramp roll's turn used to alias
 * from 439° down to 79°, and `settled` was judged on the one kept frame that
 * fell in the last half second.
 */

/** Window over which a body must stay still to count as settled, in seconds. */
const SETTLE_WINDOW_S = 0.5;
const SETTLED_SPEED_MS = 0.001;
const SETTLED_TURN_RADS = (0.5 * Math.PI) / 180;
const ROCK_WINDOW_S = 1;
const ROCK_MIN_DEG = 0.2;

export interface BodyFinal {
  /** The body's name, where it differs from the id it is keyed by. */
  name?: string;
  posMm: [number, number, number];
  /** Angle between the body's own +Z and world up, in degrees. */
  tiltDeg: number;
  /**
   * How far the body turned over the whole run, in degrees: every step's turn
   * added up, so a wheel that went round twice says 720 and one that rocked
   * back and forth says how much it rocked.
   */
  turnedDeg: number;
  /** The angle between where the body started and where it ended, in degrees. */
  netTurnedDeg: number;
  speedMmS: number;
  angSpeedDegS: number;
  /** The fastest the body went over the run, mm/s and °/s. */
  peakSpeedMmS: number;
  peakAngSpeedDegS: number;
  settled: boolean;
  rocking: boolean;
}

export interface TrajectorySummary {
  /**
   * Every body and every joint settled. False when the run was too short to
   * judge. Judged on the whole scene, whatever `bodies` are listed.
   */
  settled: boolean;
  /** Body ids and joint names still moving at the end, when not settled. */
  moving?: string[];
  /** Seconds of simulated time the run covered. */
  durationS: number;
  bodies: Record<string, BodyFinal>;
}

/** World up expressed through a quaternion [w, x, y, z]: the rotated +Z's z. */
function tiltOf(q: number[]): number {
  const [, x, y] = q;
  const zz = 1 - 2 * (x * x + y * y);
  return (Math.acos(Math.max(-1, Math.min(1, zz))) * 180) / Math.PI;
}

/** Angle between two orientations, in degrees. */
function angleBetween(a: number[], b: number[]): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);

/**
 * The angle a body turned through between two kept frames. The shortest turn
 * between the two orientations is right while it is well under half a turn;
 * past a quarter turn per frame (a fast spinner with a coarse stride) it may
 * have aliased, and the body's own angular speed over the gap says more.
 */
function stepTurnDeg(q0: number[], q1: number[], w0: number[] | undefined, w1: number[] | undefined, dt: number): number {
  const shortest = angleBetween(q0, q1);
  if (shortest < 90 || !w0 || !w1 || !(dt > 0)) return shortest;
  return Math.max(shortest, (((len(w0) + len(w1)) / 2) * dt * 180) / Math.PI);
}

/**
 * Direction reversals of a series, counting only swings bigger than `min`.
 * The direction is first set by the first swing that big from the start, and
 * every turn after that counts.
 */
function reversals(series: number[], min: number): number {
  let turns = 0;
  let dir = 0;
  let hi = series[0];
  let lo = series[0];
  for (const v of series) {
    hi = Math.max(hi, v);
    lo = Math.min(lo, v);
    if (dir === 0) {
      if (v - lo > min) dir = 1;
      else if (hi - v > min) dir = -1;
      if (dir !== 0) hi = lo = v;
    } else if (dir > 0 && hi - v > min) {
      turns++;
      dir = -1;
      lo = v;
    } else if (dir < 0 && v - lo > min) {
      turns++;
      dir = 1;
      hi = v;
    }
  }
  return turns;
}

export interface SummaryOptions {
  /**
   * Joint types by name. A slide's speed is in m/s and a hinge's in rad/s, so
   * each is judged by its own limit; a joint with no known type is judged as
   * a slide, the stricter. Free and ball joints are left to their bodies.
   */
  jointTypes?: Record<string, string>;
}

/** Tilts are kept for the rock test no closer together than this, s: bounds memory at one frame a tick. */
const TILT_SAMPLE_S = 0.002;

interface BodyTrack {
  firstQuat?: number[];
  prev: { quat: number[]; angvel: number[]; time: number } | null;
  turned: number;
  /** Last frame time the body was over the settled speeds (or NaN). */
  lastMoving: number;
  /** (time, tilt) over the last ROCK_WINDOW_S, oldest first. */
  tiltT: number[];
  tilt: number[];
  end: BodyHistoryLike;
  seen: number;
  peakSpeed: number;
  peakAng: number;
}

type BodyHistoryLike = { pos: number[]; vel: number[]; angvel: number[]; quat?: number[] };

/**
 * `final`, built a frame at a time. Feed it every tick (or every kept frame)
 * in time order; `result()` judges the run up to the last frame fed.
 */
export class TrajectoryAccumulator {
  private bodies = new Map<string, BodyTrack>();
  /** Joint name -> last frame time it was over its settled speed. */
  private joints = new Map<string, number>();
  private firstTime = NaN;
  private lastTime = NaN;
  private readonly types: Record<string, string>;

  constructor(options: SummaryOptions = {}) {
    this.types = options.jointTypes ?? {};
  }

  add(frame: { time: number; bodies?: Record<string, BodyHistoryLike>; joints?: Record<string, { vel: number | number[] }> }): void {
    const t = frame.time;
    if (Number.isNaN(this.firstTime)) this.firstTime = t;
    this.lastTime = t;
    for (const [id, b] of Object.entries(frame.bodies || {})) {
      let k = this.bodies.get(id);
      if (!k) {
        k = { prev: null, turned: 0, lastMoving: -Infinity, tiltT: [], tilt: [], end: b, seen: t, peakSpeed: 0, peakAng: 0 };
        this.bodies.set(id, k);
      }
      k.end = b;
      k.seen = t;
      if (b.quat) {
        if (!k.firstQuat) k.firstQuat = b.quat;
        if (k.prev) k.turned += stepTurnDeg(k.prev.quat, b.quat, k.prev.angvel, b.angvel, t - k.prev.time);
        k.prev = { quat: b.quat, angvel: b.angvel, time: t };
        const n = k.tiltT.length;
        if (n === 0 || t - k.tiltT[n - 1] >= TILT_SAMPLE_S) { k.tiltT.push(t); k.tilt.push(tiltOf(b.quat)); }
        // Nothing older than a window before now can be in the last window.
        let drop = 0;
        while (drop < k.tiltT.length && k.tiltT[drop] < t - ROCK_WINDOW_S) drop++;
        if (drop > 64 || drop === k.tiltT.length) { k.tiltT.splice(0, drop); k.tilt.splice(0, drop); }
      }
      const v = len(b.vel), w = len(b.angvel);
      if (!(v <= SETTLED_SPEED_MS) || !(w <= SETTLED_TURN_RADS)) k.lastMoving = t;
      if (v > k.peakSpeed) k.peakSpeed = v;
      if (w > k.peakAng) k.peakAng = w;
    }
    // The joints as well: a joint whose body the frames do not carry would
    // otherwise turn unseen, and a NaN speed is never still.
    for (const [name, j] of Object.entries(frame.joints || {})) {
      // Free and ball joints carry vectors; their bodies are judged instead.
      if (typeof j.vel !== 'number') continue;
      const type = this.types[name];
      if (type === 'free' || type === 'ball') continue;
      const limit = type === 'hinge' ? SETTLED_TURN_RADS : SETTLED_SPEED_MS;
      if (!this.joints.has(name)) this.joints.set(name, -Infinity);
      if (!(Math.abs(j.vel) <= limit)) this.joints.set(name, t);
    }
  }

  result(): TrajectorySummary | null {
    if (Number.isNaN(this.lastTime)) return null;
    const durationS = this.lastTime - this.firstTime;
    const settleFrom = this.lastTime - SETTLE_WINDOW_S;
    const rockFrom = this.lastTime - ROCK_WINDOW_S;
    const judged = durationS >= SETTLE_WINDOW_S;

    const bodies: Record<string, BodyFinal> = {};
    const moving: string[] = [];
    let allSettled = judged;
    for (const [id, k] of this.bodies) {
      // Bodies of the last frame only: a body gone by then (shattered) has no end state.
      if (k.seen !== this.lastTime) continue;
      const end = k.end;
      const still = judged && k.lastMoving < settleFrom;
      const tilts = k.tilt.filter((_, i) => k.tiltT[i] >= rockFrom);
      const rocking = tilts.length > 2 && reversals(tilts, ROCK_MIN_DEG) >= 2;
      const settled = still && !rocking;
      if (!settled) { allSettled = false; if (judged) moving.push(id); }
      bodies[id] = {
        posMm: [end.pos[0] * 1000, end.pos[1] * 1000, end.pos[2] * 1000].map((v) => Math.round(v * 10) / 10) as [
          number,
          number,
          number,
        ],
        tiltDeg: end.quat ? Math.round(tiltOf(end.quat) * 10) / 10 : 0,
        turnedDeg: Math.round(k.turned * 10) / 10,
        netTurnedDeg: end.quat && k.firstQuat ? Math.round(angleBetween(k.firstQuat, end.quat) * 10) / 10 : 0,
        speedMmS: Math.round(len(end.vel) * 10000) / 10,
        angSpeedDegS: Math.round(((len(end.angvel) * 180) / Math.PI) * 10) / 10,
        peakSpeedMmS: Math.round(k.peakSpeed * 10000) / 10,
        peakAngSpeedDegS: Math.round(((k.peakAng * 180) / Math.PI) * 10) / 10,
        settled,
        rocking,
      };
    }
    if (judged) {
      for (const [name, last] of this.joints) {
        if (last >= settleFrom) { allSettled = false; moving.push(name); }
      }
    }
    return { settled: allSettled, ...(moving.length ? { moving } : {}), durationS, bodies };
  }
}

/** `final` from a list of frames (a kept trajectory). A run fed every tick is judged more exactly. */
export function summarizeTrajectory(trajectory: HistoryEntry[], options: SummaryOptions = {}): TrajectorySummary | null {
  const acc = new TrajectoryAccumulator(options);
  for (const frame of trajectory) acc.add(frame);
  return acc.result();
}
