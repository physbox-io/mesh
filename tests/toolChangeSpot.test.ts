import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS, deriveReliefFeeds } from '../src/utils/reliefCarveExporter';
import { deriveSolidOptions, generateSolidMachining } from '../src/utils/solidMachiningExporter';
import { simulateMilling, type SimTool } from '../src/utils/cutSimulation';
import { FLAT_PROFILE, StockModel } from '../src/utils/stockModel';
import { chooseTouchSpot } from '../src/utils/touchSpot';
import { setupFrame } from '../src/utils/orient';
import { gridFromPoints } from '../src/utils/meshLeveler';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * Where the machine stands for a tool change: over ground the new bit can be
 * zeroed on, reached with the tool already high. Each program is cut back out
 * of a block and re-zeroed where it parked, as the operator does, so a wrong
 * spot shows up as a wrong part.
 */

const body = (geoms: object[]): SceneGraph =>
  ({ nodes: [{ id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0], geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g })) as SceneGeom[], joints: [], children: [] }] });

const dome = body([{ type: 'sphere', size: [0.05] }]);

/** A square pyramid, its point up: all that reaches the top face is a point. */
function pyramid(halfBaseMm: number, heightMm: number): SceneGraph {
  const b = halfBaseMm / 1000, h = heightMm / 1000;
  const v = [[-b, -b, 0], [b, -b, 0], [b, b, 0], [-b, b, 0], [0, 0, h]];
  const faces = [0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
  return body([{ type: 'mesh', size: [1], renderVertices: v.flat(), vertices: v.flatMap(([x, y, z]) => [x, z, -y]), faces }]);
}

const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) =>
  ({ type: 'box', size: [hx / 1000, hy / 1000, hz / 1000], pos: [cx / 1000, cy / 1000, cz / 1000] });

/** The program split at its tool change, and where the tool stood for it. */
function atChange(gcode: string) {
  const lines = gcode.split('\n');
  const code = lines.map((l) => l.split(';')[0].trim());
  const m6 = code.findIndex((l) => /^T2\s*M6/.test(l));
  expect(m6).toBeGreaterThan(0);
  let lastCut = m6;
  while (!code[lastCut].startsWith('G1')) lastCut--;
  const between = code.slice(lastCut + 1, m6).filter((l) => /^G0/.test(l));
  const lift = between.findIndex((l) => /\bZ/.test(l));
  const park = between.findIndex((l) => /\bX/.test(l));
  const word = (l: string, a: string) => parseFloat(new RegExp(`${a}(-?[\\d.]+)`).exec(l)![1]);
  return {
    before: lines.slice(0, m6).join('\n'),
    liftIndex: lift,
    parkIndex: park,
    x: word(between[park], 'X'),
    y: word(between[park], 'Y'),
    z: word(between[lift], 'Z'),
    after: code.slice(m6 + 1).filter(Boolean),
  };
}

const tools = (rough: number, fin: number, shape: SimTool['shape'] = 'flat'): Record<number, SimTool> => ({
  1: { shape: 'flat', diameterMm: rough },
  2: { shape, diameterMm: fin },
});

/** The stock under a cutter of radius `r` at a point: the lowest and highest any of it stands. */
function under(h: { at: (x: number, y: number) => number }, x: number, y: number, r: number) {
  let lo = Infinity, hi = -Infinity;
  for (let a = -r; a <= r; a += 0.25) {
    for (let b = -r; b <= r; b += 0.25) {
      if (Math.hypot(a, b) > r) continue;
      const z = h.at(x + a, y + b);
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
  }
  return { lo, hi };
}

describe('a relief carved 1:1', () => {
  it('parks on the stock roughing left at Z0, lifted first, and a re-zero there cuts the right part', () => {
    const asked = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 140, stockDepthMm: 140, stockThicknessMm: 60, carveDepthMm: 20,
      verticalScaleMode: 'fill' as const, fitMode: 'fit' as const, backgroundMode: 'carve' as const,
      roughingToolDiaMm: 6, finishingToolDiaMm: 3,
      finishingToolType: 'ball_nose' as const,
    };
    const opts = { ...asked, ...deriveReliefFeeds(asked) };
    const r = generateReliefCarveGcode(dome, opts);
    expect(r.success, r.error).toBe(true);
    const c = atChange(r.gcode);
    expect(c.liftIndex).toBeLessThan(c.parkIndex);
    expect(c.z).toBeGreaterThanOrEqual(20);

    const cell = { widthMm: 140, depthMm: 140, cellMm: 0.25, initialTool: 1, tools: tools(6, 3, 'ball') };
    const rough = simulateMilling(c.before, cell);
    const ground = under(rough, c.x, c.y, 1.5);
    expect(ground.lo).toBeCloseTo(0, 3);

    // Nothing else in the finishing block moved: Z0 is still the stock's face.
    const done = simulateMilling(r.gcode, cell);
    expect(done.cuts.filter((m) => m.rapid && m.removedMm > 0.05)).toEqual([]);
    let deepest = 0;
    for (const z of done.heights) deepest = Math.min(deepest, z);
    expect(deepest).toBeCloseTo(-20, 0);
  }, 240000);
});

describe('Background Carve, with only a point left at the top face', () => {
  const scene = pyramid(30, 20);
  const asked = {
    ...DEFAULT_RELIEF_OPTIONS,
    stockWidthMm: 120, stockDepthMm: 120, stockThicknessMm: 40, carveDepthMm: 20,
    fitMode: 'manual' as const, scalePercent: 100, verticalScaleMode: 'proportional' as const, verticalExaggeration: 1,
    backgroundMode: 'carve' as const,
    roughingToolDiaMm: 3.175, finishingToolDiaMm: 2,
    finishingToolType: 'flat' as const,
  };
  const opts = { ...asked, ...deriveReliefFeeds(asked) };
  const r = generateReliefCarveGcode(scene, opts);
  const cell = { widthMm: 120, depthMm: 120, cellMm: 0.25, initialTool: 1, tools: tools(3.175, 2) };

  it('parks on the roughing floor and rewrites finishing for a Z0 there', () => {
    expect(r.success, r.error).toBe(true);
    const c = atChange(r.gcode);
    expect(c.liftIndex).toBeLessThan(c.parkIndex);

    const rough = simulateMilling(c.before, cell);
    const ground = under(rough, c.x, c.y, 1);
    expect(ground.hi - ground.lo).toBeLessThan(0.02);
    const floor = ground.hi;
    expect(floor).toBeLessThan(-5);

    // The lift back up is the same height over the block as the one before
    // the change, in the new Z0's numbers.
    expect(parseFloat(/Z(-?[\d.]+)/.exec(c.after[0])![1])).toBeCloseTo(c.z - floor, 2);
    // Up clear of everything at the end of the program too.
    const end = c.after.findIndex((l) => l.startsWith('M5'));
    expect(parseFloat(/Z(-?[\d.]+)/.exec(c.after[end - 1])![1])).toBeCloseTo(opts.safeZ - floor, 2);
  });

  it('comes out the right shape from that re-zero', () => {
    const done = simulateMilling(r.gcode, cell);
    expect(done.cuts.filter((m) => m.rapid && m.removedMm > 0.05)).toEqual([]);
    // Pyramid: 20 mm below the point at 30 mm out along an axis, and flat beyond.
    const cx = 60, cy = 60;
    // 0.4, not 0.35: the flat finisher's stairs on the 34° flank. At 0,-22 it
    // left 0.337 mm at a 25% stepover and 0.362 mm at the 30% a flat bit now
    // gets (deriveReliefFeeds) - stock left on, not a gouge, and not the re-zero.
    for (const [dx, dy, want] of [[0, 0, 0], [15, 0, -10], [0, -22, -14.67], [40, 0, -20], [45, 45, -20], [-40, 20, -20]]) {
      expect(Math.abs(done.at(cx + dx, cy + dy) - want), `at ${dx},${dy}`).toBeLessThan(0.4);
    }
  });

  it('keeps the viewport in stock heights', () => {
    const lowest = Math.min(...r.segments.flatMap((s) => s.points.map((p) => p.z)));
    expect(lowest).toBeCloseTo(-20, 0);
  });
});

describe('a levelled program', () => {
  it('takes the ground the grid puts at the spot out of the finishing block', () => {
    const scene = pyramid(30, 20);
    const asked = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 120, stockDepthMm: 120, stockThicknessMm: 40, carveDepthMm: 20,
      fitMode: 'manual' as const, scalePercent: 100, backgroundMode: 'skip' as const,
      roughingToolDiaMm: 6, finishingToolDiaMm: 3,
      finishingToolType: 'flat' as const,
    };
    const opts = { ...asked, ...deriveReliefFeeds(asked) };
    const plain = generateReliefCarveGcode(scene, opts);
    const c = atChange(plain.gcode);
    // A tilted board, level at the origin, as a probe run normalises it.
    const tilt = (x: number) => x / 100;
    const points: { x: number; y: number; z: number }[][] = [];
    for (const y of [0, 120]) points.push([0, 120].map((x) => ({ x, y, z: tilt(x) })));
    const grid = gridFromPoints(points)!;
    const levelled = generateReliefCarveGcode(scene, { ...opts, applyMeshLeveling: true, meshLevelGrid: grid });
    expect(levelled.success, levelled.error).toBe(true);
    const travel = (g: string) => parseFloat(/G0 (?:X\S+ Y\S+ )?Z(-?[\d.]+) ; back to travel/.exec(g)![1]);
    const span = tilt(120);
    // Set to Z0 at the spot, the tool is already at the grid's height there, so
    // the warp has nothing to add to this lift over the unwarped program's.
    expect(c.x).toBeGreaterThan(10);
    expect(travel(levelled.gcode)).toBeCloseTo(travel(plain.gcode) + span, 2);
  }, 120000);
});

describe('solid machining', () => {
  it('parks each side on the frame, off the pin holes', () => {
    const scene = body([box(0, 0, 8, 25, 20, 8)]);
    const asked = {
      sides: 2 as const, material: 'softwood' as const,
      roughingToolDiaMm: 6, finishingToolDiaMm: 3, finishingToolType: 'flat' as const,
    };
    const r = generateSolidMachining(scene, deriveSolidOptions(scene, asked));
    expect(r.success, r.error).toBe(true);
    expect(r.pins.length).toBe(2);
    const { widthMm: W, depthMm: D } = r.stock;
    for (const s of r.sides) {
      const c = atChange(s.gcode);
      const rough = simulateMilling(c.before, { widthMm: W, depthMm: D, cellMm: 0.25, initialTool: 1, tools: tools(6, 3) });
      expect(under(rough, c.x, c.y, 1.5).lo).toBeCloseTo(0, 3);
      for (const p of r.pins) expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeGreaterThan(4 + 1.5);
    }
  }, 120000);

  it('does the same on every setup of a job turned on its sides, on what the earlier setups left', () => {
    const W = 135, D = 138, H = 19;
    const run = 12 * Math.tan((15 * Math.PI) / 180);
    const prism = (profile: [number, number][]) => {
      const v: number[] = [];
      for (const x of [0, W]) for (const [y, z] of profile) v.push(x / 1000, y / 1000, z / 1000);
      const n = profile.length;
      const faces: number[] = [];
      for (let i = 1; i < n - 1; i++) faces.push(0, i + 1, i, n, n + i, n + i + 1);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push(i, j, n + j, i, n + j, n + i);
      }
      const yup: number[] = [];
      for (let i = 0; i < v.length; i += 3) yup.push(v[i], v[i + 2], -v[i + 1]);
      return { type: 'mesh', size: [1], renderVertices: v, vertices: yup, faces };
    };
    const floor = H - 12;
    const scene = body([
      prism([[0, 0], [D, 0], [D, floor], [0, floor]]),
      prism([[0, floor], [60, floor], [60 + run, H], [0, H]]),
      prism([[72, floor], [D, floor], [D, H], [72 + run, H]]),
    ]);
    const asked = {
      sides: 1 as const, material: 'softwood' as const,
      roughingToolDiaMm: 6, finishingToolDiaMm: 3.175, finishingToolType: 'flat' as const,
      toolStickoutMm: 80, stockWidthMm: 150, stockDepthMm: 150, stockThicknessMm: 20,
    };
    const r = generateSolidMachining(scene, { ...deriveSolidOptions(scene, asked), setups: 'auto' });
    expect(r.success, r.error).toBe(true);
    const setups = r.setups!;
    expect(setups.length).toBeGreaterThan(1);
    const block = r.stock;
    const cut = setups.map((s) => simulateMilling(s.gcode, {
      widthMm: s.stock.widthMm, depthMm: s.stock.depthMm, cellMm: 0.5, initialTool: 1, tools: tools(6, 3.175),
    }));
    setups.forEach((s, k) => {
      if (!s.toolChange) return;
      const c = atChange(s.gcode);
      const here = setupFrame(s.upFace, block);
      expect(c.liftIndex).toBeLessThan(c.parkIndex);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(s.stock.widthMm);
      for (let e = 0; e < k; e++) {
        const q = setupFrame(setups[e].upFace, block).toSetup(here.toFirst([c.x, c.y, 0]));
        expect(cut[e].at(q[0], q[1]), `setup ${k} over what setup ${e} cut`).toBeGreaterThanOrEqual(q[2] - 0.5);
      }
    });
  }, 240000);
});

describe('chooseTouchSpot', () => {
  const area = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const model = () => new StockModel(area, 0.5);

  it('takes the middle of an untouched block', () => {
    const spot = chooseTouchSpot(model(), area, 2)!;
    expect(spot.levelMm).toBe(0);
    expect(spot.x).toBeCloseTo(50, 0);
    expect(spot.y).toBeCloseTo(30, 0);
    expect(spot.clearanceMm).toBeCloseTo(30, 0);
  });

  it('stays out of what has been cut, and off what the model has not seen', () => {
    const s = model();
    s.cut(0, 30, -5, 60, 30, -5, 10, FLAT_PROFILE);
    const spot = chooseTouchSpot(s, area, 2, (x) => x < 90)!;
    expect(spot.levelMm).toBe(0);
    expect(spot.x).toBeGreaterThan(62);
    expect(spot.x).toBeLessThan(90);
  });

  it('falls back on a floor, and never on a slope', () => {
    const flat = model();
    for (let y = 0; y <= 60; y += 4) flat.cut(0, y, -3, 100, y, -3, 5, FLAT_PROFILE);
    const spot = chooseTouchSpot(flat, area, 2)!;
    expect(spot.levelMm).toBeCloseTo(-3, 3);

    const sloped = model();
    for (let x = 0; x <= 100; x += 2) sloped.cut(x, -5, -1 - x / 20, x, 65, -1 - x / 20, 3, FLAT_PROFILE);
    expect(chooseTouchSpot(sloped, area, 2)).toBeNull();
  });
});
