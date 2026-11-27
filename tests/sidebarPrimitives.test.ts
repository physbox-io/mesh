import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 };
});

import { createHingeNode } from '../src/utils/hardwareComponents';
import { useStore } from '../src/store/useStore';

describe('createHingeNode (Print-in-Place Knuckle Hinge)', () => {
  it('returns a 2-body articulated hinge with a real hinge joint on the moving leaf, valid geoms, and non-zero mass', () => {
    const hinge = createHingeNode();

    expect(hinge.type).toBe('body');
    expect(hinge.isHardwareComponent).toBe(true);
    expect(hinge.hardwareType).toBe('knuckle_hinge');
    expect(hinge.joints).toHaveLength(1);
    expect(hinge.joints[0].type).toBe('free');

    // Lies flat on the XY bed above the floor
    expect(hinge.pos[2]).toBeCloseTo(4 / 2000 + 0.01, 6);

    // 2-body structure: parent (fixed leaf + 3 knuckles + pin) + 1 child (moving leaf + 2 knuckles)
    expect(hinge.children).toHaveLength(1);
    const movingLeaf = hinge.children[0];
    expect(movingLeaf.id).toBe(`${hinge.id}_leaf_b`);
    expect(movingLeaf.pos).toEqual([0, 0, 0]);

    // Real MuJoCo hinge joint along Y
    expect(movingLeaf.joints).toHaveLength(1);
    const joint = movingLeaf.joints[0];
    expect(joint.type).toBe('hinge');
    expect(joint.axis).toEqual([0, 1, 0]);
    expect(joint.limited).toBe(true);
    expect(joint.range).toEqual([-180, 180]);
    expect(joint.damping).toBeCloseTo(0.004, 6);

    // Parent geoms: fixed leaf (-X), 3 knuckles (y = -2*segL, 0, +2*segL), captive pin
    expect(hinge.geoms).toHaveLength(5);
    const parentLeaf = hinge.geoms.find((g) => g.type === 'box');
    const parentCyls = hinge.geoms.filter((g) => g.type === 'cylinder');
    expect(parentLeaf).toBeDefined();
    expect(parentLeaf!.pos![0]).toBeLessThan(0);
    expect(parentCyls).toHaveLength(4);
    for (const c of parentCyls) {
      expect(c.euler).toEqual([90, 0, 0]);
      expect(c.size[0]).toBeGreaterThan(0);
      expect(c.size[1]).toBeGreaterThan(0);
    }

    // Moving leaf geoms: moving leaf (+X), 2 knuckles (y = -segL, +segL)
    expect(movingLeaf.geoms).toHaveLength(3);
    const childLeaf = movingLeaf.geoms.find((g) => g.type === 'box');
    const childCyls = movingLeaf.geoms.filter((g) => g.type === 'cylinder');
    expect(childLeaf).toBeDefined();
    expect(childLeaf!.pos![0]).toBeGreaterThan(0);
    expect(childCyls).toHaveLength(2);
    for (const c of childCyls) {
      expect(c.euler).toEqual([90, 0, 0]);
      expect(c.size[0]).toBeGreaterThan(0);
      expect(c.size[1]).toBeGreaterThan(0);
    }

    // Non-zero mass on both bodies (~0.012 kg total)
    const parentMass = hinge.geoms.reduce((acc, g) => acc + (g.mass ?? 0), 0);
    const childMass = movingLeaf.geoms.reduce((acc, g) => acc + (g.mass ?? 0), 0);
    expect(parentMass).toBeGreaterThan(0);
    expect(childMass).toBeGreaterThan(0);
    expect(parentMass + childMass).toBeCloseTo(0.012, 4);
  });

  it('scales dimensions cleanly when custom length, width, and thickness are passed', () => {
    const hinge = createHingeNode(60, 40, 5);
    expect(hinge.pos[2]).toBeCloseTo(5 / 2000 + 0.01, 6);
    const parentLeaf = hinge.geoms.find((g) => g.type === 'box')!;
    expect(parentLeaf.size[1]).toBeCloseTo(0.03, 6); // 60mm / 2
    expect(parentLeaf.size[2]).toBeCloseTo(0.0025, 6); // 5mm / 2
  });
});

describe('addComponent("tray") (Hollow Box / Tray primitive)', () => {
  it('creates a CSG-enabled hollow box with 3mm wall/floor clearance and top overshoot', () => {
    const recompileSpy = vi.spyOn(useStore.getState(), 'recompile').mockImplementation(() => {});
    try {
      const id = useStore.getState().addComponent('tray', [0, 0, 0]);
      const node = useStore.getState().sceneGraph.nodes.find((n) => n.id === id);

      expect(node).toBeDefined();
      expect(node!.csgEnabled).toBe(true);
      expect(node!.csgCollision).toBe('auto');
      expect(node!.csgMass).toBe(1);
      expect(node!.joints).toHaveLength(1);
      expect(node!.joints[0].type).toBe('free');

      expect(node!.geoms).toHaveLength(2);
      const [outer, cavity] = node!.geoms;

      expect(outer.type).toBe('box');
      expect(outer.csg).toBeUndefined();
      expect(outer.size).toEqual([0.05, 0.04, 0.02]);
      expect(outer.mass).toBe(1);
      expect(outer.condim).toBe(3);

      expect(cavity.type).toBe('box');
      expect(cavity.csg).toBe('difference');
      expect(cavity.size).toEqual([0.047, 0.037, 0.02]);
      expect(cavity.pos).toEqual([0, 0, 0.003]);

      // 3mm wall thickness in X and Y
      expect(outer.size[0] - cavity.size[0]).toBeCloseTo(0.003, 6);
      expect(outer.size[1] - cavity.size[1]).toBeCloseTo(0.003, 6);

      // 3mm floor thickness at the bottom
      const outerBottom = -outer.size[2];
      const cavityBottom = cavity.pos![2] - cavity.size[2];
      expect(cavityBottom - outerBottom).toBeCloseTo(0.003, 6);

      // 3mm overshoot at the top (no coincident top face)
      const outerTop = outer.size[2];
      const cavityTop = cavity.pos![2] + cavity.size[2];
      expect(cavityTop - outerTop).toBeCloseTo(0.003, 6);
    } finally {
      recompileSpy.mockRestore();
    }
  });
});
