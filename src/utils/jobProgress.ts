import type { ProgramTimeline } from './timeEstimate';
import { distanceSqToMove } from './livePlayhead';

/**
 * Where in a running program the cutter actually is.
 *
 * The streamer knows exactly which lines it has sent and which GRBL has
 * acknowledged, and neither is the line being cut. GRBL acks a line when it has
 * parsed it into its planner, which holds fifteen blocks on a stock board, so
 * the acked count runs ahead of the tool by up to that many moves. GRBL can say
 * which line it is executing (`Ln:`) only when built with line numbers and fed
 * N-words, and neither is the case here.
 *
 * It can be pinned down anyway, because the line being cut is never far behind
 * the acked one:
 *
 * - Every move before the planner's contents has been cut. When the status
 *   report carries `Bf:` (planner blocks free) that is exact; otherwise the
 *   deepest planner going is assumed. That is a floor the progress cannot fall
 *   below.
 * - Within the few dozen moves behind the acked line, the position GRBL reports
 *   picks out the exact move and how far along it the tool is. That window
 *   keeps out a relief's earlier layers and passes, which is what made a
 *   search of the whole path jump between them. It does not keep out the next
 *   few finishing rows, so the match is held to the path itself and the
 *   earliest move that fits wins (see `CUT_SNAP_TOLERANCE_MM`).
 *
 * The answer is turned into seconds through the program with the per-line
 * clock from `programTimeline`, because a line is not a unit of time, and it
 * never moves backwards within a run.
 */

/**
 * GRBL's usable planner depth on a stock 328p build: the least a planner holds,
 * so the depth assumed for one whose `Bf:` has never been seen empty.
 */
export const DEFAULT_PLANNER_BLOCKS = 15;
/**
 * How many moves behind the acked line the position is matched against.
 * Wider than any planner on the boards this app drives (grblHAL builds run 32
 * or more), so a bigger planner than assumed still matches.
 */
export const CUT_SEARCH_MOVES = 64;
/**
 * How far off the program's path a reported position may be and still match,
 * mm. GRBL reports where the steps put the tool, so on the path it is within a
 * step and the report's three decimals; this allows for that and little else.
 *
 * It was a millimetre, which is wider than a finishing stepover. A relief's
 * finishing raster is rows 0.4 mm apart cut in fragments a millimetre or two
 * long, so the window behind the acks holds several rows, and a tool on one
 * row matched the next one along — or the rapid back across the stock that
 * starts it. The clock jumped ahead to that move and then, since it never goes
 * back, stood still until the tool caught up: a bar that lurched and stalled
 * through the whole finishing pass while roughing, its passes a cutter's width
 * apart, ran smoothly.
 */
export const CUT_SNAP_TOLERANCE_MM = 0.1;

export interface CutState {
  /** Seconds through the program, on the timeline's clock. */
  seconds: number;
  /** The move the cutter was last placed on; the search never starts before it. */
  move: number;
}

export const CUT_START: CutState = { seconds: 0, move: 0 };

export interface CutObservation {
  /** Program lines GRBL has acknowledged: lines `0..acked-1` are in its planner or done. */
  acked: number;
  /** Planner blocks still to run, from `Bf:`, or null when the report doesn't carry it. */
  plannerBlocksInUse: number | null;
  /** The line a resumed run picked up at; nothing before it is part of this run. */
  floorLine: number;
  /** Work position from the status report, or null if there isn't one to use. */
  pos: { x: number; y: number; z: number } | null;
}

/** Seconds at the start of move `k`, or at the end of the acked lines if `k` is past them. */
function startOfMove(tl: ProgramTimeline, k: number, acked: number): number {
  if (k < tl.moveStart[acked]) return tl.moves[k].t0;
  return acked > 0 ? tl.lineEnd[acked - 1] : 0;
}

/** The clock at the point on a move nearest the position. */
function clockOnMove(tl: ProgramTimeline, k: number, x: number, y: number, z: number): number {
  const m = tl.moves[k];
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

/** Moves the cutter forward from `prev` on one status report. */
export function locateCut(tl: ProgramTimeline, obs: CutObservation, prev: CutState): CutState {
  const lines = tl.lineEnd.length;
  if (lines === 0) return prev;
  const acked = Math.max(0, Math.min(lines, obs.acked));
  const floorLine = Math.max(0, Math.min(lines, obs.floorLine));
  const ackedMoves = tl.moveStart[acked];
  const firstMove = tl.moveStart[floorLine];

  // Everything before the planner's contents has run. One block of slack while
  // anything is in it: GRBL frees a block once its steps are prepared, which
  // can be a moment before the last of them has moved. An empty planner is
  // empty, and everything acked has run.
  //
  // Without `Bf:` the planner is taken to be as deep as the search window, not
  // a stock board's fifteen. The floor has to be a point the tool has passed,
  // and on a deeper planner (grblHAL, most 32-bit boards) acked-minus-fifteen
  // is ahead of the tool: the clock jumped to it, the search then started past
  // the move the tool was really on, and nothing moved until the tool caught
  // up. Long moves hid it; a finishing raster's millimetre fragments, each
  // with a retract and a rapid, made it a lurch every few seconds. Too deep a
  // guess only puts the floor further back, where the position takes over.
  const inPlanner = obs.plannerBlocksInUse ?? CUT_SEARCH_MOVES;
  const floorMove = Math.max(firstMove, ackedMoves - inPlanner - (inPlanner > 0 ? 1 : 0));
  let seconds = Math.max(prev.seconds, startOfMove(tl, floorMove, acked));
  let move = Math.max(prev.move, floorMove);

  if (obs.pos) {
    const { x, y, z } = obs.pos;
    const lo = Math.max(firstMove, prev.move, ackedMoves - CUT_SEARCH_MOVES);
    // The earliest move the position lies on, not the nearest or the latest.
    // Where the path crosses or retraces itself — a ramp going back over its
    // own line, a rapid passing over a cut — the position is on both, and
    // taking the later one is a jump the clock can never undo; taking the
    // earlier one is a lag the next report makes up. A point on a junction
    // goes to the move ending there, at the same clock as the next one's start.
    const tolSq = CUT_SNAP_TOLERANCE_MM * CUT_SNAP_TOLERANCE_MM;
    let best = -1;
    for (let k = lo; k < ackedMoves; k++) {
      if (distanceSqToMove(tl.moves[k], x, y, z) <= tolSq) {
        best = k;
        break;
      }
    }
    if (best >= 0) {
      const at = clockOnMove(tl, best, x, y, z);
      if (at > seconds) seconds = at;
      if (best > move) move = best;
    }
  }

  // Never past what GRBL has actually been given.
  const ceiling = acked > 0 ? tl.lineEnd[acked - 1] : 0;
  return { seconds: Math.min(seconds, Math.max(ceiling, prev.seconds)), move };
}

/**
 * The line being cut at `seconds`: the first one that hasn't finished by then.
 *
 * That is also the line a resume would restart on, which is why the progress
 * readout quotes it.
 */
export function lineAtSeconds(tl: ProgramTimeline, seconds: number): number {
  let lo = 0;
  let hi = tl.lineEnd.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tl.lineEnd[mid] <= seconds) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Seconds at the start of a line, which is where a resumed run's progress begins. */
export function secondsAtLine(tl: ProgramTimeline, line: number): number {
  if (line <= 0 || tl.lineEnd.length === 0) return 0;
  return tl.lineEnd[Math.min(line, tl.lineEnd.length) - 1];
}
