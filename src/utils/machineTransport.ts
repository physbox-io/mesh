import { machineSocketUrl, submitMachineJob } from './apiClient';

// ---------------------------------------------------------------------------
// How the app reaches the machine
// ---------------------------------------------------------------------------
//
// There are two wires. One is a USB cable into the laptop; the other is a Tekno
// Box plugged into the machine, reached through api.physbox.io. Everything
// above this file is the same either way — GRBL is GRBL, and the streamer, the
// resume logic and the status parser do not care how the bytes arrive.
//
// There is deliberately no third wire straight to a box on the local network.
// It was tried and removed: it cannot work from the deployed https app at all
// (a secure page may not open a plain connection to a home network), so it was
// an option that worked on a developer's laptop and nowhere else. WiFi means
// the Tekno Box, and the Tekno Box is reached through the cloud.
//
// So the difference is confined here, to two implementations of one small
// interface. The interface is deliberately line-oriented rather than
// byte-oriented, because that is the level both wires agree at: the serial side
// has to reassemble lines out of arbitrary chunks anyway, and the WebSocket
// side is handed text that also needs splitting. Doing it once per transport
// and handing whole lines upward means the manager never sees a partial line,
// which is what it always wanted.
//
// Realtime bytes stay separate from lines because GRBL treats them separately:
// `?`, `!`, `~`, 0x18 and 0x85 are acted on the moment they arrive, ahead of
// everything already buffered, and a transport that queued them behind the
// program would turn a feed hold into a request to stop in several seconds'
// time.

/** What a wire to the machine has to be able to do. */
export interface MachineTransport {
  /**
   * Hands a whole program over for the far end to run by itself.
   *
   * Only some wires can do this, and the difference is fundamental rather than
   * a detail. Over USB or on the LAN this browser *is* the streamer: it sends a
   * line, waits for `ok`, sends the next, and the job lives exactly as long as
   * the tab does. Through the cloud the device runs the program instead —
   * because a round trip per line would be unusable, and because a four-hour
   * carve must not depend on a laptop staying open.
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
 * Splits an arbitrary stream of chunks into whole lines.
 *
 * Both transports need this and neither may keep a partial line to itself: a
 * status report that arrives in two pieces is still one report, and half of it
 * parses as nothing at all.
 */
class LineBuffer {
  private buffer = '';

  push(chunk: string, emit: (line: string) => void) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) emit(trimmed);
    }
  }

  reset() {
    this.buffer = '';
  }
}

/**
 * The slice of the WebSerial API this file uses.
 *
 * Declared here rather than pulled in as a dependency: the spec is not in
 * TypeScript's DOM lib, and the alternative is `any` on the one object that
 * every byte to the machine passes through.
 */
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

interface SerialLike {
  requestPort(): Promise<SerialPortLike>;
}

function serialApi(): SerialLike | null {
  const nav = navigator as Navigator & { serial?: SerialLike };
  return nav.serial ?? null;
}

/** Whether this browser can talk to a USB serial device at all. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && serialApi() !== null;
}

/**
 * Why the USB cable is not on offer, or null when it is.
 *
 * There are two quite different reasons and they send you looking in opposite
 * places. WebSerial is gated on a *secure context*, so it is missing from a page
 * served over plain http at a LAN address — nothing to do with the browser, and
 * telling someone to switch browsers there wastes an afternoon. It is genuinely
 * absent in Firefox and Safari whatever the origin.
 *
 * The two are told apart by `isSecureContext`, which is exactly the condition
 * the API is gated on. Note that `http://localhost` is a secure context by
 * definition, which is why the machine running the app can use the cable while
 * a phone on the same network cannot.
 */
export function webSerialUnavailableReason(): string | null {
  if (isWebSerialSupported()) return null;

  const secure = typeof window !== 'undefined' && window.isSecureContext;
  if (!secure) {
    return (
      'USB needs a secure page. This one is served over plain http, so the browser hides the ' +
      'serial API — open the app on localhost or over https to use the cable, or connect over ' +
      'WiFi instead, which works from here.'
    );
  }
  return 'This browser has no WebSerial. Use Chrome, Edge or Opera for the cable — or connect over WiFi, which works in any of them.';
}

/** A USB cable straight into the machine's controller. */
export class SerialTransport implements MachineTransport {
  readonly label = 'USB Machine';

  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private reading = false;
  private lines = new LineBuffer();

  private readonly baudRate: number;

  constructor(baudRate = 115200) {
    this.baudRate = baudRate;
  }

  async open(onLine: (line: string) => void, onClosed: () => void): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error(webSerialUnavailableReason() ?? 'USB serial is not available here.');
    }

    const serial = serialApi();
    if (!serial) throw new Error('WebSerial disappeared between the check and the request.');
    this.port = await serial.requestPort();
    await this.port.open({ baudRate: this.baudRate });

    const decoder = new TextDecoderStream();
    /*
     * `TextDecoderStream` declares its input as `BufferSource` while the port
     * yields `Uint8Array`. The two are compatible at run time; the cast is the
     * narrowest way to say so without loosening the port's own type.
     *
     * The rejection is not swallowed. This pipe failing is the one fault that
     * leaves everything else looking healthy: writes still succeed, the machine
     * still moves, and nothing ever comes back — so `$$` goes unanswered, the
     * position readout sits at zero, and the first line of a job waits for an
     * `ok` for ever while the app shows it as running. Reported as a drop,
     * because that is what it is: half the wire is gone.
     */
    this.port.readable
      .pipeTo(decoder.writable as WritableStream<Uint8Array>)
      .catch(() => {
        if (!this.reading) return;
        this.reading = false;
        onClosed();
      });
    this.reader = decoder.readable.getReader();

    const encoder = new TextEncoderStream();
    encoder.readable.pipeTo(this.port.writable).catch(() => {});
    this.writer = encoder.writable.getWriter();

    this.reading = true;
    this.lines.reset();
    void this.readLoop(onLine, onClosed);
  }

  private async readLoop(onLine: (line: string) => void, onClosed: () => void) {
    while (this.reading && this.reader) {
      try {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.lines.push(value, onLine);
      } catch {
        break;
      }
    }
    // Only a drop counts: `close()` clears the flag before it cancels the
    // reader, so a deliberate disconnect does not report itself as a fault.
    if (this.reading) {
      this.reading = false;
      onClosed();
    }
  }

  async close(): Promise<void> {
    this.reading = false;
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
      }
      if (this.writer) {
        await this.writer.close();
        this.writer.releaseLock();
      }
      if (this.port) await this.port.close();
    } catch {
      // Cleanup errors are not worth reporting: the wire is going away either way.
    }
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.lines.reset();
  }

  async writeLine(line: string): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(line.trim() + '\n');
  }

  async writeRealtime(byte: number): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(String.fromCharCode(byte));
  }
}

/**
 * A machine reached through api.physbox.io.
 *
 * The device holds an outbound connection to the relay; this opens the other
 * side of it. Nothing here touches the customer's network, so it works from the
 * deployed https app — which the direct-LAN transport above cannot, and never
 * will, because a secure page may not open a plain connection to a home
 * network.
 *
 * The division of labour is the thing to understand. Interactive commands —
 * jog, home, zero, a status poll, stop — go over this link, and a hundred
 * milliseconds of round trip is neither here nor there for those. Running a
 * program does *not*: `runJob` hands the G-code to the API and the device cuts
 * it on its own. See the interface's comment on `runJob`.
 */
export class CloudMachineTransport implements MachineTransport {
  readonly label: string;

  private socket: WebSocket | null = null;
  private lines = new LineBuffer();
  private closing = false;
  private readonly deviceId: string;

  constructor(deviceId: string, deviceName = 'machine') {
    this.deviceId = deviceId;
    this.label = `${deviceName} (physbox cloud)`;
  }

  open(onLine: (line: string) => void, onClosed: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = machineSocketUrl(this.deviceId);
      if (!url) {
        reject(new Error('Sign in to physbox to reach a machine over the internet.'));
        return;
      }

      let settled = false;
      this.closing = false;
      this.lines.reset();

      const socket = new WebSocket(url);
      this.socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // already gone
        }
        reject(new Error('physbox did not answer. Check your internet connection.'));
      }, 15000);

      socket.onmessage = (event) => {
        let msg: { type?: string; data?: unknown; error?: unknown };
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }

        if (msg?.type === 'welcome') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }

        if (msg?.type === 'machine_data' && typeof msg.data === 'string') {
          this.lines.push(msg.data, onLine);
          return;
        }

        if (msg?.type === 'device_offline') {
          /*
           * The relay is still there; the machine is not.
           *
           * Reported as a dropped link rather than swallowed, because from up
           * here the two are the same thing — commands will not reach the
           * cutter either way, and a panel that goes on showing "connected"
           * while the machine is unplugged is worse than one that says so.
           */
          if (settled && !this.closing) onClosed();
        }
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Could not reach physbox.'));
      };

      socket.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('physbox closed the connection. Your session may have expired.'));
          return;
        }
        if (!this.closing) onClosed();
      };
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = null;
    this.lines.reset();
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Going away regardless.
    }
  }

  private send(payload: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  async writeLine(line: string): Promise<void> {
    this.send({ type: 'machine_line', data: line.trim() });
  }

  async writeRealtime(byte: number): Promise<void> {
    this.send({ type: 'machine_realtime', bytes: [byte] });
  }

  async runJob(gcode: string, options: { name?: string; estimatedSeconds?: number }) {
    const result = await submitMachineJob({
      deviceId: this.deviceId,
      gcode,
      name: options.name,
      estimatedSeconds: options.estimatedSeconds,
    });
    return { delivered: result.delivered, message: result.message };
  }
}
