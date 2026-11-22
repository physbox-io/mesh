// Cloth on different layers never passes through each other (utils/cloth/clothLayers,
// utils/cloth/clothSelf, utils/cloth/clothCcd): whether an outer layer drops onto an
// inner layer worn beneath it, or a lower-numbered layer drops from above onto a
// higher-numbered layer, the upper sheet comes to rest a sheet's thickness clear above
// the lower sheet with zero crossings.

import { describe, it, expect } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import type { ClothSpec } from '../src/types/cloth';
import { clothRun } from './clothSimHarness';

function squareEdges(s: number): NonNullable<ClothSpec['pieces']>[number]['edges'] {
  return [
    { id: 'bottom', pts: [[-s / 2, -s / 2], [s / 2, -s / 2]] },
    { id: 'right', pts: [[s / 2, -s / 2], [s / 2, s / 2]] },
    { id: 'top', pts: [[s / 2, s / 2], [-s / 2, s / 2]] },
    { id: 'left', pts: [[-s / 2, s / 2], [-s / 2, -s / 2]] },
  ];
}

function sheet(id: string, side: number, z: number, layer: number): SceneNode {
  return {
    id,
    name: id,
    pos: [0, 0, z],
    cloth: {
      pieces: [{ name: id, edges: squareEdges(side), placement: { kind: 'plane' } }],
      spacing: 0.02,
      sewTime: 0,
      layer,
    },
  } as SceneNode;
}

/** Minimum height of particles in `[top0, top1)` over the horizontally nearest particle in `[bot0, bot1)`. */
function minGapAbove(x: Float64Array, bot0: number, bot1: number, top0: number, top1: number): number {
  let least = Infinity;
  for (let i = top0; i < top1; i++) {
    let bestD2 = Infinity;
    let bz = 0;
    for (let j = bot0; j < bot1; j++) {
      const d2 = (x[3 * i] - x[3 * j]) ** 2 + (x[3 * i + 1] - x[3 * j + 1]) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bz = x[3 * j + 2];
      }
    }
    least = Math.min(least, x[3 * i + 2] - bz);
  }
  return least;
}

describe('cloth across layers', () => {
  it('keeps an outer layer above an inner layer beneath it', async () => {
    const r = await clothRun([sheet('inner', 0.24, 0.006, 1), sheet('outer', 0.16, 0.04, 2)]);
    r.run(0.8);

    const nInner = r.models[0].invMass.length;
    const gap = minGapAbove(r.sim.x, 0, nInner, nInner, r.sim.n);
    const sep = Math.max(0.001, 0.5 * (r.models[0].material.thickness + r.models[1].material.thickness));

    expect(r.crossings()).toEqual([]);
    expect(gap).toBeGreaterThan(0.9 * sep);
  });

  it('keeps a lower-layer sheet on top when it falls onto a higher-layer sheet', async () => {
    const r = await clothRun([sheet('coat', 0.24, 0.006, 2), sheet('cap', 0.16, 0.12, 1)]);
    r.run(0.8);

    const nCoat = r.models[0].invMass.length;
    const gap = minGapAbove(r.sim.x, 0, nCoat, nCoat, r.sim.n);
    const sep = Math.max(0.001, 0.5 * (r.models[0].material.thickness + r.models[1].material.thickness));

    expect(r.crossings()).toEqual([]);
    expect(gap).toBeGreaterThan(0.9 * sep);
  });
});
