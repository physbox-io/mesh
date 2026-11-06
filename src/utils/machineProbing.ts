// Touch-plate zeroing and bed probing, gated on a proved probe circuit.

import { normalizeGrid, type ProbeGrid } from '@physbox-io/machining';
import { DATUM_NOT_CONFIRMED } from './machineCore';
import { SetupMachine } from './machineSetup';

/**
 * How far a Z zeroing probe searches for the plate. The tool is parked a few
 * millimetres above it first, so this only has to cover that gap; it used to
 * be 25mm, which on a circuit that failed to close was a 25mm drive through
 * the work.
 */
export const ZERO_SEARCH_MM = 10;

/** Probing: Z from a touch plate, and a grid of the bed for levelling. */
export abstract class ProbingMachine extends SetupMachine {
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
  protected probeCircuitFault(): string | null {
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
  protected assertProbeCircuit(): void {
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
  protected async probeOnce(searchDepthMm: number, feedrate: number): Promise<number | null> {
    try {
      return (await this.probeDown(searchDepthMm, feedrate)).z;
    } catch {
      return null;
    }
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

      if (!(await this.writeDatum(`G10 L20 P1 Z${touchPlateThicknessMm.toFixed(3)}`))) {
        return { success: false, message: DATUM_NOT_CONFIRMED };
      }
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

      // The first hop has no lift behind it, so a tool left on the stock would
      // drag there. Relative like every other Z move here, and only off a datum
      // that means something: with none, the reading is no measure of the gap.
      await this.awaitStatus();
      const short = PROBE_LIFT_MM - this.state.wpos.z;
      if (!this.state.needsZZero && short > 0.001) {
        await this.sendAndWait(`G91 G0 Z${short.toFixed(3)}`);
        await this.sendAndWait('G90');
      }

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
}
