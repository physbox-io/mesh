import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAST_MATERIALS,
  CAST_METALS,
  SILICONES,
  castMaterialWarnings,
  castWeightG,
  mixGrams,
  resolveCastMaterial,
} from '../src/utils/castMaterials';

describe('the material list', () => {
  it('gives every entry a weight', () => {
    for (const m of CAST_MATERIALS) {
      expect(castWeightG(m.id, 1000), m.id).toBeCloseTo(m.densityGcm3, 9);
      expect(m.densityGcm3, m.id).toBeGreaterThan(0);
    }
  });

  it('gives every entry a colour, see-through only for what is clear', () => {
    for (const m of CAST_MATERIALS) {
      expect(m.rgba, m.id).toHaveLength(4);
      for (const c of m.rgba) expect(c >= 0 && c <= 1, m.id).toBe(true);
      // Alpha 0 draws nothing at all.
      expect(m.rgba[3], m.id).toBeGreaterThan(0.2);
    }
    const alpha = (id: string) => CAST_MATERIALS.find((m) => m.id === id)!.rgba[3];
    expect(alpha('epoxy')).toBeLessThan(0.5);
    expect(alpha('water')).toBeLessThan(0.5);
    for (const opaque of ['plaster', 'concrete', 'bronze', 'chocolate']) expect(alpha(opaque), opaque).toBe(1);
  });

  it('gives every metal what a pattern needs', () => {
    expect(CAST_METALS.map((m) => m.id)).toEqual(['aluminium', 'brass', 'bronze', 'silver']);
    for (const m of CAST_METALS) {
      expect(m.shrinkPercent).toBeGreaterThan(0);
      expect(m.pourC).toBeGreaterThan(500);
    }
  });

  it('splits a mix by its ratio', () => {
    expect(SILICONES.map((m) => m.id)).toEqual(['platinum', 'tin']);
    const tin = mixGrams('tin', 110)!;
    expect(tin.a).toBeCloseTo(100, 9);
    expect(tin.b).toBeCloseTo(10, 9);
    expect(mixGrams('plaster', 170)).toMatchObject({ a: 100, b: 70, aLabel: 'powder', bLabel: 'water' });
    expect(mixGrams('epoxy', 100)).toBeNull();
  });

  it('reads the old name for silicone', () => {
    expect(resolveCastMaterial('silicone')).toBe('platinum');
    expect(resolveCastMaterial('bronze')).toBe('bronze');
    expect(resolveCastMaterial('lava')).toBeNull();
  });
});

describe('warnings come from the data', () => {
  it('warns about a big epoxy pour in PLA only', () => {
    expect(castMaterialWarnings('epoxy', 150, { pla: true })).toEqual([]);
    expect(castMaterialWarnings('epoxy', 250, { pla: true })[0]).toMatch(/A 250 ml epoxy pour.*60 °C/);
    expect(castMaterialWarnings('epoxy', 250, { pla: false })).toEqual([]);
  });

  it('warns about anything poured hotter than PLA takes', () => {
    expect(castMaterialWarnings('wax', 10, { pla: true })[0]).toMatch(/softens a PLA mold/);
    expect(castMaterialWarnings('wax', 10, { pla: false })).toEqual([]);
    expect(castMaterialWarnings('chocolate', 10, { pla: true }).join(' ')).not.toMatch(/softens/);
  });

  it('carries the notes that apply in any mold', () => {
    expect(castMaterialWarnings('water', 10, { pla: false })[0]).toMatch(/9%/);
    expect(castMaterialWarnings('chocolate', 10, { pla: false })[0]).toMatch(/food/i);
  });

  it('leaves no material name in a branch in the casting code', () => {
    const names = CAST_MATERIALS.map((m) => m.id).join('|');
    // Real ids only: 'silicone' is a Mold tab as well as an old name for platinum.
    const branch = new RegExp(`(===|!==|case)\\s*'(${names})'`);
    const files = [
      ...readdirSync('src/utils').filter((f) => /^(mold|pour|cast|silicone)/i.test(f)).map((f) => join('src/utils', f)),
      ...readdirSync('src/components').filter((f) => /(Mold|Cast|Pour)/.test(f)).map((f) => join('src/components', f)),
      ...readdirSync('src/components/cast').map((f) => join('src/components/cast', f)),
    ];
    expect(files.length).toBeGreaterThan(8);
    for (const f of files) {
      const hit = readFileSync(f, 'utf8').split('\n').findIndex((line) => branch.test(line));
      expect(hit, `${f}:${hit + 1}`).toBe(-1);
    }
  });
});
