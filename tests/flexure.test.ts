import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  allowedFlexureKindsForJoint,
  applyFlexureToNode,
  bistableForce,
  evaluateFlexureSpec,
  revertFlexure,
} from '../src/utils/flexure';

describe('Monolithic Compliant Mechanisms (Flexures)', () => {
  it('scales rotational blade stiffness with t³ / L and flags PLA sustained-load creep', () => {
    const thinPetg = evaluateFlexureSpec(
      { kind: 'blade', filament: 'petg', thicknessMm: 0.8, lengthMm: 16, widthMm: 10 },
      'hinge',
    );
    const thickPetg = evaluateFlexureSpec(
      { kind: 'blade', filament: 'petg', thicknessMm: 1.6, lengthMm: 16, widthMm: 10 },
      'hinge',
    );
    // Doubling leaf thickness increases bending stiffness by 2³ = 8x and halves safe travel
    expect(thickPetg.spec.stiffness / thinPetg.spec.stiffness).toBeCloseTo(8, 2);
    expect(thinPetg.spec.maxTravel / thickPetg.spec.maxTravel).toBeCloseTo(2, 2);
    expect(thinPetg.warnings.some((w) => w.includes('PLA'))).toBe(false);

    const pla = evaluateFlexureSpec(
      { kind: 'blade', filament: 'pla', thicknessMm: 0.8, lengthMm: 16, widthMm: 10 },
      'hinge',
    );
    expect(pla.warnings.some((w) => w.includes('PLA'))).toBe(true);
  });

  it('models a symmetric bistable Von Mises toggle with two stable equilibria and an unstable midpoint', () => {
    const evalRes = evaluateFlexureSpec(
      { kind: 'bistable', filament: 'petg', thicknessMm: 0.8, lengthMm: 18, widthMm: 8, archRiseMm: 2.6 },
      'slide',
    );
    const { spec, snapForceN } = evalRes;
    expect(snapForceN).toBeGreaterThan(0.1);

    const h0 = (spec.archRiseMm ?? 2.6) / 1000;
    // Exact equilibria at q = 0 (first latched state), q = h0 (unstable snap-through apex), q = 2*h0 (second latched state)
    expect(bistableForce(0, spec)).toBeCloseTo(0, 8);
    expect(bistableForce(h0, spec)).toBeCloseTo(0, 8);
    expect(bistableForce(2 * h0, spec)).toBeCloseTo(0, 8);

    // Restoring toward q = 0 for small positive displacement (0 < q < h0 -> force < 0)
    expect(bistableForce(0.4 * h0, spec)).toBeLessThan(0);
    // Snapping forward toward q = 2*h0 past midpoint (h0 < q < 2*h0 -> force > 0)
    expect(bistableForce(1.6 * h0, spec)).toBeGreaterThan(0);
    // Restoring back toward q = 2*h0 when pushed beyond 2*h0 (q > 2*h0 -> force < 0)
    expect(bistableForce(2.3 * h0, spec)).toBeLessThan(0);
  });

  it('converts hinge and slide joints into printable visual flexure geoms and cleanly reverts', () => {
    expect(allowedFlexureKindsForJoint('hinge')).toEqual(['blade', 'cross_pivot']);
    expect(allowedFlexureKindsForJoint('slide')).toEqual(['serpentine', 'bistable']);

    const hinged: SceneNode = {
      id: 'lid',
      name: 'Enclosure Lid',
      pos: [0, 0, 0.02],
      geoms: [{ name: 'plate', type: 'box', size: [0.03, 0.02, 0.003] }],
      joints: [{ name: 'lid_hinge', type: 'hinge', axis: [0, 1, 0], pos: [-0.03, 0, 0] }],
      children: [],
    };

    const cross = applyFlexureToNode(hinged, { kind: 'cross_pivot', filament: 'petg', thicknessMm: 0.8, lengthMm: 14 });
    expect(cross).not.toBeNull();
    const flexGeoms = cross!.node.geoms.filter((g) => g.name.startsWith('flexure_'));
    expect(flexGeoms.length).toBe(2); // ±45° crossed strips
    // Visual role ensures STL/3MF export includes the flexure leaves while MuJoCo skips self-collision jamming
    expect(flexGeoms.every((g) => g.role === 'visual')).toBe(true);
    expect(cross!.node.joints[0].stiffness).toBeGreaterThan(0);
    expect(cross!.node.joints[0].limited).toBe(true);

    const reverted = revertFlexure(cross!.node);
    expect(reverted.flexure).toBeUndefined();
    expect(reverted.geoms.some((g) => g.name.startsWith('flexure_'))).toBe(false);
    expect(reverted.joints[0].stiffness).toBe(0);
  });
});
