import { describe, it, expect } from 'vitest';
import { urbanCollectionPreset } from '../src/presets/urbanCollection';
import { clothRun, percentile } from './clothSimHarness';
import { findCrossings, untangleMesh } from '../src/utils/cloth/clothUntangle';
import type { ClothModel } from '../src/utils/cloth/clothModel';
import type { SceneNode } from '../src/types/scene';

/** Area-weighted edge strain distribution for a single ClothModel (matching clothSimHarness.strains). */
function modelStrains(model: ClothModel, base: number, x: Float64Array): number[] {
  const n = model.invMass.length;
  const at = new Map<number, number>();
  for (let t = 0; t < model.tris.length; t += 3) {
    const [a, b, c] = [model.tris[t], model.tris[t + 1], model.tris[t + 2]].map((v) => [
      model.x0[3 * v],
      model.x0[3 * v + 1],
      model.x0[3 * v + 2],
    ]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const third = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 6;
    for (let e = 0; e < 3; e++) {
      const p = model.tris[t + e];
      const q = model.tris[t + ((e + 1) % 3)];
      const k = p < q ? p * n + q : q * n + p;
      at.set(k, (at.get(k) ?? 0) + third);
    }
  }
  const all: [number, number][] = [];
  let whole = 0;
  for (let k = 0; k < model.edges.length; k += 2) {
    const p = model.edges[k];
    const q = model.edges[k + 1];
    const i = 3 * (base + p);
    const j = 3 * (base + q);
    const rest = model.edgeRest[k / 2];
    const wt = at.get(p < q ? p * n + q : q * n + p) ?? (rest * rest) / 4;
    const len = Math.hypot(x[i] - x[j], x[i + 1] - x[j + 1], x[i + 2] - x[j + 2]);
    all.push([len / rest - 1, wt]);
    whole += wt;
  }
  all.sort((p, q) => p[0] - q[0]);
  const out: number[] = [];
  for (let k = 0, acc = 0; k < all.length; k++) {
    acc += all[k][1];
    while (out.length < all.length && (out.length + 1) * whole <= acc * all.length * (1 + 1e-12)) out.push(all[k][0]);
  }
  while (out.length < all.length) out.push(all[all.length - 1][0]);
  return out;
}

describe('baseball cap knocked off onto puffer shoulder (urban_collection)', () => {
  it('collides cap cleanly with puffer shoulder (both right-side-up grab & upside-down drop) without engulfing, spiking, or stretching', async () => {
    const allNodes = structuredClone(urbanCollectionPreset.nodes) as SceneNode[];
    const lookANodes = allNodes.filter((n) => ['formA', 'neckerchief', 'shorts', 'puffer', 'cap'].includes(n.id));
    const r = await clothRun(lookANodes);

    const sim = r.sim as unknown as {
      n: number;
      x: Float64Array;
      v: Float64Array;
      tris: Int32Array;
      stitches: Int32Array;
    };
    let base = 0;
    const ranges = new Map<string, { base: number; count: number; modelIdx: number }>();
    r.models.forEach((m, idx) => {
      ranges.set(m.name, { base, count: m.invMass.length, modelIdx: idx });
      base += m.invMass.length;
    });

    const capRange = ranges.get('cap')!;
    const pufferRange = ranges.get('puffer')!;
    const capModel = r.models[capRange.modelIdx];
    const pufferModel = r.models[pufferRange.modelIdx];
    const mesh = untangleMesh(sim.n, sim.tris, sim.stitches);
    const isCap = (p: number) => p >= capRange.base && p < capRange.base + capRange.count;
    const isPuffer = (p: number) => p >= pufferRange.base && p < pufferRange.base + pufferRange.count;

    const countCapPufferCrossings = () =>
      findCrossings(sim.x, mesh).filter((c) => {
        const t0 = sim.tris[3 * c.t];
        return (isCap(c.a) && isPuffer(t0)) || (isPuffer(c.a) && isCap(t0));
      }).length;

    const capSpan = () => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < capRange.count; i++) {
        const k = 3 * (capRange.base + i);
        minX = Math.min(minX, sim.x[k]); maxX = Math.max(maxX, sim.x[k]);
        minY = Math.min(minY, sim.x[k + 1]); maxY = Math.max(maxY, sim.x[k + 1]);
        minZ = Math.min(minZ, sim.x[k + 2]); maxZ = Math.max(maxZ, sim.x[k + 2]);
      }
      return { minX, maxX, minY, maxY, minZ, maxZ, dx: maxX - minX, dy: maxY - minY, dz: maxZ - minZ };
    };

    const initialSpan = capSpan();
    const initialSnap = r.sim.state();
    const initCapS = modelStrains(capModel, capRange.base, sim.x);
    const initPufS = modelStrains(pufferModel, pufferRange.base, sim.x);

    // Measure initial shoulder top Z of puffer on both shoulders before cap touches it
    let initRightShoulderZ = -Infinity;
    let initLeftShoulderZ = -Infinity;
    for (let i = 0; i < pufferRange.count; i++) {
      const k = 3 * (pufferRange.base + i);
      if (sim.x[k] < -0.58 && sim.x[k] > -0.70) initRightShoulderZ = Math.max(initRightShoulderZ, sim.x[k + 2]);
      if (sim.x[k] > -0.38 && sim.x[k] < -0.26) initLeftShoulderZ = Math.max(initLeftShoulderZ, sim.x[k + 2]);
    }

    // -------------------------------------------------------------------------
    // Scenario 1: Grab cap off formA's head onto right shoulder (-x, uploaded_media_1795206906465.bmp)
    // -------------------------------------------------------------------------
    let renderOffset = 0;
    for (let i = 0; i < capRange.modelIdx; i++) {
      for (const g of r.models[i].groups) renderOffset += g.particles.length;
    }
    let grabRenderIdx = -1;
    let grabParticle = -1;
    let maxZ = -Infinity;
    let o = renderOffset;
    for (const g of capModel.groups) {
      g.particles.forEach((lp, li) => {
        const gp = capRange.base + lp;
        const z = sim.x[3 * gp + 2];
        if (z > maxZ) {
          maxZ = z;
          grabRenderIdx = o + li;
          grabParticle = gp;
        }
      });
      o += g.particles.length;
    }

    const p0 = [sim.x[3 * grabParticle], sim.x[3 * grabParticle + 1], sim.x[3 * grabParticle + 2]];
    // Lift up off the skull and carry over wearer's right shoulder top (x ~ -0.66)
    const via = [p0[0] - 0.10, p0[1] - 0.01, p0[2] + 0.11];
    const overRightShoulder = [p0[0] - 0.20, p0[1] - 0.01, p0[2] + 0.02];
    let worstGrabCapP95 = 0;
    let worstGrabCapP99 = 0;
    for (let step = 1; step <= 16; step++) {
      const f = step / 16;
      const a = f < 0.5 ? p0 : via;
      const b = f < 0.5 ? via : overRightShoulder;
      const u = f < 0.5 ? f / 0.5 : (f - 0.5) / 0.5;
      r.sim.grab(grabRenderIdx, [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      r.run(0.03);
      const cs = modelStrains(capModel, capRange.base, sim.x);
      worstGrabCapP95 = Math.max(worstGrabCapP95, percentile(cs, 0.95));
      worstGrabCapP99 = Math.max(worstGrabCapP99, percentile(cs, 0.99));
    }
    r.sim.grab(null, null);

    // Check while colliding across right shoulder (0.35 s) and after 1.5 s
    r.run(0.35);
    const midCrossings = countCapPufferCrossings();
    const midPufS = modelStrains(pufferModel, pufferRange.base, sim.x);
    const midCapS = modelStrains(capModel, capRange.base, sim.x);
    let maxRightShoulderZ = -Infinity;
    for (let i = 0; i < pufferRange.count; i++) {
      const k = 3 * (pufferRange.base + i);
      if (sim.x[k] < -0.58 && sim.x[k] > -0.70) maxRightShoulderZ = Math.max(maxRightShoulderZ, sim.x[k + 2]);
    }

    r.run(1.25);
    const endCrossings1 = countCapPufferCrossings();
    const endPufS1 = modelStrains(pufferModel, pufferRange.base, sim.x);
    const endCapS1 = modelStrains(capModel, capRange.base, sim.x);
    const endSpan1 = capSpan();

    console.log('Scenario 1 (grab onto right shoulder):', {
      initCapP95: +(percentile(initCapS, 0.95) * 100).toFixed(2) + '%',
      initCapP99: +(percentile(initCapS, 0.99) * 100).toFixed(2) + '%',
      worstGrabCapP95: +(worstGrabCapP95 * 100).toFixed(2) + '%',
      worstGrabCapP99: +(worstGrabCapP99 * 100).toFixed(2) + '%',
      midCapP95: +(percentile(midCapS, 0.95) * 100).toFixed(2) + '%',
      midCapP99: +(percentile(midCapS, 0.99) * 100).toFixed(2) + '%',
      endCapP95: +(percentile(endCapS1, 0.95) * 100).toFixed(2) + '%',
      endCapP99: +(percentile(endCapS1, 0.99) * 100).toFixed(2) + '%',
      initPufP99: +(percentile(initPufS, 0.99) * 100).toFixed(2) + '%',
      midPufP99: +(percentile(midPufS, 0.99) * 100).toFixed(2) + '%',
      endPufP99: +(percentile(endPufS1, 0.99) * 100).toFixed(2) + '%',
      initRightShoulderZ: +initRightShoulderZ.toFixed(4),
      maxRightShoulderZ: +maxRightShoulderZ.toFixed(4),
      midCrossings,
      endCrossings1,
      endSpan1,
    });

    expect(midCrossings).toBe(0);
    expect(endCrossings1).toBe(0);
    // Cap comes completely off the head (drops below head height z = 1.55)
    expect(endSpan1.maxZ).toBeLessThan(1.55);
    // Cap stays crisp & non-rubbery under grab (< 4.5% p95, < +5% p99 under single-vertex tug) and after release
    expect(worstGrabCapP95).toBeLessThan(0.045);
    expect(worstGrabCapP99).toBeLessThan(percentile(initCapS, 0.99) + 0.05);
    expect(percentile(midCapS, 0.95)).toBeLessThan(0.04);
    expect(percentile(endCapS1, 0.95)).toBeLessThan(0.04);
    expect(percentile(endCapS1, 0.99)).toBeLessThan(percentile(initCapS, 0.99) + 0.02);
    // Puffer shoulder NEVER erupts upward over the cap and keeps low strain (< 6% p99)
    expect(maxRightShoulderZ).toBeLessThanOrEqual(initRightShoulderZ + 0.008);
    expect(percentile(midPufS, 0.99)).toBeLessThan(0.06);
    expect(percentile(endPufS1, 0.99)).toBeLessThan(0.06);

    // -------------------------------------------------------------------------
    // Scenario 2: Cap flipped upside-down (bowl facing +Z) directly onto left shoulder (+x, media_0.png)
    // -------------------------------------------------------------------------
    r.sim.restore(initialSnap);
    // Rotate cap 180 deg around Y (flipping Z upside-down, keeping proper right-handed orientation!)
    // and place it just clear above wearer's left shoulder (x ~ -0.33, y ~ -0.02, z_bottom ~ initLeftShoulderZ + 0.015)
    const cx0 = 0.5 * (initialSpan.minX + initialSpan.maxX);
    const cy0 = 0.5 * (initialSpan.minY + initialSpan.maxY);
    const cz0 = 0.5 * (initialSpan.minZ + initialSpan.maxZ);
    const targetCx = -0.33;
    const targetCy = -0.02;
    const targetCz = initLeftShoulderZ + 0.018 + 0.5 * initialSpan.dz;
    for (let i = 0; i < capRange.count; i++) {
      const k = 3 * (capRange.base + i);
      const rx = sim.x[k] - cx0;
      const ry = sim.x[k + 1] - cy0;
      const rz = sim.x[k + 2] - cz0;
      // 180 deg rotation about Y-axis: (rx, ry, rz) -> (-rx, ry, -rz)
      sim.x[k] = targetCx - rx;
      sim.x[k + 1] = targetCy + ry;
      sim.x[k + 2] = targetCz - rz;
      sim.v[k] = 0;
      sim.v[k + 1] = 0;
      sim.v[k + 2] = 0;
    }
    // Re-sync internal prev/ccdFrom via restore with zeroed board quats so warm-start refits 180 deg cleanly
    const flippedSnap = r.sim.state();
    r.sim.restore({ ...flippedSnap, boardsQ: undefined });

    r.run(0.4);
    const upsideDownCrossMid = countCapPufferCrossings();
    const upsideDownPufMid = modelStrains(pufferModel, pufferRange.base, sim.x);
    const upsideDownCapMid = modelStrains(capModel, capRange.base, sim.x);
    let maxLeftShoulderZ = -Infinity;
    for (let i = 0; i < pufferRange.count; i++) {
      const k = 3 * (pufferRange.base + i);
      if (sim.x[k] > -0.38 && sim.x[k] < -0.26) maxLeftShoulderZ = Math.max(maxLeftShoulderZ, sim.x[k + 2]);
    }

    r.run(1.2);
    const upsideDownCrossEnd = countCapPufferCrossings();
    const upsideDownPufEnd = modelStrains(pufferModel, pufferRange.base, sim.x);
    const upsideDownCapEnd = modelStrains(capModel, capRange.base, sim.x);
    const endSpan2 = capSpan();

    console.log('Scenario 2 (upside-down drop onto left shoulder):', {
      upsideDownCapMidP95: +(percentile(upsideDownCapMid, 0.95) * 100).toFixed(2) + '%',
      upsideDownCapMidP99: +(percentile(upsideDownCapMid, 0.99) * 100).toFixed(2) + '%',
      upsideDownCapEndP95: +(percentile(upsideDownCapEnd, 0.95) * 100).toFixed(2) + '%',
      upsideDownCapEndP99: +(percentile(upsideDownCapEnd, 0.99) * 100).toFixed(2) + '%',
      upsideDownPufMidP99: +(percentile(upsideDownPufMid, 0.99) * 100).toFixed(2) + '%',
      upsideDownPufEndP99: +(percentile(upsideDownPufEnd, 0.99) * 100).toFixed(2) + '%',
      initLeftShoulderZ: +initLeftShoulderZ.toFixed(4),
      maxLeftShoulderZ: +maxLeftShoulderZ.toFixed(4),
      upsideDownCrossMid,
      upsideDownCrossEnd,
      endSpan2,
    });

    expect(upsideDownCrossMid).toBe(0);
    expect(upsideDownCrossEnd).toBe(0);
    expect(maxLeftShoulderZ).toBeLessThanOrEqual(initLeftShoulderZ + 0.008);
    expect(percentile(upsideDownCapMid, 0.95)).toBeLessThan(0.045);
    expect(percentile(upsideDownCapEnd, 0.95)).toBeLessThan(0.045);
    expect(percentile(upsideDownCapMid, 0.99)).toBeLessThan(percentile(initCapS, 0.99) + 0.025);
    expect(percentile(upsideDownCapEnd, 0.99)).toBeLessThan(percentile(initCapS, 0.99) + 0.025);
    expect(percentile(upsideDownPufMid, 0.99)).toBeLessThan(0.065);
    expect(percentile(upsideDownPufEnd, 0.99)).toBeLessThan(0.065);
    // Structured dome holds its volume (does not pancake flat; smallest bounding span stays > 14 cm)
    expect(Math.min(endSpan2.dx, endSpan2.dy, endSpan2.dz)).toBeGreaterThan(0.14);
  }, 240_000);
});
