// The machine state Mesh publishes, and the records a job leaves behind it.

import type { MachineState as BaseMachineState, MachineStatus } from '@physbox-io/machining';
import type { PendingPause } from './jobCheckpoint';
import type { MotionProfile } from './motionProfile';

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
