// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

//
// The body form, garments that start where they hang, and trims.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyFormSection, bodyLandmarks, clampBodyForm } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import type { GarmentTrim } from '../src/types/cloth';
import type { SceneNode } from '../src/types/scene';
import { clothRun } from './clothSimHarness';
import { clothModel } from '../src/utils/cloth/clothModel';
import { patternSvg } from '../src/utils/cloth/patternSvg';
import * as THREE from 'three';
import { girth } from './garmentsShared';

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
    const by = (kind: string) => m.groups.flatMap((gr) => (gr.trims ?? []).filter((t) => t.kind === kind).map(() => gr.name.split('__')[1]));
    const zipper = by('zipper'), studs = by('stud');
    expect(zipper.length).toBeGreaterThan(20);
    expect(new Set(zipper)).toEqual(new Set(['frontL', 'frontR']));
    expect(studs.length).toBeGreaterThan(12);
    expect(new Set(studs)).toEqual(new Set(['frontL', 'frontR', 'back', 'sleeveL', 'sleeveR']));
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
