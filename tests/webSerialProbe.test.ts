import { afterEach, describe, it, expect } from 'vitest';
import { webSerialManager } from '../src/utils/webSerialManager';
import { warpGcode, type ProbeGrid } from '../src/utils/meshLeveler';

/**
 * Stands in for a GRBL board on the other end of the serial port: acknowledges
 * every line, and answers a probe with a `[PRB:]` report the way real firmware
 * does. Heights come from `surface`, so a test can state the bed it is probing
 * and check the grid that comes back describes it.
 */
function attachFakeGrbl(surface: (x: number, y: number) => number | null, opts: { prove?: boolean } = {}) {
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
    state: { connected: boolean; lastError?: string; probeCircuitSeen: boolean; probePinActive: boolean };
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

  // The operator touching the tool to the plate: one report with the probe
  // pin asserted, then one with it released. Every probe is refused until the
  // controller has been seen to report the circuit closed, so the tests that
  // are about something else start from a proved one.
  if (opts.prove !== false) proveProbeCircuit();

  function proveProbeCircuit() {
    mgr.handleIncomingLine('<Idle|MPos:0,0,0|WCO:0,0,0|Pn:P>');
    mgr.handleIncomingLine('<Idle|MPos:0,0,0|WCO:0,0,0>');
  }

  return {
    sent,
    proveProbeCircuit,
    report: (line: string) => mgr.handleIncomingLine(line),
    state: () => mgr.state,
    detach() {
      mgr.transport = null;
      mgr.state.connected = false;
      mgr.state.lastError = undefined;
      // As a disconnect would: the proof belonged to this fake.
      mgr.state.probeCircuitSeen = false;
      mgr.state.probePinActive = false;
    },
    lastError: () => mgr.state.lastError,
  };
}

const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

// One fake at a time, taken down after every test whichever block it was in,
// so nothing one test proved about its machine reaches the next.
let fake: ReturnType<typeof attachFakeGrbl>;
afterEach(() => {
  fake?.detach();
});

describe('probeGrid against a live machine', () => {
  it('records what the machine reported, not zeroes', async () => {
    // A bed tilted 0.4 mm across X, measured from a tool datum 12 mm down, so a
    // grid of plain zeroes cannot pass by accident.
    fake = attachFakeGrbl((x) => -12 + (x / 100) * 0.4);
    const grid = await webSerialManager.probeGrid(bounds, 3, 3);

    expect(grid.points[0].map(p => p.z)).toEqual([0, 0.2, 0.4]);
    expect(grid.points[2].map(p => p.z)).toEqual([0, 0.2, 0.4]);
    expect(fake.lastError()).toBeUndefined();
  });

  it('probes each point with relative Z moves only, never an absolute one', async () => {
    fake = attachFakeGrbl(() => -5);
    await webSerialManager.probeGrid(bounds, 3, 3);

    expect(fake.sent.filter(l => l.includes('G38.2'))).toHaveLength(9);

    // The safety property: not one absolute Z move in the whole run. An
    // absolute `G0 Z<n>` trusts the work datum, and a wrong datum turns it into
    // a plunge through the work. Every Z move here is relative (G91).
    const absoluteZ = fake.sent.filter(l => /^G0\s+Z/.test(l));
    expect(absoluteZ).toEqual([]);

    // Each point is an XY-only traverse at the current height, a relative
    // plunge, G90 to restore absolute, then a relative lift clear.
    const probeIdx = fake.sent.findIndex(l => l.includes('G38.2'));
    expect(fake.sent[probeIdx - 1]).toMatch(/^G0 X0\.000 Y0\.000 F3000/);
    expect(fake.sent[probeIdx]).toMatch(/^G91 G38\.2 Z-10\.000 F50/);
    expect(fake.sent[probeIdx + 1]).toBe('G90');
    expect(fake.sent[probeIdx + 2]).toMatch(/^G91 G0 Z5\.000/);
  });

  it('stops on the first missed contact instead of driving down at every point', async () => {
    // The probe input never triggers — a clip that fell off, a broken wire, a
    // non-conductive surface. Recording the miss and moving on used to drive
    // the tool down at each of the remaining points in turn; it has to stop at
    // the first miss instead, leaving the machine for the operator to recover.
    fake = attachFakeGrbl(() => null);

    await expect(webSerialManager.probeGrid(bounds, 3, 3)).rejects.toThrow(/no contact/i);

    // Exactly one probe move went out: it did not plunge again after the miss.
    expect(fake.sent.filter(l => l.includes('G38.2'))).toHaveLength(1);
    expect(fake.lastError()).toMatch(/made no contact/i);
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

describe('no probe runs on a circuit nobody has proved', () => {
  /*
   * A probe is a G38.2, which stops when the probe input closes — and only
   * then. The one way it drives the tool through the work is a circuit that
   * never closes, which the controller cannot tell from "not there yet" until
   * the search runs out. So the circuit has to be seen closed, by hand, before
   * the first stab of a connection.
   */
  it('refuses to zero Z until the probe input has been seen closed', async () => {
    fake = attachFakeGrbl(() => -5, { prove: false });
    const result = await webSerialManager.zeroZ(12);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/has not been proved/);
    expect(fake.lastError()).toMatch(/has not been proved/);
    expect(fake.sent.some(l => l.includes('G38.2'))).toBe(false);
  });

  it('refuses the bed probe and a bare probe on the same grounds', async () => {
    fake = attachFakeGrbl(() => -5, { prove: false });
    await expect(webSerialManager.probeGrid(bounds, 2, 2)).rejects.toThrow(/has not been proved/);
    await expect(webSerialManager.probePoint()).rejects.toThrow(/has not been proved/);
    expect(fake.sent.some(l => l.includes('G38.2'))).toBe(false);
  });

  it('refuses while the input reads closed with nothing touching', async () => {
    fake = attachFakeGrbl(() => -5, { prove: false });
    fake.report('<Idle|MPos:0,0,0|WCO:0,0,0|Pn:P>');
    expect(fake.state().probeCircuitSeen).toBe(true);
    expect(fake.state().probePinActive).toBe(true);

    const result = await webSerialManager.zeroZ(12);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already reads closed/);
    await expect(webSerialManager.probeGrid(bounds, 2, 2)).rejects.toThrow(/already reads closed/);
    expect(fake.sent.some(l => l.includes('G38.2'))).toBe(false);
  });

  it('probes once the circuit has closed and opened again', async () => {
    fake = attachFakeGrbl(() => -5, { prove: false });
    fake.proveProbeCircuit();
    expect(fake.state().probePinActive).toBe(false);

    const result = await webSerialManager.zeroZ(12);
    expect(result.success).toBe(true);
    expect(fake.sent).toContain('G10 L20 P1 Z12.000');
  });

  it('forgets the proof when the machine goes away', async () => {
    fake = attachFakeGrbl(() => -5);
    expect(fake.state().probeCircuitSeen).toBe(true);
    await webSerialManager.disconnect();
    expect(fake.state().probeCircuitSeen).toBe(false);

    // The next machine on the cable has to prove its own.
    fake = attachFakeGrbl(() => -5, { prove: false });
    const result = await webSerialManager.zeroZ(12);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/has not been proved/);
  });
});

describe('how far a probe searches', () => {
  it('zeroes with a short search: the tool is parked close, and an open circuit is a plunge', async () => {
    fake = attachFakeGrbl(() => -5);
    await webSerialManager.zeroZ(12);
    expect(fake.sent.find(l => l.includes('G38.2'))).toBe('G91 G38.2 Z-10.000 F50');
  });
});

describe('zeroZ from a touch plate', () => {
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
