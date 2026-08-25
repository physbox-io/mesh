import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TeknoBoxTransport } from '../src/utils/machineTransport';

/**
 * A stand-in for the browser's WebSocket, with the two hooks the tests need:
 * what was sent, and a way to play messages back as if the box had sent them.
 */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;

  url: string;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  /** Everything the transport sent, as parsed envelopes. */
  envelopes() {
    return this.sent.map((s) => JSON.parse(s));
  }

  /** Plays a message back from the box. */
  deliver(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** Brings the link up the way the real box does. */
  bringUp() {
    this.onopen?.();
    this.deliver({ type: 'grbl_status', open: true, backend: 'usb', err: null });
  }
}

const originalWebSocket = (globalThis as any).WebSocket;

beforeEach(() => {
  (globalThis as any).WebSocket = FakeSocket;
  FakeSocket.last = null;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
  vi.useRealTimers();
});

/** Opens a transport against the fake, returning both. */
async function connected(host = '192.168.1.42') {
  const lines: string[] = [];
  let dropped = false;
  const transport = new TeknoBoxTransport(host);
  const opening = transport.open(
    (l) => lines.push(l),
    () => {
      dropped = true;
    }
  );
  // The constructor runs synchronously inside open(), so the socket exists.
  const socket = FakeSocket.last!;
  socket.bringUp();
  await opening;
  return { transport, socket, lines, wasDropped: () => dropped };
}

describe('TeknoBoxTransport addressing', () => {
  it('adds the scheme and the /ws path to a bare host', async () => {
    const { socket } = await connected('192.168.1.42');
    expect(socket.url).toBe('ws://192.168.1.42/ws');
  });

  it('tolerates a host typed with a scheme or a trailing slash', async () => {
    for (const typed of ['ws://box.local', 'box.local/', 'box.local']) {
      const { socket } = await connected(typed);
      expect(socket.url).toBe('ws://box.local/ws');
    }
  });

  it('keeps an explicit port', async () => {
    const { socket } = await connected('10.0.0.5:8080');
    expect(socket.url).toBe('ws://10.0.0.5:8080/ws');
  });
});

describe('TeknoBoxTransport opening', () => {
  it('asks the box to open the machine link', async () => {
    const { socket } = await connected();
    const open = socket.envelopes().find((e) => e.cmd === 'grbl_open');
    expect(open).toMatchObject({ cmd: 'grbl_open', baud: 115200, backend: 'usb' });
  });

  it('waits for the machine, not just the box', async () => {
    // Reaching the box proves nothing about what is plugged into it.
    const transport = new TeknoBoxTransport('box.local');
    const opening = transport.open(
      () => {},
      () => {}
    );
    const socket = FakeSocket.last!;
    socket.onopen?.();

    let settled = false;
    void opening.then(
      () => (settled = true),
      () => (settled = true)
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.deliver({ type: 'grbl_status', open: true, backend: 'usb' });
    await expect(opening).resolves.toBeUndefined();
  });

  it('reports what the box said when the machine side will not open', async () => {
    const transport = new TeknoBoxTransport('box.local');
    const opening = transport.open(
      () => {},
      () => {}
    );
    const socket = FakeSocket.last!;
    socket.onopen?.();
    socket.deliver({ type: 'grbl_status', open: false, err: 'no usb device' });

    await expect(opening).rejects.toThrow(/no usb device/);
  });
});

describe('TeknoBoxTransport framing', () => {
  it('sends a G-code line bare, because the box appends the newline', async () => {
    const { transport, socket } = await connected();
    await transport.writeLine('G0 X10 Y10');

    const line = socket.envelopes().find((e) => e.cmd === 'grbl_line');
    expect(line).toEqual({ cmd: 'grbl_line', data: 'G0 X10 Y10' });
    // A terminator here would put a blank line on the wire after every command,
    // and GRBL answers a blank line with its own `ok` — which desynchronises the
    // streamer's one-line-one-ack accounting.
    expect(line.data).not.toContain('\n');
  });

  it('sends realtime bytes raw rather than as a line', async () => {
    const { transport, socket } = await connected();
    await transport.writeRealtime(0x21); // feed hold

    expect(socket.envelopes().find((e) => e.cmd === 'grbl_raw')).toEqual({
      cmd: 'grbl_raw',
      bytes: [0x21],
    });
    expect(socket.envelopes().some((e) => e.cmd === 'grbl_line')).toBe(false);
  });

  it('reassembles a status report split across two frames', async () => {
    const { socket, lines } = await connected();
    socket.deliver({ type: 'grbl_data', data: '<Idle|MPos:1.000,2.000' });
    expect(lines).toEqual([]); // half a report parses as nothing

    socket.deliver({ type: 'grbl_data', data: ',3.000|FS:0,0>\nok\n' });
    expect(lines).toEqual(['<Idle|MPos:1.000,2.000,3.000|FS:0,0>', 'ok']);
  });

  it('splits several lines arriving in one frame', async () => {
    const { socket, lines } = await connected();
    socket.deliver({ type: 'grbl_data', data: 'ok\nok\nerror:2\n' });
    expect(lines).toEqual(['ok', 'ok', 'error:2']);
  });

  it('ignores the box chatter that is nothing to do with the machine', async () => {
    const { socket, lines } = await connected();
    socket.deliver({ type: 'mesh_messages', messages: [] });
    socket.deliver({ type: 'grbl_data', data: 'ok\n' });
    expect(lines).toEqual(['ok']);
  });
});

describe('TeknoBoxTransport closing', () => {
  it('tells the box to release the machine', async () => {
    const { transport, socket } = await connected();
    await transport.close();

    expect(socket.envelopes().some((e) => e.cmd === 'grbl_close')).toBe(true);
    expect(socket.closed).toBe(true);
  });

  it('does not report a deliberate close as a dropped link', async () => {
    const { transport, socket, wasDropped } = await connected();
    await transport.close();
    socket.onclose?.();
    expect(wasDropped()).toBe(false);
  });

  it('does report the wire going away on its own', async () => {
    const { socket, wasDropped } = await connected();
    socket.onclose?.();
    expect(wasDropped()).toBe(true);
  });

  it('reports the machine being unplugged from a box that stays up', async () => {
    const { socket, wasDropped } = await connected();
    socket.deliver({ type: 'grbl_status', open: false, err: 'device gone' });
    expect(wasDropped()).toBe(true);
  });
});
