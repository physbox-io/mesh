import { describe, it, expect } from 'vitest';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { simulateMilling } from '../src/utils/cutSimulation';
import { reliefSimulationTools } from '../src/utils/simulatedPart';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * A solid part's walls are cut where the model puts them. Each part is
 * machined one-sided with a flat finisher, cut back out of the block by the
 * simulator, and its walls found at several heights: every one within
 * TOL_MM of the model, neither proud nor cut in. The walls used to land
 * wherever the sampling grid put them, up to 0.6 mm proud a side.
 */

const TOL_MM = 0.1;
const CELL_MM = 0.05;

function body(geoms: Partial<SceneGeom>[]): SceneGraph {
  return {
    nodes: [{
      id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
      geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g })) as SceneGeom[], joints: [], children: [],
    }],
  } as SceneGraph;
}

/** A closed prism over a counter-clockwise outline, z0..z1, mm. */
function prism(outline: number[][], z0: number, z1: number): Partial<SceneGeom> {
  const n = outline.length;
  const pts = [...outline.map(([x, y]) => [x, y, z0]), ...outline.map(([x, y]) => [x, y, z1])];
  const cx = outline.reduce((s, p) => s + p[0], 0) / n, cy = outline.reduce((s, p) => s + p[1], 0) / n;
  pts.push([cx, cy, z0], [cx, cy, z1]);
  const faces: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(2 * n, j, i, 2 * n + 1, n + i, n + j, i, j, n + j, i, n + j, n + i);
  }
  const m = pts.map(([x, y, z]) => [x / 1000, y / 1000, z / 1000]);
  return { type: 'mesh', size: [1], renderVertices: m.flat(), vertices: m.flatMap(([x, y, z]) => [x, z, -y]), faces };
}
const rect = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Machines a part and hands back its height at a point in the model's own plan coordinates. */
function machined(geoms: Partial<SceneGeom>[]) {
  const scene = body(geoms);
  const opts = deriveSolidOptions(scene, {
    sides: 1, material: 'softwood', roughingToolDiaMm: 6, finishingToolDiaMm: 3,
    finishingToolType: 'flat', tabCount: 0, registrationPins: false,
  });
  const res = generateSolidMachining(scene, opts);
  expect(res.success, res.error).toBe(true);
  const sim = simulateMilling(res.sides[0].gcode, {
    widthMm: res.stock.widthMm, depthMm: res.stock.depthMm, cellMm: CELL_MM, ...reliefSimulationTools(opts),
  });
  const bottom = -res.stock.thicknessMm;
  return {
    seconds: res.estimatedTimeSeconds,
    /** Height above the part's underside at (x, y), model mm. */
    at: (x: number, y: number) => sim.at(res.partBounds.minX + x, res.partBounds.minY + y) - bottom,
  };
}

/** Where the cut crosses `level` going from (x0, y0) toward (x1, y1), as a distance along the line. */
function crossing(at: (x: number, y: number) => number, x0: number, y0: number, x1: number, y1: number, level: number) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const startAbove = at(x0, y0) > level;
  for (let t = 0; t <= len; t += CELL_MM / 2) {
    if (at(x0 + ((x1 - x0) * t) / len, y0 + ((y1 - y0) * t) / len) > level !== startAbove) return t;
  }
  return NaN;
}

describe('solid machining wall size', () => {
  it('cuts a boss to size on both axes', () => {
    const { at } = machined([prism(rect(0, 0, 40, 30), 0, 10)]);
    for (const z of [1, 5, 9]) {
      // From 3 mm outside each wall, inward.
      expect(Math.abs(crossing(at, -3, 15, 20, 15, z) - 3)).toBeLessThan(TOL_MM);
      expect(Math.abs(crossing(at, 43, 15, 20, 15, z) - 3)).toBeLessThan(TOL_MM);
      expect(Math.abs(crossing(at, 20, -3, 20, 15, z) - 3)).toBeLessThan(TOL_MM);
      expect(Math.abs(crossing(at, 20, 33, 20, 15, z) - 3)).toBeLessThan(TOL_MM);
    }
  });

  it('cuts a pocket to size, down to its floor', () => {
    // 50 x 40 x 12 block with a 20 x 14 pocket 8 deep.
    const { at } = machined([
      prism(rect(0, 0, 50, 40), 0, 4), prism(rect(0, 0, 15, 40), 0, 12), prism(rect(35, 0, 50, 40), 0, 12),
      prism(rect(15, 0, 35, 13), 0, 12), prism(rect(15, 27, 35, 40), 0, 12),
    ]);
    for (const z of [5, 8, 11]) {
      // From the pocket's middle out to each wall.
      expect(Math.abs(crossing(at, 25, 20, 10, 20, z) - 10)).toBeLessThan(TOL_MM);
      expect(Math.abs(crossing(at, 25, 20, 40, 20, z) - 10)).toBeLessThan(TOL_MM);
      expect(Math.abs(crossing(at, 25, 20, 25, 5, z) - 7)).toBeLessThan(TOL_MM);
      expect(Math.abs(crossing(at, 25, 20, 25, 35, z) - 7)).toBeLessThan(TOL_MM);
    }
  });

  it('cuts a cylinder round, and a turned square without rounding its corners', () => {
    const r = 15, n = 256;
    const cyl = machined([prism(Array.from({ length: n }, (_, k) => [r * Math.cos((2 * Math.PI * k) / n), r * Math.sin((2 * Math.PI * k) / n)]), 0, 10)]);
    const apothem = r * Math.cos(Math.PI / n);
    for (let k = 0; k < 36; k++) {
      const a = (2 * Math.PI * k) / 36, c = Math.cos(a), s = Math.sin(a);
      for (const z of [2, 8]) {
        const out = crossing(cyl.at, 15 + 18 * c, 15 + 18 * s, 15, 15, z);
        expect(Math.abs(18 - out - apothem)).toBeLessThan(TOL_MM);
      }
    }
    // A 20 mm square turned 30 degrees: its faces and its corners.
    const turn = Math.PI / 6;
    const sq = [[-10, -10], [10, -10], [10, 10], [-10, 10]].map(([x, y]) => [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)]);
    const half = 10 * (Math.cos(turn) + Math.sin(turn));
    const cut = machined([prism(sq, 0, 10)]);
    for (let k = 0; k < 72; k++) {
      const a = (2 * Math.PI * k) / 72;
      const want = 10 / Math.max(Math.abs(Math.cos(a - turn)), Math.abs(Math.sin(a - turn)));
      const out = crossing(cut.at, half + 18 * Math.cos(a), half + 18 * Math.sin(a), half, half, 8);
      expect(Math.abs(18 - out - want)).toBeLessThan(TOL_MM);
    }
  });
});
