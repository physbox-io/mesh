import { describe, expect, it } from 'vitest';
import { clothRun } from './clothSimHarness';
import { urbanCollectionPreset } from '../src/presets/urbanCollection';

describe('cloth taken hold of while the scene runs (ClothSim.grab)', () => {
  it('pulls a hood down off the head and leaves it down when let go', async () => {
    const nodes = urbanCollectionPreset.nodes as never as { id: string }[];
    const r = await clothRun([nodes.find((n) => n.id === 'formB'), nodes.find((n) => n.id === 'hoodie')] as never);
    const m = r.models[0];
    const hood = m.groups.filter((g) => /hood[LR]$/.test(g.name));
    const hoodParticles = [...new Set(hood.flatMap((g) => g.particles))];
    const hoodTop = () => Math.max(...hoodParticles.map((p) => r.sim.x[3 * p + 2]));
    const hoodMeanZ = () => hoodParticles.reduce((s, p) => s + r.sim.x[3 * p + 2], 0) / hoodParticles.length;
    const hoodMeanSpeed = () => hoodParticles.reduce((s, p) => s + Math.hypot(r.sim.v[3 * p], r.sim.v[3 * p + 1], r.sim.v[3 * p + 2]), 0) / hoodParticles.length;
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
    const releasedMeanZ = hoodMeanZ();
    r.run(0.6);
    // Soft cotton jersey drapes down behind the neck and settles quickly rather
    // than springing back up against gravity and oscillating for seconds.
    expect(hoodMeanSpeed()).toBeLessThan(0.1);
    expect(hoodMeanZ()).toBeLessThanOrEqual(releasedMeanZ + 0.015);
    r.run(0.9);
    expect(hoodTop()).toBeLessThan(up - 0.15);
    expect(hoodMeanZ()).toBeLessThanOrEqual(releasedMeanZ + 0.015);
    expect(r.crossings().length).toBeLessThan(before + 20);
    expect(r.speedOver(0.2)).toBeLessThan(0.02);
  }, 600000);
});
