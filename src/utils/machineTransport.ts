import {
  CloudTransport,
  LineBuffer,
  WebSerialTransport,
  isWebSerialSupported,
  webSerialUnavailableReason,
  type GrblTransport,
} from '@physbox-io/machining';
import { machineSocketUrl, submitMachineJob } from './apiClient';

// ---------------------------------------------------------------------------
// How the app reaches the machine
// ---------------------------------------------------------------------------
//
// The wires themselves are now `@physbox-io/machining`, shared with Etch and
// Volt. All three had their own copy, and each was holding a fix the other two
// never got — this one alone reported a dead read pipe as a disconnect, which
// is the fault that otherwise leaves a job sitting at line one looking like it
// is running. That went into the package; Etch's fix for the serial port
// wedging open on close came back the other way.
//
// What stays here is the shape this app talks in. The package's interface is
// chunk-oriented, because that is what a wire actually delivers; this one is
// line-oriented, because a status report split across two chunks is still one
// report and half of it parses as nothing. The adapters below are that
// difference and nothing else, so every caller keeps its imports.

export { isWebSerialSupported, webSerialUnavailableReason };

/** What a wire to the machine has to be able to do. */
export interface MachineTransport {
  /**
   * Hands a whole program over for the far end to run by itself.
   *
   * Only some wires can do this, and the difference is fundamental rather than
   * a detail. Over USB this browser *is* the streamer: it sends a line, waits
   * for `ok`, sends the next, and the job lives exactly as long as the tab
   * does. Through the cloud the device runs the program instead — because a
   * round trip per line would be unusable, and because a four-hour carve must
   * not depend on a laptop staying open.
   *
   * Absent on the transports that stream. `webSerialManager` checks for it and
   * takes the other path, rather than every caller having to know which kind of
   * connection it is looking at.
   */
  runJob?(gcode: string, options: { name?: string; estimatedSeconds?: number }): Promise<{
    delivered: boolean;
    message: string;
  }>;
  /** Shown in the UI as what is on the other end. */
  readonly label: string;
  /**
   * Opens the connection.
   *
   * `onLine` is called with each complete line the machine sends, already
   * trimmed of its newline. `onClosed` is called if the wire drops on its own —
   * a pulled cable, a Tekno Box that lost WiFi — as opposed to being closed
   * from this side.
   *
   * Rejects with a message fit to show the operator.
   */
  open(onLine: (line: string) => void, onClosed: () => void): Promise<void>;
  close(): Promise<void>;
  /** One G-code line, without its terminator; the transport frames it. */
  writeLine(line: string): Promise<void>;
  /** One realtime byte, ahead of anything queued. */
  writeRealtime(byte: number): Promise<void>;
}

/**
 * Wraps one of the package's transports in this app's line-oriented interface.
 *
 * The reassembly is the whole of the adaptation: chunks in, whole lines out.
 */
abstract class LineOrientedTransport implements MachineTransport {
  abstract readonly label: string;
  protected abstract readonly wire: GrblTransport;
  private readonly lines = new LineBuffer();

  async open(onLine: (line: string) => void, onClosed: () => void): Promise<void> {
    this.lines.reset();
    this.wire.onData(chunk => this.lines.push(chunk, onLine));
    this.wire.onDisconnect?.(() => {
      this.lines.reset();
      onClosed();
    });
    await this.wire.connect();
  }

  async close(): Promise<void> {
    await this.wire.disconnect();
    this.lines.reset();
  }

  writeLine(line: string): Promise<void> {
    return this.wire.writeLine(line);
  }

  writeRealtime(byte: number): Promise<void> {
    return this.wire.writeRealtime(byte);
  }
}

/** A USB cable straight into the machine's controller. */
export class SerialTransport extends LineOrientedTransport {
  readonly label = 'USB Machine';
  protected readonly wire: GrblTransport;

  constructor(baudRate = 115200) {
    super();
    this.wire = new WebSerialTransport(baudRate);
  }
}

/**
 * A Tekno Box, reached through api.physbox.io.
 *
 * Unlike the cable, this one can be handed a whole program to cut on its own —
 * see `runJob` on the interface.
 */
export class CloudMachineTransport extends LineOrientedTransport {
  readonly label: string;
  protected readonly wire: CloudTransport;

  constructor(deviceId: string, deviceName = 'machine') {
    super();
    this.label = `${deviceName} (physbox cloud)`;
    this.wire = new CloudTransport(deviceId, { machineSocketUrl, submitMachineJob });
  }

  runJob(gcode: string, options: { name?: string; estimatedSeconds?: number }) {
    return this.wire.runJob(gcode, options);
  }
}
