// Garments drafted onto a body form, sewn and draped in real MuJoCo: every
// seam closes and the garment hangs on the form instead of falling off it.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { applyCloth, initClothRuntime } from '../src/utils/cloth/clothStep';
import { meshCloth } from '../src/utils/cloth/clothMesh';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyLandmarks, ellipseHalfWidth } from '../src/utils/cloth/bodyForm';
import type { SceneGraph } from '../src/types/scene';
import type { GarmentKind } from '../src/types/cloth';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

describe('body form', () => {
  it('sizes its slices to the tape measurements', () => {
    const a = ellipseHalfWidth(1, 0.7), b = 0.7 * a;
    const h = ((a - b) / (a + b)) ** 2;
    // Ramanujan's second approximation, inverted: back to 1 m round.
    expect(Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))).toBeCloseTo(1, 3);
    const form = bodyFormNode('f', 'form', { chest: 1.1, waist: 0.9 });
    // The widest slice is at the bust and measures the chest.
    const torso = form.geoms!.filter((g) => g.name.startsWith('form_torso'));
    const widest = torso.reduce((p, q) => (q.size[0] > p.size[0] ? q : p));
    expect(widest.size[0]).toBeCloseTo(ellipseHalfWidth(1.1, 0.7), 2);
    expect(Math.abs(widest.pos![2] - bodyLandmarks(form.bodyForm!).bustZ)).toBeLessThan(0.05);
  });
});

describe.each<GarmentKind>(['tshirt', 'dress', 'skirt'])('%s', (garment) => {
  it('sews shut and hangs on the form', () => {
    const form = bodyFormNode('f', 'form');
    const g = garmentNode('g', 'garment', { garment }, form);
    const xml = compileToMJCF({ nodes: [form, g] } as SceneGraph);
    const model = mj.MjModel.from_xml_string(xml);
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    const rt = initClothRuntime(mj, model)!;
    const t0 = performance.now();
    // Long enough to see it come to rest, not just to see the seams close:
    // at a 4 ms step both passed at 3 s while the shirt never stopped moving.
    let before: Float64Array | null = null;
    while (data.time < 6) {
      if (!before && data.time >= 5.5) before = Float64Array.from(data.flexvert_xpos);
      data.xfrc_applied.fill(0);
      applyCloth(rt, model, data, [0, 0, 0], 1.225);
      mj.mj_step(model, data);
    }
    const ms = (performance.now() - t0) / (6 / model.opt.timestep);
    let moved = 0;
    for (let v = 0; v < model.nflexvert; v++) moved += Math.hypot(...[0, 1, 2].map((k) => data.flexvert_xpos[3 * v + k] - before![3 * v + k]));
    const speed = moved / model.nflexvert / 0.5;
    const mesh = meshCloth(g.cloth!);
    const bySeam: Record<string, number> = {};
    for (const s of mesh.stitches) {
      const ia = mj.mj_name2id(model, 1, `garment__${s.a[0]}_${s.a[1]}`), ib = mj.mj_name2id(model, 1, `garment__${s.b[0]}_${s.b[1]}`);
      const gap = Math.hypot(...[0, 1, 2].map((k) => data.xpos[3 * ia + k] - data.xpos[3 * ib + k]));
      const name = g.cloth!.seams![s.seam].name!;
      bySeam[name] = Math.max(bySeam[name] ?? 0, gap);
    }
    const z: number[] = [];
    for (let v = 0; v < model.nflexvert; v++) z.push(data.flexvert_xpos[3 * v + 2]);
    console.log(garment, `${model.nflexvert} verts, ${ms.toFixed(1)} ms/step, ${(speed * 1000).toFixed(1)} mm/s`, 'z', Math.min(...z).toFixed(2), Math.max(...z).toFixed(2),
      Object.fromEntries(Object.entries(bySeam).map(([k, v]) => [k, Math.round(v * 1000)])));
    expect(z.every(Number.isFinite)).toBe(true);
    // Sewn: every seam within a few mm (the eased neckline is the loosest).
    for (const [name, gap] of Object.entries(bySeam)) expect(gap, name).toBeLessThan(name === 'neckline' ? 0.008 : 0.005);
    // At rest: under 5 mm/s on average.
    expect(speed).toBeLessThan(0.005);
    // Still on the form: the top of it is up near the shoulders or waist, not on the floor.
    const L = bodyLandmarks(form.bodyForm!);
    expect(Math.max(...z)).toBeGreaterThan((garment === 'skirt' ? L.hipZ : L.bustZ));
    expect(Math.max(...z)).toBeLessThan(L.hpsZ + 0.15);
    expect(Math.min(...z)).toBeGreaterThan(0);
  });
});
