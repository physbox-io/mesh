// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyFormGeoms, bodyFormSection, bodyLandmarks, clampBodyForm } from '../src/utils/cloth/bodyForm';
import { boundaryLoops, garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import { GARMENT_DEFAULTS, garmentSettings } from '../src/utils/cloth/garments';
import { fullSides, panelEdgeEase } from '../src/utils/cloth/garmentFullness';
import { ballgownPreset, bonedGownPreset, dartedSheathPreset, gathersAndPleatsPreset, menswearPreset, shirtAndJacketPreset, tailoredOutfitPreset } from '../src/presets/clothPresets';
import { colliderContact, type Collider } from '../src/utils/cloth/clothColliders';
import type { BodyFormMeasurements, GarmentDraft, GarmentKind, GarmentTrim } from '../src/types/cloth';
import type { SceneNode } from '../src/types/scene';
import { clothRun, percentile } from './clothSimHarness';
import { clothModel } from '../src/utils/cloth/clothModel';
import { patternSvg } from '../src/utils/cloth/patternSvg';
import * as THREE from 'three';

/** Perimeter of a section given as radii at even angles round a centre. */
const girth = (sec: { radii: number[] }) => {
  const n = sec.radii.length;
  let L = 0;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n, ra = sec.radii[i], rb = sec.radii[(i + 1) % n];
    L += Math.hypot(rb * Math.cos(b) - ra * Math.cos(a), rb * Math.sin(b) - ra * Math.sin(a));
  }
  return L;
};

describe('body form', () => {
  it.each(['male', 'female'] as const)('a %s form is drawn as closed, outward surfaces', (figure) => {
    // Every limb and the torso: a mesh whose triangles all face out encloses a positive volume.
    for (const g of bodyFormNode('form', 'form', { figure }).geoms.filter((q) => q.type === 'mesh')) {
      const v = g.vertices!, f = g.faces!;
      let vol = 0;
      for (let t = 0; t < f.length; t += 3) {
        const [a, b, c] = [f[t], f[t + 1], f[t + 2]].map((i) => [v[3 * i], v[3 * i + 1], v[3 * i + 2]]);
        vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
      }
      expect(vol, g.name).toBeGreaterThan(0);
    }
  });
  it.each(['male', 'female'] as const)('a %s form tapes at its chest, waist and hip measurements', (figure) => {
    const m = clampBodyForm({ figure });
    const L = bodyLandmarks(m);
    // The skin is smoothed up the body, so within a few percent.
    expect(girth(bodyFormSection(m, L.bustZ)) / m.chest).toBeCloseTo(1, 1);
    expect(girth(bodyFormSection(m, L.waistZ)) / m.waist).toBeCloseTo(1, 1);
    expect(girth(bodyFormSection(m, L.hipZ)) / m.hip).toBeCloseTo(1, 1);
    if (figure === 'female') expect(L.bustProminence).toBeGreaterThan(0.02);
    else expect(L.bustProminence).toBe(0);
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
  ['woven shirt on a female form, darted', 'tshirt', FEMALE, { material: 'woven' }],
  ['skirt', 'skirt', FEMALE],
  // The same machinery for everything else: trousers, a jacket, a gown with
  // a train and batwing sleeves, and tubes round any span of a limb.
  ['jeans on a male form', 'trousers', {}],
  ['leather jacket on a male form', 'jacket', {}],
  ['ballgown with a train and batwing sleeves', 'gown', FEMALE],
  ['sock', 'sock', {}],
  ['knit hat', 'hat', FEMALE],
  ['leg warmer, open at both ends', 'tube', {}, { over: 'legR', from: 0.55, to: 0.8, cap: false }],
];

/**
 * The panels each is cut in: bodices front and back, with their set-in
 * sleeves (a batwing's are cut in one with the body; a sleeve past the
 * elbow is cut round there, upper and lower); the rest as named.
 */
const expectedPanels = (garment: GarmentKind, options: Partial<GarmentDraft>): string[] | null => {
  const d = { ...GARMENT_DEFAULTS[garment], ...options };
  if (d.legs) return ['backL', 'backR', 'frontL', 'frontR'];
  if (garment === 'hat') return ['gore1', 'gore2', 'gore3', 'gore4', 'gore5', 'gore6'];
  if (garment === 'sock') return ['gore1', 'gore2', 'gore3', 'gore4'];
  if (d.over) return null;
  const fronts = d.opening ? ['frontL', 'frontR'] : ['front'];
  if (d.top === 'waist' || d.sleeve <= 0.03 || d.armhole > 0.05) return ['back', ...fronts];
  return d.sleeve > 0.35 ? ['back', ...fronts, 'sleeveLLower', 'sleeveLUpper', 'sleeveRLower', 'sleeveRUpper'] : ['back', ...fronts, 'sleeveL', 'sleeveR'];
};

describe.each(cases)('%s', (_label, garment, measurements, options = {}) => {
  const form = bodyFormNode('form', 'form', measurements);
  const g = garmentNode('g', 'garment', { garment, ...options }, form);

  it('is modelled clear of the body and splits into panels that lie flat', () => {
    const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
    const L = bodyLandmarks(form.bodyForm!);
    for (const p of shell.points) {
      if (p[2] > L.hpsZ || p[2] < L.hipZ) continue;
      const sec = bodyFormSection(form.bodyForm!, p[2]);
      const th = Math.atan2(p[1] - sec.centreY, p[0]), n = sec.radii.length;
      const f = (((th / (2 * Math.PI)) % 1) + 1) % 1 * n, i = Math.floor(f), t = f - i;
      const r = sec.radii[i % n] * (1 - t) + sec.radii[(i + 1) % n] * t;
      expect(Math.hypot(p[0], p[1] - sec.centreY) - r).toBeGreaterThan(0.002);
    }
    const names = shell.panels.map((p) => p.name).sort();
    const expected = expectedPanels(garment, options);
    if (expected) expect(names).toEqual(expected);
    else { expect(names.length).toBeGreaterThanOrEqual(2); expect(new Set(names).size).toBe(names.length); }
    // Flattened as it is cut: a sleeve cap with its ease (garmentFullness).
    const settings = garmentSettings(g.cloth!.garment!);
    const sides = fullSides(shell, settings.fullness, settings.material);
    for (const [k, p] of shell.panels.entries()) {
      const piece = flattenPanel(p.name, shell.cut ?? shell.points, shell.tris, p.tris, shell.seams.map((s) => s.path), 15, undefined, panelEdgeEase(shell, sides, k));
      // As flat as the fabric needs: a knit goes over a bust by stretching.
      const give = CLOTH_MATERIALS[options.material ?? GARMENT_DEFAULTS[garment].material].give;
      expect(piece.strain95, p.name).toBeLessThan(Math.max(0.05, Math.min(give, 0.08)));
      expect(Math.abs(piece.areaChange), p.name).toBeLessThan(0.01);
    }
  });

  it('drapes, comes to rest on the form, and holds its cut', async () => {
    const r = await clothRun([form, g]);
    r.run(2.5);
    const speed = r.speedOver(0.5);
    const clear = r.clearance();
    const s = r.strains();
    console.log(_label, `${(speed * 1000).toFixed(1)} mm/s, nearest ${(clear * 1000).toFixed(1)} mm, strain p95 ${(percentile(s, 0.95) * 100).toFixed(1)}% p99 ${(percentile(s, 0.99) * 100).toFixed(1)}% max ${(percentile(s, 1) * 100).toFixed(0)}%`);
    expect(speed).toBeLessThan(0.005);
    // Nothing inside the form: the cloth's middle stays at its thickness off it.
    expect(clear).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    // Holds its cut; a close-fitting knit (a sock, a hat) within what the
    // fabric gives, as it is worn stretched over the body.
    const d = { ...GARMENT_DEFAULTS[garment], ...options };
    const give = (d.ease ?? 0) <= 0.02 ? CLOTH_MATERIALS[d.material].give : 0;
    expect(percentile(s, 0.95)).toBeLessThan(Math.max(0.03, give));
    expect(percentile(s, 0.99)).toBeLessThan(Math.max(0.08, 1.5 * give));
  }, 120_000);
});

// Hung, not dropped: a garment starts where it rests. The shell once stood its
// ease over the shoulders as everywhere, and released, a jacket fell 40 mm and
// a t-shirt 15 before its shoulders took it (garmentShell: the ease hangs below).
describe('starts where it hangs', () => {
  it.each([['jacket', 'jacket', 0.015], ['t-shirt', 'tshirt', 0.006]] as const)('a %s barely moves when released', async (_l, garment, most) => {
    const form = bodyFormNode('form', 'form', {});
    const g = garmentNode('g', 'g', { garment }, form);
    const r = await clothRun([form, g]);
    const z0 = Array.from({ length: r.sim.n }, (_, i) => r.sim.x[3 * i + 2]);
    const top = Math.max(...z0);
    const upper = z0.flatMap((z, i) => (z > top - 0.08 ? [i] : []));
    r.run(2.5);
    const drop = upper.reduce((acc, i) => acc + z0[i] - r.sim.x[3 * i + 2], 0) / upper.length;
    console.log(`${garment}: its top 8 cm dropped ${(drop * 1000).toFixed(1)} mm`);
    expect(drop).toBeLessThan(most);
  }, 120_000);

  // In the app the store decomposes the form (a torso slice is concave enough),
  // and a decomposed body's dynamic drawn meshes were dropped from the model:
  // the cloth, which reads its mesh colliders from the model by name, kept only
  // the capsules, and a dress fell to the floor. A form stands anywhere; its
  // meshes are drawn at its transform, so they are dynamic.
  it('a form collides as everything drawn even once it is decomposed', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' }, [0.45, 0, 0]);
    const g = garmentNode('g', 'g', { garment: 'dress' }, form);
    const mesh = (n: SceneNode) => (n.geoms ?? []).filter((q) => q.type === 'mesh' && q.role === 'visual').length;
    const decomposed: SceneNode = {
      ...form,
      collisionDecomposed: true,
      geoms: [...form.geoms!, { name: 'form_torso13_c0', type: 'box', size: [0.1, 0.1, 0.02], pos: [0, 0, 1.27], role: 'collision', csgDerived: 'collider', colliderOf: 'form_torso13' } as SceneNode['geoms'][number]],
    } as SceneNode;
    const r = await clothRun([decomposed, g]);
    const sdfs = r.colliders.filter((c) => c.shape.kind === 'sdf').length;
    expect(sdfs).toBe(mesh(form));
    const z0 = Array.from({ length: r.sim.n }, (_, i) => r.sim.x[3 * i + 2]);
    const top = Math.max(...z0);
    r.run(1);
    expect(top - Math.max(...Array.from({ length: r.sim.n }, (_, i) => r.sim.x[3 * i + 2]))).toBeLessThan(0.01);
  }, 120_000);
});

// Trims: a jacket's open edges are named for the cuts that made them, its
// zipper runs the opening and its studs the neckline and cuffs, and every
// one is marked on the piece it sits on.
describe('trims', () => {
  it('a jacket carries its zipper and studs on named edges, and on the pattern', () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const g = garmentNode('g', 'garment', { garment: 'jacket' }, form);
    const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
    const names = new Set([...shell.edges.map((e) => e.name), ...shell.seams.filter((sm) => sm.open).map((sm) => sm.name)]);
    for (const n of ['opening', 'neckline', 'hem', 'cuffL', 'cuffR']) expect([...names], n).toContain(n);
    const m = clothModel(g, new THREE.Matrix4(), [form, g]);
    const by = (kind: string) => m.groups.flatMap((gr) => (gr.trims ?? []).filter((t) => t.kind === kind).map((t) => gr.name.split('__')[1]));
    const zipper = by('zipper'), studs = by('stud');
    expect(zipper.length).toBeGreaterThan(20);
    expect(new Set(zipper)).toEqual(new Set(['frontL', 'frontR']));
    expect(studs.length).toBeGreaterThan(12);
    expect(new Set(studs)).toEqual(new Set(['frontL', 'frontR', 'back', 'sleeveLLower', 'sleeveRLower']));
    const svg = patternSvg(m.groups.map((gr) => ({ name: gr.name, ...gr.flat! })));
    expect((svg.match(/<circle/g) ?? []).length).toBe(zipper.length + studs.length);
  });

  it('buttons an opening: holes on the front that laps over, on a stand run on over the other', () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const model = (trim: Partial<GarmentTrim>) => {
      const node = garmentNode('g', 'cardigan', { garment: 'tshirt', opening: true, trims: [{ kind: 'button', along: 'opening', spacing: 0.08, ...trim }] }, form);
      return clothModel(node, new THREE.Matrix4(), [form, node]);
    };
    const on = (m: ReturnType<typeof clothModel>, panel: string, kind: string) => (m.groups.find((gr) => gr.name.endsWith(`__${panel}`))?.trims ?? []).filter((t) => t.kind === kind).length;
    // Edge to edge: buttons on one front, holes on the other (the right laps over unless asked), fastened by stitches.
    const flat = model({ stand: 0 });
    expect(on(flat, 'frontL', 'button')).toBeGreaterThanOrEqual(4);
    expect(on(flat, 'frontR', 'buttonhole')).toBe(on(flat, 'frontL', 'button'));
    expect(flat.stitches.length / 2).toBe(on(flat, 'frontL', 'button'));
    const left = model({ stand: 0, lap: 'left' });
    expect(on(left, 'frontL', 'buttonhole')).toBe(on(left, 'frontR', 'button'));
    // With a stand: the lapping front's strip, its holes and buttons down its middle, tacked over the other front.
    const stood = model({});
    const stand = stood.groups.find((gr) => gr.name.endsWith('__stand_frontR'))!;
    expect(stand).toBeDefined();
    expect(on(stood, 'stand_frontR', 'buttonhole')).toBeGreaterThanOrEqual(4);
    expect(on(stood, 'stand_frontR', 'button')).toBe(on(stood, 'stand_frontR', 'buttonhole'));
    expect(on(stood, 'frontL', 'button') + on(stood, 'frontR', 'buttonhole')).toBe(0);
    const standTacks = (stood.tacks ?? []).filter((t) => stand.particles.includes(t.particle));
    expect(standTacks.length).toBeGreaterThan(0);
    // Its strip lies over the left front: out past the opening, to the wearer's left.
    expect(Math.max(...stand.particles.map((p) => stood.x0[3 * p]))).toBeGreaterThan(0.02);
    // Unbuttoned, nothing holds the fronts together.
    const open = model({ fastened: false });
    expect((open.tacks ?? []).length).toBe(0);
    expect(open.stitches.length / 2).toBe(open.groups.find((gr) => gr.name.endsWith('__stand_frontR'))!.particles.length / 3);
  });
});

describe('elastics, negative ease, pockets, and belts on garments', () => {
  it('gathers a waistband with embedded elastic and drapes a negative-ease spandex top', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const regularNode = garmentNode('reg', 'reg', { garment: 'tshirt', ease: 0.04, material: 'spandex' }, form);
    const negEaseNode = garmentNode('neg', 'neg', {
      garment: 'tshirt', ease: -0.12, material: 'spandex',
      elastics: [{ along: 'hem', ratio: 0.75, stiffness: 90 }],
    }, form);
    const mReg = clothModel(regularNode, new THREE.Matrix4(), [form, regularNode]);
    const mNeg = clothModel(negEaseNode, new THREE.Matrix4(), [form, negEaseNode]);
    const widthOf = (m: ReturnType<typeof clothModel>) => {
      const f = m.groups.find((gr) => gr.name.endsWith('__front'))!.flat!.uv;
      return Math.max(...f.map((q) => q[0])) - Math.min(...f.map((q) => q[0]));
    };
    expect(widthOf(mNeg)).toBeLessThan(widthOf(mReg) * 0.9);
    expect(mNeg.elastics?.length).toBeGreaterThan(10);

    const r = await clothRun([form, negEaseNode]);
    r.run(1.5);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(percentile(r.strains(), 0.95)).toBeLessThan(CLOTH_MATERIALS.spandex.give);
  }, 120_000);

  it('puts pockets where the pattern marks them, on any panel, mirrored on a pair', () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const jeans = garmentNode('jeans', 'jeans', { garment: 'trousers', pockets: [{ panel: 'front', at: [0.62, 0.86] }, { panel: 'back', at: [0.5, 0.8] }] }, form);
    const m = clothModel(jeans, new THREE.Matrix4(), [form, jeans]);
    const centre = (suffix: string) => {
      const g = m.groups.find((gr) => gr.name.endsWith(`__${suffix}`));
      expect(g, suffix).toBeDefined();
      return [0, 1, 2].map((k) => g!.particles.reduce((acc, p) => acc + m.x0[3 * p + k], 0) / g!.particles.length);
    };
    const fl = centre('pocket_frontL'), fr = centre('pocket_frontR'), bl = centre('pocket_backL'), br = centre('pocket_backR');
    // A pair, mirrored across the body; on the front and on the back; on the hips, below the waistband.
    expect(Math.abs(fl[0] + fr[0])).toBeLessThan(0.01);
    expect(Math.abs(fl[2] - fr[2])).toBeLessThan(0.01);
    expect(fl[0]).toBeGreaterThan(0.03);
    expect(fl[1]).toBeLessThan(bl[1]);
    expect(Math.abs(bl[0] + br[0])).toBeLessThan(0.01);
    for (const c of [fl, bl]) expect(c[2]).toBeGreaterThan(0.75);
    // Sewn round three sides, the mouth free.
    const tacked = (m.tacks ?? []).filter((t) => m.groups.find((gr) => gr.name.endsWith('__pocket_frontL'))!.particles.includes(t.particle));
    expect(tacked.some((t) => t.lift)).toBe(true);
    expect(tacked.some((t) => !t.lift)).toBe(true);
    // And on a sleeve.
    const jacket = garmentNode('jacket', 'jacket', { garment: 'jacket', pockets: [{ panel: 'sleeveLUpper', at: [0.5, 0.5], width: 0.06, height: 0.08 }] }, form);
    const mj = clothModel(jacket, new THREE.Matrix4(), [form, jacket]);
    const sp = mj.groups.find((gr) => gr.name.endsWith('__pocket_sleeveLUpper'))!;
    expect(sp).toBeDefined();
    expect(sp.particles.reduce((acc, p) => acc + mj.x0[3 * p], 0) / sp.particles.length).toBeGreaterThan(0.2);
    // Cut as pieces too: in the pattern.
    expect(sp.flat!.outline.length).toBeGreaterThan(4);
  });

  it('a belt is cloth drawn in round the garment, through its loops, and holds it in', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const jeans = garmentNode('jeans', 'jeans', { garment: 'trousers', belt: { width: 0.035, ratio: 0.95 } }, form);
    const m = clothModel(jeans, new THREE.Matrix4(), [form, jeans]);
    const names = m.groups.map((gr) => gr.name.split('__')[1]);
    expect(names).toContain('belt');
    for (let k = 1; k <= 5; k++) expect(names).toContain(`beltLoop_${k}`);
    const belt = m.groups.find((gr) => gr.name.endsWith('__belt'))!;
    expect(belt.trims?.some((t) => t.kind === 'buckle')).toBe(true);
    // Cut 5% short of the way round.
    const cutLen = Math.max(...belt.flat!.uv.map((q) => q[0])) - Math.min(...belt.flat!.uv.map((q) => q[0]));
    const bottom = (x: Float64Array) => {
      const rows = belt.particles.map((p, i) => ({ p, v: belt.flat!.uv[i][1] }));
      const vMid = 0;
      const row = rows.filter((r) => Math.abs(r.v - vMid) < 0.006).map((r) => [x[3 * r.p], x[3 * r.p + 1], x[3 * r.p + 2]]);
      const cy = row.reduce((a, q) => a + q[1], 0) / row.length;
      row.sort((a, b) => Math.atan2(a[1] - cy, a[0]) - Math.atan2(b[1] - cy, b[0]));
      let L = 0;
      for (let i = 0; i < row.length; i++) { const a = row[i], b = row[(i + 1) % row.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
      return L;
    };
    const startLen = bottom(m.x0);
    expect(cutLen / startLen).toBeLessThan(0.97);
    const r = await clothRun([form, jeans]);
    r.run(1.5);
    // It takes the jeans in (tacks pull both ways; measured 0.45%: the cloth round it holds it out) and stays up.
    expect(bottom(r.sim.x)).toBeLessThan(startLen * 0.997);
    expect(Math.min(...belt.particles.map((p) => r.sim.x[3 * p + 2]))).toBeGreaterThan(0.9);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.0015);

    // Along any edge, into the garment from it: a hatband above the brim; round each ankle at a height.
    const hat = garmentNode('hat', 'hat', { garment: 'hat', belt: true, beltLoops: 0 }, form);
    const mh = clothModel(hat, new THREE.Matrix4(), [form, hat]);
    const hb = mh.groups.find((gr) => gr.name.endsWith('__belt'))!;
    const brim = Math.min(...Array.from({ length: mh.x0.length / 3 }, (_, i) => mh.x0[3 * i + 2]).slice(0, hb.particles[0]));
    expect(Math.min(...hb.particles.map((p) => mh.x0[3 * p + 2]))).toBeGreaterThan(brim);
    const ankles = garmentNode('ank', 'ank', { garment: 'trousers', belt: { at: 0.12 }, beltLoops: 0 }, form);
    const ma = clothModel(ankles, new THREE.Matrix4(), [form, ankles]);
    const xs = ['belt1', 'belt2'].map((n) => { const g = ma.groups.find((gr) => gr.name.endsWith(`__${n}`))!; expect(g, n).toBeDefined(); return g.particles.reduce((a, p) => a + ma.x0[3 * p], 0) / g.particles.length; });
    expect(xs[0] * xs[1]).toBeLessThan(0);

    // The tailored outfit: what is sewn on is in the jeans' triangles an outer layer is kept off.
    const models = tailoredOutfitPreset.nodes.filter((n) => n.cloth).map((n) => clothModel(n, new THREE.Matrix4(), tailoredOutfitPreset.nodes));
    expect(models.map((qm) => qm.name)).toEqual(['jeans', 'stretchTop', 'cardigan']);
    expect(models[0].tris.length).toBeGreaterThan(models[0].overlayTrisStart!);
  }, 180_000);
  it('keeps the buttoned cardigan outside the belted jeans and their back pockets on the tailored outfit preset', async () => {
    const r = await clothRun(tailoredOutfitPreset.nodes);
    r.run(2);
    const x = r.sim.x;
    let base = 0;
    const bases = r.models.map((m) => { const b = base; base += m.invMass.length; return b; });
    const jeans = r.models[0], top = r.models[1], card = r.models[2];
    const jb = bases[0], tb = bases[1], cb = bases[2];
    const beltGrp = jeans.groups.find((g) => g.name.endsWith('__belt'))!;
    const maxBeltZ = Math.max(...beltGrp.particles.map((p) => x[3 * (jb + p) + 2]));
    const minTopZ = Math.min(...Array.from({ length: top.invMass.length }, (_, i) => x[3 * (tb + i) + 2]));
    console.log(`tailoredOutfit z: belt max=${maxBeltZ.toFixed(3)}m, stretchTop min=${minTopZ.toFixed(3)}m`);
    // The waist-length stretch top sits at the natural waist, clear above the belt and pockets of the jeans.
    expect(minTopZ).toBeGreaterThan(maxBeltZ - 0.015);
    for (const grp of jeans.groups) {
      for (const p of grp.particles) {
        const px = x[3 * (jb + p)], py = x[3 * (jb + p) + 1], pz = x[3 * (jb + p) + 2];
        if (pz < 0.76) continue; // below the cardigan hem
        let bestD = Infinity, bestSd = Infinity;
        for (let t = 0; t < card.tris.length; t += 3) {
          const [a, b, c] = [0, 1, 2].map((q) => 3 * (cb + card.tris[t + q]));
          const cx = (x[a] + x[b] + x[c]) / 3, cy = (x[a + 1] + x[b + 1] + x[c + 1]) / 3, cz = (x[a + 2] + x[b + 2] + x[c + 2]) / 3;
          const d = Math.hypot(px - cx, py - cy, pz - cz);
          if (d >= bestD) continue;
          bestD = d;
          const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
          const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const nl = Math.hypot(nx, ny, nz) || 1;
          bestSd = ((cx - px) * nx + (cy - py) * ny + (cz - pz) * nz) / nl;
        }
        expect(bestSd, grp.name).toBeGreaterThan(CLOTH_THICKNESS);
      }
    }
  }, 300_000);

  it('holds a bow sewn onto the back of a gown, and the gown on the form', async () => {
    const r = await clothRun(ballgownPreset.nodes);
    r.run(3);
    const gown = r.models.find((m) => m.name === 'gown')!, bow = r.models.find((m) => m.name === 'bow')!;
    const x = r.sim.x, gb = 0, bb = gown.invMass.length;
    let gownTop = -Infinity, bowLow = Infinity;
    for (let i = 0; i < gown.invMass.length; i++) gownTop = Math.max(gownTop, x[3 * (gb + i) + 2]);
    for (let i = 0; i < bow.invMass.length; i++) bowLow = Math.min(bowLow, x[3 * (bb + i) + 2]);
    // Still up on the shoulders, and the bow still on its back (not fallen to the train).
    expect(gownTop).toBeGreaterThan(1.35);
    expect(bowLow).toBeGreaterThan(0.45);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    const sim = r.sim as unknown as { stitches: Int32Array };
    let gap = 0;
    for (let k = 0; k < sim.stitches.length; k += 2) {
      const a = 3 * sim.stitches[k], b = 3 * sim.stitches[k + 1];
      if ((sim.stitches[k] < bb) === (sim.stitches[k + 1] < bb)) continue; // the bow's own seams
      gap = Math.max(gap, Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2]));
    }
    console.log('bow to gown, widest stitch', (gap * 1000).toFixed(1), 'mm');
    expect(gap).toBeLessThan(0.025);
    expect(bow.groups.length).toBe(1);
    const ribbon = bow.groups[0];
    const tailLPts = ribbon.particles.filter((p) => bow.x0[3 * p] > 0.04 && bow.x0[3 * p + 2] < 0.85);
    const tailRPts = ribbon.particles.filter((p) => bow.x0[3 * p] < -0.04 && bow.x0[3 * p + 2] < 0.85);
    const minXL = Math.min(...tailLPts.map((p) => x[3 * (bb + p)]));
    const maxXR = Math.max(...tailRPts.map((p) => x[3 * (bb + p)]));
    expect(minXL).toBeGreaterThan(maxXR);
  }, 300_000);
});

// A draft's own cuts and seams: generic planes, so any style is the same
// machinery. Princess lines split a bodice in five; an open centre-back seam
// is a zip; a slanted cut takes one shoulder off; gores cut a skirt round.
describe('cuts and seams a draft asks for', () => {
  const form = bodyFormNode('form', 'form', FEMALE);
  const L = bodyLandmarks(form.bodyForm!);
  const princess = { name: 'princess', point: [L.bustPoint[0], 0, 0], normal: [1, 0, 0], mirror: true, on: ['skin' as const] };

  it('princess seams, a centre-back zip, and a strapless top from a height', () => {
    const g = garmentNode('g', 'bodice', {
      garment: 'dress', top: L.bustZ + 0.05, length: 0.3, sleeve: 0,
      seams: [princess, { name: 'zip', point: [0, 0, 0], normal: [1, 0, 0], front: false, open: true }],
      trims: [{ kind: 'zipper', along: 'zip' }],
    }, form);
    const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
    const names = shell.panels.map((p) => p.name).sort();
    // A centre front, side fronts; centre backs either side of the zip, side backs.
    expect(names).toEqual(['backL1', 'backL2', 'backR1', 'backR2', 'front', 'frontL', 'frontR']);
    expect(shell.seams.some((sm) => sm.name === 'zip' && sm.open)).toBe(true);
    // No higher than asked: strapless.
    expect(Math.max(...shell.points.map((p) => p[2]))).toBeLessThan(L.bustZ + 0.06);
    const m = clothModel(g, new THREE.Matrix4(), [form, g]);
    const zip = m.groups.flatMap((gr) => (gr.trims ?? []).filter((t) => t.kind === 'zipper').map(() => gr.name.split('__')[1]));
    expect(new Set(zip)).toEqual(new Set(['backL1', 'backR1']));
    for (const gr of m.groups) expect(gr.flat!.strain95, gr.name).toBeLessThan(0.05);
  });

  it('a slanted cut takes one shoulder off, its edge named', () => {
    const g = garmentNode('g', 'oneShoulder', {
      garment: 'tshirt', sleeve: 0, fitted: true,
      cuts: [{ name: 'shoulderLine', point: [0.05, 0, L.bustZ + 0.08], normal: [-0.45, 0, 1], x: [-1, 0.06] }],
    }, form);
    const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
    // Over the kept shoulder, resting on it (within a centimetre of the form's
    // top there); the other side cut away well below it.
    const top = (pts: number[][], side: number) => pts.reduce((z, p) => (side * p[0] > 0.1 ? Math.max(z, p[2]) : z), -Infinity);
    const skin = bodyFormGeoms(form.bodyForm!, 'form').find((q) => q.name === 'form_skin')!;
    const formPts: number[][] = [];
    for (let i = 0; i < skin.vertices!.length; i += 3) formPts.push([skin.vertices![i], -skin.vertices![i + 2], skin.vertices![i + 1]]);
    const shoulder = top(formPts, 1);
    expect(top(shell.points, 1)).toBeGreaterThan(shoulder - 0.01);
    expect(top(shell.points, -1)).toBeLessThan(shoulder - 0.1);
    expect(shell.edges.some((e) => e.name === 'shoulderLine')).toBe(true);
  });

  it('gores cut a skirt round, below the waist', () => {
    const shell = garmentShell(garmentNode('g', 'gored', { garment: 'skirt', gores: 6 }, form).cloth!.garment!, form.bodyForm!);
    expect(shell.panels.length).toBe(6);
  });
});

// Boning: rods along the garment's lines, straight at rest. Bones up a
// strapless bodice's seams, stopping at the waist, marked on its pieces as
// channels; a hoop (steel closed in a ring along a seam round a skirt) holds
// a soft skirt out that falls in without it.
describe('boning', () => {
  const form = bodyFormNode('form', 'form', FEMALE);
  const L = bodyLandmarks(form.bodyForm!);

  it('bones a bodice up its seams to the waist, channels on the pattern', () => {
    const z: [number, number] = [L.waistZ - 0.06, 3];
    const g = garmentNode('b', 'boned', {
      garment: 'dress', top: L.bustZ + 0.05, length: 0.3, sleeve: 0, material: 'woven',
      seams: [{ name: 'princess', point: [L.bustPoint[0], 0, 0], normal: [1, 0, 0], mirror: true, on: ['skin'] }],
      rods: [{ along: 'princessL', z }, { along: 'princessR', z }, { along: 'side', z }],
    }, form);
    const m = clothModel(g, new THREE.Matrix4(), [form, g]);
    expect(m.rods?.links.length).toBeGreaterThan(20);
    for (let k = 0; k < m.rods!.links.length; k++) expect(m.x0[3 * m.rods!.links[k] + 2]).toBeGreaterThan(z[0] - 0.01);
    expect(m.groups.some((gr) => (gr.flat?.lines?.length ?? 0) > 0)).toBe(true);
    const svg = patternSvg(m.groups.map((gr) => ({ name: gr.name, ...gr.flat! })));
    expect(svg).toContain('boning channel');
  });

  it('a hoop holds a soft skirt out', async () => {
    const zHoop = L.waistZ - 0.55;
    const radius = async (rods: boolean) => {
      const node = garmentNode('g', 'g', {
        garment: 'skirt', length: 0.65, flare: 2.2, material: 'jersey',
        seams: [{ name: 'hoop', point: [0, 0, zHoop], normal: [0, 0, 1] }],
        ...(rods ? { rods: [{ along: 'hoop', kind: 'hoopSteel' as const }] } : {}),
      }, form);
      const hoop = new Set(garmentShell(node.cloth!.garment!, form.bodyForm!).seams.filter((sm) => sm.name === 'hoop').flatMap((sm) => sm.path));
      const r = await clothRun([form, node]);
      const at = () => [...hoop].reduce((acc, i) => acc + Math.hypot(r.sim.x[3 * i], r.sim.x[3 * i + 1]), 0) / hoop.size;
      const r0 = at();
      r.run(2);
      return at() / r0;
    };
    const hooped = await radius(true), bare = await radius(false);
    console.log(`hoop radius kept: hooped ${(hooped * 100).toFixed(0)}%, bare ${(bare * 100).toFixed(0)}%`);
    expect(hooped).toBeGreaterThan(0.93);
    expect(bare).toBeLessThan(hooped - 0.06);
  }, 240_000);

  // The preset: a strapless gown boned up its seams, zipped up the back, a
  // hoop round its skirt, a spencer over it. Its zip once drew teeth and
  // left the back open (the gown slid to the floor); its bones and hoop, at
  // rest straight, tore the cloth round them (edges four times their length).
  it('holds the boned gown preset up, zipped, its hoop round and its cut kept', async () => {
    const r = await clothRun(bonedGownPreset.nodes);
    const gown = r.models.find((m) => m.name === 'gown')!;
    const top = () => { let z = -Infinity; for (let i = 0; i < gown.invMass.length; i++) z = Math.max(z, r.sim.x[3 * i + 2]); return z; };
    // The hoop's own points: those its links join below the bodice.
    const hoop = [...new Set(gown.rods!.links.filter((i) => gown.x0[3 * i + 2] < 0.6))];
    const hoopAt = () => hoop.reduce((acc, i) => acc + Math.hypot(r.sim.x[3 * i], r.sim.x[3 * i + 1]), 0) / hoop.length;
    const top0 = top(), hoop0 = hoopAt();
    expect(gown.rods!.links.length).toBeGreaterThan(100);
    r.run(2.5);
    const s = r.strains();
    console.log(`boned gown: top ${top0.toFixed(3)} -> ${top().toFixed(3)}, hoop r ${hoop0.toFixed(3)} -> ${hoopAt().toFixed(3)}, strain p95 ${(percentile(s, 0.95) * 100).toFixed(1)}% p99 ${(percentile(s, 0.99) * 100).toFixed(1)}%`);
    expect(top()).toBeGreaterThan(top0 - 0.05);
    expect(hoopAt()).toBeGreaterThan(0.93 * hoop0);
    expect(percentile(s, 0.95)).toBeLessThan(0.03);
    expect(percentile(s, 0.99)).toBeLessThan(0.08);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
  }, 300_000);
});

// Stiffened pieces: a piece's stiffnessScale reaches the solver.
describe('stiffened pieces', () => {
  it('scales a piece’s stretch and bending', () => {
    const piece = (k?: number) => ({ id: 'n', name: 'n', pos: [0, 0, 1], cloth: { pieces: [{ name: 'p', ...(k ? { stiffnessScale: k } : {}), edges: [{ id: 'b', pts: [[0, 0], [0.2, 0]] }, { id: 'r', pts: [[0.2, 0], [0.2, 0.2]] }, { id: 't', pts: [[0.2, 0.2], [0, 0.2]] }, { id: 'l', pts: [[0, 0.2], [0, 0]] }], placement: { kind: 'plane' } }], spacing: 0.04 } } as unknown as SceneNode);
    const soft = clothModel(piece(), new THREE.Matrix4(), []), stiff = clothModel(piece(10), new THREE.Matrix4(), []);
    expect(stiff.edgeStiffness![0] / soft.edgeStiffness![0]).toBeCloseTo(10);
    expect(stiff.bendStiffness![0] / soft.bendStiffness![0]).toBeCloseTo(10);
  });
});

// Darts anywhere, in any direction (garmentDarts): a slit from the apex along
// a line through its panel, opened into a wedge when the piece is laid flat
// and sewn shut when it is worn. Single-ended from a seam (an elbow, a sleeve
// cap, a skirt's waist) or double-ended inside a panel (a back waist).
describe('darts', () => {
  /** A dart's legs in a flat piece (its slit's two sides, split at its points), its length on the garment, and how wide it opens. */
  const dartLegs = (shell: ReturnType<typeof garmentShell>, piece: ReturnType<typeof flattenPanel>, name: string) => {
    const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const E = new Set(shell.seams.filter((s) => s.name === name).map((s) => key(s.path[0], s.path[1])));
    const nb = new Map<number, Set<number>>(), counted = new Set<string>();
    let len3 = 0;
    for (let t = 0; t < piece.tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const i = piece.tris[t + e], j = piece.tris[t + ((e + 1) % 3)], k = key(piece.points[i], piece.points[j]);
      if (!E.has(k)) continue;
      (nb.get(i) ?? nb.set(i, new Set()).get(i)!).add(j); (nb.get(j) ?? nb.set(j, new Set()).get(j)!).add(i);
      if (!counted.has(k)) { counted.add(k); const a = shell.points[piece.points[i]], b = shell.points[piece.points[j]]; len3 += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
    }
    const copies = new Map<number, number[]>();
    for (const i of nb.keys()) (copies.get(piece.points[i]) ?? copies.set(piece.points[i], []).get(piece.points[i])!).push(i);
    const tips = [...nb.keys()].filter((i) => copies.get(piece.points[i])!.length === 1 && nb.get(i)!.size === 2);
    const ends = [...nb.keys()].filter((i) => nb.get(i)!.size === 1);
    const order = [ends[0] ?? tips[0]], seen = new Set(order);
    for (;;) { const nx = [...nb.get(order[order.length - 1])!].find((x) => !seen.has(x)); if (nx === undefined) break; seen.add(nx); order.push(nx); }
    if (!ends.length) order.push(order[0]);
    const L = (a: number, b: number) => Math.hypot(piece.uv[a][0] - piece.uv[b][0], piece.uv[a][1] - piece.uv[b][1]);
    const legs = [0];
    for (let k = 1; k < order.length; k++) { legs[legs.length - 1] += L(order[k - 1], order[k]); if (tips.includes(order[k]) && k < order.length - 1) legs.push(0); }
    let width = 0;
    for (const c of copies.values()) for (let x = 0; x < c.length; x++) for (let y = x + 1; y < c.length; y++) width = Math.max(width, L(c[x], c[y]));
    return { legs, len3, width, ends: ends.map((i) => piece.outline.includes(i)) };
  };
  const flat = (shell: ReturnType<typeof garmentShell>, name: string) => {
    const p = shell.panels.find((q) => q.name === name)!;
    return flattenPanel(name, shell.cut ?? shell.points, shell.tris, p.tris, shell.seams.map((s) => s.path));
  };

  // A one-piece fitted sleeve past an elbow bent 25 degrees (under the 30 at
  // which a sleeve is cut round there): measured, its piece flattened at 7.2%
  // plain and 4.2% with the two darts; draped, p95 1.9% -> 1.5%.
  it('an elbow dart and a sleeve-cap dart let a fitted sleeve lie flat and drape truer', async () => {
    const form = bodyFormNode('form', 'form', { ...FEMALE, elbowBend: 25 });
    const elbow = { name: 'elbow', apex: { limb: 'armL' as const, along: 'joint' as const, face: [1, 0, 1] }, to: { limb: 'armL' as const, along: 'joint' as const, face: [0, -1, -1] }, mirror: true };
    const cap = { name: 'cap', apex: { limb: 'armL' as const, along: 0.12, face: [0, 0, 1] }, direction: [-1, 0, 1], mirror: true };
    const draft = { garment: 'dress' as const, sleeve: 0.45, cuff: 0.2 };
    const plain = garmentNode('g', 'plain', draft, form), darted = garmentNode('g', 'darted', { ...draft, darts: [elbow, cap] }, form);
    const sp = garmentShell(plain.cloth!.garment!, form.bodyForm!), sd = garmentShell(darted.cloth!.garment!, form.bodyForm!);
    for (const n of ['elbowL', 'elbowR', 'capL', 'capR']) expect(sd.seams.some((s) => s.name === n), n).toBe(true);
    // The bust darts are still the plan's own: these shape elsewhere.
    expect(sd.seams.some((s) => s.name === 'dartL')).toBe(true);
    for (const side of ['L', 'R']) {
      const p0 = flat(sp, `sleeve${side}`), p1 = flat(sd, `sleeve${side}`);
      console.log(`sleeve${side} strain95 plain ${(p0.strain95 * 100).toFixed(2)}% darted ${(p1.strain95 * 100).toFixed(2)}%`);
      expect(p1.strain95).toBeLessThan(0.05);
      expect(p1.strain95).toBeLessThan(p0.strain95 - 0.02);
      for (const n of [`elbow${side}`, `cap${side}`]) {
        const d = dartLegs(sd, p1, n);
        // Single-ended: two legs, open at a seam (both ends on the outline: a notch in the pattern), alike so they sew.
        expect(d.legs.length, n).toBe(2);
        expect(d.ends.every(Boolean), n).toBe(true);
        expect(d.width, n).toBeGreaterThan(0.01);
        expect(Math.abs(d.legs[0] - d.legs[1]) / d.len3, n).toBeLessThan(0.04);
      }
    }
    const drape = async (g: SceneNode) => {
      const r = await clothRun([form, g]);
      r.run(2.5);
      const s = r.strains();
      return { speed: r.speedOver(0.5), clear: r.clearance(), p95: percentile(s, 0.95), p99: percentile(s, 0.99) };
    };
    const a = await drape(plain), b = await drape(darted);
    console.log(`fitted sleeve drape: plain p95 ${(a.p95 * 100).toFixed(2)}% p99 ${(a.p99 * 100).toFixed(2)}%, darted p95 ${(b.p95 * 100).toFixed(2)}% p99 ${(b.p99 * 100).toFixed(2)}%`);
    expect(b.speed).toBeLessThan(0.005);
    expect(b.clear).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(b.p95).toBeLessThan(a.p95);
    expect(b.p99).toBeLessThan(0.08);
  }, 300_000);

  // Double-ended back waist darts on a fitted dress, in place of the plan's
  // own (their apexes near): drawn in the pattern as fish-eyes, sewn shut when
  // cut as pieces. Skirt waist darts from the waistband: measured, the back
  // flattened at 1.74% plain, 1.31% darted.
  it('back waist darts and skirt waist darts: in the pattern as darts, legs alike, sewn shut', async () => {
    const form = bodyFormNode('form', 'form', FEMALE);
    const back = { name: 'backWaist', apex: { z: 'waist' as const, x: 0.075, back: true }, direction: [0, 0, 1], length: 0.15, back: 0.12, mirror: true };
    const g = garmentNode('g', 'dress', { garment: 'dress', darts: [back] }, form);
    const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
    const names = new Set(shell.seams.map((s) => s.name));
    expect(names.has('backWaistL') && names.has('backWaistR')).toBe(true);
    expect(names.has('waistDartBackL')).toBe(false);
    expect(names.has('waistDartFrontL') && names.has('dartL')).toBe(true);
    const piece = flat(shell, 'back');
    expect(piece.strain95).toBeLessThan(0.025);
    expect(piece.darts?.length).toBe(2);
    for (const n of ['backWaistL', 'backWaistR']) {
      const d = dartLegs(shell, piece, n);
      expect(d.legs.length, n).toBe(2);
      expect(d.ends.some(Boolean), n).toBe(false);
      expect(d.width, n).toBeGreaterThan(0.005);
      expect(Math.abs(d.legs[0] - d.legs[1]) / d.len3, n).toBeLessThan(0.02);
    }
    const m = clothModel(g, new THREE.Matrix4(), [form, g]);
    const svg = patternSvg(m.groups.map((gr) => ({ name: gr.name, ...gr.flat! })));
    const backPath = svg.split('\n').find((l) => l.startsWith('<path') && (l.match(/ Z/g) ?? []).length === 3);
    expect(backPath).toBeDefined();

    // Cut as pieces and sewn up: each dart's two sides, the same piece's points, stitched shut.
    const pieces = garmentNode('g', 'dress', { garment: 'dress', darts: [back] }, form);
    pieces.cloth!.layout = 'pieces';
    const r = await clothRun([form, pieces]);
    r.run(3);
    const model = r.models[0], sim = r.sim as unknown as { stitches: Int32Array; x: Float64Array };
    const groupOf = new Int32Array(model.invMass.length).fill(-1);
    model.groups.forEach((gr, k) => gr.particles.forEach((p) => { groupOf[p] = k; }));
    let gap = 0, n = 0;
    for (let k = 0; k < sim.stitches.length; k += 2) {
      const a = sim.stitches[k], b = sim.stitches[k + 1];
      if (groupOf[a] !== groupOf[b]) continue;
      n++;
      gap = Math.max(gap, Math.hypot(sim.x[3 * a] - sim.x[3 * b], sim.x[3 * a + 1] - sim.x[3 * b + 1], sim.x[3 * a + 2] - sim.x[3 * b + 2]));
    }
    console.log(`darts sewn as pieces: ${n} stitches, widest ${(gap * 1000).toFixed(1)} mm`);
    expect(n).toBeGreaterThan(40);
    expect(gap).toBeLessThan(0.005);

    const skirtDarts = [
      { name: 'skirtDartFront', apex: { z: 'hip' as const, dz: 0.09, x: 0.085 }, direction: [0, 0, 1], mirror: true },
      { name: 'skirtDartBack', apex: { z: 'hip' as const, dz: 0.06, x: 0.085, back: true }, direction: [0, 0, 1], mirror: true },
    ];
    const s0 = garmentShell(garmentNode('s', 's', { garment: 'skirt' }, form).cloth!.garment!, form.bodyForm!);
    const s1 = garmentShell(garmentNode('s', 's', { garment: 'skirt', darts: skirtDarts }, form).cloth!.garment!, form.bodyForm!);
    const b0 = flat(s0, 'back'), b1 = flat(s1, 'back');
    expect(b1.strain95).toBeLessThan(b0.strain95 - 0.002);
    for (const nm of ['skirtDartBackL', 'skirtDartBackR']) {
      const d = dartLegs(s1, b1, nm);
      expect(d.legs.length, nm).toBe(2);
      expect(d.ends.every(Boolean), nm).toBe(true);
      expect(Math.abs(d.legs[0] - d.legs[1]) / d.len3, nm).toBeLessThan(0.02);
    }
  }, 300_000);

  // The preset that shows them: every piece cut flat within the 5% a woven
  // takes, and worn, at rest with its cut kept.
  it('cuts and drapes the darted sheath preset', async () => {
    const form = dartedSheathPreset.nodes.find((n) => n.bodyForm)!, dress = dartedSheathPreset.nodes.find((n) => n.cloth?.garment)!;
    const shell = garmentShell(dress.cloth!.garment!, form.bodyForm!);
    for (const n of ['backWaistL', 'backWaistR', 'elbowL', 'elbowR', 'capL', 'capR']) expect(shell.seams.some((sm) => sm.name === n), n).toBe(true);
    for (const p of shell.panels) expect(flattenPanel(p.name, shell.cut ?? shell.points, shell.tris, p.tris, shell.seams.map((sm) => sm.path)).strain95, p.name).toBeLessThan(0.05);
    const r = await clothRun(dartedSheathPreset.nodes);
    r.run(2.5);
    const s = r.strains(), speed = r.speedOver(0.5);
    console.log(`darted sheath: ${(speed * 1000).toFixed(1)} mm/s, strain p95 ${(percentile(s, 0.95) * 100).toFixed(1)}% p99 ${(percentile(s, 0.99) * 100).toFixed(1)}%`);
    expect(speed).toBeLessThan(0.005);
    expect(percentile(s, 0.95)).toBeLessThan(0.03);
    expect(percentile(s, 0.99)).toBeLessThan(0.08);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
  }, 300_000);
});

// Collars and lapels: cloth sewn on and started as worn. A collar is cut flat
// from its modelled shape (stand up the neck, fall folded over it) and sewn
// to the neckline through the neckline's own points; lapels are the fronts
// run on past their roll lines, cut in one with them and turned back.
describe('collars and lapels', () => {
  type Model = ReturnType<typeof clothModel>;
  const group = (m: Model, piece: string) => m.groups.find((gr) => gr.name.endsWith(`__${piece}`));
  /** Each column of a collar: its point on the neckline, on the roll line, and at the fall's edge (a stand of its own, or one folded piece). */
  const columns = (m: Model, suffix = '') => {
    const stand = group(m, `collarStand${suffix}`), fall = group(m, `collar${suffix}`)!;
    if (!stand) {
      // One piece: rows up the stand and down the fall, a column at each neckline point (the first point of each a garment's);
      // its roll row is its highest at the centre back.
      const garment = new Set(m.groups.filter((gr) => gr !== fall).flatMap((gr) => gr.particles));
      const rows = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((k) => fall.particles.length % k === 0 && fall.particles.every((p, i) => (i % k === 0) === garment.has(p)))!;
      const n = fall.particles.length / rows, mid = Math.floor(n / 2);
      let roll = 0;
      for (let j = 0; j < rows; j++) if (m.x0[3 * fall.particles[mid * rows + j] + 2] > m.x0[3 * fall.particles[mid * rows + roll] + 2]) roll = j;
      return Array.from({ length: n }, (_, i) => ({ neck: fall.particles[i * rows], roll: fall.particles[i * rows + roll], edge: fall.particles[i * rows + rows - 1] }));
    }
    const n = stand.particles.filter((p) => fall.particles.includes(p)).length;
    const rs = stand.particles.length / n, rf = fall.particles.length / n;
    return Array.from({ length: n }, (_, i) => ({ neck: stand.particles[i * rs], roll: stand.particles[i * rs + rs - 1], edge: fall.particles[i * rf + rf - 1] }));
  };
  const at = (x: ArrayLike<number>, p: number) => [x[3 * p], x[3 * p + 1], x[3 * p + 2]];

  it('cuts each family of collar flat, sews it on by the neckline\'s points, and starts it folded; lapels cut in one with the fronts', () => {
    const male = bodyFormNode('form', 'form', { figure: 'male' }), female = bodyFormNode('form', 'form', FEMALE);
    const shirtOf = (shirt: (typeof shirtAndJacketPreset.nodes)[number]) => ({ ...shirt.cloth!.garment!, fitTo: undefined });
    const shirtNode = shirtAndJacketPreset.nodes.find((n) => n.name === 'shirt')!, jacketNode = shirtAndJacketPreset.nodes.find((n) => n.name === 'jacket')!;
    const cases: [string, SceneNode, SceneNode][] = [
      ['band (mandarin)', male, garmentNode('g', 'g', { garment: 'tshirt', material: 'woven', neckline: 0.03, collar: { stand: 0.035, fall: 0 } }, male)],
      ['shirt collar on a stand', male, garmentNode('g', 'g', shirtOf(shirtNode), male)],
      ['flat (Peter Pan)', female, garmentNode('g', 'g', { garment: 'tshirt', material: 'woven', fitted: true, neckline: 0.05, collar: { stand: 0.006, fall: 0.07, round: 0.04, point: -0.01 } }, female)],
      ['notched, with lapels', male, garmentNode('g', 'g', shirtOf(jacketNode), male)],
    ];
    for (const [label, form, node] of cases) {
      const t0 = performance.now();
      const m = clothModel(node, new THREE.Matrix4(), [form, node]);
      const ms = performance.now() - t0;
      const pieces = m.groups.filter((gr) => /collar/.test(gr.name));
      console.log(label, `${ms.toFixed(0)} ms,`, pieces.map((gr) => `${gr.name.split('__')[1]} ${(gr.flat!.strain95 * 100).toFixed(1)}%`).join(', '));
      expect(pieces.length, label).toBeGreaterThan(0);
      // Flat as a woven needs: in the pattern, within 5%.
      for (const gr of pieces) { expect(gr.flat!.strain95, gr.name).toBeLessThan(0.05); expect(gr.flat!.outline.length).toBeGreaterThan(8); }
      // Sewn through the neckline's own points: its neck edge is the garment's, nearly every neckline point on it.
      const cols = columns(m);
      const garmentPts = new Set(m.groups.filter((gr) => !/collar/.test(gr.name)).flatMap((gr) => gr.particles));
      expect(cols.every((c) => garmentPts.has(c.neck)), label).toBe(true);
      // Started folded: the roll line above the neck edge (unless it lies flat), the fall's edge below the roll line and further from the neck axis than the neck edge.
      const L = bodyLandmarks(form.bodyForm!);
      const radial = (q: number[]) => Math.hypot(q[0], q[1] - bodyFormSection(form.bodyForm!, Math.min(q[2], L.hpsZ)).centreY);
      const folded = cols.filter((c) => at(m.x0, c.edge)[2] < at(m.x0, c.roll)[2] - 0.003 && radial(at(m.x0, c.edge)) > radial(at(m.x0, c.neck))).length / cols.length;
      if (label.startsWith('band')) expect(cols.every((c) => at(m.x0, c.roll)[2] > at(m.x0, c.neck)[2] + 0.025)).toBe(true);
      else expect(folded, label).toBeGreaterThan(0.9);
    }
    // Lapels: each front run on past its roll line into its lapel, one piece in the pattern, still flat.
    const plainJacket = garmentNode('g', 'g', { ...shirtOf(jacketNode), lapels: undefined }, male);
    const jacket = cases[3][2];
    const withLapels = clothModel(jacket, new THREE.Matrix4(), [male, jacket]), without = clothModel(plainJacket, new THREE.Matrix4(), [male, plainJacket]);
    for (const front of ['frontL', 'frontR']) {
      const a = group(withLapels, front)!, b = group(without, front)!;
      // Its area flat: the cloth past the roll line taken off, and the lapel, wider, put back.
      const area = (gr: typeof a) => Math.abs(gr.flat!.outline.reduce((acc, i, k, o) => { const p = gr.flat!.uv[i], q = gr.flat!.uv[o[(k + 1) % o.length]]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
      console.log(front, `flat ${(area(b) * 1e4).toFixed(0)} cm2 -> ${(area(a) * 1e4).toFixed(0)} cm2 with its lapel; strain95 ${(a.flat!.strain95 * 100).toFixed(1)}%`);
      expect(area(a)).toBeGreaterThan(area(b));
      expect(a.flat!.strain95).toBeLessThan(0.05);
      // Turned back over the front from the start, a layer off it; its edge the piece's.
      const lapelTacks = (withLapels.tacks ?? []).filter((t) => a.particles.includes(t.particle));
      expect(lapelTacks.length).toBeGreaterThan(10);
      const lapelPts = new Set(lapelTacks.map((t) => a.particles.indexOf(t.particle)));
      expect(a.flat!.outline.filter((i) => lapelPts.has(i)).length).toBeGreaterThan(5);
      expect(lapelTacks.every((t) => t.lift && t.offset > CLOTH_THICKNESS)).toBe(true);
    }
    expect(withLapels.groups.some((gr) => /lapel/.test(gr.name))).toBe(false);
    // The gorge seam: the collar's neck edge runs on from the neckline along each lapel's top edge,
    // through the lapel's own points, so the seam is in both patterns and sewn as they start.
    const neckEdge = columns(withLapels).map((c) => c.neck);
    for (const front of ['frontL', 'frontR']) {
      const gr = group(withLapels, front)!, lapelPts = new Set((withLapels.tacks ?? []).filter((t) => gr.particles.includes(t.particle)).map((t) => t.particle));
      const gorge = neckEdge.filter((p) => lapelPts.has(p));
      console.log(`gorge seam on ${front}: ${gorge.length} lapel points on the collar's neck edge`);
      expect(gorge.length).toBeGreaterThanOrEqual(2);
      const onOutline = (g: typeof gr, p: number) => g.flat!.outline.includes(g.particles.indexOf(p));
      expect(gorge.every((p) => onOutline(gr, p) && onOutline(group(withLapels, 'collarStand')!, p))).toBe(true);
    }
  }, 120_000);

  // A shawl collar: the lapels run on round the neck, each half cut in one
  // with its front, the halves seamed at the centre back; no collar piece.
  it('cuts a shawl collar in one with the fronts, seamed at the centre back, and drapes it with its roll kept', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const node = garmentNode('g', 'g', {
      garment: 'jacket', material: 'woven', ease: 0.16, length: 0.26, neckline: 0.05,
      lapels: { break: 0.24, width: 0.07, peak: 0, shawl: true }, collar: { stand: 0.015, standFront: 0.005, fall: 0.06 },
      trims: [{ kind: 'button', along: 'opening', spacing: 0.1, size: 0.02 }],
    }, form);
    const t0 = performance.now();
    const m = clothModel(node, new THREE.Matrix4(), [form, node]);
    const ms = performance.now() - t0;
    const fl = group(m, 'frontL')!, fr = group(m, 'frontR')!, back = group(m, 'back')!;
    console.log(`shawl: ${ms.toFixed(0)} ms, frontL ${(fl.flat!.strain95 * 100).toFixed(1)}%, frontR ${(fr.flat!.strain95 * 100).toFixed(1)}% (with their halves of the collar)`);
    expect(m.groups.some((gr) => /collar|shawl|lapel/.test(gr.name))).toBe(false);
    // A one-piece rolled collar needs more stretch to lie flat than a seamed one
    // (measured: a 3 cm one-piece stand 8.3% against 2.9/3.1% split); a shawl's
    // under collar is eased into shape, so it is held to 7.5% here (measured 4.6/6.7%).
    for (const gr of [fl, fr]) expect(gr.flat!.strain95).toBeLessThan(0.075);
    // The centre-back seam: the halves share a column of points off the neckline, both on each half's edge.
    const seam = fl.particles.filter((p) => fr.particles.includes(p) && !back.particles.includes(p));
    expect(seam.length).toBeGreaterThanOrEqual(4);
    for (const gr of [fl, fr]) expect(seam.every((p) => gr.flat!.outline.includes(gr.particles.indexOf(p)))).toBe(true);
    // Its centre back as cut: neck point, roll (its highest), and the fall's edge (furthest from the neck point).
    const cbNeck = fl.particles.find((p) => fr.particles.includes(p) && back.particles.includes(p) && Math.abs(m.x0[3 * p]) < 0.03)!;
    const roll = seam.reduce((a, p) => (m.x0[3 * p + 2] > m.x0[3 * a + 2] ? p : a));
    const edge = seam.reduce((a, p) => (Math.hypot(...at(m.x0, p).map((v, k) => v - at(m.x0, cbNeck)[k])) > Math.hypot(...at(m.x0, a).map((v, k) => v - at(m.x0, cbNeck)[k])) ? p : a));
    const r = await clothRun([form, node]);
    const x = (p: number) => at(r.sim.x, p);
    const rise0 = m.x0[3 * roll + 2] - m.x0[3 * cbNeck + 2];
    r.run(2.5);
    const speed = r.speedOver(0.5), s = r.strains();
    const rise = x(roll)[2] - x(cbNeck)[2], drop = x(roll)[2] - x(edge)[2];
    console.log(`shawl drape: ${(speed * 1000).toFixed(1)} mm/s, nearest ${(r.clearance() * 1000).toFixed(1)} mm, strain p95 ${(percentile(s, 0.95) * 100).toFixed(1)}% p99 ${(percentile(s, 0.99) * 100).toFixed(1)}%; centre back roll ${(rise0 * 1000).toFixed(0)} -> ${(rise * 1000).toFixed(0)} mm above the neck, fall's edge ${(drop * 1000).toFixed(0)} mm below the roll`);
    expect(speed).toBeLessThan(0.005);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(percentile(s, 0.95)).toBeLessThan(0.03);
    expect(percentile(s, 0.99)).toBeLessThan(0.08);
    // The roll holds: the collar still stands at the back and its fall still hangs down over it.
    expect(rise).toBeGreaterThan(0.75 * rise0);
    expect(drop).toBeGreaterThan(0.01);
  }, 300_000);

  // The preset: the shirt's collar on its stand under the jacket's notched
  // collar and lapels. Held to: settled, nothing in the form, its cut kept;
  // the lapels still turned back; each collar still up and folded over.
  it('drapes the shirt and jacket preset with their collars up and folded, the lapels turned back', async () => {
    const r = await clothRun(shirtAndJacketPreset.nodes);
    const shirt = r.models.find((m) => m.name === 'shirt')!, jacket = r.models.find((m) => m.name === 'jacket')!;
    const base = new Map<Model, number>([[shirt, 0], [jacket, shirt.invMass.length]]);
    const collars = [shirt, jacket].map((m) => ({ m, cols: columns(m) }));
    const xw = (m: Model, p: number) => at(r.sim.x, base.get(m)! + p);
    const rise = (m: Model, c: { neck: number; roll: number }, x: (m: Model, p: number) => number[]) => x(m, c.roll)[2] - x(m, c.neck)[2];
    const x0 = (m: Model, p: number) => at(m.x0, p);
    const rise0 = collars.map(({ m, cols }) => cols.map((c) => rise(m, c, x0)));
    r.run(2.5);
    const speed = r.speedOver(0.5);
    const s = r.strains();
    // Nearest the form any collar point comes.
    const inv = (r.sim as unknown as { inv: THREE.Matrix4[] }).inv;
    let collarClear = Infinity;
    const v = new THREE.Vector3();
    for (const { m } of collars) for (const gr of m.groups.filter((g) => /collar/.test(g.name))) for (const p of gr.particles) {
      r.colliders.forEach((c: Collider, ci) => {
        if (!c.body && c.geom === undefined) return;
        const q = xw(m, p);
        v.set(q[0], q[1], q[2]).applyMatrix4(inv[ci]);
        const h = colliderContact(c, [v.x, v.y, v.z]);
        if (h) collarClear = Math.min(collarClear, h.d);
      });
    }
    console.log(`shirt and jacket: ${(speed * 1000).toFixed(1)} mm/s, nearest ${(r.clearance() * 1000).toFixed(1)} mm (collars ${(collarClear * 1000).toFixed(1)} mm), strain p95 ${(percentile(s, 0.95) * 100).toFixed(1)}% p99 ${(percentile(s, 0.99) * 100).toFixed(1)}%`);
    expect(speed).toBeLessThan(0.005);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(collarClear).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(percentile(s, 0.95)).toBeLessThan(0.03);
    expect(percentile(s, 0.99)).toBeLessThan(0.08);
    collars.forEach(({ m, cols }, k) => {
      // Still folded: the fall's edge below the roll line, round the collar.
      const folded = cols.filter((c) => xw(m, c.edge)[2] < xw(m, c.roll)[2] - 0.003).length / cols.length;
      // Still up: the stand's rise at the back half, against what it was cut to.
      const back = cols.map((c, i) => ({ c, i })).filter(({ c }) => x0(m, c.neck)[1] > 0);
      const kept = back.reduce((acc, { c, i }) => acc + rise(m, c, xw) / rise0[k][i], 0) / back.length;
      console.log(`${m.name} collar: folded at ${(folded * 100).toFixed(0)}% of its columns, stand kept ${(kept * 100).toFixed(0)}% of its rise round the back`);
      expect(folded).toBeGreaterThan(0.9);
      expect(kept).toBeGreaterThan(0.75);
    });
    // The lapels lie turned back on the fronts: how far each point has lifted off them.
    for (const front of ['frontL', 'frontR']) {
      const gr = jacket.groups.find((g) => g.name.endsWith(`__${front}`))!;
      const lift = (jacket.tacks ?? []).filter((t) => gr.particles.includes(t.particle)).map((t) => {
        const [a, b, c] = t.tri.map((q) => xw(jacket, q)), p = xw(jacket, t.particle);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nrm = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
        const foot = [0, 1, 2].map((q) => t.bary[0] * a[q] + t.bary[1] * b[q] + t.bary[2] * c[q]);
        return ((p[0] - foot[0]) * nrm[0] + (p[1] - foot[1]) * nrm[1] + (p[2] - foot[2]) * nrm[2]) / nl;
      }).sort((p, q) => p - q);
      console.log(`lapel on ${front}: off the front ${(lift[0] * 1000).toFixed(1)}-${(lift[lift.length - 1] * 1000).toFixed(1)} mm, median ${(lift[lift.length >> 1] * 1000).toFixed(1)} mm`);
      expect(lift[0]).toBeGreaterThan(CLOTH_THICKNESS);
      expect(lift[lift.length >> 1]).toBeLessThan(0.01);
      expect(lift[lift.length - 1]).toBeLessThan(0.02);
    }
  }, 300_000);
});

// Fullness: more cloth on one side of a seam than the seam is long. A woven
// sleeve's cap is eased into its armhole: the pattern's cap a few percent
// longer than the armhole, which is no strain. A skirt gathered into a
// bodice, and one pleated from a yoke: the pieces cut wider along the seam,
// the extra eased into it as sewn, and draped, folds.
describe('fullness', () => {
  /** A horizontal slice through a cloth's triangles: its length, and the length round the outside of it (convex hull). */
  const slice = (x: ArrayLike<number>, base: number, tris: number[], z0: number) => {
    let len = 0;
    const pts: number[][] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const q = [tris[t], tris[t + 1], tris[t + 2]].map((i) => [x[3 * (base + i)], x[3 * (base + i) + 1], x[3 * (base + i) + 2]]);
      const cut: number[][] = [];
      for (let e = 0; e < 3; e++) { const a = q[e], b = q[(e + 1) % 3]; if ((a[2] - z0) * (b[2] - z0) < 0) { const f = (z0 - a[2]) / (b[2] - a[2]); cut.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]); } }
      if (cut.length === 2) { len += Math.hypot(cut[0][0] - cut[1][0], cut[0][1] - cut[1][1]); pts.push(...cut); }
    }
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: number[][]) => { const h: number[][] = []; for (const p of list) { while (h.length >= 2 && cr(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } return h.slice(0, -1); };
    const hull = [...half(pts), ...half(pts.slice().reverse())];
    let round = 0;
    for (let i = 0; i < hull.length; i++) round += Math.hypot(hull[i][0] - hull[(i + 1) % hull.length][0], hull[i][1] - hull[(i + 1) % hull.length][1]);
    return { len, round };
  };

  it('eases a woven sleeve cap into its armhole, as far as the fabric eases', () => {
    const form = bodyFormNode('form', 'form', FEMALE);
    const ease = (material: 'woven' | 'jersey') => {
      const g = garmentNode('g', 'g', { garment: 'tshirt', material }, form);
      const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
      return { shell, sides: fullSides(shell, undefined, material) };
    };
    // A knit gives over the shoulder as it is; a woven's sleeves carry the ease, the body none.
    expect(ease('jersey').sides.length).toBe(0);
    const { shell, sides } = ease('woven');
    expect(sides.map((sd) => shell.panels[sd.panel].name).sort()).toEqual(['sleeveL', 'sleeveR']);
    for (const sd of sides) {
      expect(sd.kind).toBe('ease');
      expect(sd.ratio).toBeCloseTo(1 + CLOTH_MATERIALS.woven.easeIn, 3);
      const p = shell.panels[sd.panel], seams = shell.seams.map((sm) => sm.path), P = shell.cut ?? shell.points;
      const plain = flattenPanel(p.name, P, shell.tris, p.tris, seams, 15, undefined);
      const eased = flattenPanel(p.name, P, shell.tris, p.tris, seams, 15, undefined, panelEdgeEase(shell, sides, sd.panel));
      // The cap lies longer than the armhole, by no more than its ease, and that is not strain.
      let flat = 0, worn = 0;
      for (let i = 0; i < eased.outline.length; i++) {
        const a = eased.outline[i], b = eased.outline[(i + 1) % eased.outline.length], ga = eased.points[a], gb = eased.points[b];
        if (!sd.edges.has(ga < gb ? ga * P.length + gb : gb * P.length + ga)) continue;
        flat += Math.hypot(eased.uv[a][0] - eased.uv[b][0], eased.uv[a][1] - eased.uv[b][1]);
        worn += Math.hypot(P[ga][0] - P[gb][0], P[ga][1] - P[gb][1], P[ga][2] - P[gb][2]);
      }
      console.log(`${p.name}: cap ${(flat / worn * 100 - 100).toFixed(1)}% over its armhole; strain95 ${(plain.strain95 * 100).toFixed(2)}% plain, ${(eased.strain95 * 100).toFixed(2)}% eased`);
      expect(flat / worn).toBeGreaterThan(1.01);
      expect(flat / worn).toBeLessThan(1 + CLOTH_MATERIALS.woven.easeIn + 0.01);
      expect(eased.strain95).toBeLessThan(plain.strain95 - 0.01);
      expect(eased.edgeEase!.some((e) => e > 0)).toBe(true);
    }
  });

  it('gathers a skirt into its bodice, tucks the bodice, and pleats a skirt from its yoke: cut wider, sewn in, draped in folds', async () => {
    const t0 = performance.now();
    const r = await clothRun(gathersAndPleatsPreset.nodes);
    const build = performance.now() - t0;
    const L = bodyLandmarks(clampBodyForm(FEMALE));
    const bases = new Map<string, number>();
    let b = 0;
    for (const m of r.models) { bases.set(m.name, b); b += m.invMass.length; }
    for (const [name, seam, want] of [['gathered', 'waist', 2], ['pleated', 'yoke', 2.5]] as const) {
      // The gathered skirt's own seam edge: the bodice above it is spread too (its tucks), and the fuller side is the one tacked.
      const m = r.models.find((mm) => mm.name === name)!;
      // The pieces below the seam cut that much wider along it: their sewn edge
      // flat, over the seam it is sewn to (the edges of the panel above that the tacks hold it to).
      expect(m.tacks!.length, name).toBeGreaterThan(40);
      let along = 0, seamRound = 0;
      for (const grp of m.groups) {
        const set = new Set(grp.particles);
        const mine = m.tacks!.filter((tk) => set.has(tk.particle) && !tk.tri.some((q) => set.has(q)));
        if (!mine.length) continue;
        const sewn = new Set(mine.map((tk) => tk.particle));
        const local = new Map(grp.particles.map((p, i) => [p, i]));
        const out = grp.flat!.outline;
        for (let i = 0; i < out.length; i++) {
          const pa = grp.particles[out[i]], pb = grp.particles[out[(i + 1) % out.length]];
          if (sewn.has(pa) || sewn.has(pb)) along += Math.hypot(grp.flat!.uv[local.get(pa)!][0] - grp.flat!.uv[local.get(pb)!][0], grp.flat!.uv[local.get(pa)!][1] - grp.flat!.uv[local.get(pb)!][1]);
        }
      }
      const node = gathersAndPleatsPreset.nodes.find((n) => n.name === name)!, formNode = gathersAndPleatsPreset.nodes.find((n) => n.name === node.cloth!.garment!.fitTo)!;
      const shell = garmentShell(node.cloth!.garment!, formNode.bodyForm!);
      for (const sm of shell.seams) if (sm.name === seam) for (let i = 1; i < sm.path.length; i++) { const a = shell.points[sm.path[i - 1]], c = shell.points[sm.path[i]]; seamRound += Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]); }
      console.log(`${name}: cut ${along.toFixed(2)} m along a seam ${seamRound.toFixed(2)} m long (x${(along / seamRound).toFixed(2)})`);
      expect(along / seamRound).toBeGreaterThan(0.85 * want);
      expect(along / seamRound).toBeLessThan(1.1 * want);
    }
    r.run(2.5);
    const speed = r.speedOver(0.5), s = r.strains();
    console.log(`gathers and pleats: built ${(build / 1000).toFixed(1)} s, ${(speed * 1000).toFixed(1)} mm/s, nearest ${(r.clearance() * 1000).toFixed(1)} mm, strain p95 ${(percentile(s, 0.95) * 100).toFixed(2)}% p99 ${(percentile(s, 0.99) * 100).toFixed(2)}%`);
    expect(speed).toBeLessThan(0.005);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(percentile(s, 0.95)).toBeLessThan(0.03);
    expect(percentile(s, 0.99)).toBeLessThan(0.08);
    // Folds: the cloth round the garment at a height over the way round its
    // outside. The tucks folded where stitched, open (none) above.
    for (const [name, z, least, most] of [['gathered', L.waistZ + 0.04, 1.08, 9], ['gathered', L.waistZ + 0.15, 0, 1.06], ['gathered', L.waistZ - 0.1, 1.2, 9], ['gathered', L.waistZ - 0.3, 1.1, 9], ['pleated', L.waistZ - 0.15, 1.6, 9], ['pleated', L.waistZ - 0.4, 1.5, 9]] as const) {
      const m = r.models.find((mm) => mm.name === name)!;
      const q = slice(r.sim.x, bases.get(name)!, m.tris, z);
      console.log(`${name} at ${z.toFixed(2)} m: cloth ${q.len.toFixed(2)} m round ${q.round.toFixed(2)} m (x${(q.len / q.round).toFixed(2)})`);
      expect(q.len / q.round, `${name} at ${z.toFixed(2)}`).toBeGreaterThan(least);
      expect(q.len / q.round, `${name} at ${z.toFixed(2)}`).toBeLessThan(most);
      // Sewn: each seam point where it was sewn on (a millimetre or two of the pleats' pressing).
      let gap = 0;
      for (const tk of m.tacks!) {
        const o = bases.get(name)!, X = r.sim.x, at = (i: number, c: number) => X[3 * (o + i) + c];
        const p = [0, 1, 2].map((c) => at(tk.particle, c)), w = [0, 1, 2].map((c) => tk.bary[0] * at(tk.tri[0], c) + tk.bary[1] * at(tk.tri[1], c) + tk.bary[2] * at(tk.tri[2], c));
        gap = Math.max(gap, Math.hypot(p[0] - w[0], p[1] - w[1], p[2] - w[2]) - tk.offset);
      }
      expect(gap, name).toBeLessThan(0.004);
    }
  }, 300_000);

  it('lets unpressed pleats fall open below their stitching', async () => {
    const form = bodyFormNode('form', 'form', FEMALE);
    const L = bodyLandmarks(form.bodyForm!);
    const g = garmentNode('g', 'pleated', {
      garment: 'skirt', length: 0.55, flare: 1.3,
      seams: [{ name: 'yoke', point: [0, 0, L.waistZ - 0.07], normal: [0, 0, 1] }],
      fullness: [{ along: 'yoke', kind: 'knife', ratio: 2.5, count: 6, stitched: 0.1, pressed: false }],
    }, form);
    const r = await clothRun([form, g]);
    r.run(3.5);
    const speed = r.speedOver(0.5), s = r.strains(), m = r.models[0];
    // Near the hem: 5 cm above where it hangs (its highest point), so the
    // slice is a whole ring round the skirt. At a fixed height it cut the
    // hem's ragged edge and read less cloth than the way round (x0.89).
    const zOf = (i: number) => r.sim.x[3 * i + 2];
    const hem = boundaryLoops(m.invMass.length, m.tris).reduce((a, b) => (b.reduce((t, i) => t + zOf(i), 0) / b.length < a.reduce((t, i) => t + zOf(i), 0) / a.length ? b : a));
    const hemTop = Math.max(...hem.map(zOf));
    const near = slice(r.sim.x, 0, m.tris, L.waistZ - 0.15), low = slice(r.sim.x, 0, m.tris, hemTop + 0.05);
    console.log(`unpressed pleats: ${(speed * 1000).toFixed(1)} mm/s, p99 ${(percentile(s, 0.99) * 100).toFixed(2)}%, folds x${(near.len / near.round).toFixed(2)} stitched, x${(low.len / low.round).toFixed(2)} 5 cm above the hem (${hemTop.toFixed(3)} m)`);
    expect(speed).toBeLessThan(0.005);
    expect(percentile(s, 0.99)).toBeLessThan(0.08);
    expect(near.len / near.round).toBeGreaterThan(1.6);
    expect(low.len / low.round).toBeLessThan(1.15);
  }, 300_000);
});
