import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAST_MATERIALS,
  CAST_METALS,
  SILICONES,
  castMaterial,
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
    // Cured epoxy and ice are hazy, not glass: see-through, but plainly there.
    for (const hazy of ['epoxy', 'water']) {
      expect(alpha(hazy), hazy).toBeGreaterThan(0.45);
      expect(alpha(hazy), hazy).toBeLessThan(0.75);
    }
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
    const plaster = mixGrams('plaster', 170)!;
    expect(plaster).toMatchObject({ aLabel: 'powder', bLabel: 'water' });
    expect(plaster.a / plaster.b).toBeCloseTo(100 / 70, 9);
    expect(mixGrams('epoxy', 100)).toBeNull();
  });

  it('weighs out plaster as the slurry that fills the mold, not the lighter piece it dries to', () => {
    // 100 cm³ of mold: split from the cured 120 g, the mix came out a quarter short.
    const mix = mixGrams('plaster', castWeightG('plaster', 100_000))!;
    // Powder (2.63 g/cm³) and water together fill the 100 cm³.
    expect(mix.a / 2.63 + mix.b).toBeCloseTo(100, 0);
    expect(mix.a + mix.b).toBeGreaterThan(150);
  });

  it('reads the old name for silicone', () => {
    expect(resolveCastMaterial('silicone')).toBe('platinum');
    expect(resolveCastMaterial('bronze')).toBe('bronze');
    expect(resolveCastMaterial('lava')).toBeNull();
  });
});

describe('warnings come from the data', () => {
  it('warns about a big epoxy pour dynamically by mold softening point and in silicone', () => {
    expect(castMaterial('epoxy').mixNote).toMatch(/1:1.*2:1/);
    expect(castMaterialWarnings('epoxy', 150, { pla: true })).toEqual([]);
    expect(castMaterialWarnings('epoxy', 150, { pla: false })).toEqual([]);
    expect(castMaterialWarnings('epoxy', 250, { pla: true })[0]).toMatch(/A 250 ml epoxy pour.*PLA's ~60 °C/);
    expect(castMaterialWarnings('epoxy', 250, { pla: true, softenC: 60, name: 'PETG + PVA' })[0]).toMatch(/PETG \+ PVA's ~60 °C/);

    // High-temp ABS + HIPS (95 °C) never claims PLA's ~60 °C softening point.
    const absNotes = castMaterialWarnings('epoxy', 250, { pla: true, softenC: 95, name: 'ABS + HIPS' });
    expect(absNotes).toHaveLength(1);
    expect(absNotes[0]).toMatch(/ABS \+ HIPS.*95 °C/);
    expect(absNotes[0]).not.toMatch(/PLA|60 °C/);

    // Thick/large pours in insulating silicone still warn about standard casting epoxy exotherm.
    const silNotes = castMaterialWarnings('epoxy', 250, { pla: false });
    expect(silNotes).toHaveLength(1);
    expect(silNotes[0]).toMatch(/250 ml.*deep-pour epoxy/i);
    expect(silNotes[0]).not.toMatch(/PLA/);
  });

  it('warns about polyurethane moisture foaming on water-soluble liners and fast exotherm on big pours', () => {
    expect(castMaterialWarnings('polyurethane', 50, { pla: true })).toEqual([]);
    expect(castMaterialWarnings('polyurethane', 50, { pla: false })).toEqual([]);
    const pvaNotes = castMaterialWarnings('polyurethane', 50, { pla: true, softenC: 60, name: 'PLA + PVA' });
    expect(pvaNotes).toHaveLength(1);
    expect(pvaNotes[0]).toMatch(/foams.*moisture.*PLA \+ PVA/i);
    const bvohNotes = castMaterialWarnings('polyurethane', 50, { pla: true, softenC: 60, name: 'PLA + BVOH' });
    expect(bvohNotes[0]).toMatch(/foams.*moisture/i);
    expect(castMaterialWarnings('polyurethane', 50, { pla: true, softenC: 95, name: 'ABS + HIPS' })).toEqual([]);
    expect(castMaterialWarnings('polyurethane', 200, { pla: true, softenC: 60, name: 'PLA' })[0]).toMatch(/200 ml polyurethane.*60 °C/);
  });

  it('warns about anything poured hotter than the printed mold takes', () => {
    expect(castMaterialWarnings('wax', 10, { pla: true })[0]).toMatch(/avoid softening a PLA mold/);
    expect(castMaterialWarnings('wax', 10, { pla: true, softenC: 95, name: 'ABS + HIPS' })).toEqual([]);
    expect(castMaterialWarnings('wax', 10, { pla: false })).toEqual([]);
    expect(castMaterialWarnings('chocolate', 10, { pla: true }).join(' ')).not.toMatch(/soften/);
  });

  it('carries the notes that apply in any mold', () => {
    expect(castMaterialWarnings('water', 10, { pla: false })).toEqual([]);
    expect(castMaterialWarnings('chocolate', 10, { pla: false })).toEqual([]);
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
