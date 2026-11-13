import { describe, expect, it } from 'vitest';
import { clothRun } from './clothSimHarness';
import { urbanCollectionPreset } from '../src/presets/urbanCollection';

describe('cloth taken hold of while the scene runs (ClothSim.grab)', () => {
  it('pulls a hood down off the head and leaves it down when let go', async () => {
    const nodes = urbanCollectionPreset.nodes as never as { id: string }[];
    const r = await clothRun([nodes.find((n) => n.id === 'formB'), nodes.find((n) => n.id === 'hoodie')] as never);
    const m = r.models[0];
    const hood = m.groups.filter((g) => /hood[LR]$/.test(g.name));
    const hoodTop = () => Math.max(...hood.flatMap((g) => g.particles.map((p) => r.sim.x[3 * p + 2])));
    // The hood's highest point, by its index as drawn.
    let o = 0, idx = -1, top = -1, pz = -Infinity;
    for (const g of m.groups) { if (g.name.endsWith('hoodL')) g.particles.forEach((p, l) => { if (r.sim.x[3 * p + 2] > pz) { pz = r.sim.x[3 * p + 2]; idx = o + l; top = p; } }); o += g.particles.length; }
    const up = hoodTop();
    r.run(0.5);
    const before = r.crossings().length;
    const x0 = [0, 1, 2].map((c) => r.sim.x[3 * top + c]), via = [x0[0], x0[1] + 0.2, x0[2] + 0.12], to = [x0[0], x0[1] + 0.25, x0[2] - 0.45];
    // Up and back over the head, then down behind the neck, as a hand would.
    for (let k = 1; k <= 30; k++) {
      const f = k / 30, a = f < 0.4 ? x0 : via, b = f < 0.4 ? via : to, t = f < 0.4 ? f / 0.4 : (f - 0.4) / 0.6;
      r.sim.grab(idx, [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * t));
      r.run(0.05);
    }
    r.sim.grab(idx, to);
    r.run(0.5);
    expect(Math.hypot(...[0, 1, 2].map((c) => r.sim.x[3 * top + c] - to[c]))).toBeLessThan(0.03);
    r.sim.grab(null, null);
    r.run(1.5);
    expect(hoodTop()).toBeLessThan(up - 0.15);
    expect(r.crossings().length).toBeLessThan(before + 20);
    expect(r.speedOver(0.2)).toBeLessThan(0.02);
  }, 600000);
});
