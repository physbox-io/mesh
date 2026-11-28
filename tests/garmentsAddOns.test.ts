// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

//
// Elastics, negative ease, pockets and belts.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import { ballgownPreset, tailoredOutfitPreset } from '../src/presets/clothPresets';
import { clothRun, percentile } from './clothSimHarness';
import { clothModel } from '../src/utils/cloth/clothModel';
import * as THREE from 'three';

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
    const jacket = garmentNode('jacket', 'jacket', { garment: 'jacket', pockets: [{ panel: 'sleeveL', at: [0.5, 0.5], width: 0.06, height: 0.08 }] }, form);
    const mj = clothModel(jacket, new THREE.Matrix4(), [form, jacket]);
    const sp = mj.groups.find((gr) => gr.name.endsWith('__pocket_sleeveL'))!;
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
    // The tails may lie one over the other as they hang (seen from behind,
    // their sides overlapped by 15 mm once bending was solved at the
    // ribbon's own compliance); neither passes through the other or the bow.
    expect(r.crossings().filter((c) => c.edgePiece.startsWith('bow') && c.triPiece.startsWith('bow'))).toEqual([]);
  }, 300_000);
});
