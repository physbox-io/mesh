// Recovering a job: resume offers, checkpoints, parking, and standing a job down.

import { locateExecutedLine, planResume, type ResumeOptions } from '@physbox-io/machining';
import {
  adoptCheckpoint,
  clearCheckpoint,
  recordProgress,
  type CheckpointProgram,
  type PendingPause,
} from './jobCheckpoint';
import { QUICK_REPLY_TIMEOUT_MS, StreamAbortedError } from './machineCore';
import { JobMachine } from './machineJob';
import { unlockAllowed } from './machineGates';
import { classifyJobLine, describeGrblError, prepareJobLines } from './machineJobLines';
import type { ResumePoint } from './machineTypes';

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
const PARK_LOOKBACK_LINES = 64;

/** A job that stopped, or was stood down, and how it is picked back up. */
export abstract class RecoveryMachine extends JobMachine {
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
  public restoreMeshCheckpoint(
    program: CheckpointProgram,
    fromLine: number,
    from: NonNullable<ResumePoint['from']> & {
      approximate: boolean;
      pendingPause?: PendingPause;
      /** Where the machine last read. A first report of exactly zero then means it restarted. */
      mpos?: { x: number; y: number; z: number };
    }
  ): boolean {
    if (this.isJobRunning || this.isPaused) return false;

    const prepared = prepareJobLines(program.gcode);
    if (prepared.length === 0) return false;

    this.program = prepared;
    const machine = program.settings?.machine;
    if (machine === 'laser' || machine === 'cnc') {
      this.programKind = { program: prepared, laser: machine === 'laser' };
    }
    this.jobContext = { name: program.jobName ?? undefined, settings: program.settings };
    adoptCheckpoint(program);
    if (from.mpos) this.expectMachinePosition(from.mpos);

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

    const offer: ResumePoint = this.state.resume ?? {
      fromLine: plan.fromLine,
      stoppedAtLine: plan.fromLine,
      totalLines: this.programLength(),
      reason: 'cancelled',
      jobName: this.jobContext.name ?? null,
    };
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

    void this.beginStreaming([...preamble.map((l) => l.code), ...tail.map((l) => l.code)], { resume: offer });

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
   * restart, or a board found reading zero after the link was away leaves the
   * controller unsure of X and Y — a hard limit that browns out the board brings
   * it back reading zero wherever the gantry stopped, while G54 survives in
   * EEPROM — so the package holds them lost until the machine homes or the
   * operator zeroes them again. A dropped link alone is no such evidence. And a
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
    return planResume(this.program.map((l) => l.code), fromLine, {
      ...options,
      isLaser: this.jobIsLaser(options?.isLaser),
      arrivingAtPause: this.lineIsPause(fromLine),
    });
  }

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
    // A tool change or a sheet swap has already drained, stopped and parked
    // the machine, which is free to be jogged. It never reports the feed hold
    // waited for below, so parking it turned the pause into an operator hold
    // five seconds later: the prompt was lost, and with it the re-zero gate
    // that `assertReadyToResume` keys on PAUSED_TOOL.
    if (this.state.status === 'PAUSED_TOOL' || this.state.status === 'PAUSED_MATERIAL') return false;

    // An e-stop at any await below has already stopped the machine. What is
    // left of this sequence must not run after it.
    const epoch = this.jobEpoch;
    const stoppedMeanwhile = () => epoch !== this.jobEpoch;

    // 1. Hold, and let the deceleration finish.
    if (!this.isPaused) {
      this.isPaused = true;
      // The sender stops with the machine, or it fills the planner behind the hold.
      this.queue.hold();
      await this.writeRealtime(0x21); // '!'
      if (stoppedMeanwhile()) return false;
    }
    this.updateState({
      status: 'PAUSED_OPERATOR',
      pauseMessage: 'Stopping the axes before standing the job down…',
    });
    const stopped = await this.waitForHoldComplete();
    if (stoppedMeanwhile()) return false;
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
      ? Math.max(
          this.rewindFloor(sentLine),
          locateExecutedLine(this.program.map((l) => l.code), at, sentLine, PARK_LOOKBACK_LINES)
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
    if (stoppedMeanwhile()) return false;
    await this.sendAndWait('G21 G90', QUICK_REPLY_TIMEOUT_MS);
    if (stoppedMeanwhile()) return false;
    if (!this.jobIsLaser(laser)) {
      const parkRetractZ = await this.clampedRetractZ(5);
      if (stoppedMeanwhile()) return false;
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
  protected parkToResume(reason: 'alarm' | 'disconnected'): void {
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
    this.dropPark();
    void this.restoreLaserMode();
  }

  protected dropPark(): void {
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
  protected async waitForHoldComplete(timeoutMs = 5000): Promise<boolean> {
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
    await this.stopForCancel();
    // The soft reset leaves GRBL in Alarm if it was moving, so the status the
    // machine reports next is the truth here rather than an assumed IDLE.
    this.updateState({ progressPercent: 0, remainingSeconds: null, pauseMessage: undefined });
  }

  /**
   * How far back from `sent` a stopped job may be picked up: a planner's worth,
   * and never past the line this run was resumed from, or a tool change or
   * programmed stop, which would cut the last tool's path with the new one.
   */
  protected rewindFloor(sent: number): number {
    const floor = Math.max(this.cutFloorLine, sent - PARK_LOOKBACK_LINES);
    for (let i = sent - 1; i >= floor; i--) {
      const code = (this.program[i]?.code ?? '').replace(/\([^)]*\)|;.*$/g, '');
      if (classifyJobLine(code) !== 'motion') return i + 1;
    }
    return floor;
  }

  /**
   * Drops everything this side is holding about a job, without touching the
   * machine. Used when the controller has already stopped on its own.
   */
  // Never `interrupted`: that one is by definition a job nothing here saw end,
  // so there is no call site in this class that could pass it.
  protected abandonJob(reason: Exclude<ResumePoint['reason'], 'interrupted'> = 'cancelled', message?: string) {
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
      const stoppedAt = this.rewindFloor(sent);
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

    // A cancelled setup leaves the block as it left it, not as its zeros found it.
    if (reason === 'cancelled' && this.runningSetup && (this.isJobRunning || this.isPaused)) {
      this.setupEndedAt = ++this.datumSeq;
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
   *
   * Only for an alarm or a controller at rest with no job on it: standing a job
   * down is the one thing this does that an unlock has no business doing to a
   * job that is fine, and an alarm has already taken any job off the machine.
   */
  public async unlockAlarm(): Promise<void> {
    if (!unlockAllowed(this.state)) {
      this.refuseWhileJobHoldsMachine('unlock');
      throw new Error("Can't unlock while a job is running or on feed hold. Stop or finish the job first.");
    }
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
    await this.restoreLaserMode();
  }
}
