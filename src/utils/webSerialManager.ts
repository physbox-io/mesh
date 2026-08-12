// ---------------------------------------------------------------------------
// WebSerial Connection & Machine Controller Manager
// Supports GRBL / Marlin serial communication, homing, zeroing, framing trace,
// and interactive pauses for Manual Tool Changes (M6) and Material Swaps (M0).
// ---------------------------------------------------------------------------

export type MachineStatus =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'IDLE'
  | 'RUNNING'
  | 'PAUSED_MATERIAL'
  | 'PAUSED_TOOL'
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
  pauseMessage?: string;
  lastError?: string;
}

export type MachineStateListener = (state: MachineState) => void;

class WebSerialManager {
  private port: any = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private isReading = false;
  private statusPollTimer: any = null;

  private gcodeQueue: string[] = [];
  private currentQueueIndex = 0;
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

  private state: MachineState = {
    status: 'DISCONNECTED',
    connected: false,
    mpos: { x: 0, y: 0, z: 0 },
    wpos: { x: 0, y: 0, z: 0 },
    currentLine: 0,
    totalLines: 0,
    progressPercent: 0,
  };

  private listeners: Set<MachineStateListener> = new Set();

  public isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
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
  }

  private updateState(patch: Partial<MachineState>) {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  /** Requests USB port from user and opens connection at 115200 baud. */
  public async connect(baudRate = 115200): Promise<boolean> {
    if (!this.isSupported()) {
      this.updateState({ status: 'ERROR', lastError: 'WebSerial API is not supported in this browser. Use Chrome, Edge, or Opera.' });
      return false;
    }

    try {
      this.updateState({ status: 'CONNECTING' });
      // Request serial port from user browser picker
      this.port = await (navigator as any).serial.requestPort();
      await this.port!.open({ baudRate });

      const textDecoder = new TextDecoderStream();
      this.port!.readable!.pipeTo(textDecoder.writable);
      this.reader = textDecoder.readable.getReader();

      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(this.port!.writable!);
      this.writer = textEncoder.writable.getWriter();

      this.isReading = true;
      this.startReadingLoop();
      this.startStatusPolling();

      this.updateState({ status: 'IDLE', connected: true, portName: 'USB Machine' });
      return true;
    } catch (err: any) {
      this.updateState({
        status: 'DISCONNECTED',
        connected: false,
        lastError: err?.message || 'Failed to connect to USB serial device.',
      });
      return false;
    }
  }

  /** Closes serial connection. */
  public async disconnect(): Promise<void> {
    this.stopStatusPolling();
    this.isReading = false;
    this.isJobRunning = false;

    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
      if (this.writer) {
        await this.writer.close();
        this.writer.releaseLock();
      }
      if (this.port) {
        await this.port.close();
      }
    } catch {
      // ignore cleanup errors
    }

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.updateState({ status: 'DISCONNECTED', connected: false });
  }

  /** Sends a single G-code string line over serial. */
  public async sendLine(command: string): Promise<void> {
    if (!this.writer || !this.state.connected) return;
    const line = command.trim() + '\n';
    await this.writer.write(line);
  }

  /** Reads incoming serial messages from GRBL / Marlin. */
  private async startReadingLoop() {
    let buffer = '';
    while (this.isReading && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            this.handleIncomingLine(line.trim());
          }
        }
      } catch (err) {
        break;
      }
    }
  }

  /** Parses GRBL response lines like 'ok', 'error:', or '<Idle|MPos:10,20,0|WPos:10,20,0>'. */
  private handleIncomingLine(line: string) {
    if (!line) return;

    // GRBL Status Parsing: <Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:0.000,0.000,0.000>
    if (line.startsWith('<') && line.endsWith('>')) {
      const body = line.slice(1, -1);
      const parts = body.split('|');
      const grblState = parts[0];

      if (grblState === 'Alarm') {
        this.updateState({ status: 'ALARM' });
      }

      for (const part of parts) {
        if (part.startsWith('MPos:')) {
          const coords = part.slice(5).split(',').map(Number);
          if (coords.length >= 3) {
            this.updateState({ mpos: { x: coords[0], y: coords[1], z: coords[2] } });
          }
        } else if (part.startsWith('WPos:')) {
          const coords = part.slice(5).split(',').map(Number);
          if (coords.length >= 3) {
            this.updateState({ wpos: { x: coords[0], y: coords[1], z: coords[2] } });
          }
        }
      }
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
      this.updateState({ lastError: `Machine Error: ${line}` });
      const failProbe = this.pendingProbe;
      this.pendingProbe = null;
      if (failProbe) failProbe(null);
      const waiters = this.okWaiters;
      this.okWaiters = [];
      for (const w of waiters) w();
    }
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
    if (!this.writer || !this.state.connected) return Promise.resolve();
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
    if (!this.writer || !this.state.connected) return null;

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
    this.statusPollTimer = setInterval(() => {
      if (this.state.connected && this.writer) {
        this.writer.write('?');
      }
    }, 300);
  }

  private stopStatusPolling() {
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
  }

  /** Starts streaming a full G-code job. */
  public startJob(gcode: string) {
    if (!this.state.connected) return;

    this.gcodeQueue = gcode.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith(';'));
    this.currentQueueIndex = 0;
    this.isJobRunning = true;
    this.isPaused = false;

    this.updateState({
      status: 'RUNNING',
      currentLine: 0,
      totalLines: this.gcodeQueue.length,
      progressPercent: 0,
    });

    this.advanceJobQueue();
  }

  /** Processes and sends the next line in the G-code queue. */
  private async advanceJobQueue() {
    if (!this.isJobRunning || this.isPaused) return;

    if (this.currentQueueIndex >= this.gcodeQueue.length) {
      this.isJobRunning = false;
      this.updateState({ status: 'IDLE', progressPercent: 100 });
      return;
    }

    const line = this.gcodeQueue[this.currentQueueIndex];
    this.currentQueueIndex++;

    const progressPercent = Math.round((this.currentQueueIndex / this.gcodeQueue.length) * 100);
    this.updateState({ currentLine: this.currentQueueIndex, progressPercent });

    // Handle Tool Change (T<N> M6) or Material Swap (M0) Pauses
    if (line.includes('M6') || line.startsWith('T') && line.includes('M6')) {
      this.triggerPause('PAUSED_TOOL', `Tool Change Required (${line}). Replace tool and zero Z before resuming.`);
      return;
    }

    if (line.startsWith('M0') || line.includes('PAUSE: Insert Material Sheet')) {
      const match = line.match(/Sheet (\d+ of \d+)/);
      const msg = match ? `Insert Material Sheet ${match[1]}` : 'Insert Next Material Sheet into cutter.';
      this.triggerPause('PAUSED_MATERIAL', msg);
      return;
    }

    await this.sendLine(line);
  }

  /** Triggers an interactive pause for Tool or Material Changes. */
  private async triggerPause(type: 'PAUSED_TOOL' | 'PAUSED_MATERIAL', message: string) {
    this.isPaused = true;
    this.updateState({ status: type, pauseMessage: message });

    // Send safety park commands
    await this.sendLine('M5'); // Laser/Spindle OFF
    await this.sendLine('G0 Z25.000'); // Safe Z
    await this.sendLine('G0 X0.000 Y0.000'); // Park XY
  }

  /** Resumes a paused job after tool/material swap. */
  public async resumeJob() {
    if (!this.isPaused) return;

    this.isPaused = false;
    this.updateState({ status: 'RUNNING', pauseMessage: undefined });
    // Out of band GRBL resume ~
    if (this.writer) await this.writer.write('~');
    this.advanceJobQueue();
  }

  /** Cancels the running job. */
  public async cancelJob() {
    this.isJobRunning = false;
    this.isPaused = false;
    this.gcodeQueue = [];
    await this.eStop();
    this.updateState({ status: 'IDLE', progressPercent: 0 });
  }

  /** Triggers hardware homing cycle ($H). */
  public async homeMachine(): Promise<void> {
    await this.sendLine('$H');
  }

  /** Kills GRBL Alarm state ($X). */
  public async unlockAlarm(): Promise<void> {
    await this.sendLine('$X');
  }

  /** Sets current XY position as G54 Work Origin (0,0). */
  public async zeroXY(): Promise<void> {
    await this.sendLine('G10 L20 P1 X0 Y0');
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
    if (this.writer) await this.writer.write('\x85');
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
    touchPlateThicknessMm = 15.0,
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
    if (this.writer) {
      await this.writer.write('\x18'); // Ctrl+X soft reset
      await this.sendLine('M5');
    }
  }
}

export const webSerialManager = new WebSerialManager();
