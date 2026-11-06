// Running a job: starting it, its programmed pauses, and finishing it.

import { planResume, type JobPauseKind } from '@physbox-io/machining';
import { cloudAutosave } from './cloudDocuments';
import { beginCheckpoint, clearCheckpoint } from './jobCheckpoint';
import { QUICK_REPLY_TIMEOUT_MS } from './machineCore';
import { classifyJobLine, prepareJobLines, programIsLaser, type JobLine } from './machineJobLines';
import { ProbingMachine } from './machineProbing';
import type { JobSetup, MachineState } from './machineTypes';
import { writeLaserModeBorrowed } from './guideSpot';

/** How long the end of a job may wait for the planner to run dry. */
const END_OF_JOB_DRAIN_MS = 10 * 60 * 1000;

/** Running a program: start, stream, the pauses it asks for, resume from them, finish. */
export abstract class JobMachine extends ProbingMachine {
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
      /** What the program is for, when the caller knows. Otherwise it is read from the program. */
      machine?: 'laser' | 'cnc';
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
    // the context below, which belongs to the job still running. Nor while one
    // is starting: the package marks it running only once it streams, and a
    // second run in that second overwrote the first's name and setup.
    if (this.isJobRunning || this.isPaused || this.starting) {
      this.updateState({ lastError: 'A job is already running or paused. Cancel it before starting another.' });
      return null;
    }
    this.jobContext = { name: options.name, settings: options.settings ?? null };
    if (!this.transport || !this.state.connected) {
      this.updateState({ lastError: 'No machine is connected, so there was nothing to send the job to.' });
      return null;
    }

    const prepared = prepareJobLines(gcode);
    const codes = prepared.map((l) => l.code);
    const laser = options.machine ? options.machine === 'laser' : programIsLaser(codes);

    // A laser job has no Z to plunge with, so an untouched Z datum cannot hurt
    // it — everything else routes a spinning or moving tool toward a surface
    // whose height this session has not actually confirmed.
    if (this.state.needsZZero && !laser) {
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
     * The box streams it, so there is no moment here to borrow `$32` in.
     */
    if (this.transport.runJob) {
      const refusal =
        this.travelBlockedReason(codes) ??
        this.spindleBlockedReason(codes, laser) ??
        this.laserModeBlockedReason(!laser);
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

    void this.startPrepared(gcode, prepared, laser, options.estimatedSeconds);
    return null;
  }

  /**
   * Starts a program from its first line.
   *
   * Never throws: everything that refuses a job here says so in `lastError`,
   * which is where the export modals and MCP look.
   */
  public async startJob(gcode: string, estimatedSeconds?: number): Promise<void> {
    const prepared = prepareJobLines(gcode);
    await this.startPrepared(gcode, prepared, programIsLaser(prepared.map((l) => l.code)), estimatedSeconds);
  }

  private async startPrepared(
    gcode: string,
    prepared: JobLine[],
    laser: boolean,
    estimatedSeconds?: number
  ): Promise<void> {
    if (!this.state.connected) return;
    if (this.isJobRunning || this.isPaused || this.starting) return; // see runJob

    // Before anything is set up for it: the package refuses these too, but by
    // then this job would already read as running, with its clock going, and
    // the last job's resume offer and checkpoint gone. `resumeFromLine` had
    // the same fault, and checks the position up front for the same reason.
    const codes = prepared.map((l) => l.code);
    const refusal =
      this.positionBlockedReason() ?? this.travelBlockedReason(codes) ?? this.spindleBlockedReason(codes, laser);
    if (refusal) {
      this.updateState({ lastError: refusal });
      return;
    }

    this.jobStartedAt = Date.now();
    this.startElapsedTicker();

    this.program = prepared;
    this.programKind = { program: prepared, laser };
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
   *
   * `ifRefused` is what to put back if the stream never begins.
   */
  protected async beginStreaming(lines: string[], ifRefused: Partial<MachineState> = {}): Promise<void> {
    this.starting = true;
    this.streamBegan = false;
    const epoch = this.jobEpoch;
    try {
      if (this.state.guideSpot) await this.guideSpotOff();
      // Cancelled while the beam was going out.
      if (epoch !== this.jobEpoch || this.state.status !== 'RUNNING') return;
      await this.fitLaserModeToJob();
      if (epoch !== this.jobEpoch) return;
      // `starting` stays up until this settles: the package marks the job
      // running only after its own first await.
      await this.streamProgram({ lines, layers: [], spindleLine: null });
    } catch (err) {
      this.updateState({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      this.starting = false;
      // Refused, or stopped (an E-Stop while the guide spot went out) before
      // the first line: nothing ran, so nothing is running. Left alone, the
      // job read as RUNNING with its clock counting up from nothing.
      if (!this.streamBegan) {
        this.stopElapsedTicker();
        if (this.state.status === 'RUNNING') this.updateState({ status: 'IDLE', ...ifRefused });
      }
      this.releaseStreamWaiters();
      // However the job went. `starting` held off the other ways back until now.
      if (!this.isJobRunning && this.state.status !== 'PAUSED_PARKED') void this.restoreLaserMode();
    }
  }

  /**
   * Sets `$32` to suit the job, if it does not, for as long as the job lasts.
   *
   * Laser mode stops a spindle on every rapid, and its absence burns a laser's
   * beam through them, so a controller left set for the other head is corrected
   * rather than argued with. The way back is written down first, by the same
   * route as the guide spot's borrow, so that a session ending mid-job still
   * puts it right at the next connection. Unknown is left alone. Throws if the
   * controller will not take it: a job must not run on the wrong setting.
   */
  protected async fitLaserModeToJob(): Promise<void> {
    await this.whenHalted();
    if (this.laserModeRestoring) await this.laserModeRestoring;
    const laser = this.jobIsLaser();
    const wanted = laser ? 1 : 0;
    const current = this.state.grblSettings[32];
    if (current === undefined || current === wanted) return;
    const home = this.laserModeHome ?? (current as 0 | 1);
    const after = home === wanted ? null : home;
    writeLaserModeBorrowed(home);
    try {
      await this.sendLine(`$32=${wanted}`, { timeoutMs: QUICK_REPLY_TIMEOUT_MS });
    } catch {
      writeLaserModeBorrowed(this.laserModeHome);
      throw new Error(
        this.laserModeBlockedReason(!laser) ??
          'Laser mode is off ($32=0), which leaves the beam on through every rapid. Send $32=1 before running a laser job.'
      );
    }
    this.laserModeHome = after;
    writeLaserModeBorrowed(after);
    this.noteLaserMode(wanted);
  }

  /**
   * Gives a job's `$32` back once it has finished. GRBL refuses a setting while
   * it moves, and the last `ok` is for parsing the last line, so this waits for
   * the planner to run dry first.
   */
  protected async returnLaserModeAfterJob(): Promise<void> {
    if (this.laserModeHome === null) return;
    try {
      await this.sendLine('G4 P0', { timeoutMs: END_OF_JOB_DRAIN_MS });
    } catch {
      // Stopped some other way, which brings its own chance to restore it.
      return;
    }
    if (!this.isJobRunning && !this.starting) await this.restoreLaserMode();
  }

  protected onJobStarted(): void {
    this.streamBegan = true;
    this.releaseStreamWaiters();
  }

  protected releaseStreamWaiters(): void {
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
  protected describeToolChange(line: string, note: string): string {
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
        if (s > 0) rpm = `, switch the spindle on at ${s.toLocaleString()} RPM`;
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

    // Get clear of the work. Not at a sheet swap on a laser.
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
    // A tool change stays where the program brought it: an exporter that parks
    // chooses that spot, over stock Z can be taken from again.
    if (type !== 'PAUSED_TOOL') await this.sendLine('G0 X0.000 Y0.000'); // Where the work can be reached
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

  /** A run from a line starts its queue with a preamble, so it is counted from the program. */
  protected programLinesBefore(index: number): readonly string[] {
    return this.program.slice(0, Math.max(0, this.jobLineBase + index)).map((l) => l.code);
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
  protected refuseSetup(setup: JobSetup | undefined, origin: 'ui' | 'mcp', relayed: boolean): string | null {
    if (!setup || setup.index <= 1) return null;
    const which = `Setup ${setup.index} of ${setup.of}`;
    if (origin !== 'ui' || relayed) {
      return `${which} turns the block by hand, so it can only be started from this screen, by someone at the machine.`;
    }
    // Setup 1 is let through above: running the first face again starts over.
    const pending = this.state.setupPending;
    if (pending?.sequenceId === setup.sequenceId && setup.index !== pending.next) {
      return `${which}: run setup ${pending.next} first.`;
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
    void this.returnLaserModeAfterJob();
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
   * The pause turned the spindle off and lifted, a stop other than a tool change
   * parked at X0 Y0, and then the operator was free to jog, touch off (which sends `G21 G90`) and fit a new
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
  protected async restoreAfterProgramPause(): Promise<void> {
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
}
