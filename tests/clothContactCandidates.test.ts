// Self and layer contacts test each particle only against the triangles
// listed near it at the last hash rebuild (by true distance), and rebuild the
// hash only once the cloth has moved (self) or every few substeps (layers).
// Looking afresh every time gives the same cloth: forced rebuilds (self) and
// a full scan of the particle's cell every call (layers) leave it
// bit-identical.

import { describe, it, expect } from 'vitest';
import { resizePiece, sheetNode } from '../src/utils/cloth/clothSheet';
import type { SceneNode } from '../src/types/scene';
import { clothRun } from './clothSimHarness';

function squareEdges(s: number) {
  return [
    { id: 'bottom', pts: [[-s / 2, -s / 2], [s / 2, -s / 2]] },
    { id: 'right', pts: [[s / 2, -s / 2], [s / 2, s / 2]] },
    { id: 'top', pts: [[s / 2, s / 2], [-s / 2, s / 2]] },
    { id: 'left', pts: [[-s / 2, s / 2], [-s / 2, -s / 2]] },
  ];
}
const layered = (id: string, side: number, z: number, layer: number) => ({
  id, name: id, pos: [0, 0, z],
  cloth: { pieces: [{ name: id, edges: squareEdges(side), placement: { kind: 'plane' } }], spacing: 0.02, sewTime: 0, layer },
} as unknown as SceneNode);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('contact candidate lists', () => {
  it('self: a sheet folding over a ball, rebuilt every substep or only once moved, ends the same', async () => {
    const scene = () => {
      const ball = { id: 'ball', name: 'ball', pos: [0, 0, 0.3], geoms: [{ name: 'ball_g', type: 'sphere', size: [0.08], rgba: [1, 1, 1, 1] }], joints: [], children: [] } as unknown as SceneNode;
      const s = sheetNode([ball], null, [0, 0]);
      s.pos = [0, 0, 0.42];
      s.cloth!.pieces = [resizePiece(s.cloth!.pieces![0], 0.5, 0.5)];
      return [ball, s];
    };
    const a = await clothRun(scene()), b = await clothRun(scene());
    const self = (b.sim as any).self;
    expect(self.active).toBe(true);
    const orig = self.collide.bind(self);
    self.collide = (x: Float64Array, prev: Float64Array, step = true) => { if (step) for (const g of self.groups) g.built = false; return orig(x, prev, step); };
    a.run(0.8); b.run(0.8);
    expect(Array.from(a.sim.x)).toEqual(Array.from(b.sim.x));
  }, 200_000);

  it('layers: an outer sheet dropped on an inner one, listed or scanned, ends the same', async () => {
    const scene = () => [layered('inner', 0.24, 0.006, 1), layered('outer', 0.16, 0.04, 2)];
    const a = await clothRun(scene()), b = await clothRun(scene());
    const layers = (b.sim as any).layers;
    expect(layers.active).toBe(true);
    const orig = layers.collide.bind(layers);
    layers.collide = (...args: unknown[]) => { for (const g of layers.groups) g.xp.fill(Infinity); return orig(...args); };
    a.run(0.8); b.run(0.8);
    expect(Array.from(a.sim.x)).toEqual(Array.from(b.sim.x));
    expect(a.crossings()).toEqual([]);
  }, 200_000);
});
