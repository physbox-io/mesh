import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * The checks a program meets before it moves anything, on the paths that used
 * to slip past them: a job handed to a Tekno Box, a framing lap, and a program
 * exported for a faster spindle than the one on the cable. And what parking
 * leaves behind when it cannot finish cleanly.
 */

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  syncCloudParameters: vi.fn().mockResolvedValue(undefined),
}));

const { webSerialManager } = await import('../src/utils/webSerialManager');
const { writeSpindleMaxOverride } = await import('../src/utils/spindleOverride');

type Transport = {
  label: string;
  open: () => Promise<void>;
  close: () => Promise<void>;
  writeRealtime: (b: number) => Promise<void>;
  writeLine: (l: string) => Promise<void>;
  runJob?: (gcode: string, options: unknown) => Promise<{ delivered: boolean; message: string }>;
};
const mgr = webSerialManager as unknown as {
  transport: Transport | null;
  state: Record<string, unknown>;
  parseLine: (line: string) => void;
  lastWco: { x: number; y: number; z: number } | undefined;
  grblSettings: Map<number, number>;
  machineKey: string | null;
  handleTransportDisconnect: (err?: Error) => void;
  starting: boolean;
};

const store = new Map<string, string>();
let sent: string[] = [];
let realtime: number[] = [];
/** What a status poll answers. */
let report = '<Idle|MPos:0,0,0|FS:0,0>';

function attach(extra: Partial<Transport> = {}) {
  sent = [];
  realtime = [];
  report = '<Idle|MPos:0,0,0|FS:0,0>';
  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.grblSettings = {};
  mgr.state.park = null;
  mgr.state.resume = null;
  mgr.machineKey = null;
  mgr.lastWco = { x: 0, y: 0, z: 0 };
  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async writeRealtime(b: number) {
      realtime.push(b);
      if (b === 0x3f) setTimeout(() => mgr.parseLine(report), 0);
      if (b === 0x18) setTimeout(() => mgr.parseLine("Grbl 1.1h ['$' for help]"), 2);
    },
    async writeLine(line: string) {
      if (!line.trim()) return;
      sent.push(line.trim());
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          mgr.parseLine('ok');
          resolve();
        }, 0)
      );
    },
    ...extra,
  };
}

/** A homed machine with 150 x 150 x 60 of travel, its work origin at X100. */
function limitTravel() {
  for (const [k, v] of [[20, 0], [23, 3], [27, 1], [130, 150], [131, 150], [132, 60]]) {
    mgr.grblSettings.set(k, v);
  }
  mgr.parseLine('<Home|MPos:0,0,0>');
  mgr.parseLine('<Idle|MPos:0,0,0|WCO:0,0,0>');
  mgr.parseLine('<Idle|MPos:100,0,-10|WCO:100,0,-10>');
}

const motionLines = () => sent.filter((l) => /^G[0-3]\b/.test(l));

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(async () => {
  await webSerialManager.cancelJob().catch(() => {});
  await vi.waitFor(() => expect(mgr.starting).toBe(false));
  mgr.transport = null;
  mgr.grblSettings.clear();
  mgr.machineKey = null;
  mgr.state.connected = false;
  mgr.state.status = 'DISCONNECTED';
  mgr.state.park = null;
  mgr.state.resume = null;
  vi.unstubAllGlobals();
});

describe('a job handed to a Tekno Box', () => {
  it('is refused before it is handed over when it would run off an axis', async () => {
    const handed = vi.fn().mockResolvedValue({ delivered: true, message: 'ok' });
    attach({ runJob: handed });
    limitTravel();

    const run = await webSerialManager.runJob(['G21', 'G90', 'G0 X60 Y10', 'G1 X70 F600'].join('\n'));
    expect(handed).not.toHaveBeenCalled();
    expect(run?.delivered).toBe(false);
    expect(run?.message).toMatch(/past the \+X end of the machine's travel/);
    expect(webSerialManager.getState().lastError).toBe(run?.message);
    expect(webSerialManager.getState().status).not.toBe('RUNNING');
  });

  it('puts a job the box would not take where errors are shown', async () => {
    attach({ runJob: vi.fn().mockResolvedValue({ delivered: false, message: 'The box is busy.' }) });

    const run = await webSerialManager.runJob('G21\nG90\nG0 X1');
    expect(run?.delivered).toBe(false);
    expect(webSerialManager.getState().lastError).toBe('The box is busy.');
    expect(webSerialManager.getState().pauseMessage).toBeUndefined();
    expect(webSerialManager.getState().status).toBe('IDLE');
  });
});

describe('a program planned for a faster spindle than this one', () => {
  const JOB = ['G21', 'G90', 'G0 Z5', 'M3 S24000', 'G4 P2', 'G1 Z-1 F300', 'G1 X10 F1500', 'M5', 'M30'].join('\n');

  it('is refused on a controller that sets the speed, before anything moves', async () => {
    attach();
    mgr.state.grblSettings = { 30: 10000 };

    await webSerialManager.startJob(JOB);
    expect(webSerialManager.getState().lastError).toMatch(/S24000.*\$30.*Re-export for this machine/s);
    expect(webSerialManager.isRunning()).toBe(false);
    expect(motionLines()).toEqual([]);
  });

  it('is refused for a Tekno Box job too', async () => {
    const handed = vi.fn().mockResolvedValue({ delivered: true, message: 'ok' });
    attach({ runJob: handed });
    mgr.state.grblSettings = { 30: 10000 };

    const run = await webSerialManager.runJob(JOB);
    expect(handed).not.toHaveBeenCalled();
    expect(run?.message).toMatch(/Re-export for this machine/);
  });

  it('runs on the machine whose override says its S drives nothing, and only that one', async () => {
    attach();
    writeSpindleMaxOverride(24000, 'grbl:1.1h.20190825:Router');

    // Another controller identifies itself: the router's override is not its.
    mgr.parseLine('[VER:1.1h.20190825:Mill]');
    webSerialManager.reapplySpindleOverride();
    mgr.state.grblSettings = { 30: 10000 };
    expect(webSerialManager.getState().motion.spindle?.max).not.toBe(24000);
    await webSerialManager.startJob(JOB);
    expect(webSerialManager.getState().lastError).toMatch(/Re-export for this machine/);

    // The router: planned to its real top speed, and its job is not refused.
    mgr.parseLine('[VER:1.1h.20190825:Router]');
    webSerialManager.reapplySpindleOverride();
    expect(webSerialManager.getState().motion.spindle?.max).toBe(24000);
    void webSerialManager.startJob(JOB);
    await vi.waitFor(() => expect(sent).toContain('M3 S24000'));
  });
});

describe('a framing lap', () => {
  it('is refused before it moves when it would run off an axis', async () => {
    attach();
    limitTravel();
    report = '<Idle|MPos:100,0,-10|WCO:100,0,-10>';

    await expect(
      webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 60, maxY: 10 }, 0, { laserMode: false })
    ).rejects.toThrow(/past the \+X end/);
    expect(motionLines()).toEqual([]);
    expect(webSerialManager.getState().lastError).toMatch(/past the \+X end/);
  });
});

describe('parking', () => {
  const ROUTER_JOB = ['G21', 'G90', 'G0 Z5', 'G1 Z-2 F300', ...Array.from({ length: 50 }, (_, i) => `G1 X${(i + 2) * 2}`), 'M30'].join('\n');

  it('never resets a machine that has not confirmed it stopped', async () => {
    attach();
    void webSerialManager.startJob(ROUTER_JOB);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(4));
    // Still decelerating, for as long as anyone waits.
    report = '<Hold:1|MPos:5,0,-2|FS:0,0>';

    expect(await webSerialManager.parkJob()).toBe(false);
    expect(realtime).not.toContain(0x18);
    const state = webSerialManager.getState();
    expect(state.status).toBe('PAUSED_OPERATOR');
    expect(state.park).toBeNull();
    expect(state.pauseMessage).toMatch(/left in feed hold/);
    expect(webSerialManager.isJobPaused()).toBe(true);
  }, 15000);

  async function park() {
    attach();
    // A previous test's alarm left the singleton with its position lost, and
    // the package will not stream again until X and Y have been zeroed.
    await webSerialManager.zeroAllHere();
    sent.length = 0;
    void webSerialManager.startJob(ROUTER_JOB);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(4));
    report = '<Hold:0|MPos:5,0,-2|FS:0,0>';
    expect(await webSerialManager.parkJob()).toBe(true);
    report = '<Idle|MPos:5,0,5|FS:0,0>';
    const parked = webSerialManager.getState().park;
    expect(parked).not.toBeNull();
    return parked!;
  }

  it('turns into a resume offer when an alarm ends it', async () => {
    const parked = await park();
    mgr.parseLine('ALARM:1');

    const state = webSerialManager.getState();
    expect(state.park).toBeNull();
    expect(state.resume).toMatchObject({ fromLine: parked.fromLine, reason: 'alarm' });
  });

  it('turns into a resume offer when the link drops', async () => {
    const parked = await park();
    mgr.handleTransportDisconnect(new Error('The device has been lost.'));

    const state = webSerialManager.getState();
    expect(state.park).toBeNull();
    expect(state.resume).toMatchObject({ fromLine: parked.fromLine, reason: 'disconnected' });
  });
});
