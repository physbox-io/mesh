// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyFormSection, bodyLandmarks, clampBodyForm } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import { GARMENT_DEFAULTS } from '../src/utils/cloth/garments';
import { ballgownPreset, menswearPreset } from '../src/presets/clothPresets';
import type { BodyFormMeasurements, GarmentDraft, GarmentKind } from '../src/types/cloth';
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
    for (const p of shell.panels) {
      const piece = flattenPanel(p.name, shell.cut ?? shell.points, shell.tris, p.tris, shell.seams.map((s) => s.path));
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
});

// A garment laid out as its pieces, each flat a little off where it goes,
// sews up onto the form when the scene plays: the stitches close over the
// sew time and it settles clear of the body, holding its cut.
describe('laid out as pieces', () => {
  it('a t-shirt sews up from its flat pieces', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const g = garmentNode('g', 'garment', { garment: 'tshirt' }, form);
    g.cloth!.layout = 'pieces';
    const r = await clothRun([form, g]);
    r.run(4);
    expect(r.speedOver(0.5)).toBeLessThan(0.005);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    expect(percentile(r.strains(), 0.95)).toBeLessThan(0.03);
  }, 300_000);
});

// Several garments together: each worn over those of lower layers, and an
// ornament sewn onto a garment.
describe('worn together', () => {
  it('keeps each layer outside the ones under it: jeans, a t-shirt over them, a jacket over that', async () => {
    const r = await clothRun(menswearPreset.nodes);
    r.run(3);
    expect(r.speedOver(0.5)).toBeLessThan(0.005);
    expect(r.clearance()).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    // Each outer particle against the nearest triangle of each lower layer,
    // by that triangle's outward normal (garments are wound outward).
    const x = r.sim.x;
    let base = 0;
    const bases = r.models.map((m) => { const b = base; base += m.invMass.length; return b; });
    for (const [oi, outer] of r.models.entries()) {
      for (const [ii, inner] of r.models.entries()) {
        if (inner.layer >= outer.layer) continue;
        let inside = 0, near = 0;
        for (let p = 0; p < outer.invMass.length; p++) {
          const k = 3 * (bases[oi] + p);
          let best = Infinity, sd = 0;
          for (let t = 0; t < inner.tris.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map((q) => 3 * (bases[ii] + inner.tris[t + q]));
            const cx = (x[a] + x[b] + x[c]) / 3, cy = (x[a + 1] + x[b + 1] + x[c + 1]) / 3, cz = (x[a + 2] + x[b + 2] + x[c + 2]) / 3;
            const d = Math.hypot(x[k] - cx, x[k + 1] - cy, x[k + 2] - cz);
            if (d >= best) continue;
            best = d;
            const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2], vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, nl = Math.hypot(nx, ny, nz) || 1;
            sd = ((x[k] - cx) * nx + (x[k + 1] - cy) * ny + (x[k + 2] - cz) * nz) / nl;
          }
          if (best > 0.03) continue;
          near++;
          if (sd < -0.002) inside++;
        }
        console.log(`${outer.name} over ${inner.name}: ${near} points near it, ${inside} inside it`);
        expect(inside / Math.max(1, near), `${outer.name} through ${inner.name}`).toBeLessThan(0.01);
      }
    }
    const jIdx = r.models.findIndex((m) => m.name === 'jacket'), jm = r.models[jIdx], jb = bases[jIdx];
    const frontL = jm.groups.find((gr) => gr.name.endsWith('__frontL'))!;
    const frontR = jm.groups.find((gr) => gr.name.endsWith('__frontR'))!;
    const topZL = Math.max(...frontL.particles.map((i) => x[3 * (jb + i) + 2]));
    const topZR = Math.max(...frontR.particles.map((i) => x[3 * (jb + i) + 2]));
    expect(Math.abs(topZL - topZR)).toBeLessThan(0.02);
    expect(Math.min(topZL, topZR)).toBeGreaterThan(1.45);
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
