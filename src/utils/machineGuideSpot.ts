// The laser guide spot: a pointer-power beam for sighting the head onto the work.

import {
  GUIDE_JIGGLE_FEED_MM_MIN,
  GUIDE_JIGGLE_PATTERN,
  GUIDE_JIGGLE_REPLY_TIMEOUT_MS,
  GUIDE_JIGGLE_STEP_MM,
  GUIDE_SPOT_TIMEOUT_MS,
  readGuideJiggle,
  readGuidePower,
  writeLaserModeBorrowed,
} from './guideSpot';
import { MachineCore, QUICK_REPLY_TIMEOUT_MS } from './machineCore';

/** The guide spot, and the `$32` it borrows. See `src/utils/guideSpot.ts`. */
export abstract class GuideSpotMachine extends MachineCore {
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
   * lit it goes out on its own. A disconnect and starting a job put it out too,
   * through `guideSpotOff`, and an E-stop with its reset. A pulled cable leaves
   * it to the controller: nothing here can reach the beam, and its deadline goes
   * with the link, so it burns until the controller is reset or powered off.
   */
  public async guideSpotOn(power: number = readGuidePower()): Promise<void> {
    if (!this.state.connected) {
      this.updateState({ lastError: 'Not connected to a machine.' });
      return;
    }
    // Firing into a running job would fight the program's own S words, and the
    // spot would be indistinguishable from the cut anyway.
    // Starting counts: the start has already put the spot out, so one lit now
    // would stay lit, with `$32` off, for the whole job.
    if (this.isJobRunning || this.starting) {
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
    if (this.laserModeEnabled()) {
      // A parked job's borrow may already want it at 0 afterwards.
      const home = this.laserModeHome ?? 1;
      // Written down before the setting is changed, not after: the case this
      // covers is the page disappearing between the two.
      writeLaserModeBorrowed(home === 1 ? 1 : null);
      await this.sendLine('$32=0');
      this.noteLaserMode(0);
      this.laserModeHome = home === 1 ? 1 : null;
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
  protected async runGuideJiggle(): Promise<void> {
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
      this.laserModeHome = null;
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
    // Laser mode back before anything else can run.
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
  protected async awaitJiggleStopped(maxWaitMs = 1500): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (this.guideJiggleRunning && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  protected armGuideSpotTimeout(): void {
    this.clearGuideSpotTimeout();
    this.guideSpotTimer = setTimeout(() => {
      this.guideSpotTimer = null;
      void this.guideSpotOff();
    }, GUIDE_SPOT_TIMEOUT_MS);
  }

  protected clearGuideSpotTimeout(): void {
    if (this.guideSpotTimer) {
      clearTimeout(this.guideSpotTimer);
      this.guideSpotTimer = null;
    }
  }
}
