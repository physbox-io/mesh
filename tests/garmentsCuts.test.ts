// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

//
// Cuts and seams a draft asks for, boning, and stiffened pieces.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyFormGeoms, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { bonedGownPreset } from '../src/presets/clothPresets';
import type { SceneNode } from '../src/types/scene';
import { clothRun, percentile } from './clothSimHarness';
import { clothModel } from '../src/utils/cloth/clothModel';
import { patternSvg } from '../src/utils/cloth/patternSvg';
import * as THREE from 'three';
import { FEMALE } from './garmentsShared';

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
