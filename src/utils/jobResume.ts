// ---------------------------------------------------------------------------
// Picking a job back up where it stopped
// ---------------------------------------------------------------------------
//
// Everything that ends a job early ends it in the same place: line eleven
// thousand of nineteen thousand, three hours in. A bit snaps, a limit switch
// twitches, the USB cable is nudged, the power blinks. Up to now every one of
// those meant starting the carve again from the top — recutting three hours of
// air and finished surface to get back to the point where it stopped, which on
// a relief is not merely slow but actively damaging.
//
// A G-code program cannot simply be entered in the middle, because almost
// nothing in it is self-contained. Line eleven thousand is `G1 X84.2 Y19.7` and
// it means nothing on its own: the units, the absolute-versus-incremental mode,
// the work coordinate system, the feedrate, the spindle speed and the Z the
// tool is supposed to be at were all set hundreds or thousands of lines earlier
// and have been in force ever since. Sending that line to a machine sitting at
// its home position with the spindle off does something arbitrary and probably
// expensive.
//
// So resuming means replaying: read the program from the top *without sending
// it*, accumulating the state each line would have left behind, and then write
// a short preamble that puts the machine back into that state before the stream
// restarts. That is what this file does. It sends nothing and talks to nothing
// — it turns a program and a line number into the lines that have to come
// first, which makes the interesting part of resuming something that can be
// tested rather than discovered on a ruined workpiece.

/** The state a G-code program carries forward from line to line. */
export interface ModalState {
  /** G20 (inches) or G21 (mm), whichever the program last selected. */
  units: 'G20' | 'G21';
  /** G90 (absolute) or G91 (incremental). */
  distance: 'G90' | 'G91';
  /** G17/G18/G19. */
  plane: 'G17' | 'G18' | 'G19';
  /** The work coordinate system in force, G54–G59. */
  wcs: string;
  /** The last F word, in the program's own units per minute. */
  feed: number | null;
  /** The spindle/laser state, or null if none was ever commanded. */
  spindle: { mode: 'M3' | 'M4'; rpm: number | null } | null;
  /**
   * Where the tool is once the scanned lines have run. Null on an axis the
   * program never mentioned — a laser job commands no Z at all.
   */
  position: { x: number | null; y: number | null; z: number | null };
  /**
   * The highest Z the program ever commands, which is its own retract height
   * and therefore the height at which it is known to be safe to traverse.
   *
   * Taken across the whole program rather than only the part that has run,
   * because the retract in force at the restart point may well be a plunge
   * depth — what is wanted is the height the program itself treats as clear.
   */
  safeZ: number | null;
  /**
   * True when something was seen that this scan cannot faithfully replay, so
   * the position it reports may be wrong.
   *
   * `G92` redefines the coordinate system mid-program and `G28`/`G30` jump to a
   * stored machine position; either makes the accumulated coordinates a fiction.
   * Nothing this app exports emits them, but a program that came from elsewhere
   * might, and quietly resuming into the wrong place is the one outcome worth
   * more than a refusal.
   */
  uncertain: boolean;
  /** What made it uncertain, for saying so. */
  uncertainBecause?: string;
}

const INITIAL: ModalState = {
  units: 'G21',
  distance: 'G90',
  plane: 'G17',
  wcs: 'G54',
  feed: null,
  spindle: null,
  position: { x: null, y: null, z: null },
  safeZ: null,
  uncertain: false,
};

/** Reads a word's value off a line, e.g. word('X', 'G1 X4.2 Y0') === 4.2. */
function word(code: string, letter: string): number | null {
  const m = new RegExp(`${letter}(-?\\d*\\.?\\d+)`, 'i').exec(code);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Whether a G or M code appears on the line, tolerating the leading zeros GRBL allows. */
function hasCode(code: string, letter: 'G' | 'M', n: number): boolean {
  return new RegExp(`\\b${letter}0*${n}\\b`, 'i').test(code);
}

/**
 * Replays `lines[0..upTo)` to work out the state line `upTo` would have run in.
 *
 * `lines` are the stripped code lines the sender actually streams, which is the
 * same numbering the progress display counts in — so "resume from line 11 000"
 * means the same thing to this function as it does to the operator reading it
 * off the screen.
 */
export function scanModalState(lines: string[], upTo: number): ModalState {
  const state: ModalState = {
    ...INITIAL,
    position: { ...INITIAL.position },
  };

  const limit = Math.max(0, Math.min(upTo, lines.length));

  // The retract height comes from the whole program, not just the part that ran.
  for (const raw of lines) {
    const z = word(raw, 'Z');
    if (z !== null && (state.safeZ === null || z > state.safeZ)) state.safeZ = z;
  }

  for (let i = 0; i < limit; i++) {
    const code = lines[i];

    if (hasCode(code, 'G', 20)) state.units = 'G20';
    if (hasCode(code, 'G', 21)) state.units = 'G21';
    if (hasCode(code, 'G', 90)) state.distance = 'G90';
    if (hasCode(code, 'G', 91)) state.distance = 'G91';
    if (hasCode(code, 'G', 17)) state.plane = 'G17';
    if (hasCode(code, 'G', 18)) state.plane = 'G18';
    if (hasCode(code, 'G', 19)) state.plane = 'G19';
    for (let w = 54; w <= 59; w++) if (hasCode(code, 'G', w)) state.wcs = `G${w}`;

    if (hasCode(code, 'G', 92) || hasCode(code, 'G', 28) || hasCode(code, 'G', 30)) {
      state.uncertain = true;
      state.uncertainBecause =
        'The program uses G92/G28/G30, which move or redefine the coordinate system part way ' +
        'through. Where the tool would be at this line cannot be worked out by reading the file.';
    }

    const f = word(code, 'F');
    if (f !== null && f > 0) state.feed = f;

    // The S word is the spindle speed even on lines that do not start it, and
    // on a laser it is the power, changing constantly.
    const s = word(code, 'S');
    if (hasCode(code, 'M', 3) || hasCode(code, 'M', 4)) {
      state.spindle = {
        mode: hasCode(code, 'M', 4) ? 'M4' : 'M3',
        rpm: s !== null ? s : state.spindle?.rpm ?? null,
      };
    } else if (hasCode(code, 'M', 5)) {
      state.spindle = null;
    } else if (s !== null && state.spindle) {
      state.spindle = { ...state.spindle, rpm: s };
    }

    // Only motion words move the tool. A bare `S1000` or `M5` does not.
    const isMotion =
      hasCode(code, 'G', 0) || hasCode(code, 'G', 1) || hasCode(code, 'G', 2) || hasCode(code, 'G', 3);
    const x = word(code, 'X');
    const y = word(code, 'Y');
    const z = word(code, 'Z');
    if (isMotion || x !== null || y !== null || z !== null) {
      const apply = (prev: number | null, next: number | null): number | null => {
        if (next === null) return prev;
        if (state.distance === 'G91') return (prev ?? 0) + next;
        return next;
      };
      state.position = {
        x: apply(state.position.x, x),
        y: apply(state.position.y, y),
        z: apply(state.position.z, z),
      };
    }
  }

  return state;
}

export interface ResumeOptions {
  /**
   * How fast to descend back into the cut, in the program's units per minute.
   * A rapid down to the cutting depth would arrive at full speed into stock
   * that is already there.
   */
  plungeFeed?: number;
  /** Seconds to let the spindle come up to speed before touching the work. */
  spindleWarmupSeconds?: number;
  /** Extra height above the program's own retract to traverse at. */
  extraClearance?: number;
}

/**
 * The lines that have to run before the stream restarts.
 *
 * The order matters and differs between a router and a laser. A router has to
 * have its spindle turning before the tool touches anything, so the spindle
 * comes back on first and the descent into the cut happens last. A laser has no
 * spinning-up to do and every millimetre travelled with the beam on is a cut,
 * so it is positioned *first* and the beam restored only once it is standing on
 * the restart point. Getting that the wrong way round scores a line straight
 * across the work on the way to picking up where it left off.
 *
 * Which one a program is comes from whether it ever commands a Z: a laser job
 * has no Z axis to command, and nothing else in a program says so as reliably.
 */
export function buildResumePreamble(
  state: ModalState,
  fromLine: number,
  options?: ResumeOptions
): string[] {
  const opt = {
    plungeFeed: options?.plungeFeed ?? 300,
    spindleWarmupSeconds: options?.spindleWarmupSeconds ?? 2,
    extraClearance: options?.extraClearance ?? 0,
  };

  const num = (v: number) => v.toFixed(3);
  const lines: string[] = [];
  const isLaser = state.position.z === null && state.safeZ === null;

  lines.push(`; --- RESUME AT LINE ${fromLine} ---`);
  lines.push(state.units);
  lines.push(state.distance === 'G91' ? 'G90' : state.distance);
  lines.push(state.plane);
  lines.push(state.wcs);

  const spindleLine = state.spindle
    ? `${state.spindle.mode}${state.spindle.rpm !== null ? ` S${Math.round(state.spindle.rpm)}` : ''}`
    : null;

  if (!isLaser) {
    // Up and clear before anything moves sideways.
    const clearZ = (state.safeZ ?? 5) + opt.extraClearance;
    lines.push(`G0 Z${num(clearZ)} ; retract to the program's own clear height`);

    if (spindleLine) {
      lines.push(`${spindleLine} ; spindle back to the speed the job was cut at`);
      if (opt.spindleWarmupSeconds > 0) lines.push(`G4 P${opt.spindleWarmupSeconds}`);
    }

    if (state.position.x !== null || state.position.y !== null) {
      const x = state.position.x ?? 0;
      const y = state.position.y ?? 0;
      lines.push(`G0 X${num(x)} Y${num(y)} ; over the point it stopped at`);
    }

    if (state.position.z !== null) {
      // Down at feedrate, not rapid: the tool is descending into stock that is
      // still there, and this is the one move in the preamble that cuts.
      lines.push(`G1 Z${num(state.position.z)} F${Math.round(opt.plungeFeed)} ; back down into the cut`);
    }
  } else {
    if (state.position.x !== null || state.position.y !== null) {
      const x = state.position.x ?? 0;
      const y = state.position.y ?? 0;
      // Beam still off — this traverse must not mark the work.
      lines.push(`G0 X${num(x)} Y${num(y)} ; over the point it stopped at, beam off`);
    }
    if (spindleLine) lines.push(`${spindleLine} ; beam back on, now that it is in position`);
  }

  if (state.feed !== null) lines.push(`F${Math.round(state.feed)} ; restore the cutting feed`);
  if (state.distance === 'G91') lines.push('G91 ; back to incremental, as the program left it');
  lines.push(`; --- resuming program ---`);

  return lines;
}

/** Everything needed to restart a program part way through. */
export interface ResumePlan {
  /** The lines to run before the program's own resume. */
  preamble: string[];
  /** The state the scan reconstructed, for showing the operator. */
  state: ModalState;
  /** The line the program itself picks up at. */
  fromLine: number;
}

/**
 * Plans a resume, which is the scan and the preamble taken together.
 *
 * The line to resume *at* is the one that had not finished, not the one after
 * it: a line that was cut off partway through was not completed, and running it
 * again is harmless — it re-cuts a path that has already been cut — while
 * skipping it leaves a gap.
 */
export function planResume(
  lines: string[],
  fromLine: number,
  options?: ResumeOptions
): ResumePlan {
  const clamped = Math.max(0, Math.min(fromLine, lines.length));
  const state = scanModalState(lines, clamped);
  return {
    preamble: buildResumePreamble(state, clamped, options),
    state,
    fromLine: clamped,
  };
}

/**
 * Which line the machine actually finished, given where it is standing.
 *
 * The streamer knows which line it *sent*, and that is not the same number.
 * GRBL answers `ok` when it has parsed a line, not when it has moved, and it
 * holds a planner buffer of parsed-but-unexecuted blocks — so at the moment a
 * feed hold stops the machine, the sent count is ahead of the cut by however
 * deep that buffer happened to be. Resuming from the sent line would step over
 * every buffered move and leave a gap in the middle of the job.
 *
 * The position, though, is not a guess: the machine is stationary and reporting
 * where it is. So the executed line is found by replaying the program and
 * taking the line whose end point the tool is actually standing on.
 *
 * Only a window behind the sent line is considered. The whole program is not a
 * candidate set — a raster crosses its own neighbours constantly and there are
 * thousands of lines whose end points sit within a stepover of each other, so a
 * global nearest-point search would cheerfully land on the wrong pass. The
 * window is bounded by how far the buffer can possibly have run ahead.
 *
 * Ties and near-misses resolve backwards, to the earliest line within the
 * tolerance. Rewinding too far recuts material that has already been cut, which
 * costs time and nothing else; not rewinding far enough leaves a stretch
 * uncut, which is a ruined workpiece.
 */
export function locateExecutedLine(
  lines: string[],
  at: { x: number; y: number; z: number },
  sentLine: number,
  lookBack = 64,
  toleranceMm = 0.05
): number {
  const hi = Math.max(0, Math.min(lines.length, sentLine));
  const lo = Math.max(0, hi - Math.max(1, lookBack));

  let best = lo;
  let bestDist = Infinity;

  for (let i = lo; i <= hi; i++) {
    const state = scanModalState(lines, i);
    const p = state.position;
    // A program that never mentions an axis says nothing about it — a laser job
    // commands no Z — so an absent axis is not evidence either way.
    const dx = p.x === null ? 0 : p.x - at.x;
    const dy = p.y === null ? 0 : p.y - at.y;
    const dz = p.z === null ? 0 : p.z - at.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Strictly less than, so the earliest of several equally good candidates
    // wins and the rewind errs backwards.
    if (dist < bestDist - 1e-9) {
      bestDist = dist;
      best = i;
      if (dist <= toleranceMm) break;
    }
  }

  return best;
}
