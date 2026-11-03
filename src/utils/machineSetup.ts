// Getting the work set up: zeroing by hand, jogging, homing, framing, and lifting clear.

import type { FrameJobOptions } from '@physbox-io/machining';
import { DATUM_NOT_CONFIRMED } from './machineCore';
import { GuideSpotMachine } from './machineGuideSpot';

/**
 * How far below the homing pull-off point a machine-referenced retract stops.
 *
 * Homing leaves the tool at `MPos -$27`, the pull-off, which is only just
 * clear of the switch. A retract to a millimetre under the ceiling sat on that
 * edge with the default `$27=1`, and a switch with a few tenths of hysteresis
 * trips there. So the retract stops this far below the pull-off point instead.
 */
const RETRACT_BELOW_PULLOFF_MM = 1;

/** Setting the work up by hand: datums, jogging, homing, framing and lifting clear. */
export abstract class SetupMachine extends GuideSpotMachine {
  /** The block's datum has been re-taken, for the setup gate. */
  protected recordZDatum(): void {
    super.recordZDatum();
    this.zZeroedAt = ++this.datumSeq;
  }

  protected recordXYDatum(axes: { x?: boolean; y?: boolean } = { x: true, y: true }): void {
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
    if (!(await this.writeDatum(`G10 L20 P1 ${words.join(' ')}`))) {
      return { success: false, message: DATUM_NOT_CONFIRMED };
    }
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

  public async homeMachine(): Promise<void> {
    this.refuseWhileJobHoldsMachine('home');
    await super.homeMachine();
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
    if (!(await this.writeDatum(`G10 L20 P1 Z${offsetMm.toFixed(3)}`))) {
      return { success: false, message: DATUM_NOT_CONFIRMED };
    }
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
  protected async retractClearOfWork(): Promise<boolean> {
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
}
