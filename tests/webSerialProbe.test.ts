import { describe, it, expect, beforeEach } from 'vitest';
import { webSerialManager } from '../src/utils/webSerialManager';
import { warpGcode, type ProbeGrid } from '../src/utils/meshLeveler';

/**
 * Stands in for a GRBL board on the other end of the serial port: acknowledges
 * every line, and answers a probe with a `[PRB:]` report the way real firmware
 * does. Heights come from `surface`, so a test can state the bed it is probing
 * and check the grid that comes back describes it.
 */
function attachFakeGrbl(surface: (x: number, y: number) => number | null) {
  // The manager's serial plumbing is private; a test has to reach past it to
  // stand in for hardware.
  const mgr = webSerialManager as unknown as {
    transport: {
      label: string;
      writeLine: (line: string) => Promise<void>;
      writeRealtime: (byte: number) => Promise<void>;
      open: () => Promise<void>;
      close: () => Promise<void>;
    } | null;
    state: { connected: boolean; lastError?: string };
    handleIncomingLine: (line: string) => void;
  };

  const sent: string[] = [];
  let x = 0;
  let y = 0;

  mgr.state.connected = true;
  mgr.state.lastError = undefined;
  mgr.transport = {
    label: 'Fake GRBL',
    async open() {},
    async close() {},
    // Nothing here probes with a realtime byte; `?` polling is off in these
    // tests and a status request would only add noise to `sent`.
    async writeRealtime() {},
    async writeLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      sent.push(trimmed);

      const mx = trimmed.match(/X(-?[\d.]+)/);
      const my = trimmed.match(/Y(-?[\d.]+)/);
      if (trimmed.startsWith('G0')) {
        if (mx) x = parseFloat(mx[1]);
        if (my) y = parseFloat(my[1]);
      }

      // Reply out of band, as the read loop would. A probe reports its result
      // first and is then acknowledged like any other line; a probe that never
      // touches reports the failure instead.
      await Promise.resolve();
      if (trimmed.includes('G38.2')) {
        const z = surface(x, y);
        if (z === null) {
          mgr.handleIncomingLine('error:9');
        } else {
          mgr.handleIncomingLine(`[PRB:${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}:1]`);
          mgr.handleIncomingLine('ok');
        }
      } else {
        mgr.handleIncomingLine('ok');
      }
    },
  };

  return {
    sent,
    detach() {
      mgr.transport = null;
      mgr.state.connected = false;
      mgr.state.lastError = undefined;
    },
    lastError: () => mgr.state.lastError,
  };
}

const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

describe('probeGrid against a live machine', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake?.detach();
  });

  it('records what the machine reported, not zeroes', async () => {
    // A bed tilted 0.4 mm across X, measured from a tool datum 12 mm down, so a
    // grid of plain zeroes cannot pass by accident.
    fake = attachFakeGrbl((x) => -12 + (x / 100) * 0.4);
    const grid = await webSerialManager.probeGrid(bounds, 3, 3);

    expect(grid.points[0].map(p => p.z)).toEqual([0, 0.2, 0.4]);
    expect(grid.points[2].map(p => p.z)).toEqual([0, 0.2, 0.4]);
    expect(fake.lastError()).toBeUndefined();
  });

  it('actually probes at each point and retracts', async () => {
    fake = attachFakeGrbl(() => -5);
    await webSerialManager.probeGrid(bounds, 3, 3);

    expect(fake.sent.filter(l => l.includes('G38.2'))).toHaveLength(9);
    // Every probe is bracketed by a positioning move and a retract.
    const probeIdx = fake.sent.findIndex(l => l.includes('G38.2'));
    expect(fake.sent[probeIdx - 1]).toMatch(/^G0 X0\.000 Y0\.000 Z5\.000/);
    // G90 restores absolute mode after the relative probe, then we retract.
    expect(fake.sent[probeIdx + 1]).toBe('G90');
    expect(fake.sent[probeIdx + 2]).toMatch(/^G0 Z5\.000/);
  });

  it('reports points that never made contact instead of recording them as level', async () => {
    fake = attachFakeGrbl((x, y) => (x === 100 && y === 100 ? null : -8));
    const grid = await webSerialManager.probeGrid(bounds, 3, 3);

    expect(grid.points[2][2].z).toBe(0);
    expect(fake.lastError()).toMatch(/no contact at 1 of 9/);
  });

  it('feeds a grid the leveller can actually warp G-code with', async () => {
    fake = attachFakeGrbl((x) => -12 + (x / 100) * 0.4);
    const grid = await webSerialManager.probeGrid(bounds, 3, 3) as ProbeGrid;

    // A cut at the far side of a bed that falls away by 0.4 mm has to follow it.
    const warped = warpGcode('G90\nG0 X0.000 Y50.000 Z0.000\nG1 X100.000 Y50.000 Z0.000 F600', grid);
    const lastZ = [...warped.matchAll(/Z(-?[\d.]+)/g)].pop()![1];
    expect(parseFloat(lastZ)).toBeCloseTo(0.4, 2);
  });
});

describe('zeroZ from a touch plate', () => {
  let fake: ReturnType<typeof attachFakeGrbl>;

  beforeEach(() => {
    fake?.detach();
  });

  it('sets the work offset to the plate thickness once the probe touches', async () => {
    fake = attachFakeGrbl(() => -18.4);
    const result = await webSerialManager.zeroZ(15);

    expect(result.success).toBe(true);
    expect(result.machineZ).toBeCloseTo(-18.4, 3);
    // The persistent G54 offset, not a G92 shift that homing would throw away.
    expect(fake.sent).toContain('G10 L20 P1 Z15.000');
    expect(fake.sent.some(l => l.startsWith('G92'))).toBe(false);
    // And it backs off the plate afterwards.
    expect(fake.sent).toContain('G91 G0 Z5.000');
  });

  it('leaves the datum alone when the probe never makes contact', async () => {
    // Nothing under the tool: the machine reports the probe as failed.
    fake = attachFakeGrbl(() => null);
    const result = await webSerialManager.zeroZ(15);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/never made contact/);
    // Zeroing on a missed probe would tell the machine the stock top is wherever
    // the tool ran to, which is below the bed.
    expect(fake.sent.some(l => l.includes('G10 L20'))).toBe(false);
    expect(fake.lastError()).toMatch(/NOT set/);
  });

  it('jogs relatively so the tool can be driven to the origin', async () => {
    fake = attachFakeGrbl(() => -5);
    await webSerialManager.jog({ x: -1, y: 10 }, 800);

    expect(fake.sent).toContain('$J=G91 G21 X-1.000 Y10.000 F800');
  });
});
