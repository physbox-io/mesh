import { describe, it, expect } from 'vitest';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { reliefSimulationTools, runSimulationJob, simulatedBody } from '../src/utils/simulatedPart';
import { cutSetups } from '../src/utils/multiSetupMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * Add Simulation across setups cut from different faces: each setup cut in
 * its own frame, and the part the region every one of them leaves.
 */

const W = 135, D = 138, H = 19;

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
  return { name, type: 'mesh', size: [1], renderVertices: v, faces } as SceneGeom;
}

const run = 12 * Math.tan((15 * Math.PI) / 180);
const tray: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'tray', type: 'body', pos: [0, 0, 0],
    geoms: [
      prism('base', [[0, 0], [D, 0], [D, 7], [0, 7]]),
      prism('front', [[0, 7], [60, 7], [60 + run, H], [0, H]]),
      prism('back', [[72, 7], [D, 7], [D, H], [72 + run, H]]),
    ],
    joints: [], children: [],
  }],
};

const opts = deriveSolidOptions(tray, {
  sides: 1, material: 'softwood', roughingToolDiaMm: 6, finishingToolDiaMm: 6, finishingToolType: 'flat',
  toolStickoutMm: 80, stockWidthMm: 150, stockDepthMm: 150, stockThicknessMm: 20,
});
const result = generateSolidMachining(tray, { ...opts, setups: 'auto' });
const setups = result.setups!.map((s) => ({ gcode: s.gcode, rotation: s.rotation, translation: s.translation, stock: s.stock }));
const tools = reliefSimulationTools(opts);
const stock = result.stock;

/** A model point (mm, as drawn) in setup 1's frame: centred in plan, top 1 mm under the stock's. */
const at = (x: number, y: number, z: number): [number, number, number] => [x + 7.5, y + 6, z - 20];

/** Whether a model point (as drawn) is inside the tray, this far in from its surfaces. */
function insideTray(x: number, y: number, z: number, m: number): boolean {
  if (x < m || x > W - m || y < m || y > D - m || z < m || z > H - m) return false;
  if (z <= 7 - m) return true;
  const t = (z - 7) / 12;
  return y < 60 + run * t - m || (y > 72 + run * t + m && z >= 7 + m);
}

describe('several setups, one of them on a side', () => {
  const cut = cutSetups(setups, tools.tools, tools.initialTool, stock, 0.25);

  it('never marks a point inside the part as cut away', () => {
    let worst = Infinity;
    for (let x = 1; x < W; x += 6.7) {
      for (let y = 1; y < D; y += 1.3) {
        for (let z = 0.5; z < H; z += 0.9) {
          if (!insideTray(x, y, z, 0.3)) continue;
          worst = Math.min(worst, cut.field(...at(x, y, z)));
        }
      }
    }
    // A cut simulated at 0.25 mm, read to its cell.
    expect(worst).toBeGreaterThan(-0.3);
  });

  it('clears the undercut the top could not see, to within the skin', () => {
    // 1.6 mm off the leaning front wall, 5 mm above the groove floor, along the groove.
    for (const x of [10, 40, 67, 95, 125]) {
      expect(cut.field(...at(x, 62.9, 12))).toBeLessThan(0);
    }
  });

  it('meshes the part closed, wound outward, and lays it back over the model', () => {
    const sim = runSimulationJob({
      gcode: '', widthMm: stock.widthMm, depthMm: stock.depthMm, thicknessMm: stock.thicknessMm,
      ...tools, setups, cellMm: 0.5, maxTriangles: 150_000,
    });
    const integrity = analyzeMesh(Array.from(sim.positions), Array.from(sim.faces))!;
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    expect(sim.volumeMm3).toBeGreaterThan(0);
    // The tray's own volume plus the frame it is held in, within a few percent.
    const trayMm3 = W * D * 7 + W * 12 * (D - 12);
    expect(sim.volumeMm3).toBeGreaterThan(trayMm3 * 0.97);
    expect(sim.volumeMm3).toBeLessThan(stock.widthMm * stock.depthMm * stock.thicknessMm);

    // Over the part's own outline: the model, a fillet in the groove's acute
    // corner, the skin the ends leave, and the tabs. Within a few percent.
    const measured = runSimulationJob({
      gcode: '', widthMm: stock.widthMm, depthMm: stock.depthMm, thicknessMm: stock.thicknessMm,
      ...tools, setups, cellMm: 0.5, maxTriangles: 150_000,
      measureRect: result.partBounds, measureMask: result.footprint,
    }).measuredVolumeMm3!;
    // Read on a 0.5 mm grid, so to about a percent either way.
    expect(measured / result.partVolumeMm3).toBeGreaterThan(0.99);
    expect(measured / result.partVolumeMm3).toBeLessThan(1.03);

    const node = simulatedBody(sim, result.stockTransform!, { id: 's', name: 's', kind: 'machining', placement: 'overlay' });
    const v = node.geoms[0].renderVertices!;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], v[i] + node.pos[i % 3]);
      hi[i % 3] = Math.max(hi[i % 3], v[i] + node.pos[i % 3]);
    }
    // Centred on the tray in plan.
    expect(((lo[0] + hi[0]) / 2) * 1000).toBeCloseTo(W / 2, 0);
    expect(((lo[1] + hi[1]) / 2) * 1000).toBeCloseTo(D / 2, 0);
  });

  it('keeps the part whole with the turn out by less than the skin, and shows it when out by more', () => {
    const side = result.setups!.find((s) => s.upFace === '+x')!;
    const shifted = (by: number) => setups.map((s) =>
      s.rotation === side.rotation
        ? { ...s, translation: [s.translation[0], s.translation[1] + by, s.translation[2]] as [number, number, number] }
        : s);
    const worstIn = (f: (x: number, y: number, z: number) => number) => {
      let worst = Infinity;
      for (let x = 75; x < W; x += 3.1) {
        for (let y = 50; y < 85; y += 0.3) {
          for (let z = 7.5; z < H; z += 0.7) {
            if (!insideTray(x, y, z, 0.3)) continue;
            worst = Math.min(worst, f(...at(x, y, z)));
          }
        }
      }
      return worst;
    };
    const within = cutSetups(shifted(side.allowanceMm * 0.7), tools.tools, tools.initialTool, stock, 0.25);
    expect(worstIn(within.field)).toBeGreaterThan(-0.3);
    const beyond = cutSetups(shifted(side.allowanceMm * 3), tools.tools, tools.initialTool, stock, 0.25);
    expect(worstIn(beyond.field)).toBeLessThan(-0.5);
  });
});

describe('the top and the flip', () => {
  it('go the way they always have', () => {
    const ball: SceneGraph = {
      nodes: [{ id: 'b', name: 'p', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'sphere', size: [0.02] } as never], joints: [], children: [] }],
    };
    const o = deriveSolidOptions(ball, { sides: 2, material: 'softwood' });
    const r = generateSolidMachining(ball, { ...o, setups: 2 });
    const base = { widthMm: r.stock.widthMm, depthMm: r.stock.depthMm, thicknessMm: r.stock.thicknessMm, ...reliefSimulationTools(o), cellMm: 0.5 };
    const legacy = runSimulationJob({ ...base, gcode: r.sides[0].gcode, gcodeB: r.sides[1].gcode });
    const planned = generateSolidMachining(ball, { ...o, setups: ['+z', '-z'] });
    const viaSetups = runSimulationJob({
      ...base, gcode: '',
      setups: planned.setups!.map((s) => ({ gcode: s.gcode, rotation: s.rotation, translation: s.translation, stock: s.stock })),
    });
    expect(viaSetups.volumeMm3).toBeCloseTo(legacy.volumeMm3, 6);
    expect(Array.from(viaSetups.faces)).toEqual(Array.from(legacy.faces));
  });
});
