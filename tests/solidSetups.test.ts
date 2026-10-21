import { describe, it, expect } from 'vitest';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { simulateMilling } from '../src/utils/cutSimulation';
import { setupFrame } from '../src/utils/orient';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * Solid machining from any face, end to end: the planner's choice turned into
 * programs, and each side setup cut back out of its own block.
 */

const W = 135, D = 138, H = 19;

/** A prism along X over a convex profile in (y, z), mm, as a mesh geom. */
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
  const yup: number[] = [];
  for (let i = 0; i < v.length; i += 3) yup.push(v[i], v[i + 2], -v[i + 1]);
  return { name, type: 'mesh', size: [1], renderVertices: v, vertices: yup, faces } as SceneGeom;
}

function tray(leanDeg: number): SceneGraph {
  const floor = H - 12;
  const run = 12 * Math.tan((leanDeg * Math.PI) / 180);
  return {
    nodes: [{
      id: 'b1', name: 'tray', type: 'body', pos: [0, 0, 0],
      geoms: [
        prism('base', [[0, 0], [D, 0], [D, floor], [0, floor]]),
        prism('front', [[0, floor], [60, floor], [60 + run, H], [0, H]]),
        prism('back', [[72, floor], [D, floor], [D, H], [72 + run, H]]),
      ],
      joints: [], children: [],
    }],
  };
}

const tooling = {
  sides: 1 as const, material: 'softwood' as const,
  roughingToolDiaMm: 6, finishingToolDiaMm: 6, finishingToolType: 'flat' as const,
  toolStickoutMm: 80, stockWidthMm: 150, stockDepthMm: 150, stockThicknessMm: 20,
};

describe('solid machining from any face', () => {
  const scene = tray(15);
  const opts = deriveSolidOptions(scene, tooling);
  const r = generateSolidMachining(scene, { ...opts, setups: 'auto' });

  it('turns the leaning tray onto both ends and frees it from the top last', () => {
    expect(r.success, r.error).toBe(true);
    const faces = r.setups!.map((s) => s.upFace);
    expect(new Set(faces)).toEqual(new Set(['+x', '-x', '+z']));
    expect(faces[faces.length - 1]).toBe('+z');
    r.setups!.forEach((s, i) => {
      expect(s.index).toBe(i + 1);
      expect(s.of).toBe(3);
      expect(s.gcode.length).toBeGreaterThan(100);
      expect(s.instructions.length).toBeGreaterThan(0);
    });
    expect(r.plan!.text).toMatch(/3 setups/);
    expect(r.plan!.redesignHint).toMatch(/upright/);
    // What a plan that succeeds says it leaves: only what every router leaves.
    expect(r.plan!.remaining.text).toMatch(/Inside corners come out rounded|Every surface/);
  });

  it('tells the operator how to stand the block, naming two faces', () => {
    const end = r.setups!.find((s) => s.upFace === '+x')!;
    expect(end.gcode).toMatch(/Stand the block: Stand the block on its left end, right end up, with the front towards you/);
    expect(end.datum!.touches.map((t) => t.axis)).toEqual(['x', 'y', 'z']);
    // Every setup says how it is zeroed, and none says a thing twice.
    for (const s of r.setups!) {
      expect(s.instructions.some((i) => /^Zero /.test(i))).toBe(true);
      expect(s.instructions.join(' ')).not.toMatch(/Stand the block: Stand/);
    }
  });

  it('cuts each end into the groove about half way, and never into the part', () => {
    for (const face of ['+x', '-x'] as const) {
      const s = r.setups!.find((q) => q.upFace === face)!;
      const frame = setupFrame(face, r.stock);
      const cut = simulateMilling(s.gcode, {
        widthMm: frame.stock.widthMm, depthMm: frame.stock.depthMm, cellMm: 0.25,
        tools: { 1: { shape: 'flat', diameterMm: 6 }, 2: { shape: 'flat', diameterMm: 6 } },
      });
      // Under the front wall's overhang, which the top cannot see: 5 mm above
      // the groove floor the wall is at model Y 61.3 and its lip covers to 63.2.
      // 1.6 mm off the wall, past the skin the turn leaves on it.
      const sliver = frame.toSetup([75, (150 - D) / 2 + 62.9, -(20 - H) - 12 + 5]);
      expect(cut.at(sliver[0], sliver[1])).toBeLessThan(-60);
      expect(s.allowanceMm).toBeLessThan(1.5);
      // Solid tray beside the groove: not cut below the stock face.
      const solid = frame.toSetup([75, (150 - D) / 2 + 30, -(20 - H) - 6]);
      expect(cut.at(solid[0], solid[1])).toBeGreaterThan(-1);
      expect(s.depthMm).toBeLessThan(80);
    }
  });

  it('refuses, in plain words, a part its bit cannot reach rather than plan it wrong', () => {
    // A 6 mm bit reaching 48 mm cannot get half way along the groove from either end.
    const res = generateSolidMachining(scene, { ...opts, toolStickoutMm: 0, setups: 'auto' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/^This part can't be cut with this bit/);
    expect(res.error).toMatch(/at least \d+ mm from its tip to the holder/);
    expect(res.error).not.toMatch(/mm³|stickout|collet/);
  });

  it('leaves an upright tray to one setup, as it always was', () => {
    const upright = tray(0);
    const res = generateSolidMachining(upright, { ...deriveSolidOptions(upright, tooling), setups: 'auto' });
    expect(res.success, res.error).toBe(true);
    expect(res.setups!.map((s) => s.upFace)).toEqual(['+z']);
  });
});

describe('choosing the way up', () => {
  /** A plain block, 80 x 20 x 60 tall, with a pocket only in its front face. */
  const frontPocket: SceneGraph = {
    nodes: [{
      id: 'b', name: 'plate', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [
        // Back slab, then a frame round a 40 x 30 pocket 8 deep in the front.
        { name: 'back', type: 'box', pos: [0, 0.006, 0.03], size: [0.04, 0.004, 0.03] },
        { name: 'l', type: 'box', pos: [-0.03, -0.004, 0.03], size: [0.01, 0.006, 0.03] },
        { name: 'r', type: 'box', pos: [0.03, -0.004, 0.03], size: [0.01, 0.006, 0.03] },
        { name: 'b', type: 'box', pos: [0, -0.004, 0.0075], size: [0.02, 0.006, 0.0075] },
        { name: 't', type: 'box', pos: [0, -0.004, 0.0525], size: [0.02, 0.006, 0.0075] },
      ] as SceneGeom[],
    }],
  };

  it('lays a part with work only on its front face up, in one setup', () => {
    const o = deriveSolidOptions(frontPocket, { sides: 1, material: 'softwood', finishingToolDiaMm: 3.175, roughingToolDiaMm: 3.175 });
    const r = generateSolidMachining(frontPocket, { ...o, setups: 'auto' });
    expect(r.success, r.error).toBe(true);
    expect(r.setups!.length).toBe(1);
    // The front (-Y of the model) is what points at the spindle now.
    expect(r.upChosen).toBe('-y');
  });

  it('keeps the way up it was asked for when nothing is gained by turning', () => {
    const o = deriveSolidOptions(tray(0), { ...tooling });
    const r = generateSolidMachining(tray(0), { ...o, setups: 'auto' });
    expect(r.upChosen).toBe('+z');
  });
});

describe('a round body with a box tail, flipped and opened from the end', () => {
  // A display replica of a bomb casing at 67 mm: an ellipsoid body, a tail
  // cylinder and a square shroud with cross fins. Top and flip reach the
  // body; only the shroud's open end sees into the box tail.
  const g = (name: string, type: string, size: number[], pos: number[], quat?: number[]) =>
    ({ name, type, size, pos, ...(quat ? { quat } : {}) }) as SceneGeom;
  const replica: SceneGraph = {
    nodes: [{
      id: 'b', name: 'replica', type: 'body', pos: [0, 0, 0.034], joints: [], children: [],
      geoms: [
        g('body', 'ellipsoid', [0.042, 0.032, 0.032], [0.01, 0, 0]),
        g('tail', 'cylinder', [0.014, 0.022], [-0.04, 0, 0], [0.7071068, 0, 0.7071068, 0]),
        g('st', 'box', [0.012, 0.026, 0.0012], [-0.07, 0, 0.0248]),
        g('sb', 'box', [0.012, 0.026, 0.0012], [-0.07, 0, -0.0248]),
        g('sl', 'box', [0.012, 0.0012, 0.026], [-0.07, 0.0248, 0]),
        g('sr', 'box', [0.012, 0.0012, 0.026], [-0.07, -0.0248, 0]),
        g('fh', 'box', [0.016, 0.025, 0.0012], [-0.066, 0, 0]),
        g('fv', 'box', [0.016, 0.0012, 0.025], [-0.066, 0, 0]),
      ],
    }],
  };

  it('plans top, the tail end, then the flip, narrowing the frame so a short bit reaches', () => {
    const o = deriveSolidOptions(replica, {
      scalePercent: 50, setups: 'auto', material: 'hardwood', toolStickoutMm: 30,
      roughingToolDiaMm: 3.175, finishingToolDiaMm: 3.175,
    });
    const t0 = performance.now();
    const r = generateSolidMachining(replica, o);
    expect(r.success, r.error).toBe(true);
    expect(r.upChosen).toBe('+z');
    expect(r.setups!.map((s) => s.upFace)).toEqual(['+z', '-x', '-z']);
    expect(r.plan!.text).toMatch(/runs right up to the block's left end/);
    expect(performance.now() - t0).toBeLessThan(30_000);

    // Changing only feed rate or safeZ reuses cached triangles, voxels, and setup plans.
    const r2 = generateSolidMachining(replica, { ...o, safeZMm: o.safeZMm + 5, finishingFeedRate: o.finishingFeedRate + 200 });
    expect(r2.success).toBe(true);
    expect(r2.setups!.map((s) => s.upFace)).toEqual(['+z', '-x', '-z']);
    expect(r2.partVolumeMm3).toBeCloseTo(r.partVolumeMm3, 5);
  }, 60_000);
});
