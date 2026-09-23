import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  DEFORM_MATERIALS, deformMaterial, estimateBodyMass, geomVolume, materialUpdates, shatterFields,
} from '../src/utils/deformMaterials';

const cube = (half: number, extra: Partial<SceneNode['geoms'][number]> = {}): SceneNode => ({
  id: 'n', name: 'n', pos: [0, 0, 0], children: [],
  joints: [{ name: 'j', type: 'free' }],
  geoms: [{ name: 'g', type: 'box', size: [half, half, half], ...extra }],
} as unknown as SceneNode);

describe('deformMaterials', () => {
  it('weighs primitives by volume and density, and lets a stated mass win', () => {
    expect(geomVolume({ name: 'b', type: 'box', size: [0.05, 0.05, 0.05] })).toBeCloseTo(0.001);
    expect(estimateBodyMass(cube(0.05))).toBeCloseTo(1);             // a litre of water
    expect(estimateBodyMass(cube(0.05, { density: 2500 }))).toBeCloseTo(2.5);
    expect(estimateBodyMass(cube(0.05, { mass: 0.3, density: 2500 }))).toBeCloseTo(0.3);
  });

  it('ignores cutters and decoration', () => {
    const n = cube(0.05);
    n.geoms!.push({ name: 'cut', type: 'box', size: [1, 1, 1], csg: 'difference' });
    n.geoms!.push({ name: 'deco', type: 'box', size: [1, 1, 1], role: 'visual' });
    expect(estimateBodyMass(n)).toBeCloseTo(1);
  });

  it('scales the shatter threshold with the body, so a marble and a slab both break from the same drop', () => {
    const glass = deformMaterial('glass')!;
    const small = materialUpdates(cube(0.01), glass, { shatter: false, dent: false });
    const big = materialUpdates(cube(0.2), glass, { shatter: false, dent: false });
    const ratio = big.node.shatterImpulseNs! / small.node.shatterImpulseNs!;
    expect(ratio).toBeGreaterThan(1000);
    // The threshold is worked out from the NEW density, not water's.
    expect(big.node.shatterImpulseNs).toBeCloseTo(3 * 2500 * 0.064, 0);
  });

  it('turns on the natural behaviours when neither is on, and leaves the choice alone otherwise', () => {
    const glass = deformMaterial('glass')!;
    const steel = deformMaterial('steel')!;
    const plastic = deformMaterial('plastic')!;
    expect(materialUpdates(cube(0.05), glass, { shatter: false, dent: false })).toMatchObject({ shatter: true, dent: false });
    expect(materialUpdates(cube(0.05), steel, { shatter: false, dent: false })).toMatchObject({ shatter: false, dent: true });
    expect(materialUpdates(cube(0.05), plastic, { shatter: true, dent: true })).toMatchObject({ shatter: true, dent: true });
  });

  it('turns off what a material cannot do', () => {
    const steel = deformMaterial('steel')!;
    const r = materialUpdates(cube(0.05), steel, { shatter: true, dent: false });
    expect(r.shatter).toBe(false);
    expect('shatterImpulseNs' in r.node && r.node.shatterImpulseNs === undefined).toBe(true);
  });

  it('gives density only to geoms without a stated mass', () => {
    const r = materialUpdates(cube(0.05, { mass: 2 }), deformMaterial('steel')!, { shatter: false, dent: false });
    expect(r.geoms).toEqual({});
    const r2 = materialUpdates(cube(0.05), deformMaterial('steel')!, { shatter: false, dent: false });
    expect(r2.geoms).toEqual({ 0: { density: 7850 } });
  });

  it('never writes a zero threshold, which would mean unbreakable', () => {
    expect(shatterFields(deformMaterial('glass')!.shatter!, 0).shatterImpulseNs).toBeGreaterThan(0);
    expect(shatterFields(deformMaterial('glass')!.shatter!, 1e-6).shatterImpulseNs).toBeGreaterThan(0);
  });

  it('every material does at least one thing, and pierces well above where it dents', () => {
    for (const m of DEFORM_MATERIALS) {
      expect(m.shatter || m.dent).toBeTruthy();
      expect((m.natural.shatter && m.shatter) || (m.natural.dent && m.dent)).toBeTruthy();
      if (m.dent?.pierceNs) expect(m.dent.pierceNs).toBeGreaterThan(m.dent.yieldNs * 1.5);
    }
  });
});
