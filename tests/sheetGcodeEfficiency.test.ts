import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, generateContourSliceGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { LaserPanel, Point2D } from '../src/utils/laserCutExporter';

/*
 * Sheet G-code that is safe can still waste the afternoon: flying back and
 * forth across the sheet between holes, piercing every loop on a corner,
 * re-sending the feed on every line. These measure the order and the bytes.
 */

const rect = (x0: number, y0: number, x1: number, y1: number): Point2D[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

const panel = (over: Partial<LaserPanel> = {}): LaserPanel =>
  ({
    id: 'p', name: 'p', thickness: 0.006,
    origin3D: { x: 0, y: 0, z: 0 }, normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 1, z: 0 },
    // Holes listed far, near, middle from the origin.
    outerPolygon2D: rect(0, 0, 100, 60),
    innerCutouts2D: [rect(78, 20, 88, 30), rect(8, 20, 18, 30), rect(48, 20, 58, 30)].map((l) => l.reverse()),
    edges3D: [], width2D: 100, height2D: 60, placedPos2D: { x: 0, y: 0 }, sheetIndex: 0,
    ...over,
  }) as unknown as LaserPanel;

/** The XY each loop or line starts at: the rapid that precedes it. */
const starts = (gcode: string) =>
  gcode.split('\n').filter((l) => /^G0 X/.test(l)).map((l) => ({
    x: parseFloat(/X(-?[\d.]+)/.exec(l)![1]), y: parseFloat(/Y(-?[\d.]+)/.exec(l)![1]),
  })).filter((p) => p.x !== 0 || p.y !== 0); // parking moves

describe('sheet G-code order', () => {
  for (const machineMode of ['laser', 'cnc'] as const) {
    it(`cuts a panel's holes nearest first on a ${machineMode}`, () => {
      const g = generateLaserCutGcode([panel()], { ...DEFAULT_GCODE_OPTIONS, machineMode, bitDiameterMm: 2 });
      const xs = starts(g.gcode).slice(0, 3).map((p) => p.x);
      expect(xs[0]).toBeLessThan(20);
      expect(xs[1]).toBeGreaterThan(40);
      expect(xs[1]).toBeLessThan(60);
      expect(xs[2]).toBeGreaterThan(70);
    });
  }

  it('cuts a contour layer\'s holes nearest first, then the outline', () => {
    const layer = {
      index: 0, z: 0.005, pieceCount: 1, areaMm2: 5700,
      loops: [rect(0, 0, 100, 60), ...panel().innerCutouts2D],
      sheetIndex: 0, placedPos2D: { x: 0, y: 0 }, modelOffset2D: { x: 0, y: 60 }, width2D: 100, height2D: 60,
    };
    const g = generateContourSliceGcode({ success: true, layers: [layer], sheetCount: 1 }, { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' });
    const xs = starts(g.gcode).map((p) => p.x);
    expect(xs).toHaveLength(4);
    expect(xs[0]).toBeLessThan(20);
    expect(xs[1]).toBeGreaterThan(40);
    expect(xs[1]).toBeLessThan(60);
    expect(xs[2]).toBeGreaterThan(70);
  });

  it('starts a loop on a straight edge, near where the head is, not on a corner', () => {
    const g = generateLaserCutGcode([panel({ innerCutouts2D: [] })], { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' });
    const [s] = starts(g.gcode);
    const corners = rect(0, 0, 100, 60);
    for (const c of corners) expect(Math.hypot(s.x - c.x, s.y - c.y)).toBeGreaterThan(1);
    // On the outline, and on the side nearest the origin it came from.
    expect(s.x === 0 || s.y === 0).toBe(true);
  });

  it('chains engraving lines end to end, turning a line round when its far end is nearer', () => {
    const g = generateLaserCutGcode([panel({
      innerCutouts2D: [],
      engrave2D: [
        [{ x: 30, y: 10 }, { x: 80, y: 10 }],
        [{ x: 5, y: 10 }, { x: 20, y: 10 }],
        [{ x: 25, y: 40 }, { x: 25, y: 12 }],
      ],
    })], { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' });
    const s = starts(g.gcode).slice(0, 3);
    expect(s[0]).toEqual({ x: 5, y: 10 });
    expect(s[1]).toEqual({ x: 25, y: 12 }); // the one whose end was nearer, reversed
    expect(s[2]).toEqual({ x: 30, y: 10 });
  });
});

describe('sheet G-code bytes', () => {
  for (const machineMode of ['laser', 'cnc'] as const) {
    it(`sends a feed only when it changes, and never on a rapid (${machineMode})`, () => {
      const g = generateLaserCutGcode([panel()], { ...DEFAULT_GCODE_OPTIONS, machineMode, bitDiameterMm: 2 });
      const lines = g.gcode.split('\n');
      expect(lines.some((l) => /^G0\b[^;]*F/.test(l))).toBe(false);
      let feed: string | null = null;
      for (const l of lines) {
        const m = /^G[123]\b[^;]*F(\d+(?:\.\d+)?)/.exec(l);
        if (!m) continue;
        expect(m[1], l).not.toBe(feed);
        feed = m[1];
      }
    });

    it(`does not lift to a height it is already at (${machineMode})`, () => {
      const g = generateLaserCutGcode([panel()], { ...DEFAULT_GCODE_OPTIONS, machineMode, bitDiameterMm: 2 });
      let z: string | null = null;
      for (const l of g.gcode.split('\n')) {
        if (/^M[0-9]+/.test(l) && /^M(0|1|6)\b|M6\b/.test(l)) z = null;
        const m = /^G0 Z(-?[\d.]+)\s*(;.*)?$/.exec(l);
        if (m) expect(m[1], 'duplicate retract').not.toBe(z);
        const any = /^G[0123]\b[^;]*Z(-?[\d.]+)/.exec(l);
        if (any) z = any[1];
      }
    });
  }

  it('counts every depth pass of a router cut in the cut distance', () => {
    const run = (zStepdown: number) => generateLaserCutGcode([panel({ innerCutouts2D: [] })], {
      ...DEFAULT_GCODE_OPTIONS, machineMode: 'cnc', bitDiameterMm: 2, cutDepthZ: 6, zStepdown,
    }).totalCutDistanceMm;
    expect(run(3)).toBeCloseTo(2 * run(6), -1);
  });
});
