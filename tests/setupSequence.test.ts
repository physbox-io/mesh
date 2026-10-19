import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webSerialManager, type JobSetup } from '../src/utils/webSerialManager';

/*
 * A part machined from more than one face: between setups the block is lifted,
 * turned and put back, so every zero the last setup ran on is stale. Side B
 * could start on side A's datum before this; now a later setup refuses until
 * it has been zeroed again, and only from the screen at the machine.
 */

type Internals = {
  transport: { label: string; writeLine: (l: string) => Promise<void>; writeRealtime: (b: number) => Promise<void>; open: () => Promise<void>; close: () => Promise<void>; runJob?: unknown } | null;
  state: Record<string, unknown>;
  parseLine: (line: string) => void;
  runningSetup: JobSetup | null;
  onJobFinished: () => Record<string, unknown>;
  zZeroedAt: number;
  xyZeroedAt: number;
  setupEndedAt: number;
  datumSeq: number;
};
const mgr = webSerialManager as unknown as Internals;

const sequence = (index: number, extra: Partial<JobSetup> = {}): JobSetup => ({
  sequenceId: 's1', index, of: 2, locate: 'knownSpot', ...extra,
});

/** Side A runs to its end, as the streamer reports it. */
function finishSetup(setup: JobSetup) {
  mgr.runningSetup = setup;
  const patch = mgr.onJobFinished();
  Object.assign(mgr.state, patch);
  return patch;
}

describe('a setup after the first', () => {
  beforeEach(() => {
    mgr.state.connected = true;
    mgr.state.status = 'IDLE';
    mgr.state.lastError = undefined;
    mgr.state.needsZZero = false;
    mgr.zZeroedAt = mgr.xyZeroedAt = mgr.setupEndedAt = mgr.datumSeq = 0;
    mgr.transport = {
      label: 'Fake GRBL',
      async open() {},
      async close() {},
      async writeRealtime() {},
      async writeLine() {
        setTimeout(() => mgr.parseLine('ok'), 0);
      },
    };
  });
  afterEach(() => {
    mgr.transport = null;
    mgr.state.connected = false;
    mgr.state.status = 'DISCONNECTED';
    mgr.state.setupPending = null;
  });

  it('leaves the next setup pending and Z untrusted when the one before it ends', () => {
    const patch = finishSetup(sequence(1));
    expect(patch.setupPending).toEqual({ sequenceId: 's1', next: 2, of: 2, locate: 'knownSpot' });
    expect(patch.needsZZero).toBe(true);
    // The last setup clears it.
    expect(finishSetup(sequence(2)).setupPending).toBeNull();
  });

  it('refuses to start until Z and then X and Y are zeroed again', async () => {
    await webSerialManager.zeroAllHere();
    finishSetup(sequence(1));

    // Z untrusted after the turn: the ordinary Z guard says so first.
    expect(await webSerialManager.runJob('G0 X0', { setup: sequence(2) })).toBeNull();
    expect(String(mgr.state.lastError)).toMatch(/Z zero/);

    await webSerialManager.zeroZHere();
    expect(await webSerialManager.runJob('G0 X0', { setup: sequence(2) })).toBeNull();
    expect(String(mgr.state.lastError)).toMatch(/zero X and Y/);
  });

  it('starts once both are re-taken', async () => {
    finishSetup(sequence(1));
    await webSerialManager.zeroZHere();
    await webSerialManager.zeroXY();
    const refusal = (mgr as unknown as { refuseSetup: (s: JobSetup, o: string, r: boolean) => string | null })
      .refuseSetup(sequence(2), 'ui', false);
    expect(refusal).toBeNull();
  });

  it('on pins wants Z and the operator’s word that the block is seated, not X and Y', async () => {
    const pins = (seated: boolean) => sequence(2, { locate: 'pins', pinsSeated: seated });
    const refuse = (s: JobSetup) =>
      (mgr as unknown as { refuseSetup: (s: JobSetup, o: string, r: boolean) => string | null }).refuseSetup(s, 'ui', false);
    finishSetup(sequence(1, { locate: 'pins' }));
    expect(refuse(pins(true))).toMatch(/Z zero/);
    await webSerialManager.zeroZHere();
    expect(refuse(pins(false))).toMatch(/pins/);
    expect(refuse(pins(true))).toBeNull();
  });

  it('is never started by an agent or from another device', async () => {
    finishSetup(sequence(1));
    await webSerialManager.zeroZHere();
    await webSerialManager.zeroXY();
    expect(await webSerialManager.runJob('G0 X0', { setup: sequence(2), origin: 'mcp' })).toBeNull();
    expect(String(mgr.state.lastError)).toMatch(/someone at the machine/);
    const refuse = (mgr as unknown as { refuseSetup: (s: JobSetup, o: string, r: boolean) => string | null }).refuseSetup;
    expect(refuse.call(mgr, sequence(2), 'ui', true)).toMatch(/someone at the machine/);
  });

  it('needs zeroing in this session after a reload, which forgets the setup that ended', () => {
    // A fresh connection: nothing zeroed, nothing ended.
    const refuse = (mgr as unknown as { refuseSetup: (s: JobSetup, o: string, r: boolean) => string | null }).refuseSetup;
    expect(refuse.call(mgr, sequence(2), 'ui', false)).toMatch(/Z zero/);
  });

  it('leaves the first setup and ordinary jobs alone', () => {
    const refuse = (mgr as unknown as { refuseSetup: (s: JobSetup | undefined, o: string, r: boolean) => string | null }).refuseSetup;
    expect(refuse.call(mgr, sequence(1), 'mcp', true)).toBeNull();
    expect(refuse.call(mgr, undefined, 'mcp', true)).toBeNull();
  });
});
