import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The audit's machine-safety findings, each as the operator or agent would meet
 * it, on a fake controller: what goes down the wire, in what order, and what
 * the app then believes. See also `machineGuards.test.ts` for the same pattern.
 */

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  syncCloudParameters: vi.fn().mockResolvedValue(undefined),
}));

const { webSerialManager } = await import('../src/utils/webSerialManager');
const { createMeshMachineHandlers, machineArming, setCurrentScene } = await import('../src/utils/machineMcp');
const { beginCheckpoint, clearCheckpoint, noteCheckpointPosition, recordProgress } = await import(
  '../src/utils/jobCheckpoint'
);
const { prepareJobLines } = await import('../src/utils/machineJobLines');

type Transport = {
  label: string;
  open: () => Promise<void>;
  close: () => Promise<void>;
  disconnect?: () => Promise<void>;
  writeRealtime: (b: number) => Promise<void>;
  writeLine: (l: string) => Promise<void>;
  runJob?: (gcode: string, options: unknown) => Promise<{ delivered: boolean; message: string }>;
};
const mgr = webSerialManager as unknown as {
  transport: Transport | null;
  state: Record<string, unknown> & { grblSettings: Record<number, number> };
  parseLine: (line: string) => void;
  lastWco: { x: number; y: number; z: number } | undefined;
  grblSettings: Map<number, number>;
  program: unknown[];
  jobLineBase: number;
  machineKey: string | null;
  handleTransportDisconnect: (err?: Error) => void;
  starting: boolean;
  laserModeHome: 0 | 1 | null;
  lostAxes: { x: boolean; y: boolean };
  setupEndedAt: number;
  zZeroedAt: number;
  isJobRunning: boolean;
  isPaused: boolean;
  currentQueueIndex: number;
  cutFloorLine: number;
  drainedPause: unknown;
};

const store = new Map<string, string>();
let sent: string[] = [];
let realtime: number[] = [];
/** What a status poll answers. */
let report = '<Idle|MPos:1,2,3|FS:0,0>';
/** Lines the controller refuses, by what it refuses them with. */
let refuse: (line: string) => string | null = () => null;
/** Lines the controller holds on to, so a job stays in flight. */
let hold: (line: string) => boolean = () => false;
const held: string[] = [];

function attach(extra: Partial<Transport> = {}) {
  webSerialManager.setBed(null);
  sent = [];
  realtime = [];
  refuse = () => null;
  hold = () => false;
  held.length = 0;
  report = '<Idle|MPos:1,2,3|FS:0,0>';
  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.grblState = 'Idle';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.zDatumTrusted = true;
  mgr.state.grblSettings = {};
  mgr.state.park = null;
  mgr.state.resume = null;
  mgr.state.setupPending = null;
  mgr.state.hasHomed = false;
  mgr.state.guideSpot = false;
  mgr.state.wpos = { x: 0, y: 0, z: 20 };
  mgr.grblSettings.clear();
  mgr.program = [];
  mgr.jobLineBase = 0;
  mgr.machineKey = null;
  mgr.laserModeHome = null;
  mgr.lostAxes = { x: false, y: false };
  mgr.lastWco = { x: 0, y: 0, z: 0 };
  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async disconnect() {
      sent.push('<closed>');
    },
    async writeRealtime(b: number) {
      realtime.push(b);
      if (b === 0x3f) setTimeout(() => mgr.parseLine(report), 0);
      if (b === 0x18) {
        report = report.replace(/<(Run|Hold)[^|]*/, '<Idle');
        setTimeout(() => mgr.parseLine("Grbl 1.1h ['$' for help]"), 2);
      }
    },
    async writeLine(line: string) {
      const code = line.trim();
      if (!code) return;
      sent.push(code);
      if (hold(code)) {
        held.push(code);
        return;
      }
      const refused = refuse(code);
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          mgr.parseLine(refused ?? 'ok');
          resolve();
        }, 0)
      );
    },
    ...extra,
  };
}

const laser32 = (v: 0 | 1) => {
  mgr.state.grblSettings = { 32: v };
  mgr.grblSettings.set(32, v);
};
const job = (status = 'RUNNING') =>
  vi.waitFor(() => expect(webSerialManager.getState().status).toBe(status));
const started = () =>
  vi.waitFor(() => {
    expect(webSerialManager.getState().lastError).toBeUndefined();
    expect(webSerialManager.isRunning()).toBe(true);
  });
const finished = () =>
  vi.waitFor(() => {
    expect(webSerialManager.isRunning()).toBe(false);
    expect(webSerialManager.getState().status).toBe('IDLE');
    expect(webSerialManager.getState().lastCompletedJob).not.toBeNull();
  });
/** Answers everything held back, so a job can run on to its end. */
const release = () => {
  hold = () => false;
  held.splice(0).forEach(() => mgr.parseLine('ok'));
};

/** A router's program: Z words and M3. */
const ROUTER = ['G21', 'G90', 'G0 Z5', 'M3 S12000', 'G1 Z-1 F100', 'G1 X10 F500', 'G0 Z5', 'M5', 'M30'].join('\n');
/** A laser's: no Z, M4. */
const LASER = ['G21', 'G90', 'G0 X1 Y1', 'M4 S500', 'G1 X10 F1000', 'M5', 'M30'].join('\n');
/** Cuts, then changes tool. */
const TOOL_CHANGE = ['G21', 'G90', 'G0 Z5', 'M3 S12000', 'G1 Z-1 F100', 'G1 X10 F500', 'G0 Z5', 'M5', 'T2 M6', 'M3 S12000', 'G1 Z-1 F100', 'G1 X20 F500', 'G0 Z5', 'M5', 'M30'].join('\n');

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  attach();
});

afterEach(async () => {
  machineArming.disarm('session-ended');
  release();
  await webSerialManager.cancelJob().catch(() => {});
  await vi.waitFor(() => expect(mgr.starting).toBe(false));
  mgr.transport = null;
  mgr.grblSettings.clear();
  mgr.state.connected = false;
  mgr.state.status = 'DISCONNECTED';
  clearCheckpoint();
  vi.unstubAllGlobals();
});

describe('C1: a closed port leaves nothing lit', () => {
  it('puts the guide spot out, and gives $32 back, before the port closes', async () => {
    laser32(1);
    mgr.state.status = 'IDLE';
    await webSerialManager.guideSpotOn(1);
    await webSerialManager.disconnect();
    const closed = sent.indexOf('<closed>');
    expect(closed).toBeGreaterThan(-1);
    expect(sent.indexOf('M5')).toBeGreaterThan(-1);
    expect(sent.indexOf('M5')).toBeLessThan(closed);
    expect(sent.indexOf('$32=1')).toBeGreaterThan(-1);
    expect(sent.indexOf('$32=1')).toBeLessThan(closed);
    // A spot is not a job: the disconnect does not wait on a reset for it.
    expect(realtime).not.toContain(0x18);
  });
});

describe('the arming gate', () => {
  const machine = () => createMeshMachineHandlers();

  it('cancels the job an agent started when a person disarms, not a person’s own', async () => {
    machine();
    machineArming.arm();
    hold = (l) => l.startsWith('G1');
    void webSerialManager.runJob(ROUTER);
    await started();
    machineArming.disarm('operator');
    await new Promise((r) => setTimeout(r, 20));
    expect(webSerialManager.isRunning()).toBe(true);
    expect(realtime).not.toContain(0x18);
  });

  it('closes on an e-stop and an alarm, and not on a cancel or a failed probe', async () => {
    machineArming.arm();
    await webSerialManager.eStop();
    expect(machineArming.getState()).toMatchObject({ armed: false, lastClosedReason: 'estop' });

    machineArming.arm();
    mgr.parseLine('ALARM:5');
    expect(machineArming.getState().armed).toBe(true);
    await webSerialManager.unlockAlarm();

    mgr.parseLine('ALARM:1');
    expect(machineArming.getState()).toMatchObject({ armed: false, lastClosedReason: 'alarm' });
    await webSerialManager.unlockAlarm();

    attach();
    machineArming.arm();
    hold = (l) => l.startsWith('G1');
    void webSerialManager.runJob(ROUTER);
    await started();
    await webSerialManager.cancelJob();
    expect(machineArming.getState().armed).toBe(true);
  });
});

describe('H9: the lines behind a resume', () => {
  it('counts a bit as having cut when the run started after its cuts', async () => {
    mgr.program = prepareJobLines(TOOL_CHANGE);
    // Picked up at the M6 itself: the new queue has no feed move ahead of it.
    expect(webSerialManager.resumeFromLine(8).ok).toBe(true);
    await job('PAUSED_TOOL');
    await vi.waitFor(() => expect(webSerialManager.getState().needsZZero).toBe(true));
  });
});

describe('agent jobs picked up from a line', () => {
  const armed = () => {
    machineArming.arm();
    return createMeshMachineHandlers();
  };

  it('are the agent’s, so disarming stops them', async () => {
    await webSerialManager.startJob(ROUTER);
    await finished();
    const handlers = armed();
    hold = (l) => l.startsWith('G1');
    await handlers.MACHINE_RESUME_FROM_LINE({ fromLine: 2 });
    await started();
    expect(webSerialManager.jobOrigin()).toBe('agent');
  });

  it('leave nothing expected behind when refused', async () => {
    const handlers = armed();
    await expect(handlers.MACHINE_RESUME_FROM_LINE({ fromLine: 2 })).rejects.toThrow(/no program/);
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    expect(webSerialManager.jobOrigin()).toBe('operator');
  });
});

describe('H19: refused before anything is planned', () => {
  beforeEach(async () => {
    machineArming.arm();
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
  });

  it.each([
    ['MACHINE_PROBE_SURFACE', {}],
    ['MACHINE_ZERO_Z', { here: true }],
    ['MACHINE_ZERO_ALL', {}],
    ['MACHINE_RESUME_FROM_LINE', { fromLine: 1 }],
  ])('%s', async (name, args) => {
    setCurrentScene(null);
    const handlers = createMeshMachineHandlers();
    const before = machineArming.getState().lastAgentCommand;
    await expect(handlers[name](args)).rejects.toThrow(/while a job is running or on feed hold/);
    expect(machineArming.getState().lastAgentCommand).toBe(before);
  });
});

describe('C2: unlock', () => {
  it('is refused while a job is streaming, and leaves it running', async () => {
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    await expect(webSerialManager.unlockAlarm()).rejects.toThrow(/while a job is running/);
    expect(webSerialManager.isRunning()).toBe(true);
    expect(sent).not.toContain('$X');
  });

  it('leaves a tool change waiting', async () => {
    await webSerialManager.startJob(TOOL_CHANGE);
    await job('PAUSED_TOOL');
    await vi.waitFor(() => expect(webSerialManager.getState().pauseMessage).toMatch(/Tool change/));
    await expect(webSerialManager.unlockAlarm()).rejects.toThrow();
    expect(webSerialManager.getState().status).toBe('PAUSED_TOOL');
    expect(webSerialManager.isJobPaused()).toBe(true);
    expect(sent).not.toContain('$X');
  });

  it('is refused while the controller is moving with no job', async () => {
    mgr.parseLine('<Jog|MPos:1,2,3|FS:500,0>');
    await expect(webSerialManager.unlockAlarm()).rejects.toThrow();
    expect(sent).not.toContain('$X');
  });

  it('clears an alarm, whatever the job had been doing', async () => {
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    mgr.parseLine('ALARM:1');
    await webSerialManager.unlockAlarm();
    expect(sent).toContain('$X');
  });

  it('works on a stopped controller with nothing to hold', async () => {
    await webSerialManager.unlockAlarm();
    expect(sent).toContain('$X');
  });
});

describe('C5: the job is what the program says, not what $32 says', () => {
  it('holds a router job to the Z gate on a controller left in laser mode', async () => {
    laser32(1);
    mgr.state.needsZZero = true;
    await webSerialManager.runJob(ROUTER);
    expect(webSerialManager.getState().lastError).toMatch(/Z zero has not been set/);
    expect(sent).toEqual([]);
  });

  it('lets a laser job through on a controller with laser mode off', async () => {
    laser32(0);
    mgr.state.needsZZero = true;
    await webSerialManager.runJob(LASER);
    await finished();
    expect(sent).toContain('M4 S500');
  });

  it('believes the caller over the program', async () => {
    mgr.state.needsZZero = true;
    await webSerialManager.runJob(ROUTER, { machine: 'laser' });
    await finished();
    expect(sent).toContain('G1 X10 F500');
    expect(webSerialManager.isLaserJob()).toBe(true);
  });

  it('reads $32 only when there is no job loaded', () => {
    laser32(1);
    expect(webSerialManager.isLaserJob()).toBe(true);
    mgr.program = prepareJobLines(ROUTER);
    expect(webSerialManager.isLaserJob()).toBe(false);
    laser32(0);
    mgr.program = prepareJobLines(LASER);
    expect(webSerialManager.isLaserJob()).toBe(true);
  });

  it('borrows $32 for a router job, ahead of the first line, and gives it back at the end', async () => {
    laser32(1);
    await webSerialManager.runJob(ROUTER);
    await finished();
    expect(sent.indexOf('$32=0')).toBeGreaterThan(-1);
    expect(sent.indexOf('$32=0')).toBeLessThan(sent.indexOf('G21'));
    await vi.waitFor(() => expect(sent).toContain('$32=1'));
    expect(sent.indexOf('$32=1')).toBeGreaterThan(sent.indexOf('M30'));
    expect(webSerialManager.getState().grblSettings[32]).toBe(1);
    expect(store.size === 0 || ![...store.keys()].some((k) => k.includes('laserModeBorrowed'))).toBe(true);
  });

  it('borrows $32 the other way for a laser job', async () => {
    laser32(0);
    await webSerialManager.runJob(LASER);
    await finished();
    expect(sent.indexOf('$32=1')).toBeLessThan(sent.indexOf('G21'));
    await vi.waitFor(() => expect(sent).toContain('$32=0'));
    expect(sent.indexOf('$32=0')).toBeGreaterThan(sent.indexOf('M30'));
    expect(webSerialManager.getState().grblSettings[32]).toBe(0);
  });

  it('sends nothing when the setting already fits, or is unknown', async () => {
    await webSerialManager.runJob(ROUTER);
    await finished();
    expect(sent.filter((l) => l.startsWith('$32'))).toEqual([]);
    attach();
    laser32(0);
    await webSerialManager.runJob(ROUTER);
    await finished();
    expect(sent.filter((l) => l.startsWith('$32'))).toEqual([]);
  });

  it.each([
    ['an e-stop', () => webSerialManager.eStop()],
    ['a cancel', () => webSerialManager.cancelJob()],
    ['an alarm', async () => void mgr.parseLine('ALARM:1')],
    ['a restart nobody asked for', async () => void mgr.parseLine("Grbl 1.1h ['$' for help]")],
    ['a refused line', async () => void mgr.parseLine('error:20')],
  ])('gives it back after %s', async (_, end) => {
    laser32(1);
    hold = (l) => l.startsWith('G1');
    await webSerialManager.runJob(ROUTER);
    await started();
    expect(mgr.laserModeHome).toBe(1);
    report = '<Run|MPos:1,2,3|FS:500,0>';
    hold = () => false;
    await end();
    await vi.waitFor(() => expect(sent).toContain('$32=1'), { timeout: 5000 });
    await vi.waitFor(() => expect(webSerialManager.getState().grblSettings[32]).toBe(1), { timeout: 5000 });
  }, 9000);

  it('puts it right at the next connection after a crash', async () => {
    laser32(1);
    hold = (l) => l.startsWith('G1');
    await webSerialManager.runJob(ROUTER);
    await started();
    // The page dies: only what was written down survives.
    mgr.isJobRunning = false;
    mgr.laserModeHome = null;
    attach();
    report = '<Idle|MPos:1,2,3|FS:0,0>';
    mgr.transport!.writeLine = async (line: string) => {
      const code = line.trim();
      sent.push(code);
      if (code === '$$') {
        mgr.parseLine('$32=0');
        mgr.parseLine('$110=3000');
      }
      setTimeout(() => mgr.parseLine('ok'), 0);
    };
    await webSerialManager.refreshMachineSettings(50, 1);
    await vi.waitFor(() => expect(sent).toContain('$32=1'));
  });

  it('falls back to the package’s refusal if the controller will not change it', async () => {
    laser32(1);
    refuse = (l) => (l.startsWith('$32') ? 'error:8' : null);
    await webSerialManager.runJob(ROUTER);
    await vi.waitFor(() => expect(webSerialManager.getState().lastError).toMatch(/Laser mode is on \(\$32=1\)/), { timeout: 5000 });
    expect(webSerialManager.getState().status).toBe('IDLE');
    expect(sent).not.toContain('G21');
  });

  it('keeps a resume offer when the borrow fails', async () => {
    await webSerialManager.startJob(ROUTER);
    await finished();
    laser32(1);
    refuse = (l) => (l.startsWith('$32') ? 'error:8' : null);
    expect(webSerialManager.resumeFromLine(2).ok).toBe(true);
    await vi.waitFor(() => expect(webSerialManager.getState().lastError).toMatch(/Laser mode is on/), { timeout: 5000 });
    expect(webSerialManager.getState().resume?.fromLine).toBe(2);
  });

  it('refuses a router job handed to a box in laser mode, which cannot be borrowed for', async () => {
    laser32(1);
    const runJob = vi.fn(async () => ({ delivered: true, message: 'ok' }));
    mgr.transport!.runJob = runJob;
    const out = await webSerialManager.runJob(ROUTER);
    expect(out?.delivered).toBe(false);
    expect(out?.message).toMatch(/Laser mode is on/);
    expect(runJob).not.toHaveBeenCalled();
  });

  it('parks a router job with a lift on a controller left in laser mode', async () => {
    laser32(1);
    hold = (l) => l.startsWith('G1');
    await webSerialManager.runJob(ROUTER);
    await started();
    report = '<Hold:0|MPos:1,2,3|WPos:1,2,-1|FS:0,0>';
    expect(await webSerialManager.parkJob()).toBe(true);
    report = '<Idle|MPos:1,2,3|WPos:1,2,-1|FS:0,0>';
    expect(sent.some((l) => /^G0 Z/.test(l))).toBe(true);
  });

  it('parks a laser job without one on a controller with laser mode off', async () => {
    laser32(0);
    hold = (l) => l.startsWith('G1');
    await webSerialManager.runJob(LASER);
    await started();
    report = '<Hold:0|MPos:1,2,3|FS:0,0>';
    expect(await webSerialManager.parkJob()).toBe(true);
    expect(sent.some((l) => /^G0 Z/.test(l))).toBe(false);
  });

  it('frames a router job dark and lifted, whatever $32 says', async () => {
    laser32(1);
    mgr.program = prepareJobLines(ROUTER);
    await webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 5);
    expect(sent.some((l) => /^M3/.test(l))).toBe(false);
    expect(sent.some((l) => /^G0 Z/.test(l))).toBe(true);
  });

  it('frames as it did when no job is loaded on a laser', async () => {
    laser32(1);
    await webSerialManager.frameJob({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 5);
    expect(sent.some((l) => /^M3/.test(l))).toBe(true);
    expect(sent.some((l) => /^G0 Z/.test(l))).toBe(false);
  });
});

describe('H5: a checkpoint read back after a reload', () => {
  const program = () => ({
    version: 1,
    id: 'p',
    gcode: ROUTER,
    totalLines: 9,
    jobName: 'job',
    settings: null,
    startedAt: 1,
    documentId: null,
    bytes: 1,
  });
  const restore = (mpos?: { x: number; y: number; z: number }) =>
    webSerialManager.restoreCheckpoint(program() as never, 3, {
      source: 'local',
      approximate: false,
      jobName: 'job',
      startedAt: 1,
      stoppedAt: 2,
      mpos,
    });

  it('writes the machine position down with the line', () => {
    beginCheckpoint({ gcode: ROUTER, totalLines: 9, jobName: 'j', settings: null, documentId: null });
    noteCheckpointPosition({ x: 40, y: 50, z: -6 });
    recordProgress(3, 'alarm', true);
    expect(JSON.parse(store.get('physics_job_checkpoint_progress')!).mpos).toEqual({ x: 40, y: 50, z: -6 });
  });

  it('calls X and Y lost when the first report reads exactly zero', () => {
    restore({ x: 40, y: 50, z: -6 });
    mgr.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(webSerialManager.resumeBlockedReason()).toMatch(/lost its position/);
    expect(webSerialManager.resumeBlockedReason()).not.toMatch(/connection/);
  });

  it('adds no step when the board kept its place', () => {
    restore({ x: 40, y: 50, z: -6 });
    mgr.parseLine('<Idle|MPos:40.000,50.000,-6.000|FS:0,0>');
    expect(webSerialManager.resumeBlockedReason()).toBeNull();
  });

  it('has no evidence without a stored position', () => {
    restore();
    mgr.parseLine('<Idle|MPos:0.000,0.000,0.000|FS:0,0>');
    expect(webSerialManager.resumeBlockedReason()).toBeNull();
  });
});

describe('H8: a Z zero after an alarm is no proof the tool changed', () => {
  it('stops at the M6 again rather than skipping it', async () => {
    await webSerialManager.startJob(TOOL_CHANGE);
    await job('PAUSED_TOOL');
    await vi.waitFor(() => expect(webSerialManager.getState().pauseMessage).toMatch(/Tool change/));
    await vi.waitFor(() => expect(mgr.drainedPause).not.toBeNull());
    mgr.parseLine('ALARM:1');
    const offer = webSerialManager.getState().resume!;
    expect(offer.pendingPause?.kind).toBe('tool-change');
    await webSerialManager.unlockAlarm();
    await webSerialManager.zeroXY();
    await webSerialManager.zeroZHere();
    expect(webSerialManager.previewResume(offer.fromLine)?.fromLine).toBe(offer.fromLine);
    expect(webSerialManager.resumeFromLine(offer.fromLine).ok).toBe(true);
    await job('PAUSED_TOOL');
  });
});

describe('H21: the order of a part’s setups', () => {
  const seq = (index: number, of = 3) => ({ sequenceId: 's', index, of, locate: 'pins' as const, pinsSeated: true });
  const refused = () => webSerialManager.getState().lastError;

  beforeEach(async () => {
    await webSerialManager.runJob(ROUTER, { setup: seq(1) });
    await finished();
    await webSerialManager.zeroZHere();
  });

  it('refuses one that is not next', async () => {
    await webSerialManager.runJob(ROUTER, { setup: seq(3) });
    expect(refused()).toMatch(/Setup 3 of 3/);
    expect(webSerialManager.isRunning()).toBe(false);
  });

  it('takes the one that is', async () => {
    await webSerialManager.runJob(ROUTER, { setup: seq(2) });
    await vi.waitFor(() => expect(webSerialManager.getState().lastCompletedJob?.totalLines).toBe(9));
    expect(webSerialManager.getState().setupPending?.next).toBe(3);
  });

  it('allows anything when nothing is known, as after a reload', async () => {
    mgr.state.setupPending = null;
    await webSerialManager.runJob(ROUTER, { setup: seq(3) });
    await finished();
  });

  it('does not carry a cancelled setup’s zeros', async () => {
    hold = (l) => l.startsWith('G1');
    await webSerialManager.runJob(ROUTER, { setup: seq(2) });
    await started();
    const before = mgr.setupEndedAt;
    await webSerialManager.cancelJob();
    expect(mgr.setupEndedAt).toBeGreaterThan(before);
    expect(mgr.zZeroedAt).toBeLessThan(mgr.setupEndedAt);
  });
});

describe('H15: moves that lean on a datum', () => {
  it('lifts to a clearance before the first hop of a grid when the tool is low', async () => {
    mgr.state.probeCircuitSeen = true;
    report = '<Idle|MPos:0,0,0|WPos:0,0,1.000|FS:0,0>';
    mgr.parseLine(report);
    const grid = webSerialManager.probeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2, 2);
    const answerProbes = setInterval(() => {
      if (sent.some((l) => l.includes('G38.2'))) mgr.parseLine('[PRB:0.000,0.000,-1.000:1]');
    }, 1);
    await grid.catch(() => {});
    clearInterval(answerProbes);
    const firstHop = sent.findIndex((l) => /^G0 X/.test(l));
    expect(sent.slice(0, firstHop).join(' ')).toMatch(/G91 G0 Z4\.000/);
  });

  it('does not lift when the tool is already clear', async () => {
    mgr.state.probeCircuitSeen = true;
    report = '<Idle|MPos:0,0,0|WPos:0,0,5.000|FS:0,0>';
    mgr.parseLine(report);
    const grid = webSerialManager.probeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2, 2);
    const answerProbes = setInterval(() => {
      if (sent.some((l) => l.includes('G38.2'))) mgr.parseLine('[PRB:0.000,0.000,-1.000:1]');
    }, 1);
    await grid.catch(() => {});
    clearInterval(answerProbes);
    const firstHop = sent.findIndex((l) => /^G0 X/.test(l));
    expect(sent.slice(0, firstHop).join(' ')).not.toMatch(/G91 G0 Z/);
  });

  it('holds an agent’s go-to-origin to a Z datum', async () => {
    machineArming.arm();
    mgr.state.needsZZero = true;
    await expect(createMeshMachineHandlers().MACHINE_GOTO_ORIGIN({})).rejects.toThrow(/Z zero has not been set/);
    expect(sent.some((l) => /^G0/.test(l))).toBe(false);
  });

  it('does not hold an operator’s, which is how a zero is checked', async () => {
    mgr.state.needsZZero = true;
    await webSerialManager.gotoWorkOrigin();
    expect(sent).toContain('G0 X0.000 Y0.000');
  });

  it('sends no Z on a laser', async () => {
    laser32(1);
    await webSerialManager.gotoWorkOrigin();
    expect(sent.some((l) => /^G0 Z/.test(l))).toBe(false);
    expect(sent).toContain('G0 X0.000 Y0.000');
  });
});

describe('the medium findings', () => {
  it('will not ask for $$ under a running job', async () => {
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    await expect(webSerialManager.refreshMachineSettings(50, 1)).rejects.toThrow(/while a job is running/);
    expect(sent).not.toContain('$$');
  });

  it('parks no further back than a tool change', async () => {
    const lines = TOOL_CHANGE.split('\n');
    const program = [...lines.slice(0, 9), 'G1 X0 F500', ...Array.from({ length: 10 }, (_, i) => `G1 X${i + 1} F500`), 'G1 X10 F500', 'M5', 'M30'].join('\n');
    await webSerialManager.startJob(program);
    await job('PAUSED_TOOL');
    await vi.waitFor(() => expect(mgr.drainedPause).not.toBeNull());
    hold = (l) => l === 'G1 X10 F500';
    await webSerialManager.resumeJob({ zIsSet: true });
    await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
    // Stands at X0: the same point as the cut before the tool change.
    report = '<Hold:0|MPos:0,0,0|WPos:0.000,0.000,5.000|FS:0,0>';
    mgr.parseLine(report);
    expect(await webSerialManager.parkJob()).toBe(true);
    expect(webSerialManager.getState().park!.fromLine).toBeGreaterThanOrEqual(9);
  });

  it('an e-stop while a park settles cancels the park', async () => {
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    report = '<Hold:1|MPos:1,2,3|FS:0,0>';
    const parking = webSerialManager.parkJob();
    await new Promise((r) => setTimeout(r, 20));
    await webSerialManager.eStop();
    report = '<Hold:0|MPos:1,2,3|FS:0,0>';
    expect(await parking).toBe(false);
    expect(webSerialManager.getState().park).toBeNull();
    expect(realtime.filter((b) => b === 0x18)).toHaveLength(1);
    expect(sent.some((l) => /^G0 Z/.test(l) && sent.indexOf(l) > 6)).toBe(false);
  });

  it('an e-stop after the park’s reset stops the lift that follows it', async () => {
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    report = '<Hold:0|MPos:1,2,3|FS:0,0>';
    mgr.parseLine(report);
    const lifts = sent.filter((l) => /^G0 Z/.test(l)).length;
    let stopped = false;
    const off = webSerialManager.addListener((state) => {
      if (state.status !== 'PAUSED_PARKED' || stopped) return;
      stopped = true;
      void webSerialManager.eStop();
    });
    await webSerialManager.parkJob();
    off();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((l) => /^G0 Z/.test(l)).length).toBe(lifts);
  });

  it('an e-stop on a parked job keeps the line, and needs asking to go back', async () => {
    hold = (l) => l.startsWith('G1');
    void webSerialManager.startJob(ROUTER);
    await started();
    report = '<Hold:0|MPos:1,2,3|FS:0,0>';
    mgr.parseLine(report);
    expect(await webSerialManager.parkJob()).toBe(true);
    await webSerialManager.eStop();
    const state = webSerialManager.getState();
    expect(state.park).toBeNull();
    expect(state.resume).not.toBeNull();
    expect(state.status).toBe('IDLE');
    expect(await webSerialManager.resumeFromPark()).toBe(false);
  });

  it('allows for paper on the side of a wall the bit is on', async () => {
    // Outside a face at 0, a 6 mm bit on 0.1 paper stands at -3.1.
    await webSerialManager.setWorkPosition({ x: -3, y: -3 }, 0.1);
    expect(sent).toContain('G10 L20 P1 X-3.100 Y-3.100');
    // Inside a notch with its wall at 12, it stands at 8.9, not 9.1.
    await webSerialManager.setWorkPosition({ x: 9, y: 9 }, 0.1);
    expect(sent).toContain('G10 L20 P1 X8.900 Y8.900');
  });

  it('a wall touched from its high side adds', async () => {
    await webSerialManager.setWorkPosition({ x: 53 }, 0.1, { x: 1 });
    expect(sent).toContain('G10 L20 P1 X53.100');
  });
});

describe('C11: a tool change stays over the spot the exporter chose', () => {
  const PROGRAM = ['G21', 'G90', 'G0 Z5', 'M3 S12000', 'G1 Z-1 F100', 'G1 X10 F500', 'G0 Z20', 'M5', 'G0 X70 Y70', 'T2 M6', 'M3 S12000', 'G1 Z-2 F100', 'G1 X90 F500', 'G0 Z20', 'M5', 'M30'].join('\n');

  it('lifts, sends no XY move, and resumes from the same XY', async () => {
    mgr.state.hasHomed = true;
    await webSerialManager.startJob(PROGRAM);
    await job('PAUSED_TOOL');
    await vi.waitFor(() => expect(mgr.drainedPause).not.toBeNull());
    await vi.waitFor(() => expect(webSerialManager.getState().pauseMessage).toMatch(/Tool change/));
    await new Promise((r) => setTimeout(r, 20));
    const m6 = sent.indexOf('G0 X70 Y70');
    const atStop = sent.slice(m6 + 1);
    expect(atStop.some((l) => /[XY]-?\d/.test(l))).toBe(false);
    expect(atStop).toContain('M5');

    sent = [];
    await webSerialManager.resumeJob({ zIsSet: true });
    await finished();
    const back = sent.find((l) => /^G0 X/.test(l));
    expect(back).toMatch(/^G0 X70\.000 Y70\.000/);
  });

  it('still parks at a material change', async () => {
    const swap = ['G21', 'G90', 'G0 Z20', 'M3 S12000', 'G1 Z-1 F100', 'G1 X10 F500', 'G0 Z20', 'M5', 'M0', 'M3 S12000', 'G1 X20 F500', 'M5', 'M30'].join('\n');
    mgr.state.hasHomed = false;
    report = '<Idle|MPos:0,0,20|WPos:0,0,20|FS:0,0>';
    mgr.parseLine(report);
    await webSerialManager.startJob(swap);
    await job('PAUSED_MATERIAL');
    await vi.waitFor(() => expect(sent).toContain('G0 X0.000 Y0.000'));
  });
});

describe('H14: one touch plate', () => {
  it('is what an agent’s zero defaults to', async () => {
    store.set('meshTouchPlateMm', '7.5');
    machineArming.arm();
    mgr.state.probeCircuitSeen = true;
    const zero = createMeshMachineHandlers().MACHINE_ZERO_Z({});
    await vi.waitFor(() => expect(sent.some((l) => l.includes('G38.2'))).toBe(true));
    mgr.parseLine('[PRB:0.000,0.000,-1.000:1]');
    await zero;
    expect(sent).toContain('G10 L20 P1 Z7.500');
  });
});

describe('H16: numbers from an agent', () => {
  let handlers: ReturnType<typeof createMeshMachineHandlers>;
  afterEach(() => {
    mgr.state.motion = { ...webSerialManager.getState().motion, source: 'assumed', travel: null };
  });
  beforeEach(() => {
    machineArming.arm();
    handlers = createMeshMachineHandlers();
    const motion = webSerialManager.getState().motion;
    mgr.state.motion = {
      ...motion,
      source: 'machine',
      maxRate: { x: 2000, y: 1800, z: 500 },
      travel: { x: 300, y: 200, z: 80 },
    };
  });

  it('reads "0.1" as a tenth of a millimetre', async () => {
    await handlers.MACHINE_ZERO_Z({ here: true, offsetMm: '0.1' });
    expect(sent).toContain('G10 L20 P1 Z0.100');
  });

  it.each([
    ['junk', { here: true, offsetMm: 'lots' }],
    ['a huge offset', { here: true, offsetMm: 1e6 }],
    ['a plate past 100', { touchPlateMm: 101 }],
    ['a negative plate', { touchPlateMm: -1 }],
    ['a search deeper than the machine', { touchPlateMm: 10, searchDepthMm: 500 }],
    ['a feed past the machine', { touchPlateMm: 10, feedRate: 99999 }],
    ['a junk feed', { touchPlateMm: 10, feedRate: 'fast' }],
  ])('refuses %s, and sends nothing', async (_, args) => {
    await expect(handlers.MACHINE_ZERO_Z(args)).rejects.toThrow(/Nothing was sent/);
    expect(sent).toEqual([]);
  });

  it('refuses a jog past the machine’s own travel', async () => {
    await expect(handlers.MACHINE_JOG({ x: 301 })).rejects.toThrow(/Nothing was sent/);
    await expect(handlers.MACHINE_JOG({ z: '81' })).rejects.toThrow(/Nothing was sent/);
    await expect(handlers.MACHINE_JOG({ x: 1, feedRate: 2001 })).rejects.toThrow(/Nothing was sent/);
    expect(sent).toEqual([]);
  });

  it('jogs by a string', async () => {
    await handlers.MACHINE_JOG({ x: '1.5', feedRate: '600' });
    expect(sent.some((l) => l.startsWith('$J=') && l.includes('X1.500'))).toBe(true);
  });

  it('refuses a probe grid off the machine, and junk counts', async () => {
    const bounds = { minX: 0, minY: 0, maxX: 500, maxY: 10 };
    await expect(handlers.MACHINE_PROBE_SURFACE({ bounds })).rejects.toThrow(/Nothing was sent/);
    await expect(
      handlers.MACHINE_PROBE_SURFACE({ bounds: { ...bounds, maxX: 10 }, cols: 'many' })
    ).rejects.toThrow(/Nothing was sent/);
    expect(sent).toEqual([]);
  });

  it('takes no missing fromLine for line 0', async () => {
    await webSerialManager.startJob(ROUTER);
    await finished();
    await expect(handlers.MACHINE_RESUME_FROM_LINE({ fromLine: null })).rejects.toThrow(/Give fromLine/);
  });

  it('refuses junk in a resume’s options rather than dropping it', async () => {
    await webSerialManager.startJob(ROUTER);
    await finished();
    await expect(
      handlers.MACHINE_RESUME_FROM_LINE({ fromLine: 2, options: { plungeFeed: 'slow' } })
    ).rejects.toThrow(/Nothing was sent/);
  });

  describe('a carve', () => {
    const block = {
      nodes: [{ id: 'b', name: 'p', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'box', size: [0.02, 0.02, 0.005] }], joints: [], children: [] }],
    };

    it('reads its numbers from strings', async () => {
      const { carveOptions } = await import('../src/utils/machineMcp');
      setCurrentScene(block as never);
      const { dia, options } = carveOptions({ toolDiaMm: '6', stockThicknessMm: '12', sides: '1' });
      expect(dia).toBe(6);
      expect(options.stockThicknessMm).toBe(12);
    });

    it('refuses junk', async () => {
      const { carveOptions } = await import('../src/utils/machineMcp');
      setCurrentScene(block as never);
      expect(() => carveOptions({ toolDiaMm: 'big' })).toThrow(/Nothing was sent/);
      expect(() => carveOptions({ toolDiaMm: 0 })).toThrow(/Nothing was sent/);
      expect(() => carveOptions({ stockThicknessMm: 1e6 })).toThrow(/Nothing was sent/);
    });

    it.each([['A'], [1], ['1']])('runs side %s', async (side) => {
      setCurrentScene(block as never);
      mgr.state.needsZZero = false;
      hold = (l) => l.startsWith('G1');
      await handlers.CARVE_SCENE({ side, toolDiaMm: 3 });
      await started();
      expect(webSerialManager.jobOrigin()).toBe('agent');
      expect(sent.join(' ')).toMatch(/G21/);
    });

    it('takes a setup number from a string, and refuses junk', async () => {
      const { pickCarveTarget } = await import('../src/utils/machineMcp');
      const planned = [{ index: 1, gcode: 'a' }, { index: 2, gcode: 'b' }];
      const sides = [{ side: 'A' as const, gcode: 'a' }, { side: 'B' as const, gcode: 'b' }];
      expect(pickCarveTarget({ setup: '2' }, planned, sides).wanted).toBe(2);
      expect(pickCarveTarget({ side: 2 }, null, sides).wanted).toBe('B');
      expect(pickCarveTarget({ side: 'b' }, null, sides).wanted).toBe('B');
      expect(() => pickCarveTarget({ setup: 'two' }, planned, sides)).toThrow(/Nothing was sent/);
      expect(() => pickCarveTarget({ side: 'C' }, null, sides)).toThrow(/Nothing was sent/);
    });
  });
});
