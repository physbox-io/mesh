import { describe, it, expect } from 'vitest';
import {
  estimateGcodeTime,
  estimateMoveSeconds,
  clockMoves,
  moveSeconds,
  formatDuration,
  programTimeline,
  type TimedMove,
} from '../src/utils/timeEstimate';
import { prepareJobLines } from '../src/utils/webSerialManager';
import { DEFAULT_MOTION_PROFILE } from '../src/utils/motionProfile';

/** A straight run of `n` moves of `step` mm along X at `feed` mm/min. */
function raster(n: number, step: number, feed: number, reverseEvery = 0): TimedMove[] {
  const out: TimedMove[] = [];
  let x = 0;
  let y = 0;
  let dir = 1;
  for (let i = 0; i < n; i++) {
    if (reverseEvery > 0 && i > 0 && i % reverseEvery === 0) {
      // End of a scanline: step across and turn round, which is the move that
      // costs a raster all its speed.
      out.push({ x1: x, y1: y, z1: 0, x2: x, y2: y + step, z2: 0, feed, rapid: false });
      y += step;
      dir = -dir;
    }
    out.push({ x1: x, y1: y, z1: 0, x2: x + step * dir, y2: y, z2: 0, feed, rapid: false });
    x += step * dir;
  }
  return out;
}

describe('trapezoidal move timing', () => {
  it('reaches the programmed feed on a long move and takes about distance/feed', () => {
    // 300 mm at 3000 mm/min is 6 s at speed; the ramps at either end add a
    // fraction of a second and no more.
    const seconds = estimateMoveSeconds([
      { x1: 0, y1: 0, z1: 0, x2: 300, y2: 0, z2: 0, feed: 3000, rapid: false },
    ]);
    expect(seconds).toBeGreaterThan(6);
    expect(seconds).toBeLessThan(6.4);
  });

  it('a move too short to reach its feed runs at the acceleration limit, not the feed', () => {
    // From rest to rest over 0.1 mm. distance/feed would say 0.002 s; the axes
    // physically cannot do it in less than the triangular profile allows.
    const naive = (0.1 / 3000) * 60;
    const a = DEFAULT_MOTION_PROFILE.accel.x;
    const real = moveSeconds(0.1, 0, 0, 3000 / 60, a);
    expect(real).toBeGreaterThan(naive * 5);
    // 2 * sqrt(d / a) for a symmetric triangle.
    expect(real).toBeCloseTo(2 * Math.sqrt(0.1 / a), 6);
  });

  it('a raster of tiny steps is governed by the block rate, not by the feedrate', () => {
    // 4000 x 0.05 mm steps — a finishing pass in miniature. The axes could hold
    // 1500 mm/min all the way along a straight scanline; the controller cannot
    // take 30,000 instructions a second to let them, and that floor is what
    // decides the job.
    const moves = raster(4000, 0.05, 1500);
    const length = moves.reduce((d, m) => d + Math.hypot(m.x2 - m.x1, m.y2 - m.y1), 0);
    const naive = (length / 1500) * 60;
    const real = estimateMoveSeconds(moves);
    expect(real).toBeGreaterThan(naive);
    // 450 blocks/s over 4000 blocks is just under 9 s, whatever the feed says.
    expect(real).toBeGreaterThan(4000 / 450);
  });

  it('a path that changes direction at every point never gets near its feedrate', () => {
    // A saw-tooth of 1 mm teeth: every junction is a sharp corner, which is
    // what a decimated relief surface actually looks like.
    const zigzag: TimedMove[] = [];
    for (let i = 0; i < 400; i++) {
      const y = i % 2 === 0 ? 0 : 1;
      zigzag.push({ x1: i, y1: y, z1: 0, x2: i + 1, y2: 1 - y, z2: 0, feed: 3000, rapid: false });
    }
    const length = zigzag.reduce((d, m) => d + Math.hypot(m.x2 - m.x1, m.y2 - m.y1), 0);
    const naive = (length / 3000) * 60;
    const real = estimateMoveSeconds(zigzag);
    // Nearly a full stop at every tooth, so it comes out several times over.
    // A 45° move gets more acceleration than a pure X one — each axis only has
    // to supply its own component — which is why this is under three rather
    // than over it, and is the per-axis planning working rather than against it.
    expect(real).toBeGreaterThan(naive * 2.5);
  });

  it('carries speed through a straight junction and brakes at a reversal', () => {
    const pair = (x2: number) => [
      { x1: 0, y1: 0, z1: 0, x2: 5, y2: 0, z2: 0, feed: 3000, rapid: false },
      { x1: 5, y1: 0, z1: 0, x2, y2: 0, z2: 0, feed: 3000, rapid: false },
    ];
    const straight = estimateMoveSeconds(pair(10));
    const doubledBack = estimateMoveSeconds(pair(0));
    // Same 10 mm either way; the reversal has to come to a standstill in the
    // middle and build back up, which the straight run never does.
    expect(doubledBack).toBeGreaterThan(straight * 1.15);
  });

  it('hands back a clock whose last move ends at the total', () => {
    const clocked = clockMoves(raster(50, 1, 1000));
    expect(clocked).toHaveLength(50);
    expect(clocked[0].t0).toBe(0);
    for (let i = 1; i < clocked.length; i++) {
      expect(clocked[i].t0).toBeCloseTo(clocked[i - 1].t1, 10);
    }
    expect(clocked[clocked.length - 1].t1).toBeCloseTo(estimateMoveSeconds(raster(50, 1, 1000)), 10);
  });
});

describe('reading a G-code program', () => {
  it('counts rapids at the traverse rate and cuts at the programmed feed', () => {
    const est = estimateGcodeTime(
      ['G21', 'G90', 'G0 X100', 'G1 X200 F600', 'M30'].join('\n'),
      { rapidRateMmMin: 3000 }
    );
    expect(est.rapidDistanceMm).toBeCloseTo(100, 6);
    expect(est.cutDistanceMm).toBeCloseTo(100, 6);
    // The cut alone is 10 s; the rapid adds about 2.
    expect(est.seconds).toBeGreaterThan(11);
    expect(est.seconds).toBeLessThan(13.5);
  });

  it('keeps the feed modal across lines that do not restate it', () => {
    const withF = estimateGcodeTime('G90\nG1 X100 F600\nG1 X200\n');
    const restated = estimateGcodeTime('G90\nG1 X100 F600\nG1 X200 F600\n');
    expect(withF.seconds).toBeCloseTo(restated.seconds, 6);
  });

  it('honours G91 relative moves', () => {
    const abs = estimateGcodeTime('G90\nG1 X10 F1000\nG1 X20\n');
    const rel = estimateGcodeTime('G91\nG1 X10 F1000\nG1 X10\n');
    expect(rel.cutDistanceMm).toBeCloseTo(abs.cutDistanceMm, 6);
    expect(rel.seconds).toBeCloseTo(abs.seconds, 6);
  });

  it('ignores comments, and counts the dwell the spindle spends spinning up', () => {
    const bare = estimateGcodeTime('G90\nG1 X10 F1000\n');
    const withDwell = estimateGcodeTime('; a comment\nG90\nG4 P2 ; spin up\nG1 X10 F1000 ; the cut\n');
    expect(withDwell.seconds).toBeCloseTo(bare.seconds + 2, 6);
  });

  it('counts the stops it cannot time', () => {
    const est = estimateGcodeTime('G90\nG1 X10 F500\nM5\nT2 M6\nG1 X20\nM0\nM30\n');
    expect(est.operatorStops).toBe(2);
  });

  it('reads inches when the program asks for them', () => {
    const mm = estimateGcodeTime('G21\nG90\nG1 X25.4 F254\n');
    const inch = estimateGcodeTime('G20\nG90\nG1 X1 F10\n');
    expect(inch.cutDistanceMm).toBeCloseTo(mm.cutDistanceMm, 4);
    expect(inch.seconds).toBeCloseTo(mm.seconds, 4);
  });

  it('reads words that are not separated by spaces', () => {
    const spaced = estimateGcodeTime('G90\nG1 X10 Y5 F800\n');
    const packed = estimateGcodeTime('G90\nG1X10Y5F800\n');
    expect(packed.seconds).toBeCloseTo(spaced.seconds, 10);
  });

  it('keeps the motion mode across lines that leave out the G word', () => {
    const est = estimateGcodeTime('G90\nG0 X10\nY10\nG1 X20 F600\nX30\nY20\n');
    expect(est.rapidDistanceMm).toBeCloseTo(20, 6);
    expect(est.cutDistanceMm).toBeCloseTo(30, 6);
  });

  it('does not take an offset or a dwell for a move in the current mode', () => {
    const est = estimateGcodeTime('G90\nG1 X10 F600\nG10 L20 P1 Z0\nG92 X0\nG4 P1\n');
    expect(est.cutDistanceMm).toBeCloseTo(10, 6);
  });

  it('reads parenthesised comments as comments', () => {
    const est = estimateGcodeTime('G90\n(Pass 1 of 3: G0 Z-2.0) G1 X10 F600\nM0 (PAUSE: X99 Y99)\n');
    expect(est.cutDistanceMm).toBeCloseTo(10, 6);
    expect(est.rapidDistanceMm).toBe(0);
  });

  it('measures a G2/G3 arc along the arc, from I/J or from R', () => {
    // Chords sag 0.01 mm inside the arc, so the length is short by a few hundredths.
    // A half circle of radius 10 from (0,0) to (20,0): pi * 10 long, not the 20 mm chord.
    const ij = estimateGcodeTime('G90 G17\nG2 X20 Y0 I10 J0 F600\n');
    expect(ij.cutDistanceMm).toBeCloseTo(Math.PI * 10, 1);
    // A quarter circle by R, both ways round: the short arc and (R < 0) the long one.
    const short = estimateGcodeTime('G90\nG3 X10 Y10 R10 F600\n');
    expect(short.cutDistanceMm).toBeCloseTo((Math.PI / 2) * 10, 1);
    const long = estimateGcodeTime('G90\nG3 X10 Y10 R-10 F600\n');
    expect(long.cutDistanceMm).toBeCloseTo(1.5 * Math.PI * 10, 1);
    // A full circle, start and end the same point.
    const full = estimateGcodeTime('G90\nG0 X10\nG2 X10 Y0 I-10 J0 F600\n');
    expect(full.cutDistanceMm).toBeCloseTo(2 * Math.PI * 10, 1);
  });

  it('ends an arc where the program says, and keeps going from there', () => {
    const est = estimateGcodeTime('G90\nG2 X20 Y0 I10 J0 F600\nG1 X30\n');
    expect(est.cutDistanceMm).toBeCloseTo(Math.PI * 10 + 10, 1);
  });
});

describe('splitting a program line from its comments', () => {
  it('does not cut a line at a semicolon inside parentheses', () => {
    expect(prepareJobLines('(Tool 1; 3mm flat) G0 Z5')).toEqual([{ code: 'G0 Z5', note: 'Tool 1; 3mm flat' }]);
  });

  it('keeps parentheses after a semicolon as comment text', () => {
    expect(prepareJobLines('G1 X1 ; move (fast)')).toEqual([{ code: 'G1 X1', note: 'move (fast)' }]);
  });
});

describe('putting each line of a program on the clock', () => {
  const PROGRAM = [
    '; header',
    'G21 G90',
    'M3 S12000',
    'G4 P2 (spin up)',
    'G0 Z5',
    'G0 X10 Y10',
    'G1 Z-1 F300',
    ...Array.from({ length: 40 }, (_, i) => `G1 X${10 + (i + 1) * 0.5} F1200`),
    'G0 Z5',
    'T2 M6 (ball nose)',
    'G1 X0 Y0 F1500',
    'M30',
  ].join('\n');
  const lines = prepareJobLines(PROGRAM).map((l) => l.code);
  const tl = programTimeline(lines);

  it('indexes the lines the streamer sends, and totals what the estimate says', () => {
    expect(tl.lineEnd).toHaveLength(lines.length);
    expect(tl.moveStart).toHaveLength(lines.length + 1);
    expect(tl.total).toBeCloseTo(estimateGcodeTime(PROGRAM).seconds, 9);
  });

  it('never runs backwards, and a line that does not move takes no time', () => {
    for (let i = 1; i < tl.lineEnd.length; i++) expect(tl.lineEnd[i]).toBeGreaterThanOrEqual(tl.lineEnd[i - 1]);
    const m6 = lines.findIndex((l) => /M6/.test(l));
    expect(tl.lineEnd[m6]).toBe(tl.lineEnd[m6 - 1]);
  });

  it('puts a dwell on the clock at its own line', () => {
    const dwell = lines.findIndex((l) => /^G4/.test(l));
    expect(tl.lineEnd[dwell]).toBeCloseTo(2, 9);
    // The moves after it start after it.
    expect(tl.moves[tl.moveStart[dwell + 1]].t0).toBeCloseTo(2, 9);
  });

  it('tags every move with the line that made it', () => {
    for (let i = 0; i < lines.length; i++) {
      for (let k = tl.moveStart[i]; k < tl.moveStart[i + 1]; k++) expect(tl.moves[k].line).toBe(i);
    }
  });
});

describe('formatDuration', () => {
  it('reads as a duration a person can plan around', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(7 * 60)).toBe('7 min');
    expect(formatDuration(60 * 60)).toBe('1 h');
    expect(formatDuration(134 * 60)).toBe('2 h 14 min');
  });
});
