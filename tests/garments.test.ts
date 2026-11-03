// Garments drafted onto a body form, sewn and draped in real MuJoCo, held to
// what a person looks at: every seam closed to a few mm, the garment at rest
// (not just its seams closed: at a 4 ms step a shirt passed that and never
// stopped moving), and nothing sunk into the form (a fitted dress sank 13 mm
// and showed the form through it in patches). Six seconds each.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { applyCloth, initClothRuntime } from '../src/utils/cloth/clothStep';
import { meshCloth } from '../src/utils/cloth/clothMesh';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyLandmarks, ellipseHalfWidth } from '../src/utils/cloth/bodyForm';
import type { SceneGraph } from '../src/types/scene';
import type { BodyFormMeasurements, GarmentDraft, GarmentKind } from '../src/types/cloth';

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
    const torso = form.geoms!.filter((g) => g.name.startsWith('form_torso'));
    const widest = torso.reduce((p, q) => (q.size[0] > p.size[0] ? q : p));
    expect(widest.size[0]).toBeCloseTo(ellipseHalfWidth(1.1, 0.7), 2);
    expect(Math.abs(widest.pos![2] - bodyLandmarks(form.bodyForm!).bustZ)).toBeLessThan(0.05);
  });
});

const PRESET_DRESS_FORM = { chest: 0.92, waist: 0.72, hip: 0.98, shoulderWidth: 0.39, neck: 0.33, height: 1.68, upperArm: 0.27 };
const cases: [string, GarmentKind, Partial<BodyFormMeasurements>, Partial<GarmentDraft>?][] = [
  ['t-shirt', 'tshirt', {}],
  ['t-shirt on a bigger form, arms higher', 'tshirt', { armAngle: 40, chest: 1.1, waist: 0.95 }],
  ['dress', 'dress', {}],
  ['dress on the preset form', 'dress', PRESET_DRESS_FORM],
  ['skirt', 'skirt', {}],
  ['dress with sleeves', 'dress', {}, { sleeve: 0.2 }],
  ['knit dress', 'dress', {}, { material: 'jersey' }],
];

describe.each(cases)('%s', (_label, garment, measurements, options = {}) => {
  it('is sewn shut, at rest, and sits on the form', { timeout: 300_000 }, () => {
    const form = bodyFormNode('f', 'form', measurements);
    const g = garmentNode('g', 'garment', { garment, ...options }, form);
    const model = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [form, g] } as SceneGraph));
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    const rt = initClothRuntime(mj, model)!;
    let before: Float64Array | null = null;
    while (data.time < 6) {
      if (!before && data.time >= 5.5) before = Float64Array.from(data.flexvert_xpos);
      data.xfrc_applied.fill(0);
      applyCloth(rt, model, data, [0, 0, 0], 1.225);
      mj.mj_step(model, data);
    }
    let moved = 0;
    for (let v = 0; v < model.nflexvert; v++) moved += Math.hypot(...[0, 1, 2].map((k) => data.flexvert_xpos[3 * v + k] - before![3 * v + k]));
    const speed = moved / model.nflexvert / 0.5;

    const bySeam: Record<string, number> = {};
    for (const s of meshCloth(g.cloth!).stitches) {
      const ia = mj.mj_name2id(model, 1, `garment__${s.a[0]}_${s.a[1]}`), ib = mj.mj_name2id(model, 1, `garment__${s.b[0]}_${s.b[1]}`);
      const gap = Math.hypot(...[0, 1, 2].map((k) => data.xpos[3 * ia + k] - data.xpos[3 * ib + k]));
      const name = g.cloth!.seams![s.seam].name!;
      bySeam[name] = Math.max(bySeam[name] ?? 0, gap);
    }
    // How far cloth has gone into the form, past its own 4 mm skin.
    let deepest = 0;
    const vec = data.contact;
    try {
      for (let i = 0; i < vec.size(); i++) { const c = vec.get(i); if (c.geom1 < 0 || c.geom2 < 0) deepest = Math.min(deepest, c.dist); c.delete(); }
    } finally { vec.delete(); }
    const z: number[] = [];
    for (let v = 0; v < model.nflexvert; v++) z.push(data.flexvert_xpos[3 * v + 2]);
    console.log(_label, `${(speed * 1000).toFixed(1)} mm/s, deepest ${(deepest * 1000).toFixed(1)} mm`,
      Object.fromEntries(Object.entries(bySeam).map(([k, v]) => [k, +(v * 1000).toFixed(1)])));

    expect(z.every(Number.isFinite)).toBe(true);
    for (const [name, gap] of Object.entries(bySeam)) expect(gap, name).toBeLessThan(0.006);
    expect(speed).toBeLessThan(0.005);
    // Contacts are measured from the cloth's 4 mm collision skin, while the
    // fabric is drawn through its vertices: 3 mm into the skin still leaves
    // the drawn surface 1 mm clear of the form, so nothing shows through.
    expect(deepest).toBeGreaterThan(-0.003);
    const L = bodyLandmarks(form.bodyForm!);
    expect(Math.max(...z)).toBeGreaterThan(garment === 'skirt' ? L.hipZ : L.bustZ);
    expect(Math.max(...z)).toBeLessThan(L.hpsZ + 0.15);
  });
});
