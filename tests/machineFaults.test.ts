import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prepareJobLines, webSerialManager } from '../src/utils/webSerialManager';

/**
 * How a job goes wrong, and whether the app says so.
 *
 * The streaming loop is paced one `ok` at a time, and every way of losing an
 * `ok` produces the same thing at the front: a program that stops on the line
 * it lost one at, with the app still showing it as running. These cover the two
 * that were reachable — a line the controller refuses, and an acknowledgement
 * eaten by something that was waiting on an earlier command.
 */
function attachFakeGrbl(options: { ack?: boolean } = {}) {
  const ack = options.ack ?? true;
  const mgr = webSerialManager as unknown as {
    transport: {
      label: string;
      writeLine: (line: string) => Promise<void>;
      writeRealtime: (byte: number) => Promise<void>;
      open: () => Promise<void>;
      close: () => Promise<void>;
    } | null;
    state: Record<string, unknown>;
    handleIncomingLine: (line: string) => void;
    sendAndWait: (command: string, timeoutMs?: number) => Promise<void>;
  };

  const sent: string[] = [];

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.guideSpot = false;

  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async writeRealtime() {},
    async writeLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      sent.push(trimmed);
      if (!ack) return;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          mgr.handleIncomingLine('ok');
          resolve();
        }, 0)
      );
    },
  };

  return {
    mgr,
    sent,
    detach() {
      mgr.transport = null;
      mgr.state.connected = false;
      mgr.state.status = 'DISCONNECTED';
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const JOB = ['G21', 'G90', 'G1 X10 F600', 'G1 X20', 'G1 X30', 'M30'].join('\n');

describe('a line the controller refuses', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake = attachFakeGrbl({ ack: false });
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('stands the job down instead of leaving it running for ever', async () => {
    webSerialManager.startJob(JOB);
    await settle();
    expect(webSerialManager.getState().status).toBe('RUNNING');

    // The refusal *is* the missing `ok`. Nothing more would ever have been
    // sent, and the app used to go on showing RUNNING at whatever percentage
    // it had reached.
    fake.mgr.handleIncomingLine('error:9');
    await settle();

    const state = webSerialManager.getState();
    expect(state.status).not.toBe('RUNNING');
    expect(state.lastError).toContain('error:9');
    // Locked out during alarm, said in words rather than as a number.
    expect(state.lastError).toContain('unlocked');
    // And the program is kept, so it can be run on from where it stopped.
    expect(state.resume?.fromLine).toBeGreaterThanOrEqual(0);
  });
});

describe('an acknowledgement left over from an earlier command', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    // Silent to begin with, so the command below goes unanswered and leaves a
    // waiter behind — a probe that never touched, a zeroing move refused while
    // the machine was still in alarm.
    fake = attachFakeGrbl({ ack: false });
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('does not eat the job\'s first ack', async () => {
    // Left waiting on an `ok` that never came. Its own timeout is minutes away,
    // which is far longer than it takes to press start — and the job's first
    // ack would go to it, after which the program sits on line one for ever,
    // showing RUNNING.
    void fake.mgr.sendAndWait('G38.2 Z-20 F50', 60_000);
    await settle();
    fake.sent.length = 0;

    // The machine starts answering again — it was only ever this app that was
    // still counting on a reply.
    const transport = fake.mgr.transport!;
    transport.writeLine = async (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      fake.sent.push(trimmed);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          fake.mgr.handleIncomingLine('ok');
          resolve();
        }, 0)
      );
    };

    webSerialManager.startJob(JOB);
    for (let i = 0; i < 6; i++) await settle();

    // It got past the first line, which is the whole of the claim.
    expect(fake.sent.length).toBeGreaterThan(1);
    expect(webSerialManager.getState().currentLine).toBeGreaterThan(1);
  });
});

describe('the prompt at a programmed stop', () => {
  it('reads the sheet number out of a parenthesised comment', () => {
    // The laser export writes its sheet swap as `M0 (PAUSE: ...)`, and G-code's
    // other comment syntax went unread — so an operator holding three sheets of
    // ply was told "Programmed stop. Resume when ready."
    const lines = prepareJobLines('M0 (PAUSE: Insert Material Sheet 2 of 3)\nG0 X0 Y0\n');

    expect(lines[0].code).toBe('M0');
    expect(lines[0].note).toContain('Sheet 2 of 3');
  });

  it('still reads the semicolon form, and keeps both when a line has both', () => {
    const lines = prepareJobLines('G0 X1 (rapid) ; to the corner\n');
    expect(lines[0].code).toBe('G0 X1');
    expect(lines[0].note).toContain('to the corner');
    expect(lines[0].note).toContain('rapid');
  });
});
