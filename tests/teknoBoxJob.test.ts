import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * A job handed to a Tekno Box is streamed by the box, not by this tab, but it
 * is still the job running on the machine: it stays RUNNING through the
 * reports, Pause and a disarm stop it, a second job is refused, and nothing
 * moves the machine by hand while it runs.
 */

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  syncCloudParameters: vi.fn().mockResolvedValue(undefined),
}));

const { webSerialManager } = await import('../src/utils/webSerialManager');
const { machineArming } = await import('../src/utils/machineMcp');

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
  starting: boolean;
  isJobRunning: boolean;
  isPaused: boolean;
};

const store = new Map<string, string>();
let sent: string[] = [];
let realtime: number[] = [];
const handed = vi.fn();

function attachBox() {
  webSerialManager.setBed(null);
  sent = [];
  realtime = [];
  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.grblSettings = {};
  mgr.state.park = null;
  mgr.state.resume = null;
  mgr.machineKey = null;
  mgr.lastWco = { x: 0, y: 0, z: 0 };
  handed.mockReset();
  handed.mockResolvedValue({ delivered: true, message: 'Sent to the box.' });
  mgr.transport = {
    label: 'Tekno Box',
    async open() {},
    async close() {},
    async writeRealtime(b: number) {
      realtime.push(b);
      if (b === 0x18) setTimeout(() => mgr.parseLine("Grbl 1.1h ['$' for help]"), 2);
    },
    async writeLine(line: string) {
      if (!line.trim()) return;
      sent.push(line.trim());
      setTimeout(() => mgr.parseLine('ok'), 0);
    },
    runJob: handed,
  };
}

const JOB = ['G21', 'G90', 'G0 Z5', 'M3 S12000', 'G1 Z-1 F200', 'G1 X10 F800', 'G0 Z5', 'M5'].join('\n');

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  attachBox();
});

afterEach(async () => {
  machineArming.disarm('operator');
  await webSerialManager.cancelJob().catch(() => {});
  mgr.isJobRunning = false;
  mgr.isPaused = false;
  mgr.transport = null;
  mgr.state.connected = false;
  mgr.state.status = 'DISCONNECTED';
  vi.unstubAllGlobals();
});

describe('a job handed to a Tekno Box', () => {
  it('stays RUNNING when the next report says Idle', async () => {
    const run = await webSerialManager.runJob(JOB);
    expect(run?.delivered).toBe(true);
    mgr.parseLine('<Idle|MPos:0,0,0|FS:0,0>');
    expect(webSerialManager.getState().status).toBe('RUNNING');
    expect(webSerialManager.isRunning()).toBe(true);
  });

  it('pauses with a feed hold sent to the box', async () => {
    await webSerialManager.runJob(JOB);
    mgr.parseLine('<Run|MPos:0,0,0|FS:800,12000>');
    await webSerialManager.pauseJob();
    expect(realtime).toContain(0x21);
    expect(webSerialManager.getState().status).toBe('PAUSED_OPERATOR');
  });

  it('refuses a second start on top of it', async () => {
    await webSerialManager.runJob(JOB);
    const second = await webSerialManager.runJob(JOB);
    expect(second).toBeNull();
    expect(handed).toHaveBeenCalledTimes(1);
    expect(webSerialManager.getState().lastError).toMatch(/already running/);
  });

  it('refuses zeroing, going to the origin and jogging while it runs', async () => {
    await webSerialManager.runJob(JOB);
    await expect(webSerialManager.zeroXY()).rejects.toThrow(/while a job is running/);
    await expect(webSerialManager.jog({ x: 1 })).rejects.toThrow(/while a job is running/);
    await expect(webSerialManager.gotoWorkOrigin()).rejects.toThrow(/while a job is running/);
    expect(sent).toEqual([]);
  });

  it('is stopped by a person disarming the agent that started it', async () => {
    machineArming.arm();
    await webSerialManager.runJob(JOB, { origin: 'mcp' });
    expect(webSerialManager.jobOrigin()).toBe('agent');
    machineArming.disarm('operator');
    await vi.waitFor(() => expect(realtime).toContain(0x18));
    expect(webSerialManager.isRunning()).toBe(false);
  });
});
