import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  syncCloudParameters: vi.fn().mockResolvedValue(undefined),
}));

const { webSerialManager } = await import('../src/utils/webSerialManager');
const { readLaserModeBorrowed, writeLaserModeBorrowed } = await import('../src/utils/guideSpot');
const { measureGcodeBounds } = await import('../src/utils/workEnvelope');

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
  state: Record<string, unknown> & {
    connected: boolean;
    status: string;
    wpos: { x: number; y: number; z: number };
    mpos: { x: number; y: number; z: number };
    needsZZero: boolean;
    hasHomed: boolean;
    grblSettings: Record<number, number>;
    park: { fromLine: number; totalLines: number; at: { x: number; y: number; z: number } } | null;
    resume: { fromLine: number; totalLines: number } | null;
    setupPending: { sequenceId: string; next: number; of: number; locate: 'pins' | 'knownSpot' } | null;
    lastError?: string;
    probePinActive: boolean;
    probeCircuitSeen: boolean;
  };
  parseLine: (line: string) => void;
  lastWco: { x: number; y: number; z: number } | undefined;
  grblSettings: Map<number, number>;
  machineKey: string | null;
  starting: boolean;
  isJobRunning: boolean;
  isPaused: boolean;
  lostAxes: { x: boolean; y: boolean };
  laserModeHome: 0 | 1 | null;
  laserModeRestoring: Promise<void> | null;
  jobContext: { name?: string; settings?: Record<string, unknown> | null };
  runningSetup: unknown;
  homedAt: { x: number; y: number; z: number } | null;
  applyRemoteCommands: (commands: Array<{ kind: string; step: number }>) => Promise<void>;
  retractClearOfWork: () => Promise<boolean>;
  restoreLaserMode: () => Promise<void>;
  jobPeakWorkZ: number | null;
};

const store = new Map<string, string>();
let sent: string[] = [];
let realtime: number[] = [];
let lineHandler: ((line: string) => boolean | void) | null = null;
let reportLine = '<Idle|MPos:0.000,0.000,0.000|FS:0,0>';

function attachFake(extra: Partial<Transport> = {}) {
  webSerialManager.setBed(null);
  sent = [];
  realtime = [];
  lineHandler = null;
  reportLine = '<Idle|MPos:0.000,0.000,0.000|FS:0,0>';
  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.hasHomed = false;
  mgr.state.grblSettings = {};
  mgr.grblSettings.clear();
  mgr.state.park = null;
  mgr.state.resume = null;
  mgr.state.setupPending = null;
  mgr.state.wpos = { x: 0, y: 0, z: 0 };
  mgr.state.mpos = { x: 0, y: 0, z: 0 };
  mgr.state.probePinActive = false;
  mgr.state.probeCircuitSeen = true;
  mgr.machineKey = null;
  mgr.lastWco = { x: 0, y: 0, z: 0 };
  mgr.lostAxes = { x: false, y: false };
  mgr.laserModeHome = null;
  mgr.laserModeRestoring = null;
  mgr.homedAt = null;
  mgr.jobPeakWorkZ = null;
  mgr.isJobRunning = false;
  mgr.isPaused = false;
  mgr.starting = false;
  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async writeRealtime(b: number) {
      realtime.push(b);
      if (b === 0x3f) setTimeout(() => mgr.parseLine(reportLine), 0);
      if (b === 0x18) setTimeout(() => mgr.parseLine("Grbl 1.1h ['$' for help]"), 2);
    },
    async writeLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      sent.push(trimmed);
      if (lineHandler && lineHandler(trimmed) === true) return;
      setTimeout(() => mgr.parseLine('ok'), 0);
    },
    ...extra,
  };
}

const ROUTER_JOB = [
  'G21',
  'G90',
  'G0 Z5',
  'M3 S18000',
  'G0 X10 Y10',
  'G1 Z-1 F200',
  'G1 X50 Y10 F800',
  'G0 Z5',
  'M5',
].join('\n');

const LASER_JOB = [
  'G21',
  'G90',
  'M4 S500',
  'G1 X10 Y10 F1200',
  'M5',
].join('\n');

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  attachFake();
});

afterEach(async () => {
  lineHandler = null;
  await webSerialManager.cancelJob().catch(() => {});
  webSerialManager.clearResumePoint();
  webSerialManager.discardPark();
  mgr.isJobRunning = false;
  mgr.isPaused = false;
  mgr.starting = false;
  mgr.laserModeHome = null;
  mgr.laserModeRestoring = null;
  mgr.transport = null;
  mgr.state.connected = false;
  mgr.state.status = 'DISCONNECTED';
  vi.unstubAllGlobals();
});

describe('machine control audit fixes', () => {
  describe('resumeFromPark and resumeFromLine safety', () => {
    it('keeps park intact and sets lastError when resumeFromLine refuses due to travel bounds', async () => {
      // Load a program via restoreMeshCheckpoint and put machine in PAUSED_PARKED.
      webSerialManager.restoreMeshCheckpoint(
        { gcode: ROUTER_JOB, totalLines: 9, jobName: 'box', settings: null, startedAt: Date.now() },
        4,
        { source: 'local', jobName: 'box', startedAt: Date.now(), stoppedAt: Date.now(), approximate: false }
      );
      // Machine bed is only 30 mm wide, while job goes to X50.
      mgr.grblSettings.set(130, 30);
      mgr.grblSettings.set(131, 30);
      mgr.grblSettings.set(132, 50);
      mgr.state.grblSettings = { 130: 30, 131: 30, 132: 50 };
      mgr.state.status = 'PAUSED_PARKED';
      mgr.state.park = { fromLine: 4, totalLines: 9, at: { x: 10, y: 10, z: 5 } };

      const ok = await webSerialManager.resumeFromPark({ isLaser: false });
      expect(ok).toBe(false);
      // Must NOT strand in PAUSED_PARKED with park === null!
      expect(webSerialManager.getState().status).toBe('PAUSED_PARKED');
      expect(webSerialManager.getState().park).not.toBeNull();
      expect(webSerialManager.getState().lastError).toMatch(/travel|bed|30|50|X/i);
    });

    it('refuses resumeFromLine when program spindle RPM exceeds controller $30 ceiling', () => {
      webSerialManager.restoreMeshCheckpoint(
        { gcode: ROUTER_JOB, totalLines: 9, jobName: 'fast-spindle', settings: null, startedAt: Date.now() },
        4,
        { source: 'local', jobName: 'fast-spindle', startedAt: Date.now(), stoppedAt: Date.now(), approximate: false }
      );
      mgr.grblSettings.set(30, 10000);
      mgr.state.grblSettings = { 30: 10000 };

      const res = webSerialManager.resumeFromLine(4, { isLaser: false });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/18000.*10000|exceeds controller max/i);
      expect(webSerialManager.getState().lastError).toBe(res.message);
      expect(webSerialManager.getState().status).not.toBe('RUNNING');
    });
  });

  describe('Tekno Box / cloud-relay runJob guards', () => {
    it('refuses a handed-over job when machine position is lost', async () => {
      const runJob = vi.fn().mockResolvedValue({ delivered: true, message: 'Sent.' });
      attachFake({ runJob });
      mgr.lostAxes = { x: true, y: true };

      const res = await webSerialManager.runJob(ROUTER_JOB, { name: 'lost-pos' });
      expect(res?.delivered).toBe(false);
      expect(res?.message).toMatch(/lost its position/i);
      expect(runJob).not.toHaveBeenCalled();
    });

    it('refuses a handed-over laser job when $32=0', async () => {
      const runJob = vi.fn().mockResolvedValue({ delivered: true, message: 'Sent.' });
      attachFake({ runJob });
      mgr.grblSettings.set(32, 0);
      mgr.state.grblSettings = { 32: 0 };

      const res = await webSerialManager.runJob(LASER_JOB, { name: 'laser-off', machine: 'laser' });
      expect(res?.delivered).toBe(false);
      expect(res?.message).toMatch(/\$32=0/);
      expect(runJob).not.toHaveBeenCalled();
    });

    it('blocks concurrent runJob submissions while handoff is in flight', async () => {
      let release!: (v: { delivered: boolean; message: string }) => void;
      const runJob = vi.fn(
        () => new Promise<{ delivered: boolean; message: string }>((r) => { release = r; })
      );
      attachFake({ runJob });

      const first = webSerialManager.runJob(ROUTER_JOB, { name: 'first' });
      const second = await webSerialManager.runJob(ROUTER_JOB, { name: 'second' });
      expect(second).toBeNull();
      expect(runJob).toHaveBeenCalledTimes(1);

      release({ delivered: true, message: 'Sent.' });
      expect((await first)?.delivered).toBe(true);
    });

    it('does not clobber jobContext or setupPending when a runJob is refused', async () => {
      const runJob = vi.fn().mockResolvedValue({ delivered: false, message: 'Box busy' });
      attachFake({ runJob });
      mgr.jobContext = { name: 'previous-job', settings: { foo: 1 } };
      const pending = { sequenceId: 'seq-1', next: 2, of: 2, locate: 'knownSpot' as const };
      mgr.state.setupPending = pending;

      // Refused because Z zero is needed.
      mgr.state.needsZZero = true;
      const refused = await webSerialManager.runJob(ROUTER_JOB, {
        name: 'new-job',
        setup: { sequenceId: 'seq-1', index: 2, of: 2, locate: 'knownSpot' },
      });
      expect(refused).toBeNull();
      expect(mgr.jobContext.name).toBe('previous-job');
      expect(mgr.state.setupPending).toEqual(pending);
    });
  });

  describe('$32 laser-mode borrow/restore safety', () => {
    it('awaits an in-flight restoreLaserMode before borrowing $32=0 in guideSpotOn', async () => {
      mgr.laserModeHome = 1;
      mgr.grblSettings.set(32, 0);
      mgr.state.grblSettings = { 32: 0 };

      let ackRestore!: () => void;
      lineHandler = (line) => {
        if (line === '$32=1') {
          ackRestore = () => mgr.parseLine('ok');
          return true;
        }
      };

      const restoring = mgr.restoreLaserMode();
      await new Promise((r) => setTimeout(r, 10));
      const spotPromise = webSerialManager.guideSpotOn(2);
      // Release the background `$32=1` restore; guideSpotOn must then send `$32=0` AFTER it.
      ackRestore();
      await restoring;
      await spotPromise;

      const idx1 = sent.indexOf('$32=1');
      const idx0 = sent.indexOf('$32=0');
      expect(idx1).toBeGreaterThanOrEqual(0);
      expect(idx0).toBeGreaterThan(idx1);
      expect(webSerialManager.getState().grblSettings[32]).toBe(0);
    });

    it('preserves persisted laserModeBorrowed=0 if guideSpotOn fails sending $32=0', async () => {
      // Simulate a parked laser job that borrowed $32=1 from home=0.
      mgr.laserModeHome = 0;
      writeLaserModeBorrowed(0);
      mgr.grblSettings.set(32, 1);
      mgr.state.grblSettings = { 32: 1 };

      lineHandler = (line) => {
        if (line === '$32=0') {
          setTimeout(() => mgr.parseLine('error:8'), 0);
          return true;
        }
      };

      await expect(webSerialManager.guideSpotOn(2)).rejects.toThrow();
      expect(readLaserModeBorrowed()).toBe(0);
    });
  });

  describe('retractClearOfWork units and probing guards', () => {
    it('asserts G21 before homed and un-homed retracts so G20 programs do not retract in inches', async () => {
      mgr.grblSettings.set(132, 60);
      mgr.state.grblSettings = { 132: 60 };
      mgr.state.hasHomed = true;
      mgr.homedAt = { x: 0, y: 0, z: -1 };
      await mgr.retractClearOfWork();
      const g21Homed = sent.indexOf('G21');
      const g53 = sent.findIndex((l) => /^G53 G0 Z/.test(l));
      expect(g21Homed).toBeGreaterThanOrEqual(0);
      expect(g53).toBeGreaterThan(g21Homed);

      sent = [];
      mgr.state.hasHomed = false;
      mgr.state.wpos = { x: 0, y: 0, z: 2 };
      mgr.jobPeakWorkZ = 15;
      await mgr.retractClearOfWork();
      const g21Unhomed = sent.indexOf('G21');
      const g90 = sent.indexOf('G90 G0 Z15.000');
      expect(g21Unhomed).toBeGreaterThanOrEqual(0);
      expect(g90).toBeGreaterThan(g21Unhomed);
    });

    it('clamps probeGrid initial lift to headroom even when Z is zeroed', async () => {
      mgr.grblSettings.set(132, 60);
      mgr.state.grblSettings = { 132: 60 };
      mgr.state.hasHomed = true;
      mgr.homedAt = { x: 0, y: 0, z: 0 };
      mgr.state.needsZZero = false;
      // Only 2 mm below top-1 headroom (mpos.z = -3, top = 0 => room = 0 - 1 - (-3) = 2 mm).
      reportLine = '<Idle|MPos:0.000,0.000,-3.000|FS:0,0>';
      mgr.lastWco = { x: 0, y: 0, z: -3 };
      mgr.state.mpos = { x: 0, y: 0, z: -3 };
      mgr.state.wpos = { x: 0, y: 0, z: 0 };

      lineHandler = (line) => {
        if (line.includes('G38.2')) {
          setTimeout(() => {
            mgr.parseLine('[PRB:0.000,0.000,-3.000:1]');
            mgr.parseLine('ok');
          }, 0);
          return true;
        }
      };

      await webSerialManager.probeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2, 2);
      const firstLift = sent.find((l) => l.startsWith('G91 G0 Z'));
      expect(firstLift).toBe('G91 G0 Z2.000');
    });

    it('refuses probePoint while a job is running and refuses zeroAllHere when disconnected', async () => {
      mgr.isJobRunning = true;
      mgr.isPaused = false;
      await expect(webSerialManager.probePoint()).rejects.toThrow(/while a job is running/);

      mgr.isJobRunning = false;
      mgr.state.connected = false;
      await expect(webSerialManager.zeroAllHere()).rejects.toThrow(/Not connected/);
    });
  });

  describe('workEnvelope measureGcodeBounds full-circle arcs', () => {
    it('includes cardinal extrema of G2/G3 full circles with omitted X and Y words', () => {
      const bounds = measureGcodeBounds([
        'G21 G90',
        'G0 X10 Y20',
        'G2 I15 J0 F600',
      ].join('\n'));
      expect(bounds).not.toBeNull();
      // Center is (25, 20), radius 15 => X in [10, 40], Y in [5, 35].
      expect(bounds!.minX).toBeCloseTo(10, 5);
      expect(bounds!.maxX).toBeCloseTo(40, 5);
      expect(bounds!.minY).toBeCloseTo(5, 5);
      expect(bounds!.maxY).toBeCloseTo(35, 5);
    });
  });

  describe('remote commands during job startup window', () => {
    it('honors a remote pause arriving while starting is true', async () => {
      mgr.starting = true;
      const pauseSpy = vi.spyOn(webSerialManager, 'pauseJob').mockResolvedValue(undefined);
      await mgr.applyRemoteCommands([{ kind: 'pause', step: 0 }]);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      pauseSpy.mockRestore();
    });
  });
});
