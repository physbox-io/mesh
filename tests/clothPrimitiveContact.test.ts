// Simple shapes answer for cloth just off them, not only once it is inside:
// the standoff (the cloth's thickness) and friction need the contact while
// the cloth is still outside. And a capped cylinder's distance is exact
// inside near its flat ends, on its axis, and off its rim.

import { describe, it, expect } from 'vitest';
import { colliderContact, sceneColliders } from '../src/utils/cloth/clothColliders';
import { resizePiece, sheetNode } from '../src/utils/cloth/clothSheet';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import type { SceneNode } from '../src/types/scene';
import { clothRun } from './clothSimHarness';

const body = (id: string, pos: number[], geom: Record<string, unknown>): SceneNode => ({
  id, name: id, pos, geoms: [{ name: `${id}_g`, rgba: [0.6, 0.6, 0.6, 1], ...geom }], joints: [], children: [],
} as unknown as SceneNode);

describe('primitive collider contact', () => {
  const cs = sceneColliders([
    body('box', [0, 0, 0], { type: 'box', size: [0.3, 0.2, 0.4] }),
    body('sph', [0, 0, 0], { type: 'sphere', size: [0.1] }),
    body('ell', [0, 0, 0], { type: 'ellipsoid', size: [0.1, 0.2, 0.3] }),
    body('cap', [0, 0, 0], { type: 'capsule', size: [0.05, 0.2] }),
    body('cyl', [0, 0, 0], { type: 'cylinder', size: [0.4, 0.02] }),
  ], false);
  const [box, sph, ell, cap, cyl] = cs;
  const at = (c: typeof box, p: number[]) => colliderContact(c, p);

  it('reads cloth 2 mm off each shape as 2 mm off, not as no contact', () => {
    for (const [c, p] of [[box, [0, 0, 0.402]], [box, [0.302, 0, 0]], [sph, [0, 0, 0.102]], [ell, [0, 0, 0.302]], [cap, [0.052, 0, 0]], [cap, [0, 0, 0.252]], [cyl, [0.402, 0, 0]], [cyl, [0, 0, 0.022]]] as const) {
      const h = at(c, p as number[]);
      expect(h, `${c.shape.kind} at ${p}`).not.toBeNull();
      expect(h!.d).toBeCloseTo(0.002, 4);
    }
  });

  it('a point 1 mm under a cylinder top is 1 mm inside, pushed up', () => {
    const h = at(cyl, [0.1, 0, 0.019])!;
    expect(h.d).toBeCloseTo(-0.001, 6);
    expect(h.n[2]).toBeCloseTo(1, 6);
  });

  it('a point on a cylinder or capsule axis has a normal', () => {
    const tall = sceneColliders([body('t', [0, 0, 0], { type: 'cylinder', size: [0.05, 0.5] })], false)[0];
    for (const c of [tall, cap]) {
      const h = at(c, [0, 0, 0])!;
      expect(h.d).toBeCloseTo(-0.05, 6);
      expect(Math.hypot(...h.n)).toBeCloseTo(1, 6);
      expect(h.n[2]).toBeCloseTo(0, 6); // sideways, the nearest way out
    }
  });

  it('off a cylinder rim, the distance and normal come from the rim', () => {
    const h = at(cyl, [0.43, 0, 0.06])!;
    expect(h.d).toBeCloseTo(Math.hypot(0.03, 0.04), 6);
    expect(h.n[0]).toBeCloseTo(0.6, 6);
    expect(h.n[2]).toBeCloseTo(0.8, 6);
  });

  it('a sheet on a box keeps the cloth thickness off it', async () => {
    const table = body('table', [0, 0, 0.4], { type: 'box', size: [0.3, 0.2, 0.4] });
    const r = await clothRun([table, sheetNode([table], table)]);
    r.run(2.0);
    const ds: number[] = [];
    for (let i = 0; i < r.sim.n; i++) {
      const q = [Math.abs(r.sim.x[3 * i]) - 0.3, Math.abs(r.sim.x[3 * i + 1]) - 0.2, Math.abs(r.sim.x[3 * i + 2] - 0.4) - 0.4];
      const o = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
      const d = o > 0 ? o : Math.max(...q);
      if (d < 0.02) ds.push(d);
    }
    ds.sort((a, b) => a - b);
    expect(ds.length).toBeGreaterThan(50);
    // Every particle near it at the full thickness (it lay 0.03 mm off it).
    expect(ds[0]).toBeGreaterThan(0.95 * CLOTH_THICKNESS);
  }, 200_000);

  it('friction holds a sheet on a box tilted under its friction angle', async () => {
    const table = body('table', [0, 0, 0.4], { type: 'box', size: [0.6, 0.6, 0.4], friction: [0.8, 0.005, 0.0001] });
    const s = sheetNode([table], null, [0, 0]);
    s.pos = [0, 0, 0.83];
    s.cloth!.pieces = [resizePiece(s.cloth!.pieces![0], 0.3, 0.3)];
    const r = await clothRun([table, s]);
    const cy = () => { let y = 0; for (let i = 1; i < r.sim.x.length; i += 3) y += r.sim.x[i]; return y / r.sim.n; };
    r.run(0.5);
    const y0 = cy();
    const ang = (25 * Math.PI) / 180; // tan 25° = 0.47 < 0.8
    r.run(1.5, { gravity: [0, 9.81 * Math.sin(ang), -9.81 * Math.cos(ang)] });
    expect(Math.abs(cy() - y0)).toBeLessThan(0.005);
  }, 200_000);
});
