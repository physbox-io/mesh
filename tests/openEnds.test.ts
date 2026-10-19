import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { simulateMilling, type CutResult } from '../src/utils/cutSimulation';
import { reliefSimulationTools } from '../src/utils/simulatedPart';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * A feature that runs out at the part's edge has to come out open.
 *
 * oak_tray's phone groove ran the length of the tray and was cut stopping
 * about 2.6 mm short of each end (run_657c196aa4ac76bec5): a slot closed at
 * both ends, which a phone does not fit. Each program here is cut back out of
 * its block, and the floor at the part's end faces is held to the floor in the
 * middle of the groove.
 */

const W = 135, D = 138, H = 19;
const GROOVE_DEPTH = 12, GROOVE_WIDTH = 12;
/** The groove's near wall at its floor, from the part's front. */
const GROOVE_Y = 60;

/** A prism along X over a convex profile in (y, z), mm. Outward winding is the exporters' job. */
function prism(name: string, profile: [number, number][]): SceneGeom {
  const v: number[] = [];
  for (const x of [0, W]) for (const [y, z] of profile) v.push(x / 1000, y / 1000, z / 1000);
  const n = profile.length;
  const faces: number[] = [];
  for (let i = 1; i < n - 1; i++) faces.push(0, i + 1, i, n, n + i, n + i + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(i, j, n + j, i, n + j, n + i);
  }
  // The Y-up copy, (x, y, z) -> (x, z, -y), as mjcf.ts expects alongside.
  const yup: number[] = [];
  for (let i = 0; i < v.length; i += 3) yup.push(v[i], v[i + 2], -v[i + 1]);
  return { name, type: 'mesh', size: [1], renderVertices: v, vertices: yup, faces } as SceneGeom;
}

/** The tray block with a through-groove along X, its walls leaning back by `leanDeg`. */
function tray(leanDeg: number): SceneGraph {
  const floor = H - GROOVE_DEPTH;
  const run = GROOVE_DEPTH * Math.tan((leanDeg * Math.PI) / 180);
  const near = GROOVE_Y, far = GROOVE_Y + GROOVE_WIDTH;
  return {
    nodes: [{
      id: 'b1', name: 'tray', type: 'body', pos: [0, 0, 0],
      geoms: [
        prism('base', [[0, 0], [D, 0], [D, floor], [0, floor]]),
        prism('front', [[0, floor], [near, floor], [near + run, H], [0, H]]),
        prism('back', [[far, floor], [D, floor], [D, H], [far + run, H]]),
      ],
      joints: [], children: [],
    }],
  };
}

/** Deepest the simulated floor goes along X over a short span of the groove's middle in Y. */
function grooveFloor(cut: CutResult, x: number, yLo: number, yHi: number): number {
  let lowest = 0;
  for (let y = yLo; y <= yHi; y += cut.cell / 2) lowest = Math.min(lowest, cut.at(x, y));
  return lowest;
}

const tools = {
  roughingToolDiaMm: 3.175,
  finishingToolType: 'ball_nose' as const,
  finishingToolDiaMm: 1.5875,
  finishingStepoverPercent: 40,
};

describe('a groove open at both ends', () => {
  const cases = [
    { lean: 0, margin: 0, background: 'skip' as const, height: 'model' as const },
    { lean: 0, margin: 0, background: 'carve' as const, height: 'model' as const },
    { lean: 0, margin: 7.5, background: 'skip' as const, height: 'model' as const },
    { lean: 0, margin: 7.5, background: 'carve' as const, height: 'model' as const },
    { lean: 0, margin: 0, background: 'carve' as const, height: 'fill' as const },
    { lean: 15, margin: 0, background: 'skip' as const, height: 'model' as const },
    { lean: 15, margin: 7.5, background: 'carve' as const, height: 'model' as const },
  ];

  for (const c of cases) {
    it(`relief, ${c.lean}° lean, ${c.margin} mm margin, background ${c.background}, height ${c.height}`, () => {
      const opts = {
        ...DEFAULT_RELIEF_OPTIONS,
        ...tools,
        stockWidthMm: W + 2 * c.margin,
        stockDepthMm: D + 2 * c.margin,
        stockThicknessMm: 20,
        carveDepthMm: 11.5,
        verticalScaleMode: c.height,
        backgroundMode: c.background,
      };
      const r = generateReliefCarveGcode(tray(c.lean), opts);
      expect(r.success, r.error).toBe(true);
      const cut = simulateMilling(r.gcode, {
        widthMm: opts.stockWidthMm, depthMm: opts.stockDepthMm, cellMm: 0.2,
        ...reliefSimulationTools(opts),
      });

      const s = r.scaleFactor;
      const y0 = r.carveBounds.minY;
      // The middle third of the groove's floor, which is open from above at any lean.
      const yLo = y0 + (GROOVE_Y + GROOVE_WIDTH / 3) * s;
      const yHi = y0 + (GROOVE_Y + (2 * GROOVE_WIDTH) / 3) * s;
      const middle = grooveFloor(cut, (r.carveBounds.minX + r.carveBounds.maxX) / 2, yLo, yHi);
      expect(middle).toBeLessThan(-r.reliefDepthMm * 0.5);

      const tol = cut.cell + 0.1;
      const atStart = grooveFloor(cut, r.carveBounds.minX + cut.cell / 2, yLo, yHi);
      const atEnd = grooveFloor(cut, r.carveBounds.maxX - cut.cell / 2, yLo, yHi);
      expect(atStart, 'floor at X min').toBeLessThan(middle + tol);
      expect(atEnd, 'floor at X max').toBeLessThan(middle + tol);
    });
  }

  for (const c of [{ lean: 0, margin: 7.5 }, { lean: 15, margin: 7.5 }]) {
    it(`solid, one side, ${c.lean}° lean, ${c.margin} mm margin`, () => {
      const scene = tray(c.lean);
      const opts = deriveSolidOptions(scene, {
        ...tools, sides: 1, material: 'softwood',
        stockWidthMm: W + 2 * c.margin + 2 * 3.175 + 20,
        stockDepthMm: D + 2 * c.margin + 2 * 3.175 + 20,
      });
      const r = generateSolidMachining(scene, opts);
      expect(r.success, r.error).toBe(true);
      const cut = simulateMilling(r.sides[0].gcode, {
        widthMm: r.stock.widthMm, depthMm: r.stock.depthMm, cellMm: 0.2,
        ...reliefSimulationTools(opts),
      });
      const b = r.partBounds;
      const yLo = b.minY + GROOVE_Y + GROOVE_WIDTH / 3;
      const yHi = b.minY + GROOVE_Y + (2 * GROOVE_WIDTH) / 3;
      const middle = grooveFloor(cut, (b.minX + b.maxX) / 2, yLo, yHi);
      const top = -(r.stock.thicknessMm - H) / 2;
      expect(middle).toBeLessThan(top - GROOVE_DEPTH * 0.8);

      const tol = cut.cell + 0.1;
      expect(grooveFloor(cut, b.minX + cut.cell / 2, yLo, yHi), 'floor at X min').toBeLessThan(middle + tol);
      expect(grooveFloor(cut, b.maxX - cut.cell / 2, yLo, yHi), 'floor at X max').toBeLessThan(middle + tol);
    });
  }
});

describe('a model with nothing open at its edge', () => {
  it('keeps the cutter on the board and says nothing about the edge', () => {
    // A closed tray: walls all round, so every edge of the surface is the top face.
    const closed: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'tray', type: 'body', pos: [0, 0, 0],
        geoms: [
          prism('base', [[0, 0], [D, 0], [D, 7], [0, 7]]),
          prism('front', [[0, 7], [10, 7], [10, H], [0, H]]),
          prism('back', [[D - 10, 7], [D, 7], [D, H], [D - 10, H]]),
        ],
        joints: [], children: [],
      }],
    };
    // Close the ends too: a box across each.
    closed.nodes[0].geoms.push(
      { name: 'endA', type: 'box', pos: [0.005, D / 2000, H / 2000], size: [0.005, D / 2000, H / 2000] } as SceneGeom,
      { name: 'endB', type: 'box', pos: [(W - 5) / 1000, D / 2000, H / 2000], size: [0.005, D / 2000, H / 2000] } as SceneGeom,
    );
    const r = generateReliefCarveGcode(closed, {
      ...DEFAULT_RELIEF_OPTIONS, ...tools,
      stockWidthMm: W, stockDepthMm: D, stockThicknessMm: 20,
      verticalScaleMode: 'model', backgroundMode: 'skip',
    });
    expect(r.success, r.error).toBe(true);
    expect(r.frameBounds).toBeUndefined();
    expect(r.warnings.join('\n')).not.toMatch(/past the board edge/);
    for (const m of r.gcode.matchAll(/^G[01][^;\n]*X(-?[\d.]+)/gm)) expect(Number(m[1])).toBeGreaterThanOrEqual(0);
  });

  it('does not carry a dome’s flank out across an uncut margin', () => {
    const dome: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'dome', type: 'body', pos: [0, 0, 0],
        geoms: [{ name: 's', type: 'sphere', size: [0.03] } as SceneGeom],
        joints: [], children: [],
      }],
    };
    const r = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS, ...tools,
      stockWidthMm: 90, stockDepthMm: 90, stockThicknessMm: 40,
      verticalScaleMode: 'model', backgroundMode: 'skip',
    });
    expect(r.success, r.error).toBe(true);
    expect(r.frameBounds).toBeUndefined();
    const cut = simulateMilling(r.gcode, { widthMm: 90, depthMm: 90, cellMm: 0.3, ...reliefSimulationTools({ ...DEFAULT_RELIEF_OPTIONS, ...tools }) });
    // The board's edge, half way along each side, is left at its top face.
    for (const [x, y] of [[1, 45], [89, 45], [45, 1], [45, 89]]) expect(cut.at(x, y)).toBeGreaterThan(-0.05);
  });
});
