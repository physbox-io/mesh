import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { LaserPanel } from '../src/utils/laserCutExporter';

const panel = (id: string, thicknessMm: number, sheetIndex: number): LaserPanel =>
  ({
    id, name: id,
    thickness: thicknessMm / 1000,
    origin3D: { x: 0, y: 0, z: 0 },
    normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 },
    vAxis3D: { x: 0, y: 1, z: 0 },
    outerPolygon2D: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    innerCutouts2D: [],
    edges3D: [],
    width2D: 100,
    height2D: 60,
    placedPos2D: { x: 20, y: 30 },
    sheetIndex,
  }) as unknown as LaserPanel;

/** The deepest Z the program cuts to on each sheet, in order. */
function deepestPerSheet(gcode: string): number[] {
  const out: number[] = [];
  for (const line of gcode.split('\n')) {
    if (/^; SHEET \d+ of/.test(line)) out.push(0);
    const z = /^G1 .*Z(-?[\d.]+)/.exec(line);
    if (z && out.length) out[out.length - 1] = Math.min(out[out.length - 1], parseFloat(z[1]));
  }
  return out;
}

describe('a mixed stock rack on a router', () => {
  it('cuts each sheet through its own thickness', () => {
    const r = generateLaserCutGcode([panel('thin', 6, 0), panel('thick', 12, 1)], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      cutDepthZ: 6, // the first row of the rack
      zStepdown: 3,
      sheetStockThicknessMm: [6, 12],
    });
    expect(r.success).toBe(true);
    expect(deepestPerSheet(r.gcode)).toEqual([-6, -12]);
  });

  it('falls back to the one cut depth when the sheets are not known', () => {
    const r = generateLaserCutGcode([panel('a', 6, 0), panel('b', 6, 1)], {
      ...DEFAULT_GCODE_OPTIONS, machineMode: 'cnc', cutDepthZ: 6, zStepdown: 3,
    });
    expect(deepestPerSheet(r.gcode)).toEqual([-6, -6]);
  });
});

describe('laser power mode', () => {
  const laser = (p: LaserPanel) => generateLaserCutGcode([p], {
    ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser',
    attachmentsEnabled: true, attachmentWidthMm: 2, attachmentSpacingMm: 50,
  });

  it('fires in dynamic power mode, M4, so corners are not charred', () => {
    const p = panel('p', 3, 0);
    (p as { engrave2D?: { x: number; y: number }[][] }).engrave2D = [[{ x: 10, y: 10 }, { x: 50, y: 10 }]];
    const g = laser(p).gcode;
    expect(g).toMatch(/^M4 S\d+/m);
    expect(g).not.toMatch(/^M3\b/m);
  });

  it('crosses a holding tab with S0 on the move, without stopping the head', () => {
    const lines = laser(panel('p', 3, 0)).gcode.split('\n');
    const first = lines.findIndex((l) => /^M4/.test(l));
    const last = lines.lastIndexOf('M5');
    const loop = lines.slice(first + 1, last);
    // The beam never toggles with M3/M5 inside the loop: those force a planner stop.
    expect(loop.some((l) => /^M[35]\b/.test(l))).toBe(false);
    // It goes out and comes back by S word on the G1 moves.
    const off = loop.filter((l) => /^G1 .*S0\b/.test(l));
    const on = loop.filter((l) => /^G1 .*S[1-9]\d*/.test(l));
    expect(off.length).toBeGreaterThan(0);
    expect(on.length).toBe(off.length);
  });
});
