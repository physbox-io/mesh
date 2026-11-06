// ---------------------------------------------------------------------------
// WebSerial Connection & Machine Controller Manager
// Supports GRBL / Marlin serial communication, homing, zeroing, framing trace,
// interactive pauses for Manual Tool Changes (M6) and Material Swaps (M0), and
// an operator feed hold that can be lifted again without losing the program.
// ---------------------------------------------------------------------------

import {
  FEED_OVERRIDE_BYTES,
  RAPID_OVERRIDE_BYTES,
  SPINDLE_OVERRIDE_BYTES,
  TelemetryThrottle,
  remoteResumeRefusal,
  type MachineStatus,
  type OverrideStep,
  type ResolvedFrames,
  type StatusReport,
} from '@physbox-io/machining';
import { postMachineTelemetry, type MachiningTelemetry, type RemoteCommand } from './apiClient';
import { cloudAutosave } from './cloudDocuments';
import { getRunProgramDocumentId, noteCheckpointPosition } from './jobCheckpoint';
import { RecoveryMachine } from './machineRecovery';
import type { MachineState } from './machineTypes';
import { DEFAULT_MOTION_PROFILE } from './motionProfile';
import { cncBedStore } from './printBedSettings';

// Everything this module has always exported, from wherever it now lives.
export type {
  MachineStatus,
  JobSetup,
  MachineState,
  CompletedJob,
  ParkPoint,
  ResumePoint,
  MachineStateListener,
  MachineLink,
} from './machineTypes';
export { prepareJobLines, classifyJobLine, describeGrblError, type JobLine } from './machineJobLines';
export { StreamAbortedError } from './machineCore';
export { ZERO_SEARCH_MM } from './machineProbing';

/*
 * The override bytes are the protocol, not a choice, so they come from
 * `@physbox-io/machining` along with the rest of it — the three apps had three
 * identical copies of these tables. Re-exported because this module's own
 * consumers import them from here.
 */
export { FEED_OVERRIDE_BYTES, SPINDLE_OVERRIDE_BYTES, RAPID_OVERRIDE_BYTES };
export type { OverrideStep };

/**
 * How often a running job's position is published to api.physbox.io.
 *
 * The dashboard is watched by someone who has walked away from the machine, so
 * it wants seconds of latency, not milliseconds — and the status poll below
 * runs at 5 Hz, so publishing on every state change would be a request every
 * 200 ms for the length of a job. A relief carve runs for hours.
 */
const TELEMETRY_INTERVAL_MS = 2000;

/**
 * The link to the machine, as Mesh drives it: connecting and losing the wire,
 * what the controller says of its own accord (resets, alarms, status reports),
 * the telemetry that goes to api.physbox.io, and the E-Stop. Everything else is
 * in the layers below it (see `MachineCore`).
 */
class WebSerialManager extends RecoveryMachine {
  /** Telemetry pacing — see `publishTelemetry`. */
  private telemetry = new TelemetryThrottle<MachiningTelemetry>({
    intervalMs: TELEMETRY_INTERVAL_MS,
    post: (frame) =>
      postMachineTelemetry('physics', frame).then((commands) => this.applyRemoteCommands(commands)),
  });
  /** Between `onLinkLost` and the link reading as closed. See `publishTelemetry`. */
  private linkGoing = false;

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
   * The rule is the package's, shared with an agent's `resume`.
   */
  private async resumeRemotely(): Promise<void> {
    if (remoteResumeRefusal(this.state.status)) return;
    await this.resumeJob();
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
   * A deliberate disconnect, while the port can still be written to. A closed
   * port would leave the guide spot burning and `$32` borrowed. A job on the
   * wire is the package's to stop, and its `$32` waits for the next connection.
   */
  protected async beforeLinkCloses(): Promise<void> {
    if (this.isJobRunning) return;
    if (!this.state.guideSpot && this.laserModeHome === null) return;
    await this.guideSpotOff();
    // A report after those lines, or the package takes the machine for busy.
    await this.awaitStatus();
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
    if (!this.isJobRunning && !this.starting && this.state.status !== 'PAUSED_PARKED') {
      void this.restoreLaserMode();
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
    void this.restoreLaserMode();
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
    if (machineWord === 'Alarm' && (this.isJobRunning || this.isPaused)) {
      this.abandonJob('alarm');
      void this.restoreLaserMode();
    }
    if (machineWord === 'Alarm') this.parkToResume('alarm');

    // A job still starting counts: the package marks it running only once its
    // stream begins, and the heights seen meanwhile are this job's.
    const inJob = this.isJobRunning || this.isPaused || this.starting;
    if (inJob && machineWord !== 'Alarm') {
      this.jobPeakWorkZ = Math.max(this.jobPeakWorkZ ?? -Infinity, frames.wpos.z);
      noteCheckpointPosition(frames.mpos);
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

  /** Emergency stop: a soft reset (Ctrl-X). */
  public async eStop(): Promise<void> {
    // A soft reset from a finished feed hold leaves GRBL Idle, not Alarm, so no
    // alarm arrives to end the job. Left running, a later Resume streamed the
    // rest of the program into a freshly reset machine with the spindle off.
    if (this.isJobRunning || this.isPaused) {
      this.abandonJob('cancelled');
      this.updateState({ progressPercent: 0, remainingSeconds: null, pauseMessage: undefined });
    }
    // A parked job is standing still, so its line is still a good one.
    if (this.state.park) {
      this.parkToResume('alarm');
      this.updateState({ status: 'IDLE', progressPercent: 0, remainingSeconds: null });
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
    // What is left is a borrowed `$32`. GRBL takes settings in Alarm as well
    // as Idle.
    await this.restoreLaserMode();
  }
}

export const webSerialManager = new WebSerialManager();

// The owner's figure for the working envelope, for the travel check wherever
// the controller has not reported its own; kept current as it is edited or
// arrives from the account.
webSerialManager.setBed(cncBedStore.get());
cncBedStore.subscribe((bed) => webSerialManager.setBed(bed));
