// The inspector's Mass for a geom weighed by its volume.
//
// The slider read `geom.mass ?? 0`, so a lattice arm the solver weighs at
// 64 g showed 0.00 kg, as does every sculpt and every primitive with no mass.

import { describe, it, expect } from 'vitest';
import { displayedGeomMass } from '../src/utils/geomMassDisplay';
import type { SceneNode } from '../src/types/scene';

const node = (geoms: SceneNode['geoms']): SceneNode =>
  ({ id: 'n', name: 'n', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms } as SceneNode);

describe('displayedGeomMass', () => {
  it('shows a stated mass as stated', () => {
    expect(displayedGeomMass(node([{ name: 'b', type: 'box', size: [0.1, 0.1, 0.1], mass: 2 }]), 0, 9))
      .toEqual({ kg: 2, computed: false, scope: 'geom' });
  });

  it('weighs a primitive by its volume and density', () => {
    const m = displayedGeomMass(node([{ name: 'b', type: 'box', size: [0.05, 0.05, 0.05], density: 700 }]), 0, null)!;
    expect(m.computed).toBe(true);
    expect(m.kg).toBeCloseTo(0.001 * 700, 9);
  });

  it("gives a mesh with no mass its body's compiled mass", () => {
    const n = node([
      { name: 'arm_mesh', type: 'mesh', size: [1], latticeGeom: true },
      { name: 'arm_piece0', type: 'mesh', size: [1], csgDerived: 'collider' },
    ]);
    expect(displayedGeomMass(n, 0, 0.064)).toEqual({ kg: 0.064, computed: true, scope: 'geom' });
    // Not compiled yet: nothing to show rather than a zero.
    expect(displayedGeomMass(n, 0, undefined)).toBeNull();
  });

  it('says when the figure is the whole body', () => {
    const n = node([
      { name: 'clay', type: 'mesh', size: [1] },
      { name: 'weight', type: 'box', size: [0.01, 0.01, 0.01], mass: 0.5 },
    ]);
    expect(displayedGeomMass(n, 0, 1.2)?.scope).toBe('body');
  });
});
