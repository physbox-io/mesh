// Snap fits: a hook stood on a lid's top face, its catch window in a wall.
// The hook's mesh is checked as built (closed, outward, standing where it
// should, lip facing the way asked), and its beam against the strain it was
// sized for.

import { describe, it, expect } from 'vitest';
import { hardwareCutGeoms, hardwareSpecOf, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { SNAP_SIZES, snapBeamLength, snapLipHeight, snapHookProfileMm, PLA_SAFE_STRAIN } from '../src/utils/snapFits';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const block = (): SceneNode => ({
  id: 'lid', name: 'lid', pos: [0, 0, 0], csgEnabled: true,
  geoms: [{ name: 'b', type: 'box', size: [0.03, 0.03, 0.005] } as SceneGeom],
} as SceneNode);

const spec = (over: Partial<HardwareCutSpec> = {}): HardwareCutSpec => ({
  group: 'snap1', kind: 'snap_hook', size: 'M', at: [0, 0, 0.005], normal: [0, 0, 1], ...over,
});

function place(node: SceneNode, s: HardwareCutSpec): SceneGeom[] {
  const pieces = hardwareCutGeoms(s, node.id, node);
  for (const piece of pieces) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return pieces;
}

function signedVolume(v: number[], f: number[]): number {
  let vol = 0;
  for (let i = 0; i < f.length; i += 3) {
    const [a, b, c] = [f[i], f[i + 1], f[i + 2]].map((k) => [v[k * 3], v[k * 3 + 1], v[k * 3 + 2]]);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return vol;
}

const extent = (v: number[], axis: number) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < v.length; i += 3) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  return [lo, hi];
};

describe('snap fit sizing', () => {
  it('keeps every size\'s beam root at the safe strain', () => {
    for (const s of Object.values(SNAP_SIZES)) {
      const L = snapBeamLength(s);
      expect((1.5 * s.thickness * s.depth) / (L * L)).toBeCloseTo(PLA_SAFE_STRAIN, 9);
    }
    expect(snapBeamLength(SNAP_SIZES.M)).toBeCloseTo(12, 6);
  });

  it('has a 30 degree lead-in on the lip', () => {
    const p = snapHookProfileMm(SNAP_SIZES.M);
    const [x0, z0] = p[4], [x1, z1] = p[5];
    expect((Math.atan2(x0 - x1, z1 - z0) * 180) / Math.PI).toBeCloseTo(30, 6);
  });
});

describe('snap hook', () => {
  it('stands a closed, outward-wound beam on the face, as tall as beam and lip', () => {
    const [hook] = place(block(), spec());
    expect(hook.csg).toBe('union');
    const v = hook.renderVertices!, f = hook.faces!;
    expect(signedVolume(v, f)).toBeGreaterThan(0);
    const s = SNAP_SIZES.M;
    const [zLo, zHi] = extent(v, 2);
    expect(zHi * 1000).toBeCloseTo(5 + snapBeamLength(s) + snapLipHeight(s), 3);
    expect(zLo * 1000).toBeLessThan(5); // sunk into the lid so the union overlaps
    const [yLo, yHi] = extent(v, 1);
    expect((yHi - yLo) * 1000).toBeCloseTo(s.width, 3);
  });

  it('faces its lip along the face\'s X, and a quarter turn later along its Y', () => {
    const s = SNAP_SIZES.M;
    const [a] = place(block(), spec());
    const [xLo, xHi] = extent(a.renderVertices!, 0);
    expect(xHi * 1000).toBeCloseTo(s.depth, 3);
    expect(xLo * 1000).toBeCloseTo(-s.thickness, 3);
    const [b] = place(block(), spec({ quarter: 1 }));
    const [yLo, yHi] = extent(b.renderVertices!, 1);
    expect(yHi * 1000).toBeCloseTo(s.depth, 3);
    expect(yLo * 1000).toBeCloseTo(-s.thickness, 3);
    expect(hardwareSpecOf(b.renderVertices ? [b] : [], 'snap1')?.quarter).toBe(1);
  });
});

describe('snap catch', () => {
  it('cuts a window through the wall, the lip\'s size plus the fit', () => {
    const wall: SceneNode = { id: 'w', name: 'w', pos: [0, 0, 0], csgEnabled: true, geoms: [{ name: 'b', type: 'box', size: [0.002, 0.03, 0.03] } as SceneGeom] } as SceneNode;
    const [win] = place(wall, spec({ kind: 'snap_catch', at: [0.002, 0, 0], normal: [1, 0, 0] }));
    expect(win.csg).toBe('difference');
    const s = SNAP_SIZES.M;
    expect(win.size[0] * 2000).toBeCloseTo(snapLipHeight(s) + 0.3, 3);
    expect(win.size[1] * 2000).toBeCloseTo(s.width + 0.3, 3);
    // through: longer than the 4 mm wall
    expect(win.size[2] * 2000).toBeGreaterThan(4);
  });
});

describe('on a hollow box', () => {
  // 80 x 60 x 40 box, 2 mm walls, open top: outer minus inner, as a box is built here.
  const box = (): SceneNode => {
    const node = {
      id: 'box', name: 'box', pos: [0, 0, 0], csgEnabled: true,
      geoms: [
        { name: 'outer', type: 'box', size: [0.04, 0.03, 0.02] },
        { name: 'inner', type: 'box', size: [0.038, 0.028, 0.02], pos: [0, 0, 0.002], csg: 'difference' },
      ] as SceneGeom[],
    } as SceneNode;
    return node;
  };

  it('cuts the catch window through the near wall only', () => {
    const node = box();
    const [win] = place(node, spec({ kind: 'snap_catch', at: [0.04, 0, 0.005], normal: [1, 0, 0] }));
    // the window's centre sits in the +X wall, and it is about a wall long
    expect(win.pos![0] * 1000).toBeCloseTo(39, 1);
    expect(win.size[2] * 2000).toBeLessThan(4);
  });

  it('stands a hook on an inside face, on that wall, not the far one', () => {
    const node = box();
    const [hook] = place(node, spec({ at: [0.038, 0, 0.005], normal: [-1, 0, 0] }));
    const [xLo, xHi] = extent(hook.renderVertices!, 0);
    // from the inner face at x = 38 mm inward, not out from the -X wall
    expect(xHi * 1000).toBeGreaterThan(37);
    expect(xHi * 1000).toBeLessThan(40);
    expect(xLo * 1000).toBeGreaterThan(15);
  });

  it('never pokes the hook\'s root out through a thin lid', () => {
    const lid: SceneNode = { id: 'l', name: 'l', pos: [0, 0, 0], csgEnabled: true, geoms: [{ name: 'b', type: 'box', size: [0.06, 0.04, 0.001] } as SceneGeom] } as SceneNode;
    const [hook] = place(lid, spec({ at: [0, 0, -0.001], normal: [0, 0, -1] }));
    const [, zHi] = extent(hook.renderVertices!, 2);
    expect(zHi * 1000).toBeLessThan(1);
  });
});
