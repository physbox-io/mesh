// ---------------------------------------------------------------------------
// WebSerial Connection & Machine Controller Manager
// Supports GRBL / Marlin serial communication, homing, zeroing, framing trace,
// interactive pauses for Manual Tool Changes (M6) and Material Swaps (M0), and
// an operator feed hold that can be lifted again without losing the program.
// ---------------------------------------------------------------------------

import {
  describeGrblAlarm,
  FEED_OVERRIDE_BYTES,
  RAPID_OVERRIDE_BYTES,
  SPINDLE_OVERRIDE_BYTES,
  type MachineStatus,
  type OverrideStep,
} from '@physbox-io/machining';
import { postMachineTelemetry,
  type RemoteCommand,
} from './apiClient';
import { cloudAutosave } from './cloudDocuments';
import {
  SerialTransport,
  CloudMachineTransport,
  isWebSerialSupported,
  type MachineTransport,
} from './machineTransport';
import { locateExecutedLine, planResume, scanModalState, type ResumeOptions } from './jobResume';
import { programTimeline, type ProgramTimeline } from './timeEstimate';
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
  parseGrblSettings,
  type MotionProfile,
} from './motionProfile';
import { withSpindleOverride } from './spindleOverride';

/*
 * One vocabulary across the three apps.
 *
 * This used to spell the operator's own feed hold `PAUSED_USER` while Volt and
 * Etch called the same state `PAUSED_OPERATOR`, which is the sort of difference
 * that costs nothing until something has to speak to all three — an agent, in
 * this case, being told a machine is in a state its tools have never heard of.
 */
export type { MachineStatus };

export interface MachineState {
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
  /** The line it stopped on, in the numbering the progress display counts in. */
  fromLine: number;
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
    const semi = raw.indexOf(';');
    let code = (semi < 0 ? raw : raw.slice(0, semi)).trim();
    let note = semi < 0 ? '' : raw.slice(semi + 1).trim();

    /*
     * Parenthesised comments count too.
     *
     * G-code has two comment syntaxes and this file used to know about one of
     * them, which mattered more than it sounds: the sheet-swap pause is written
     * `M0 (PAUSE: Insert Material Sheet 2 of 3)`, and with the parens unread
     * the prompt at the machine said "Programmed stop. Resume when ready." to
     * an operator holding three sheets of ply and no way to tell which one.
     */
    const parens = [...code.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim()).filter(Boolean);
    if (parens.length > 0) {
      code = code.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      note = [note, ...parens].filter(Boolean).join(' ');
    }

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
 * One line awaiting its `ok`.
 *
 * `job` slots carry their byte cost so the streamer knows how much of GRBL's
 * serial buffer it is currently occupying; `other` slots are the interactive
 * commands, which are paced one at a time and may have someone waiting on them.
 */
type AckSlot =
  | { kind: 'job'; bytes: number; programLine: number }
  | { kind: 'other'; resolve: (() => void) | null };

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
 * How long the controller may say nothing before the app says so, ms.
 *
 * Three seconds is ten missed status polls. Short enough that pressing start
 * and getting nothing is explained while the operator is still looking at the
 * screen; long enough to ride out a controller busy with a homing cycle, which
 * on a large machine can be a couple of seconds of not answering.
 */
const CONTROLLER_SILENCE_MS = 3000;

/**
 * How long the return path has to stay healthy before the warning is withdrawn.
 *
 * The warning has one threshold going up and another coming down on purpose. A
 * single late reply used to clear it and the next gap raised it again, so over
 * a link with any jitter — a Tekno Box relaying through the cloud, say — it
 * blinked in and out while nothing was wrong, which is worse than not showing
 * it: a banner that cries wolf is a banner nobody reads when the machine really
 * has stopped answering.
 *
 * Going up stays immediate. Being told late that a machine is unresponsive is
 * the failure that costs a workpiece.
 */
const CONTROLLER_RECOVERED_MS = 1500;

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
 * How long a soft reset is given to come back up, ms.
 *
 * GRBL empties its receive buffer as it reinitialises after `0x18`, so
 * anything sent behind the reset is thrown away unanswered - and a stale
 * `<Hold:0|...>` report already on the wire reads as the machine's position
 * after it. The welcome line is the controller saying it is listening again.
 * GRBL prints it within a few milliseconds; the timeout is only for one that
 * does not print it at all.
 */
const SOFT_RESET_BOOT_MS = 1000;

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

class WebSerialManager {
  /** The wire currently open, or null. See `machineTransport.ts`. */
  private transport: MachineTransport | null = null;
  private statusPollTimer: ReturnType<typeof setInterval> | null = null;

  private gcodeQueue: string[] = [];
  /** Trailing comments, index-aligned with `gcodeQueue`, for the pause prompts. */
  private gcodeNotes: string[] = [];
  private currentQueueIndex = 0;
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

  private isJobRunning = false;
  private isPaused = false;

  /**
   * Every line sent that still owes an `ok`, oldest first.
   *
   * GRBL answers in the order it was asked, so one FIFO covers both kinds of
   * traffic: the job stream, and the interactive commands the app sends
   * alongside it. Keeping them in one queue is the point.
   *
   * It used to be a queue of probe waiters only, and a job took any `ok` that
   * no waiter claimed as its own permission to send another line. Nothing the
   * app sent outside the stream registered a waiter — `sendLine` still doesn't
   * return one — so every such line's `ok` was miscounted as the job's, and the
   * streamer sent one more line than it had been acked for. The lead never
   * recovers: it persists for the rest of the program, and once it is wide
   * enough the lines outrun GRBL's 128-byte serial buffer, which merges two
   * blocks into one and produces `error:24`, "two G-code commands that both
   * require the use of the XYZ axis words", against a program that contains no
   * such line anywhere.
   */
  private ackQueue: AckSlot[] = [];

  /**
   * Bytes of job stream sitting in GRBL's serial buffer, unacknowledged.
   *
   * The sum of the `job` slots in `ackQueue`, kept alongside it so the pump
   * does not have to walk the queue on every line.
   */
  private jobBytesInFlight = 0;
  private pendingProbe: ((z: number | null) => void) | null = null;

  /** One-shot callbacks waiting for the controller's welcome line after a reset. */
  private bootWaiters = new Set<() => void>();

  /** `ALARM:` lines seen this session, so a probe can tell it alarmed. */
  private alarmCount = 0;

  /**
   * A jog is awaiting its `ok`, and clicks made meanwhile are merged into
   * `pendingJog` rather than written. See `jog`.
   */
  private jogBusy = false;
  private pendingJog: { x: number; y: number; z: number; feedrate: number } | null = null;

  /**
   * Lines collected while a `$$` dump is being read back.
   *
   * Non-null only for the moment the query is in flight, so ordinary traffic is
   * not accumulated for the life of the connection.
   */
  private settingsSink: string[] | null = null;

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
   * Whether a homing cycle has completed since this machine was connected.
   *
   * Homing is what makes machine coordinates mean anything: until it has run,
   * `MPos` is wherever the controller happened to power up, and a `G53` move is
   * a move to an arbitrary height. Taken off the controller's own state word
   * rather than off the button in this app, so a cycle run from a pendant
   * counts too — and dropped the moment an alarm arrives, because a hard limit
   * stops the axes by cutting the drive rather than by decelerating, and the
   * steps lost between the trip and the stop take the reference with them.
   */
  private hasHomed = false;
  /** A homing cycle seen running, waiting on the `Idle` that completes it. */
  private homingInProgress = false;

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

  private state: MachineState = {
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
    motion: withSpindleOverride(DEFAULT_MOTION_PROFILE),
    grblSettings: {},
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    elapsedSeconds: 0,
    estimatedSeconds: null,
    resume: null,
    park: null,
    guideSpot: false,
    controllerSilent: false,
    probePinActive: false,
    probeCircuitSeen: false,
    lastCompletedJob: null,
  };

  private listeners: Set<MachineStateListener> = new Set();

  /** When something last arrived from the controller, for `controllerSilent`. */
  private lastRxAt = 0;

  /** The guide spot's own deadline, and the `$32` it borrowed to exist. */
  private guideSpotTimer: ReturnType<typeof setTimeout> | null = null;
  private guideSpotRestoreLaserMode = false;
  private guideJiggleRunning = false;

  /** When the last telemetry POST went out, and whether one is still in flight. */
  private lastTelemetryAt = 0;
  private telemetryInFlight = false;
  /** What the running job is, as the run archive should remember it. */
  private jobContext: { name?: string; settings?: Record<string, unknown> | null } = {};
  private lastTelemetryStatus: MachineStatus | null = null;

  /** Whether a USB cable is an option in this browser. WiFi always is. */
  public isSupported(): boolean {
    return isWebSerialSupported();
  }

  public getState(): MachineState {
    return { ...this.state };
  }

  public addListener(listener: MachineStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const currentState = this.getState();
    this.listeners.forEach(l => l(currentState));
    this.publishTelemetry(currentState);
  }

  /**
   * Streams machine state to api.physbox.io so the remote dashboard has
   * something to show.
   *
   * `RemoteMachiningModal` has always been able to read this endpoint; until now
   * nothing in this app ever wrote to it, so the dashboard only ever showed
   * machines driven by the other apps in the ecosystem.
   *
   * Three things keep it from becoming a firehose. Nothing is sent while
   * disconnected, because a browser tab sitting on the editor is not a machine.
   * Between sends there is a floor of `TELEMETRY_INTERVAL_MS`, so the 5 Hz status
   * poll does not turn into 5 Hz of HTTP. And a status *change* — the alarm, the
   * tool-change pause, the end of the job — jumps that floor, because those are
   * exactly the moments the person watching the dashboard is waiting for, and
   * making them wait out the interval is how a two-second delay becomes the
   * reason nobody trusts the dashboard.
   */
  private publishTelemetry(state: MachineState) {
    if (!state.connected) return;

    const now = Date.now();
    const changed = state.status !== this.lastTelemetryStatus;
    if (!changed && now - this.lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;
    // One in flight at a time: a stalled network would otherwise queue up a
    // backlog of stale positions that all land at once when it recovers.
    if (this.telemetryInFlight) return;

    this.lastTelemetryAt = now;
    this.lastTelemetryStatus = state.status;
    this.telemetryInFlight = true;

    void postMachineTelemetry('physics', {
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
    })
      .then((commands) => this.applyRemoteCommands(commands))
      .finally(() => {
        this.telemetryInFlight = false;
      });
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

  private updateState(patch: Partial<MachineState>) {
    // Every write of the profile goes through the override, so no path that
    // sets it — connect, disconnect, a fresh `$$` — can forget to apply it.
    if (patch.motion) {
      this.reportedMotion = patch.motion;
      patch = { ...patch, motion: withSpindleOverride(patch.motion) };
    }
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  /** Re-applies the spindle override after it changes, here or from the account. */
  public reapplySpindleOverride(): void {
    this.updateState({ motion: this.reportedMotion });
  }

  /**
   * Opens a wire to the machine.
   *
   * With no argument this is the USB cable it always was. Given a Tekno Box
   * address it goes over WiFi instead, through the box's WebSocket relay — the
   * same GRBL on the other end either way, which is why everything below this
   * point is unchanged by the choice. See `machineTransport.ts`.
   */
  /**
   * The wire to open when `connect()` is called with no argument.
   *
   * `MachineControl` — what the MCP handlers talk to — picks the transport and
   * then connects in two steps, because that is the shape the other apps'
   * managers have. This holds the choice in between. The app's own UI still
   * passes the link straight to `connect`, which is the clearer call when you
   * have it to hand.
   */
  private pendingLink: MachineLink | null = null;

  /** Chooses the wire for a later `connect()`. See `pendingLink`. */
  public setTransport(mode: 'usb' | 'wifi', deviceId?: string): void {
    this.pendingLink =
      mode === 'wifi' ? { kind: 'cloud', deviceId: deviceId ?? '' } : { kind: 'usb' };
  }

  /** Which wire is open, or would be opened, in the other apps' vocabulary. */
  public getTransportMode(): 'usb' | 'wifi' {
    if (this.transport) return this.transport.runJob ? 'wifi' : 'usb';
    return this.pendingLink?.kind === 'cloud' ? 'wifi' : 'usb';
  }

  /** Whether a job is streaming right now. */
  public isRunning(): boolean {
    return this.isJobRunning;
  }

  /** Whether a job is part-streamed and waiting. */
  public isJobPaused(): boolean {
    return this.isPaused;
  }

  /**
   * The operation being cut.
   *
   * Always null here: this app's programs are not divided into named
   * operations the way a board's isolation, drilling and profiling passes are.
   * A tool change is still a tool change, and shows up in the pause message.
   */
  public getCurrentLayer(): null {
    return null;
  }

  /** The controller's `$$` settings, in the shape the shared tools expect. */
  public getGrblSettings(): Map<number, number> {
    return new Map(
      Object.entries(this.state.grblSettings).map(([k, v]) => [Number(k), v] as [number, number])
    );
  }

  /**
   * Asks the controller where it is and waits for the answer, so a caller about
   * to reason about the tool's position reads one from now rather than from up
   * to a poll interval ago.
   */
  public async refreshPosition(): Promise<MachineState> {
    if (this.state.connected) {
      await this.writeRealtime(0x3f); // '?' — status request
      await new Promise<void>(resolve => setTimeout(resolve, 250));
    }
    return this.getState();
  }

  public async connect(link?: MachineLink): Promise<boolean> {
    const chosen: MachineLink = link ?? this.pendingLink ?? { kind: 'usb' };
    return this.openLink(chosen);
  }

  private async openLink(link: MachineLink): Promise<boolean> {
    const transport =
      link.kind === 'cloud'
        ? new CloudMachineTransport(link.deviceId, link.deviceName)
        : new SerialTransport(link.baudRate ?? 115200);

    try {
      /*
       * Whatever went wrong last time is not true any more.
       *
       * Nothing ever cleared this, so the message from a dropped cable — or a
       * connection attempt that failed once — outlived the machine coming back
       * and sat there for the rest of the session, telling someone looking at a
       * live connection that it had dropped. An error describes a moment, and
       * this is a new one.
       */
      this.updateState({ status: 'CONNECTING', lastError: undefined });

      await transport.open(
        (line: string) => this.handleIncomingLine(line),
        () => void this.handleTransportDropped()
      );

      this.transport = transport;
      this.startStatusPolling();
      // A freshly opened port may report a Z work offset left over from a
      // previous session, tool, or stock — GRBL has no way to say whether
      // this operator has touched it off since, so it starts untrusted.
      // The probe circuit likewise: whatever was proved last time belonged to
      // the old connection, and this may be a different machine.
      this.updateState({
        status: 'IDLE',
        connected: true,
        portName: transport.label,
        needsZZero: true,
        probePinActive: false,
        probeCircuitSeen: false,
      });

      // Ask what it is before anything else needs to know. Not awaited: the
      // connection is usable the moment it is open, and a controller that is
      // slow to answer `$$` must not hold the UI on "connecting".
      void this.refreshMachineSettings();
      return true;
    } catch (err) {
      await transport.close().catch(() => {});
      this.updateState({
        status: 'DISCONNECTED',
        connected: false,
        lastError: (err instanceof Error && err.message) || 'Failed to connect to the machine.',
      });
      return false;
    }
  }

  /**
   * The wire went away on its own — a pulled cable, a box that lost WiFi.
   *
   * Routed through `disconnect` so a drop and a deliberate close leave exactly
   * the same state behind, including keeping the line a running job reached so
   * it can be picked up once the cable is back in.
   */
  private async handleTransportDropped(): Promise<void> {
    if (!this.state.connected) return;
    await this.disconnect();
    this.updateState({
      lastError: 'The connection to the machine dropped.',
    });
  }

  /** Closes serial connection. */
  public async disconnect(): Promise<void> {
    this.stopStatusPolling();
    // The beam is out because the machine is gone. `$32` cannot be put back
    // over a wire that has closed, which is what the breadcrumb in local
    // storage is for — the next connection restores it.
    this.clearGuideSpotTimeout();
    // Before the flag is cleared, so the line it reached is kept: a nudged USB
    // cable is the commonest way a long carve dies, and the program is still
    // right here.
    if (this.isJobRunning || this.isPaused) this.abandonJob('disconnected');
    this.isJobRunning = false;

    try {
      if (this.transport) await this.transport.close();
    } catch {
      // ignore cleanup errors
    }

    this.transport = null;
    this.settingsSink = null;
    // The next machine on the end of the cable is not this one, and has not
    // been homed by anybody.
    this.hasHomed = false;
    this.homingInProgress = false;
    // Back to assumptions: the numbers belonged to a machine that is no longer
    // on the other end of the cable, and leaving them in place would have the
    // next estimate quietly claiming to have been read off nothing.
    this.updateState({
      status: 'DISCONNECTED',
      connected: false,
      motion: DEFAULT_MOTION_PROFILE,
      grblSettings: {},
      overrides: { feed: 100, rapid: 100, spindle: 100 },
      guideSpot: false,
      controllerSilent: false,
      // No machine, no proved circuit: the next one on the cable proves its own.
      probePinActive: false,
      probeCircuitSeen: false,
    });
  }

  /**
   * Sends a single G-code line to the machine, however it is connected.
   *
   * The line is booked into `ackQueue` before it goes out. Nobody is waiting on
   * it — that is what `sendAndWait` is for — but the `ok` it will produce has
   * to be accounted for, or the job stream takes it as permission to send a
   * line it has not been acked for. Realtime bytes are exempt and go through
   * `writeRealtime`, because GRBL answers those out of band and never with an
   * `ok`.
   */
  public async sendLine(command: string): Promise<void> {
    if (!this.transport || !this.state.connected) return;
    this.ackQueue.push({ kind: 'other', resolve: null });
    // Bare: each transport frames the line the way its own wire needs.
    await this.transport.writeLine(command);
  }

  /** Parses GRBL response lines like 'ok', 'error:', or '<Idle|MPos:10,20,0|WPos:10,20,0>'. */
  private handleIncomingLine(line: string) {
    if (!line) return;

    // Anything at all counts as the controller being alive, status reports
    // included — they are the thing the silence watchdog is really listening
    // for, since they arrive whether or not a job is running.
    this.lastRxAt = Date.now();
    if (this.state.controllerSilent) this.updateState({ controllerSilent: false });

    // GRBL Status Parsing: <Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>
    if (line.startsWith('<') && line.endsWith('>')) {
      this.parseStatusReport(line.slice(1, -1));
      return;
    }

    /*
     * The welcome line, `Grbl 1.1h ['$' for help]` (`GrblHAL ...` and FluidNC's
     * `Grbl 3.x [FluidNC ...]` too): the controller has just restarted.
     *
     * Whatever it had been sent before is gone with its receive buffer, so no
     * `ok` is coming for any of it. Left booked, those slots ate the replies
     * meant for the next probe or `$$`, one each.
     */
    if (/^Grbl/i.test(line)) {
      this.dropPendingAcks();
      // A restart nobody here asked for, mid-job: the program has stopped on
      // the controller, and the stream would otherwise sit waiting for acks
      // that will never come.
      if (this.isJobRunning || this.isPaused) {
        this.abandonJob('alarm');
        this.stopElapsedTicker();
        this.updateState({
          status: 'IDLE',
          lastError:
            'The controller restarted in the middle of the job, so the job has stopped. ' +
            'Check where the tool is, re-home if the machine has lost its position, then resume.',
        });
      }
      const waiters = [...this.bootWaiters];
      this.bootWaiters.clear();
      waiters.forEach((w) => w());
      return;
    }

    /*
     * `ALARM:N`, said once, ahead of the `Alarm` state word the status reports
     * then carry. That word stops the job; this line is the only place the
     * controller says *why*, and it went unread - a probe that ran out of travel
     * showed as nothing but a refused `G90` afterwards.
     */
    if (line.startsWith('ALARM:')) {
      this.alarmCount++;
      const failProbe = this.pendingProbe;
      this.pendingProbe = null;
      if (failProbe) failProbe(null);
      this.updateState({ lastError: describeGrblAlarm(line) });
      return;
    }

    // Probe result: [PRB:0.000,0.000,-12.345:1], the machine position where the
    // probe triggered, and 1/0 for whether it made contact at all. This is the
    // only place the machine reports a measurement, so a probing cycle that does
    // not read it is just driving the tool into the bed and recording nothing.
    if (line.startsWith('[PRB:')) {
      const body = line.slice(5).replace(/\]$/, '');
      const [coords, success] = body.split(':');
      const parts = coords.split(',').map(Number);
      const contact = success === undefined || success.trim() === '1';
      const z = parts.length >= 3 && Number.isFinite(parts[2]) ? parts[2] : null;
      const resolve = this.pendingProbe;
      this.pendingProbe = null;
      if (resolve) resolve(contact ? z : null);
      return;
    }

    // `$N=value`, the reply to `$$`. Collected rather than acted on: the whole
    // dump arrives as a hundred-odd lines followed by a single `ok`, and it is
    // only worth anything read as a set.
    if (this.settingsSink !== null && line.startsWith('$')) {
      this.settingsSink.push(line);
      return;
    }

    if (line.startsWith('ok')) {
      // Replies come back in the order the lines went out, so the ack belongs
      // to the oldest unanswered line whatever kind it was.
      const slot = this.ackQueue.shift();
      if (slot?.kind === 'job') {
        this.jobBytesInFlight = Math.max(0, this.jobBytesInFlight - slot.bytes);
        if (slot.programLine + 1 > this.ackedLines) this.ackedLines = slot.programLine + 1;
        this.pumpJobQueue();
      } else if (slot?.kind === 'other') {
        slot.resolve?.();
      }
    } else if (line.startsWith('error:')) {
      // A refused command never completes, so release whoever is waiting on it
      // rather than hanging the cycle until its timeout.
      const failProbe = this.pendingProbe;
      this.pendingProbe = null;
      if (failProbe) failProbe(null);
      const slots = this.ackQueue;
      this.ackQueue = [];
      this.jobBytesInFlight = 0;
      for (const s of slots) if (s.kind === 'other') s.resolve?.();

      /*
       * Which line was refused.
       *
       * Not the one most recently sent: the streamer keeps GRBL's buffer full,
       * so several lines are in flight and the refusal belongs to the oldest of
       * them — the head of the queue, the same ordering every other ack
       * follows. Counting them back off the send index is what keeps the line
       * number in the error message pointing at the line the operator has to go
       * and look at.
       */
      const jobSlotsInFlight = slots.reduce((n, s) => n + (s.kind === 'job' ? 1 : 0), 0);

      /*
       * A refused line ends the job, and says so.
       *
       * The refusal is an ack that will not come again, so the stream stalls on
       * it: nothing more is sent, and the app went on showing RUNNING at
       * whatever percentage it had reached — a job that had stopped dead,
       * presented as one still cutting. Standing it down keeps the resume
       * point, so the operator can fix whatever was refused and pick the
       * program back up.
       */
      if (this.isJobRunning || this.isPaused) {
        const at = Math.max(
          0,
          this.jobLineBase + this.currentQueueIndex - jobSlotsInFlight + 1
        );
        this.abandonJob('alarm');
        this.stopElapsedTicker();
        this.updateState({
          status: 'IDLE',
          lastError:
            `The machine refused line ${at} of the program (${line}), so the job has stopped ` +
            `there. ${describeGrblError(line)}`,
        });
      } else {
        this.updateState({ lastError: `Machine Error: ${line}` });
      }
    }
  }

  /**
   * Reads one `<...>` status report into machine state.
   *
   * The two position fields are alternatives, not a pair: `$10` selects which
   * one the controller sends, and the default build sends `MPos` only. Work
   * position therefore has to be *derived* — machine position minus the work
   * coordinate offset — rather than waited for, which is why `wpos` used to sit
   * at zero for the whole of a job on a stock GRBL.
   *
   * `WCO` itself only rides along every tenth report or so, because it rarely
   * changes and the report is kept short, so the last one seen is retained.
   */
  private parseStatusReport(body: string) {
    const parts = body.split('|');
    // 'Hold:0' and 'Door:1' carry a sub-state after the colon.
    const machineWord = parts[0].split(':')[0];
    const subState = parts[0].split(':')[1];

    /*
     * Whether a feed hold has finished decelerating.
     *
     * GRBL says 'Hold:1' while the axes are still slowing and 'Hold:0' once
     * they have stopped. Parking waits on this: a soft reset taken while
     * anything is still moving loses the position and comes back in alarm,
     * which is the one outcome parking exists to avoid.
     */
    if (machineWord === 'Hold') {
      this.lastHoldState = subState === '0' ? 'complete' : 'decelerating';
    } else {
      this.lastHoldState = null;
    }

    let mpos: [number, number, number] | null = null;
    let wpos: [number, number, number] | null = null;
    let pins = '';
    let bufferFree: number | null = null;
    const patch: Partial<MachineState> = {};

    for (const part of parts.slice(1)) {
      const sep = part.indexOf(':');
      if (sep < 0) continue;
      const key = part.slice(0, sep);
      const nums = part.slice(sep + 1).split(',').map(Number);

      if (key === 'MPos' && nums.length >= 3) mpos = [nums[0], nums[1], nums[2]];
      else if (key === 'WPos' && nums.length >= 3) wpos = [nums[0], nums[1], nums[2]];
      else if (key === 'WCO' && nums.length >= 3) this.workOffset = [nums[0], nums[1], nums[2]];
      // `FS:500,12000` is feed and spindle; a controller built without the
      // variable-spindle option reports `F:500` and no S at all.
      else if (key === 'FS' && nums.length >= 2) {
        patch.feedRate = nums[0] || 0;
        patch.spindleSpeed = nums[1] || 0;
      } else if (key === 'F' && nums.length >= 1) {
        patch.feedRate = nums[0] || 0;
      }
      // `Ov:100,100,100` — feed, rapid and spindle trim, as percentages.
      else if (key === 'Ov' && nums.length >= 3) {
        patch.overrides = { feed: nums[0], rapid: nums[1], spindle: nums[2] };
      }
      // `Bf:15,128` — planner blocks and serial bytes free. Only sent when `$10`
      // asks for it, and read only to say how far behind the acks the cut is.
      else if (key === 'Bf' && nums.length >= 1 && Number.isFinite(nums[0])) {
        bufferFree = nums[0];
      }
      // `Pn:P` — the asserted input pins. GRBL lists them only while one is
      // asserted, so a report with no `Pn` field means the probe is open.
      else if (key === 'Pn') pins = part.slice(sep + 1);
    }

    const probePinActive = /P/.test(pins);
    if (probePinActive !== this.state.probePinActive) patch.probePinActive = probePinActive;
    if (probePinActive && !this.state.probeCircuitSeen) patch.probeCircuitSeen = true;

    // The controller's own state word, not just its alarms.
    //
    // Only 'Alarm' used to be read, and nothing else ever set the status back, so
    // one limit switch left the app in ALARM for the rest of the session — `$X`
    // cleared the machine while the UI still refused to start a job, and the only
    // way out was a page reload. The local job states win over the report, since
    // a tool-change pause is a state this side holds while GRBL sits Idle.
    // `Home` is only reported while a homing cycle is actually running, so the
    // Idle that follows one is the moment machine coordinates become real.
    if (machineWord === 'Home') {
      this.homingInProgress = true;
    } else if (machineWord === 'Idle' && this.homingInProgress) {
      this.homingInProgress = false;
      this.hasHomed = true;
    }

    if (machineWord === 'Alarm') {
      patch.status = 'ALARM';
      // A limit switch mid-carve kills the job on the controller — GRBL will not
      // run another line until it is unlocked. The queue is dropped so nothing
      // streams on into a machine that has lost its position; the line it
      // reached is kept, so the operator can deliberately pick it back up once
      // the machine has been rehomed and the tool re-zeroed.
      if (this.isJobRunning || this.isPaused) this.abandonJob('alarm');
      // Whatever the controller now thinks `MPos` is, it is not where the tool
      // is: `G53` stops being a safe way to ask for a height until the machine
      // has been homed again.
      this.hasHomed = false;
      this.homingInProgress = false;
    } else if (!this.isPaused) {
      // RUNNING here means "a job is streaming", not "the axes are moving" — a
      // frame trace or a probing move must not light up the job progress bar.
      // A streaming job likewise stays RUNNING through the Idle reports it sits
      // in between lines.
      if (['Idle', 'Run', 'Jog', 'Home', 'Check'].includes(machineWord)) {
        patch.status = this.isJobRunning ? 'RUNNING' : 'IDLE';
      }
      // 'Hold' and 'Door' are left alone: the job is still the job, and the
      // resume path owns that transition.
    }

    const [ox, oy, oz] = this.workOffset;
    if (mpos) {
      patch.mpos = { x: mpos[0], y: mpos[1], z: mpos[2] };
      patch.wpos = { x: mpos[0] - ox, y: mpos[1] - oy, z: mpos[2] - oz };
    } else if (wpos) {
      patch.wpos = { x: wpos[0], y: wpos[1], z: wpos[2] };
      patch.mpos = { x: wpos[0] + ox, y: wpos[1] + oy, z: wpos[2] + oz };
    }
    if (patch.wpos && (this.isJobRunning || this.isPaused) && machineWord !== 'Alarm') {
      this.jobPeakWorkZ = Math.max(this.jobPeakWorkZ ?? -Infinity, patch.wpos.z);
    }

    this.plannerFree = bufferFree;
    if (bufferFree !== null) this.plannerSize = Math.max(this.plannerSize ?? 0, bufferFree);
    // Into the same update, so a report is one notification. Not on an alarm:
    // the position is a fiction from then on, and the job has been abandoned.
    if ((this.isJobRunning || this.isPaused) && machineWord !== 'Alarm') {
      Object.assign(patch, this.advanceCut(patch.wpos ?? null));
    }

    // One update for the whole report: each one notifies every listener, and
    // the telemetry publisher hangs off that.
    this.updateState(patch);

    // Anything waiting on a position from *now* rather than from up to a poll
    // interval ago has one.
    const waiters = [...this.statusWaiters];
    this.statusWaiters.clear();
    waiters.forEach(w => w());
  }

  /** Last `WCO` seen, retained between the reports that carry one. */
  private workOffset: [number, number, number] = [0, 0, 0];

  /** One-shot callbacks awaiting the next status report. */
  private statusWaiters = new Set<() => void>();

  /**
   * Asks for a status report and waits for it, so a caller about to reason
   * about where the tool *is* reads a position from now. Resolves on timeout
   * anyway: a stale reading is the caller's problem to be safe about, and
   * hanging here would strand whatever it was doing.
   */
  private async nextStatusReport(timeoutMs = 1000): Promise<void> {
    if (!this.transport || !this.state.connected) return;
    await new Promise<void>((resolve) => {
      const fire = () => {
        clearTimeout(timer);
        this.statusWaiters.delete(fire);
        resolve();
      };
      const timer = setTimeout(fire, timeoutMs);
      this.statusWaiters.add(fire);
      void this.writeRealtime(0x3f); // '?'
    });
  }

  /**
   * Forgets every line still owed an `ok`, releasing anyone waiting on one.
   *
   * For the moments the controller has thrown its receive buffer away (a
   * reset) or the stream is taking the channel over: the replies those slots
   * were booked for are not coming, and each one left behind would take the
   * `ok` meant for the next command sent.
   */
  private dropPendingAcks(): void {
    const stale = this.ackQueue;
    this.ackQueue = [];
    this.jobBytesInFlight = 0;
    for (const s of stale) if (s.kind === 'other') s.resolve?.();
  }

  /**
   * Soft-resets the controller (`0x18`) and waits for it to come back up.
   *
   * Nothing may follow the reset byte until the welcome line has arrived: GRBL
   * clears its receive buffer while reinitialising, so a line sent straight
   * after it was discarded without a reply, and its booked `ok` then answered
   * the next command instead. Resolves false if no welcome line came within
   * `SOFT_RESET_BOOT_MS`, in which case the caller carries on regardless,
   * as everything did before this waited at all.
   */
  private async softReset(): Promise<boolean> {
    this.dropPendingAcks();
    let done!: (booted: boolean) => void;
    const booted = new Promise<boolean>((resolve) => { done = resolve; });
    const onBoot = () => {
      clearTimeout(timer);
      done(true);
    };
    const timer = setTimeout(() => {
      this.bootWaiters.delete(onBoot);
      done(false);
    }, SOFT_RESET_BOOT_MS);
    this.bootWaiters.add(onBoot);
    await this.writeRealtime(0x18); // Ctrl-X
    return booted;
  }

  /**
   * Sends one line and waits for the controller to accept it, so a probing
   * sequence steps rather than races. `ok` means accepted into the planner, not
   * finished moving — GRBL runs its queue in order, so the probe that follows
   * still happens after the move it was queued behind.
   *
   * Replies are matched to commands in order, which is why the waiters are a
   * queue and not a single slot: `G38.2` is two lines with two replies, and a
   * single slot would let the second one satisfy the next command's wait.
   */
  private sendAndWait(command: string, timeoutMs = 30000): Promise<void> {
    if (!this.transport || !this.state.connected) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Give the slot up rather than dropping it: the reply may still arrive,
        // and a slot removed from the middle would shift every later ack onto
        // the wrong command.
        for (const slot of this.ackQueue) {
          if (slot.kind === 'other' && slot.resolve === finish) slot.resolve = null;
        }
        finish();
      }, timeoutMs);
      if (!this.transport || !this.state.connected) {
        finish();
        return;
      }
      this.ackQueue.push({ kind: 'other', resolve: finish });
      void this.transport.writeLine(command);
    });
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
    return this.probeOnce(searchDepthMm, feedrate, timeoutMs);
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
      return (
        'The probe circuit has not been proved on this connection. Clip the lead on, touch ' +
        'the tool to the plate by hand until the probe light comes on, then try again. A ' +
        'probe stops only when that circuit closes; without it the tool is driven into the work.'
      );
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
   */
  private async probeOnce(searchDepthMm: number, feedrate: number, timeoutMs: number): Promise<number | null> {

    let settle: (z: number | null) => void;
    const reported = new Promise<number | null>((resolve) => { settle = resolve; });
    let done = false;
    const finish = (z: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(z);
    };
    const timer = setTimeout(() => {
      if (this.pendingProbe === finish) this.pendingProbe = null;
      finish(null);
    }, timeoutMs);
    this.pendingProbe = finish;
    const alarmsBefore = this.alarmCount;

    // GRBL reports [PRB:] before acknowledging the probe, so by the time these
    // return the measurement is already in hand.
    await this.sendAndWait(`G91 G38.2 Z-${searchDepthMm.toFixed(3)} F${Math.round(feedrate)}`, timeoutMs);
    // Not into an alarm. A probe that ran out of travel leaves GRBL in ALARM:5,
    // which refuses the `G90` (error:9) and buries the alarm's own message
    // under that one. `unlockAlarm` puts absolute mode back instead.
    if (this.alarmCount === alarmsBefore && this.state.status !== 'ALARM') {
      await this.sendAndWait('G90', timeoutMs);
    }

    // A probe that ran to its full travel without touching reports no contact
    // and never sends [PRB:], so stop waiting on it here.
    finish(null);
    return reported;
  }

  /** Polls GRBL status with '?' every 300ms. */
  private startStatusPolling() {
    this.stopStatusPolling();
    this.lastRxAt = Date.now();
    this.statusPollTimer = setInterval(() => {
      if (!this.state.connected || !this.transport) return;
      void this.transport.writeRealtime(0x3f); // '?'

      // The poll doubles as a heartbeat. A controller that is listening answers
      // every one of these, so several seconds without a word back means the
      // return path is dead however healthy the outgoing one looks — and the
      // outgoing one always looks healthy, because writing to a serial port
      // succeeds whether or not anything is reading it.
      /*
       * Asymmetric on purpose — see CONTROLLER_RECOVERED_MS. Raised the moment
       * the machine has been quiet too long; withdrawn only once it has been
       * answering again for a while, so ordinary jitter cannot make it blink.
       */
      const quietFor = Date.now() - this.lastRxAt;
      const silent = this.state.controllerSilent
        ? quietFor > CONTROLLER_RECOVERED_MS
        : quietFor > CONTROLLER_SILENCE_MS;
      if (silent !== this.state.controllerSilent) {
        this.updateState({ controllerSilent: silent });
      }
    }, 300);
  }

  private stopStatusPolling() {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
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
    options: { name?: string; estimatedSeconds?: number; settings?: Record<string, unknown> | null } = {}
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
        'Z zero has not been set this session. Set it in Machine Setup before running a job — ' +
        'a Z move against an unconfirmed datum can drive the tool into the stock.';
      this.updateState({ lastError: message });
      return null;
    }

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
        pauseMessage: result.delivered ? undefined : result.message,
      });
      if (result.delivered) {
        this.jobStartedAt = Date.now();
        this.startElapsedTicker();
      }
      return result;
    }

    this.startJob(gcode, options.estimatedSeconds);
    return null;
  }

  public startJob(gcode: string, estimatedSeconds?: number) {
    if (!this.state.connected) return;
    if (this.isJobRunning || this.isPaused) return; // see runJob

    this.jobStartedAt = Date.now();
    this.startElapsedTicker();

    const prepared = prepareJobLines(gcode);
    this.program = prepared;
    this.gcodeQueue = prepared.map(l => l.code);
    this.gcodeNotes = prepared.map(l => l.note);
    this.currentQueueIndex = 0;
    this.jobLineBase = 0;
    this.isJobRunning = true;
    this.isPaused = false;
    this.jobPeakWorkZ = null;
    this.drainedPause = null;

    this.updateState({
      status: 'RUNNING',
      ...this.beginCutTracking(0),
      totalLines: this.gcodeQueue.length,
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
      // Left as-is deliberately: `runJob` has already refused to reach here
      // while Z is untrusted, and clearing it just because a program started
      // would be assuming the operator re-zeroed rather than checking.
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

    this.beginStreaming();
  }

  /**
   * Hands the ack channel to the job queue and starts it streaming.
   *
   * A lit guide spot goes out first, and the stream waits for it. Put out
   * alongside the stream, its `$32=1` reached GRBL behind the job's first lines
   * - and GRBL refuses a setting while it is running (error:8), which aborted
   * the job it had just started and left laser mode off. Its jiggle has to have
   * stopped too: GRBL takes no G-code while it is jogging.
   */
  private beginStreaming(): void {
    const queue = this.gcodeQueue;
    const go = () => {
      // Cancelled, or replaced by another job, while the beam was going out.
      if (!this.isJobRunning || this.isPaused || this.gcodeQueue !== queue) return;
      // A slot left over from a probe or a zeroing move that timed out would
      // eat the first `ok` the program earns - after which the byte count never
      // comes back down and the stream sits at line one, for ever, showing
      // RUNNING. Whatever those were pacing finished before this program started.
      this.dropPendingAcks();
      this.pumpJobQueue();
    };
    if (this.state.guideSpot) void this.guideSpotOff().then(go);
    else go();
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
  private programLength(): number {
    return this.program.length;
  }

  /**
   * Restarts the stored program part way through.
   *
   * The hard part is not the streaming, it is that line eleven thousand of a
   * G-code file means nothing on its own — the units, the coordinate system,
   * the feedrate, the spindle speed and the depth the tool is meant to be at
   * were all established thousands of lines earlier. So the program is replayed
   * without being sent (see `jobResume`), and what comes back is a short
   * preamble that puts the machine into that state: retract, spindle back up to
   * speed, move over the point it stopped at, and only then descend into the
   * cut at a feedrate rather than a rapid.
   *
   * The preamble is prepended to the tail of the program and the whole thing is
   * streamed as one job, so a pause or a second failure part way through a
   * resumed job behaves exactly like any other.
   *
   * What this deliberately does *not* do is check that the operator is ready.
   * A resume after a snapped cutter is a resume onto a different tool, whose
   * length is different, which makes the existing Z datum wrong in the
   * direction of driving the new tool into the work. That is what `needsZZero`
   * is for, and the caller is expected to have dealt with it.
   */
  public resumeFromLine(fromLine: number, options?: ResumeOptions): { ok: boolean; message: string } {
    if (!this.state.connected) {
      return { ok: false, message: 'Not connected to a machine.' };
    }
    if (this.isJobRunning || this.isPaused) {
      return { ok: false, message: 'A job is already running. Cancel it before resuming another.' };
    }
    if (this.program.length === 0) {
      return { ok: false, message: 'There is no program to resume — nothing has been sent this session.' };
    }

    fromLine = this.pastHandledToolChange(fromLine);

    const plan = planResume(this.program.map((l) => l.code), fromLine, {
      ...options,
      currentZ: this.state.wpos.z,
      arrivingAtPause: this.lineIsPause(fromLine),
    });
    const preamble = prepareJobLines(plan.preamble.join('\n'));
    const tail = this.program.slice(plan.fromLine);

    this.gcodeQueue = [...preamble.map((l) => l.code), ...tail.map((l) => l.code)];
    this.gcodeNotes = [...preamble.map((l) => l.note), ...tail.map((l) => l.note)];
    this.currentQueueIndex = 0;
    // The preamble's lines are not in the program, so the program line that
    // queue position 0 corresponds to is behind where it picks up.
    this.jobLineBase = plan.fromLine - preamble.length;
    this.isJobRunning = true;
    this.isPaused = false;
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

    this.beginStreaming();

    return {
      ok: true,
      message: plan.state.uncertain
        ? `Resuming at line ${plan.fromLine}. ${plan.state.uncertainBecause}`
        : `Resuming at line ${plan.fromLine} of ${this.programLength()}.`,
    };
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
   * Sends as much of the program as GRBL's serial buffer will hold.
   *
   * The character-counting protocol: keep a running total of the bytes written
   * that have not yet been acknowledged, and send the next line whenever it
   * fits inside `RX_FILL_BYTES`. GRBL acks on parse rather than on motion, so
   * the buffer stays full and the 15-block planner behind it always has moves
   * to look ahead at — which is what lets it carry speed through a corner
   * instead of decelerating to a stop at the end of every block.
   *
   * A pause stops the pump where it stands. The lines already in the buffer
   * still run, which is correct: GRBL executes them in order, so the retract
   * and park that `triggerPause` sends land after the last of the cutting moves
   * rather than in the middle of them.
   */
  private pumpJobQueue() {
    while (this.isJobRunning && !this.isPaused) {
      if (this.currentQueueIndex >= this.gcodeQueue.length) {
        // Everything is sent, but the machine may still be working through what
        // is in its buffer. The job is over when the last line is acked.
        if (this.jobBytesInFlight === 0) {
          this.isJobRunning = false;
          // Read before the ticker stops, which forgets when the job started.
          const elapsedSeconds = this.jobStartedAt === null
            ? this.state.elapsedSeconds
            : Math.round((Date.now() - this.jobStartedAt) / 1000);
          this.stopElapsedTicker();
          // It finished. There is nothing left to resume into — here or in
          // storage, where an offer left standing would invite somebody to
          // descend into a piece that has already come off the bed.
          clearCheckpoint();
          this.updateState({
            status: 'IDLE',
            currentLine: this.programLength(),
            progressPercent: 100,
            remainingSeconds: 0,
            resume: null,
            elapsedSeconds,
            lastCompletedJob: {
              finishedAt: Date.now(),
              elapsedSeconds,
              estimatedSeconds: this.state.estimatedSeconds,
              totalLines: this.state.totalLines,
            },
          });
        }
        return;
      }

      const bytes = this.gcodeQueue[this.currentQueueIndex].length + 1;
      // Always allow one line through, however long: a line that cannot fit an
      // empty buffer would otherwise stall the job for ever.
      if (this.jobBytesInFlight > 0 && this.jobBytesInFlight + bytes > RX_FILL_BYTES) return;

      if (!this.sendNextJobLine(bytes)) return;
    }
  }

  /**
   * Sends one line, or takes the pause it asks for.
   *
   * Returns false when the pump must stop — the line was a tool change or a
   * programmed stop, and nothing further should go out until the operator says
   * so.
   */
  private sendNextJobLine(bytes: number): boolean {
    const line = this.gcodeQueue[this.currentQueueIndex];
    const note = this.gcodeNotes[this.currentQueueIndex] || '';
    this.currentQueueIndex++;

    // The program line this queue entry is, for the ack to credit. Below where
    // the program picks up during a resume's preamble, which is not in it.
    const programLine = this.jobLineBase + this.currentQueueIndex - 1;

    // A tool change or a programmed stop is the operator's cue, not a fault.
    // Neither is sent on: GRBL rejects M6 unless it was built with it, and the
    // pause has already been taken here.
    const kind = classifyJobLine(line);

    if (kind === 'tool-change') {
      void this.triggerPause('PAUSED_TOOL', this.describeToolChange(line, note));
      return false;
    }

    if (kind === 'stop') {
      // The contour-slice export puts one of these between sheets, and says
      // which sheet in the comment.
      const sheet = note.match(/Sheet (\d+ of \d+)/);
      if (sheet) {
        void this.triggerPause('PAUSED_MATERIAL', `Insert Material Sheet ${sheet[1]}`);
      } else {
        void this.triggerPause('PAUSED_MATERIAL', note || 'Programmed stop. Resume when ready.');
      }
      return false;
    }

    if (!this.transport || !this.state.connected) return false;
    // Booked as a job slot rather than going through `sendLine`, so its ack is
    // credited back to the stream's byte count and not to an interactive
    // command that never asked for one.
    this.ackQueue.push({ kind: 'job', bytes, programLine });
    this.jobBytesInFlight += bytes;
    void this.transport.writeLine(line);
    return true;
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
    for (let i = this.currentQueueIndex; i < Math.min(this.gcodeQueue.length, this.currentQueueIndex + 5); i++) {
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

  /** Triggers an interactive pause for Tool or Material Changes. */
  private async triggerPause(type: 'PAUSED_TOOL' | 'PAUSED_MATERIAL', message: string) {
    this.isPaused = true;
    // The pump has stopped at the pause line, which is the line just taken.
    const pauseLine = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex - 1));
    this.drainedPause = null;
    this.updateState({
      status: type,
      // Not the real prompt yet: the moves already in the controller's buffer
      // are still being cut, sometimes for a quarter of a minute, and a banner
      // saying "fit the next tool" over a spindle that is still carving is
      // what made the lift that follows look like it came from nowhere.
      pauseMessage: type === 'PAUSED_TOOL'
        ? 'Finishing the moves already sent, then stopping for a tool change…'
        : 'Finishing the moves already sent, then stopping…',
      // A new bit is a new tool length, so the datum the job was started on no
      // longer describes where the tip is. Resume is gated on this being dealt
      // with, either by probing again or by touching off by hand.
      needsZZero: type === 'PAUSED_TOOL' ? true : this.state.needsZZero,
    });

    // Let the buffer run dry before deciding anything about height. GRBL acks a
    // dwell only once the planner is empty, so from the `ok` on, every line sent
    // before the pause has been cut — including the program's own retract,
    // which a relief carve makes to Z20 just before its `M6`. The lift used to
    // be sized from where the tool stood when the pump stopped, 15 s and 23 mm
    // lower, and was then added on top of that retract and into the limit switch.
    await this.sendLine('M5'); // Laser/Spindle OFF
    await this.sendAndWait('G4 P0', PAUSE_DRAIN_TIMEOUT_MS);
    // An alarm or a cancel while draining has already dealt with the job; a
    // lift and park into a machine that is no longer this job's would be wrong.
    if (!this.isPaused || this.state.status !== type) return;
    await this.nextStatusReport();
    if (!this.isPaused || this.state.status !== type) return;

    this.drainedPause = { line: pauseLine, kind: type === 'PAUSED_TOOL' ? 'tool-change' : 'stop', message };
    // Drained, so everything acked has been cut: the progress stands at the pause.
    this.updateState({ pauseMessage: message, ...this.advanceCut(null, 0) });

    // Get clear of the work, then bring the spindle out where it can be reached.
    //
    // Not at a sheet swap in a program that never commands Z - a laser job.
    // Resume puts back only the program's own Z (restoreAfterProgramPause), and
    // a laser program has none, so the lift stayed and every later sheet was cut
    // 25 mm out of focus. A tool change always lifts: it means a spindle.
    const programUsesZ = this.program.length > 0
      && scanModalState(this.program.map((l) => l.code), this.programLength()).safeZ !== null;
    if (type === 'PAUSED_TOOL' || programUsesZ) {
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
   * Stops the job where it stands, without losing the program or the position.
   *
   * `!` is GRBL's feed hold: a real-time byte, so it is acted on immediately
   * rather than queueing behind the lines already sent, and it decelerates the
   * axes along the path instead of dropping them. That is the difference
   * between a pause and a soft reset — the machine still knows where it is, so
   * `~` picks the cut back up exactly where it left it.
   *
   * The queue is stopped on this side too. GRBL acknowledges a line when it
   * parses it, not when it has moved, so without this the streamer would go on
   * happily filling the planner buffer for the whole of the pause and the first
   * seconds after resuming would be uninterruptible.
   *
   * The spindle is deliberately left running: it is sitting in the cut, and a
   * stationary bit in contact with the work is what burns wood and welds itself
   * into acrylic. Stopping it is a separate, explicit act.
   */
  public async pauseJob() {
    if (!this.isJobRunning || this.isPaused) return;
    this.isPaused = true;
    await this.writeRealtime(0x21); // '!' — feed hold
    this.updateState({
      status: 'PAUSED_OPERATOR',
      pauseMessage: 'Paused. The spindle is still running and the tool is still in the cut.',
    });
  }

  /**
   * Resumes a paused job — the operator's own pause, a tool change, or a
   * material swap.
   *
   * `~` is sent in every case. After a feed hold it is what actually releases
   * the machine; after a tool-change pause the controller was never held in the
   * first place, and a cycle start it did not need is harmless.
   */
  public async resumeJob({ zIsSet = false }: { zIsSet?: boolean } = {}) {
    if (!this.isPaused) return;

    // The re-zero gate lives here, not only in the banner's button: the bottom
    // bar's play button and MCP `resume` came straight here and plunged the new
    // bit against the old one's datum. `zIsSet` is the operator saying, by the
    // banner's "Z is already set" link, that it already describes this tool.
    if (this.state.status === 'PAUSED_TOOL' && this.state.needsZZero && !zIsSet) {
      throw new Error('Set Z zero for the new tool before resuming: the Z datum still belongs to the last one.');
    }

    // A pause the machine was free to be driven around in is a pause it has to
    // be put back from. A feed hold is not one of those — GRBL refuses to jog
    // in `Hold`, the tool is still in the cut, and `~` picks the same move back
    // up — so only the two that park get the retract.
    if (this.state.status === 'PAUSED_TOOL' || this.state.status === 'PAUSED_MATERIAL') {
      await this.restoreAfterProgramPause();
      if (!this.isPaused) return; // cancelled, alarmed or disconnected meanwhile
    }

    this.isPaused = false;
    this.drainedPause = null;
    this.updateState({ status: 'RUNNING', pauseMessage: undefined });
    // Out of band GRBL cycle start.
    await this.writeRealtime(0x7e); // '~'
    this.pumpJobQueue();
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
    await this.nextStatusReport();
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
   *      looked at, brushed out, or measured.
   *
   * After this the machine is idle and free: jog it anywhere, re-zero Z for a
   * fresh tool, whatever is needed. `resumeFromPark` puts it back.
   */
  public async parkJob(): Promise<boolean> {
    if (!this.isJobRunning || this.state.status === 'PAUSED_PARKED') return false;

    // 1. Hold, and let the deceleration finish.
    if (!this.isPaused) {
      this.isPaused = true;
      await this.writeRealtime(0x21); // '!'
    }
    this.updateState({
      status: 'PAUSED_OPERATOR',
      pauseMessage: 'Stopping the axes before standing the job down…',
    });
    const stopped = await this.waitForHoldComplete();

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
      pauseMessage: stopped
        ? `Job parked at line ${fromLine} of ${this.programLength()}. The machine is free to move — ` +
          `jog it where you like, then resume.`
        : `Job parked at line ${fromLine}, but the machine did not confirm it had stopped. Check ` +
          `where the tool is before resuming.`,
    });

    // 4. Out of the cut, once the controller is back up: anything sent before
    //    then is discarded, and a status read before then is the hold's. After
    //    a soft reset GRBL needs the modes restating before it will take a move.
    await reset;
    await this.sendAndWait('G21 G90', QUICK_REPLY_TIMEOUT_MS);
    const parkRetractZ = await this.clampedRetractZ(5);
    await this.sendAndWait(`G0 Z${parkRetractZ.toFixed(3)}`);
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
  public async resumeFromPark(): Promise<boolean> {
    const park = this.state.park;
    if (!park || this.state.status !== 'PAUSED_PARKED') return false;

    // The preamble's retract is clamped to the live Z, so read it from now.
    await this.nextStatusReport();
    this.updateState({ park: null, pauseMessage: undefined });
    return this.resumeFromLine(park.fromLine).ok;
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

  /**
   * Writes a single real-time byte.
   *
   * These are not commands and are not queued: GRBL acts on them the moment
   * they arrive, ahead of the thousands of lines already in its buffer, which
   * is the entire point — the buffered lines are exactly what needs slowing
   * down.
   */
  private async writeRealtime(byte: number): Promise<void> {
    if (!this.transport || !this.state.connected) return;
    await this.transport.writeRealtime(byte);
  }

  /**
   * Live feed trim while the job runs.
   *
   * What this replaces is aborting a job because it is cutting a little too
   * fast, changing a number, and starting the whole thing again — on a piece
   * that has already been cut into and can no longer be re-registered. A carve
   * that is chattering can be backed off in the second it takes to notice.
   *
   * Steps rather than a slider, because that is what the protocol is: GRBL has
   * no "set the feed to 87%" command, only nudges and a reset. A slider would
   * have to walk there in ten-percent hops and would lie about where it had got
   * to on the way.
   */
  public async nudgeFeedOverride(step: OverrideStep): Promise<void> {
    await this.writeRealtime(FEED_OVERRIDE_BYTES[step]);
  }

  /** Back to the feed the program asked for. */
  public async resetFeedOverride(): Promise<void> {
    await this.writeRealtime(FEED_OVERRIDE_BYTES.reset);
  }

  /**
   * Spindle speed trim, on the same contract as the feed.
   *
   * Only does anything on a machine whose controller owns the spindle. On a
   * router with a dial it is the dial that matters, which is why the pre-flight
   * panel states the RPM rather than relying on this.
   */
  public async nudgeSpindleOverride(step: OverrideStep): Promise<void> {
    await this.writeRealtime(SPINDLE_OVERRIDE_BYTES[step]);
  }

  public async resetSpindleOverride(): Promise<void> {
    await this.writeRealtime(SPINDLE_OVERRIDE_BYTES.reset);
  }

  /** Rapid traverse trim: full, half or quarter, and nothing between. */
  public async setRapidOverride(percent: 100 | 50 | 25): Promise<void> {
    await this.writeRealtime(RAPID_OVERRIDE_BYTES[percent]);
  }

  /** Cancels the running job. */
  public async cancelJob() {
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

      const sink: string[] = [];
      this.settingsSink = sink;
      try {
        await this.sendAndWait('$$', timeoutMs);
      } finally {
        this.settingsSink = null;
      }

      const settings = parseGrblSettings(sink);
      if (settings.size === 0) {
        // A board that is still booting answers nothing at all. Give it time to
        // get to its prompt rather than hammering the same question at it.
        if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 1200));
        continue;
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

  /** Triggers hardware homing cycle ($H). */
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
    await this.sendLine('$H');
  }

  /**
   * Drops everything this side is holding about a job, without touching the
   * machine. Used when the controller has already stopped on its own.
   */
  // Never `interrupted`: that one is by definition a job nothing here saw end,
  // so there is no call site in this class that could pass it.
  private abandonJob(reason: Exclude<ResumePoint['reason'], 'interrupted'> = 'cancelled') {
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
       * cut the last tool's path with the new one.
       */
      let stoppedAt = Math.max(0, sent - WebSerialManager.PARK_LOOKBACK_LINES);
      for (let i = sent - 1; i >= stoppedAt; i--) {
        const code = (this.program[i]?.code ?? '').replace(/\([^)]*\)|;.*$/g, '');
        if (classifyJobLine(code) !== 'motion') { stoppedAt = i + 1; break; }
      }
      // Forced past the throttle: what follows a drop or an alarm is often the
      // operator closing the tab, and a write that waited out its interval would
      // be the one write that mattered and did not happen.
      recordProgress(stoppedAt, reason, true);
      this.updateState({
        resume: { fromLine: stoppedAt, totalLines: this.programLength(), reason, jobName: this.jobContext.name ?? null },
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
    // Anything still waiting on an `ok` that will now never come.
    const waiters = this.ackQueue;
    this.ackQueue = [];
    this.jobBytesInFlight = 0;
    for (const s of waiters) if (s.kind === 'other') s.resolve?.();
    const probe = this.pendingProbe;
    this.pendingProbe = null;
    if (probe) probe(null);
  }

  /**
   * Kills GRBL Alarm state ($X).
   *
   * The local state is cleared alongside it: the alarm arrived with a half-sent
   * job behind it, and leaving that queue and its pause flag in place is what
   * used to make the app unusable after a limit switch until it was reloaded.
   * Status itself is not forced to IDLE — the next `<...>` report says whether
   * the unlock actually took.
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
    await this.sendAndWait('$X', QUICK_REPLY_TIMEOUT_MS);
    // An alarm keeps the modes it struck in. A probe that ran out of travel
    // alarms in the middle of its `G91` and nothing can be sent to undo that
    // until now, so without this the next positioning move was relative.
    await this.sendAndWait('G90 G21', QUICK_REPLY_TIMEOUT_MS);
  }

  /** Sets current XY position as G54 Work Origin (0,0). */
  public async zeroXY(): Promise<void> {
    this.refuseWhileJobHoldsMachine('zero XY');
    await this.sendLine('G10 L20 P1 X0 Y0');
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
    this.updateState({ needsZZero: false });
    this.jobPeakWorkZ = null;
    return {
      success: true,
      message:
        offsetMm === 0
          ? 'Work Z 0 set at the tool tip. Nothing moved — the machine has only been told where it is.'
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
    this.updateState({ needsZZero: false });
    this.jobPeakWorkZ = null;
  }

  /**
   * Nudges the machine by a relative amount, which is how you get the tool over
   * the corner of the stock before zeroing: drive it there by eye, then call
   * `zeroXY`.
   *
   * `$J=` rather than `G91 G0`: a jog is cancellable mid-move and does not
   * disturb modal state, so a fat-fingered 10 mm step can be stopped with
   * `jogCancel` and the next G-code line still runs in the mode it expects.
   */
  public async jog(delta: { x?: number; y?: number; z?: number }, feedrate = 1000): Promise<void> {
    this.refuseWhileJobHoldsMachine('jog');
    const step = { x: delta.x ?? 0, y: delta.y ?? 0, z: delta.z ?? 0, feedrate };

    /*
     * One jog on the wire at a time.
     *
     * Every click used to be written the moment it was made, with nothing
     * counting bytes: fifteen quick clicks are over 400 bytes into GRBL's 128,
     * which drops what does not fit and runs two half-lines together as one.
     * A click made while the last jog awaits its `ok` is added to the next
     * one instead, so the distance asked for is still the distance travelled.
     */
    if (this.jogBusy) {
      const p = this.pendingJog;
      this.pendingJog = p
        ? { x: p.x + step.x, y: p.y + step.y, z: p.z + step.z, feedrate }
        : step;
      return;
    }

    this.jogBusy = true;
    try {
      let next: typeof step | null = step;
      while (next) {
        const move = next;
        const axes = (['x', 'y', 'z'] as const)
          .filter((a) => Math.abs(move[a]) > 1e-9)
          .map((a) => `${a.toUpperCase()}${move[a].toFixed(3)}`)
          .join(' ');
        if (axes) {
          await this.sendAndWait(`$J=G91 G21 ${axes} F${Math.round(move.feedrate)}`, QUICK_REPLY_TIMEOUT_MS);
        }
        next = this.pendingJog;
        this.pendingJog = null;
      }
    } finally {
      this.jogBusy = false;
    }
  }

  /** Cancels an in-flight jog (GRBL real-time 0x85) without dropping the job state. */
  public async jogCancel(): Promise<void> {
    // Clicks still waiting their turn go too: a cancel that was followed by
    // the rest of the queued distance would not be a cancel.
    this.pendingJog = null;
    await this.writeRealtime(0x85);
  }

  // -------------------------------------------------------------------------
  // The guide spot
  // -------------------------------------------------------------------------

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
      if (this.state.connected) void this.sendLine('G90');
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
   * Reads back the live work Z and clamps a requested retract height to never
   * sit below it — `safeZMm` is a work height, so against a work offset left
   * over from a different stock or tool it can be below the tool already, and
   * an unclamped move meant to retract becomes a plunge. May only move Z away
   * from the stock, never toward it.
   */
  private async clampedRetractZ(safeZMm: number): Promise<number> {
    await this.nextStatusReport();
    return Math.max(safeZMm, this.state.wpos.z);
  }

  /**
   * The machine Z at the top of Z travel, or null when the settings do not say.
   *
   * GRBL homes Z to a limit switch and calls that position machine zero, so on
   * the usual setup — switch at the top — the whole of Z travel is negative and
   * the ceiling is 0. `$23` bit 2 inverts the Z homing direction, which puts
   * the switch at the bottom and the ceiling at `$132` instead. Both are read
   * off the controller rather than assumed, because guessing the sign here is
   * guessing which end of the machine the tool gets driven into.
   */
  private topOfZTravel(): number | null {
    const invertMask = this.state.grblSettings[23];
    if (invertMask === undefined) return null;
    if ((invertMask & 4) === 0) return 0;
    const maxTravel = this.state.grblSettings[132];
    return maxTravel !== undefined && maxTravel > 0 ? maxTravel : null;
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
    const top = this.topOfZTravel();

    if (this.hasHomed && top !== null) {
      const pullOff = this.state.grblSettings[27] ?? 1;
      await this.sendLine(`G53 G0 Z${(top - Math.max(0, pullOff) - RETRACT_BELOW_PULLOFF_MM).toFixed(3)}`);
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
    await this.sendLine('G0 X0.000 Y0.000 F3000');
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

    await this.sendAndWait('G21 G90');
    const contactZ = await this.probeOnce(searchDepthMm, feedrate, 120000);

    if (contactZ === null) {
      const message =
        `Probe never made contact within ${searchDepthMm} mm — Z zero was NOT set. ` +
        `Check the probe clip and lead, and start with the tool closer to the plate.`;
      this.updateState({ lastError: message });
      return { success: false, message };
    }

    await this.sendAndWait(`G10 L20 P1 Z${touchPlateThicknessMm.toFixed(3)}`);
    this.updateState({ needsZZero: false });
    // Heights seen on the old datum say nothing about this one.
    this.jobPeakWorkZ = null;
    // Relative retract: it clears the plate by the same 5 mm wherever the datum
    // ended up, and does not depend on the offset that was just written.
    await this.sendAndWait('G91 G0 Z5.000');
    await this.sendAndWait('G90');

    return {
      success: true,
      machineZ: contactZ,
      message:
        `Z zeroed on the touch plate (contact at machine Z ${contactZ.toFixed(3)}). ` +
        `Work Z 0 is ${touchPlateThicknessMm.toFixed(2)} mm below the plate top — remove the plate before cutting.`,
    };
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
  ): Promise<{ minX: number; minY: number; maxX: number; maxY: number; gridX: number; gridY: number; points: { x: number; y: number; z: number }[][] }> {
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
    const LIFT_FEED = 1000;

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
        await this.sendAndWait(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
        // Straight down, slowly, until the probe triggers or the search runs
        // out. `probePoint` issues `G91 G38.2 Z-<search>`, a relative plunge.
        const contactZ = await this.probeOnce(PROBE_SEARCH_MM, PROBE_FEED, 120000);

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
        await this.sendAndWait(`G91 G0 Z${PROBE_LIFT_MM.toFixed(3)} F${LIFT_FEED}`);
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
    await this.sendAndWait(`G91 G0 Z${PROBE_LIFT_MM.toFixed(3)} F3000`);
    await this.sendAndWait('G90');

    return {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      gridX: gx,
      gridY: gy,
      points,
    };
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
    guidePower = 5,
    opts: { laserMode?: boolean; safeZMm?: number } = {}
  ): Promise<void> {
    this.refuseWhileJobHoldsMachine('frame the job');
    // Callers have always said "CNC" by asking for no guide power at all, so
    // that stays the default reading of it. Guide power alone is not enough to
    // mean laser: MCP passes the default 5 whatever the machine, and on a
    // relay-switched router `M3 S5` is full RPM with the bit still at stock
    // height. Unless the caller says, a lit lap also needs `$32` laser mode on.
    const { laserMode = guidePower > 0 && this.laserModeEnabled(), safeZMm = 5 } = opts;
    const { minX, minY, maxX, maxY } = bounds;

    await this.sendLine('G21');
    await this.sendLine('G90');

    if (!laserMode) {
      await this.nextStatusReport();
      const retractZ = Math.max(safeZMm, this.state.wpos.z);
      await this.sendLine(`G0 Z${retractZ.toFixed(3)}`);
    }

    await this.sendLine(`G0 X${minX.toFixed(3)} Y${minY.toFixed(3)} F3000`);

    const corners: Array<[number, number]> = [
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
      [minX, minY],
    ];

    if (laserMode) {
      await this.sendLine(`M3 S${Math.round(guidePower)}`);
      for (const [x, y] of corners) {
        await this.sendLine(`G1 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
      }
      await this.sendLine('M5');
    } else {
      // No `M3` at all: a program with none in it cannot start a spindle by
      // accident, and there is nothing to cut with here anyway.
      for (const [x, y] of corners) {
        await this.sendLine(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} F3000`);
      }
    }
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
    if (this.transport) {
      this.clearGuideSpotTimeout();
      if (this.state.guideSpot) this.updateState({ guideSpot: false });
      /*
       * The reset stops the spindle and the beam itself. An `M5` used to follow
       * it, which GRBL threw away with its receive buffer, or refused (error:9)
       * in the ALARM:3 that a reset in motion leaves - either way its booked
       * `ok` then answered the next command sent instead.
       */
      // Back only once the controller is listening again, so whatever the
      // caller sends next is not thrown away with the reset.
      await this.softReset();
      // What is left is the `$32` the spot borrowed, which must not be left
      // off. GRBL takes settings in Alarm as well as Idle.
      await this.restoreLaserMode();
    }
  }
}

export const webSerialManager = new WebSerialManager();
