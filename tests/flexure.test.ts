import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  allowedFlexureKindsForJoint,
  applyFlexureToNode,
  bendLeafPoint,
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

  it('draws each leaf held by the frame at one end and following the joint at the other', () => {
    const slider: SceneNode = {
      id: 'stage', name: 'Stage', pos: [0, 0, 0],
      geoms: [{ name: 'table', type: 'box', size: [0.01, 0.015, 0.008] }],
      joints: [{ name: 'slide', type: 'slide', axis: [0, 1, 0], pos: [0, 0, 0] }],
      children: [],
    };
    const q = 0.004;
    for (const kind of ['serpentine', 'bistable'] as const) {
      const node = applyFlexureToNode(slider, { kind, folds: 3 })!.node;
      const joint = node.joints[0];
      const leaves = node.geoms.filter((g) => g.bend);
      expect(leaves.length).toBeGreaterThan(0);
      for (const g of leaves) {
        const bend = g.bend!;
        const from = bend.from as [number, number, number];
        const to = bend.to as [number, number, number];
        // In the body frame, which carries all of q: share 1 stays, share 0 is taken back by q.
        const a = bendLeafPoint(from, bend, joint, q);
        const b = bendLeafPoint(to, bend, joint, q);
        expect(a[1]).toBeCloseTo(from[1] - (1 - bend.w0) * q, 9);
        expect(b[1]).toBeCloseTo(to[1] - (1 - bend.w1) * q, 9);
      }
      // Leaves start at the body's faces (10 mm out along x), not inside it.
      const reach = Math.min(...leaves.map((g) => Math.min(Math.abs(g.bend!.from[0]), Math.abs(g.bend!.to[0]))));
      expect(reach).toBeGreaterThanOrEqual(0.01 - 1e-9);
    }
    // Bistable: the frame end sits h0 ahead along the slide, so q = 2·h0 mirrors the arch.
    const bi = applyFlexureToNode(slider, { kind: 'bistable', archRiseMm: 3 })!.node;
    for (const g of bi.geoms.filter((x) => x.bend)) {
      expect(g.bend!.from[1] - g.bend!.to[1]).toBeCloseTo(0.003, 9);
    }

    // Hinge: the frame end comes back to where it was at rest in the parent's frame.
    const arm: SceneNode = {
      id: 'arm', name: 'Arm', pos: [0, 0, 0.1],
      geoms: [{ name: 'stem', type: 'box', size: [0.004, 0.004, 0.03], pos: [0, 0, -0.035] }],
      joints: [{ name: 'pivot', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0] }],
      children: [],
    };
    const cross = applyFlexureToNode(arm, { kind: 'cross_pivot' })!.node;
    for (const g of cross.geoms.filter((x) => x.bend)) {
      // Anchored above the pivot, away from the arm that hangs below it.
      expect(g.bend!.from[2]).toBeGreaterThan(0);
      expect(g.bend!.to[2]).toBeLessThan(0);
      const theta = 0.3;
      const p = bendLeafPoint(g.bend!.from as [number, number, number], g.bend!, cross.joints[0], theta);
      // Rotating the body frame by +theta about y puts it back at rest.
      const c = Math.cos(theta), s = Math.sin(theta);
      expect(c * p[0] + s * p[2]).toBeCloseTo(g.bend!.from[0], 9);
      expect(-s * p[0] + c * p[2]).toBeCloseTo(g.bend!.from[2], 9);
    }
  });

  it('anchors a hinge flexure opposite the mass-weighted centre, children included', () => {
    // A balance beam: a heavy counterweight one side, a pan hung from a child body the other.
    const beam: SceneNode = {
      id: 'beam', name: 'Beam', pos: [0, 0, 0.1],
      geoms: [
        { name: 'hub', type: 'box', size: [0.007, 0.006, 0.0025], pos: [0, 0, -0.0065], mass: 0.001 },
        { name: 'bar', type: 'box', size: [0.05, 0.003, 0.0025], pos: [0, 0, -0.0115], mass: 0.003 },
        { name: 'counterweight', type: 'box', size: [0.006, 0.006, 0.006], pos: [-0.045, 0, -0.0115], mass: (0.006 * 0.05) / 0.045 },
      ],
      joints: [{ name: 'pivot', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0] }],
      children: [{
        id: 'pan', name: 'Pan', pos: [0.05, 0, -0.0115],
        geoms: [{ name: 'dish', type: 'box', size: [0.017, 0.017, 0.0015], pos: [0, 0, -0.04], mass: 0.006 }],
        joints: [{ name: 'stirrup', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0] }],
        children: [],
      }],
    };
    const leaves = applyFlexureToNode(beam, { kind: 'cross_pivot' })!.node.geoms.filter((g) => g.bend);
    expect(leaves.length).toBe(2);
    for (const g of leaves) {
      const [fx, , fz] = g.bend!.from;
      const [tx, , tz] = g.bend!.to;
      // Frame end straight above, body end straight below, each leaf at 45°.
      expect(fz).toBeGreaterThan(0);
      expect(tz).toBeLessThan(0);
      expect(Math.abs(fx)).toBeCloseTo(Math.abs(fz), 6);
      expect(Math.abs(tx)).toBeCloseTo(Math.abs(tz), 6);
    }
  });
});
