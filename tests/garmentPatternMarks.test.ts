import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '../src/utils/polygonOffset';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import { layoutPattern, patternSvg, type PatternPiece } from '../src/utils/cloth/patternSvg';
import { placeNotches } from '../src/utils/cloth/patternNotches';
import { exportClothPatternUnfold, patternLayoutOptions } from '../src/utils/cloth/patternExport';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const tee = garmentNode('tee', 'tee', { garment: 'tshirt' }, form);
const model = clothModel(tee, new THREE.Matrix4(), [form, tee]);
const pieces: PatternPiece[] = model.groups.filter((g) => g.flat).map((g) => ({ name: g.name.split('__')[1], ...g.flat!, garment: 'tee', fabric: g.material }));
const byName = (n: string) => pieces.find((p) => p.name === n)!;

describe('a pattern a sewist can put together', () => {
  it('notches sit at the same shell points on both sides of a seam', () => {
    const notches = placeNotches(pieces, pieces.map(() => new Set()));
    const ids = (i: number) => new Set(notches[i].filter((n) => n.t === 0).map((n) => pieces[i].ids![pieces[i].outline[n.k]]));
    const fi = pieces.findIndex((p) => p.name === 'front'), bi = pieces.findIndex((p) => p.name === 'back');
    expect(notches[fi].length).toBeGreaterThan(2);
    // Every notch on the front's seams to the back is on the back too.
    const backIds = ids(bi);
    const toBack = notches[fi].filter((n) => pieces[fi].edges![n.k]?.to?.includes('back') || pieces[fi].edges![(n.k - 1 + pieces[fi].outline.length) % pieces[fi].outline.length]?.to?.includes('back'));
    expect(toBack.length).toBeGreaterThan(0);
    for (const n of toBack) expect(backIds.has(pieces[fi].ids![pieces[fi].outline[n.k]])).toBe(true);
  });

  it('names each seam and what it sews to, on both its edges', () => {
    const L = layoutPattern(pieces, { seamAllowanceMm: 10 });
    const front = L.pieces.find((p) => p.name === 'front')!, back = L.pieces.find((p) => p.name === 'back')!;
    expect(front.seamLabels.some((l) => l.text.includes('sews to back'))).toBe(true);
    expect(back.seamLabels.some((l) => l.text.includes('sews to front'))).toBe(true);
    expect(front.seamLabels.some((l) => /sews to sleeve/.test(l.text))).toBe(true);
    expect(front.seamLabels.some((l) => l.text.startsWith('hem: turn up'))).toBe(true);
  });

  it('mirror pairs drawn once to cut 2, symmetric pieces halved on the fold', () => {
    const L = layoutPattern(pieces, { ...patternLayoutOptions(), fold: true });
    const sleeves = L.pieces.find((p) => p.names.includes('sleeveL'))!;
    expect(sleeves.names).toEqual(['sleeveL', 'sleeveR']);
    expect(sleeves.cut).toMatch(/Cut 2/);
    for (const n of ['front', 'back']) {
      const p = L.pieces.find((q) => q.name === n)!;
      expect(p.cut, n).toBe('Cut 1 on fold');
      expect(p.fold, n).toBeDefined();
      const whole = layoutPattern([byName(n)], { seamAllowanceMm: 10 }).pieces[0];
      expect(p.w).toBeLessThan(0.62 * whole.w);
    }
    expect(L.pieces.length).toBe(3);
    // Without folding, every piece whole, once each.
    expect(layoutPattern(pieces, { seamAllowanceMm: 10 }).pieces.every((p) => p.cut === 'Cut 1')).toBe(true);
  });

  it('a separate hem allowance, and an allowance per edge', () => {
    const rect: PatternPiece = {
      name: 'panel', uv: [[0, 0], [0.1, 0], [0.1, 0.2], [0, 0.2]], outline: [0, 1, 2, 3], strain95: 0,
      edges: [{ line: 'hem' }, { line: 'side', sewn: true, to: ['x'] }, { line: 'neckline' }, { line: 'side', sewn: true, to: ['x'] }],
    };
    expect(layoutPattern([rect], { seamAllowanceMm: 10, hemAllowanceMm: 30 }).pieces[0].h).toBeCloseTo(240, 1);
    const per = layoutPattern([rect], { seamAllowanceMm: 10, hemAllowanceMm: 30, edgeAllowanceMm: { hem: 40, neckline: 5 } }).pieces[0];
    expect(per.h).toBeCloseTo(245, 1);
    expect(per.w).toBeCloseTo(120, 1);
  });

  it('labels, grain arrows and a title block, in sewing terms', () => {
    const r = exportClothPatternUnfold([tee], [form, tee], undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.svg).not.toMatch(/ease to lie flat/);
    expect(r.svg).toContain('50 × 50 mm');
    expect(r.svg).toMatch(/Size: fitted to form, height \d+, chest \d+/);
    expect(r.svg).toContain('Fabric: jersey');
    expect(r.svg).toMatch(/Cut: .*on fold/);
    expect(r.svg).toContain('25 mm hem');
    for (const p of r.layout.pieces) {
      const outline = p.outlinePts;
      expect(pointInPolygon(p.label, outline), p.name).toBe(true);
      expect(p.grain, p.name).toBeDefined();
      expect(pointInPolygon({ x: p.grain!.x, y: (p.grain!.y0 + p.grain!.y1) / 2 }, outline), p.name).toBe(true);
    }
    const svg = patternSvg(pieces, 'tee', { seamAllowanceMm: 10 });
    expect((svg.match(/<line [^>]*><title>notch/g) ?? []).length).toBeGreaterThan(4);
  });
});
