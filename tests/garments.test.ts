// Garments drafted onto a body form, sewn and draped in real MuJoCo, held to
// what a person looks at: every seam closed to a few mm, the garment at rest
// (not just its seams closed: at a 4 ms step a shirt passed that and never
// stopped moving), and nothing sunk into the form (a fitted dress sank 13 mm
// and showed the form through it in patches). Six seconds each.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { applyCloth, applyClothStart, initClothRuntime } from '../src/utils/cloth/clothStep';
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

  it("measures a female form's bust round the bust, as a tape would", () => {
    const form = bodyFormNode('f', 'form', { figure: 'female', chest: 0.94, underbust: 0.78 });
    const z = bodyLandmarks(form.bodyForm!).bustZ;
    // Every geom cut at the bust line, sampled, then the convex hull's perimeter.
    const pts: [number, number][] = [];
    for (const g of form.geoms!) {
      if (g.type !== 'ellipsoid' || !/torso|bust/.test(g.name)) continue;
      const [a, b, c] = g.size, p = g.pos!, t = (z - p[2]) / c;
      if (Math.abs(t) >= 1) continue;
      const k = Math.sqrt(1 - t * t);
      for (let i = 0; i < 90; i++) { const th = (2 * Math.PI * i) / 90; pts.push([p[0] + a * k * Math.cos(th), p[1] + b * k * Math.sin(th)]); }
    }
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo: number[][] = [], hi: number[][] = [];
    for (const p of pts) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.slice().reverse()) { while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = [...lo.slice(0, -1), ...hi.slice(0, -1)];
    let girth = 0;
    for (let i = 0; i < hull.length; i++) girth += Math.hypot(hull[i][0] - hull[(i + 1) % hull.length][0], hull[i][1] - hull[(i + 1) % hull.length][1]);
    expect(girth).toBeCloseTo(0.94, 2);
    expect(bodyLandmarks(form.bodyForm!).bustProminence).toBeGreaterThan(0.02);
  });
});

const FEMALE = { figure: 'female' as const };
const cases: [string, GarmentKind, Partial<BodyFormMeasurements>, Partial<GarmentDraft>?][] = [
  ['t-shirt on a male form', 'tshirt', {}],
  ['t-shirt on a bigger male form, arms higher', 'tshirt', { armAngle: 40, chest: 1.1, waist: 0.95 }],
  ['t-shirt on a female form', 'tshirt', FEMALE],
  ['dress on a female form', 'dress', FEMALE],
  ['dress on a fuller female form', 'dress', { ...FEMALE, chest: 1.02, underbust: 0.84, waist: 0.82, hip: 1.08 }],
  ['dress with sleeves', 'dress', FEMALE, { sleeve: 0.2 }],
  ['knit dress', 'dress', FEMALE, { material: 'jersey' }],
  ['skirt', 'skirt', FEMALE],
];

describe.each(cases)('%s', (_label, garment, measurements, options = {}) => {
  it('is sewn shut, at rest, and sits on the form', { timeout: 300_000 }, () => {
    const form = bodyFormNode('f', 'form', measurements);
    const g = garmentNode('g', 'garment', { garment, ...options }, form);
    const model = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [form, g] } as SceneGraph));
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    const rt = initClothRuntime(mj, model)!;
    applyClothStart(rt, mj, model, data);
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
