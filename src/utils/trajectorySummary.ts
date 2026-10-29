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
  /** How far the body has turned since the first frame, in degrees. */
  turnedDeg: number;
  speedMmS: number;
  angSpeedDegS: number;
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

export function summarizeTrajectory(trajectory: HistoryEntry[], options: SummaryOptions = {}): TrajectorySummary | null {
  if (trajectory.length === 0) return null;
  const first = trajectory[0];
  const last = trajectory[trajectory.length - 1];
  const durationS = last.time - first.time;
  const settleFrom = last.time - SETTLE_WINDOW_S;
  const rockFrom = last.time - ROCK_WINDOW_S;
  const judged = durationS >= SETTLE_WINDOW_S;

  const bodies: Record<string, BodyFinal> = {};
  const moving: string[] = [];
  let allSettled = judged;
  for (const [id, end] of Object.entries(last.bodies || {})) {
    let still = judged;
    const tilts: number[] = [];
    for (const frame of trajectory) {
      const b = frame.bodies?.[id];
      if (!b) continue;
      if (frame.time >= settleFrom) {
        if (len(b.vel) > SETTLED_SPEED_MS || len(b.angvel) > SETTLED_TURN_RADS) still = false;
      }
      if (frame.time >= rockFrom && b.quat) tilts.push(tiltOf(b.quat));
    }
    const rocking = tilts.length > 2 && reversals(tilts, ROCK_MIN_DEG) >= 2;
    const settled = still && !rocking;
    if (!settled) { allSettled = false; if (judged) moving.push(id); }
    const startQuat = first.bodies?.[id]?.quat;
    bodies[id] = {
      posMm: [end.pos[0] * 1000, end.pos[1] * 1000, end.pos[2] * 1000].map((v) => Math.round(v * 10) / 10) as [
        number,
        number,
        number,
      ],
      tiltDeg: end.quat ? Math.round(tiltOf(end.quat) * 10) / 10 : 0,
      turnedDeg: end.quat && startQuat ? Math.round(angleBetween(startQuat, end.quat) * 10) / 10 : 0,
      speedMmS: Math.round(len(end.vel) * 10000) / 10,
      angSpeedDegS: Math.round(((len(end.angvel) * 180) / Math.PI) * 10) / 10,
      settled,
      rocking,
    };
  }
  // The joints as well: a joint whose body the frames do not carry would
  // otherwise turn unseen, and a NaN speed is never still.
  if (judged) {
    const types = options.jointTypes ?? {};
    const fastest: Record<string, number> = {};
    for (const frame of trajectory) {
      if (frame.time < settleFrom) continue;
      for (const [name, j] of Object.entries(frame.joints || {})) {
        // Free and ball joints carry vectors; their bodies are judged instead.
        if (typeof j.vel !== 'number') continue;
        const v = Math.abs(j.vel);
        if (!(v <= (fastest[name] ?? 0))) fastest[name] = v;
      }
    }
    for (const [name, v] of Object.entries(fastest)) {
      const type = types[name];
      if (type === 'free' || type === 'ball') continue;
      const limit = type === 'hinge' ? SETTLED_TURN_RADS : SETTLED_SPEED_MS;
      if (!(v <= limit)) { allSettled = false; moving.push(name); }
    }
  }
  return { settled: allSettled, ...(moving.length ? { moving } : {}), durationS, bodies };
}
