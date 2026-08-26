// ---------------------------------------------------------------------------
// How the app reaches the machine
// ---------------------------------------------------------------------------
//
// There are two wires now. One is a USB cable into the laptop; the other is a
// Tekno Box sitting on the machine with the USB cable plugged into *it*,
// relaying over WiFi. Everything above this file is the same either way — GRBL
// is GRBL, and the streamer, the resume logic and the status parser do not care
// how the bytes arrive.
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
    // `TextDecoderStream` declares its input as `BufferSource` while the port
    // yields `Uint8Array`. The two are compatible at run time; the cast is the
    // narrowest way to say so without loosening the port's own type.
    this.port.readable
      .pipeTo(decoder.writable as WritableStream<Uint8Array>)
      .catch(() => {});
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
 * Whether an address is one the browser treats as "potentially trustworthy".
 *
 * These are the origins exempt from mixed-content blocking, so they are the
 * ones an https page may open a plain `ws://` to. Everything else on the local
 * network is not — which is the whole of the difference between a Tekno Box
 * that connects from the deployed app and one that does not.
 */
export function loopbackHost(host: string): boolean {
  const bare = host.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  // Strip a port, minding the brackets IPv6 literals carry.
  const name = bare.startsWith('[')
    ? bare.slice(0, bare.indexOf(']') + 1)
    : bare.split(':')[0];

  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (name === '[::1]') return true;
  // The whole of 127.0.0.0/8, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/** How long to wait for the box to report the machine link open, ms. */
const TEKNOBOX_OPEN_TIMEOUT_MS = 8000;

/**
 * A Tekno Box on the network, hosting the machine's USB adapter.
 *
 * The box plugs into the controller's USB port and speaks to it over its own
 * USB-host stack (or a spare UART), then relays the traffic to whoever connects
 * to its WebSocket. From this side it is a transparent pipe with a JSON
 * envelope: `grbl_line` carries a line, `grbl_raw` carries realtime bytes, and
 * `grbl_data` brings back whatever the machine said.
 *
 * The envelope is worth one caution. `grbl_line` is *framed* by the box, which
 * appends the newline itself — so the line goes out bare, unlike the serial
 * transport where this side has to terminate it. Sending a terminated line
 * through the box puts a blank line on the wire after every command, and GRBL
 * answers a blank line with its own `ok`, which would desynchronise the
 * streamer's one-line-one-ack accounting within a few dozen lines.
 */
export class TeknoBoxTransport implements MachineTransport {
  readonly label: string;

  private socket: WebSocket | null = null;
  private lines = new LineBuffer();
  private closing = false;

  /**
   * Hostname or IP of the box, with an optional port. The scheme and the `/ws`
   * path are added in `url()`, so the operator types what is on the box's own
   * screen and nothing more.
   */
  private readonly host: string;
  /**
   * How the box reaches the controller: 'usb' has it hosting the machine's own
   * USB adapter, 'uart' is the fallback for boards without USB host, wired to
   * the controller's TX/RX directly.
   */
  private readonly backend: 'usb' | 'uart';
  private readonly baudRate: number;

  constructor(host: string, backend: 'usb' | 'uart' = 'usb', baudRate = 115200) {
    this.host = host;
    this.backend = backend;
    this.baudRate = baudRate;
    this.label = `Tekno Box (${host})`;
  }

  private url(): string {
    const trimmed = this.host.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
    // Plain ws:, because the box serves plain http on port 80 and has no
    // certificate to offer. From an https page that is mixed content and is
    // refused; from an http one it is fine. See `loopbackHost` for the one
    // exception, and `unreachableMessage` for saying so when it bites.
    return `ws://${trimmed}/ws`;
  }

  open(onLine: (line: string) => void, onClosed: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.closing = false;
      this.lines.reset();

      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url());
      } catch {
        reject(new Error(`${this.host} is not a usable address for a Tekno Box.`));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // already gone
        }
        reject(
          new Error(
            `The Tekno Box at ${this.host} did not answer within ${TEKNOBOX_OPEN_TIMEOUT_MS / 1000} seconds. ` +
              `Check it is powered up and on the same network.`
          )
        );
      }, TEKNOBOX_OPEN_TIMEOUT_MS);

      socket.onopen = () => {
        // Reaching the box is not the same as reaching the machine: the box is
        // on the network whether or not anything is plugged into it. So the
        // link is only "open" once it says the machine side came up.
        socket.send(
          JSON.stringify({
            cmd: 'grbl_open',
            baud: this.baudRate,
            backend: this.backend,
            timeout_ms: 3000,
          })
        );
      };

      socket.onmessage = (event) => {
        let msg: { type?: string; data?: unknown; open?: unknown; err?: unknown };
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return; // The box also broadcasts traffic this app has no interest in.
        }

        if (msg?.type === 'grbl_data' && typeof msg.data === 'string') {
          this.lines.push(msg.data, onLine);
          return;
        }

        if (msg?.type === 'grbl_status') {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            if (msg.open) {
              resolve();
            } else {
              try {
                socket.close();
              } catch {
                // already gone
              }
              reject(
                new Error(
                  msg.err
                    ? `The Tekno Box could not reach the machine: ${msg.err}`
                    : `The Tekno Box at ${this.host} is running, but nothing is answering on its ` +
                      `machine port. Check the USB lead into the controller.`
                )
              );
            }
          } else if (!msg.open && !this.closing) {
            // The machine went away while the box stayed up — an unplugged USB
            // lead at the controller end. That is a drop like any other.
            onClosed();
          }
        }
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(this.unreachableMessage()));
      };

      socket.onclose = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`The Tekno Box at ${this.host} closed the connection.`));
          return;
        }
        if (!this.closing) onClosed();
      };
    });
  }

  /**
   * What to say when the socket would not open.
   *
   * Worth telling apart, because one of the two causes is invisible: a page on
   * https is not allowed to open a plain connection to a machine on the local
   * network, and the browser reports that refusal as an ordinary connection
   * failure. Someone checking cables and power for a problem the browser
   * decided before a packet moved will not find it.
   */
  private unreachableMessage(): string {
    const blockedByMixedContent =
      typeof window !== 'undefined' &&
      window.location?.protocol === 'https:' &&
      !loopbackHost(this.host);

    if (blockedByMixedContent) {
      return (
        `This page is on https, and browsers will not let a secure page open a plain connection to ` +
        `a machine on your network — so ${this.host} was refused before anything was tried. Open ` +
        `physbox over http to use the WiFi link.`
      );
    }
    return `Could not reach a Tekno Box at ${this.host}. Check the address and that the box is powered up on this network.`;
  }

  async close(): Promise<void> {
    this.closing = true;
    const socket = this.socket;
    this.socket = null;
    this.lines.reset();
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd: 'grbl_close' }));
      }
      socket.close();
    } catch {
      // The socket is going away regardless.
    }
  }

  private send(payload: unknown) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  async writeLine(line: string): Promise<void> {
    // Bare: the box appends the newline. See the class comment.
    this.send({ cmd: 'grbl_line', data: line.trim() });
  }

  async writeRealtime(byte: number): Promise<void> {
    this.send({ cmd: 'grbl_raw', bytes: [byte] });
  }
}
