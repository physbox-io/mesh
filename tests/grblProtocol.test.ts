import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webSerialManager } from '../src/utils/webSerialManager';

/**
 * A GRBL board that keeps to the parts of the protocol the other fakes skip:
 *
 * - a soft reset (`0x18`) empties its receive buffer and prints the welcome
 *   line a moment later, and anything written before that is lost unanswered;
 * - a probe that runs out of travel raises ALARM:5, and an alarmed board
 *   refuses G-code (error:9) until `$X`;
 * - a `$` setting is refused (error:8) unless the board is idle;
 * - its serial buffer is 128 bytes, and what does not fit is dropped.
 *
 * Replies are on a timer, as from a real read loop.
 */
function attachBoard() {
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
    ackQueue: unknown[];
    guideSpotRestoreLaserMode: boolean;
  };

  const board = {
    booting: false,
    alarm: false,
    /** Lines that have arrived and not yet been answered: the board is busy with them. */
    running: 0,
    report: '<Idle|MPos:0.000,0.000,0.000|FS:0,0>',
    /** Answers a line; `null` lets the default ok stand. */
    answer: null as null | ((line: string) => string[] | null),
  };
  const sent: string[] = [];
  const lost: string[] = [];
  let rxBytes = 0;
  const peak = { rxBytes: 0 };
  const reply = (line: string) => setTimeout(() => mgr.handleIncomingLine(line), 0);

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.guideSpot = false;
  mgr.state.probeCircuitSeen = true;
  mgr.state.probePinActive = false;
  // A singleton: a $32=1 restored by one test would make the next a laser.
  mgr.state.grblSettings = {};
  mgr.guideSpotRestoreLaserMode = false;
  mgr.ackQueue = [];

  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async writeRealtime(byte: number) {
      sent.push(String.fromCharCode(byte));
      if (byte === 0x18) {
        board.booting = true;
        rxBytes = 0;
        setTimeout(() => {
          board.booting = false;
          mgr.handleIncomingLine("Grbl 1.1h ['$' for help]");
        }, 5);
      } else if (byte === 0x3f && !board.booting) {
        reply(board.report);
      }
    },
    async writeLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (board.booting) {
        lost.push(trimmed);
        return;
      }
      sent.push(trimmed);
      rxBytes += trimmed.length + 1;
      peak.rxBytes = Math.max(peak.rxBytes, rxBytes);
      board.running++;
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          rxBytes -= trimmed.length + 1;
          board.running--;
          const custom = board.answer?.(trimmed);
          if (custom) {
            custom.forEach((l) => mgr.handleIncomingLine(l));
          } else if (trimmed === '$X') {
            board.alarm = false;
            mgr.handleIncomingLine('ok');
          } else if (board.alarm) {
            mgr.handleIncomingLine('error:9');
          } else if (trimmed.startsWith('$32=') && board.running > 0) {
            mgr.handleIncomingLine('error:8');
          } else {
            mgr.handleIncomingLine('ok');
          }
          resolve();
        }, 0)
      );
    },
  };

  return {
    mgr,
    board,
    sent,
    lost,
    peak,
    lines: () => sent.filter((s) => s.length > 1),
    detach() {
      mgr.transport = null;
      mgr.state.connected = false;
      mgr.state.status = 'DISCONNECTED';
      mgr.guideSpotRestoreLaserMode = false;
    },
  };
}

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const JOB = ['G21', 'G90', 'G1 X10 F600', ...Array.from({ length: 50 }, (_, i) => `G1 X${(i + 2) * 10}`), 'M30'].join('\n');

/** The same, cut in Z: a router job, which a park lifts out of. */
const ROUTER_JOB = ['G21', 'G90', 'G0 Z5', 'G1 Z-2 F300', ...JOB.split('\n').slice(2)].join('\n');

let fake: ReturnType<typeof attachBoard>;
beforeEach(() => {
  fake = attachBoard();
});
afterEach(async () => {
  await webSerialManager.cancelJob();
  await wait(20);
  fake.detach();
});

describe('soft reset', () => {
  it('sends nothing behind the reset until the controller is back up', async () => {
    fake.mgr.guideSpotRestoreLaserMode = true;
    await webSerialManager.eStop();

    // The borrowed laser mode is put back, after the welcome line, and answered.
    expect(fake.lost).toEqual([]);
    expect(fake.lines()).toContain('$32=1');
    expect(fake.lines()).not.toContain('M5');
    await wait(5);
    expect(fake.mgr.ackQueue).toHaveLength(0);
  });

  it('parks only once the controller has rebooted, and owes no acks after', async () => {
    webSerialManager.startJob(ROUTER_JOB);
    await wait();
    fake.board.report = '<Hold:0|MPos:5.000,0.000,-2.000|FS:0,0>';
    const parked = await webSerialManager.parkJob();
    expect(parked).toBe(true);
    expect(fake.lost).toEqual([]);

    const afterReset = fake.lines().slice(fake.lines().lastIndexOf('G21 G90'));
    expect(afterReset[0]).toBe('G21 G90');
    expect(afterReset[1]).toMatch(/^G0 Z/);
    await wait(5);
    expect(fake.mgr.ackQueue).toHaveLength(0);
  });

  it('leaves a laser at its focus height when parking, and when resuming the park', async () => {
    // A focus move, so the program alone would pass for a router's.
    webSerialManager.startJob(['G21', 'G90', 'G0 Z0', 'M4 S800', ...JOB.split('\n').slice(2)].join('\n'));
    await wait();
    fake.board.report = '<Hold:0|MPos:25.000,0.000,0.000|FS:0,0>';
    expect(await webSerialManager.parkJob({ isLaser: true })).toBe(true);
    const parkedAt = fake.lines().length;
    expect(fake.lines().slice(fake.lines().lastIndexOf('G21 G90'))).toEqual(['G21 G90']);

    fake.board.report = '<Idle|MPos:25.000,0.000,0.000|FS:0,0>';
    expect(await webSerialManager.resumeFromPark({ isLaser: true })).toBe(true);
    for (let i = 0; i < 10; i++) await wait();
    const resumed = fake.lines().slice(parkedAt);
    // The program's own focus move may be replayed; nothing else moves Z.
    expect(resumed.filter((l) => /\bZ-?\d/.test(l) && l !== 'G0 Z0')).toEqual([]);
    expect(resumed).not.toContain('G4 P2');
  });

  it('stops a job the controller restarted underneath, rather than waiting on it', async () => {
    webSerialManager.startJob(JOB);
    await wait();
    fake.mgr.handleIncomingLine("Grbl 1.1h ['$' for help]");

    expect(webSerialManager.isRunning()).toBe(false);
    expect(webSerialManager.getState().lastError).toMatch(/restarted/);
    expect(webSerialManager.getState().resume).not.toBeNull();
    expect(fake.mgr.ackQueue).toHaveLength(0);
  });
});

describe('the guide spot and a starting job', () => {
  it('puts the beam out, and laser mode back, before the first line of the job', async () => {
    fake.mgr.state.guideSpot = true;
    fake.mgr.guideSpotRestoreLaserMode = true;

    webSerialManager.startJob(JOB);
    for (let i = 0; i < 40; i++) await wait();

    const lines = fake.lines();
    const firstJobLine = lines.indexOf('G1 X10 F600');
    expect(firstJobLine).toBeGreaterThan(-1);
    expect(lines.indexOf('M5')).toBeLessThan(firstJobLine);
    expect(lines.indexOf('S0')).toBeLessThan(firstJobLine);
    expect(lines.indexOf('$32=1')).toBeGreaterThan(-1);
    expect(lines.indexOf('$32=1')).toBeLessThan(lines.indexOf('G21'));
    // Refused, it used to abort the job it had just started.
    expect(webSerialManager.getState().lastError).toBeUndefined();
    expect(webSerialManager.getState().resume).toBeNull();
  });

  it('does not stream a job cancelled while the beam was going out', async () => {
    fake.mgr.state.guideSpot = true;
    webSerialManager.startJob(JOB);
    await webSerialManager.cancelJob();
    for (let i = 0; i < 20; i++) await wait();

    expect(fake.lines()).not.toContain('G1 X10 F600');
  });
});

describe('a probe that runs out of travel', () => {
  beforeEach(() => {
    fake.board.answer = (line) => {
      if (!line.includes('G38.2')) return null;
      fake.board.alarm = true;
      return ['ALARM:5', '[PRB:0.000,0.000,-10.000:0]', 'ok'];
    };
  });

  it('reports the alarm, and sends nothing an alarmed controller would refuse', async () => {
    const z = await webSerialManager.probePoint(10, 50, 2000);

    expect(z).toBeNull();
    expect(fake.lines()).not.toContain('G90');
    expect(webSerialManager.getState().lastError).toMatch(/Probe failed/);
  });

  it('puts absolute millimetres back on unlock, since the alarm struck in G91', async () => {
    await webSerialManager.probePoint(10, 50, 2000);
    await webSerialManager.unlockAlarm();

    const lines = fake.lines();
    expect(lines.slice(lines.indexOf('$X'))).toEqual(['$X', 'G90 G21']);
    expect(webSerialManager.getState().lastError).toBeUndefined();
  });

  it('still restores G90 after a probe that touched', async () => {
    fake.board.answer = (line) =>
      line.includes('G38.2') ? ['[PRB:0.000,0.000,-3.000:1]', 'ok'] : null;
    const z = await webSerialManager.probePoint(10, 50, 2000);

    expect(z).toBe(-3);
    expect(fake.lines()).toContain('G90');
  });
});

describe('jogging', () => {
  it('keeps one jog on the wire, and travels every click', async () => {
    const clicks = Array.from({ length: 15 }, () => webSerialManager.jog({ x: 10 }, 1000));
    await Promise.all(clicks);
    for (let i = 0; i < 10; i++) await wait();

    const jogs = fake.lines().filter((l) => l.startsWith('$J='));
    // The first click, then everything clicked while it waited, as one move.
    expect(jogs).toEqual(['$J=G91 G21 X10.000 F1000', '$J=G91 G21 X140.000 F1000']);
    expect(fake.peak.rxBytes).toBeLessThanOrEqual(128);
  });

  it('drops clicks still queued when the jog is cancelled', async () => {
    void webSerialManager.jog({ y: 5 });
    void webSerialManager.jog({ y: 5 });
    await webSerialManager.jogCancel();
    for (let i = 0; i < 10; i++) await wait();

    expect(fake.lines().filter((l) => l.startsWith('$J='))).toEqual(['$J=G91 G21 Y5.000 F1000']);
  });
});
