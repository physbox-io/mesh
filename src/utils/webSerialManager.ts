// ---------------------------------------------------------------------------
// WebSerial Connection & Machine Controller Manager
// Supports GRBL / Marlin serial communication, homing, zeroing, framing trace,
// interactive pauses for Manual Tool Changes (M6) and Material Swaps (M0), and
// an operator feed hold that can be lifted again without losing the program.
// ---------------------------------------------------------------------------

import { postMachineTelemetry } from './apiClient';
import { cloudAutosave } from './cloudDocuments';
import {
  SerialTransport,
  CloudMachineTransport,
  isWebSerialSupported,
  type MachineTransport,
} from './machineTransport';
import { locateExecutedLine, planResume, type ResumeOptions } from './jobResume';
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

export type MachineStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED_MATERIAL'
  | 'PAUSED_TOOL'
  | 'PAUSED_USER'
  | 'PAUSED_PARKED'
  | 'ALARM'
  | 'ERROR';

export interface MachineState {
  status: MachineStatus;
  connected: boolean;
  portName?: string;
  mpos: { x: number; y: number; z: number };
  wpos: { x: number; y: number; z: number };
  currentLine: number;
  totalLines: number;
  progressPercent: number;
  /**
   * Seconds since the job started cutting, and the run time it was quoted at.
   *
   * The line count cannot answer "how much longer" and never could. GRBL acks a
   * line when it has parsed it, so the count runs ahead of the cut by whatever
   * is sitting in the planner; and a line is not a unit of time either — a
   * rapid across the stock is one line and a fraction of a second, a raster
   * pass is one line and several. On a relief, where the mix of the two changes
   * completely between roughing and finishing, "62% of the lines" and "62% of
   * the way through" are simply different numbers.
   *
   * The clock is not a guess in the same way: the estimate comes off the
   * finished program and the machine's own `$$` limits, and the elapsed time is
   * measured. `estimatedSeconds` is null when the job was started by something
   * that did not quote one, and the UI says so rather than inventing a figure.
   */
  elapsedSeconds: number;
  estimatedSeconds: number | null;
  pauseMessage?: string;
  lastError?: string;
  /** Live feed and spindle, as reported in GRBL's `FS:` status field. */
  feedRate: number;
  spindleSpeed: number;
  /**
   * Whether the work Z datum is known to be stale.
   *
   * A tool change invalidates it: two bits are never the same length, so the Z
   * zero that was touched off on the roughing mill is wrong by whatever the
   * difference is the moment the finishing bit goes in — and it is wrong in the
   * direction of driving the new tool into the work. Nothing on the machine
   * knows this has happened, so the app has to remember it and say so, rather
   * than letting Resume look like an ordinary button.
   *
   * Set when a job pauses for a tool change, cleared by either zeroing route.
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
  /** What ended it, which is what decides how alarming to make the offer. */
  reason: 'alarm' | 'cancelled' | 'disconnected';
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

/**
 * How far one nudge moves an override. GRBL implements exactly these four and
 * nothing between, so this is the protocol rather than a choice of resolution.
 */
export type OverrideStep = 10 | 1 | -1 | -10;

export const FEED_OVERRIDE_BYTES: Record<OverrideStep | 'reset', number> = {
  reset: 0x90,
  10: 0x91,
  [-10]: 0x92,
  1: 0x93,
  [-1]: 0x94,
};

export const SPINDLE_OVERRIDE_BYTES: Record<OverrideStep | 'reset', number> = {
  reset: 0x99,
  10: 0x9a,
  [-10]: 0x9b,
  1: 0x9c,
  [-1]: 0x9d,
};

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

/** Rapid traverse trim: GRBL implements full, half and quarter, and no more. */
export const RAPID_OVERRIDE_BYTES: Record<100 | 50 | 25, number> = {
  100: 0x95,
  50: 0x96,
  25: 0x97,
};

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
  private statusPollTimer: any = null;

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
  private isJobRunning = false;
  private isPaused = false;

  /**
   * Waiters for a single command's reply, used by the probing cycle.
   *
   * A job is paced by its own `ok` handling, but probing has to read a number
   * back off the machine rather than just push lines at it, so those two
   * commands wait for the controller instead of returning the moment the bytes
   * are written.
   */
  private okWaiters: (() => void)[] = [];
  private pendingProbe: ((z: number | null) => void) | null = null;

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
      this.updateState({ elapsedSeconds: Math.round((Date.now() - this.jobStartedAt) / 1000) });
    }, 1000);
  }

  private stopElapsedTicker() {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.jobStartedAt = null;
  }

  /** Set from the status report; see `parseStatusReport`. */
  private lastHoldState: 'decelerating' | 'complete' | null = null;

  private state: MachineState = {
    status: 'DISCONNECTED',
    connected: false,
    mpos: { x: 0, y: 0, z: 0 },
    wpos: { x: 0, y: 0, z: 0 },
    currentLine: 0,
    totalLines: 0,
    progressPercent: 0,
    feedRate: 0,
    spindleSpeed: 0,
    needsZZero: false,
    motion: DEFAULT_MOTION_PROFILE,
    grblSettings: {},
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    elapsedSeconds: 0,
    estimatedSeconds: null,
    resume: null,
    park: null,
    guideSpot: false,
    controllerSilent: false,
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
      jobName: state.portName,
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
    }).finally(() => {
      this.telemetryInFlight = false;
    });
  }

  private updateState(patch: Partial<MachineState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  /**
   * Opens a wire to the machine.
   *
   * With no argument this is the USB cable it always was. Given a Tekno Box
   * address it goes over WiFi instead, through the box's WebSocket relay — the
   * same GRBL on the other end either way, which is why everything below this
   * point is unchanged by the choice. See `machineTransport.ts`.
   */
  public async connect(link: MachineLink = { kind: 'usb' }): Promise<boolean> {
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
      this.updateState({ status: 'IDLE', connected: true, portName: transport.label });

      // Ask what it is before anything else needs to know. Not awaited: the
      // connection is usable the moment it is open, and a controller that is
      // slow to answer `$$` must not hold the UI on "connecting".
      void this.refreshMachineSettings();
      return true;
    } catch (err: any) {
      await transport.close().catch(() => {});
      this.updateState({
        status: 'DISCONNECTED',
        connected: false,
        lastError: err?.message || 'Failed to connect to the machine.',
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
    });
  }

  /** Sends a single G-code line to the machine, however it is connected. */
  public async sendLine(command: string): Promise<void> {
    if (!this.transport || !this.state.connected) return;
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
      const resolve = this.okWaiters.shift();
      if (resolve) {
        resolve();
      } else if (this.isJobRunning && !this.isPaused) {
        this.advanceJobQueue();
      }
    } else if (line.startsWith('error:')) {
      // A refused command never completes, so release whoever is waiting on it
      // rather than hanging the cycle until its timeout.
      const failProbe = this.pendingProbe;
      this.pendingProbe = null;
      if (failProbe) failProbe(null);
      const waiters = this.okWaiters;
      this.okWaiters = [];
      for (const w of waiters) w();

      /*
       * A refused line ends the job, and says so.
       *
       * The refusal *is* the missing `ok`: the stream is paced one ack at a
       * time, so a line GRBL will not take leaves the queue waiting for a reply
       * that has already been given and will not come again. Nothing more was
       * ever sent after it, and the app went on showing RUNNING at whatever
       * percentage it had reached — a job that had stopped dead, presented as
       * one still cutting. Standing it down keeps the resume point, so the
       * operator can fix whatever was refused and pick the program back up.
       */
      if (this.isJobRunning || this.isPaused) {
        const at = Math.max(0, this.jobLineBase + this.currentQueueIndex);
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
    }

    // The controller's own state word, not just its alarms.
    //
    // Only 'Alarm' used to be read, and nothing else ever set the status back, so
    // one limit switch left the app in ALARM for the rest of the session — `$X`
    // cleared the machine while the UI still refused to start a job, and the only
    // way out was a page reload. The local job states win over the report, since
    // a tool-change pause is a state this side holds while GRBL sits Idle.
    if (machineWord === 'Alarm') {
      patch.status = 'ALARM';
      // A limit switch mid-carve kills the job on the controller — GRBL will not
      // run another line until it is unlocked. The queue is dropped so nothing
      // streams on into a machine that has lost its position; the line it
      // reached is kept, so the operator can deliberately pick it back up once
      // the machine has been rehomed and the tool re-zeroed.
      if (this.isJobRunning || this.isPaused) this.abandonJob('alarm');
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

    // One update for the whole report: each one notifies every listener, and
    // the telemetry publisher hangs off that.
    this.updateState(patch);
  }

  /** Last `WCO` seen, retained between the reports that carry one. */
  private workOffset: [number, number, number] = [0, 0, 0];

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
        this.okWaiters = this.okWaiters.filter(w => w !== finish);
        finish();
      }, timeoutMs);
      this.okWaiters.push(finish);
      this.sendLine(command);
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
  public async probePoint(searchDepthMm = 20, feedrate = 50, timeoutMs = 120000): Promise<number | null> {
    if (!this.transport || !this.state.connected) return null;

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

    // GRBL reports [PRB:] before acknowledging the probe, so by the time these
    // return the measurement is already in hand.
    await this.sendAndWait(`G91 G38.2 Z-${searchDepthMm.toFixed(3)} F${Math.round(feedrate)}`, timeoutMs);
    await this.sendAndWait('G90', timeoutMs);

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
    options: { name?: string; estimatedSeconds?: number } = {}
  ): Promise<{ delivered: boolean; message: string } | null> {
    if (!this.transport || !this.state.connected) {
      this.updateState({ lastError: 'No machine is connected, so there was nothing to send the job to.' });
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
      this.updateState({
        status: result.delivered ? 'RUNNING' : 'IDLE',
        estimatedSeconds: options.estimatedSeconds ?? null,
        elapsedSeconds: 0,
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

    /*
     * The stream owns the ack channel from here.
     *
     * Every `ok` is one line's worth of permission to send the next, and a
     * waiter left over from a probe or a zeroing move that timed out would eat
     * the first one — after which the program sits at line one, for ever,
     * showing RUNNING. There is nothing left for those waiters to wait for
     * anyway: whatever they were pacing finished before this program started.
     */
    const stale = this.okWaiters;
    this.okWaiters = [];
    for (const w of stale) w();

    // The beam does not stay lit into the cut: its S word would fight the
    // program's own, and `$32` has to go back before the job's first rapid.
    if (this.state.guideSpot) void this.guideSpotOff();

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

    this.updateState({
      status: 'RUNNING',
      currentLine: 0,
      totalLines: this.gcodeQueue.length,
      progressPercent: 0,
      elapsedSeconds: 0,
      estimatedSeconds: estimatedSeconds ?? null,
      // Pressing start is a new moment too: whatever the last attempt was
      // refused for is not what this one is doing.
      lastError: undefined,
      // A new program is a new job; whatever stopped the last one is no longer
      // something anyone can pick up.
      resume: null,
    park: null,
      // Whatever was outstanding from a previous job's tool change, starting a
      // new program is a fresh setup and the operator has just said so.
      needsZZero: false,
    });

    this.advanceJobQueue();
  }

  /**
   * Throws away the offer to pick a stopped job back up.
   *
   * The program itself is kept — the operator may still want to run it from the
   * start — but the offer stops being made.
   */
  public clearResumePoint(): void {
    if (this.state.resume) this.updateState({ resume: null });
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

    const plan = planResume(this.program.map((l) => l.code), fromLine, options);
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

    this.updateState({
      status: 'RUNNING',
      currentLine: plan.fromLine,
      totalLines: this.programLength(),
      progressPercent: Math.round((plan.fromLine / Math.max(1, this.programLength())) * 100),
      resume: null,
      pauseMessage: undefined,
    });

    this.advanceJobQueue();

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
    return planResume(this.program.map((l) => l.code), fromLine, options);
  }

  /** Processes and sends the next line in the G-code queue. */
  private async advanceJobQueue() {
    if (!this.isJobRunning || this.isPaused) return;

    if (this.currentQueueIndex >= this.gcodeQueue.length) {
      this.isJobRunning = false;
      this.stopElapsedTicker();
      // It finished. There is nothing left to resume into.
      this.updateState({ status: 'IDLE', progressPercent: 100, resume: null });
      return;
    }

    const line = this.gcodeQueue[this.currentQueueIndex];
    const note = this.gcodeNotes[this.currentQueueIndex] || '';
    this.currentQueueIndex++;

    // Reported against the original program rather than the queue, so a resumed
    // job carries on from 61% instead of restarting the bar at zero. During the
    // preamble the sum is below where the program picks up, and clamping there
    // is what stops the progress running backwards.
    const programLine = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex));
    const progressPercent = Math.round((programLine / Math.max(1, this.programLength())) * 100);
    this.updateState({ currentLine: programLine, progressPercent });

    // A tool change or a programmed stop is the operator's cue, not a fault.
    // Neither is sent on: GRBL rejects M6 unless it was built with it, and the
    // pause has already been taken here.
    const kind = classifyJobLine(line);

    if (kind === 'tool-change') {
      this.triggerPause('PAUSED_TOOL', this.describeToolChange(line, note));
      return;
    }

    if (kind === 'stop') {
      // The contour-slice export puts one of these between sheets, and says
      // which sheet in the comment.
      const sheet = note.match(/Sheet (\d+ of \d+)/);
      if (sheet) {
        this.triggerPause('PAUSED_MATERIAL', `Insert Material Sheet ${sheet[1]}`);
      } else {
        this.triggerPause('PAUSED_MATERIAL', note || 'Programmed stop. Resume when ready.');
      }
      return;
    }

    await this.sendLine(line);
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
    const what = note || (tool ? `tool T${tool[1]}` : 'the next tool');

    let rpm = '';
    for (let i = this.currentQueueIndex; i < Math.min(this.gcodeQueue.length, this.currentQueueIndex + 5); i++) {
      const m = this.gcodeQueue[i].match(/\bM0*3\b.*?\bS(\d+)/i);
      if (m) {
        const s = parseInt(m[1], 10);
        if (s > 0) rpm = `, set the spindle to ${s.toLocaleString()} RPM`;
        break;
      }
    }

    return `Tool change: ${what}${rpm}, then re-zero Z on the new tool before resuming.`;
  }

  /** Triggers an interactive pause for Tool or Material Changes. */
  private async triggerPause(type: 'PAUSED_TOOL' | 'PAUSED_MATERIAL', message: string) {
    this.isPaused = true;
    this.updateState({
      status: type,
      pauseMessage: message,
      // A new bit is a new tool length, so the datum the job was started on no
      // longer describes where the tip is. Resume is gated on this being dealt
      // with, either by probing again or by touching off by hand.
      needsZZero: type === 'PAUSED_TOOL' ? true : this.state.needsZZero,
    });

    // Get clear of the work, then bring the spindle out where it can be reached.
    //
    // The lift is relative. It used to be `G0 Z25`, an absolute work
    // coordinate, which assumes the datum leaves 25 mm of headroom above it —
    // on a job zeroed near the top of Z travel that is a move into the machine's
    // own limit, and the alarm that follows drops the rest of the program.
    // `G91 G0 Z25` clears the work by 25 mm from wherever it actually is.
    await this.sendLine('M5'); // Laser/Spindle OFF
    await this.sendLine('G91 G0 Z25.000'); // Lift clear, relative
    await this.sendLine('G90'); // Back to absolute before anything else runs
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
      status: 'PAUSED_USER',
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
  public async resumeJob() {
    if (!this.isPaused) return;

    this.isPaused = false;
    this.updateState({ status: 'RUNNING', pauseMessage: undefined });
    // Out of band GRBL cycle start.
    await this.writeRealtime(0x7e); // '~'
    this.advanceJobQueue();
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
      status: 'PAUSED_USER',
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
    //    carries the job forward now.
    this.isJobRunning = false;
    this.isPaused = false;
    this.okWaiters = [];
    await this.writeRealtime(0x18); // Ctrl-X, soft reset

    this.updateState({
      status: 'PAUSED_PARKED',
      park: { fromLine, totalLines: this.programLength(), at },
      pauseMessage: stopped
        ? `Job parked at line ${fromLine} of ${this.programLength()}. The machine is free to move — ` +
          `jog it where you like, then resume.`
        : `Job parked at line ${fromLine}, but the machine did not confirm it had stopped. Check ` +
          `where the tool is before resuming.`,
    });

    // 4. Out of the cut. After a soft reset GRBL needs the modes restating
    //    before it will take a move.
    await this.sendLine('G21 G90');
    await this.sendLine('G0 Z5');
    return true;
  }

  /**
   * Puts a parked job back on the machine and carries on cutting.
   *
   * The tool is driven back over the parked point at safe height and lowered
   * before the program restarts, rather than being left wherever the operator
   * jogged it — `planResume` writes a preamble that restores the modal state,
   * but it cannot know that the machine has been moved several hundred
   * millimetres since, and the first cutting move of the resumed program would
   * otherwise be a straight line across the work to get back.
   */
  public async resumeFromPark(): Promise<boolean> {
    const park = this.state.park;
    if (!park || this.state.status !== 'PAUSED_PARKED') return false;

    await this.sendLine('G21 G90');
    await this.sendLine('G0 Z5');
    await this.sendLine(`G0 X${park.at.x.toFixed(3)} Y${park.at.y.toFixed(3)}`);

    this.updateState({ park: null, pauseMessage: undefined });
    return this.resumeFromLine(park.fromLine).ok;
  }

  /** Throws away a parked job without resuming it. */
  public discardPark(): void {
    if (!this.state.park) return;
    this.updateState({
      park: null,
      status: 'IDLE',
      pauseMessage: undefined,
      progressPercent: 0,
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
    this.updateState({ progressPercent: 0, pauseMessage: undefined });
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
        this.restoreLaserMode();
      }
      return motion;
    }

    return this.state.motion;
  }

  /** Triggers hardware homing cycle ($H). */
  public async homeMachine(): Promise<void> {
    await this.sendLine('$H');
  }

  /**
   * Drops everything this side is holding about a job, without touching the
   * machine. Used when the controller has already stopped on its own.
   */
  private abandonJob(reason: ResumePoint['reason'] = 'cancelled') {
    // Where it got to, before the queue that knows it is thrown away. The line
    // that was in flight is the one to come back to rather than the one after
    // it: a move that was cut off partway through did not finish, and running
    // it again only recuts a path that has already been cut, while skipping it
    // leaves a gap in the work.
    if ((this.isJobRunning || this.isPaused) && this.program.length > 0) {
      const stoppedAt = Math.max(0, Math.min(this.programLength(), this.jobLineBase + this.currentQueueIndex - 1));
      this.updateState({
        resume: { fromLine: stoppedAt, totalLines: this.programLength(), reason },
      });
    }

    this.isJobRunning = false;
    this.isPaused = false;
    this.gcodeQueue = [];
    this.gcodeNotes = [];
    this.currentQueueIndex = 0;
    // Anything still waiting on an `ok` that will now never come.
    const waiters = this.okWaiters;
    this.okWaiters = [];
    for (const w of waiters) w();
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
      // The job it belonged to is gone, so a standing "re-zero before you
      // resume" has nothing left to warn about.
      needsZZero: false,
    });
    await this.sendLine('$X');
  }

  /** Sets current XY position as G54 Work Origin (0,0). */
  public async zeroXY(): Promise<void> {
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
    if (!this.state.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }
    await this.sendAndWait('G21 G90');
    await this.sendAndWait(`G10 L20 P1 Z${offsetMm.toFixed(3)}`);
    // The datum is now real, whichever bit is in the collet.
    this.updateState({ needsZZero: false });
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
    await this.sendLine('G10 L20 P1 X0 Y0 Z0');
    this.updateState({ needsZZero: false });
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
    const axes = (['x', 'y', 'z'] as const)
      .filter((a) => delta[a] !== undefined && delta[a] !== 0)
      .map((a) => `${a.toUpperCase()}${delta[a]!.toFixed(3)}`)
      .join(' ');
    if (!axes) return;
    await this.sendLine(`$J=G91 G21 ${axes} F${Math.round(feedrate)}`);
  }

  /** Cancels an in-flight jog (GRBL real-time 0x85) without dropping the job state. */
  public async jogCancel(): Promise<void> {
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

    await this.sendLine('M5');
    // S0 as well as M5, so the next `M3` in a hand-typed command or a program
    // header does not inherit the pointer's S word and fire at it.
    await this.sendLine('S0');
    // Laser mode back on before anything else can run. A job streamed with
    // `$32=0` still cuts, but it burns through every rapid on the way, so
    // leaving it off would be a far worse bug than the one it was turned off to
    // fix.
    this.restoreLaserMode();
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
  private restoreLaserMode(): void {
    if (!this.guideSpotRestoreLaserMode) return;
    this.guideSpotRestoreLaserMode = false;
    writeLaserModeBorrowed(false);
    this.updateState({ grblSettings: { ...this.state.grblSettings, 32: 1 } });
    void this.sendLine('$32=1');
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

  /** Retracts and drives to the current work XY origin, to check where zero landed. */
  public async gotoWorkOrigin(safeZ = 5): Promise<void> {
    await this.sendLine('G21 G90');
    await this.sendLine(`G0 Z${safeZ.toFixed(3)}`);
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
    searchDepthMm = 25,
    feedrate = 50
  ): Promise<{ success: boolean; message: string; machineZ?: number }> {
    if (!this.state.connected) {
      return { success: false, message: 'Not connected to a machine.' };
    }

    await this.sendAndWait('G21 G90');
    const contactZ = await this.probePoint(searchDepthMm, feedrate);

    if (contactZ === null) {
      const message =
        `Probe never made contact within ${searchDepthMm} mm — Z zero was NOT set. ` +
        `Check the probe clip and lead, and start with the tool closer to the plate.`;
      this.updateState({ lastError: message });
      return { success: false, message };
    }

    await this.sendAndWait(`G10 L20 P1 Z${touchPlateThicknessMm.toFixed(3)}`);
    this.updateState({ needsZZero: false });
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
    const gx = Math.max(2, Math.round(gridX));
    const gy = Math.max(2, Math.round(gridY));

    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;

    const stepX = gx > 1 ? width / (gx - 1) : 0;
    const stepY = gy > 1 ? height / (gy - 1) : 0;

    const points: { x: number; y: number; z: number }[][] = [];
    const totalPoints = gx * gy;
    let probed = 0;

    const isLive = this.state.connected;

    if (isLive) {
      await this.sendAndWait('G21 G90');
    }

    // Machine Z of the first contact. Every later point is reported against it,
    // so the grid comes out as offsets whatever the tool length or datum.
    let referenceZ: number | null = null;
    let missed = 0;

    for (let row = 0; row < gy; row++) {
      const rowPoints: { x: number; y: number; z: number }[] = [];
      const y = bounds.minY + row * stepY;

      for (let col = 0; col < gx; col++) {
        const x = bounds.minX + col * stepX;
        let probedZ = 0;

        if (isLive) {
          await this.sendAndWait(`G0 X${x.toFixed(3)} Y${y.toFixed(3)} Z5.000 F3000`);
          const contactZ = await this.probePoint(20, 50);
          await this.sendAndWait('G0 Z5.000 F1000');

          if (contactZ === null) {
            missed++;
          } else {
            if (referenceZ === null) referenceZ = contactZ;
            probedZ = parseFloat((contactZ - referenceZ).toFixed(3));
          }
        } else {
          // Simulated heightmap: slight 0.15mm bed tilt + 0.08mm dish warp
          const normX = gx > 1 ? col / (gx - 1) : 0.5;
          const normY = gy > 1 ? row / (gy - 1) : 0.5;
          const tilt = (normX - 0.5) * 0.18 + (normY - 0.5) * 0.12;
          const warp = Math.sin(normX * Math.PI) * Math.sin(normY * Math.PI) * -0.08;
          probedZ = parseFloat((tilt + warp).toFixed(3));
          await new Promise((r) => setTimeout(r, 120)); // Small delay for visual progress feedback
        }

        rowPoints.push({ x, y, z: probedZ });
        probed++;
        if (onProgress) onProgress(probed, totalPoints);
      }
      points.push(rowPoints);
    }

    if (isLive) {
      await this.sendAndWait('G0 Z10.000 F3000');
      if (missed > 0) {
        this.updateState({
          lastError:
            `Probe made no contact at ${missed} of ${totalPoints} points — those are recorded flat, ` +
            `so levelling will be wrong there. Check the probe clip and the starting Z.`,
        });
      }
    }

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

  /** Runs low-power laser framing trace around job bounding box. */
  public async frameJob(bounds: { minX: number; minY: number; maxX: number; maxY: number }, guidePower = 5): Promise<void> {
    const { minX, minY, maxX, maxY } = bounds;
    await this.sendLine('G21');
    await this.sendLine('G90');
    await this.sendLine(`G0 X${minX.toFixed(3)} Y${minY.toFixed(3)} F3000`);
    await this.sendLine(`M3 S${Math.round(guidePower)}`);
    await this.sendLine(`G1 X${maxX.toFixed(3)} Y${minY.toFixed(3)} F3000`);
    await this.sendLine(`G1 X${maxX.toFixed(3)} Y${maxY.toFixed(3)} F3000`);
    await this.sendLine(`G1 X${minX.toFixed(3)} Y${maxY.toFixed(3)} F3000`);
    await this.sendLine(`G1 X${minX.toFixed(3)} Y${minY.toFixed(3)} F3000`);
    await this.sendLine('M5');
  }

  /** Emergency Stop (Ctrl+X and M5). */
  public async eStop(): Promise<void> {
    if (this.transport) {
      this.clearGuideSpotTimeout();
      await this.transport.writeRealtime(0x18); // Ctrl+X soft reset
      await this.sendLine('M5');
      // The reset has already killed the output, so what is left is the flag
      // and the `$32` the spot borrowed — which must not be left off.
      if (this.state.guideSpot) this.updateState({ guideSpot: false });
      this.restoreLaserMode();
    }
  }
}

export const webSerialManager = new WebSerialManager();
