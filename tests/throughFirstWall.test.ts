// "Through" means through the wall the cut is on. On a hollow box that is one
// side: a cable hole in an enclosure must not come out of the opposite side.
// The far wall gets its own hole if it needs one.

import { describe, it, expect } from 'vitest';
import { hardwareCutGeoms } from '../src/utils/hardwareCuts';
import { cutGeometry, surfaceUnder, reconcileCuts } from '../src/utils/csg';
import type { SceneGeom, SceneNode } from '../src/types/scene';

// 80 x 60 x 40 box, 2 mm walls, open top: outer minus inner.
const box = (): SceneNode => ({
  id: 'box', name: 'box', pos: [0, 0, 0], csgEnabled: true,
  geoms: [
    { name: 'outer', type: 'box', size: [0.04, 0.03, 0.02] },
    { name: 'inner', type: 'box', size: [0.038, 0.028, 0.02], pos: [0, 0, 0.002], csg: 'difference' },
  ] as SceneGeom[],
} as SceneNode);

const xRange = (g: SceneGeom): [number, number] => {
  const half = g.size[1]; // cylinder half-length, along the cut's line (X here)
  return [(g.pos![0] - half) * 1000, (g.pos![0] + half) * 1000];
};

const hole = (at: number[], normal: number[]): SceneGeom => ({
  name: 'h', type: 'cylinder', size: [0.0015, 0.01], csg: 'difference', cutAt: at, cutNormal: normal,
} as SceneGeom);

describe('a through hole on a hollow box', () => {
  it('measures the side wall, not the box', () => {
    const under = surfaceUnder(box(), [0.04, 0, 0.005], [1, 0, 0])!;
    expect(under.entry[0] * 1000).toBeCloseTo(40, 6);
    expect(under.thickness * 1000).toBeCloseTo(2, 6);
  });

  it('cuts the near wall only', () => {
    const node = box();
    const h = hole([0.04, 0, 0.005], [1, 0, 0]);
    node.geoms.push(h);
    Object.assign(h, cutGeometry(node, h));
    const [lo, hi] = xRange(h);
    expect(lo).toBeGreaterThan(30); // nowhere near the -X wall at -40..-38
    expect(lo).toBeLessThan(38);
    expect(hi).toBeGreaterThan(40);
  });

  it('cuts an inside face\'s own wall, where the first surface from outside is the far wall', () => {
    const node = box();
    const h = hole([0.038, 0, 0.005], [-1, 0, 0]);
    node.geoms.push(h);
    Object.assign(h, cutGeometry(node, h));
    const [lo, hi] = xRange(h);
    expect(lo).toBeGreaterThan(30);
    expect(hi).toBeGreaterThan(40);
    reconcileCuts(node);
    expect(h.cutAt![0] * 1000).toBeCloseTo(38, 6); // the anchor stays on the face it was put on
  });

  it('gives a nut trap\'s bolt hole the one wall, with the pocket in it', () => {
    const node = box();
    const pieces = hardwareCutGeoms({ group: 'g', kind: 'nut_trap', size: 'M3', at: [0.04, 0, 0.005], normal: [1, 0, 0] }, 'box', node);
    for (const p of pieces) { node.geoms.push(p); Object.assign(p, cutGeometry(node, p)); }
    for (const p of pieces) expect(xRange(p)[0]).toBeGreaterThan(30);
  });

  it('still goes right through a solid block', () => {
    const node: SceneNode = { id: 'b', name: 'b', pos: [0, 0, 0], csgEnabled: true, geoms: [{ name: 'b', type: 'box', size: [0.02, 0.02, 0.01] } as SceneGeom] } as SceneNode;
    const h = hole([0, 0, 0.01], [0, 0, 1]);
    node.geoms.push(h);
    Object.assign(h, cutGeometry(node, h));
    expect((h.pos![2] - h.size[1]) * 1000).toBeLessThan(-10);
  });

  it('follows a face that has moved out, as before', () => {
    const node: SceneNode = { id: 'b', name: 'b', pos: [0, 0, 0], csgEnabled: true, geoms: [{ name: 'b', type: 'box', size: [0.02, 0.02, 0.02] } as SceneGeom] } as SceneNode;
    // anchored where the top used to be, 10 mm under the top now
    const under = surfaceUnder(node, [0, 0, 0.01], [0, 0, 1])!;
    expect(under.entry[2] * 1000).toBeCloseTo(20, 6);
    expect(under.thickness * 1000).toBeCloseTo(40, 6);
  });
});
