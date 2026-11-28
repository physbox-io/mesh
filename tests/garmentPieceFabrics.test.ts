// A garment's own panels could not be cut in a fabric or colour of their
// own: only sewn-on pieces had one. pieceFabrics names any piece (a panel, its
// L and R pair, a piece sewn on) and gives it a fabric, overrides and a colour.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clothModel } from '../src/utils/cloth/clothModel';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { garmentPieceRgba } from '../src/utils/cloth/garments';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import type { GarmentDraft } from '../src/types/cloth';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const build = (draft: Omit<GarmentDraft, 'fitTo'>) => {
  const n = garmentNode('g', 'g', draft, form);
  return clothModel(n, new THREE.Matrix4(), [form, n]);
};
const massOf = (m: ReturnType<typeof build>, piece: string) => {
  const g = m.groups.find((q) => q.name === `g__${piece}`)!;
  return g.particles.reduce((acc, p) => acc + (m.invMass[p] > 0 ? 1 / m.invMass[p] : 0), 0);
};

describe('pieceFabrics', () => {
  it('cuts a panel pair and a sewn-on piece in their own fabric and colour; the rest follow the garment', () => {
    const base = build({ garment: 'jacket', material: 'woven', trims: [], collar: { stand: 0.03, fall: 0.045 } });
    const m = build({ garment: 'jacket', material: 'woven', trims: [], collar: { stand: 0.03, fall: 0.045 },
      pieceFabrics: [{ piece: 'front', material: 'leather', rgba: [0.8, 0.1, 0.1, 1] }, { piece: 'collar', rgba: [0, 0, 0, 1] }] });
    expect(m.warnings).toBeUndefined();
    for (const side of ['frontL', 'frontR']) {
      const g = m.groups.find((q) => q.name === `g__${side}`)!;
      expect(g.material).toBe('leather');
      expect(g.rgba).toEqual([0.8, 0.1, 0.1, 1]);
      expect(g.tint).toBeUndefined();
      // Leather is heavier than woven, area for area (its seam points shared with the woven back, a little less).
      const r = massOf(m, side) / massOf(base, side), want = CLOTH_MATERIALS.leather.arealDensity / CLOTH_MATERIALS.woven.arealDensity;
      expect(r).toBeGreaterThan(1 + 0.8 * (want - 1));
      expect(r).toBeLessThanOrEqual(want + 1e-9);
    }
    const back = m.groups.find((q) => q.name === 'g__back')!;
    expect(back.material).toBe('woven');
    expect(back.tint).toBe(0.85);
    const collar = m.groups.find((q) => q.name.startsWith('g__collar'))!;
    expect(collar.rgba).toEqual([0, 0, 0, 1]);
    expect(collar.tint).toBeUndefined();
    expect(massOf(m, 'back')).toBeGreaterThanOrEqual(massOf(base, 'back'));
  }, 180_000);

  it('says so when it names no piece', () => {
    const m = build({ garment: 'skirt', pieceFabrics: [{ piece: 'yoke', rgba: [1, 0, 0, 1] }] });
    expect(m.warnings?.find((w) => w.startsWith("pieceFabrics[0].piece 'yoke' names no piece"))).toMatch(/its pieces: .*front/);
  }, 180_000);

  it('the live colour of a piece is its own, the last entry winning', () => {
    const d: GarmentDraft = { garment: 'dress', pieceFabrics: [{ piece: 'front', rgba: [1, 0, 0, 1] }, { piece: 'frontL', rgba: [0, 1, 0, 1] }], attached: [{ name: 'frill', outline: [[0, 0], [1, 0], [1, 1]], along: 'hem', rgba: [0, 0, 1, 1] }] };
    expect(garmentPieceRgba(d, 'frontL')).toEqual([0, 1, 0, 1]);
    expect(garmentPieceRgba(d, 'frontR')).toEqual([1, 0, 0, 1]);
    expect(garmentPieceRgba(d, 'frill')).toEqual([0, 0, 1, 1]);
    expect(garmentPieceRgba(d, 'back')).toBeUndefined();
  });
});
