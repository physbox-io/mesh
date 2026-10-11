import { describe, it, expect } from 'vitest';
import { clockMoves, type ClockedMove, type TimedMove } from '../src/utils/timeEstimate';
import {
  trackPlayhead,
  PLAYHEAD_START,
  BACKWARD_CONFIRM_REPORTS,
  type PlayheadState,
} from '../src/utils/livePlayhead';

/**
 * Two roughing layers over the same 60 x 60 mm, then a tight finishing raster
 * over it again: every point on the stock is passed three times, a stepdown or
 * a stepover from somewhere else on the path.
 */
function reliefLikePath(): ClockedMove[] {
  const raw: TimedMove[] = [];
  let at = { x: 0, y: 0, z: 5 };
  const to = (x: number, y: number, z: number, rapid = false) => {
    raw.push({ x1: at.x, y1: at.y, z1: at.z, x2: x, y2: y, z2: z, feed: rapid ? 3000 : 800, rapid });
    at = { x, y, z };
  };
  const raster = (z: number, stepover: number) => {
    to(at.x, at.y, 5, true);
    to(0, 0, 5, true);
    to(0, 0, z);
    for (let y = 0, row = 0; y <= 60; y += stepover, row++) {
      to(row % 2 ? 0 : 60, y, z);
      if (y + stepover <= 60) to(row % 2 ? 0 : 60, y + stepover, z);
    }
  };
  raster(-2, 3);
  raster(-4, 3);
  raster(-4.5, 1);
  return clockMoves(raw);
}

/** Where the tool is at job time `t`. */
function positionAt(moves: ClockedMove[], t: number) {
  const m = moves.find((mv) => mv.t1 >= t) ?? moves[moves.length - 1];
  const f = m.t1 > m.t0 ? Math.min(1, Math.max(0, (t - m.t0) / (m.t1 - m.t0))) : 1;
  return { x: m.x1 + (m.x2 - m.x1) * f, y: m.y1 + (m.y2 - m.y1) * f, z: m.z1 + (m.z2 - m.z1) * f };
}

describe('trackPlayhead', () => {
  const moves = reliefLikePath();
  const total = moves[moves.length - 1].t1;

  it('only moves forwards through a noisy run, with samples off the path', () => {
    let state: PlayheadState = PLAYHEAD_START;
    let rnd = 12345;
    const noise = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 0.6;

    const steps = 600;
    for (let k = 1; k <= steps; k++) {
      const t = (k / steps) * total;
      let p = positionAt(moves, t);
      // Every 37th report is well above the path, as a hop between passes is
      // when the preview models it at a different height. The old whole-path
      // search sent these to whichever pass happened to lie nearest.
      if (k % 37 === 0) p = { x: p.x, y: p.y, z: p.z + 20 };
      const before = state.clock;
      state = trackPlayhead(moves, p.x + noise(), p.y + noise(), p.z + noise() * 0.1, state, [t]);
      expect(state.clock).toBeGreaterThanOrEqual(before);
      // Within a pass or so of the truth, never on another layer.
      expect(Math.abs(state.clock - t)).toBeLessThan(total * 0.05);
    }
  });

  it('holds rather than jumping to the nearest pass anywhere on the path', () => {
    // Part-way through the finishing raster.
    const t = total * 0.8;
    const p = positionAt(moves, t);
    const state = trackPlayhead(moves, p.x, p.y, p.z, PLAYHEAD_START, [t]);
    expect(Math.abs(state.clock - t)).toBeLessThan(total * 0.02);

    // A report over the first roughing layer's start, with no anchor near it:
    // the old whole-path search jumped straight there.
    const early = positionAt(moves, total * 0.05);
    const held = trackPlayhead(moves, early.x, early.y, early.z + 20, state, [t]);
    expect(held.clock).toBe(state.clock);
  });

  it('follows a sustained step backwards, as a resume does, but not a single stray report', () => {
    const t = total * 0.7;
    const p = positionAt(moves, t);
    let state = trackPlayhead(moves, p.x, p.y, p.z, PLAYHEAD_START, [t]);
    const ahead = state.clock;

    // A resume picks up a little before where the job stopped.
    const resumeAt = total * 0.6;
    const q = positionAt(moves, resumeAt);

    state = trackPlayhead(moves, q.x, q.y, q.z, state, [resumeAt]);
    expect(state.clock).toBe(ahead);

    for (let k = 1; k < BACKWARD_CONFIRM_REPORTS; k++) {
      state = trackPlayhead(moves, q.x, q.y, q.z, state, [resumeAt]);
    }
    expect(Math.abs(state.clock - resumeAt)).toBeLessThan(total * 0.02);
  });
});
