import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webSerialManager } from '../src/utils/webSerialManager';

/**
 * A GRBL board that acknowledges everything and records what it was sent.
 *
 * Unlike the probing harness this one keeps the real-time bytes separate from
 * the line traffic, because the whole point of a feed hold is that it is not a
 * queued command — a `!` that arrived behind ten thousand buffered moves would
 * be a pause that took a minute to happen.
 */
function attachFakeGrbl() {
  const mgr = webSerialManager as unknown as {
    writer: { write: (s: string) => Promise<void> } | null;
    state: Record<string, unknown>;
    handleIncomingLine: (line: string) => void;
  };

  const sent: string[] = [];

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.writer = {
    async write(chunk: string) {
      // Real-time bytes carry no newline and are not lines.
      if (chunk === '!' || chunk === '~' || chunk === '?' || chunk === '\x18' || chunk === '\x85') {
        sent.push(chunk);
        return;
      }
      const trimmed = chunk.trim();
      if (!trimmed) return;
      sent.push(trimmed);
      // Acknowledged on a timer rather than a microtask, so a test can let the
      // stream advance one line at a time instead of draining the whole job
      // the first time it yields.
      await new Promise<void>((resolve) => setTimeout(() => {
        mgr.handleIncomingLine('ok');
        resolve();
      }, 0));
    },
  };

  return {
    sent,
    lines: () => sent.filter((s) => s.length > 1),
    detach() {
      mgr.writer = null;
      mgr.state.connected = false;
      mgr.state.status = 'DISCONNECTED';
      mgr.state.needsZZero = false;
    },
  };
}

/** Lets one queued `ok` land, which advances the stream by about a line. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Runs the stream on for `n` lines. */
async function advance(n: number) {
  for (let i = 0; i < n; i++) await settle();
}

const JOB = [
  'G21',
  'G90',
  'G1 X10 F600',
  'G1 X20',
  'G1 X30',
  'G1 X40',
  'M30',
].join('\n');

describe('pausing and resuming a running job', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('holds with a real-time byte and stops feeding the queue', async () => {
    webSerialManager.startJob(JOB);
    await settle();
    expect(webSerialManager.getState().status).toBe('RUNNING');
    await webSerialManager.pauseJob();
    const atPause = fake.lines().length;

    expect(webSerialManager.getState().status).toBe('PAUSED_USER');
    // `!` and not a queued command: it has to overtake everything already sent.
    expect(fake.sent).toContain('!');

    // Nothing more goes out while it is held, however many acks arrive.
    await advance(4);
    expect(fake.lines().length).toBe(atPause);
  });

  it('picks the program back up where it stopped, losing no line', async () => {
    webSerialManager.startJob(JOB);
    await settle();
    await webSerialManager.pauseJob();
    const lineAtPause = webSerialManager.getState().currentLine;

    await webSerialManager.resumeJob();
    await advance(8);

    expect(fake.sent).toContain('~');
    expect(webSerialManager.getState().currentLine).toBeGreaterThan(lineAtPause);
    // The program's own moves all reached the machine, none twice.
    const moves = fake.lines().filter((l) => l.startsWith('G1 X'));
    expect(moves).toEqual([...new Set(moves)]);
  });

  it('will not pause a machine that is not running a job', async () => {
    await webSerialManager.pauseJob();
    expect(fake.sent).not.toContain('!');
    expect(webSerialManager.getState().status).not.toBe('PAUSED_USER');
  });

  it('leaves the spindle running through an operator pause', async () => {
    webSerialManager.startJob(JOB);
    await settle();
    await webSerialManager.pauseJob();
    // A feed hold parks nothing and turns nothing off — the tool is still in
    // the cut, and it is going to carry on from exactly there.
    expect(fake.lines()).not.toContain('M5');
  });
});

describe('the Z datum across a tool change', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('flags the datum as stale when the job stops for a new tool', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nT2 M6\nG1 X20\n');
    await advance(6);

    expect(webSerialManager.getState().status).toBe('PAUSED_TOOL');
    expect(webSerialManager.getState().needsZZero).toBe(true);
  });

  it('clears the flag once Z has been set by hand', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nT2 M6\nG1 X20\n');
    await advance(6);
    expect(webSerialManager.getState().needsZZero).toBe(true);

    const result = await webSerialManager.zeroZHere();
    expect(result.success).toBe(true);
    expect(webSerialManager.getState().needsZZero).toBe(false);
  });

  it('does not raise it for a plain material-swap stop', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nM0\nG1 X20\n');
    await advance(6);

    expect(webSerialManager.getState().status).toBe('PAUSED_MATERIAL');
    expect(webSerialManager.getState().needsZZero).toBe(false);
  });
});

describe('setting Z zero by hand', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(() => fake.detach());

  it('writes the G54 offset without moving the machine or probing', async () => {
    await webSerialManager.zeroZHere();
    expect(fake.lines()).toContain('G10 L20 P1 Z0.000');
    // No probe, and no move: `G10 L20` tells the machine where it already is.
    expect(fake.lines().some((l) => l.includes('G38.2'))).toBe(false);
    expect(fake.lines().some((l) => /^G0*[01]\s/.test(l))).toBe(false);
  });

  it('puts zero under the gauge, not on top of it', async () => {
    // A 0.1 mm feeler between the tip and the work means the work is 0.1 mm
    // below the tip, and that is where Z0 has to land.
    await webSerialManager.zeroZHere(0.1);
    expect(fake.lines()).toContain('G10 L20 P1 Z0.100');
  });

  it('zeroes all three axes at once when asked', async () => {
    await webSerialManager.zeroAllHere();
    expect(fake.lines()).toContain('G10 L20 P1 X0 Y0 Z0');
    expect(webSerialManager.getState().needsZZero).toBe(false);
  });

  it('refuses when nothing is connected, rather than pretending', async () => {
    fake.detach();
    const result = await webSerialManager.zeroZHere();
    expect(result.success).toBe(false);
  });
});

describe('reading the machine and trimming it live', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('asks the controller what it is and keeps the answer', async () => {
    const mgr = webSerialManager as unknown as { handleIncomingLine: (l: string) => void };
    // The dump arrives between the query and its `ok`, as it does on the wire.
    const original = fake.sent.length;
    const query = webSerialManager.refreshMachineSettings(2000);
    // Injected before the `ok` the fake schedules on a timer, which is the
    // order a real controller sends them in: the whole dump, then the ack.
    for (const line of ['$110=8000.000', '$120=750.000', '$122=90.000', '$30=24000']) {
      mgr.handleIncomingLine(line);
    }
    await query;

    expect(fake.sent.slice(original)).toContain('$$');
    const state = webSerialManager.getState();
    expect(state.motion.source).toBe('machine');
    expect(state.motion.accel.x).toBe(750);
    expect(state.motion.accel.z).toBe(90);
    expect(state.motion.spindle).toEqual({ min: 0, max: 24000 });
  });

  it('leaves the assumed profile alone when the controller says nothing useful', async () => {
    const before = webSerialManager.getState().motion;
    await webSerialManager.refreshMachineSettings(50);
    expect(webSerialManager.getState().motion).toEqual(before);
  });

  it('reads the override percentages off the status report rather than counting clicks', () => {
    const mgr = webSerialManager as unknown as { handleIncomingLine: (l: string) => void };
    mgr.handleIncomingLine('<Run|MPos:1.000,2.000,3.000|FS:900,12000|Ov:80,100,115>');
    expect(webSerialManager.getState().overrides).toEqual({ feed: 80, rapid: 100, spindle: 115 });
  });

  it('sends override nudges as real-time bytes, not as queued commands', async () => {
    await webSerialManager.nudgeFeedOverride(-10);
    await webSerialManager.resetFeedOverride();
    await webSerialManager.nudgeSpindleOverride(1);
    await webSerialManager.setRapidOverride(25);

    expect(fake.sent).toContain(String.fromCharCode(0x92)); // feed -10%
    expect(fake.sent).toContain(String.fromCharCode(0x90)); // feed reset
    expect(fake.sent).toContain(String.fromCharCode(0x9c)); // spindle +1%
    expect(fake.sent).toContain(String.fromCharCode(0x97)); // rapid 25%
    // None of them went out as a line the controller would have to parse.
    expect(fake.lines()).toHaveLength(0);
  });

  it('retracts relative to where the tool is at a tool change, not to an absolute Z', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nT2 M6\nG1 X20\n');
    await advance(6);

    const lines = fake.lines();
    // An absolute `G0 Z25` assumes the datum leaves 25 mm of headroom above it,
    // which on a job zeroed near the top of Z travel is a move into the limit.
    expect(lines).toContain('G91 G0 Z25.000');
    expect(lines).not.toContain('G0 Z25.000');
    // And it must come back to absolute before the park, or X0 Y0 is a nudge
    // of zero rather than a move to the origin.
    const lift = lines.indexOf('G91 G0 Z25.000');
    const backToAbsolute = lines.indexOf('G90', lift);
    expect(backToAbsolute).toBeGreaterThan(lift);
    expect(lines.indexOf('G0 X0.000 Y0.000', backToAbsolute)).toBeGreaterThan(backToAbsolute);
  });
});
