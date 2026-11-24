import { describe, it, expect } from 'vitest';
import { clockMoves, programTimeline, type ClockedMove, type TimedMove } from '../src/utils/timeEstimate';
import {
  trackPlayhead,
  PLAYHEAD_START,
  BACKWARD_CONFIRM_REPORTS,
  type PlayheadState,
} from '../src/utils/livePlayhead';
import { californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS } from '../src/presets/californiaRelief';
import {
  APP_RELIEF_DEFAULTS,
  DEFAULT_RELIEF_OPTIONS,
  deriveReliefFeeds,
  generateReliefCarveGcode,
  recommendReliefTooling,
} from '../src/utils/reliefCarveExporter';
import { buildPreviewPath } from '../src/utils/toolpathPreviewPath';

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

  it('does not skip ahead to a later pass that is only a hair closer', () => {
    // A finishing pass along y = 0 at z -1, then twenty other moves, then a
    // second pass over the same line 0.04 mm lower. The report sits between
    // them, just nearer the later one, as a decimated preview leaves it.
    const raw: TimedMove[] = [{ x1: 0, y1: 0, z1: -1, x2: 60, y2: 0, z2: -1, feed: 800, rapid: false }];
    for (let k = 0; k < 20; k++) raw.push({ x1: 60, y1: 10 + k, z1: -1, x2: 0, y2: 10 + k, z2: -1, feed: 800, rapid: false });
    raw.push({ x1: 0, y1: 0, z1: -1.04, x2: 60, y2: 0, z2: -1.04, feed: 800, rapid: false });
    const path = clockMoves(raw);

    const state = trackPlayhead(path, 30, 0, -1.025, PLAYHEAD_START, []);
    expect(state.index).toBe(0);
  });

  it('still moves onto the next raster line when the tool is on it', () => {
    // Lines 0.2 mm apart: the one being cut is nearer by a full stepover.
    const raw: TimedMove[] = [];
    for (let k = 0; k < 10; k++) {
      raw.push({ x1: k % 2 ? 60 : 0, y1: k * 0.2, z1: -1, x2: k % 2 ? 0 : 60, y2: k * 0.2, z2: -1, feed: 800, rapid: false });
    }
    const path = clockMoves(raw);
    let state: PlayheadState = PLAYHEAD_START;
    for (let k = 0; k < 10; k++) {
      state = trackPlayhead(path, 30, k * 0.2, -1, state, []);
      expect(state.index).toBe(k);
    }
  });

  it('tracks the California relief carve through roughing and post-M6 finishing without jumping passes', () => {
    const baseOpts = { ...DEFAULT_RELIEF_OPTIONS, ...APP_RELIEF_DEFAULTS, ...CALIFORNIA_RELIEF_SETTINGS };
    const initial = generateReliefCarveGcode(californiaReliefPreset, baseOpts);
    expect(initial.success).toBe(true);

    const rec = recommendReliefTooling({
      reliefDepthMm: initial.reliefDepthMm,
      detailMm: initial.detailMm,
      planWidthMm: initial.carveBounds.maxX - initial.carveBounds.minX,
      planDepthMm: initial.carveBounds.maxY - initial.carveBounds.minY,
      material: baseOpts.material,
    });
    const feeds = deriveReliefFeeds({
      material: baseOpts.material,
      finishingToolDiaMm: rec.finishingToolDiaMm ?? baseOpts.finishingToolDiaMm,
      finishingFlutes: rec.finishingFlutes ?? baseOpts.finishingFlutes,
      roughingToolDiaMm: rec.roughingToolDiaMm ?? baseOpts.roughingToolDiaMm,
      roughingFlutes: rec.roughingFlutes ?? baseOpts.roughingFlutes,
      carveDepthMm: baseOpts.carveDepthMm,
      finishingToolType: rec.finishingToolType ?? baseOpts.finishingToolType,
    });
    const opts = { ...baseOpts, ...rec, ...feeds };
    const carve = generateReliefCarveGcode(californiaReliefPreset, opts);
    expect(carve.success).toBe(true);
    expect(carve.toolChange).toBe(true);
    expect(carve.finishingZOffsetMm).toBeLessThan(-10);

    const preview = buildPreviewPath(carve, opts);
    const lastRough = [...preview.moves].reverse().find((m) => m.pass === 'roughing');
    expect(lastRough).toBeDefined();
    expect(lastRough!.t1).toBeCloseTo(carve.roughingTimeSeconds, 1);

    const tl = programTimeline(carve.gcode.split('\n'), { profile: opts.motionProfile });
    let state: PlayheadState = PLAYHEAD_START;
    let maxErrRough = 0;
    let maxErrFin = 0;
    let mIdx = 0;
    const samples = 250;
    for (let s = 0; s <= samples; s++) {
      const t = (s / samples) * tl.total;
      while (mIdx + 1 < tl.moves.length && tl.moves[mIdx].t1 < t) mIdx++;
      const m = tl.moves[mIdx];
      const frac = m.t1 > m.t0 ? Math.min(1, Math.max(0, (t - m.t0) / (m.t1 - m.t0))) : 1;
      const x = m.x1 + (m.x2 - m.x1) * frac;
      const y = m.y1 + (m.y2 - m.y1) * frac;
      const wposZ = m.z1 + (m.z2 - m.z1) * frac;
      const progressSec = (t / tl.total) * preview.seconds;
      const liveZ = wposZ + (carve.finishingZOffsetMm && progressSec > carve.roughingTimeSeconds + 1e-3 ? carve.finishingZOffsetMm : 0);
      state = trackPlayhead(preview.moves, x, y, liveZ, state, [progressSec]);
      const err = Math.abs(state.clock - t);
      if (t <= carve.roughingTimeSeconds) maxErrRough = Math.max(maxErrRough, err);
      else maxErrFin = Math.max(maxErrFin, err);
    }

    expect(maxErrRough).toBeLessThan(tl.total * 0.1);
    expect(maxErrFin).toBeLessThan(tl.total * 0.12);
    expect(state.clock / preview.seconds).toBeGreaterThan(0.95);
  });
});
