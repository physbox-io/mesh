// Hardware cuts: a nut trap, counterbore, insert hole, insert boss and bearing
// pocket, each a few ordinary cuts sharing a spot. The sizes come from the ISO
// tables in utils/hardwareCuts.ts; these check that the pieces read them, that
// a hex pocket is a hex, and that the cuts land where cutGeometry says.

import { describe, it, expect } from 'vitest';
import {
  HARDWARE_KINDS, HEX_NUTS, CLEARANCE_HOLES, COUNTERBORES, INSERTS, BEARINGS,
  hardwareCutGeoms, hardwareSpecOf, nextHardwareGroup, type HardwareCutSpec,
} from '../src/utils/hardwareCuts';
import { csgHashOf, cutGeometry, primitiveToScad } from '../src/utils/csg';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const spec = (over: Partial<HardwareCutSpec>): HardwareCutSpec => ({
  group: 'g1', kind: 'nut_trap', size: 'M3', at: [0, 0, 0.01], normal: [0, 0, 1], ...over,
});

const block = (geoms: SceneGeom[] = []): SceneNode => ({
  id: 'block', name: 'block', pos: [0, 0, 0], csgEnabled: true,
  geoms: [{ name: 'b', type: 'box', size: [0.02, 0.02, 0.01] } as SceneGeom, ...geoms],
} as SceneNode);

describe('hardware tables', () => {
  it('cover every size each kind offers', () => {
    for (const size of HARDWARE_KINDS.nut_trap.sizes) {
      expect(HEX_NUTS[size], size).toBeDefined();
      expect(CLEARANCE_HOLES[size], size).toBeDefined();
      expect(COUNTERBORES[size], size).toBeDefined();
    }
    for (const size of HARDWARE_KINDS.insert_boss.sizes) expect(INSERTS[size], size).toBeDefined();
    for (const size of HARDWARE_KINDS.bearing.sizes) expect(BEARINGS[size], size).toBeDefined();
  });

  it('runs bolts from M2 to M24, not just M3', () => {
    expect(HARDWARE_KINDS.nut_trap.sizes[0]).toBe('M2');
    expect(HARDWARE_KINDS.nut_trap.sizes.at(-1)).toBe('M24');
  });
});

describe('hardwareCutGeoms', () => {
  it('makes a nut trap a hex pocket over a clearance hole right through', () => {
    const [pocket, shank] = hardwareCutGeoms(spec({ size: 'M5', fitMm: 0 }), 'block');
    // M5: 8 mm across flats, so 8/√3 to the corners; 4.7 mm deep.
    expect(pocket.facets).toBe(6);
    expect(pocket.size![0]).toBeCloseTo(0.008 / Math.sqrt(3), 6);
    expect(pocket.cutDepth).toBeCloseTo(0.0047, 7);
    expect(shank.size![0]).toBeCloseTo(0.00275, 7);
    expect(shank.cutDepth).toBe(0);
    expect([pocket, shank].every((g) => g.csg === 'difference' && g.hardware?.group === 'g1')).toBe(true);
    // The hex survives to OpenSCAD.
    expect(primitiveToScad({ ...pocket, size: [pocket.size![0], 0.002] })).toContain('$fn=6');
  });

  it('adds the fit to the nut across its flats and to its depth', () => {
    const [pocket] = hardwareCutGeoms(spec({ size: 'M3', fitMm: 0.2 }), 'block');
    expect(pocket.size![0]).toBeCloseTo(0.0057 / Math.sqrt(3), 6);
    expect(pocket.cutDepth).toBeCloseTo(0.0026, 7);
  });

  it('puts a tapped shank under a counterbore when asked', () => {
    const [head, clear] = hardwareCutGeoms(spec({ kind: 'counterbore', size: 'M6' }), 'block');
    expect(head.size![0]).toBeCloseTo(0.0055, 7);
    expect(clear.size![0]).toBeCloseTo(0.0033, 7);
    expect(clear.thread).toBeUndefined();
    const [, tap] = hardwareCutGeoms(spec({ kind: 'counterbore', size: 'M6', bore: 'tapped' }), 'block');
    expect(tap.size![0]).toBeCloseTo(0.003, 7);
    expect(tap.thread?.pitch).toBeCloseTo(0.001, 7);
  });

  it('stands an insert boss up before the hole bored into it', () => {
    const [boss, bore] = hardwareCutGeoms(spec({ kind: 'insert_boss', size: 'M4' }), 'block');
    expect(boss.csg).toBe('union');
    expect(boss.rgba).toBeUndefined();
    expect(bore.csg).toBe('difference');
    expect(boss.size![0]).toBeCloseTo(0.005, 7);
    expect(bore.size![0]).toBeCloseTo(0.0028, 7);
  });

  it('leaves a ledge under a bearing\'s outer race', () => {
    const [pocket, shaft] = hardwareCutGeoms(spec({ kind: 'bearing', size: '608' }), 'block');
    expect(pocket.size![0] * 2000).toBeCloseTo(22, 6);
    // Between the races: bigger than the 8 mm bore, smaller than the 22 mm outside.
    expect(shaft.size![0] * 2000).toBeGreaterThan(8);
    expect(shaft.size![0] * 2000).toBeLessThan(22);
  });

  it('falls back to the default size for one the kind does not have', () => {
    const [bore] = hardwareCutGeoms(spec({ kind: 'insert', size: 'M24' }), 'block');
    expect(bore.hardware?.size).toBe('M3');
  });
});

describe('placing a feature', () => {
  it('bores an insert boss from the top of the boss, not the face under it', () => {
    const node = block();
    for (const piece of hardwareCutGeoms(spec({ kind: 'insert_boss', size: 'M3', at: [0, 0, 0] }), node.id)) {
      node.geoms.push(piece);
      Object.assign(piece, cutGeometry(node, piece)!);
    }
    const [, boss, bore] = node.geoms;
    // The block's top is z = 10 mm; the boss stands 5.7 mm on it.
    const bossTop = boss.pos![2] + boss.size![1];
    expect(bossTop).toBeGreaterThan(0.0156);
    // The hole's mouth is at the boss's top (and a little over, the overshoot).
    const boreTop = bore.pos![2] + bore.size![1];
    expect(boreTop).toBeGreaterThan(0.0157 - 1e-6);
    expect(bore.pos![2] - bore.size![1]).toBeCloseTo(0.0157 - 0.0057, 3);
  });

  it('reads its spec back, and rebuilds the hash when the size changes', () => {
    const node = block(hardwareCutGeoms(spec({ size: 'M3' }), 'block'));
    const read = hardwareSpecOf(node.geoms, 'g1')!;
    expect(read.kind).toBe('nut_trap');
    expect(read.size).toBe('M3');
    expect(read.fitMm).toBeCloseTo(0.2, 6);
    const bigger = block(hardwareCutGeoms({ ...read, size: 'M8' }, 'block'));
    expect(csgHashOf(bigger)).not.toBe(csgHashOf(node));
  });

  it('names a new group after the ones already there', () => {
    const node = block(hardwareCutGeoms(spec({ group: 'nut_trap1' }), 'block'));
    expect(nextHardwareGroup(node.geoms, 'nut_trap')).toBe('nut_trap2');
    expect(nextHardwareGroup(node.geoms, 'bearing')).toBe('bearing1');
  });
});
