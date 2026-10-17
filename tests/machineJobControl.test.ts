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
    parseLine: (line: string) => void;
    lastWco: { x: number; y: number; z: number } | undefined;
  };

  const sent: string[] = [];
  /**
   * What the board answers a `?` with. A tool-change pause asks where the tool
   * is once the buffer has drained, and a board that never answered would make
   * every one of those wait out its timeout.
   */
  const board = { report: '<Idle|MPos:0.000,0.000,0.000|FS:0,0>' as string | null };
  /** Bytes written that the fake has not yet acknowledged. */
  let outstanding = 0;
  /** The high-water mark of that, which is what must never exceed the buffer. */
  const peak = { bytes: 0 };

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  // As a fresh connection leaves it. A real board follows a G10 with a `WCO:`
  // in its next report; this one never sends one, so an earlier test's zero
  // would otherwise leave work Z pinned where it was.
  mgr.lastWco = { x: 0, y: 0, z: 0 };
  mgr.state.workOffset = undefined;

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
      // A soft reset: the board reboots and says so, and the manager waits for that.
      if (byte === 0x18) setTimeout(() => mgr.parseLine("Grbl 1.1h ['$' for help]"), 0);
      if (byte === 0x3f && board.report) {
        const report = board.report;
        setTimeout(() => mgr.parseLine(report), 0);
      }
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
        mgr.parseLine('ok');
        resolve();
      }, 0));
    },
  };

  return {
    sent,
    peak,
    board,
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

    expect(webSerialManager.getState().status).toBe('PAUSED_OPERATOR');
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
    // Lines sent, not `currentLine`: that is the line being cut, which only a
    // status report moves, and this board sends none.
    const sentAtPause = fake.lines().length;

    await webSerialManager.resumeJob();
    await advance(8);

    expect(fake.sent).toContain('~');
    expect(fake.lines().length).toBeGreaterThan(sentAtPause);
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

  it('ends the job on an E-Stop, so a later Resume sends nothing', async () => {
    webSerialManager.startJob(JOB);
    await settle();
    await webSerialManager.pauseJob();
    await webSerialManager.eStop();
    const afterStop = fake.lines().length;

    await webSerialManager.resumeJob();
    await advance(4);
    expect(fake.lines().length).toBe(afterStop);
  });

  // What the "Job Succeeded" modal shows from, and the only thing it shows from.
  it('records a job that ran to its last line as completed', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nM30', 90);
    await advance(10);
    const state = webSerialManager.getState();
    expect(state.status).toBe('IDLE');
    expect(state.lastCompletedJob).toMatchObject({ totalLines: 4, estimatedSeconds: 90 });
  });

  it('does not record a stopped job as completed, and forgets the last one on a new start', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nM30');
    await advance(10);
    expect(webSerialManager.getState().lastCompletedJob).not.toBeNull();

    webSerialManager.startJob(JOB);
    expect(webSerialManager.getState().lastCompletedJob).toBeNull();
    await settle();
    await webSerialManager.eStop();
    await advance(4);
    expect(webSerialManager.getState().lastCompletedJob).toBeNull();
  });

  it('will not pause a machine that is not running a job', async () => {
    await webSerialManager.pauseJob();
    expect(fake.sent).not.toContain('!');
    expect(webSerialManager.getState().status).not.toBe('PAUSED_OPERATOR');
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

  it('keeps the flag through an alarm unlock, which says nothing about Z', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nT2 M6\nG1 X20\n');
    await advance(6);
    expect(webSerialManager.getState().needsZZero).toBe(true);

    await webSerialManager.unlockAlarm();
    expect(webSerialManager.getState().needsZZero).toBe(true);
  });

  it('refuses to resume past a tool change until Z is set, from any button', async () => {
    webSerialManager.startJob('G21\nG90\nG1 X10 F600\nT2 M6\nG1 X20\n');
    await advance(6);
    const before = fake.lines().length;

    await expect(webSerialManager.resumeJob()).rejects.toThrow(/Z zero/);
    expect(webSerialManager.getState().status).toBe('PAUSED_TOOL');
    expect(fake.lines().length).toBe(before);

    // The banner's "Z is already set" override still gets through.
    await webSerialManager.resumeJob({ zIsSet: true });
    expect(webSerialManager.getState().status).toBe('RUNNING');
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
    // Standing clear of the stock, so the prompt is the whole message.
    fake.board.report = '<Idle|MPos:0.000,0.000,5.000|FS:0,0>';
    // The exporter's own comment for the line, as a relief carve writes it.
    webSerialManager.startJob(
      'G21\nG90\nG1 X10 F600\nT2 M6 ; fit the 3.175 mm ball nose and re-zero Z\nM3 S12000\nG1 X20\n'
    );
    await advance(12);

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

  it('does not lift Z at a sheet swap in a program that never moves Z', async () => {
    // A laser job: nothing on resume would bring a lift back down.
    webSerialManager.startJob('G21\nG90\nM4 S500\nG1 X10 F600\nM5\nM0\nM4 S500\nG1 X20\n');
    await advance(8);

    expect(webSerialManager.getState().status).toBe('PAUSED_MATERIAL');
    expect(fake.lines().some((l) => /Z/.test(l))).toBe(false);
  });

  it('still lifts clear at a sheet swap in a program that cuts in Z', async () => {
    const mgr = webSerialManager as unknown as { parseLine: (l: string) => void };
    webSerialManager.startJob('G21\nG90\nG0 Z5\nG1 Z-1 F300\nG1 X10 F600\nM0\nG1 X20\n');
    // Seen at the program's clear height on the way in, then down in the cut.
    mgr.parseLine('<Run|MPos:0.000,0.000,5.000|FS:0,0>');
    fake.board.report = '<Idle|MPos:10.000,0.000,-1.000|FS:0,0>';
    await advance(12);

    expect(webSerialManager.getState().status).toBe('PAUSED_MATERIAL');
    expect(fake.lines()).toContain('G90 G0 Z5.000');
  });
});

describe('framing a job', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;
  beforeEach(() => { fake = attachFakeGrbl(); });
  afterEach(() => fake.detach());

  it('does not light a spindle for a default-power frame on a machine not in laser mode', async () => {
    (webSerialManager as unknown as { state: { grblSettings: Record<number, number> } }).state.grblSettings = { 32: 0 };
    await webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 10, maxY: 10 });

    expect(fake.lines().some((l) => l.startsWith('M3'))).toBe(false);
    expect(fake.lines().some((l) => /^G0 Z/.test(l))).toBe(true);
  });

  it('refuses to frame on a router whose Z zero has not been set this session', async () => {
    (webSerialManager as unknown as { state: { needsZZero: boolean } }).state.needsZZero = true;
    await expect(
      webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, { laserMode: false })
    ).rejects.toThrow(/Z zero/);
    expect(fake.lines()).toEqual([]);
  });

  it('lights the lap at the guide percentage of $30 and puts the beam out with S0', async () => {
    const state = (webSerialManager as unknown as { state: { grblSettings: Record<number, number> } }).state;
    state.grblSettings = { 30: 10000, 32: 1 };
    await webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 5, { laserMode: true });

    // 5% of 10000, not a raw S5 (0.05% duty).
    expect(fake.lines()).toContain('M3 S500');
    expect(fake.lines()).toContain('M5 S0');
  });

  it('puts no F word on a rapid, which would overwrite the modal feed', async () => {
    (webSerialManager as unknown as { state: { grblSettings: Record<number, number> } }).state.grblSettings = { 32: 0 };
    await webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, { laserMode: false });
    await webSerialManager.gotoWorkOrigin();

    const rapids = fake.lines().filter((l) => /\bG0\b/.test(l));
    expect(rapids.length).toBeGreaterThan(4);
    expect(rapids.filter((l) => /F/.test(l))).toEqual([]);
  });
});

describe('knowing whether the machine has homed', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;
  beforeEach(() => { fake = attachFakeGrbl(); });
  afterEach(() => fake.detach());

  it('is set by a homing cycle finishing and cleared by an alarm', () => {
    const mgr = webSerialManager as unknown as { parseLine: (l: string) => void; state: { hasHomed: boolean } };
    mgr.state.hasHomed = false;
    mgr.parseLine('<Home|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(webSerialManager.getState().hasHomed).toBe(false);
    mgr.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(webSerialManager.getState().hasHomed).toBe(true);
    mgr.parseLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(webSerialManager.getState().hasHomed).toBe(false);
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
    const mgr = webSerialManager as unknown as { parseLine: (l: string) => void };
    // The dump arrives between the query and its `ok`, as it does on the wire.
    const original = fake.sent.length;
    const query = webSerialManager.refreshMachineSettings(2000);
    // Injected before the `ok` the fake schedules on a timer, which is the
    // order a real controller sends them in: the whole dump, then the ack.
    for (const line of ['$110=8000.000', '$120=750.000', '$122=90.000', '$30=24000']) {
      mgr.parseLine(line);
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
    const mgr = webSerialManager as unknown as { parseLine: (l: string) => void };
    mgr.parseLine('<Run|MPos:1.000,2.000,3.000|FS:900,12000|Ov:80,100,115>');
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
      state: { grblSettings: Record<number, number>; hasHomed: boolean };
      parseLine: (line: string) => void;
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
    internals().state.hasHomed = false;
  });

  it('lifts in machine coordinates, under the pull-off point, once homed', async () => {
    const mgr = internals();
    mgr.state.grblSettings = { 23: 0, 132: 80, 27: 2 };
    // A homing cycle, as the controller reports one: `Home` while it runs, and
    // the `Idle` that follows is the moment MPos means something.
    mgr.parseLine('<Home|MPos:0.000,0.000,-40.000|FS:0,0>');
    mgr.parseLine('<Idle|MPos:0.000,0.000,-2.000|FS:0,0>');

    webSerialManager.startJob(TOOL_CHANGE_JOB);
    await advance(12);

    const lines = fake.lines();
    // Homing leaves the tool at -$27, only just off the switch; a millimetre
    // below that, not a millimetre below the switch itself.
    expect(lines).toContain('G53 G0 Z-3.000');
    expect(lines.some((l) => l.startsWith('G91 G0 Z'))).toBe(false);
    const lift = lines.indexOf('G53 G0 Z-3.000');
    expect(lines.indexOf('G0 X0.000 Y0.000', lift)).toBeGreaterThan(lift);
  });

  /*
   * The giraffe carve. The program retracts to Z20 before its M6, and the pump
   * reaches the M6 while a quarter of a minute of cutting is still in GRBL's
   * buffer. The lift used to be sized from where the tool was then - down in
   * the cut - and added on top of the Z20 retract, into the limit switch.
   */
  it('waits for the buffered moves to run before lifting, and lifts no higher than the job has been', async () => {
    const mgr = internals();
    mgr.state.grblSettings = { 23: 0, 132: 80 };
    webSerialManager.startJob(
      'G21\nG90\nG0 Z5.000\nG1 Z-3.500 F300\nG1 X10 F600\nG0 Z20.000\nT2 M6 ; fit the ball nose\nG1 X20\n'
    );
    // The pump stops at the M6 with the tool still in the cut.
    mgr.parseLine('<Run|MPos:5.000,0.000,-3.500|FS:600,10000>');
    // By the time the dwell is acked, the retract has run.
    fake.board.report = '<Idle|MPos:10.000,0.000,20.000|FS:0,0>';
    await advance(12);

    const lines = fake.lines();
    // The dwell goes out first and the pause is announced once it is acked;
    // the spindle stops after it, which on GRBL is the same moment (M5 waits
    // for the planner to empty anyway).
    const drain = lines.indexOf('G4 P0');
    const m5 = lines.indexOf('M5');
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(m5).toBeGreaterThan(drain);
    // Already at the highest height the job has reached: nothing more to ask.
    expect(lines.some((l) => /^G91 G0 Z/.test(l))).toBe(false);
    expect(lines.some((l) => /G0 Z(2[1-9]|[3-9]\d)/.test(l))).toBe(false);
    expect(lines.indexOf('G0 X0.000 Y0.000')).toBeGreaterThan(drain);
    expect(webSerialManager.getState().pauseMessage).toBe('Tool change: fit the ball nose.');
  });

  it('lifts back up to the highest height the job has been seen at', async () => {
    const mgr = internals();
    webSerialManager.startJob(TOOL_CHANGE_JOB);
    mgr.parseLine('<Run|MPos:0.000,0.000,12.000|FS:0,0>');
    fake.board.report = '<Idle|MPos:10.000,0.000,1.000|FS:0,0>';
    await advance(12);

    const lines = fake.lines();
    expect(lines).toContain('G90 G0 Z12.000');
    expect(lines.indexOf('G0 X0.000 Y0.000')).toBeGreaterThan(lines.indexOf('G90 G0 Z12.000'));
  });

  it('forgets that it was homed when the controller alarms', async () => {
    const mgr = internals();
    mgr.state.grblSettings = { 23: 0, 132: 80 };
    mgr.parseLine('<Home|MPos:0.000,0.000,-40.000|FS:0,0>');
    mgr.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    // A hard limit: the drive is cut rather than decelerated, so the steps
    // between the trip and the stop are gone and MPos is a fiction.
    mgr.parseLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');
    mgr.parseLine('<Idle|MPos:0.000,0.000,-5.000|FS:0,0>');

    webSerialManager.startJob(TOOL_CHANGE_JOB);
    mgr.parseLine('<Run|MPos:0.000,0.000,8.000|FS:0,0>');
    fake.board.report = '<Idle|MPos:10.000,0.000,2.000|FS:0,0>';
    await advance(12);

    const lines = fake.lines();
    expect(lines.some((l) => l.startsWith('G53'))).toBe(false);
    expect(lines).toContain('G90 G0 Z8.000');
  });

  it('does not park across the work when the job has never been above the stock', async () => {
    // Nothing here says the tool is clear of anything, so the rapid to X0 Y0
    // would be a rapid through the job. It stays put and says so.
    webSerialManager.startJob(TOOL_CHANGE_JOB);
    await advance(12);

    const lines = fake.lines();
    expect(lines).not.toContain('G0 X0.000 Y0.000');
    expect(lines.some((l) => /^G91 G0 Z/.test(l))).toBe(false);
    expect(webSerialManager.getState().pauseMessage).toMatch(/jog it clear/);
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
    // Resumed as after touching off: the datum has been dealt with.
    const resumed = webSerialManager.resumeJob({ zIsSet: true });
    // Standing where the operator touched off: on the work, two millimetres
    // below the datum the program was cut against.
    mgr.parseLine('<Idle|MPos:0.000,0.000,-2.000|FS:0,0>');
    await resumed;
    await advance(4);

    const after = fake.sent.slice(atPause);
    const lift = after.indexOf('G0 Z5.000');
    expect(lift).toBeGreaterThanOrEqual(0);
    // And before the rest of the program goes.
    expect(after.indexOf('G1 X20')).toBeGreaterThan(lift);
  });

  /** Pauses `program` at its stop, resumes it, and returns what was sent from the resume on. */
  async function pauseAndResume(program: string, status: 'PAUSED_TOOL' | 'PAUSED_MATERIAL') {
    webSerialManager.startJob(program);
    await advance(12);
    expect(webSerialManager.getState().status).toBe(status);
    const atPause = fake.sent.length;
    await webSerialManager.resumeJob({ zIsSet: true });
    await advance(12);
    return fake.sent.slice(atPause);
  }

  it('puts the spindle back on, and the tool back over and into the cut, after a stop', async () => {
    // An M0 in the middle of a cut, with no M5 before it and no M3 after: the
    // pause turned the spindle off, and the next line is a cut at depth.
    const after = await pauseAndResume(
      'G21\nG90\nG0 Z5.000\nM3 S12000\nG1 Z-2.000 F300\nG1 X10 F600\nM0\nG1 X20\n',
      'PAUSED_MATERIAL'
    );
    const at = (l: string) => after.indexOf(l);
    // The program's own next line. No `~` here: the machine drained and went
    // idle at the stop, so there is no hold to release.
    const go = at('G1 X20');
    expect(at('G0 Z5.000')).toBeGreaterThanOrEqual(0);
    expect(at('M3 S12000')).toBeGreaterThan(at('G0 Z5.000'));
    expect(at('G4 P2')).toBeGreaterThan(at('M3 S12000'));
    expect(at('G0 X10.000 Y0.000')).toBeGreaterThan(at('G0 Z5.000'));
    expect(at('G1 Z-2.000 F300')).toBeGreaterThan(at('G0 X10.000 Y0.000'));
    expect(at('F600')).toBeGreaterThan(at('G1 Z-2.000 F300'));
    expect(go).toBeGreaterThan(at('F600'));
  });

  it('restores inches and incremental mode, which touching off had replaced', async () => {
    const after = await pauseAndResume(
      'G20\nG90\nG0 Z0.200\nG1 Z-0.050 F10\nG1 X1 F20\nG91\nM0\nG1 X1\n',
      'PAUSED_MATERIAL'
    );
    const go = after.indexOf('G1 X1');
    expect(go).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('G20')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('G20')).toBeLessThan(after.indexOf('G0 Z0.200'));
    // Absolute for the moves back, incremental again for the program's own.
    expect(after.indexOf('G91')).toBeGreaterThan(after.indexOf('G0 X1.000 Y0.000'));
    expect(after.indexOf('G91')).toBeLessThan(go);
  });

  it('spins the new bit at its own speed, not the one it replaced', async () => {
    const after = await pauseAndResume(
      'G21\nG90\nG0 Z5.000\nM3 S18000\nG1 Z-2.000 F300\nG1 X10 F600\nG0 Z20.000\nT2 M6\nM3 S16000\nG1 X30\n',
      'PAUSED_TOOL'
    );
    const go = after.indexOf('G1 X30');
    expect(go).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('M3 S16000')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('M3 S16000')).toBeLessThan(go);
    expect(after).not.toContain('M3 S18000');
  });

  it('waits for every restoring line to be taken before streaming the rest', async () => {
    await pauseAndResume(
      'G21\nG90\nG0 Z5.000\nM3 S12000\nG1 Z-2.000 F300\nG1 X10 F600\nM0\n' +
        Array.from({ length: 100 }, (_, i) => `G1 X${(i + 2) * 10}`).join('\n') + '\n',
      'PAUSED_MATERIAL'
    );
    expect(fake.peak.bytes).toBeLessThanOrEqual(128);
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
});

/*
 * An alarm at a tool change, as the giraffe carve had one: the lift tripped
 * the top switch after every roughing move had been cut. The offer has to land
 * on the M6 rather than 64 lines back into the roughing path, say what was
 * being asked for, and outlive the unlock and a power cycle.
 */
describe('a job that alarms while stopped for a tool change', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;
  const mgr = () =>
    webSerialManager as unknown as {
      parseLine: (l: string) => void;
      jobContext: { name?: string };
    };

  // Line 6 (0-based) is the M6.
  const PROGRAM = [
    'G21', 'G90', 'G0 Z5.000', 'G1 Z-2.000 F300',
    ...Array.from({ length: 2 }, (_, i) => `G1 X${(i + 1) * 10} F600`),
    'T2 M6 ; fit the 1.5875 mm ball nose',
    'M3 S16000',
    'G0 Z20.000',
    'G1 X30 F600',
  ].join('\n');

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    webSerialManager.clearResumePoint();
    fake.detach();
  });

  async function alarmAtToolChange() {
    webSerialManager.startJob(PROGRAM);
    mgr().parseLine('<Run|MPos:0.000,0.000,5.000|FS:0,0>');
    fake.board.report = '<Idle|MPos:20.000,0.000,5.000|FS:0,0>';
    await advance(12);
    expect(webSerialManager.getState().status).toBe('PAUSED_TOOL');
    mgr().parseLine('<Alarm|MPos:20.000,0.000,26.000|FS:0,0>');
  }

  it('offers the tool change line itself, and says what it was waiting for', async () => {
    await alarmAtToolChange();
    const resume = webSerialManager.getState().resume;
    expect(resume?.reason).toBe('alarm');
    expect(resume?.fromLine).toBe(6);
    expect(resume?.pendingPause).toEqual({
      kind: 'tool-change',
      message: 'Tool change: fit the 1.5875 mm ball nose, set the spindle to 16,000 RPM.',
    });
  });

  it('keeps the offer through an unlock, a disconnect and a reconnect', async () => {
    await alarmAtToolChange();
    const before = webSerialManager.getState().resume;

    await webSerialManager.unlockAlarm();
    expect(webSerialManager.getState().resume).toEqual(before);

    await webSerialManager.disconnect();
    expect(webSerialManager.getState().resume).toEqual(before);
  });

  it('does not stop for the same tool change again once Z has been zeroed', async () => {
    await alarmAtToolChange();
    await webSerialManager.unlockAlarm();
    await webSerialManager.zeroZHere();
    const sentBefore = fake.lines().length;

    const res = webSerialManager.resumeFromLine(6);
    expect(res.ok).toBe(true);
    // The preamble alone is ten lines, and this board takes a tick to answer each.
    await advance(24);

    const after = fake.lines().slice(sentBefore);
    expect(after.some((l) => /M6/.test(l))).toBe(false);
    expect(after).toContain('G1 X30 F600');
    expect(webSerialManager.getState().status).not.toBe('PAUSED_TOOL');
  });

  it('does not wind back past the line a resumed run started from', async () => {
    const long = ['G21', 'G90', 'G0 Z5.000', 'G1 Z-1.000 F300',
      ...Array.from({ length: 200 }, (_, i) => `G1 X${(i + 1) * 10} F600`)].join('\n');
    webSerialManager.startJob(long);
    await advance(20);
    mgr().parseLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');
    await webSerialManager.unlockAlarm();

    // Resumed from line 150, and alarmed again a few lines in.
    expect(webSerialManager.resumeFromLine(150).ok).toBe(true);
    await advance(3);
    mgr().parseLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');

    expect(webSerialManager.getState().resume!.fromLine).toBeGreaterThanOrEqual(150);
  });

  it('still winds back an alarm that lands mid-stream, where the buffer had not run', async () => {
    const long = ['G21', 'G90', 'G0 Z5.000', 'G1 Z-1.000 F300',
      ...Array.from({ length: 200 }, (_, i) => `G1 X${(i + 1) * 10} F600`)].join('\n');
    webSerialManager.startJob(long);
    await advance(20);
    // The line last sent, which is what the rewind is measured back from.
    const reached = fake.lines().length;
    mgr().parseLine('<Alarm|MPos:0.000,0.000,0.000|FS:0,0>');

    const resume = webSerialManager.getState().resume;
    expect(resume?.pendingPause).toBeUndefined();
    expect(resume!.fromLine).toBeLessThan(reached);
  });
});

/*
 * A park lets go of the stream (it is neither running nor feed-held any more),
 * and the status poll used to read that as an idle machine: the first `Idle`
 * report, a third of a second later, replaced PAUSED_PARKED with IDLE. The
 * resume button went with it, and `resumeFromPark` refused, because it asks for
 * exactly that status. The job could only be started again from the top.
 */
describe('a parked job', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake = attachFakeGrbl();
  });
  afterEach(async () => {
    webSerialManager.discardPark();
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('stays parked through the idle reports that follow, and resumes', async () => {
    webSerialManager.startJob(JOB);
    await advance(3);
    fake.board.report = '<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>';
    expect(await webSerialManager.parkJob({ isLaser: true })).toBe(true);
    expect(webSerialManager.getState().status).toBe('PAUSED_PARKED');

    fake.board.report = '<Idle|MPos:0.000,0.000,0.000|FS:0,0>';
    const mgr = webSerialManager as unknown as { parseLine: (l: string) => void };
    mgr.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(webSerialManager.getState().status).toBe('PAUSED_PARKED');

    expect(await webSerialManager.resumeFromPark({ isLaser: true })).toBe(true);
    expect(webSerialManager.getState().status).toBe('RUNNING');
  });
});
