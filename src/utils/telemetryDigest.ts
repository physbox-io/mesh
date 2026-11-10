// A run in a few hundred bytes: what moved, how far, what stayed put, which
// joints worked and how hard, what touched what, and when it all came to rest.
//
// For an agent that wants to know what happened, not to read 200 frames of
// positions. physics_run_headless and physics_get_history return it instead of
// their frames when asked for `summary: true`. It is read from the frames it
// is given, so a peak between two kept frames can be missed: callers keep a
// few hundred frames across the run, which is enough for travel and settling
// and says so for peaks.

import type { HistoryFrame } from '../workers/physicsWorkerProtocol';

export interface BodyDigest {
  /** Start to end, mm. */
  netMm: number;
  /** Fastest seen, mm/s. */
  peakSpeedMmS: number;
  /** Fastest turn seen, degrees/s: a pivoting arm moves without going anywhere. */
  peakTurnDegS: number;
  /** Where it ended, mm. */
  endMm: [number, number, number];
  /** Fell through the floor or flew more than 5 m. */
  leftScene?: true;
}

export interface JointDigest {
  type?: string;
  /** Max minus min position: degrees for a hinge, mm for a slide. */
  travel: number;
  unit: 'deg' | 'mm';
  range: [number, number];
  /** Largest motor or clutch effort seen, N*m (hinge) or N (slide). Only for driven joints. */
  peakEffort?: number;
}

export interface TelemetryDigest {
  durationS: number;
  frames: number;
  /** Every body under 1 mm/s from this time to the end; null if it never got there. */
  settledAtS: number | null;
  /** Bodies that moved (more than 1 mm net, 5 mm/s or 5 deg/s at some point), by name. */
  moved: Record<string, BodyDigest>;
  /** How many bodies did not move. */
  still: number;
  /** Joints that travelled more than half a degree or millimetre. */
  joints: Record<string, JointDigest>;
  /** The most contacts at once, and the body pairs in contact longest. */
  contacts?: { peak: number; longest: { pair: [string, string]; seconds: number }[] };
  note: string;
}

const SETTLED_MMS = 1;
const MOVED_MM = 1;
const MOVED_PEAK_MMS = 5;
const MOVED_PEAK_DEGS = 5;

export function digestTelemetry(
  frames: HistoryFrame[],
  opts: { jointTypes?: Record<string, string>; nameOf?: (id: string) => string } = {},
): TelemetryDigest | null {
  if (!frames.length) return null;
  const name = opts.nameOf ?? ((id: string) => id);
  const first = frames[0], last = frames[frames.length - 1];
  const durationS = last.time - first.time;

  // Bodies.
  const start = new Map<string, number[]>();
  const peak = new Map<string, number>();
  const peakTurn = new Map<string, number>();
  let settledAtS: number | null = first.time;
  for (const f of frames) {
    let anyMoving = false;
    for (const [id, b] of Object.entries(f.bodies ?? {})) {
      if (!start.has(id)) start.set(id, b.pos);
      const speed = Math.hypot(b.vel?.[0] ?? 0, b.vel?.[1] ?? 0, b.vel?.[2] ?? 0) * 1000;
      peak.set(id, Math.max(peak.get(id) ?? 0, speed));
      const turn = Math.hypot(b.angvel?.[0] ?? 0, b.angvel?.[1] ?? 0, b.angvel?.[2] ?? 0) * 180 / Math.PI;
      peakTurn.set(id, Math.max(peakTurn.get(id) ?? 0, turn));
      if (speed > SETTLED_MMS) anyMoving = true;
    }
    if (anyMoving) settledAtS = null;
    else if (settledAtS === null) settledAtS = f.time;
  }
  const moved: Record<string, BodyDigest> = {};
  let still = 0;
  for (const [id, b] of Object.entries(last.bodies ?? {})) {
    const s = start.get(id) ?? b.pos;
    const netMm = Math.hypot(b.pos[0] - s[0], b.pos[1] - s[1], b.pos[2] - s[2]) * 1000;
    const peakSpeedMmS = peak.get(id) ?? 0;
    const peakTurnDegS = peakTurn.get(id) ?? 0;
    if (netMm < MOVED_MM && peakSpeedMmS < MOVED_PEAK_MMS && peakTurnDegS < MOVED_PEAK_DEGS) { still++; continue; }
    const leftScene = b.pos[2] < -0.2 || Math.hypot(b.pos[0] - s[0], b.pos[1] - s[1]) > 5;
    moved[name(id)] = {
      netMm: round(netMm),
      peakSpeedMmS: round(peakSpeedMmS),
      peakTurnDegS: round(peakTurnDegS),
      endMm: [round(b.pos[0] * 1000), round(b.pos[1] * 1000), round(b.pos[2] * 1000)],
      ...(leftScene ? { leftScene: true as const } : {}),
    };
  }

  // Joints: hinge and slide (numeric positions).
  const lo = new Map<string, number>(), hi = new Map<string, number>(), effort = new Map<string, number>();
  for (const f of frames) {
    for (const [jn, j] of Object.entries(f.joints ?? {})) {
      if (typeof j.pos !== 'number') continue;
      lo.set(jn, Math.min(lo.get(jn) ?? Infinity, j.pos));
      hi.set(jn, Math.max(hi.get(jn) ?? -Infinity, j.pos));
      const e = Math.max(Math.abs(j.actuatorForce ?? 0), Math.abs(j.clutchTorque ?? 0));
      if (j.actuatorForce !== undefined || j.clutchTorque !== undefined) effort.set(jn, Math.max(effort.get(jn) ?? 0, e));
    }
  }
  const joints: Record<string, JointDigest> = {};
  for (const [jn, min] of lo) {
    const type = opts.jointTypes?.[jn];
    const slide = type === 'slide';
    const k = slide ? 1000 : 180 / Math.PI;
    const travel = (hi.get(jn)! - min) * k;
    if (travel < 0.5 && !effort.has(jn)) continue;
    joints[jn] = {
      ...(type ? { type } : {}),
      travel: round(travel),
      unit: slide ? 'mm' : 'deg',
      range: [round(min * k), round(hi.get(jn)! * k)],
      ...(effort.has(jn) ? { peakEffort: round(effort.get(jn)!, 3) } : {}),
    };
  }

  // Contacts, when the frames carry them.
  let contacts: TelemetryDigest['contacts'];
  if (frames.some((f) => f.contacts)) {
    let peakCount = 0;
    const time = new Map<string, number>();
    for (let i = 0; i < frames.length; i++) {
      const cs = frames[i].contacts ?? [];
      peakCount = Math.max(peakCount, cs.length);
      const dt = i + 1 < frames.length ? frames[i + 1].time - frames[i].time : 0;
      const pairs = new Set<string>();
      for (const c of cs) {
        const a = name(c.body1 ?? c.geom1), b = name(c.body2 ?? c.geom2);
        if (a === b) continue;
        pairs.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
      }
      for (const p of pairs) time.set(p, (time.get(p) ?? 0) + dt);
    }
    const longest = [...time.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)
      .map(([p, seconds]) => ({ pair: p.split('\u0000') as [string, string], seconds: round(seconds, 2) }));
    contacts = { peak: peakCount, longest };
  }

  return {
    durationS: round(durationS, 3),
    frames: frames.length,
    settledAtS: settledAtS === null ? null : round(settledAtS, 3),
    moved,
    still,
    joints,
    ...(contacts ? { contacts } : {}),
    note: frames.length === 1
      ? 'Read from a single frame: run or play the simulation for more.'
      : `Read from ${frames.length} frames across the run: a peak between two frames can be missed.`,
  };
}

function round(v: number, places = 1): number {
  const k = 10 ** places;
  return Math.round(v * k) / k;
}
