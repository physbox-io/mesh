import { describe, it, expect, vi, afterEach } from 'vitest';

/*
 * What the run archive hears when a job ends badly.
 *
 * A hard limit browns out the controller and it drops off USB. Before, the
 * app's telemetry went quiet the moment the machine read as disconnected, so
 * the run was left "running" until the server gave up on it.
 */

const posted = vi.fn().mockResolvedValue([]);
vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: (...args: unknown[]) => posted(...args),
}));

const { webSerialManager } = await import('../src/utils/webSerialManager');

const mgr = webSerialManager as unknown as {
  transport: unknown;
  state: Record<string, unknown>;
  parseLine: (line: string) => void;
  lastWco: { x: number; y: number; z: number } | undefined;
  grblSettings: Map<number, number>;
  handleTransportDisconnect: (err?: Error) => void;
};

/** A board that acknowledges everything a little later, so a job stays on the wire. */
function attach() {
  const sent: string[] = [];
  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.lastWco = { x: 0, y: 0, z: 0 };
  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    async writeRealtime() {},
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
  };
  return sent;
}

const JOB = ['G21', 'G90', 'G1 X10 F600', ...Array.from({ length: 200 }, (_, i) => `G1 X${i + 2}`), 'M30'].join('\n');

afterEach(async () => {
  await webSerialManager.cancelJob().catch(() => {});
  // A job killed by a lost link unwinds over a few turns of the event loop.
  await vi.waitFor(() => expect((webSerialManager as unknown as { starting: boolean }).starting).toBe(false));
  mgr.transport = null;
  mgr.grblSettings.clear();
  mgr.state.connected = false;
  mgr.state.status = 'DISCONNECTED';
});

describe('a job cut short by the controller dropping off', () => {
  it('closes its run with an error saying so', async () => {
    const sent = attach();
    posted.mockClear();
    void webSerialManager.startJob(JOB);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(5));

    mgr.handleTransportDisconnect(new Error('The device has been lost.'));
    await vi.waitFor(() => {
      const last = posted.mock.calls.at(-1)?.[1];
      expect(last?.status).toBe('error');
      expect(last?.lastError).toMatch(/Lost the connection to the controller at line \d+/);
    });
  });
});

describe('a job cut short on a machine whose settings had been read', () => {
  /*
   * The test above passed while the real thing did not: a live connection has
   * `$$` in `grblSettings`, so standing the job down and wiping them notified
   * once more while still connected, offered as "no job", and the throttle
   * forgot the frame it needed before `connected: false` arrived.
   */
  it('still closes its run with an error', async () => {
    const sent = attach();
    mgr.state.grblSettings = { 110: 3000, 130: 300 };
    posted.mockClear();
    void webSerialManager.startJob(JOB);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(5));

    mgr.handleTransportDisconnect(new Error('The device has been lost.'));
    await vi.waitFor(() => {
      const errors = posted.mock.calls.map((c) => c[1]).filter((f) => f?.status === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].lastError).toMatch(/Lost the connection to the controller at line \d+/);
    });
  });
});

describe('a job that would run off the end of an axis', () => {
  it('is refused before anything moves, with the reason', async () => {
    const sent = attach();
    for (const [k, v] of [[20, 0], [23, 3], [27, 1], [130, 150], [131, 150], [132, 60]]) {
      mgr.grblSettings.set(k, v);
    }
    mgr.parseLine('<Home|MPos:0,0,0>');
    mgr.parseLine('<Idle|MPos:0,0,0|WCO:0,0,0>');
    mgr.parseLine('<Idle|MPos:100,0,-10|WCO:100,0,-10>');
    sent.length = 0;

    await webSerialManager.startJob(['G21', 'G90', 'G0 X60 Y10', 'G1 X70 F600'].join('\n'));
    expect(webSerialManager.getState().lastError).toMatch(/past the \+X end of the machine's travel/);
    expect(webSerialManager.getState().status).not.toBe('RUNNING');
    expect(sent.filter((l) => /^G[0-3]\b/.test(l))).toEqual([]);
  });
});
