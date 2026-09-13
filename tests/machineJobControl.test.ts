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
    transport: {
      label: string;
      writeLine: (line: string) => Promise<void>;
      writeRealtime: (byte: number) => Promise<void>;
      open: () => Promise<void>;
      close: () => Promise<void>;
    } | null;
    state: Record<string, unknown>;
    handleIncomingLine: (line: string) => void;
  };

  const sent: string[] = [];
  /** Bytes written that the fake has not yet acknowledged. */
  let outstanding = 0;
  /** The high-water mark of that, which is what must never exceed the buffer. */
  const peak = { bytes: 0 };

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;

  // Stands in for a `MachineTransport`. The two write paths are kept apart
  // because that is the distinction the transport interface exists to preserve:
  // a `!` that arrived behind ten thousand buffered moves would be a pause that
  // took a minute to happen.
  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async writeRealtime(byte: number) {
      sent.push(String.fromCharCode(byte));
    },
    async writeLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      sent.push(trimmed);
      // The controller holds the whole line plus its terminator until it has
      // parsed it, which is what the streamer's byte budget is counting.
      outstanding += trimmed.length + 1;
      if (outstanding > peak.bytes) peak.bytes = outstanding;
      // Acknowledged on a timer rather than a microtask, so a test can let the
      // stream advance a little at a time instead of draining the whole job
      // the first time it yields.
      await new Promise<void>((resolve) => setTimeout(() => {
        outstanding -= trimmed.length + 1;
        mgr.handleIncomingLine('ok');
        resolve();
      }, 0));
    },
  };

  return {
    sent,
    peak,
    lines: () => sent.filter((s) => s.length > 1),
    detach() {
      mgr.transport = null;
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

/*
 * Long enough that the streamer cannot swallow it whole.
 *
 * The stream is paced by GRBL's 128-byte serial buffer, not one line at a
 * time, so a seven-line program goes out in a single burst and is finished
 * before the first `ok` lands — which leaves nothing running to pause. Two
 * hundred moves is a few thousand bytes, so the pump is always holding some
 * back and pause, resume and "did any line go twice" all mean something.
 */
const JOB = [
  'G21',
  'G90',
  'G1 X10 F600',
  ...Array.from({ length: 200 }, (_, i) => `G1 X${(i + 2) * 10}`),
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

  /*
   * The bug this guards against cost a relief carve two hours in.
   *
   * The stream used to take any `ok` that no waiter claimed as its own
   * permission to send another line. Nothing sent outside the stream — a
   * retract at a tool change, an `M5`, a laser-mode setting — registered a
   * waiter, so its `ok` was miscounted as the job's and the streamer sent one
   * line more than it had been acked for. The lead never comes back: it
   * persists for the rest of the program, and once it is wide enough the lines
   * outrun GRBL's 128-byte serial buffer, which merges two blocks into one.
   * What the operator sees is `error:24`, "two G-code commands that both
   * require the use of the XYZ axis words", reported against a program that
   * contains no such line anywhere.
   */
  it('never puts more in the buffer than GRBL can hold', async () => {
    webSerialManager.startJob(JOB);
    await advance(30);
    expect(fake.peak.bytes).toBeLessThanOrEqual(128);
  });

  it('does not take an interactive command\'s ack as the job\'s own', async () => {
    webSerialManager.startJob(JOB);
    await advance(4);

    // The kind of thing the app sends alongside a running job: a spindle stop,
    // a retract, a mode change. Each earns exactly one `ok` of its own.
    for (let i = 0; i < 8; i++) await webSerialManager.sendLine('M5');
    await advance(20);

    expect(fake.peak.bytes).toBeLessThanOrEqual(128);
    // And the program itself is still intact — no line sent twice, none lost
    // to an ack that was credited to the wrong sender.
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

  it('says what to fit and what to set, and says the Z part once', async () => {
    // The exporter's own comment for the line, as a relief carve writes it.
    webSerialManager.startJob(
      'G21\nG90\nG1 X10 F600\nT2 M6 ; fit the 3.175 mm ball nose and re-zero Z\nM3 S12000\nG1 X20\n'
    );
    await advance(6);

    const message = webSerialManager.getState().pauseMessage ?? '';
    expect(message).toBe('Tool change: fit the 3.175 mm ball nose, set the spindle to 12,000 RPM.');
    // Once, in the banner underneath — not here, and not twice here.
    expect(message.toLowerCase()).not.toContain('zero');
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

/*
 * The lift that runs when a job stops for a tool change.
 *
 * This is the move that took a relief carve into the top limit switch: a blind
 * relative lift is unbounded upwards, and a pass that ends near the top of Z
 * has nowhere to put another 25 mm. The park that follows it is a rapid across
 * the work, so a lift that alarmed instead of running leaves the next move
 * dragging the tool through the job.
 */
describe('getting clear of the work for a tool change', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  const internals = () =>
    webSerialManager as unknown as {
      state: { grblSettings: Record<number, number> };
      handleIncomingLine: (line: string) => void;
      hasHomed: boolean;
    };

  const TOOL_CHANGE_JOB = 'G21\nG90\nG1 X10 F600\nT2 M6\nG1 X20\n';

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
    // The manager is a singleton, so both of these outlive the fake board.
    internals().state.grblSettings = {};
    internals().hasHomed = false;
  });

  it('lifts in machine coordinates once the machine has been homed', async () => {
    const mgr = internals();
    mgr.state.grblSettings = { 23: 0, 132: 80 };
    // A homing cycle, as the controller reports one: `Home` while it runs, and
    // the `Idle` that follows is the moment MPos means something.
    mgr.handleIncomingLine('<Home|MPos:0.000,0.000,-40.000|FS:0,0>');
    mgr.handleIncomingLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');

    webSerialManager.startJob(TOOL_CHANGE_JOB);
    await advance(6);

    const lines = fake.lines();
    // A millimetre under the ceiling the controller itself reported, which no
    // work offset can turn into a move into the switch.
    expect(lines).toContain('G53 G0 Z-1.000');
    expect(lines.some((l) => l.startsWith('G91 G0 Z'))).toBe(false);
    const lift = lines.indexOf('G53 G0 Z-1.000');
    expect(lines.indexOf('G0 X0.000 Y0.000', lift)).toBeGreaterThan(lift);
  });

  it('trims the relative lift to the headroom left when it has not been homed', async () => {
    const mgr = internals();
    mgr.state.grblSettings = { 23: 0, 132: 80 };
    mgr.handleIncomingLine('<Idle|MPos:0.000,0.000,-5.000|FS:0,0>');

    webSerialManager.startJob(TOOL_CHANGE_JOB);
    await advance(6);

    // Five millimetres below the top, three of them kept back: 25 mm of lift
    // becomes the 2 mm that are actually there.
    expect(fake.lines()).toContain('G91 G0 Z2.000');
  });

  it('forgets that it was homed when the controller alarms', async () => {
    const mgr = internals();
    mgr.state.grblSettings = { 23: 0, 132: 80 };
    mgr.handleIncomingLine('<Home|MPos:0.000,0.000,-40.000|FS:0,0>');
    mgr.handleIncomingLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    // A hard limit: the drive is cut rather than decelerated, so the steps
    // between the trip and the stop are gone and MPos is a fiction.
    mgr.handleIncomingLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');
    mgr.handleIncomingLine('<Idle|MPos:0.000,0.000,-5.000|FS:0,0>');

    webSerialManager.startJob(TOOL_CHANGE_JOB);
    await advance(6);

    const lines = fake.lines();
    expect(lines.some((l) => l.startsWith('G53'))).toBe(false);
    expect(lines).toContain('G91 G0 Z2.000');
  });

  it('lifts back to the program\'s own clear height before carrying on', async () => {
    // The exporter writes its lift *before* the M6 and assumes the machine is
    // still up there afterwards, so the next operation's first traverse has no
    // Z word in it. Touching off a new bit leaves the tool on the work, which
    // would make that traverse a rapid across the job at the surface of it.
    const mgr = internals();
    webSerialManager.startJob('G21\nG90\nG0 Z5.000\nG1 Z-2.000 F300\nG1 X10 F600\nT2 M6\nG1 X20\n');
    await advance(8);
    expect(webSerialManager.getState().status).toBe('PAUSED_TOOL');

    const atPause = fake.sent.length;
    const resumed = webSerialManager.resumeJob();
    // Standing where the operator touched off: on the work, two millimetres
    // below the datum the program was cut against.
    mgr.handleIncomingLine('<Idle|MPos:0.000,0.000,-2.000|FS:0,0>');
    await resumed;

    const after = fake.sent.slice(atPause);
    const lift = after.indexOf('G0 Z5.000');
    expect(lift).toBeGreaterThanOrEqual(0);
    // And before the cycle start that lets the rest of the program go.
    expect(after.indexOf(String.fromCharCode(0x7e))).toBeGreaterThan(lift);
  });

  it('leaves a feed hold alone — the tool is still in the cut', async () => {
    webSerialManager.startJob('G21\nG90\nG0 Z5.000\nG1 Z-2.000 F300\n' +
      Array.from({ length: 200 }, (_, i) => `G1 X${(i + 1) * 10} F600`).join('\n') + '\n');
    await settle();
    await webSerialManager.pauseJob();

    const atPause = fake.sent.length;
    await webSerialManager.resumeJob();

    // Nothing but the cycle start: a retract here would lift out of a cut the
    // machine is about to carry straight on with.
    expect(fake.sent.slice(atPause).filter((l) => l.length > 1)).toHaveLength(0);
  });

  it('falls back to the full relative lift when the controller says nothing about travel', async () => {
    // No `$23`: nothing is known about which end of Z home is, so nothing can
    // be worked out about headroom either, and the lift is what it always was.
    webSerialManager.startJob(TOOL_CHANGE_JOB);
    await advance(6);

    expect(fake.lines()).toContain('G91 G0 Z25.000');
  });
});
