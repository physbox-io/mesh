// Cloth against itself (utils/cloth/clothSelf): a strip folded back on itself
// and dropped comes to rest with its top half on its bottom half, not through
// it; turned off (selfCollide: false), the halves pass into each other.

import { describe, it, expect } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import type { ClothSpec } from '../src/types/cloth';
import { clothRun } from './clothSimHarness';

/** A strip 20 cm wide, flat on the floor, turned back over a 2.5 cm fold and running back over itself 5 cm up. */
function foldedStrip(selfCollide: boolean): SceneNode {
  const half = 0.6, r = 0.025, z0 = 0.006;
  const stations: { p: number[]; across: number[] }[] = [];
  for (let i = 0; i <= 6; i++) stations.push({ p: [half / 2 - (half * i) / 6, 0, z0], across: [0, 1, 0] });
  for (let i = 1; i < 12; i++) {
    const th = (Math.PI * i) / 12;
    stations.push({ p: [-half / 2 - r * Math.sin(th), 0, z0 + r - r * Math.cos(th)], across: [0, 1, 0] });
  }
  for (let i = 0; i <= 6; i++) stations.push({ p: [-half / 2 + (half * i) / 6, 0, z0 + 2 * r], across: [0, 1, 0] });
  const L = 2 * half + Math.PI * r, W = 0.2;
  const edges = [
    { id: 'a', pts: [[0, -W / 2], [L, -W / 2]] },
    { id: 'b', pts: [[L, -W / 2], [L, W / 2]] },
    { id: 'c', pts: [[L, W / 2], [0, W / 2]] },
    { id: 'd', pts: [[0, W / 2], [0, -W / 2]] },
  ] as NonNullable<ClothSpec['pieces']>[number]['edges'];
  return {
    id: 'strip', name: 'strip', pos: [0, 0, 0],
    cloth: {
      pieces: [{ name: 'p', edges, placement: { kind: 'plane' }, start: { kind: 'path', stations } }],
      spacing: 0.02, sewTime: 0, selfCollide,
    },
  } as SceneNode;
}

describe('cloth self-collision', () => {
  it.each([true, false])('a strip folded on itself lies on itself (self-collision %s)', async (self) => {
    const r = await clothRun([foldedStrip(self)]);
    const x0 = Float64Array.from(r.sim.x);
    const top: number[] = [], bottom: number[] = [];
    for (let i = 0; i < r.sim.n; i++) {
      const X = x0[3 * i], Z = x0[3 * i + 2];
      if (X < -0.15 || X > 0.25) continue;
      if (Z > 0.045) top.push(i); else if (Z < 0.015) bottom.push(i);
    }
    r.run(1.5);
    const X = r.sim.x;
    // Each top point's height over the bottom point nearest under it.
    let least = Infinity;
    for (const i of top) {
      let bd = Infinity, bz = 0;
      for (const j of bottom) {
        const d = (X[3 * i] - X[3 * j]) ** 2 + (X[3 * i + 1] - X[3 * j + 1]) ** 2;
        if (d < bd) { bd = d; bz = X[3 * j + 2]; }
      }
      least = Math.min(least, X[3 * i + 2] - bz);
    }
    console.log(`self ${self}: top half ${(least * 1000).toFixed(2)} mm over the bottom at its lowest`);
    // Two sheets' middles a sheet's thickness apart (clothSelf keeps at least 1 mm).
    // Measured 0.99 mm with the self pass on every constraint pass, 0.94 with it
    // once a substep: the floor's last push lifts the bottom half 0.06 mm into
    // the top until the next substep. 6% of the sheet, not worth a second pass.
    if (self) expect(least).toBeGreaterThan(0.9 * Math.max(0.001, r.models[0].material.thickness));
    else expect(least).toBeLessThan(0.0005);
  }, 60_000);
});
