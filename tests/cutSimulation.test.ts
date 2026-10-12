import { describe, it, expect } from 'vitest';
import { simulateMilling, type SimTool } from '../src/utils/cutSimulation';
import { buildSimulationMesh, halveGrid } from '../src/utils/simulationMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';

// The simulator against cuts whose answer is known on paper, and the mesh it
// becomes against what a closed solid has to be.

/** Centre of the cell a coordinate falls in. */
const centre = (cell: number, v: number) => (Math.floor(v / cell) + 0.5) * cell;

const run = (gcode: string, tool: SimTool, size = 40, cellMm = 0.05) =>
  simulateMilling(gcode, { widthMm: size, depthMm: size, cellMm, tools: { 1: tool } });

/** The same move cut by stepping the cutter along it in tiny steps. */
function bruteForce(
  a: [number, number, number], b: [number, number, number], tool: SimTool, x: number, y: number
): number {
  const r = tool.diameterMm / 2;
  const k = 1 / Math.tan(((tool.vAngleDeg ?? 90) * Math.PI) / 360);
  let best = 0;
  for (let s = 0; s <= 20000; s++) {
    const t = s / 20000;
    const px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t, pz = a[2] + (b[2] - a[2]) * t;
    const d = Math.hypot(x - px, y - py);
    if (d > r) continue;
    const level = pz + (tool.shape === 'flat' ? 0 : tool.shape === 'ball' ? r - Math.sqrt(r * r - d * d) : k * d);
    best = Math.min(best, level);
  }
  return best;
}

describe('cutSimulation', () => {
  it('cuts a flat slot exactly its depth and width', () => {
    const cut = run('G0 X10 Y20 Z5\nG1 Z-2\nG1 X30\nG0 Z5', { shape: 'flat', diameterMm: 4 });
    expect(cut.at(20, 20)).toBeCloseTo(-2, 9);
    expect(cut.at(20, 21.9)).toBeCloseTo(-2, 9);
    expect(cut.at(20, 22.1)).toBe(0);
    expect(cut.at(20, 17.9)).toBe(0);
    // The ends are the cutter's round.
    expect(cut.at(8.1, 20)).toBeCloseTo(-2, 9);
    expect(cut.at(7.9, 20)).toBe(0);
    expect(cut.cuts.every((c) => !c.rapid)).toBe(true);
  });

  it('leaves the scallop a ball nose should between two passes', () => {
    const r = 3, step = 2, depth = -3;
    const cut = run(
      `G0 X5 Y20 Z5\nG1 Z${depth}\nG1 X35\nG0 Z5\nG0 X5 Y${20 + step}\nG1 Z${depth}\nG1 X35\nG0 Z5`,
      { shape: 'ball', diameterMm: 2 * r }, 40, 0.01
    );
    // At the cell centre nearest the cusp, and at the cusp itself.
    const y = centre(cut.cell, 20 + step / 2);
    const dy = Math.min(Math.abs(y - 20), Math.abs(y - 20 - step));
    expect(cut.at(20, y) - depth).toBeCloseTo(r - Math.sqrt(r * r - dy * dy), 6);
    expect(r - Math.sqrt(r * r - (step / 2) ** 2) - (r - Math.sqrt(r * r - dy * dy))).toBeLessThan(0.01);
  });

  it('cuts a V groove at its angle', () => {
    const cut = run('G0 X5 Y20 Z5\nG1 Z-3\nG1 X35\nG0 Z5', { shape: 'v_bit', diameterMm: 6, vAngleDeg: 90 }, 40, 0.01);
    for (const off of [0.5, 1, 2, 2.9]) {
      const y = centre(cut.cell, 20 + off);
      expect(cut.at(20, y)).toBeCloseTo(-3 + (y - 20), 9);
    }
    expect(cut.at(20, 23.5)).toBe(0);
  });

  it('matches stepping the cutter along climbing and falling moves', () => {
    const tools: SimTool[] = [
      { shape: 'flat', diameterMm: 4 },
      { shape: 'ball', diameterMm: 4 },
      { shape: 'v_bit', diameterMm: 6, vAngleDeg: 60 },
      { shape: 'v_bit', diameterMm: 6, vAngleDeg: 150 },
    ];
    const moves: [number, number, number][][] = [
      [[10, 10, -1], [30, 25, -4]],
      [[30, 12, -5], [12, 20, -0.5]],
      [[20, 20, -6], [20.3, 20.1, -1]], // steeper than any flank
      [[15, 15, -2], [15, 15, -5]], // straight plunge
    ];
    for (const tool of tools) {
      for (const [a, b] of moves) {
        const cut = run(`G0 X${a[0]} Y${a[1]} Z5\nG0 Z${a[2]}\nG1 X${b[0]} Y${b[1]} Z${b[2]}`, tool, 40, 0.5);
        // Only the G1 from a to b cuts below a's height that the plunge to a did not.
        const plunge = run(`G0 X${a[0]} Y${a[1]} Z5\nG0 Z${a[2]}`, tool, 40, 0.5);
        for (let j = 0; j < cut.rows; j += 3) {
          for (let i = 0; i < cut.cols; i += 3) {
            const x = (i + 0.5) * cut.cell, y = (j + 0.5) * cut.cell;
            const want = Math.min(plunge.at(x, y), bruteForce(a, b, tool, x, y));
            expect(cut.at(x, y)).toBeCloseTo(want, 2);
          }
        }
      }
    }
  });

  it('switches cutters at the tool change, not at a comment', () => {
    const gcode = [
      '; T1: flat',
      'G0 X5 Y10 Z5', 'G1 Z-2', 'G1 X35', 'G0 Z20',
      '; --- OP 2: finishing',
      'G0 X5 Y30', 'G1 Z-2', 'G1 X10', 'G0 Z20',
      'T2 M6 ; fit the ball',
      'G0 X20 Y30', 'G1 Z-2', 'G1 X35', 'G0 Z20',
    ].join('\n');
    const cut = simulateMilling(gcode, {
      widthMm: 40, depthMm: 40, cellMm: 0.05,
      tools: { 1: { shape: 'flat', diameterMm: 4 }, 2: { shape: 'ball', diameterMm: 4 } },
    });
    expect(cut.toolsUsed).toEqual([1, 2]);
    expect(cut.at(7.5, 31.5)).toBeCloseTo(-2, 9); // still the flat after the comment
    const ballSide = -2 + 2 - Math.sqrt(4 - 1.5 ** 2);
    expect(cut.at(27.5, 31.5)).toBeCloseTo(ballSide, 1);
  });

  it('reports a rapid that cuts', () => {
    const cut = run('G0 X5 Y20 Z-1\nG0 X35', { shape: 'flat', diameterMm: 3 });
    expect(cut.cuts.some((c) => c.rapid && c.removedMm > 0.9)).toBe(true);
  });

  it('cuts a cell it only grazes but does not call it a dive', () => {
    // Cell centres at 0.125 and 0.375. The first pass, 1.0 mm out, takes the
    // 0.375 column to -4 and misses the edge one; the second, 0.922 mm out,
    // reaches the edge column by 0.003 mm.
    const cut = simulateMilling('G0 X1.0 Y5 Z5\nG1 Z-4\nG1 Y15\nG0 Z5\nG0 X0.922\nG1 Z-4\nG1 Y5', {
      widthMm: 20, depthMm: 20, cellMm: 0.25, tools: { 1: { shape: 'flat', diameterMm: 1.6 } },
    });
    expect(cut.at(0.125, 10)).toBe(-4);
    expect(cut.cuts.some((c) => c.line === 7)).toBe(false);
  });

  it('caps the grid at the cell budget', () => {
    const big = simulateMilling('G0 X0 Y0 Z5', { widthMm: 600, depthMm: 400, tools: { 1: { shape: 'flat', diameterMm: 6 } } });
    expect(big.cols * big.rows).toBeLessThanOrEqual(4e6 * 1.01);
    expect(big.cell).toBeCloseTo(0.245, 2);
  });
});

describe('simulationMesh', () => {
  const sizeOf = (positions: Float32Array) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], positions[i]);
    }
    return { lo, hi };
  };
  const check = (mesh: ReturnType<typeof buildSimulationMesh>) => {
    const integrity = analyzeMesh(Array.from(mesh.positions), Array.from(mesh.faces))!;
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    expect(integrity.volume).toBeGreaterThan(0);
    return integrity;
  };

  it('turns an uncut block into a box of a handful of triangles', () => {
    const cut = run('G0 X0 Y0 Z5', { shape: 'flat', diameterMm: 3 }, 40, 0.1);
    const mesh = buildSimulationMesh({ ...cut, top: cut.heights, bottom: -10, widthMm: 40, depthMm: 40 });
    const { volume } = check(mesh);
    expect(volume).toBeCloseTo(40 * 40 * 10, 0);
    const { lo, hi } = sizeOf(mesh.positions);
    expect([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]).toEqual([0, 0, -10, 40, 40, 0]);
    // A quad per side and a fan over each face, round only the corners the walls stand on.
    expect(mesh.faces.length / 3).toBeLessThanOrEqual(16);
  });

  it('closes round a pocket and a hole cut right through', () => {
    const gcode = [
      'G0 X10 Y10 Z5', 'G1 Z-4', 'G1 X25', 'G1 Y25', 'G1 X10', 'G1 Y10', 'G0 Z5', // a square ring 4 deep
      'G0 X32 Y32', 'G1 Z-12', 'G0 Z5', // a hole through 10 mm stock
      'G0 X5 Y35', 'G1 Z-11', 'G1 X20 Y20', 'G0 Z5', // a diagonal slot through, the staircase case
    ].join('\n');
    const cut = run(gcode, { shape: 'flat', diameterMm: 3 }, 40, 0.2);
    const mesh = buildSimulationMesh({ ...cut, top: cut.heights, bottom: -10, widthMm: 40, depthMm: 40 });
    const { volume } = check(mesh);
    const hole = Math.PI * 1.5 ** 2 * 10;
    const slot = (Math.hypot(15, 15) * 3 + Math.PI * 1.5 ** 2) * 10;
    const ring = (18 * 18 - 12 * 12) * 4; // 15 mm square path, 3 mm cutter
    const expected = 40 * 40 * 10 - hole - slot - ring;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(0.01);
  });

  it('stays under the triangle budget by relaxing the tolerance', () => {
    // A ball raster over a wavy surface: no two neighbouring quads coplanar.
    const lines: string[] = ['G0 X0 Y0 Z5'];
    for (let y = 0; y <= 60; y += 0.8) {
      lines.push(`G0 X0 Y${y.toFixed(2)}`);
      for (let x = 0; x <= 60; x += 0.5) lines.push(`G1 X${x.toFixed(2)} Z${(-3 + 2 * Math.sin(x / 4) * Math.cos(y / 5)).toFixed(3)}`);
      lines.push('G0 Z5');
    }
    const cut = simulateMilling(lines.join('\n'), { widthMm: 60, depthMm: 60, cellMm: 0.1, tools: { 1: { shape: 'ball', diameterMm: 3 } } });
    const mesh = buildSimulationMesh({ ...cut, top: cut.heights, bottom: -8, widthMm: 60, depthMm: 60 }, { maxTriangles: 50_000 });
    expect(mesh.faces.length / 3).toBeLessThanOrEqual(50_000);
    expect(mesh.toleranceMm).toBeGreaterThan(0.005);
    check(mesh);
  });

  it('builds a two-sided part from a top and a bottom heightmap', () => {
    // A 20 mm cube in the middle of 40 x 40 x 30, cut from both faces.
    const cols = 200, rows = 200, cell = 0.2;
    const top = new Float64Array(cols * rows), bottom = new Float64Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5) * cell, y = (j + 0.5) * cell;
        const inside = x > 10 && x < 30 && y > 10 && y < 30;
        top[j * cols + i] = inside ? -5 : -15;
        bottom[j * cols + i] = inside ? -25 : -15;
      }
    }
    const mesh = buildSimulationMesh({ cols, rows, cell, originX: 0, originY: 0, widthMm: 40, depthMm: 40, top, bottom });
    const { volume } = check(mesh);
    expect(Math.abs(volume - 8000) / 8000).toBeLessThan(0.03);
  });

  it('draws a part that is all walls on a coarser grid, rather than over the budget', () => {
    // A field of 1 mm pins, cut from both sides: every pin is four walls, and
    // no tolerance merges a wall away. The oak tree came out like this, at
    // 600 000 triangles.
    const cols = 400, rows = 400, cell = 0.1;
    const top = new Float64Array(cols * rows), bottom = new Float64Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const pin = i % 20 < 10 && j % 20 < 10;
        top[j * cols + i] = pin ? -2 : -6;
        bottom[j * cols + i] = pin ? -10 : -6;
      }
    }
    const grid = { cols, rows, cell, originX: 0, originY: 0, widthMm: 40, depthMm: 40, top, bottom };
    const fine = buildSimulationMesh(grid, { maxTriangles: Infinity });
    const mesh = buildSimulationMesh(grid, { maxTriangles: fine.faces.length / 3 / 3 });
    expect(mesh.faces.length / 3).toBeLessThanOrEqual(fine.faces.length / 3 / 3);
    expect(mesh.cellMm).toBeGreaterThan(cell);
    check(mesh);
    // Halving keeps the material's volume exactly: 400 pins of 1 x 1 x 8 mm.
    // What the mesh then loses is the mesher's own half cell round every
    // edge, which a 1 mm pin on a 0.4 mm grid feels and a part does not.
    const gridVolume = (g: typeof grid) => {
      let v = 0;
      for (let k = 0; k < g.cols * g.rows; k++) v += Math.max(0, g.top[k] - (g.bottom as Float64Array)[k]) * g.cell ** 2;
      return v;
    };
    let g = grid;
    for (let n = 0; n < 3; n++) {
      g = halveGrid(g) as typeof grid;
      expect(gridVolume(g)).toBeCloseTo(3200, 6);
    }
  });
});
