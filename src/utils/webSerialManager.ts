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

    if (line.startsWith('ok')) {
      if (this.isJobRunning && !this.isPaused) {
        this.advanceJobQueue();
      }
    } else if (line.startsWith('error:')) {
      this.updateState({ lastError: `Machine Error: ${line}` });
    }
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

  /** Runs Auto Z-Probe Macro for CNC Tool Changes. */
  public async zeroZ(touchPlateThicknessMm = 15.0): Promise<void> {
    await this.sendLine('G38.2 Z-30 F50');
    await this.sendLine(`G92 Z${touchPlateThicknessMm.toFixed(3)}`);
    await this.sendLine('G0 Z10.000');
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
