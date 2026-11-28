// A pass that only pushes does not ask a collider again about a point that
// cannot have come within the margin since it last read it (a distance
// changes no faster than the collider's Lipschitz bound). The cloth ends
// exactly where it does asking every time.

import { describe, it, expect } from 'vitest';
import { buildSdf } from '../src/utils/cloth/clothColliders';
import { resizePiece, sheetNode } from '../src/utils/cloth/clothSheet';
import type { SceneNode } from '../src/types/scene';
import { clothRun } from './clothSimHarness';

const scene = (): SceneNode[] => {
  const ramp = { id: 'ramp', name: 'ramp', pos: [0, 0, 0], isWedge: true, width: 0.6, depth: 0.6, height: 0.3, geoms: [{ name: 'ramp_g', type: 'box', size: [0.3, 0.3, 0.15] }] } as unknown as SceneNode;
  const ball = { id: 'ball', name: 'ball', pos: [0.15, 0.1, 0.33], geoms: [{ name: 'ball_g', type: 'sphere', size: [0.06], rgba: [1, 1, 1, 1] }], joints: [], children: [] } as unknown as SceneNode;
  const s = sheetNode([ramp, ball], null, [0.05, 0]);
  s.pos = [0.05, 0, 0.45];
  s.cloth!.pieces = [resizePiece(s.cloth!.pieces![0], 0.5, 0.5)];
  return [ramp, ball, s];
};

describe('collider distance cache', () => {
  it('a grid distance changes no faster than its bound', () => {
    // A closed tetrahedron-ish mesh: a box.
    const p = [[0, 0, 0], [0.3, 0, 0], [0.3, 0.2, 0], [0, 0.2, 0], [0, 0, 0.1], [0.3, 0, 0.1], [0.3, 0.2, 0.1], [0, 0.2, 0.1]];
    const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
    const g = buildSdf(p, f), L = g.lipschitz();
    expect(L).toBeGreaterThan(0.9);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 2000; k++) {
      const a = [rnd() * 0.4 - 0.05, rnd() * 0.3 - 0.05, rnd() * 0.2 - 0.05];
      const b = a.map((v) => v + (rnd() - 0.5) * 0.02);
      const da = g.value(a[0], a[1], a[2]), db = g.value(b[0], b[1], b[2]);
      if (Number.isNaN(da) || Number.isNaN(db)) continue;
      expect(Math.abs(da - db)).toBeLessThanOrEqual(L * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) + 1e-9);
    }
  });

  it('leaves the cloth bit-identical to asking every time', async () => {
    const a = await clothRun(scene());
    const b = await clothRun(scene());
    expect(a.colliders.some((c) => c.shape.kind === 'sdf')).toBe(true);
    const off = b.sim as unknown as { colD: Float64Array | null };
    expect(off.colD).not.toBeNull();
    off.colD = null; // b asks every collider every time
    a.run(0.6); b.run(0.6);
    expect(Array.from(a.sim.x)).toEqual(Array.from(b.sim.x));
  }, 200_000);
});
