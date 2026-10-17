import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { programTimeline, type ProgramTimeline } from '../src/utils/timeEstimate';
import { CUT_START, lineAtSeconds, locateCut, secondsAtLine, type CutState } from '../src/utils/jobProgress';
import { prepareJobLines, webSerialManager } from '../src/utils/webSerialManager';

/*
 * A relief in miniature: two roughing layers over the same XY a millimetre
 * apart, each a serpentine of rows half a millimetre apart, then a tool change
 * and a finishing pass over the same ground again. Every point on it is within
 * a millimetre or two of some other part of the program, which is what made a
 * search of the whole path jump between passes.
 */
function relief(): string {
  const out = ['G21 G90', 'M3 S10000', 'G0 Z5'];
  const rows = (z: number, feed: number) => {
    out.push('G0 X0 Y0', `G1 Z${z} F300`);
    for (let r = 0; r < 6; r++) {
      const y = r * 0.5;
      if (r > 0) out.push(`G1 Y${y} F${feed}`);
      for (let s = 1; s <= 20; s++) {
        const x = r % 2 === 0 ? s : 20 - s;
        out.push(`G1 X${x} F${feed}`);
      }
    }
    out.push('G0 Z5');
  };
  rows(-1, 1200);
  rows(-2, 1200);
  out.push('M5', 'T2 M6 (ball nose)', 'M3 S16000');
  rows(-2.5, 1500);
  out.push('M5', 'M30');
  return out.join('\n');
}

const LINES = prepareJobLines(relief()).map((l) => l.code);
const TL = programTimeline(LINES);

/** The line each move came from, and the move each line's first block is. */
const pointAfterMove = (tl: ProgramTimeline, k: number) => {
  const m = tl.moves[k];
  return { x: m.x2, y: m.y2, z: m.z2 };
};

describe('placing the cutter from acks and position', () => {
  it('follows the true move exactly, however far ahead the acks are', () => {
    let state: CutState = CUT_START;
    let rng = 7;
    const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let done = 1; done < TL.moves.length; done++) {
      const truth = TL.moves[done - 1].t1;
      // The acks run ahead of the cut by however much is in the planner, and a
      // grblHAL planner holds more than twice a stock board's.
      const lead = Math.floor(rand() * 40);
      const ackedMove = Math.min(TL.moves.length - 1, done + lead);
      const acked = TL.moves[ackedMove].line + 1;
      state = locateCut(TL, { acked, plannerBlocksInUse: null, floorLine: 0, pos: pointAfterMove(TL, done - 1) }, state);
      expect(state.seconds).toBeCloseTo(truth, 6);
    }
  });

  it('does not go back to an earlier pass that the tool happens to be over', () => {
    // Well into the second layer.
    const k = TL.moves.findIndex((m) => m.z2 === -2 && m.x2 === 10);
    const acked = TL.moves[k].line + 1;
    const here = locateCut(TL, { acked, plannerBlocksInUse: 0, floorLine: 0, pos: pointAfterMove(TL, k) }, CUT_START);
    // The first layer's matching point, a millimetre up: still in snap range of
    // the earlier pass, and nowhere near where the job is.
    const p = pointAfterMove(TL, k);
    const next = locateCut(TL, { acked, plannerBlocksInUse: 0, floorLine: 0, pos: { ...p, z: -1 } }, here);
    expect(next.seconds).toBe(here.seconds);
  });

  it('stands on the floor the planner sets when the position says nothing', () => {
    const acked = TL.moves[40].line + 1;
    // Lifted off the path entirely: only the acks and `Bf:` are left.
    const off = { x: 500, y: 500, z: 500 };
    const exact = locateCut(TL, { acked, plannerBlocksInUse: 5, floorLine: 0, pos: off }, CUT_START);
    expect(exact.seconds).toBeCloseTo(TL.moves[TL.moveStart[acked] - 6].t0, 9);
    const assumed = locateCut(TL, { acked, plannerBlocksInUse: null, floorLine: 0, pos: off }, CUT_START);
    expect(assumed.seconds).toBeLessThanOrEqual(exact.seconds);
    // Drained: everything acked has run.
    const drained = locateCut(TL, { acked, plannerBlocksInUse: 0, floorLine: 0, pos: null }, CUT_START);
    expect(drained.seconds).toBeCloseTo(TL.lineEnd[acked - 1], 9);
  });

  it('never claims more than GRBL has been given', () => {
    const acked = TL.moves[30].line + 1;
    const ahead = pointAfterMove(TL, 60);
    const s = locateCut(TL, { acked, plannerBlocksInUse: 0, floorLine: 0, pos: ahead }, CUT_START);
    expect(s.seconds).toBeLessThanOrEqual(TL.lineEnd[acked - 1]);
  });

  it('neither lurches nor stalls through a finishing raster, on any planner depth', () => {
    // What a hybrid finishing pass looks like on mostly uncut ground: rows
    // 0.4 mm apart, each a few slivers a millimetre long, every one entered and
    // left with a retract and a rapid across the stock.
    const out = ['G21 G90', 'M3 S16000', 'G0 Z5'];
    for (let r = 0; r < 40; r++) {
      const y = (r * 0.4).toFixed(1);
      const xs = r % 2 === 0 ? [5, 30, 60, 85] : [85, 60, 30, 5];
      for (const x0 of xs) {
        const dir = r % 2 === 0 ? 1 : -1;
        out.push(`G0 X${x0} Y${y}`, 'G0 Z0.5', `G1 Z-0.1 F480`);
        for (let s = 1; s <= 3; s++) out.push(`G1 X${x0 + dir * s * 0.4} F1440`);
        out.push('G0 Z1');
      }
    }
    const tl = programTimeline(prepareJobLines(out.join('\n')).map((l) => l.code));

    for (const depth of [8, 15, 32, 48]) {
      let state: CutState = CUT_START;
      let mi = 0;
      let prevErr = 0;
      for (let t = 0; t < tl.total; t += 0.1) {
        while (mi < tl.moves.length - 1 && tl.moves[mi].t1 < t) mi++;
        const m = tl.moves[mi];
        const f = m.t1 > m.t0 ? Math.min(1, (t - m.t0) / (m.t1 - m.t0)) : 1;
        const pos = { x: m.x1 + (m.x2 - m.x1) * f, y: m.y1 + (m.y2 - m.y1) * f, z: m.z1 + (m.z2 - m.z1) * f };
        const acked = tl.moves[Math.min(tl.moves.length - 1, mi + depth)].line + 1;
        // No `Bf:`: the planner's depth is not known.
        state = locateCut(tl, { acked, plannerBlocksInUse: null, floorLine: 0, pos }, state);
        const err = state.seconds - t;
        expect(err, `depth ${depth} at ${t.toFixed(1)} s`).toBeLessThan(0.05);
        expect(err - prevErr, `depth ${depth} at ${t.toFixed(1)} s`).toBeGreaterThan(-0.15);
        prevErr = err;
      }
    }
  });

  it('reads the line being cut off the clock, and a resume line back onto it', () => {
    const line = TL.moves[50].line;
    expect(lineAtSeconds(TL, (TL.moves[50].t0 + TL.moves[50].t1) / 2)).toBe(line);
    expect(lineAtSeconds(TL, secondsAtLine(TL, line))).toBeLessThanOrEqual(line);
  });
});

/**
 * A GRBL board with a planner.
 *
 * Lines wait in the serial buffer until there is a planner slot for them, are
 * acked as they are planned, and are cut one block per `tick`. That lag between
 * the ack and the cut is the whole reason the sent line could not be the
 * progress, so the fake has to have it.
 */
function attachPlannerGrbl({ reportBf }: { reportBf: boolean }) {
  const mgr = webSerialManager as unknown as {
    transport: unknown;
    state: Record<string, unknown>;
    parseLine: (line: string) => void;
    lastWco: { x: number; y: number; z: number } | undefined;
  };
  const PLANNER = 15;
  const rx: string[] = [];
  const planner: Array<{ x: number; y: number; z: number }> = [];
  const pos = { x: 0, y: 0, z: 0 };
  /** Where the last planned block ends, which is where the next one starts from. */
  const plannedTo = { x: 0, y: 0, z: 0 };
  let executed = 0;

  mgr.state.connected = true;
  mgr.state.status = 'IDLE';
  mgr.state.lastError = undefined;
  mgr.state.needsZZero = false;
  mgr.state.elapsedSeconds = 0;
  // As a fresh connection leaves it: work position read as machine position.
  mgr.lastWco = { x: 0, y: 0, z: 0 };

  const report = () => {
    const bf = reportBf ? `|Bf:${PLANNER - planner.length},128` : '';
    mgr.parseLine(
      `<${planner.length ? 'Run' : 'Idle'}|MPos:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)}${bf}|FS:0,0>`
    );
  };

  /** Moves serial-buffer lines into the planner while there is room, acking each. */
  const plan = () => {
    while (rx.length) {
      const line = rx[0].toUpperCase();
      const motion = /\bG0*[01]\b/.test(line) && /[XYZ]-?\d/.test(line);
      if (motion && planner.length >= PLANNER) return;
      // A dwell is only acked once the planner has run dry.
      if (/\bG0*4\b/.test(line) && planner.length > 0) return;
      rx.shift();
      if (motion) {
        const to = { ...plannedTo };
        for (const [, axis, v] of line.matchAll(/([XYZ])(-?\d*\.?\d+)/g)) {
          to[axis.toLowerCase() as 'x' | 'y' | 'z'] = parseFloat(v);
        }
        const moved = to.x !== plannedTo.x || to.y !== plannedTo.y || to.z !== plannedTo.z;
        Object.assign(plannedTo, to);
        // A zero-length move is dropped by GRBL, and by the timeline too.
        if (moved) planner.push(to);
      }
      mgr.parseLine('ok');
    }
  };

  mgr.transport = {
    label: 'Fake GRBL with a planner',
    async open() {},
    async close() {},
    async writeRealtime(byte: number) {
      if (byte === 0x3f) setTimeout(report, 0);
      // A soft reset: the board reboots and says so, and the manager waits for that.
      if (byte === 0x18) setTimeout(() => mgr.parseLine("Grbl 1.1h ['$' for help]"), 0);
    },
    async writeLine(line: string) {
      if (line.trim()) rx.push(line.trim());
    },
  };

  return {
    /** Cuts one block, plans what fits, and reports. */
    step() {
      plan();
      const block = planner.shift();
      if (block) {
        Object.assign(pos, block);
        executed++;
      }
      plan();
      report();
    },
    plan,
    report,
    get executed() { return executed; },
    detach() {
      mgr.transport = null;
      mgr.state.connected = false;
      mgr.state.status = 'DISCONNECTED';
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const seconds = () => (webSerialManager.getState().progressPercent / 100) * TL.total;
const M6_LINE = LINES.findIndex((l) => /\bM6\b/.test(l));
/** Blocks before the tool change, which is where the first run stops. */
const BLOCKS_BEFORE_M6 = TL.moveStart[M6_LINE];

for (const reportBf of [true, false]) {
  describe(`job progress on a streaming job (${reportBf ? 'with' : 'without'} Bf: in the report)`, () => {
    let fake: ReturnType<typeof attachPlannerGrbl>;
    beforeEach(() => {
      fake = attachPlannerGrbl({ reportBf });
    });
    afterEach(async () => {
      await webSerialManager.cancelJob();
      fake.detach();
    });

    it('moves only forward, and with the cutter rather than the sends', async () => {
      webSerialManager.startJob(relief());
      // The relief's timeline was built against the default profile, as here.
      let last = 0;
      // The stream is asynchronous, so each step yields to let it write. Capped,
      // so a stream that stalls fails here rather than hanging the run.
      for (let guard = 0; fake.executed < BLOCKS_BEFORE_M6; guard++) {
        expect(guard).toBeLessThan(BLOCKS_BEFORE_M6 * 4);
        await settle();
        fake.step();
        // Acks are credited a microtask after their `ok`, so a report in the
        // same turn sees the count before them; the next report, as here, does not.
        await settle();
        fake.report();
        const s = seconds();
        const truth = fake.executed > 0 ? TL.moves[fake.executed - 1].t1 : 0;
        expect(s).toBeGreaterThanOrEqual(last);
        // To the rounding of a percentage to two places.
        expect(Math.abs(s - truth)).toBeLessThanOrEqual(TL.total * 1e-4 + 1e-6);
        last = s;
      }
    });

    it('stands still at the tool change, on the tool change line', async () => {
      webSerialManager.startJob(relief());
      for (let i = 0; i < BLOCKS_BEFORE_M6 + 5; i++) {
        fake.step();
        await settle();
      }
      // Let the drain and the lift that follow it run.
      for (let i = 0; i < 40; i++) {
        fake.step();
        await settle();
      }
      const state = webSerialManager.getState();
      expect(state.status).toBe('PAUSED_TOOL');
      expect(state.currentLine).toBe(M6_LINE);
      expect(seconds()).toBeCloseTo(secondsAtLine(TL, M6_LINE), 1);
      const held = state.progressPercent;
      for (let i = 0; i < 10; i++) fake.step();
      expect(webSerialManager.getState().progressPercent).toBe(held);
    });
  });
}

describe('job progress on a resumed job', () => {
  let fake: ReturnType<typeof attachPlannerGrbl>;
  beforeEach(() => {
    fake = attachPlannerGrbl({ reportBf: false });
  });
  afterEach(async () => {
    await webSerialManager.cancelJob();
    fake.detach();
  });

  it('starts at the share of the job its line had reached, not at the old clock', async () => {
    webSerialManager.startJob(relief());
    for (let i = 0; i < 30; i++) {
      await settle();
      fake.step();
    }
    await webSerialManager.cancelJob();
    const fromLine = TL.moves[200].line;
    const r = webSerialManager.resumeFromLine(fromLine);
    expect(r.ok).toBe(true);
    expect(seconds()).toBeCloseTo(secondsAtLine(TL, fromLine), 1);
    expect(webSerialManager.getState().currentLine).toBe(fromLine);
  });
});
