import { describe, it, expect } from 'vitest';
import {
  contourSheetParts, laserSheetParts, laserStockTransform, regionArea, routerClosing, runSheetJob, type SheetPart,
} from '../src/utils/sheetSimulation';
import { simulatedBody } from '../src/utils/simulatedPart';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS, type LaserPanel, type Point2D } from '../src/utils/laserCutExporter';
import { exportContourSliceSvg, collectSceneTriangles } from '../src/utils/contourSliceExporter';
import { stackedCubesPreset } from '../src/presets/presetScenes';
import type { SceneGraph } from '../src/types/scene';

// Sheet parts as they come off the machine: outlines extruded at the stock's
// thickness, a router's inside corners rounded, put back where they go.

const rect = (x0: number, y0: number, x1: number, y1: number): Point2D[] =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];

const flat = (loops: Point2D[][], t = 3): SheetPart =>
  ({ loops, origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], zFrom: 0, zTo: t });

const closed = (positions: Float32Array, faces: Uint32Array) => {
  const integrity = analyzeMesh(Array.from(positions), Array.from(faces))!;
  expect(integrity.closed).toBe(true);
  expect(integrity.consistentlyWound).toBe(true);
  return integrity.volume;
};

/** Bounds of a set of points, x, y, z. */
const boundsOf = (p: ArrayLike<number>) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  return { lo, hi };
};

describe('sheet parts', () => {
  it('extrudes an outline with a hole and an island in it, closed', () => {
    // Wound every which way: nesting decides what is material.
    const loops = [rect(0, 0, 50, 40), rect(10, 10, 40, 30), rect(20, 15, 30, 25).reverse()];
    const res = runSheetJob({ parts: [flat(loops, 6)] });
    const volume = closed(res.positions, res.faces);
    expect(volume).toBeCloseTo((50 * 40 - 30 * 20 + 10 * 10) * 6, 3);
    expect(res.volumeMm3).toBeCloseTo(volume, 3);
  });

  it('leaves a router bit\'s radius in every inside corner, and not on the outside ones', () => {
    // An L: one inside corner.
    const L: Point2D[] = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 20 }, { x: 0, y: 20 },
    ];
    const r = 2;
    // The offset draws its arcs as chords, which leave a sliver more: 5%.
    const fillet = r * r * (1 - Math.PI / 4);
    const extra = regionArea(routerClosing([L], r)) - regionArea([L]);
    expect(Math.abs(extra - fillet) / fillet).toBeLessThan(0.05);
    // A square hole: four inside corners, seen from the material.
    const holed = [rect(0, 0, 40, 40), rect(10, 10, 30, 30)];
    const four = regionArea(routerClosing(holed, r)) - regionArea(holed);
    expect(Math.abs(four - 4 * fillet) / (4 * fillet)).toBeLessThan(0.05);
  });

  it('never cuts a slot narrower than the bit', () => {
    const slotted = [rect(0, 0, 40, 20), rect(10, 5, 30, 8)]; // 3 mm wide
    const cut = runSheetJob({ parts: [flat(slotted)], routerRadiusMm: 2 });
    expect(cut.cutAreaMm2).toBeCloseTo(40 * 20, 0);
    expect(cut.drawnAreaMm2).toBeCloseTo(40 * 20 - 20 * 3, 6);
    closed(cut.positions, cut.faces);
  });

  it('turns a panel the packer turned back into its place', () => {
    // A 30 x 10 panel at (100, 0, 0) in the XZ plane, laid on the sheet a quarter turn round.
    const panel: LaserPanel = {
      id: 'p', name: 'p', thickness: 0.003,
      origin3D: { x: 0.1, y: 0, z: 0 }, normal3D: { x: 0, y: -1, z: 0 },
      uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 0, z: 1 },
      // Drawn about its origin from (-15, -5); normalised, then turned: 10 wide, 30 tall.
      outerPolygon2D: rect(0, 0, 30, 10).map((p) => ({ x: 10 - p.y, y: p.x })),
      innerCutouts2D: [],
      edges3D: [],
      modelOffset2D: { x: -15, y: -5 },
      width2D: 10, height2D: 30, turnedOnSheet: true,
    };
    const [part] = laserSheetParts([panel]);
    const res = runSheetJob({ parts: [part] });
    const { lo, hi } = boundsOf(res.positions);
    [85, -1.5, -5].forEach((v, a) => expect(lo[a]).toBeCloseTo(v, 6));
    [115, 1.5, 5].forEach((v, a) => expect(hi[a]).toBeCloseTo(v, 6));
  });

  it('puts a laser box back together where the model is', () => {
    const scene = stackedCubesPreset as SceneGraph;
    const result = exportLaserCutSvg(scene, { ...DEFAULT_LASER_OPTIONS, jointMode: 'finger' });
    expect(result.success).toBe(true);
    const res = runSheetJob({ parts: laserSheetParts(result.panels!, result.sheets) });
    closed(res.positions, res.faces);
    const transform = laserStockTransform(result.panels!, result.scaleFactor ?? 1);
    const node = simulatedBody({ ...res, cellMm: 0, toleranceMm: 0 }, transform, {
      id: 's', name: 's', kind: 'laser', placement: 'overlay',
    });
    // The assembled shells fill the cubes' bounds, to within the stock.
    const v = node.geoms[0].renderVertices!;
    const got = boundsOf(v.map((c, i) => (c + node.pos[i % 3]) * 1000));
    const model = boundsOf(collectSceneTriangles(scene).tris.map((c) => c * 1000));
    for (let a = 0; a < 3; a++) {
      expect(Math.abs(got.lo[a] - model.lo[a])).toBeLessThan(3.1);
      expect(Math.abs(got.hi[a] - model.hi[a])).toBeLessThan(3.1);
    }
  });

  it('stacks contour layers back up into the model', () => {
    const sphere: SceneGraph = {
      nodes: [{
        id: 'b', name: 'ball', type: 'body', pos: [0, 0, 0.05],
        geoms: [{ name: 'g', type: 'sphere', size: [0.04] } as never],
        joints: [], children: [],
      }],
    };
    const result = exportContourSliceSvg(sphere, { materialThickness: 0.004, pinHoles: false });
    expect(result.success).toBe(true);
    const res = runSheetJob({ parts: contourSheetParts(result.layers!, 4) });
    const volume = closed(res.positions, res.faces);
    // Twenty 4 mm discs make an 80 mm ball to within the steps. The reported
    // volume counts every disc whole; the drawn one is short by the seams that
    // keep the discs from reading as one solid.
    const ball = (4 / 3) * Math.PI * 40 ** 3;
    expect(Math.abs(res.volumeMm3 - ball) / ball).toBeLessThan(0.03);
    expect(volume).toBeLessThan(res.volumeMm3 * 0.99);
    const node = simulatedBody({ ...res, cellMm: 0, toleranceMm: 0 }, result.stockTransform!, {
      id: 's', name: 's', kind: 'contour', placement: 'overlay',
    });
    const v = node.geoms[0].renderVertices!;
    const got = boundsOf(v.map((c, i) => (c + node.pos[i % 3]) * 1000));
    expect(got.lo[2]).toBeCloseTo(10, 3);
    expect(got.hi[2]).toBeCloseTo(90, 3);
    expect(got.hi[0]).toBeLessThan(40.01);
    expect(got.hi[0]).toBeGreaterThan(39);
  });

  it('draws stacked identical layers as separate sheets, not one block', () => {
    const square = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }];
    const layers = [0, 1, 2].map((index) => ({ index, z: 0, loops: [square], pieceCount: 1, areaMm2: 2500 }));
    const res = runSheetJob({ parts: contourSheetParts(layers, 20) });
    // Every sheet but the bottom one stands on a gap, so no two share a face.
    const zs = new Set<number>();
    for (let i = 2; i < res.positions.length; i += 3) zs.add(+res.positions[i].toFixed(3));
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 20, 21, 40, 41, 60]);
    // The volume is still three whole sheets.
    expect(res.volumeMm3).toBeCloseTo(3 * 2500 * 20, 0);
  });
});
