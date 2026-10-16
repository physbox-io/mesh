import type { ClockedMove } from './timeEstimate';

/**
 * Following a running job along its preview path, from the position the
 * machine reports.
 *
 * Pure and store-free so it can be tested without a browser; `ToolpathView`
 * calls `trackPlayhead` once per status report.
 */

/** How far off the path the machine may report before a match is refused, mm. */
export const LIVE_SNAP_TOLERANCE_MM = 6;
/**
 * How much closer a later move has to be than an earlier one to win, mm.
 *
 * The preview is decimated and leaves out lead-ins, so a status report sits a
 * little off the path, and a pass further on over the same ground (the next
 * layer, the finishing raster) can come out a hair closer than the pass being
 * cut. Within this margin the earliest move wins. It is kept under a fine
 * stepover, so the pass the tool has moved onto still beats the one beside it.
 */
export const LIVE_TIE_MM = 0.1;
/** How many moves ahead of the last match the forward search looks. */
export const LIVE_SEARCH_WINDOW = 4000;
/** Half-width of the window searched round each anchor, as a fraction of the path. */
export const ANCHOR_WINDOW_FRACTION = 0.1;
/**
 * How many reports in a row must match behind the playhead before it is
 * allowed backwards. GRBL is polled every 300 ms, so this is a couple of
 * seconds: longer than a lead-in ramp or a hop the preview does not model,
 * shorter than the wait for a resume to start cutting.
 */
export const BACKWARD_CONFIRM_REPORTS = 8;

/** Squared distance from a point to the segment a move sweeps. */
export function distanceSqToMove(m: ClockedMove, x: number, y: number, z: number): number {
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const dz = m.z2 - m.z1;
  const lenSq = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (lenSq > 1e-12) {
    t = ((x - m.x1) * dx + (y - m.y1) * dy + (z - m.z1) * dz) / lenSq;
    t = Math.min(1, Math.max(0, t));
  }
  const px = m.x1 + dx * t - x;
  const py = m.y1 + dy * t - y;
  const pz = m.z1 + dz * t - z;
  return px * px + py * py + pz * pz;
}

/** The move in flight at time `t`, by binary search over the cumulative clock. */
export function moveIndexAt(moves: ClockedMove[], t: number): number {
  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].t1 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The nearest move in `[lo, hi)`, or null if none is within the snap tolerance.
 * Of the moves within `LIVE_TIE_MM` of the nearest, the earliest.
 */
function nearestWithin(
  moves: ClockedMove[],
  x: number,
  y: number,
  z: number,
  lo: number,
  hi: number
): { index: number; distSq: number } | null {
  let bestI = -1;
  let bestD = Infinity;
  for (let i = Math.max(0, lo); i < Math.min(moves.length, hi); i++) {
    const d = distanceSqToMove(moves[i], x, y, z);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  if (bestI < 0 || bestD > LIVE_SNAP_TOLERANCE_MM * LIVE_SNAP_TOLERANCE_MM) return null;
  const tie = (Math.sqrt(bestD) + LIVE_TIE_MM) ** 2;
  for (let i = Math.max(0, lo); i < bestI; i++) {
    const d = distanceSqToMove(moves[i], x, y, z);
    if (d <= tie) return { index: i, distSq: d };
  }
  return { index: bestI, distSq: bestD };
}

/** The clock at the point on move `i` nearest the position, so a long pass advances smoothly. */
function clockOnMove(m: ClockedMove, x: number, y: number, z: number): number {
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const dz = m.z2 - m.z1;
  const lenSq = dx * dx + dy * dy + dz * dz;
  let f = 0;
  if (lenSq > 1e-12) {
    f = ((x - m.x1) * dx + (y - m.y1) * dy + (z - m.z1) * dz) / lenSq;
    f = Math.min(1, Math.max(0, f));
  }
  return m.t0 + (m.t1 - m.t0) * f;
}

export interface PlayheadState {
  /** The move last matched; the forward search starts here. */
  index: number;
  /** Job seconds at the playhead. */
  clock: number;
  /** Consecutive reports that matched behind the playhead and were held back. */
  behind: number;
}

export const PLAYHEAD_START: PlayheadState = { index: 0, clock: 0, behind: 0 };

/**
 * Where on the program the machine is, given where it says the tool is.
 *
 * The position is projected onto the path rather than taken from the line
 * count, because lines are counted as they are *sent* — ahead of the cutter by
 * the planner buffer — and a line is not a unit of time.
 *
 * But a relief crosses itself constantly: roughing layers repeat the same XY a
 * stepdown apart, and every raster pass lies a stepover from its neighbours. So
 * the nearest point on the whole path is very often the wrong pass, and taking
 * it is what made the playhead leap between layers. Three things stop that:
 *
 * - The search runs forward from the last match first.
 * - When that misses, it looks only round the `anchors` — job clocks taken from
 *   signals that cannot wander between passes (time elapsed against the
 *   estimate, lines sent against the program) — and never the whole path. If
 *   nothing there is close either (a jog, a probe), the playhead holds.
 * - It does not go backwards on one report. A match behind the playhead has to
 *   persist for `BACKWARD_CONFIRM_REPORTS` reports, which a real step back (a
 *   resume from an earlier line) does and a stray match on an old pass does not.
 */
export function trackPlayhead(
  moves: ClockedMove[],
  x: number,
  y: number,
  z: number,
  prev: PlayheadState,
  anchors: number[]
): PlayheadState {
  if (moves.length === 0) return prev;

  const start = Math.min(Math.max(0, prev.index), moves.length - 1);
  let hit = nearestWithin(moves, x, y, z, start, start + LIVE_SEARCH_WINDOW);

  if (!hit) {
    const half = Math.max(1, Math.ceil(moves.length * ANCHOR_WINDOW_FRACTION));
    for (const t of anchors) {
      if (!Number.isFinite(t)) continue;
      const centre = moveIndexAt(moves, t);
      const found = nearestWithin(moves, x, y, z, centre - half, centre + half + 1);
      if (found && (!hit || found.distSq < hit.distSq)) hit = found;
    }
  }

  if (!hit) return prev;

  const clock = clockOnMove(moves[hit.index], x, y, z);
  if (clock >= prev.clock) return { index: hit.index, clock, behind: 0 };

  const behind = prev.behind + 1;
  if (behind >= BACKWARD_CONFIRM_REPORTS) return { index: hit.index, clock, behind: 0 };
  return { ...prev, behind };
}
