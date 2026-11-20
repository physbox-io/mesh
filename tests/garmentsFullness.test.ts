// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

//
// Fullness: ease, gathers and pleats.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyLandmarks, clampBodyForm } from '../src/utils/cloth/bodyForm';
import { boundaryLoops, garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import { fullSides, panelEdgeEase } from '../src/utils/cloth/garmentFullness';
import { gathersAndPleatsPreset } from '../src/presets/clothPresets';
import { clothRun, percentile } from './clothSimHarness';
import { FEMALE } from './garmentsShared';

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
    // x1.154 measured since bending is solved at the cloth's own compliance (x1.15 or less when each pass was its own).
    expect(low.len / low.round).toBeLessThan(1.2);
  }, 300_000);
});
