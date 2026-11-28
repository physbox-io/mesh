// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

//
// Darts.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { dartedSheathPreset } from '../src/presets/clothPresets';
import type { SceneNode } from '../src/types/scene';
import { clothRun, percentile } from './clothSimHarness';
import { clothModel } from '../src/utils/cloth/clothModel';
import { patternSvg } from '../src/utils/cloth/patternSvg';
import * as THREE from 'three';
import { FEMALE } from './garmentsShared';

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
      // The plain sleeve's woven cap has the plan's own cap dart now (garmentPlan): measured plain 5.9%, darted 4.4%.
      expect(p1.strain95).toBeLessThan(p0.strain95 - 0.01);
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
