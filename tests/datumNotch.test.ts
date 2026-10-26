import { describe, it, expect } from 'vitest';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { simulateMilling } from '../src/utils/cutSimulation';
import { setupFrame } from '../src/utils/orient';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * The datum notch: the first setup cuts a cube out of a waste corner, and a
 * later turned setup is zeroed on two of its walls instead of on the sawn
 * block. The tray from solidSetups.test.ts, whose ends run first and whose
 * top frees it last.
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

const tools = { 1: { shape: 'flat' as const, diameterMm: 6 }, 2: { shape: 'flat' as const, diameterMm: 6 } };

describe('datum notch, on a block with room at the corners', () => {
  const scene = tray(15);
  // 10.5 mm of waste at each end and 11 front and back: room for an 8 mm notch and its millimetre.
  const big = { ...tooling, stockWidthMm: 156, stockDepthMm: 160, stockThicknessMm: 30 };
  const r = generateSolidMachining(scene, { ...deriveSolidOptions(scene, big), setups: 'auto' });
  const first = r.setups?.[0];
  const top = r.setups?.find((s) => s.upFace === '+z');

  it('has the first end cut it, and the top zeroed on it', () => {
    expect(r.success, r.error).toBe(true);
    expect(first!.upFace).toBe('-x');
    expect(first!.gcode).toMatch(/; Datum notch : 8\.0 mm cube/);
    // The bit and a millimetre either side: 6 + 2. Touched from inside, so the
    // work position set is the wall less the bit's radius.
    const tx = top!.datum!.touches.find((t) => t.axis === 'x')!;
    const ty = top!.datum!.touches.find((t) => t.axis === 'y')!;
    expect([tx.wallMm, ty.wallMm]).toEqual([8, 8]);
    expect([tx.valueMm, ty.valueMm]).toEqual([5, 5]);
    expect(top!.gcode.split('\n')[0]).toMatch(/^; Zero X, Y {3}: on the far walls of the 8\.0 mm datum notch/);
    expect(top!.instructions.join(' ')).toMatch(/datum notch/);
  });

  it("really cuts it: the first setup's own program, milled", () => {
    const frame = setupFrame('-x', r.stock);
    const cut = simulateMilling(first!.gcode, { widthMm: frame.stock.widthMm, depthMm: frame.stock.depthMm, cellMm: 0.25, tools });
    // The notch is the cube at the left end's corner with the front and the
    // top: x 0-8, y 0-8, z -8-0 in the block's first frame. Its middle, seen
    // from the left end, is 4 mm in from that corner, cut 8 mm down.
    const mid = frame.toSetup([0, 4, -4]);
    expect(cut.at(mid[0], mid[1])).toBeLessThan(-7.5);
    // And no further than the cube: 2 mm past it along the front, untouched.
    const past = frame.toSetup([0, 10, -4]);
    expect(cut.at(past[0], past[1])).toBeGreaterThan(-0.5);
  });

  it('leaves the far end on its sawn corner, and says why', () => {
    const far = r.setups!.find((s) => s.upFace === '+x')!;
    expect(far.datum!.touches.find((t) => t.axis === 'x')!.wallMm).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/right end setup is zeroed on the block's sawn corner/);
  });
});

describe('datum notch, on a block with no room for one', () => {
  const scene = tray(15);
  const r = generateSolidMachining(scene, { ...deriveSolidOptions(scene, tooling), setups: 'auto' });

  it('zeroes on the sawn corner, cuts nothing for it, and says why', () => {
    expect(r.success, r.error).toBe(true);
    const top = r.setups!.find((s) => s.upFace === '+z')!;
    expect(top.datum).toBeUndefined();
    expect(r.setups!.some((s) => /Datum notch/.test(s.gcode))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/top setup is zeroed on the block's sawn corner \(no datum notch: the part comes within 9 mm/);
  });
});
