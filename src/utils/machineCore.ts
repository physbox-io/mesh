// The fields and shared helpers every layer of Mesh's machine stands on.

import { AckTimeoutError, GrblMachine, scanModalState } from '@physbox-io/machining';
import { machineSocketUrl, submitMachineJob } from './apiClient';
import {
  DEFAULT_SPINDLE_PWM_MAX,
  guidePowerToS,
  readLaserModeBorrowed,
  writeLaserModeBorrowed,
} from './guideSpot';
import { recordProgress } from './jobCheckpoint';
import {
  CUT_START,
  DEFAULT_PLANNER_BLOCKS,
  lineAtSeconds,
  locateCut,
  secondsAtLine,
  type CutState,
} from './jobProgress';
import { classifyJobLine, type JobLine } from './machineJobLines';
import type { JobSetup, MachineLink, MachineState } from './machineTypes';
import { DEFAULT_MOTION_PROFILE, motionProfileFromSettings, type MotionProfile } from './motionProfile';
import { readSpindleMaxOverride, spindleCeilingRefusal, withSpindleOverride } from './spindleOverride';
import { programTimeline, type ProgramTimeline } from './timeEstimate';

export class StreamAbortedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Job stream aborted (${reason})`);
    this.reason = reason;
    this.name = 'StreamAbortedError';
  }
}

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

/**
 * How long a tool-change pause waits for the moves already sent to be cut.
 *
 * GRBL's planner holds only a handful of blocks, but grblHAL builds hold
 * dozens and a slow finishing feed spreads them over minutes. Running out of
 * patience here leaves the pause unparked, which is safe; lifting early is not.
 */
const PAUSE_DRAIN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long a jog, or a line that puts the beam out, waits for its `ok`.
 *
 * Short, because both are waited on by something the operator is watching: a
 * job that will not start until the guide spot is out, a jog pad that holds
 * the next click until this one is accepted.
 */
export const QUICK_REPLY_TIMEOUT_MS = 3000;

export const DATUM_NOT_CONFIRMED =
  'The controller did not confirm the new zero, so it has not been recorded. Check the connection and zero again.';

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
 * loop, shared with Etch and Volt. Mesh's own part is built up in layers, each
 * in its own module: this one holds every field and the helpers they all use;
 * then the guide spot, setting up the work, probing, running a job, and
 * recovering one (resume, park, abandon); `WebSerialManager` is the link
 * itself, its telemetry and the controller's own reports.
 */
export abstract class MachineCore extends GrblMachine<MachineState> {
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
  protected assumeZeroWorkOffset(): void {
    if (!this.lastWco) this.lastWco = { x: 0, y: 0, z: 0 };
  }

  /** The paired device's name, for the label of a cloud connection. */
  protected cloudDeviceName: string | undefined;

  /** Trailing comments, index-aligned with `gcodeQueue`, for the pause prompts. */
  protected gcodeNotes: string[] = [];
  /**
   * The whole program as it was handed over, kept for the length of the session.
   *
   * Separate from `gcodeQueue` because the queue is what is left to send, and a
   * resume rewrites it: it becomes a preamble that puts the machine back into
   * the state the program had reached, followed by the tail of the program. The
   * original has to survive that so a second resume — the bit snapped twice —
   * still has something to count lines against.
   */
  protected program: JobLine[] = [];
  /**
   * The program-line number that `gcodeQueue[0]` corresponds to.
   *
   * Zero for a job run from the start. Negative during a resume's preamble,
   * which is lines that are not in the program at all, so the reported progress
   * clamps rather than counting backwards.
   */
  protected jobLineBase = 0;

  /**
   * The program on the clock, line by line, for reading progress off the line
   * being cut. Built whenever `program` is set; null for a job a cloud device
   * runs by itself, which has no line stream here to read.
   */
  protected timeline: ProgramTimeline | null = null;
  /** Program lines GRBL has acknowledged this run: `0..ackedLines-1` are planned or cut. */
  protected ackedLines = 0;
  /** Where this run picked the program up: 0 from the start, the resume line otherwise. */
  protected cutFloorLine = 0;
  /** Where the cutter was last placed. See `advanceCut`. */
  protected cut: CutState = CUT_START;
  /**
   * The planner's depth and its free blocks, from `Bf:`. GRBL reports it only
   * when `$10` asks, so both stay null on a stock setup; the depth is the most
   * free blocks ever seen, which is the planner sitting empty.
   */
  protected plannerSize: number | null = null;
  protected plannerFree: number | null = null;

  /** Wall clock the current job started cutting at, or null between jobs. */
  protected jobStartedAt: number | null = null;
  protected elapsedTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Publishes the elapsed clock once a second while a job runs.
   *
   * A second is the resolution the readout is written at, and polling faster
   * would only re-render the same string. Paused time still counts: the piece
   * is still on the machine and the operator is still waiting on it.
   */
  protected startElapsedTicker() {
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
  protected beginCutTracking(fromLine: number): Partial<MachineState> {
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
  protected advanceCut(
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
  protected cutProgress(): Partial<MachineState> {
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

  protected stopElapsedTicker() {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.jobStartedAt = null;
  }

  /** Set from the status report; see `parseStatusReport`. */
  protected lastHoldState: 'decelerating' | 'complete' | null = null;
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
  protected jobPeakWorkZ: number | null = null;

  /**
   * The pause the stream stopped at, once everything sent before it has run.
   *
   * GRBL acks lines when it parses them, so when the pump reaches an `M6` up
   * to a planner's worth of moves are still to be cut. Once the `G4 P0` behind
   * them is acked they have all been cut, and the job stands exactly at the
   * pause line — so an alarm from then on, such as the lift tripping a switch,
   * resumes at that line rather than winding back into the last tool's path.
   */
  protected drainedPause: { line: number; kind: 'tool-change' | 'stop'; message: string } | null = null;

  /** The controller's last refusal, and the line it refused. See `failJob`. */
  protected lastRefusal: { reply: string; line: string | undefined } | null = null;
  /** The operator's "Z is already set" for the resume in progress. See `resumeJob`. */
  protected zIsSetForResume = false;
  /** A start is waiting on the guide spot or stale replies. See `startJob`. */
  protected starting = false;
  /** Whether the stream `beginStreaming` is waiting on ever began. */
  protected streamBegan = false;
  /** Pauses pressed during `starting`, waiting for the stream to begin. See `pauseJob`. */
  protected awaitingStream: Array<() => void> = [];

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
  protected guideSpotTimer: ReturnType<typeof setTimeout> | null = null;
  protected guideSpotRestoreLaserMode = false;
  protected guideJiggleRunning = false;
  /** What the running job is, as the run archive should remember it. */
  protected jobContext: { name?: string; settings?: Record<string, unknown> | null } = {};
  /**
   * Datum bookkeeping for parts cut in several setups. Each event takes the
   * next number, so "zeroed since the last setup ended" is a comparison. Kept
   * per connection: a reload forgets the setup that ended, and the zeros with
   * it, so a later setup still needs zeroing in this session.
   */
  protected datumSeq = 0;
  protected zZeroedAt = 0;
  protected xZeroedAt = 0;
  protected yZeroedAt = 0;
  protected setupEndedAt = 0;
  /** The setup the job on the wire belongs to, if it is one. */
  protected runningSetup: JobSetup | null = null;

  /**
   * The motion profile as the controller reported it, before the operator's
   * spindle override. `state.motion` is this with the override applied, so
   * changing the override can be undone without asking the machine again.
   */
  protected reportedMotion: MotionProfile = DEFAULT_MOTION_PROFILE;

  /**
   * Which controller this is, for filing the spindle override under — the
   * cloud device's id, or what `$I` says the board is (its build and any name
   * set with `$I=`). Null until known, and for a controller that will not say,
   * which is when the unkeyed override applies. See `spindleOverride.ts`.
   */
  protected machineKey: string | null = null;

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

  /**
   * Sends one line and waits for the controller to accept it, giving up after
   * `timeoutMs` without giving up its place in the queue (its reply may still
   * come). A refusal still throws: a zeroing line the controller refused has
   * not zeroed anything, and must not be reported as though it had.
   */
  protected async sendAndWait(command: string, timeoutMs = 30000): Promise<void> {
    if (!this.transport || !this.state.connected) return;
    try {
      await this.sendLine(command, { timeoutMs });
    } catch (err) {
      if (!(err instanceof AckTimeoutError)) throw err;
    }
  }

  /**
   * Writes a work offset and says whether the controller took it.
   *
   * Not `sendAndWait`, which gives up on a timeout without saying so: a `G10`
   * lost on a link that had gone deaf was reported as a zero set, and the Z
   * gate on starts and resumes was lifted on it. An idle controller answers a
   * `G10` at once, so one that has not within a few seconds is not trusted
   * with the datum.
   */
  protected async writeDatum(line: string): Promise<boolean> {
    try {
      await this.sendLine(line, { timeoutMs: QUICK_REPLY_TIMEOUT_MS });
      return true;
    } catch (err) {
      if (!(err instanceof AckTimeoutError)) throw err;
      this.updateState({ lastError: DATUM_NOT_CONFIRMED });
      return false;
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
  protected spindleBlockedReason(lines: readonly string[]): string | null {
    return spindleCeilingRefusal(lines, {
      maxRpm: this.state.grblSettings[30],
      laser: this.laserModeEnabled(),
      overridden: readSpindleMaxOverride(this.machineKey) !== null,
    });
  }

  /** A laser focuses once by hand and its Z never moves during a job. */
  protected hasJobZAxis(): boolean {
    return !this.laserModeEnabled();
  }

  /** How many lines the program has, which is what progress is measured against. */
  protected programLength(): number {
    return this.program.length;
  }

  /**
   * Whether the program line a resume would restart on is one that pauses.
   *
   * The line, not the lines around it: a resume restarts the stream *at*
   * `fromLine`, so it is that line's own classification which decides whether
   * the first thing to happen is a cut or a stop.
   */
  protected lineIsPause(fromLine: number): boolean {
    const line = this.program[Math.max(0, Math.min(fromLine, this.program.length - 1))];
    if (!line) return false;
    return classifyJobLine(line.code) !== 'motion';
  }

  /** Whether the loaded job is for a laser, for UI that has no export modal to ask. */
  public isLaserJob(): boolean {
    return this.jobIsLaser();
  }

  /**
   * Whether the job is for a laser: the caller's word when it has one, then
   * `$32` laser mode, then a program that never commands a Z.
   */
  protected jobIsLaser(explicit?: boolean): boolean {
    if (explicit !== undefined) return explicit;
    if (this.laserModeEnabled()) return true;
    // `upTo` 0: only the whole-program safe Z is wanted, not a replay.
    return this.program.length > 0 && scanModalState(this.program.map((l) => l.code), 0).safeZ === null;
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
  protected refuseWhileJobHoldsMachine(what: string): void {
    if ((this.isJobRunning && !this.isPaused) || this.state.status === 'PAUSED_OPERATOR') {
      throw new Error(`Can't ${what} while a job is running or on feed hold. Stop or finish the job first.`);
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
  protected async restoreLaserMode(): Promise<void> {
    if (!this.guideSpotRestoreLaserMode) return;
    this.guideSpotRestoreLaserMode = false;
    writeLaserModeBorrowed(false);
    this.updateState({ grblSettings: { ...this.state.grblSettings, 32: 1 } });
    // Waited for: GRBL writes EEPROM for a setting, and a stream started
    // before the `ok` would be racing that write.
    await this.sendAndWait('$32=1', QUICK_REPLY_TIMEOUT_MS);
  }

  /** Full-scale S for this controller — `$30`, or the usual 1000 if unasked. */
  protected spindlePwmMax(): number {
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
  protected laserModeEnabled(): boolean {
    return this.state.grblSettings[32] === 1;
  }
}
