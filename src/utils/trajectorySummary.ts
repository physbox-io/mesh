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
  /** Every body settled. False when the run was too short to judge. */
  settled: boolean;
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

export function summarizeTrajectory(trajectory: HistoryEntry[]): TrajectorySummary | null {
  if (trajectory.length === 0) return null;
  const first = trajectory[0];
  const last = trajectory[trajectory.length - 1];
  const durationS = last.time - first.time;
  const settleFrom = last.time - SETTLE_WINDOW_S;
  const rockFrom = last.time - ROCK_WINDOW_S;
  const judged = durationS >= SETTLE_WINDOW_S;

  const bodies: Record<string, BodyFinal> = {};
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
    if (!settled) allSettled = false;
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
  return { settled: allSettled, durationS, bodies };
}
