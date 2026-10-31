// ---------------------------------------------------------------------------
// WebSerial Connection & Machine Controller Manager
// Supports GRBL / Marlin serial communication, homing, zeroing, framing trace,
// interactive pauses for Manual Tool Changes (M6) and Material Swaps (M0), and
// an operator feed hold that can be lifted again without losing the program.
// ---------------------------------------------------------------------------

import {
  AckTimeoutError,
  GrblMachine,
  TelemetryThrottle,
  FEED_OVERRIDE_BYTES,
  RAPID_OVERRIDE_BYTES,
  SPINDLE_OVERRIDE_BYTES,
  locateExecutedLine,
  normalizeGrid,
  planResume,
  scanModalState,
  type FrameJobOptions,
  type JobPauseKind,
  type MachineState as BaseMachineState,
  type MachineStatus,
  type OverrideStep,
  type ProbeGrid,
  type ResolvedFrames,
  type ResumeOptions,
  type StatusReport,
} from '@physbox-io/machining';

export class StreamAbortedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Job stream aborted (${reason})`);
    this.reason = reason;
    this.name = 'StreamAbortedError';
  }
}
import {
  machineSocketUrl,
  postMachineTelemetry,
  submitMachineJob,
  type MachiningTelemetry,
  type RemoteCommand,
} from './apiClient';
import { cloudAutosave } from './cloudDocuments';
import { cncBedStore } from './printBedSettings';
import { programTimeline, type ProgramTimeline } from './timeEstimate';
import { splitGcodeComments } from './gcodeComments';
import {
  CUT_START,
  DEFAULT_PLANNER_BLOCKS,
  lineAtSeconds,
  locateCut,
  secondsAtLine,
  type CutState,
} from './jobProgress';
import {
  adoptCheckpoint,
  beginCheckpoint,
  clearCheckpoint,
  getRunProgramDocumentId,
  recordProgress,
  type CheckpointProgram,
  type PendingPause,
} from './jobCheckpoint';
import {
  DEFAULT_SPINDLE_PWM_MAX,
  GUIDE_JIGGLE_FEED_MM_MIN,
  GUIDE_JIGGLE_PATTERN,
  GUIDE_JIGGLE_REPLY_TIMEOUT_MS,
  GUIDE_JIGGLE_STEP_MM,
  GUIDE_SPOT_TIMEOUT_MS,
  guidePowerToS,
  readGuideJiggle,
  readGuidePower,
  readLaserModeBorrowed,
  writeLaserModeBorrowed,
} from './guideSpot';
import {
  DEFAULT_MOTION_PROFILE,
  motionProfileFromSettings,
  type MotionProfile,
} from './motionProfile';
import { readSpindleMaxOverride, spindleCeilingRefusal, withSpindleOverride } from './spindleOverride';

/*
 * One vocabulary across the three apps.
 *
 * This used to spell the operator's own feed hold `PAUSED_USER` while Volt and
 * Etch called the same state `PAUSED_OPERATOR`, which is the sort of difference
 * that costs nothing until something has to speak to all three — an agent, in
 * this case, being told a machine is in a state its tools have never heard of.
 */
export type { MachineStatus };

/** Where a job sits in a part machined from more than one face. */
export interface JobSetup {
  /** The same for every setup of one part's program. */
  sequenceId: string;
  /** 1-based. */
  index: number;
  of: number;
  /** How this setup finds the part again: pins in the bed, or touching off on the block. */
  locate: 'pins' | 'knownSpot';
  /** The operator has confirmed the block is down on its pins. Only means something with pins. */
  pinsSeated?: boolean;
}

export interface MachineState extends BaseMachineState {
  /**
   * The next setup of a part machined from more than one face, once the one
   * before it has finished: the block has to be turned and re-zeroed before
   * it runs. Null when nothing is waiting.
   */
  setupPending?: { sequenceId: string; next: number; of: number; locate: 'pins' | 'knownSpot' } | null;
  status: MachineStatus;
  connected: boolean;
  portName?: string;
  mpos: { x: number; y: number; z: number };
  wpos: { x: number; y: number; z: number };
  /**
   * The program line the cutter is on — not the line last sent, which runs
   * ahead of it by GRBL's serial buffer and planner. See `jobProgress.ts`.
   * It is also the line a resume from here would restart on.
   */
  currentLine: number;
  totalLines: number;
  /**
   * How far through the program the cutter is, by time rather than by lines.
   *
   * Taken from the line being cut (`currentLine`, refined by where the tool is
   * along it) and the per-line clock from `programTimeline`. A line is not a
   * unit of time — a rapid across the stock is one line and a fraction of a
   * second, a raster pass is hundreds of short ones — so "62% of the lines" and
   * "62% of the way through" are different numbers, and this is the second.
   * It only moves forward within a run, holds still through pauses, and a
   * resumed run starts at the share of the job its line had reached.
   *
   * A job handed to a cloud device has no line stream to read, and falls back
   * to elapsed time against the quoted estimate.
   */
  progressPercent: number;
  /** Time left at the current feed override, or null when nothing can say. */
  remainingSeconds: number | null;
  /**
   * Seconds since the job started cutting, and the run time it was quoted at.
   * Both are readouts only; `progressPercent` is the progress.
   */
  elapsedSeconds: number;
  estimatedSeconds: number | null;
  pauseMessage?: string;
  lastError?: string;
  /** Live feed and spindle, as reported in GRBL's `FS:` status field. */
  feedRate: number;
  spindleSpeed: number;
  /**
   * Whether the work Z datum is unknown, stale, or otherwise not to be
   * trusted for a Z move.
   *
   * True the moment a connection is opened: GRBL keeps G54's Z offset in
   * EEPROM across sessions, tools and stock changes, so a datum that reads
   * as perfectly valid may belong to a different setup entirely, and there is
   * nothing in a status report that says whether *this* operator has zeroed
   * *this* Z since. A tool change mid-job invalidates it the same way — two
   * bits are never the same length, so the zero touched off on the roughing
   * mill is wrong by whatever the difference is the moment the finishing bit
   * goes in, and wrong in the direction of driving the new tool into the
   * work. Nothing on the machine knows either has happened, so the app has to
   * remember it and say so, rather than letting a Z move look like an
   * ordinary one.
   *
   * Set on connect and when a job pauses for a tool change; cleared only by
   * a zeroing route that actually writes a Z offset (`zeroZHere`, `zeroZ`,
   * `zeroAllHere`) — never by starting a job, which is the moment it matters
   * most and proves nothing about whether Z was re-touched off.
   */
  needsZZero: boolean;
  /**
   * Whether the machine has homed since it connected or last alarmed. Until
   * then `MPos` is wherever the steppers were at power-on, and nothing measured
   * in machine coordinates (the work envelope) means anything.
   */
  hasHomed: boolean;
  /**
   * What this machine can actually do, read from its own `$$` settings.
   *
   * Falls back to the assumed hobby-router profile while nothing is connected,
   * and says which it is, because a run-time estimate built on invented
   * acceleration figures is a guess and should not be dressed up as anything
   * else. `$120` alone spans a factor of fifty across the machines this app
   * drives.
   */
  motion: MotionProfile;
  /** Every `$N=value` the controller reported, for anything else that needs one. */
  grblSettings: Record<number, number>;
  /**
   * Live feed, rapid and spindle overrides as percentages, from the
   * controller's own `Ov:` report.
   *
   * Read rather than tallied. An override survives a page reload, is cleared by
   * a reset, and can be changed from a pendant while this app is watching, so a
   * readout that counted its own clicks would be wrong after any of those.
   * `Ov:` rides along every tenth status report or so, like `WCO`, so the last
   * one seen is retained.
   */
  overrides: { feed: number; rapid: number; spindle: number };
  /**
   * The program that stopped early, and where it got to.
   *
   * Everything that ends a carve early ends it three hours in, and until now
   * every one of those meant running the whole file again from the top. Holding
   * on to the line it reached costs nothing and is the difference between
   * losing twenty minutes and losing an afternoon.
   *
   * Null whenever there is nothing to pick up: before the first job, and after
   * one runs to its end.
   */
  resume: ResumePoint | null;
  /**
   * A job stood down mid-cut so the machine can be driven around.
   *
   * Distinct from `resume`, which is the wreckage of a job that ended badly.
   * This one is deliberate and is expected to be picked up again, and it
   * carries the position the tool was standing at so it can be put back.
   */
  park: ParkPoint | null;
  /** Whether the laser is lit at pointer power. See `src/utils/guideSpot.ts`. */
  guideSpot: boolean;
  /**
   * Nothing has come back from the controller for several seconds.
   *
   * Worth a state of its own because it is invisible otherwise, and because it
   * is the difference between the two failures that look identical from the
   * front: a job that is streaming slowly, and a job that is not streaming at
   * all. The app pushes a `?` at the controller five times a second, so silence
   * for seconds means the link back is dead — a wrong baud rate, a lead with no
   * receive line in it, a controller that has crashed — and a program stopped
   * at line one waiting for an `ok` that is never coming looks exactly like a
   * button that did nothing.
   */
  controllerSilent: boolean;
  /** The controller reports the probe input closed right now (`Pn:P`). */
  probePinActive: boolean;
  /**
   * The probe input has been seen to close at least once on this connection.
   *
   * Every probe here is a `G38.2`, which the controller stops on contact — so
   * the one way a probe drives the bit through the work is a circuit that
   * never closes: a clip left off, a lead on the wrong side of the collet, a
   * tip glazed from the last cut. Nothing in the controller can tell that
   * apart from "not there yet" until the search runs out. Touching the bit to
   * the plate by hand before the first stab proves the circuit, and every
   * continuity probe is refused until that has happened.
   */
  probeCircuitSeen: boolean;
  /**
   * The last job that ran to its final line, for the "Job Succeeded" notice.
   *
   * Set in one place only: the pump, when the last line of the program has
   * been acknowledged. Every other way a job ends — E-Stop, an alarm, a dropped
   * connection, a discarded park — goes through `abandonJob` or `discardPark`
   * and leaves this alone, so its presence means the program really did finish.
   * Cleared when the next job starts. `finishedAt` is what tells one finish
   * from the next, so a notice dismissed for one job does not hide the next.
   */
  lastCompletedJob: CompletedJob | null;
}

/** What a job that ran to the end took. */
export interface CompletedJob {
  finishedAt: number;
  elapsedSeconds: number;
  estimatedSeconds: number | null;
  totalLines: number;
}

/** A job set aside mid-cut, with the machine free to be moved. */
export interface ParkPoint {
  /** The line the machine had actually finished, not the line last sent. */
  fromLine: number;
  totalLines: number;
  /** Where the tool was standing when the cut stopped, in work coordinates. */
  at: { x: number; y: number; z: number };
}

/** A program that stopped early, kept so it can be picked back up. */
export interface ResumePoint {
  /**
   * The line to pick it up from, in the numbering the progress display counts
   * in. Not the line it stopped on: wound back past anything the controller had
   * acknowledged but not yet run, and never behind a tool change or programmed
   * stop. It is the suggestion the Run From field starts at.
   */
  fromLine: number;
  /**
   * The line the stream had reached when it stopped, when that is not
   * `fromLine`. Shown beside the suggestion so the operator can see how far
   * back it winds, and judge whether to go back further.
   */
  stoppedAtLine?: number;
  /**
   * What the controller or the app said when it stopped, in words.
   *
   * Kept here rather than read from `lastError`, because unlocking the alarm —
   * the first thing anyone does next — clears `lastError`, and the offer outlives
   * it. A refused line said "line 4,210 refused (error:22)" and the banner then
   * said only "the controller alarmed", which is the wrong failure to go and fix.
   */
  message?: string;
  totalLines: number;
  /**
   * What ended it, which is what decides how alarming to make the offer.
   *
   * `interrupted` is the one nothing in this session witnessed: a job found in
   * storage after the tab, the browser or the laptop went away mid-cut. Nothing
   * stopped it in any orderly sense — it simply stopped being streamed — so the
   * machine has since been power-cycled, and the warnings are harder.
   */
  reason: 'alarm' | 'cancelled' | 'disconnected' | 'interrupted';
  /**
   * The program was read back from storage rather than streamed from here.
   *
   * Worth flagging on its own because everything the controller knew is gone
   * with it: the homing, the work offsets that were not in EEPROM, and the tool
   * that was in the spindle. A resume banner for one of these has to say so.
   */
  restored?: boolean;
  /** The reached line may be up to a minute behind the cut. See `loadCheckpoint`. */
  approximate?: boolean;
  /**
   * The job had already stopped at a tool change or programmed stop when it
   * ended, and everything before it had been cut. The offer then lands on that
   * line, and the banner says what was being asked for — which is what makes
   * "zero Z before resuming" make sense after an alarm that looked random.
   */
  pendingPause?: PendingPause;
  /** The job this offer belongs to, so another job's Start can say what it would discard. */
  jobName?: string | null;
  /** Where a restored job was found, and when it ran. Only set when `restored`. */
  from?: {
    source: 'local' | 'cloud';
    jobName: string | null;
    startedAt: number;
    stoppedAt: number;
  };
}

/**
 * How often a running job's position is published to api.physbox.io.
 *
 * The dashboard is watched by someone who has walked away from the machine, so
 * it wants seconds of latency, not milliseconds — and the status poll below
 * runs at 5 Hz, so publishing on every state change would be a request every
 * 200 ms for the length of a job. A relief carve runs for hours.
 */
const TELEMETRY_INTERVAL_MS = 2000;

/** One prepared program line: what the controller gets, and what it was for. */
export interface JobLine {
  /** The command with its comment stripped. */
  code: string;
  /** The trailing comment, if the exporter wrote one. Never sent. */
  note: string;
}

/**
 * Strips a program down to the lines a controller should receive.
 *
 * GRBL's serial input buffer is 128 bytes and the stream is paced one `ok` at a
 * time, so a comment sent down the wire costs a slot that a move could have had.
 * A relief carve is tens of thousands of lines and stalls the spindle in the cut
 * if it streams slower than it mills, which is the whole reason not to send
 * text the machine will only throw away.
 *
 * The comments are kept rather than dropped, because the pause prompts are
 * written in them: the exporter is the only thing that knows a `T2 M6` means the
 * 3.175 mm ball nose.
 */
export function prepareJobLines(gcode: string): JobLine[] {
  const out: JobLine[] = [];
  for (const raw of gcode.split('\n')) {
    /*
     * Parenthesised comments count too.
     *
     * G-code has two comment syntaxes and this file used to know about one of
     * them, which mattered more than it sounds: the sheet-swap pause is written
     * `M0 (PAUSE: Insert Material Sheet 2 of 3)`, and with the parens unread
     * the prompt at the machine said "Programmed stop. Resume when ready." to
     * an operator holding three sheets of ply and no way to tell which one.
     */
    const { code, notes } = splitGcodeComments(raw);
    const note = notes.join(' ');

    if (!code) continue;
    out.push({ code, note });
  }
  return out;
}

/**
 * Whether a line is a deliberate stop the operator has to act on.
 *
 * Matched on word boundaries rather than by substring: `M30` ends the program
 * and `M03` starts the spindle, and a job that paused for either would sit
 * waiting for a tool change that never comes, at the end of a carve that is
 * already finished.
 */

/**
 * GRBL's serial receive buffer, in bytes.
 *
 * The controller acknowledges a line when it has *parsed* it, not when it has
 * moved, so the streamer is free to keep the buffer full — and has to, because
 * a job streamed one line at a time can never fill the 15-block planner behind
 * it. With nothing queued to plan against, GRBL decelerates to a stop at the
 * end of every block, which on a finishing raster of half-millimetre moves is
 * a stop at every point: slow, and it chatters.
 */
const GRBL_RX_BUFFER_BYTES = 128;

/**
 * How much of that buffer the streamer will fill.
 *
 * Short of the real figure on purpose. The count here is of bytes *written*,
 * and it can only be an estimate of what the controller still holds: the reply
 * for a line may already be on the wire when the next one is queued. Leaving a
 * margin means an estimate that runs slightly optimistic still cannot overflow
 * the buffer, and the difference in throughput between 112 and 128 bytes is
 * nothing next to what overflowing costs.
 */
const RX_FILL_BYTES = GRBL_RX_BUFFER_BYTES - 16;

export function classifyJobLine(line: string): 'tool-change' | 'stop' | 'motion' {
  const code = line.toUpperCase();
  if (/\bM0*6\b/.test(code)) return 'tool-change';
  if (/\bM0*[01]\b/.test(code)) return 'stop';
  return 'motion';
}

/**
 * What GRBL's error numbers mean, for the ones a job actually hits.
 *
 * `error:9` on its own sends an operator to a forum. Written out, it is a
 * machine that needs unlocking and a job that can be run again in ten seconds —
 * and the same is true of most of these. Only the codes a streaming program can
 * realistically produce are here; the rest fall back to saying so plainly
 * rather than being guessed at.
 */
export function describeGrblError(line: string): string {
  const code = Number(/error:\s*(\d+)/i.exec(line)?.[1]);
  switch (code) {
    case 1:
    case 20:
      return 'The controller did not recognise a command in the program — check the machine profile it was exported for.';
    case 2:
      return 'A number in that line was malformed.';
    case 8:
      return 'That setting can only be changed while the machine is idle.';
    case 9:
      return 'The machine is locked out — it is in alarm, and will refuse G-code until it is homed or unlocked ($X).';
    case 15:
      return 'The move runs outside the machine\'s travel. Check where work zero is set.';
    case 22:
      return 'No feed rate was in effect for a cutting move.';
    case 24:
      return 'Two motions were commanded on one line.';
    case 25:
      return 'A G-code word was repeated on one line.';
    case 33:
      return 'The move is not geometrically valid — usually an arc whose radius does not reach its end point.';
    default:
      return 'The controller did not say more than that.';
  }
}

/*
 * The override bytes are the protocol, not a choice, so they come from
 * `@physbox-io/machining` along with the rest of it — the three apps had three
 * identical copies of these tables. Re-exported because this module's own
 * consumers import them from here.
 */
export { FEED_OVERRIDE_BYTES, SPINDLE_OVERRIDE_BYTES, RAPID_OVERRIDE_BYTES };
export type { OverrideStep };

/**
 * How long a tool-change pause waits for the moves already sent to be cut.
 *
 * GRBL's planner holds only a handful of blocks, but grblHAL builds hold
 * dozens and a slow finishing feed spreads them over minutes. Running out of
 * patience here leaves the pause unparked, which is safe; lifting early is not.
 */
const PAUSE_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * How far a Z zeroing probe searches for the plate. The tool is parked a few
 * millimetres above it first, so this only has to cover that gap; it used to
 * be 25mm, which on a circuit that failed to close was a 25mm drive through
 * the work.
 */
export const ZERO_SEARCH_MM = 10;

/**
 * How far below the homing pull-off point a machine-referenced retract stops.
 *
 * Homing leaves the tool at `MPos -$27`, the pull-off, which is only just
 * clear of the switch. A retract to a millimetre under the ceiling sat on that
 * edge with the default `$27=1`, and a switch with a few tenths of hysteresis
 * trips there. So the retract stops this far below the pull-off point instead.
 */
const RETRACT_BELOW_PULLOFF_MM = 1;

/**
 * How long a jog, or a line that puts the beam out, waits for its `ok`.
 *
 * Short, because both are waited on by something the operator is watching: a
 * job that will not start until the guide spot is out, a jog pad that holds
 * the next click until this one is accepted.
 */
const QUICK_REPLY_TIMEOUT_MS = 3000;

/** Rapid traverse trim: GRBL implements full, half and quarter, and no more. */

export type MachineStateListener = (state: MachineState) => void;

/** Which wire to open, and where. */
export type MachineLink =
  | { kind: 'usb'; baudRate?: number }
  | {
      kind: 'cloud';
      /** The paired machine's id, from `fetchMachineDevices`. */
      deviceId: string;
      /** Shown in the UI; falls back to a generic label. */
      deviceName?: string;
    };

/**
 * How long a line may go unanswered before the job is given up on.
 *
 * As long as the longest pause drain, because a dwell at a pause is answered
 * only once the planner is empty, and that is the longest any line here waits.
 * There used to be no limit at all; the silence watchdog (`controllerSilent`)
 * is what notices a controller that has stopped answering.
 */
const JOB_ACK_TIMEOUT_MS = PAUSE_DRAIN_TIMEOUT_MS;

/**
 * Mesh's machine: `GrblMachine` from `@physbox-io/machining`, which owns the
 * wire, the line queue, the status frames, jogging, probing and the streaming
 * loop, shared with Etch and Volt. What is here is Mesh's: progress read off
 * where the cutter is rather than off the acks, resume-from-line and park,
 * checkpoints that survive the tab, the tool-change lift and park, the laser
 * guide spot, and telemetry.
 */
class WebSerialManager extends GrblMachine<MachineState> {
  constructor() {
    super({
      endpoints: { machineSocketUrl, submitMachineJob },
      rxFillBytes: RX_FILL_BYTES,
      ackTimeoutMs: JOB_ACK_TIMEOUT_MS,
      statusPollMs: 300,
    });
    this.assumeZeroWorkOffset();
  }

  /**
   * Reads work position as machine position until the controller reports a
   * `WCO:`, which it does only every ten to thirty reports.
   *
   * This app has always made that assumption, and its tool-change lift is
   * built on it: the job's peak work Z comes off the reports in between. The
   * package's own default is to hold the last work position instead, which
   * before the first `WCO` is a zero that never moves.
   */
  private assumeZeroWorkOffset(): void {
    if (!this.lastWco) this.lastWco = { x: 0, y: 0, z: 0 };
  }

  /** The paired device's name, for the label of a cloud connection. */
  private cloudDeviceName: string | undefined;

  /** Trailing comments, index-aligned with `gcodeQueue`, for the pause prompts. */
  private gcodeNotes: string[] = [];
  /**
   * The whole program as it was handed over, kept for the length of the session.
   *
   * Separate from `gcodeQueue` because the queue is what is left to send, and a
   * resume rewrites it: it becomes a preamble that puts the machine back into
   * the state the program had reached, followed by the tail of the program. The
   * original has to survive that so a second resume — the bit snapped twice —
   * still has something to count lines against.
   */
  private program: JobLine[] = [];
  /**
   * The program-line number that `gcodeQueue[0]` corresponds to.
   *
   * Zero for a job run from the start. Negative during a resume's preamble,
   * which is lines that are not in the program at all, so the reported progress
   * clamps rather than counting backwards.
   */
  private jobLineBase = 0;

  /**
   * The program on the clock, line by line, for reading progress off the line
   * being cut. Built whenever `program` is set; null for a job a cloud device
   * runs by itself, which has no line stream here to read.
   */
  private timeline: ProgramTimeline | null = null;
  /** Program lines GRBL has acknowledged this run: `0..ackedLines-1` are planned or cut. */
  private ackedLines = 0;
  /** Where this run picked the program up: 0 from the start, the resume line otherwise. */
  private cutFloorLine = 0;
  /** Where the cutter was last placed. See `advanceCut`. */
  private cut: CutState = CUT_START;
  /**
   * The planner's depth and its free blocks, from `Bf:`. GRBL reports it only
   * when `$10` asks, so both stay null on a stock setup; the depth is the most
   * free blocks ever seen, which is the planner sitting empty.
   */
  private plannerSize: number | null = null;
  private plannerFree: number | null = null;

  /** Wall clock the current job started cutting at, or null between jobs. */
  private jobStartedAt: number | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Publishes the elapsed clock once a second while a job runs.
   *
   * A second is the resolution the readout is written at, and polling faster
   * would only re-render the same string. Paused time still counts: the piece
   * is still on the machine and the operator is still waiting on it.
   */
  private startElapsedTicker() {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = setInterval(() => {
      if (this.jobStartedAt === null) return;
      const elapsedSeconds = Math.round((Date.now() - this.jobStartedAt) / 1000);
      const estimate = this.state.estimatedSeconds;
      // A job a cloud device is running has no acks or lines here to read, so
      // the clock against the quote is all there is. Short of 100 until the
      // device says it has finished.
      if (this.timeline === null && estimate) {
        this.updateState({
          elapsedSeconds,
          progressPercent: Math.min(99, (elapsedSeconds / estimate) * 100),
          remainingSeconds: Math.max(0, estimate - elapsedSeconds),
        });
      } else {
        this.updateState({ elapsedSeconds });
      }
    }, 1000);
  }

  /**
   * Starts this run's progress at `fromLine`, against the program as it stands.
   *
   * The timeline is rebuilt here rather than kept, so it is timed with the
   * motion profile of the machine connected now.
   */
  private beginCutTracking(fromLine: number): Partial<MachineState> {
    this.timeline = this.program.length > 0
      ? programTimeline(this.program.map((l) => l.code), { profile: this.state.motion })
      : null;
    this.ackedLines = fromLine;
    this.cutFloorLine = fromLine;
    const tl = this.timeline;
    this.cut = tl
      ? { seconds: secondsAtLine(tl, fromLine), move: tl.moveStart[Math.min(fromLine, tl.lineEnd.length)] }
      : CUT_START;
    return this.cutProgress();
  }

  /**
   * Places the cutter from one status report, and the progress that follows.
   *
   * `plannerBlocksInUse` overrides the report's `Bf:` — a drained buffer is
   * known to be empty without asking.
   */
  private advanceCut(
    pos: { x: number; y: number; z: number } | null,
    plannerBlocksInUse?: number
  ): Partial<MachineState> {
    const tl = this.timeline;
    if (!tl) return {};
    // The depth is never taken as less than a stock board's: the most free
    // blocks seen is only the depth once the planner has been seen empty, and
    // assuming too deep a planner merely puts the floor further back.
    const inUse = plannerBlocksInUse
      ?? (this.plannerFree !== null
        ? Math.max(DEFAULT_PLANNER_BLOCKS, this.plannerSize ?? 0) - this.plannerFree
        : null);
    this.cut = locateCut(
      tl,
      { acked: this.ackedLines, plannerBlocksInUse: inUse, floorLine: this.cutFloorLine, pos },
      this.cut
    );
    const patch = this.cutProgress();
    // Throttled inside, to a storage write every couple of seconds. The cut
    // line rather than the sent one, so a job picked back up after the tab
    // went away restarts where the tool was, not a planner's worth past it.
    if (this.isJobRunning && !this.isPaused) recordProgress(patch.currentLine ?? 0, 'streaming');
    return patch;
  }

  /** `currentLine`, `progressPercent` and `remainingSeconds` from the cut state. */
  private cutProgress(): Partial<MachineState> {
    const tl = this.timeline;
    if (!tl) return {};
    const total = tl.total;
    const seconds = Math.min(total, this.cut.seconds);
    // Never past the next line GRBL hasn't been given. That line may be a tool
    // change, which takes no time and so would otherwise be counted as done.
    const currentLine = Math.min(lineAtSeconds(tl, seconds), this.ackedLines, tl.lineEnd.length);
    const feed = Math.max(10, this.state.overrides?.feed ?? 100);
    return {
      currentLine,
      progressPercent: total > 0 ? Math.round((seconds / total) * 10000) / 100 : 0,
      remainingSeconds: Math.max(0, total - seconds) * (100 / feed),
    };
  }

  private stopElapsedTicker() {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.jobStartedAt = null;
  }

  /** Set from the status report; see `parseStatusReport`. */
  private lastHoldState: 'decelerating' | 'complete' | null = null;
  /**
   * The highest work Z this job has been seen at, from the status reports.
   *
   * On a machine that has not been homed this is the only height the app
   * knows the tool can reach: it has just been there, on the same datum. A
   * tool-change lift asks for no more than this, because a blind relative lift
   * on top of the program's own retract took a relief carve into the top limit
   * switch. Reset whenever a stream starts or resumes, since a resume may follow
   * a re-zero for a longer tool, which makes the same work Z a higher machine
   * position.
   */
  private jobPeakWorkZ: number | null = null;

  /**
   * The pause the stream stopped at, once everything sent before it has run.
   *
   * GRBL acks lines when it parses them, so when the pump reaches an `M6` up
   * to a planner's worth of moves are still to be cut. Once the `G4 P0` behind
   * them is acked they have all been cut, and the job stands exactly at the
   * pause line — so an alarm from then on, such as the lift tripping a switch,
   * resumes at that line rather than winding back into the last tool's path.
   */
  private drainedPause: { line: number; kind: 'tool-change' | 'stop'; message: string } | null = null;

  /** The controller's last refusal, and the line it refused. See `failJob`. */
  private lastRefusal: { reply: string; line: string | undefined } | null = null;
  /** The operator's "Z is already set" for the resume in progress. See `resumeJob`. */
  private zIsSetForResume = false;
  /** A start is waiting on the guide spot or stale replies. See `startJob`. */
  private starting = false;
  /** Pauses pressed during `starting`, waiting for the stream to begin. See `pauseJob`. */
  private awaitingStream: Array<() => void> = [];

  protected createInitialState(): MachineState {
    return {
      status: 'DISCONNECTED',
      connected: false,
      mpos: { x: 0, y: 0, z: 0 },
      wpos: { x: 0, y: 0, z: 0 },
      currentLine: 0,
      totalLines: 0,
      progressPercent: 0,
      remainingSeconds: null,
      feedRate: 0,
      spindleSpeed: 0,
      // Disconnected: there is no machine to have a stale datum, but nothing has
      // been zeroed either, so a move guarded on this must still be blocked.
      needsZZero: true,
      zDatumTrusted: false,
      motion: withSpindleOverride(DEFAULT_MOTION_PROFILE),
      grblSettings: {},
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      elapsedSeconds: 0,
      estimatedSeconds: null,
      resume: null,
      park: null,
      guideSpot: false,
      hasHomed: false,
      controllerSilent: false,
      probePinActive: false,
      probeCircuitSeen: false,
      lastCompletedJob: null,
      setupPending: null,
    };
  }

  /** The guide spot's own deadline, and the `$32` it borrowed to exist. */
  private guideSpotTimer: ReturnType<typeof setTimeout> | null = null;
  private guideSpotRestoreLaserMode = false;
  private guideJiggleRunning = false;

  /** Telemetry pacing — see `publishTelemetry`. */
  private telemetry = new TelemetryThrottle<MachiningTelemetry>({
    intervalMs: TELEMETRY_INTERVAL_MS,
    post: (frame) =>
      postMachineTelemetry('physics', frame).then((commands) => this.applyRemoteCommands(commands)),
  });
  /** Between `onLinkLost` and the link reading as closed. See `publishTelemetry`. */
  private linkGoing = false;
  /** What the running job is, as the run archive should remember it. */
  private jobContext: { name?: string; settings?: Record<string, unknown> | null } = {};
  /**
   * Datum bookkeeping for parts cut in several setups. Each event takes the
   * next number, so "zeroed since the last setup ended" is a comparison. Kept
   * per connection: a reload forgets the setup that ended, and the zeros with
   * it, so a later setup still needs zeroing in this session.
   */
  private datumSeq = 0;
  private zZeroedAt = 0;
  private xZeroedAt = 0;
  private yZeroedAt = 0;
  private setupEndedAt = 0;
  /** The setup the job on the wire belongs to, if it is one. */
  private runningSetup: JobSetup | null = null;

  protected onStateNotified(state: MachineState): void {
    this.publishTelemetry(state);
  }

  /**
   * Streams machine state to api.physbox.io so the remote dashboard and the
   * run archive have something to show.
   *
   * Paced by the shared `TelemetryThrottle`. Between sends there is a floor of
   * `TELEMETRY_INTERVAL_MS`, so the 5 Hz status poll does not turn into 5 Hz of
   * HTTP. A status *change* — the alarm, the tool-change pause, the end of the
   * job — jumps that floor, because those are exactly the moments the person
   * watching is waiting for. Nothing is sent for a browser tab sitting on the
   * editor with no machine, except the one frame that matters: a controller
   * dropping off mid-job, which closes the run as the crash it was rather than
   * leaving it "running" until the server times it out.
   */
  private publishTelemetry(state: MachineState) {
    // The link is being torn down: the frames in between describe a job being
    // stood down by the app, not anything the machine did. See `onLinkLost`.
    if (this.linkGoing && state.connected) return;
    if (!state.connected) {
      this.linkGoing = false;
      this.closeRunOnLinkLoss(state.lastError);
      return;
    }

    this.telemetry.offer(
      {
        status: state.status,
        // What is being cut, not what it is plugged into. The port name is the
        // fallback for a program nobody named — a jog or a hand-sent line.
        jobName: this.jobContext.name || state.portName,
        // What it is being cut from and with. Without it an archived run says how
        // long it took and nothing about what it produced.
        settings: this.jobContext.settings ?? null,
        progressPercent: state.progressPercent,
        currentLine: state.currentLine,
        totalLines: state.totalLines,
        // Work coordinates, not machine: the dashboard is read against the job,
        // and the job was posted about the work origin.
        xyz: { ...state.wpos },
        feedRate: state.feedRate,
        spindleSpeed: state.spindleSpeed,
        lastError: state.lastError ?? null,
        // Which cloud document this browser is working on, so the archived run points
        // back at the scene that produced it. Null when the account has no cloud
        // document, which is the ordinary case for a free or signed-out session.
        documentId: cloudAutosave.getStatus().documentId,
        documentRevision: cloudAutosave.getStatus().revision,
        // The program itself, stored as its own document when the account is Pro,
        // so the archive can say what was cut and not only how it went.
        programDocumentId: getRunProgramDocumentId(),
      },
      state.status,
      this.isJobRunning || this.isPaused
    );
  }

  /**
   * Closes the archived run as the crash it was, if a job was on the wire.
   *
   * The throttle only remembers a job frame while frames keep arriving with
   * the job still active, which is why `onLinkLost` stops offering frames
   * while it stands the job down.
   */
  private closeRunOnLinkLoss(lastError: string | undefined) {
    const reason = lastError ? ` (${lastError})` : '';
    this.telemetry.connectionLost((last) => ({
      ...last,
      status: 'error',
      lastError: `Lost the connection to the controller at line ${last.currentLine}${reason}.`,
    }));
  }

  /**
   * Acts on what was asked for from another device.
   *
   * Only while a job is actually on the wire. The queue is drained by the post
   * regardless, so a command that arrives against an idle machine is discarded
   * rather than held: it was aimed at a cut, and that cut is over.
   *
   * Sequentially, because the trims are realtime bytes and GRBL counts them —
   * two writes racing is two nudges in an order neither end chose.
   *
   * An unrecognised kind is ignored rather than guessed at. The server already
   * refuses to queue one this build has not claimed; this is the same rule
   * stated where it is enforced.
   */
  private async applyRemoteCommands(commands: RemoteCommand[]): Promise<void> {
    if (!commands?.length || !this.isRunning()) return;

    for (const c of commands) {
      try {
        if (c.kind === 'pause') {
          await this.pauseJob();
          continue;
        }

        if (c.kind === 'resume') {
          await this.resumeRemotely();
          continue;
        }

        if (c.kind === 'rapid') {
          if (c.step === 100 || c.step === 50 || c.step === 25) {
            await this.setRapidOverride(c.step);
          }
          continue;
        }
        if (c.kind !== 'feed' && c.kind !== 'spindle') continue;

        const nudge = c.step === 1 || c.step === -1 || c.step === 10 || c.step === -10 ? c.step : null;
        if (c.kind === 'feed') {
          if (nudge === null) await this.resetFeedOverride();
          else await this.nudgeFeedOverride(nudge);
        } else {
          if (nudge === null) await this.resetSpindleOverride();
          else await this.nudgeSpindleOverride(nudge);
        }
      } catch {
        // A dropped write is one nudge, and the next status report shows the
        // percentage that actually took. Nothing here is worth failing a post.
      }
    }
  }

  /**
   * Picks a job back up on the say-so of a device that cannot see the machine.
   *
   * Refused outright when the pause came from the program rather than from a
   * person — an M0 or an M6. Those mean somebody is at the bench with their
   * hands on the work, changing a tool or clearing a part, and the thing that
   * tells them it is safe to stand back is the operator pressing Resume where
   * they can see it. A phone in another room cannot know that, so it does not
   * get to decide it.
   *
   * An operator pause is the opposite case: it is a feed hold somebody asked
   * for, and picking it up is the whole point of being able to do this at all.
   * The tool is still in the cut and Z has not moved, so there is nothing to
   * put back before the stream restarts.
   *
   * The state is read from `status` rather than from a pause kind: a tool
   * change and a material swap are the two that park the machine, and they are
   * exactly the two that are refused here.
   */
  private async resumeRemotely(): Promise<void> {
    if (this.state.status !== 'PAUSED_OPERATOR') return;
    await this.resumeJob();
  }


  /**
   * The motion profile as the controller reported it, before the operator's
   * spindle override. `state.motion` is this with the override applied, so
   * changing the override can be undone without asking the machine again.
   */
  private reportedMotion: MotionProfile = DEFAULT_MOTION_PROFILE;

  /**
   * Which controller this is, for filing the spindle override under — the
   * cloud device's id, or what `$I` says the board is (its build and any name
   * set with `$I=`). Null until known, and for a controller that will not say,
   * which is when the unkeyed override applies. See `spindleOverride.ts`.
   */
  private machineKey: string | null = null;

  /** The key the spindle override for the connected controller is filed under. */
  public spindleOverrideKey(): string | null {
    return this.machineKey;
  }

  /**
   * `[VER:1.1h.20190825:My router]` from `$I`. The whole body is the identity:
   * the build alone would make every stock board of one release the same
   * machine, and the name alone is empty on most of them.
   */
  protected onUnhandledLine(line: string): void {
    const ver = /^\[VER:(.*)\]$/.exec(line.trim());
    if (ver && this.transportMode !== 'wifi') {
      this.machineKey = `grbl:${ver[1].trim()}`;
    }
  }

  protected updateState(patch: Partial<MachineState>): void {
    // Every write of the profile goes through the override, so no path that
    // sets it — connect, disconnect, a fresh `$$` — can forget to apply it.
    if (patch.motion) {
      this.reportedMotion = patch.motion;
      patch = { ...patch, motion: withSpindleOverride(patch.motion, readSpindleMaxOverride(this.machineKey)) };
    }
    // `needsZZero` is this app's name for the package's `zDatumTrusted`, the
    // other way up. The package sets one (a tool change), the UI reads the
    // other, and the two must never disagree.
    if (patch.zDatumTrusted !== undefined && patch.needsZZero === undefined) {
      patch = { ...patch, needsZZero: !patch.zDatumTrusted };
    } else if (patch.needsZZero !== undefined && patch.zDatumTrusted === undefined) {
      patch = { ...patch, zDatumTrusted: !patch.needsZZero };
    }
    super.updateState(patch);
  }


  /** Re-applies the spindle override after it changes, here or from the account. */
  public reapplySpindleOverride(): void {
    this.updateState({ motion: this.reportedMotion });
  }

  /** The controller's `$$` settings, in the shape the shared tools expect. */
  public getGrblSettings(): Map<number, number> {
    return new Map(
      Object.entries(this.state.grblSettings).map(([k, v]) => [Number(k), v] as [number, number])
    );
  }

  /**
   * Opens a wire to the machine.
   *
   * With no argument this is the wire chosen by `setTransport` — the USB
   * cable unless something said otherwise. Given a paired device it goes over
   * WiFi instead, through the physbox relay: the same GRBL on the other end
   * either way, which is why everything past the wire is unchanged by the
   * choice. A bare number is a baud rate, which is how the package's
   * `autoConnect` calls it.
   */
  public async connect(link?: MachineLink | number): Promise<boolean> {
    if (typeof link === 'object') {
      if (link.kind === 'cloud') {
        this.setTransport('wifi', link.deviceId);
        this.cloudDeviceName = link.deviceName;
      } else {
        this.setTransport('usb');
      }
    }
    const baudRate =
      typeof link === 'number' ? link : link?.kind === 'usb' ? link.baudRate ?? 115200 : 115200;

    /*
     * Whatever went wrong last time is not true any more.
     *
     * Nothing ever cleared this, so the message from a dropped cable — or a
     * connection attempt that failed once — outlived the machine coming back
     * and sat there for the rest of the session, telling someone looking at a
     * live connection that it had dropped. An error describes a moment, and
     * this is a new one.
     */
    this.updateState({ lastError: undefined });
    // A box on the cloud relay is named by its device id before it says
    // anything; a board on a cable has to be asked (`$I`, after `$$`).
    this.machineKey = this.transportMode === 'wifi' && this.getCloudDeviceId() ? `cloud:${this.getCloudDeviceId()}` : null;
    const ok = await super.connect(baudRate);
    // A failed connect is shown as disconnected with its reason, as it always
    // was here, rather than as the package's ERROR.
    if (!ok && this.state.status === 'ERROR') this.updateState({ status: 'DISCONNECTED' });
    return ok;
  }

  protected async onConnected(): Promise<void> {
    this.assumeZeroWorkOffset();
    // A freshly opened port may report a Z work offset left over from a
    // previous session, tool, or stock — GRBL has no way to say whether this
    // operator has touched it off since, so it starts untrusted. The probe
    // circuit likewise: whatever was proved last time belonged to the old
    // connection, and this may be a different machine.
    this.updateState({
      portName:
        this.transportMode === 'wifi' ? `${this.cloudDeviceName || 'machine'} (physbox cloud)` : 'USB Machine',
      needsZZero: true,
      probePinActive: false,
      probeCircuitSeen: false,
    });
    // Ask what it is before anything else needs to know. Not awaited: the
    // connection is usable the moment it is open, and a controller that is
    // slow to answer `$$` must not hold the UI on "connecting".
    void this.refreshMachineSettings();
  }

  /**
   * The wire is going — a pulled cable, a box that lost WiFi, or a deliberate
   * disconnect. Either way the same state is left behind.
   */
  protected onLinkLost(): void {
    // Before anything else: from here until the link reads as closed, nothing
    // is offered to the telemetry throttle. Standing the job down below clears
    // `isJobRunning`, and the very next state change — any machine whose `$$`
    // has been read has a non-empty `grblSettings` to wipe — used to be offered
    // as "no job" while the link still read as connected. That made the
    // throttle forget the job's last frame, so when `connected: false` arrived
    // there was no run left to close, and every real dropped cable left its run
    // "running" until the server timed it out. Closing the run right here was
    // tried too: the post was still in flight, and the next "connected, idle"
    // frame replaced it in the throttle's queue before it went out.
    //
    // The job's state as it stands is offered once first, so the frame the run
    // is closed from is the latest one even if no status report has changed
    // anything since the last.
    this.publishTelemetry(this.getState());
    this.linkGoing = true;
    this.clearGuideSpotTimeout();
    // While the job is still known to be running, so the line it reached is
    // kept: a nudged USB cable is the commonest way a long carve dies, and the
    // program is still right here.
    if (this.isJobRunning || this.isPaused) this.abandonJob('disconnected');
    this.parkToResume('disconnected');
    // Back to assumptions: the numbers belonged to a machine that is no longer
    // on the other end of the cable, and leaving them in place would have the
    // next estimate quietly claiming to have been read off nothing. Its spindle
    // override goes with it, for the same reason.
    this.machineKey = null;
    this.updateState({
      motion: DEFAULT_MOTION_PROFILE,
      grblSettings: {},
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      guideSpot: false,
      // No machine, no proved circuit: the next one on the cable proves its own.
      probePinActive: false,
      probeCircuitSeen: false,
    });
  }

  /**
   * The controller restarted — a soft reset, or a power cycle.
   *
   * The package has already dropped every line it was owed a reply for. A
   * restart nobody here asked for, mid-job, has stopped the program on the
   * controller, and the job is stood down with its line kept.
   */
  protected onControllerReset(): void {
    if (this.isJobRunning || this.isPaused) {
      const message =
        'The controller restarted in the middle of the job, so the job has stopped. ' +
        'Check where the tool is, re-home if the machine has lost its position, then resume.';
      this.abandonJob('alarm', message);
      this.stopElapsedTicker();
      this.updateState({ status: 'IDLE', lastError: message });
    }
  }

  /**
   * `ALARM:N`, said once, ahead of the `Alarm` state word the reports then
   * carry. A limit switch mid-carve kills the job on the controller — GRBL will
   * not run another line until it is unlocked — so the job is stood down here
   * with the line it reached kept, for the operator to pick back up once the
   * machine has been rehomed and the tool re-zeroed.
   */
  protected onAlarm(): void {
    if (this.isJobRunning || this.isPaused) this.abandonJob('alarm');
    this.parkToResume('alarm');
  }

  /**
   * A refused line. Remembered for `failJob`, which names the program line when
   * the refusal ends a job; outside a job it is shown as it stands.
   */
  protected onRefused(reply: string, line: string | undefined): void {
    this.lastRefusal = { reply, line };
    if (!this.isJobRunning && !this.isPaused) this.updateState({ lastError: `Machine Error: ${reply}` });
  }

  /**
   * A refused line ends the job, and says which line it was.
   *
   * The refusal is an ack that will not come again, so the stream would stall
   * on it and go on showing RUNNING at whatever percentage it had reached — a
   * job that had stopped dead, presented as one still cutting. Standing it down
   * keeps the resume point, so the operator can fix whatever was refused and
   * pick the program back up.
   */
  protected failJob(err: Error, at?: { queueIndex: number }): void {
    if (!this.isJobRunning && !this.isPaused) return;
    const refusal = this.lastRefusal;
    this.lastRefusal = null;
    const refused =
      at !== undefined && refusal !== null && refusal.line === this.gcodeQueue[at.queueIndex];
    const line = at !== undefined ? Math.max(0, this.jobLineBase + at.queueIndex + 1) : 0;
    const message = refused
      ? `The machine refused line ${line} of the program (${refusal.reply}), so the job has stopped ` +
        `there. ${describeGrblError(refusal.reply)}`
      : err.message;
    this.abandonJob('alarm', message);
    this.stopElapsedTicker();
    this.updateState({ status: 'IDLE', lastError: message });
  }

  /**
   * A parked job has let go of the stream, so it is neither running nor
   * paused, and the Idle it sits in read as "no job": the next report dropped
   * the status, and with it the way to resume. A report never moves the app
   * out of a park.
   */
  protected deriveStatus(report: StatusReport): MachineStatus {
    if (this.state.status === 'PAUSED_PARKED' && report.state !== 'Alarm') return 'PAUSED_PARKED';
    return super.deriveStatus(report);
  }

  /**
   * What this app reads off a status report beyond the positions and the state
   * word, which the package has already folded in.
   */
  protected onStatusReport(report: StatusReport, frames: ResolvedFrames): Partial<MachineState> {
    const machineWord = report.state;

    /*
     * Whether a feed hold has finished decelerating.
     *
     * GRBL says 'Hold:1' while the axes are still slowing and 'Hold:0' once
     * they have stopped. Parking waits on this: a soft reset taken while
     * anything is still moving loses the position and comes back in alarm,
     * which is the one outcome parking exists to avoid.
     */
    this.lastHoldState = machineWord === 'Hold' ? (report.subState === 0 ? 'complete' : 'decelerating') : null;

    const patch: Partial<MachineState> = {};

    // `Pn:P` — the asserted input pins. GRBL lists them only while one is
    // asserted, so a report with no `Pn` field means the probe is open.
    const probePinActive = /P/.test(report.pins ?? '');
    if (probePinActive !== this.state.probePinActive) patch.probePinActive = probePinActive;
    if (probePinActive && !this.state.probeCircuitSeen) patch.probeCircuitSeen = true;

    // The alarm word as well as the `ALARM:` line, which a controller does not
    // always send: the job is dropped so nothing streams on into a machine
    // that has lost its position.
    if (machineWord === 'Alarm' && (this.isJobRunning || this.isPaused)) this.abandonJob('alarm');
    if (machineWord === 'Alarm') this.parkToResume('alarm');

    // A job still starting counts: the package marks it running only once its
    // stream begins, and the heights seen meanwhile are this job's.
    const inJob = this.isJobRunning || this.isPaused || this.starting;
    if (inJob && machineWord !== 'Alarm') {
      this.jobPeakWorkZ = Math.max(this.jobPeakWorkZ ?? -Infinity, frames.wpos.z);
    }

    // `Bf:15,128` — planner blocks and serial bytes free. Only sent when `$10`
    // asks for it, and read only to say how far behind the acks the cut is.
    const bufferFree = report.buffer && Number.isFinite(report.buffer.blocks) ? report.buffer.blocks : null;
    this.plannerFree = bufferFree;
    if (bufferFree !== null) this.plannerSize = Math.max(this.plannerSize ?? 0, bufferFree);
    // Not on an alarm: the position is a fiction from then on, and the job has
    // been abandoned.
    if (inJob && machineWord !== 'Alarm') {
      Object.assign(patch, this.advanceCut(frames.wpos));
    }
    return patch;
  }

  /**
   * Sends one line and waits for the controller to accept it, giving up after
   * `timeoutMs` without giving up its place in the queue (its reply may still
   * come). A refusal still throws: a zeroing line the controller refused has
   * not zeroed anything, and must not be reported as though it had.
   */
  private async sendAndWait(command: string, timeoutMs = 30000): Promise<void> {
    if (!this.transport || !this.state.connected) return;
    try {
      await this.sendLine(command, { timeoutMs });
    } catch (err) {
      if (!(err instanceof AckTimeoutError)) throw err;
    }
  }


  /**
   * Runs one probing move and returns the machine Z where the tip touched, or
   * null if it never made contact. The wait is long because the tool travels
   * the whole search distance at probing feedrate before giving up.
   *
   * The probe is sent relative, so the search is a distance below wherever the
   * tool is now rather than an absolute Z that depends on where the datum was
   * set — under G90 a `Z-20` on a machine zeroed high is a 20 mm dive past it.
   */
  public async probePoint(searchDepthMm = ZERO_SEARCH_MM, feedrate = 50, timeoutMs = 120000): Promise<number | null> {
    if (!this.transport || !this.state.connected) return null;
    this.assertProbeCircuit();
    void timeoutMs;
    return this.probeOnce(searchDepthMm, feedrate);
  }

  /**
   * Why a continuity probe may not start right now, or null if it may. See
   * `probeCircuitSeen`.
   *
   * The opposite state is refused too: an input that reads closed with the
   * tool in the air is a lead shorted to the frame or `$6` set the wrong way,
   * and the controller would alarm on the first stab (ALARM:4) rather than
   * measure anything.
   */
  private probeCircuitFault(): string | null {
    if (this.state.probePinActive) {
      return (
        'The probe input already reads closed. If the tool is not touching the plate, the ' +
        'lead is shorted or the probe pin invert ($6) is set the wrong way — either way a ' +
        'probe cannot tell contact from open air, so it is not started.'
      );
    }
    if (!this.state.probeCircuitSeen) {
      return 'Probe circuit not verified this session. Touch the plate to the tool to confirm continuity before probing.';
    }
    return null;
  }

  /** `probeCircuitFault`, as a refusal the operator sees. */
  private assertProbeCircuit(): void {
    const fault = this.probeCircuitFault();
    if (!fault) return;
    this.updateState({ lastError: fault });
    throw new Error(fault);
  }

  /**
   * One `G38.2`, with the circuit already checked by the caller: the zero and
   * grid routines gate once up front, not per stab, because between points
   * the input is read off a poll that may not have caught the lift yet.
   *
   * The package's `probeDown` sends it relative and puts absolute mode back —
   * except into an alarm, which refuses the `G90` and would bury the alarm's
   * own message under that one; `unlockAlarm` restores it instead. Null for no
   * contact, and for anything else that ended the probe without a reading.
   */
  private async probeOnce(searchDepthMm: number, feedrate: number): Promise<number | null> {
    try {
      return (await this.probeDown(searchDepthMm, feedrate)).z;
    } catch {
      return null;
    }
  }


  /**
   * Why this controller cannot run a program as exported, or null.
   *
   * The program asking for more spindle than `$30` gives: GRBL clamps `S`, so
   * a job planned for a 24,000 RPM router run on a 10,000 RPM PWM spindle cuts
   * every feed at 2.4 times the chip load. Not when the operator has given this
   * machine a spindle override (its `S` drives nothing), and not on a laser.
   */
  private spindleBlockedReason(lines: readonly string[]): string | null {
    return spindleCeilingRefusal(lines, {
      maxRpm: this.state.grblSettings[30],
      laser: this.laserModeEnabled(),
      overridden: readSpindleMaxOverride(this.machineKey) !== null,
    });
  }

  /**
   * Runs a program, whichever way this connection runs programs.
   *
   * Over USB or on the LAN the browser is the streamer and everything below
   * applies. Through the cloud the device does it instead — see `runJob` on
   * `MachineTransport` — and the difference is checked here rather than in
   * every export modal, because which kind of wire is attached is not something
   * a modal should have to know.
   *
   * Resolves to null when the job was streamed from here, or to the relay's
   * answer when it was handed over.
   */
  public async runJob(
    gcode: string,
    options: {
      name?: string;
      estimatedSeconds?: number;
      settings?: Record<string, unknown> | null;
      /** Which setup of a several-face part this is. */
      setup?: JobSetup;
      /** Who asked. A later setup is only ever started by the operator at the machine. */
      origin?: 'ui' | 'mcp';
    } = {}
  ): Promise<{ delivered: boolean; message: string } | null> {
    /*
     * Recorded before anything is sent, and replaced outright by every job.
     *
     * The archive opens a run from the *first* telemetry frame that looks like
     * one and never revisits the settings it arrived with, so a context set
     * after streaming starts is a context that arrives too late — and one left
     * over from the last job would file this run under what the last one was
     * cut from.
     */
    // Not over the top of one already in flight: a new stream resets the byte
    // count while the old program's lines are still in GRBL's buffer, which
    // over MCP put 222 bytes into its 128-byte receive buffer. Checked before
    // the context below, which belongs to the job still running.
    if (this.isJobRunning || this.isPaused) {
      this.updateState({ lastError: 'A job is already running or paused. Cancel it before starting another.' });
      return null;
    }
    this.jobContext = { name: options.name, settings: options.settings ?? null };
    if (!this.transport || !this.state.connected) {
      this.updateState({ lastError: 'No machine is connected, so there was nothing to send the job to.' });
      return null;
    }

    // A laser job has no Z to plunge with, so an untouched Z datum cannot hurt
    // it — everything else routes a spinning or moving tool toward a surface
    // whose height this session has not actually confirmed.
    if (this.state.needsZZero && !this.laserModeEnabled()) {
      const message =
        'Z zero has not been set this session. Set Z zero in Machine Setup before running a job.';
      this.updateState({ lastError: message });
      return null;
    }

    /*
     * The checks `startJob` makes before streaming, made here for a job the
     * box will stream. The package's travel check lives in `streamProgram`,
     * which a handed-over job never reaches, so a Tekno Box ran programs that
     * went past the end of an axis that the same machine on a cable refused.
     * Before the setup bookkeeping below, which a refused job must not touch.
     */
    if (this.transport.runJob) {
      const codes = prepareJobLines(gcode).map((l) => l.code);
      const refusal = this.travelBlockedReason(codes) ?? this.spindleBlockedReason(codes);
      if (refusal) {
        this.updateState({ lastError: refusal });
        return { delivered: false, message: refusal };
      }
    }

    const setupRefusal = this.refuseSetup(options.setup, options.origin ?? 'ui', !!this.transport.runJob);
    if (setupRefusal) {
      this.updateState({ lastError: setupRefusal });
      return null;
    }
    this.runningSetup = options.setup ?? null;
    // The turn it was waiting for has been made, and its zeros checked.
    if (options.setup && this.state.setupPending) this.updateState({ setupPending: null });

    if (this.transport.runJob) {
      let result: { delivered: boolean; message: string };
      try {
        result = await this.transport.runJob(gcode, options);
      } catch (err: unknown) {
        // Handing a job over is a network request, and a request that fails has
        // to land somewhere the operator can see. Swallowed, it is a play
        // button that does nothing at all.
        const message =
          err instanceof Error ? err.message : 'The job could not be sent to the machine.';
        this.updateState({ status: 'IDLE', lastError: message });
        return { delivered: false, message };
      }
      // The device owns the clock now. What comes back arrives as progress over
      // the relay rather than being counted out here.
      // Nothing streams from here, so there is no line to read progress off.
      this.timeline = null;
      this.updateState({
        status: result.delivered ? 'RUNNING' : 'IDLE',
        estimatedSeconds: options.estimatedSeconds ?? null,
        elapsedSeconds: 0,
        progressPercent: 0,
        remainingSeconds: options.estimatedSeconds ?? null,
        // A job the box would not take is an error, and goes where errors are
        // shown. As a pause message on an IDLE machine nothing displayed it,
        // and the export modals ignore what this returns — so the play button
        // simply did nothing.
        pauseMessage: undefined,
        lastError: result.delivered ? undefined : result.message,
      });
      if (result.delivered) {
        this.jobStartedAt = Date.now();
        this.startElapsedTicker();
      }
      return result;
    }

    void this.startJob(gcode, options.estimatedSeconds);
    return null;
  }

  /**
   * Starts a program from its first line.
   *
   * Never throws: everything that refuses a job here says so in `lastError`,
   * which is where the export modals and MCP look.
   */
  public async startJob(gcode: string, estimatedSeconds?: number): Promise<void> {
    if (!this.state.connected) return;
    if (this.isJobRunning || this.isPaused || this.starting) return; // see runJob

    const prepared = prepareJobLines(gcode);
    // Before anything is set up for it: the package refuses it too, but by
    // then this job would already read as running.
    const codes = prepared.map((l) => l.code);
    const refusal = this.travelBlockedReason(codes) ?? this.spindleBlockedReason(codes);
    if (refusal) {
      this.updateState({ lastError: refusal });
      return;
    }

    this.jobStartedAt = Date.now();
    this.startElapsedTicker();

    this.program = prepared;
    this.gcodeNotes = prepared.map(l => l.note);
    this.jobLineBase = 0;
    this.jobPeakWorkZ = null;
    this.drainedPause = null;

    this.updateState({
      status: 'RUNNING',
      ...this.beginCutTracking(0),
      totalLines: prepared.length,
      elapsedSeconds: 0,
      estimatedSeconds: estimatedSeconds ?? null,
      // Pressing start is a new moment too: whatever the last attempt was
      // refused for is not what this one is doing.
      lastError: undefined,
      // A new program is a new job; whatever stopped the last one is no longer
      // something anyone can pick up.
      resume: null,
      park: null,
      lastCompletedJob: null,
      // needsZZero is left as-is deliberately: `runJob` has already refused to
      // reach here while Z is untrusted, and clearing it just because a program
      // started would be assuming the operator re-zeroed rather than checking.
    });

    /*
     * Written before the first line goes out, not after.
     *
     * The window this closes is the one that costs the most: a long job that is
     * interrupted by the tab going away takes its `program` with it, and until
     * it has been written down somewhere outside this object there is nothing to
     * resume into. The first move of a carve is also usually the deepest, so a
     * checkpoint that only started covering the job a minute in would miss the
     * part it would hurt most to recut.
     */
    beginCheckpoint({
      gcode,
      totalLines: prepared.length,
      jobName: this.jobContext.name ?? null,
      settings: this.jobContext.settings ?? null,
      documentId: cloudAutosave.getStatus().documentId,
    });

    await this.beginStreaming(prepared.map(l => l.code));
  }

  /**
   * Streams a prepared queue — a whole program, or a resume's preamble and the
   * tail of one.
   *
   * A lit guide spot goes out first, and the stream waits for it. Put out
   * alongside the stream, its `$32=1` reached GRBL behind the job's first lines
   * - and GRBL refuses a setting while it is running (error:8), which aborted
   * the job it had just started and left laser mode off. Its jiggle has to have
   * stopped too: GRBL takes no G-code while it is jogging. The package then
   * lets go of any reply still owed from before (see `letGoOfStaleAcks`).
   */
  private async beginStreaming(lines: string[]): Promise<void> {
    this.starting = true;
    const epoch = this.jobEpoch;
    try {
      if (this.state.guideSpot) await this.guideSpotOff();
      // Cancelled while the beam was going out.
      if (epoch !== this.jobEpoch || this.state.status !== 'RUNNING') return;
      // `starting` stays up until this settles: the package marks the job
      // running only after its own first await.
      await this.streamProgram({ lines, layers: [], spindleLine: null });
    } catch (err) {
      this.updateState({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      this.starting = false;
      this.releaseStreamWaiters();
    }
  }

  protected onJobStarted(): void {
    this.releaseStreamWaiters();
  }

  private releaseStreamWaiters(): void {
    const waiters = this.awaitingStream;
    this.awaitingStream = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * A feed hold, as the package makes it - including in the moment between
   * Start and the first line.
   *
   * The job shows as running from the click, but the package only takes it as
   * running once the guide spot is out and stale replies are let go of, up to
   * a second later. A pause pressed then found no job, did nothing, and the
   * program started anyway. So it waits for the stream to begin (the stream
   * has written at most its first line by then) and holds that.
   */
  public async pauseJob(): Promise<void> {
    if (this.starting && !this.isJobRunning) {
      await new Promise<void>((resolve) => this.awaitingStream.push(resolve));
    }
    await super.pauseJob();
  }

  /** Mesh refuses an unzeroed start itself, in `runJob`, with its own words. */
  protected assertReadyToCut(): void {}

  /** A laser focuses once by hand and its Z never moves during a job. */
  protected hasJobZAxis(): boolean {
    return !this.laserModeEnabled();
  }

  /**
   * Throws away the offer to pick a stopped job back up.
   *
   * The program itself is kept — the operator may still want to run it from the
   * start — but the offer stops being made.
   */
  public clearResumePoint(): void {
    // The stored copy goes with it. Discarding the offer is the operator saying
    // this job is over, and an offer that came back after a reload having just
    // been dismissed would be a bug rather than a kindness.
    clearCheckpoint();
    if (this.state.resume) this.updateState({ resume: null });
  }

  /**
   * Picks up a job left behind by a session that is no longer here.
   *
   * The counterpart to `loadCheckpoint`: the program is put back where
   * `resumeFromLine` looks for it, and the reached line is offered as a resume
   * point exactly as a snapped cutter's would be. From here on the two are the
   * same thing, which is the point — the resume machinery does not need to know
   * whether the program it is replaying was streamed an hour ago or yesterday.
   *
   * What is *not* the same is the machine. Nothing in this app stopped that job,
   * so the controller has been round a power cycle: not homed, holding whatever
   * offsets survived in EEPROM, with an unknown tool in the spindle. `restored`
   * carries that to the banner, and `needsZZero` is already true because a
   * connection sets it.
   */
  public restoreCheckpoint(
    program: CheckpointProgram,
    fromLine: number,
    from: NonNullable<ResumePoint['from']> & { approximate: boolean; pendingPause?: PendingPause }
  ): boolean {
    if (this.isJobRunning || this.isPaused) return false;

    const prepared = prepareJobLines(program.gcode);
    if (prepared.length === 0) return false;

    this.program = prepared;
    this.jobContext = { name: program.jobName ?? undefined, settings: program.settings };
    adoptCheckpoint(program);

    this.updateState({
      totalLines: prepared.length,
      ...this.beginCutTracking(Math.max(0, Math.min(prepared.length, fromLine))),
      resume: {
        fromLine: Math.max(0, Math.min(prepared.length, fromLine)),
        totalLines: prepared.length,
        reason: 'interrupted',
        restored: true,
        approximate: from.approximate,
        jobName: program.jobName ?? null,
        ...(from.pendingPause ? { pendingPause: from.pendingPause } : {}),
        from: {
          source: from.source,
          jobName: from.jobName,
          startedAt: from.startedAt,
          stoppedAt: from.stoppedAt,
        },
      },
    });
    return true;
  }

  /** How many lines the program has, which is what progress is measured against. */
  protected programLength(): number {
    return this.program.length;
  }

  /**
   * Restarts the stored program part way through.
   *
   * The hard part is not the streaming, it is that line eleven thousand of a
   * G-code file means nothing on its own — the units, the coordinate system,
   * the feedrate, the spindle speed and the depth the tool is meant to be at
   * were all established thousands of lines earlier. So the program is replayed
   * without being sent (see the package's `stream/resume`), and what comes back is a short
   * preamble that puts the machine into that state: retract, spindle back up to
   * speed, move over the point it stopped at, and only then descend into the
   * cut at a feedrate rather than a rapid.
   *
   * The preamble is prepended to the tail of the program and the whole thing is
   * streamed as one job, so a pause or a second failure part way through a
   * resumed job behaves exactly like any other.
   *
   * It refuses, in words, while `resumeBlockedReason` has one: a machine that
   * has lost its X/Y place, or a router whose Z datum is not trusted. Both are
   * checked here and not only by the buttons, because an agent's
   * `resume_from_line` arrives with no button in front of it.
   */
  public resumeFromLine(fromLine: number, options?: ResumeOptions): { ok: boolean; message: string } {
    if (!this.state.connected) {
      return { ok: false, message: 'Not connected to a machine.' };
    }
    if (this.isJobRunning || this.isPaused || this.starting) {
      return { ok: false, message: 'A job is already running. Cancel it before resuming another.' };
    }
    if (this.program.length === 0) {
      return { ok: false, message: 'There is no program to resume — nothing has been sent this session.' };
    }
    // Before anything is marked RUNNING. The package's `streamProgram` would
    // refuse a lost position too, but only once this had already set the
    // status, the clock and the line base, so the job read as running while
    // nothing was being sent.
    const blocked = this.resumeBlockedReason(options?.isLaser);
    if (blocked) {
      this.updateState({ lastError: blocked });
      return { ok: false, message: blocked };
    }

    fromLine = this.pastHandledToolChange(fromLine);

    const plan = planResume(this.program.map((l) => l.code), fromLine, {
      ...options,
      isLaser: this.jobIsLaser(options?.isLaser),
      currentZ: this.state.wpos.z,
      arrivingAtPause: this.lineIsPause(fromLine),
    });
    const preamble = prepareJobLines(plan.preamble.join('\n'));
    const tail = this.program.slice(plan.fromLine);
    // From wherever the tool was jogged to, the rest of the job still has to
    // fit the machine.
    const offTheBed = this.travelBlockedReason([...preamble, ...tail].map((l) => l.code));
    if (offTheBed) return { ok: false, message: offTheBed };

    this.gcodeNotes = [...preamble.map((l) => l.note), ...tail.map((l) => l.note)];
    // The preamble's lines are not in the program, so the program line that
    // queue position 0 corresponds to is behind where it picks up.
    this.jobLineBase = plan.fromLine - preamble.length;
    this.jobPeakWorkZ = null;
    this.drainedPause = null;

    // The clock carries on from what the job had already run, rather than
    // starting again or counting the time it spent stopped as cutting.
    this.jobStartedAt = Date.now() - this.state.elapsedSeconds * 1000;
    this.startElapsedTicker();

    this.updateState({
      status: 'RUNNING',
      ...this.beginCutTracking(plan.fromLine),
      totalLines: this.programLength(),
      resume: null,
      pauseMessage: undefined,
      lastCompletedJob: null,
    });

    void this.beginStreaming([...preamble.map((l) => l.code), ...tail.map((l) => l.code)]);

    return {
      ok: true,
      message: plan.state.uncertain
        ? `Resuming at line ${plan.fromLine}. ${plan.state.uncertainBecause}`
        : `Resuming at line ${plan.fromLine} of ${this.programLength()}.`,
    };
  }

  /**
   * Why a stopped job may not be picked up again right now, or null.
   *
   * Two things make a resume cut in the wrong place. An alarm, an unrequested
   * restart or a dropped link mid-job leaves the controller unsure of X and Y —
   * a hard limit that browns out the board brings it back reading zero wherever
   * the gantry stopped, while G54 survives in EEPROM — so the package holds
   * them lost until the machine homes or the operator zeroes them again. And a
   * router whose Z datum is untrusted (a fresh connection, a new bit) would
   * descend to the stopped depth measured from the wrong tip. A laser's Z never
   * moves in a job, so only the first applies to it.
   */
  public resumeBlockedReason(isLaser?: boolean): string | null {
    const position = this.positionBlockedReason();
    if (position) return position;
    if (this.state.needsZZero && !this.jobIsLaser(isLaser)) {
      return (
        'Z zero has not been set for the tool in the spindle. Zero Z in Machine Setup before resuming — ' +
        'the resume descends back to the depth the job had reached, measured from that zero.'
      );
    }
    return null;
  }

  /**
   * What a resume from a given line would do, without doing it.
   *
   * The preamble is the part worth reading before committing to it: it names
   * the depth the tool is about to be sent back down to, and that is the number
   * an operator wants to check against the workpiece in front of them.
   */
  public previewResume(fromLine: number, options?: ResumeOptions) {
    if (this.program.length === 0) return null;
    fromLine = this.pastHandledToolChange(fromLine);
    return planResume(this.program.map((l) => l.code), fromLine, {
      ...options,
      isLaser: this.jobIsLaser(options?.isLaser),
      arrivingAtPause: this.lineIsPause(fromLine),
    });
  }

  /**
   * Steps a resume past a tool change the operator has already made.
   *
   * An offer standing at a tool change whose new bit has since been zeroed
   * has had its tool change: replaying the `M6` would only stop the job again
   * at once, for the same bit, and demand the same zero a second time.
   */
  private pastHandledToolChange(fromLine: number): number {
    const offer = this.state.resume;
    if (
      offer?.pendingPause?.kind === 'tool-change'
      && offer.fromLine === fromLine
      && !this.state.needsZZero
      && this.lineIsPause(fromLine)
    ) {
      return Math.min(this.programLength(), fromLine + 1);
    }
    return fromLine;
  }

  /**
   * Whether the program line a resume would restart on is one that pauses.
   *
   * The line, not the lines around it: a resume restarts the stream *at*
   * `fromLine`, so it is that line's own classification which decides whether
   * the first thing to happen is a cut or a stop.
   */
  private lineIsPause(fromLine: number): boolean {
    const line = this.program[Math.max(0, Math.min(fromLine, this.program.length - 1))];
    if (!line) return false;
    return classifyJobLine(line.code) !== 'motion';
  }

  /**
   * What a pause the program asks for means here: which tool, which sheet.
   *
   * Shown as "finishing the moves already sent" until they have been: GRBL
   * acks lines when it parses them, so up to a planner's worth of moves are
   * still being cut, sometimes for a quarter of a minute, and a banner saying
   * "fit the next tool" over a spindle that is still carving is what made the
   * lift that follows look like it came from nowhere. A new bit is a new tool
   * length, so the datum stops being trusted from that moment (the package
   * does it), and resume is gated on it being dealt with.
   */
  protected describePause(kind: JobPauseKind, line: string) {
    // The pause line is the one the stream is standing on.
    const note = this.gcodeNotes[this.currentQueueIndex] || '';
    if (kind === 'tool') {
      return {
        status: 'PAUSED_TOOL' as const,
        message: this.describeToolChange(line, note),
        settling: 'Finishing the moves already sent, then stopping for a tool change…',
      };
    }
    // The contour-slice export puts one of these between sheets, and says which
    // sheet in the comment.
    const sheet = note.match(/Sheet (\d+ of \d+)/);
    return {
      status: 'PAUSED_MATERIAL' as const,
      message: sheet ? `Insert Material Sheet ${sheet[1]}` : note || 'Programmed stop. Resume when ready.',
      settling: 'Finishing the moves already sent, then stopping…',
    };
  }


  /**
   * Builds the tool-change prompt.
   *
   * "Tool Change Required (T2 M6)" tells the operator nothing they can act on —
   * only the document knows what T2 is, and standing at the machine holding two
   * end mills is the worst moment to have to go and look. So the exporter's own
   * comment for the line is carried through, and the spindle speed is read out
   * of the `M3 S` that follows, because on a router without closed-loop control
   * that number is a dial the operator has to turn by hand.
   */
  private describeToolChange(line: string, note: string): string {
    const tool = line.match(/\bT(\d+)/);
    // The comment in the file ends "and re-zero Z" and is right to: it is read
    // by whatever sender opens the file, most of which say nothing else about
    // it. Here it is one of three places that were saying it, so it comes off
    // the front line and is left to the banner, which has room to say why.
    const named = note.replace(/[\s,]*and re-?zero( the)? Z\b\.?$/i, '').trim();
    const what = named || (tool ? `tool T${tool[1]}` : 'the next tool');

    let rpm = '';
    for (let i = this.currentQueueIndex + 1; i < Math.min(this.gcodeQueue.length, this.currentQueueIndex + 6); i++) {
      const m = this.gcodeQueue[i].match(/\bM0*3\b.*?\bS(\d+)/i);
      if (m) {
        const s = parseInt(m[1], 10);
        if (s > 0) rpm = `, set the spindle to ${s.toLocaleString()} RPM`;
        break;
      }
    }

    // Not a word about re-zeroing Z. The exporter's own comment for the line
    // usually ends "and re-zero Z", and the banner this message appears in
    // spells the whole thing out underneath — so saying it here made a prompt
    // that gave the same instruction three times over and buried the two
    // things only this line knows: which cutter, and what to set the dial to.
    return `Tool change: ${what}${rpm}.`;
  }

  /**
   * The stream has stopped at a tool change or programmed stop, and the
   * package has drained the buffer and waited out a `G4 P0`: every line sent
   * before the pause has been cut — including the program's own retract, which
   * a relief carve makes to Z20 just before its `M6`. The lift used to be sized
   * from where the tool stood when the pump stopped, 15 s and 23 mm lower, and
   * was then added on top of that retract and into the limit switch.
   */
  protected async onStreamPaused(kind: JobPauseKind): Promise<void> {
    const type = kind === 'tool' ? 'PAUSED_TOOL' : 'PAUSED_MATERIAL';
    const message = this.state.pauseMessage ?? '';
    // The stream has stepped past the pause line, which is the line just taken.
    const pauseLine = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex - 1));

    await this.sendAndWait('M5', QUICK_REPLY_TIMEOUT_MS); // Laser/Spindle OFF
    // An alarm or a cancel meanwhile has already dealt with the job; a lift and
    // park into a machine that is no longer this job's would be wrong.
    if (!this.isPaused || this.state.status !== type) return;
    await this.awaitStatus();
    if (!this.isPaused || this.state.status !== type) return;

    this.drainedPause = { line: pauseLine, kind: type === 'PAUSED_TOOL' ? 'tool-change' : 'stop', message };
    // Drained, so everything acked has been cut: the progress stands at the pause.
    this.updateState(this.advanceCut(null, 0));

    // Get clear of the work, then bring the spindle out where it can be reached.
    //
    // Not at a sheet swap on a laser.
    // Resume puts back only the program's own Z (restoreAfterProgramPause), and
    // a laser program has none, so the lift stayed and every later sheet was cut
    // 25 mm out of focus. A tool change always lifts: it means a spindle.
    if (type === 'PAUSED_TOOL' || !this.jobIsLaser()) {
      // The park is a rapid across the work at whatever height the lift left,
      // so it only goes when the tool is known to be clear of the stock top.
      const clear = await this.retractClearOfWork();
      if (!clear) {
        this.updateState({
          pauseMessage: `${message} The tool has not been parked: this job never went above where it is standing now, so jog it clear before changing anything.`,
        });
        return;
      }
    }
    await this.sendLine('G90'); // Absolute, whichever way the lift was made
    await this.sendLine('G0 X0.000 Y0.000'); // Park XY where the collet is reachable
  }

  /**
   * Acks have reached `position` in the queue: program lines up to there are
   * planned or cut. Progress itself is read off the cutter (`advanceCut`), not
   * off this; this only bounds it.
   *
   * The pause line a stream stops at is counted done by the package, and is
   * not yet: it takes no time, so it would be read as passed, and the line a
   * resume would restart on is the pause itself.
   */
  protected reportProgress(position: number): void {
    let done = this.jobLineBase + position;
    const last = this.program[done - 1];
    if (this.isPaused && last && classifyJobLine(last.code) !== 'motion') done -= 1;
    if (done > this.ackedLines) this.ackedLines = done;
  }

  /**
   * Why a setup after the first cannot start yet, or null when it can.
   *
   * Between setups the block has been lifted, turned and put back, so every
   * datum the last setup ran on is stale. A setup is only allowed to run on
   * zeros taken after the one before it finished: Z always, and X and Y too
   * unless the block is down on registration pins, which the operator has to
   * say. Never from an agent or another device: someone has to be standing at
   * the machine to turn the block.
   */
  private refuseSetup(setup: JobSetup | undefined, origin: 'ui' | 'mcp', relayed: boolean): string | null {
    if (!setup || setup.index <= 1) return null;
    const which = `Setup ${setup.index} of ${setup.of}`;
    if (origin !== 'ui' || relayed) {
      return `${which} turns the block by hand, so it can only be started from this screen, by someone at the machine.`;
    }
    if (this.zZeroedAt <= this.setupEndedAt || this.zZeroedAt === 0) {
      return `${which}: set Z zero on the new top face first. The last setup's Z is from a face that has moved.`;
    }
    if (setup.locate === 'pins') {
      if (!setup.pinsSeated) return `${which}: confirm the block is down on its pins before it runs.`;
      return null;
    }
    const xy = Math.min(this.xZeroedAt, this.yZeroedAt);
    if (xy <= this.setupEndedAt || xy === 0) {
      return `${which}: zero X and Y on the spot this setup locates from first. The last setup's X and Y are on a corner that has moved.`;
    }
    return null;
  }

  /** The block's datum has been re-taken, for the setup gate. */
  protected recordZDatum(): void {
    super.recordZDatum();
    this.zZeroedAt = ++this.datumSeq;
  }

  private recordXYDatum(axes: { x?: boolean; y?: boolean } = { x: true, y: true }): void {
    const at = ++this.datumSeq;
    if (axes.x) this.xZeroedAt = at;
    if (axes.y) this.yZeroedAt = at;
  }

  /**
   * Says where the tool is now, in work coordinates, for any of X, Y and Z:
   * `G10 L20 P1`, the same persistent G54 offset the zeroing buttons write.
   *
   * How a turned block is located on its own faces: the bit's side is brought
   * up to a face on a slip of paper and that axis is set to minus the bit's
   * radius (the centre stands a radius outside the face), and Z on the top.
   * `paperMm` is the feeler's thickness, added on the side away from the work.
   */
  public async setWorkPosition(
    at: { x?: number; y?: number; z?: number },
    paperMm = 0
  ): Promise<{ success: boolean; message: string }> {
    this.refuseWhileJobHoldsMachine('set the work position');
    if (!this.state.connected) return { success: false, message: 'Not connected to a machine.' };
    const words: string[] = [];
    // The paper holds the bit further out from the face it is touching.
    if (at.x !== undefined) words.push(`X${(at.x + Math.sign(at.x) * paperMm).toFixed(3)}`);
    if (at.y !== undefined) words.push(`Y${(at.y + Math.sign(at.y) * paperMm).toFixed(3)}`);
    if (at.z !== undefined) words.push(`Z${(at.z + paperMm).toFixed(3)}`);
    if (words.length === 0) return { success: false, message: 'No axis given.' };
    await this.sendAndWait('G21 G90');
    await this.sendAndWait(`G10 L20 P1 ${words.join(' ')}`);
    if (at.z !== undefined) {
      this.recordZDatum();
      this.jobPeakWorkZ = null;
    }
    if (at.x !== undefined || at.y !== undefined) this.recordXYDatum({ x: at.x !== undefined, y: at.y !== undefined });
    return { success: true, message: `Work position set: ${words.join(' ')}.` };
  }

  /**
   * Spindle off and the tool lifted as high as is safe, for turning the block
   * between setups. Only on a homed machine, where the top of travel is known;
   * otherwise it says so and the operator jogs up by hand.
   */
  public async parkHigh(): Promise<{ success: boolean; message: string }> {
    this.refuseWhileJobHoldsMachine('park the spindle');
    if (!this.state.connected) return { success: false, message: 'Not connected to a machine.' };
    await this.sendAndWait('M5');
    if (!this.state.hasHomed || this.zTravelTop() === null) {
      return {
        success: false,
        message: 'The machine has not homed, so the top of its travel is not known. Spindle stopped; jog Z up by hand.',
      };
    }
    await this.retractClearOfWork();
    return { success: true, message: 'Spindle stopped and the tool lifted to the top of its travel.' };
  }

  /** The last line was acknowledged: the job ran to its end. */
  protected onJobFinished(): Partial<MachineState> {
    // A setup with another after it leaves the block to be turned, and every
    // zero it ran on stale.
    const setup = this.runningSetup;
    this.runningSetup = null;
    let between: Partial<MachineState> = {};
    if (setup) {
      this.setupEndedAt = ++this.datumSeq;
      between =
        setup.index < setup.of
          ? {
              setupPending: { sequenceId: setup.sequenceId, next: setup.index + 1, of: setup.of, locate: setup.locate },
              needsZZero: true,
              zDatumTrusted: false,
            }
          : { setupPending: null };
    }
    // Read before the ticker stops, which forgets when the job started.
    const elapsedSeconds = this.jobStartedAt === null
      ? this.state.elapsedSeconds
      : Math.round((Date.now() - this.jobStartedAt) / 1000);
    this.stopElapsedTicker();
    // It finished. There is nothing left to resume into — here or in storage,
    // where an offer left standing would invite somebody to descend into a
    // piece that has already come off the bed.
    clearCheckpoint();
    return {
      ...between,
      currentLine: this.programLength(),
      remainingSeconds: 0,
      resume: null,
      elapsedSeconds,
      lastCompletedJob: {
        finishedAt: Date.now(),
        elapsedSeconds,
        estimatedSeconds: this.state.estimatedSeconds,
        totalLines: this.state.totalLines,
      },
    };
  }

  /**
   * Resumes a paused job — the operator's own pause, a tool change, or a
   * material swap.
   *
   * The re-zero gate is applied here, not only in the banner's button: the
   * bottom bar's play button and MCP `resume` came straight here and plunged
   * the new bit against the old one's datum. `zIsSet` is the operator saying,
   * by the banner's "Z is already set" link, that it already describes this
   * tool.
   */
  public async resumeJob({ zIsSet = false }: { zIsSet?: boolean } = {}): Promise<void> {
    if (!this.isPaused) return;
    // Read inside the package's resume before its first await, so it applies
    // to this resume and no other.
    this.zIsSetForResume = zIsSet;
    const resumed = super.resumeJob();
    this.zIsSetForResume = false;
    await resumed;
  }

  protected assertReadyToResume(): void {
    if (this.state.status === 'PAUSED_TOOL' && this.state.needsZZero && !this.zIsSetForResume) {
      throw new Error('Set Z zero for the new tool before resuming: the Z datum still belongs to the last one.');
    }
  }

  /**
   * A pause the machine was free to be driven around in is a pause it has to
   * be put back from. The package calls this only after a programmed pause: a
   * feed hold leaves the tool in the cut, and `~` picks the same move back up.
   */
  protected async beforeStreamResumes(): Promise<void> {
    await this.restoreAfterProgramPause();
  }

  protected onJobResuming(): Partial<MachineState> {
    this.drainedPause = null;
    return {};
  }


  /**
   * Puts the machine back the way the program left it at a tool change or a
   * programmed stop, before the stream restarts.
   *
   * The pause turned the spindle off, lifted, parked at X0 Y0, and then the
   * operator was free to jog, touch off (which sends `G21 G90`) and fit a new
   * bit. The program knows none of that. The exporter writes its lift *before*
   * the `M6` and assumes the machine is still up there, over the same point, in
   * the same modes, with the spindle as it was - so the next line may be a bare
   * `G0 X Y` (a rapid across the job at the surface, from a tool left on the
   * work), a `G1 Z-2` (a plunge at X0 Y0), a cut at depth with a dead spindle
   * after an `M0` that never repeats its `M3`, or an inch or `G91` move read in
   * millimetres or absolute.
   *
   * So this sends what a resume from that line would: the planner's preamble.
   * Units, plane and work offset; up to the program's clear height (never down
   * from where the tool is); over the point the program had reached; the
   * spindle back to the speed it will next cut at, with time to spin up; down
   * at a feed to where the program left the tool; and the feed and distance
   * mode last. Every line waits for its `ok`, so the receive buffer is empty
   * when the pump fills it again. The pause drained the buffer before it
   * lifted, so the positions here are where the tool really is.
   */
  private async restoreAfterProgramPause(): Promise<void> {
    if (this.program.length === 0) return;
    const at = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex));
    // The retract is clamped to the live Z, so read it from now.
    await this.awaitStatus();
    const plan = planResume(this.program.map((l) => l.code), at, {
      currentZ: this.state.wpos.z,
      isLaser: this.jobIsLaser(),
      arrivingAtPause: this.lineIsPause(at),
    });
    for (const line of prepareJobLines(plan.preamble.join('\n'))) {
      if (!this.isPaused) return;
      await this.sendAndWait(line.code);
    }
  }

  /** Whether the loaded job is for a laser, for UI that has no export modal to ask. */
  public isLaserJob(): boolean {
    return this.jobIsLaser();
  }

  /**
   * Whether the job is for a laser: the caller's word when it has one, then
   * `$32` laser mode, then a program that never commands a Z.
   */
  private jobIsLaser(explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit;
    if (this.laserModeEnabled()) return true;
    // `upTo` 0: only the whole-program safe Z is wanted, not a replay.
    return this.program.length > 0 && scanModalState(this.program.map((l) => l.code), 0).safeZ === null;
  }

  /**
   * How far ahead of the cut the streamer can be when a hold lands.
   *
   * GRBL answers `ok` on parse and executes later out of its planner buffer, so
   * the line last sent is not the line last cut. Fifteen blocks is the stock
   * planner depth; the window searched is wider than that because a program
   * line is not always a motion block — comments, modal words and dwells all
   * consume a line without consuming a block, so the line offset can exceed the
   * block offset. Being generous costs a longer search and nothing else, since
   * the position match is what actually picks the line.
   */
  private static readonly PARK_LOOKBACK_LINES = 64;

  /**
   * Stands the job down so the machine can be driven around, without losing it.
   *
   * A feed hold alone is not enough to be useful. GRBL will not accept a jog in
   * `Hold`, so "pause and have a look" currently means the tool sits in the cut
   * and nothing can be moved — and the only way out is to abandon the job,
   * which on a carve that has been running two hours means the piece is scrap,
   * because it can no longer be re-registered.
   *
   * The sequence that gets out of that:
   *
   *   1. Feed hold, and wait for motion to actually stop. Decelerating along
   *      the path keeps the position true, which everything below depends on.
   *   2. Work out which line was really cut, from where the tool is standing
   *      rather than from what has been sent. See `locateExecutedLine`.
   *   3. Soft reset. From a *stationary* hold this is clean — GRBL keeps its
   *      machine position and comes back in `Idle` rather than `Alarm`, which
   *      is the whole reason for waiting in step 1.
   *   4. Retract to safe Z, so the tool is out of the cut and the work can be
   *      looked at, brushed out, or measured. A laser stays at its focus
   *      height.
   *
   * After this the machine is idle and free: jog it anywhere, re-zero Z for a
   * fresh tool, whatever is needed. `resumeFromPark` puts it back.
   */
  public async parkJob({ isLaser: laser }: { isLaser?: boolean } = {}): Promise<boolean> {
    if (!this.isJobRunning || this.state.status === 'PAUSED_PARKED') return false;

    // 1. Hold, and let the deceleration finish.
    if (!this.isPaused) {
      this.isPaused = true;
      // The sender stops with the machine, or it fills the planner behind the hold.
      this.queue.hold();
      await this.writeRealtime(0x21); // '!'
    }
    this.updateState({
      status: 'PAUSED_OPERATOR',
      pauseMessage: 'Stopping the axes before standing the job down…',
    });
    const stopped = await this.waitForHoldComplete();
    /*
     * Never reset a machine that has not confirmed it stopped. This used to
     * carry on regardless: a reset taken while the axes are still moving is a
     * reset in motion — ALARM:3, the position gone — and the alarm took the
     * status out of PAUSED_PARKED, so `resumeFromPark` refused and there was
     * no resume offer either. The job was stranded. Left in feed hold instead,
     * it is still the job it was: Resume carries on, and parking can be tried
     * again once the controller reports the hold complete.
     */
    if (!stopped) {
      this.updateState({
        status: 'PAUSED_OPERATOR',
        pauseMessage:
          'The machine did not confirm the axes had stopped, so the job has been left in feed hold ' +
          'rather than parked — resetting a machine that may still be moving loses its position. ' +
          'Resume to carry on, or try parking again in a moment.',
      });
      return false;
    }

    // 2. Where it really got to, before the reset throws the buffer away.
    const at = { ...this.state.wpos };
    const sentLine = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex));
    const fromLine = this.program.length
      ? locateExecutedLine(
          this.program.map((l) => l.code),
          at,
          sentLine,
          WebSerialManager.PARK_LOOKBACK_LINES
        )
      : sentLine;

    // 3. Let go of the program. The queue stops here; the park point is what
    //    carries the job forward now. The soft reset throws away whatever GRBL
    //    had buffered, and the acks those lines owed with it.
    this.isJobRunning = false;
    this.isPaused = false;
    const reset = this.softReset();

    // A parked job is expected to be picked up again, and "again" is allowed to
    // be tomorrow: parking is what an operator does when they stop for the day.
    recordProgress(fromLine, 'parked', true);

    this.updateState({
      status: 'PAUSED_PARKED',
      park: { fromLine, totalLines: this.programLength(), at },
      pauseMessage:
        `Job parked at line ${fromLine} of ${this.programLength()}. The machine is free to move — ` +
        `jog it where you like, then resume.`,
    });

    // 4. Out of the cut, once the controller is back up: anything sent before
    //    then is discarded, and a status read before then is the hold's. After
    //    a soft reset GRBL needs the modes restating before it will take a move.
    //    Not on a laser: its Z is a focus height, and the resume preamble puts
    //    no Z back on a laser, so a lift here cut the rest of the job 5 mm out
    //    of focus.
    await reset;
    await this.sendAndWait('G21 G90', QUICK_REPLY_TIMEOUT_MS);
    if (!this.jobIsLaser(laser)) {
      const parkRetractZ = await this.clampedRetractZ(5);
      await this.sendAndWait(`G0 Z${parkRetractZ.toFixed(3)}`);
    }
    return true;
  }

  /**
   * Puts a parked job back on the machine and carries on cutting.
   *
   * Wherever the operator jogged the tool to, `resumeFromLine`'s preamble
   * restores the modes, lifts clear of the live Z, rapids over the point the
   * program had reached and only then descends - all inside the byte-counted
   * stream. This used to send its own retract and traverse first, unpaced, so
   * they sat in GRBL's buffer while the stream filled it behind them, and then
   * did the same moves a second time.
   */
  public async resumeFromPark(options?: Pick<ResumeOptions, 'isLaser'>): Promise<boolean> {
    const park = this.state.park;
    if (!park || this.state.status !== 'PAUSED_PARKED') return false;
    // Before the park is cleared below: a refusal from `resumeFromLine` after
    // that point left no park and no offer, and the job could not be picked up.
    const blocked = this.resumeBlockedReason(options?.isLaser);
    if (blocked) {
      this.updateState({ lastError: blocked });
      return false;
    }

    // The preamble's retract is clamped to the live Z, so read it from now.
    await this.awaitStatus();
    this.updateState({ park: null, pauseMessage: undefined });
    return this.resumeFromLine(park.fromLine, options).ok;
  }

  /**
   * A park ended by something other than Resume or Discard — an alarm (a limit
   * switch hit while jogging around), or the link dropping.
   *
   * The status leaves PAUSED_PARKED with it, and `resumeFromPark` only answers
   * in that status, so a park left standing was a job nothing could pick up:
   * no Resume, and no resume offer, after the cable was plugged back in. It
   * becomes the ordinary resume offer instead, from the line the park had
   * located, with the reason that decides how hard the banner warns.
   */
  private parkToResume(reason: 'alarm' | 'disconnected'): void {
    const park = this.state.park;
    if (!park) return;
    recordProgress(park.fromLine, reason, true);
    this.updateState({
      park: null,
      pauseMessage: undefined,
      // The park located the executed line from where the tool stood, so the
      // stop and the restart are the same line.
      resume: {
        fromLine: park.fromLine,
        stoppedAtLine: park.fromLine,
        totalLines: park.totalLines,
        reason,
        jobName: this.jobContext.name ?? null,
      },
    });
  }

  /** Throws away a parked job without resuming it. */
  public discardPark(): void {
    if (!this.state.park) return;
    clearCheckpoint();
    this.updateState({
      park: null,
      status: 'IDLE',
      pauseMessage: undefined,
      progressPercent: 0,
      remainingSeconds: null,
    });
  }

  /**
   * Waits for a feed hold to finish decelerating.
   *
   * GRBL reports `Hold:1` while it is still slowing down and `Hold:0` once the
   * axes are stopped. The difference matters: a soft reset sent while anything
   * is still moving loses the position and comes back in alarm, which is
   * exactly the outcome parking exists to avoid.
   */
  private async waitForHoldComplete(timeoutMs = 5000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await this.writeRealtime(0x3f); // '?' — status request
      await new Promise((r) => setTimeout(r, 120));
      if (this.lastHoldState === 'complete') return true;
    }
    return false;
  }


  /** Cancels the running job. */
  public async cancelJob(): Promise<void> {
    this.abandonJob('cancelled');
    await this.eStop();
    // The soft reset leaves GRBL in Alarm if it was moving, so the status the
    // machine reports next is the truth here rather than an assumed IDLE.
    this.updateState({ progressPercent: 0, remainingSeconds: null, pauseMessage: undefined });
  }


  /**
   * Asks the controller what it is, and remembers the answer.
   *
   * `$$` is the only way to find out, and until now nothing asked — so every
   * run-time estimate in the app was built on an invented 500 mm/s² and
   * 3000 mm/min, on machines whose real figures range from a stock GRBL's
   * 10 mm/s² to a ballscrew mill's several thousand. The estimate is the number
   * people use to decide whether to start a two-hour carve before dinner, and
   * it was out by whatever that ratio happened to be.
   *
   * Failure is not an error state. A controller that does not answer `$$`, or
   * answers something this does not understand, leaves the assumed profile in
   * place and the app carries on saying it is assuming — which is exactly what
   * it was doing before, only now it admits it.
   */
  public async refreshMachineSettings(timeoutMs = 4000, attempts = 3): Promise<MotionProfile> {
    if (!this.state.connected || !this.transport) return this.state.motion;

    /*
     * Asked more than once, because the first ask is made at the worst possible
     * moment.
     *
     * Opening a serial port asserts DTR, and on every Arduino-based controller
     * — which is most of them — that resets the board. It spends the next
     * second or two booting, deaf, and the `$$` sent the instant the port
     * opened goes into the void. One attempt meant the app then spent the whole
     * session quoting run times off invented acceleration figures while
     * displaying a note about reading them from the machine "once connected",
     * on a machine that was connected.
     */
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!this.state.connected || !this.transport) return this.state.motion;

      // The package collects every `$N=` line into its map as it arrives.
      this.grblSettings.clear();
      try {
        await this.sendAndWait('$$', timeoutMs);
      } catch {
        // Refused, or the board rebooted under it: the same as no answer.
      }

      const settings = new Map(this.grblSettings);
      if (settings.size === 0) {
        // A board that is still booting answers nothing at all. Give it time to
        // get to its prompt rather than hammering the same question at it.
        if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1200));
        continue;
      }

      // Who it is, before the profile is applied, so the spindle override
      // that goes on top of it is this controller's own and not the last
      // one's. Not over a running program, which GRBL would refuse (error:8);
      // a board that does not answer is simply unidentified.
      if (this.machineKey === null && this.transportMode !== 'wifi' && !this.isJobRunning && !this.isPaused) {
        try {
          await this.sendAndWait('$I', Math.min(timeoutMs, 1500));
        } catch {
          // Unidentified: the unkeyed override applies.
        }
      }

      const motion = motionProfileFromSettings(settings);
      this.updateState({
        motion,
        grblSettings: Object.fromEntries(settings),
      });
      // A `$32` this app switched off to light a guide spot, on a session that
      // ended before it could switch it back on. Cutting with laser mode off
      // burns a line through every rapid, so it is put right at the first
      // opportunity — which is here, the first moment the setting is known.
      if (settings.get(32) === 0 && readLaserModeBorrowed()) {
        this.guideSpotRestoreLaserMode = true;
        void this.restoreLaserMode();
      }
      return motion;
    }

    return this.state.motion;
  }
  /**
   * Refuses a manual move or zeroing while a program has hold of the machine.
   *
   * Streaming, or feed-held with the rest of the program in GRBL's planner: a
   * jog then is refused by GRBL (error:8), which abandoned the job with the
   * spindle still on, and a G0 or G10 queues behind the hold and runs in the
   * middle of the program on resume. A tool-change or material pause is fine -
   * the machine is parked and waiting for exactly this - and so is a park.
   */
  private refuseWhileJobHoldsMachine(what: string): void {
    if ((this.isJobRunning && !this.isPaused) || this.state.status === 'PAUSED_OPERATOR') {
      throw new Error(`Can't ${what} while a job is running or on feed hold. Stop or finish the job first.`);
    }
  }

  public async homeMachine(): Promise<void> {
    this.refuseWhileJobHoldsMachine('home');
    await super.homeMachine();
  }


  /**
   * Drops everything this side is holding about a job, without touching the
   * machine. Used when the controller has already stopped on its own.
   */
  // Never `interrupted`: that one is by definition a job nothing here saw end,
  // so there is no call site in this class that could pass it.
  private abandonJob(reason: Exclude<ResumePoint['reason'], 'interrupted'> = 'cancelled', message?: string) {
    // Where it got to, before the queue that knows it is thrown away. The line
    // that was in flight is the one to come back to rather than the one after
    // it: a move that was cut off partway through did not finish, and running
    // it again only recuts a path that has already been cut, while skipping it
    // leaves a gap in the work.
    const drained = this.drainedPause;
    this.drainedPause = null;
    if ((this.isJobRunning || this.isPaused) && this.program.length > 0 && drained) {
      // Stopped at a pause whose preceding moves had all been cut: nothing to
      // wind back over. Winding back here put a ball nose onto the last 64
      // lines of the roughing end mill's path.
      recordProgress(drained.line, reason, true, { kind: drained.kind, message: drained.message });
      this.updateState({
        resume: {
          fromLine: drained.line,
          totalLines: this.programLength(),
          reason,
          pendingPause: { kind: drained.kind, message: drained.message },
          stoppedAtLine: drained.line,
          ...(message ? { message } : {}),
          jobName: this.jobContext.name ?? null,
        },
      });
    } else if ((this.isJobRunning || this.isPaused) && this.program.length > 0) {
      const sent = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex - 1));
      /*
       * Rewound from the line last SENT, which is not the line last CUT: GRBL
       * acks on parse, so up to a planner's worth of blocks plus a receive
       * buffer of lines had not run. Resuming from the sent line skipped them
       * and left an uncut stretch. A park can ask the stationary machine where
       * it is (locateExecutedLine); here it can't - after an alarm the position
       * is a fiction and after a drop it is stale - so it goes back the same
       * window the park searches. Recutting costs time; a gap ruins the part.
       * Never back past a tool change or programmed stop, though: that would
       * cut the last tool's path with the new one. Nor past the line this run
       * was resumed from, which the operator chose and whose preamble lines
       * are not program lines at all.
       */
      let stoppedAt = Math.max(this.cutFloorLine, sent - WebSerialManager.PARK_LOOKBACK_LINES);
      for (let i = sent - 1; i >= stoppedAt; i--) {
        const code = (this.program[i]?.code ?? '').replace(/\([^)]*\)|;.*$/g, '');
        if (classifyJobLine(code) !== 'motion') { stoppedAt = i + 1; break; }
      }
      // Forced past the throttle: what follows a drop or an alarm is often the
      // operator closing the tab, and a write that waited out its interval would
      // be the one write that mattered and did not happen.
      recordProgress(stoppedAt, reason, true);
      this.updateState({
        resume: {
          fromLine: stoppedAt,
          stoppedAtLine: sent,
          ...(message ? { message } : {}),
          totalLines: this.programLength(),
          reason,
          jobName: this.jobContext.name ?? null,
        },
      });
    }

    this.isJobRunning = false;
    this.isPaused = false;
    // A stopped job is not running up time. The elapsed figure stays, and a
    // resume carries on counting from it.
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.jobStartedAt = null;
    this.gcodeQueue = [];
    this.gcodeNotes = [];
    this.currentQueueIndex = 0;
    // A start still waiting on stale replies does not go ahead after this.
    this.jobEpoch++;
    // The stream stops sending. A hold, not a failure of what is in flight: the
    // controller may still answer those lines (nothing here has reset it), and
    // a reply arriving after its slot was dropped would answer the next command.
    this.queue.hold();
    this.queue.failAll(new StreamAbortedError(reason));
    this.queue.release();
  }

  /**
   * Kills GRBL Alarm state ($X), then puts back absolute millimetres.
   *
   * The local state is cleared alongside it: the alarm arrived with a half-sent
   * job behind it, and leaving that queue and its pause flag in place is what
   * used to make the app unusable after a limit switch until it was reloaded.
   */
  public async unlockAlarm(): Promise<void> {
    this.abandonJob('alarm');
    this.updateState({
      lastError: undefined,
      pauseMessage: undefined,
      currentLine: 0,
      totalLines: 0,
      progressPercent: 0,
      remainingSeconds: null,
      // needsZZero is left as it was. An unlock proves nothing about the Z
      // datum: a machine that powers up in alarm, or a bit that snapped and was
      // replaced, still has to be zeroed before a start or a resume.
    });
    await super.unlockAlarm();
  }

  /** Sets current XY position as G54 Work Origin (0,0). */
  public async zeroXY(): Promise<void> {
    this.refuseWhileJobHoldsMachine('zero XY');
    await super.zeroXY();
    this.recordXYDatum();
  }


  /**
   * Sets work Z zero from where the tool is standing right now, with no probe
   * involved.
   *
   * This is how most people actually zero a router: wind the bit down onto the
   * work — or onto a slip of paper, or a 1-2-3 block — until it just bites,
   * then call that zero. It wants no touch plate, no continuity clip and no
   * conductive stock, which between them rule the probe out on painted MDF, on
   * anything held in a wooden jig, and on every machine whose probe input has
   * never been wired up. Without it the only route to a Z datum in this app was
   * one that a good half of the setups it runs on cannot use at all.
   *
   * `offsetMm` is how far the tip is *above* the surface it is being zeroed
   * against, so a 0.1 mm feeler gauge is entered as 0.1 and the datum lands on
   * the material rather than on the gauge. Zeroing on a block sat on the work
   * is the same idea with a bigger number.
   *
   * `G10 L20 P1` writes the G54 offset, matching the probe path — `G92` is a
   * temporary shift that `$H` or a soft reset would silently discard while the
   * job carried on assuming it.
   */
  public async zeroZHere(offsetMm = 0): Promise<{ success: boolean; message: string }> {
    this.refuseWhileJobHoldsMachine('zero Z');
    if (!this.state.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }
    await this.sendAndWait('G21 G90');
    await this.sendAndWait(`G10 L20 P1 Z${offsetMm.toFixed(3)}`);
    // The datum is now real, whichever bit is in the collet.
    this.recordZDatum();
    this.jobPeakWorkZ = null;
    return {
      success: true,
      message:
        offsetMm === 0
          ? 'Work Z0 set at current tool position.'
          : `Work Z 0 set ${offsetMm.toFixed(2)} mm below the tool tip, allowing for the gauge under it.`,
    };
  }

  /**
   * Sets all three axes' work zero where the tool is standing.
   *
   * The one-button version of the manual touch-off, for the common case where
   * the tool has been jogged to the corner of the stock and rested on its top
   * face: X, Y and Z all mean "here".
   */
  public async zeroAllHere(): Promise<void> {
    this.refuseWhileJobHoldsMachine('zero the axes');
    await this.sendLine('G10 L20 P1 X0 Y0 Z0');
    this.recordZDatum();
    this.recordXYDatum();
    this.jobPeakWorkZ = null;
  }

  /**
   * Nudges the machine by a relative amount, which is how you get the tool over
   * the corner of the stock before zeroing: drive it there by eye, then call
   * `zeroXY`. One jog on the wire at a time, later clicks added to the next —
   * see the package's `jog`.
   */
  public async jog(delta: { x?: number; y?: number; z?: number }, feedrate = 1000): Promise<void> {
    this.refuseWhileJobHoldsMachine('jog');
    await super.jog(delta, feedrate);
  }


  /**
   * Lights the laser at pointer power, so the operator can see where the head
   * is standing and jog the *beam* — not the gantry — onto the corner of the
   * stock before zeroing.
   *
   * Without this there is no way to set XY zero on a laser accurately. You jog
   * by eye against the head, or against a red pointer diode mounted a few
   * millimetres off the optical axis, and the whole job comes out shifted by
   * that offset — the same amount, in the same direction, every time.
   *
   * `M3` and not `M4`: in GRBL's laser mode `M4` is dynamic power, which scales
   * with feed and is therefore *off* on a stationary head — exactly the case
   * here. `M3` is constant power and fires immediately at idle.
   *
   * The beam is left burning at the operator's discretion on a head that is not
   * moving, so it carries its own deadline: `GUIDE_SPOT_TIMEOUT_MS` after being
   * lit it goes out on its own. Every other exit from this state — disconnect,
   * E-stop, starting a job — kills it too, through `guideSpotOff`.
   */
  public async guideSpotOn(power: number = readGuidePower()): Promise<void> {
    if (!this.state.connected) {
      this.updateState({ lastError: 'Not connected to a machine.' });
      return;
    }
    // Firing into a running job would fight the program's own S words, and the
    // spot would be indistinguishable from the cut anyway.
    if (this.isJobRunning) {
      this.updateState({ lastError: 'Cannot light the guide spot while a job is running.' });
      return;
    }
    // GRBL refuses everything in alarm, `M3` included, and refuses it *quietly*
    // as far as the operator is concerned — the beam simply never appears,
    // which reads as a broken button rather than a machine that needs
    // unlocking.
    if (this.state.status === 'ALARM') {
      this.updateState({
        lastError: 'The machine is in alarm and will refuse to fire. Home it, or unlock ($X), first.',
      });
      return;
    }

    /*
     * Laser mode has to come off for a spot to exist at all.
     *
     * With `$32=1` GRBL only energises the laser during a G1/G2/G3 feed move
     * and turns it off everywhere else — rapids, and standing still. That is
     * right for cutting and exactly wrong for a pointer: the head is stationary
     * by definition. `M3 S<n>` is accepted, answers `ok`, and produces no
     * light, which is what a first attempt at this looks like on real hardware.
     *
     * So laser mode goes off for as long as the spot is lit and is restored the
     * moment it goes out. `$32` is only accepted in Idle, which the state check
     * above has already established.
     */
    if (this.laserModeEnabled() && !this.guideSpotRestoreLaserMode) {
      // Written down before the setting is changed, not after: the case this
      // covers is the page disappearing between the two.
      writeLaserModeBorrowed(true);
      await this.sendLine('$32=0');
      this.updateState({ grblSettings: { ...this.state.grblSettings, 32: 0 } });
      this.guideSpotRestoreLaserMode = true;
    }

    // Scaled here as well as in the UI: this is a public method, and the
    // percentage means nothing until it is against this machine's `$30`.
    await this.sendLine(`M3 S${this.guidePowerAsS(power)}`);
    this.updateState({ guideSpot: true });
    this.armGuideSpotTimeout();
    if (readGuideJiggle()) void this.runGuideJiggle();
  }

  /**
   * Keeps the spot lit on a machine that only fires while moving, by tracing a
   * cross a tenth of a millimetre across, over and over, centred on the point
   * being sighted.
   *
   * `$32=0` is meant to make this unnecessary, and on many controllers it does.
   * On others the PWM is gated on motion below the level any `$` setting
   * reaches, and the dot blinks out the instant the head stops. Motion is then
   * the only way to hold it, so the motion is made small enough to be no motion
   * at all — ±0.1 mm is inside the beam's own spot size — and the cross returns
   * to its own centre every cycle rather than walking the origin across the
   * bed.
   *
   * `G1` and not `$J`: a jog is not a feed move, and a controller that only
   * lights the laser during feed moves will not light it for a jog either.
   *
   * `G91` is restored to `G90` at the end of every cycle rather than once at
   * the end of the loop. Relative mode left set is how a later positioning move
   * gets read as an offset and walks the head off the job, and this loop can
   * stop at a disconnect, an alarm or a timeout — none of which run cleanup.
   */
  private async runGuideJiggle(): Promise<void> {
    if (this.guideJiggleRunning) return;
    this.guideJiggleRunning = true;
    try {
      while (
        this.state.guideSpot &&
        this.state.connected &&
        !this.isJobRunning &&
        this.state.status !== 'ALARM' &&
        // Re-read per cycle rather than captured on entry, so unticking the box
        // stops the movement without putting the beam out — which is the answer
        // on a machine that turns out not to need it.
        readGuideJiggle()
      ) {
        await this.sendAndWait('G91', GUIDE_JIGGLE_REPLY_TIMEOUT_MS);
        for (const [dx, dy] of GUIDE_JIGGLE_PATTERN) {
          // Checked per move rather than per cycle: this loop shares the serial
          // channel with everything else, so how fast it notices it should stop
          // is how long anything else has to wait to have the channel to
          // itself.
          if (!this.state.guideSpot || !this.state.connected) break;
          await this.sendAndWait(
            `G1 X${(dx * GUIDE_JIGGLE_STEP_MM).toFixed(3)} Y${(dy * GUIDE_JIGGLE_STEP_MM).toFixed(3)} ` +
              `F${GUIDE_JIGGLE_FEED_MM_MIN}`,
            GUIDE_JIGGLE_REPLY_TIMEOUT_MS
          );
        }
        await this.sendAndWait('G90', GUIDE_JIGGLE_REPLY_TIMEOUT_MS);
      }
    } finally {
      this.guideJiggleRunning = false;
      // Whatever ended the loop, absolute mode is not optional. Cheap to assert
      // twice; expensive exactly once, if the cycle above was cut short.
      if (this.state.connected) void this.sendLine('G90').catch(() => {});
    }
  }

  /** Puts the guide spot out. Safe to call when it was never lit. */
  public async guideSpotOff(): Promise<void> {
    this.clearGuideSpotTimeout();
    if (!this.state.connected) {
      // Nothing to send to, but the flag must not survive: the beam is out
      // because the machine is gone.
      if (this.state.guideSpot) this.updateState({ guideSpot: false });
      this.guideSpotRestoreLaserMode = false;
      return;
    }
    // The flag goes down *first*, and is what the jiggle loop watches. Sending
    // M5 while that loop is still feeding moves in would put the tail of its
    // cross on the far side of the beam going out — and, worse, leave its `G91`
    // and the commands after it racing whatever runs next.
    this.updateState({ guideSpot: false });
    await this.awaitJiggleStopped();

    // Each one acknowledged before this returns, so a job waiting on it starts
    // streaming into a controller that has finished with all three.
    await this.sendAndWait('M5', QUICK_REPLY_TIMEOUT_MS);
    // S0 as well as M5, so the next `M3` in a hand-typed command or a program
    // header does not inherit the pointer's S word and fire at it.
    await this.sendAndWait('S0', QUICK_REPLY_TIMEOUT_MS);
    // Laser mode back on before anything else can run. A job streamed with
    // `$32=0` still cuts, but it burns through every rapid on the way, so
    // leaving it off would be a far worse bug than the one it was turned off to
    // fix.
    await this.restoreLaserMode();
  }

  /**
   * Waits for the jiggle loop to finish whatever move it is in the middle of,
   * so the caller has the serial link to itself.
   *
   * Capped rather than open-ended: a controller that has stopped answering
   * would otherwise hold up switching the beam off, which is the one thing that
   * must not be made to wait on anything.
   */
  private async awaitJiggleStopped(maxWaitMs = 1500): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (this.guideJiggleRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  /**
   * Puts `$32` back if the guide spot borrowed it, without the `M5`/`S0` of a
   * full `guideSpotOff`.
   *
   * For the paths that have already killed output by other means — a job's own
   * header, a soft reset — where what still has to happen is restoring laser
   * mode, and where restoring it *late* would mean a job streaming with the
   * beam burning through its rapids.
   */
  private async restoreLaserMode(): Promise<void> {
    if (!this.guideSpotRestoreLaserMode) return;
    this.guideSpotRestoreLaserMode = false;
    writeLaserModeBorrowed(false);
    this.updateState({ grblSettings: { ...this.state.grblSettings, 32: 1 } });
    // Waited for: GRBL writes EEPROM for a setting, and a stream started
    // before the `ok` would be racing that write.
    await this.sendAndWait('$32=1', QUICK_REPLY_TIMEOUT_MS);
  }

  /** Full-scale S for this controller — `$30`, or the usual 1000 if unasked. */
  private spindlePwmMax(): number {
    const reported = this.state.grblSettings[30];
    return reported && reported > 0 ? reported : DEFAULT_SPINDLE_PWM_MAX;
  }

  /**
   * What a pointer percentage comes out as in S words on this machine, so the
   * UI can show the number that actually goes down the wire. An operator
   * comparing settings against LightBurn or a forum post is comparing S words,
   * and a percentage alone is not translatable without `$30`.
   */
  public guidePowerAsS(percent: number): number {
    return guidePowerToS(percent, this.spindlePwmMax());
  }

  /**
   * Whether `$32` laser mode is on. Unknown counts as off: turning it back on
   * afterwards on a machine that never had it would be changing a setting the
   * operator did not ask us to touch.
   */
  private laserModeEnabled(): boolean {
    return this.state.grblSettings[32] === 1;
  }

  private armGuideSpotTimeout(): void {
    this.clearGuideSpotTimeout();
    this.guideSpotTimer = setTimeout(() => {
      this.guideSpotTimer = null;
      void this.guideSpotOff();
    }, GUIDE_SPOT_TIMEOUT_MS);
  }

  private clearGuideSpotTimeout(): void {
    if (this.guideSpotTimer) {
      clearTimeout(this.guideSpotTimer);
      this.guideSpotTimer = null;
    }
  }
  /**
   * Lifts the tool clear of the work without driving it into the top of travel,
   * and says whether it is now clear of the stock top.
   *
   * Called only once the buffer has drained, so the position read here is
   * where the tool actually stands.
   *
   * On a homed machine the lift is exact: `G53` names a height in machine
   * coordinates, and the homing pull-off point (less a margin) is as high as it
   * is safe to go, whatever the work offset says.
   *
   * Un-homed, nothing about the ceiling is known. `MPos` 0 is wherever the
   * controller powered up, so "headroom" worked out from it is fiction, and a
   * blind relative lift took two relief carves into the top switch: from the
   * program's own Z20 retract, 25 mm more was further than the machine had. So
   * the lift goes no higher than this job has already been seen to go, on the
   * same datum. That height is reachable by demonstration. For a carve that
   * retracts before its `M6` it means no lift at all, and the operator jogs up
   * from the pause banner if they need more room.
   */
  private async retractClearOfWork(): Promise<boolean> {
    // From the package, which takes the top from where homing really came to
    // rest rather than assuming machine zero (or `$132`) is it. The old local
    // reading did assume that, and firmware differs on what it calls home: on
    // one that reports the switch as a positive MPos, a lift to "0 less the
    // pull-off" was a rapid downward.
    const top = this.zTravelTop();

    if (this.state.hasHomed && top !== null) {
      await this.sendLine(`G53 G0 Z${(top - RETRACT_BELOW_PULLOFF_MM).toFixed(3)}`);
      return true;
    }

    const currentZ = this.state.wpos.z;
    const target = Math.max(currentZ, this.jobPeakWorkZ ?? -Infinity);
    if (target > currentZ + 0.001) {
      await this.sendLine(`G90 G0 Z${target.toFixed(3)}`);
    }
    // The datum is the stock top for every program this app writes, so a tool
    // at or below it may be in the work, and a rapid park from there is a rapid
    // through the job.
    return target > 0;
  }

  /** Retracts and drives to the current work XY origin, to check where zero landed. */
  public async gotoWorkOrigin(safeZ = 5): Promise<void> {
    this.refuseWhileJobHoldsMachine('go to the origin');
    await this.sendLine('G21 G90');
    const retractZ = await this.clampedRetractZ(safeZ);
    await this.sendLine(`G0 Z${retractZ.toFixed(3)}`);
    await this.sendLine('G0 X0.000 Y0.000');
  }

  /**
   * Sets work Z zero from a touch plate, and reports whether it actually did.
   *
   * The probe result has to be read back before the datum is set: a probe that
   * ran its full travel without touching — clip off, plate not under the tool —
   * leaves the tool somewhere below where it started, and zeroing there tells
   * the machine the stock surface is at a depth it will happily cut to. So no
   * contact means no datum, and the caller is told why.
   *
   * `G10 L20 P1` writes the G54 work offset rather than `G92`'s temporary shift,
   * which a soft reset or `$H` would discard while the job still assumed it.
   */
  public async zeroZ(
    touchPlateThicknessMm = 12.0,
    searchDepthMm = ZERO_SEARCH_MM,
    feedrate = 50
  ): Promise<{ success: boolean; message: string; machineZ?: number }> {
    this.refuseWhileJobHoldsMachine('probe Z');
    if (!this.state.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }
    const fault = this.probeCircuitFault();
    if (fault) {
      this.updateState({ lastError: fault });
      return { success: false, message: fault };
    }

    const prevStatus = this.state.status;
    if (!prevStatus.startsWith('PAUSED')) {
      this.updateState({ status: 'PROBING' });
    }
    try {
      await this.sendAndWait('G21 G90');
      const contactZ = await this.probeOnce(searchDepthMm, feedrate);

      if (contactZ === null) {
        const message =
          `Probe never made contact within ${searchDepthMm} mm — Z zero was NOT set. ` +
          `Check the probe clip and lead, and start with the tool closer to the plate.`;
        this.updateState({ lastError: message });
        return { success: false, message };
      }

      await this.sendAndWait(`G10 L20 P1 Z${touchPlateThicknessMm.toFixed(3)}`);
      this.recordZDatum();
      // Heights seen on the old datum say nothing about this one.
      this.jobPeakWorkZ = null;
      // Relative retract: it clears the plate by the same 5 mm wherever the datum
      // ended up, and does not depend on the offset that was just written.
      await this.sendAndWait('G91 G0 Z5.000');
      await this.sendAndWait('G90');

      return {
        success: true,
        machineZ: contactZ,
        message: `Z zeroed on touch plate (machine Z ${contactZ.toFixed(3)}, plate ${touchPlateThicknessMm.toFixed(2)} mm). Remove plate before cutting.`,
      };
    } finally {
      if (this.state.status === 'PROBING') {
        this.updateState({ status: prevStatus === 'PROBING' ? 'IDLE' : prevStatus });
      }
    }
  }

  /**
   * Probes a grid of points across the job's bounds and returns each one's
   * height relative to the first, which is what the leveller adds back to the
   * commanded Z.
   *
   * On a live machine each point is a move, a `G38.2` probe whose `[PRB:]` reply
   * is read back, and a retract. Disconnected, it returns a plausible tilt and
   * dish so the rest of the pipeline can be exercised without hardware — a
   * simulated grid, never presented as a measurement.
   *
   * No touch plate thickness here, unlike `zeroZ`: heights are relative to the
   * reference point, and a constant plate thickness cancels out of a difference.
   * A point that never makes contact is recorded flat rather than guessed at.
   */
  public async probeGrid(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    gridX = 3,
    gridY = 3,
    onProgress?: (probedCount: number, totalCount: number) => void
  ): Promise<ProbeGrid> {
    this.refuseWhileJobHoldsMachine('probe the surface');
    const gx = Math.max(2, Math.round(gridX));
    const gy = Math.max(2, Math.round(gridY));

    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    const stepX = gx > 1 ? width / (gx - 1) : 0;
    const stepY = gy > 1 ? height / (gy - 1) : 0;

    const points: { x: number; y: number; z: number }[][] = [];
    const totalPoints = gx * gy;
    let probed = 0;

    // Probing is a physical measurement: `G38.2` moves down until the
    // controller's probe input triggers, which only happens when something
    // completes that circuit — a conductive touch plate or bed with the tool
    // clipped to it, or a mechanical/inductive touch probe on the input. There
    // is nothing to fabricate without a machine, so this refuses rather than
    // inventing a heightmap that would then warp a real job.
    if (!this.state.connected) {
      throw new Error('No machine is connected, so the bed cannot be probed.');
    }
    this.assertProbeCircuit();

    const prevStatus = this.state.status;
    if (!prevStatus.startsWith('PAUSED')) {
      this.updateState({ status: 'PROBING' });
    }
    try {
      // Every Z move here is relative, and there is not one absolute Z rapid in
      // the whole routine. That is the safety property that matters: an absolute
      // `G0 Z<n>` trusts the work datum, and a wrong datum — a Z zeroed on the
      // wrong face, a G54 offset left over from another job — turns that rapid
      // into a full-speed plunge through the work before any probe move even
      // begins. This drove a tool through the plate once; it cannot here, because
      // nothing moves Z to an assumed height.
      //
      // The contract instead: the operator jogs the tool to a small clearance
      // above the surface (a few mm) before starting. From there the routine only
      // ever moves XY across at that height and plunges *down* slowly under
      // `G38.2`, which stops the instant the probe triggers — or, if it never
      // does, at a bounded search depth, after which the first miss aborts the
      // whole grid. After each contact it lifts back up by a fixed relative step,
      // so the clearance tracks the surface from point to point rather than being
      // trusted to an absolute number.
      const PROBE_SEARCH_MM = 10; // most the tool can plunge before the move ends
      const PROBE_LIFT_MM = 5; // relative lift after each contact, kept for the next hop
      const PROBE_FEED = 50; // slow, so the probe has time to stop the move

      await this.sendAndWait('G21 G90');

      // Machine Z of the first contact. Every later point is reported against it,
      // so the grid comes out as offsets whatever the tool length or datum.
      let referenceZ: number | null = null;

      for (let row = 0; row < gy; row++) {
        const rowPoints: { x: number; y: number; z: number }[] = [];
        const y = bounds.minY + row * stepY;

        for (let col = 0; col < gx; col++) {
          const x = bounds.minX + col * stepX;

          // Across to the point at the current clearance — an XY-only move, no Z
          // word, so the height the operator (or the last lift) set is kept.
          await this.sendAndWait(`G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
          // Straight down, slowly, until the probe triggers or the search runs
          // out. `probePoint` issues `G91 G38.2 Z-<search>`, a relative plunge.
          const contactZ = await this.probeOnce(PROBE_SEARCH_MM, PROBE_FEED);

          // A miss means the plunge ran its whole length without the probe
          // triggering: a clip that fell off, a broken wire, a non-conductive
          // surface, or a clearance set too high to reach in one search. GRBL is
          // now in a probe-fail alarm with the tool at the bottom of the move.
          //
          // Stop here. Recording the miss and moving on (the old behaviour) drove
          // the tool down again at every remaining point; aborting on the first
          // miss makes it a single slow plunge the operator can watch and stop.
          // Left where it stopped, on purpose: retracting into an alarm is
          // refused, and jogging clear is the operator's call, not this routine's.
          if (contactZ === null) {
            this.updateState({
              lastError:
                `Bed probe made no contact at X${x.toFixed(1)} Y${y.toFixed(1)}, so it stopped before ` +
                `probing further. Check the probe clip and wiring, that the surface is conductive, and ` +
                `that the tool started within ${PROBE_SEARCH_MM} mm of it — then clear the alarm and try again.`,
            });
            throw new Error('Bed probe made no contact — stopped to avoid driving the tool into the work.');
          }

          // Lift clear before the next hop, relative to where it just touched, so
          // the clearance follows the surface instead of an assumed height.
          await this.sendAndWait(`G91 G0 Z${PROBE_LIFT_MM.toFixed(3)}`);
          await this.sendAndWait('G90');

          if (referenceZ === null) referenceZ = contactZ;
          const probedZ = parseFloat((contactZ - referenceZ).toFixed(3));

          rowPoints.push({ x, y, z: probedZ });
          probed++;
          if (onProgress) onProgress(probed, totalPoints);
        }
        points.push(rowPoints);
      }

      // Every point contacted (a miss would have thrown), so the tool is one lift
      // above the last one. A final relative lift leaves it clear for the operator
      // — still no absolute Z move.
      await this.sendAndWait(`G91 G0 Z${PROBE_LIFT_MM.toFixed(3)}`);
      await this.sendAndWait('G90');

      const rawGrid: ProbeGrid = {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
        gridX: gx,
        gridY: gy,
        points,
      };
      const datum = this.zDatumWorkXY();
      if (datum) {
        const normalized = normalizeGrid(rawGrid, datum.x, datum.y);
        return {
          ...normalized,
          referencedTo: 'z-datum',
          points: normalized.points.map((row) =>
            row.map((p) => ({ ...p, z: parseFloat(p.z.toFixed(3)) }))
          ),
        };
      }
      return {
        ...rawGrid,
        referencedTo: 'first-point',
      };
    } finally {
      if (this.state.status === 'PROBING') {
        this.updateState({ status: prevStatus === 'PROBING' ? 'IDLE' : prevStatus });
      }
    }
  }

  /**
   * Traces the job's bounding box so the operator can see where it will land.
   *
   * What that means depends on the machine, and getting it wrong is destructive
   * in one direction only:
   *
   *  - **Laser** — trace at a low guide power so the dot is visible. There is no
   *    Z in the toolpath, so none is commanded here either.
   *  - **CNC** — retract clear first and trace with the spindle *off*. A router
   *    sits at work Z0 after zeroing, which is the surface of the stock, and
   *    framing from there drags the bit right around the outline of the part.
   *
   * The retract is clamped to where the tool already is. `safeZMm` is a *work*
   * height, so it is only clear of the job when Z0 belongs to the stock clamped
   * down now; against a zero left over from an earlier run it can sit below the
   * tool, and the move meant to make framing safe becomes a plunge. Framing may
   * only ever move Z away from the stock — a stale reading can leave it higher
   * than asked for, never lower.
   */
  public async frameJob(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    guidePowerOrOptions: number | FrameJobOptions = 5,
    opts: { laserMode?: boolean; safeZMm?: number } = {}
  ): Promise<void> {
    // The package's form, `(bounds, { retractZmm })`, is a dark lap on a router.
    // Nothing here calls it that way; it is accepted so this stays a GrblMachine.
    let guidePower: number;
    if (typeof guidePowerOrOptions === 'number') {
      guidePower = guidePowerOrOptions;
    } else {
      guidePower = 0;
      opts = { laserMode: false, safeZMm: guidePowerOrOptions.retractZmm };
    }
    this.refuseWhileJobHoldsMachine('frame the job');
    // Callers have always said "CNC" by asking for no guide power at all, so
    // that stays the default reading of it. Guide power alone is not enough to
    // mean laser: MCP passes the default 5 whatever the machine, and on a
    // relay-switched router `M3 S5` is full RPM with the bit still at stock
    // height. Unless the caller says, a lit lap also needs `$32` laser mode on.
    const { laserMode = guidePower > 0 && this.laserModeEnabled(), safeZMm = 5 } = opts;
    const { minX, minY, maxX, maxY } = bounds;

    // The retract below is a work height, and with no datum set this session
    // the work Z reading is whatever an earlier job left: the tool can be on
    // the stock while it reads +50, so "lift to at least 5" lifts nothing and
    // the lap drags the bit round the outline.
    if (!laserMode && this.state.needsZZero) {
      const message =
        'Z zero has not been set this session. Set it in Machine Setup before framing — ' +
        'the lift clear of the stock is measured from that datum.';
      this.updateState({ lastError: message });
      throw new Error(message);
    }

    /*
     * The whole lap is written out first and checked against the machine's
     * travel before any of it is sent. It used to go out a line at a time
     * through `sendLine`, which no travel check sees — only `streamProgram`
     * runs one — so a frame of a job placed past the end of an axis drove into
     * the limit, while the job itself would have been refused.
     */
    const lap: string[] = ['G21', 'G90'];

    if (!laserMode) {
      await this.awaitStatus();
      const retractZ = Math.max(safeZMm, this.state.wpos.z);
      lap.push(`G0 Z${retractZ.toFixed(3)}`);
    }

    // No F on a rapid: GRBL ignores it for the move but keeps it as the modal
    // feed, so the next G1 without one of its own would run at it.
    lap.push(`G0 X${minX.toFixed(3)} Y${minY.toFixed(3)}`);

    const corners: Array<[number, number]> = [
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ];

    if (laserMode) {
      // A percentage, like the guide spot's, scaled by `$30`: a raw `S5` is
      // 0.05% duty on a 10000-scale controller, a lap nobody can see.
      lap.push(`M3 S${this.guidePowerAsS(guidePower)}`);
      for (const [x, y] of corners) lap.push(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
      lap.push('M5 S0');
    } else {
      // No `M3` at all: a program with none in it cannot start a spindle by
      // accident, and there is nothing to cut with here anyway.
      for (const [x, y] of corners) lap.push(`G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
    }

    const offTheBed = this.travelBlockedReason(lap);
    if (offTheBed) {
      this.updateState({ lastError: offTheBed });
      throw new Error(offTheBed);
    }

    for (const line of lap) await this.sendLine(line);
  }

  /** Emergency stop: a soft reset (Ctrl-X). */
  public async eStop(): Promise<void> {
    // A soft reset from a finished feed hold leaves GRBL Idle, not Alarm, so no
    // alarm arrives to end the job. Left running, a later Resume streamed the
    // rest of the program into a freshly reset machine with the spindle off.
    if (this.isJobRunning || this.isPaused) {
      this.abandonJob('cancelled');
      this.updateState({ progressPercent: 0, remainingSeconds: null, pauseMessage: undefined });
    }
    if (!this.transport) return;
    this.clearGuideSpotTimeout();
    if (this.state.guideSpot) this.updateState({ guideSpot: false });
    /*
     * The reset stops the spindle and the beam itself. An `M5` used to follow
     * it, which GRBL threw away with its receive buffer, or refused (error:9)
     * in the ALARM:3 that a reset in motion leaves - either way its booked
     * `ok` then answered the next command sent instead. The package's e-stop
     * returns only once the controller is listening again.
     */
    await super.eStop();
    // What is left is the `$32` the spot borrowed, which must not be left
    // off. GRBL takes settings in Alarm as well as Idle.
    await this.restoreLaserMode();
  }
}

export const webSerialManager = new WebSerialManager();

// The owner's figure for the working envelope, for the travel check wherever
// the controller has not reported its own; kept current as it is edited or
// arrives from the account.
webSerialManager.setBed(cncBedStore.get());
cncBedStore.subscribe((bed) => webSerialManager.setBed(bed));
