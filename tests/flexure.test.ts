import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  HOWELL_PRBM_GAMMA,
  HOWELL_PRBM_K_THETA,
  allowedFlexureKindsForJoint,
  analyzeSceneFlexures,
  applyFlexureToNode,
  bendLeafPoint,
  bistableForce,
  buildCantileverPawl,
  buildCompliantGripper,
  buildMonolithicPrintNodes,
  buildParallelFlexureStage,
  evaluateCantileverBeam,
  evaluateFlexureSpec,
  evaluateParallelFlexure,
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

  it('computes second moment I, strain, safety factor, and targetDeflection over-stress warnings', () => {
    const safe = evaluateFlexureSpec(
      { kind: 'blade', filament: 'petg', thicknessMm: 0.8, lengthMm: 16, widthMm: 10, targetDeflection: 15 },
      'hinge',
    );
    // I = b * t^3 / 12 = 0.010 * (0.0008)^3 / 12 = 4.2667e-13 m^4
    expect(safe.secondMomentM4).toBeCloseTo((0.01 * 0.0008 ** 3) / 12, 16);
    expect(safe.yieldStrain).toBeCloseTo(48e6 / 2.1e9, 4);
    expect(safe.operating).toBeDefined();
    expect(safe.operating!.safetyFactor).toBeGreaterThan(1.4);
    expect(safe.safetyFactor).toBe(safe.operating!.safetyFactor);
    expect(safe.maxForceOrTorque).toBeGreaterThan(0);

    // Push well past PETG yield on a thick, short blade
    const overstressed = evaluateFlexureSpec(
      { kind: 'blade', filament: 'petg', thicknessMm: 2.0, lengthMm: 8, widthMm: 10, targetDeflection: 30 },
      'hinge',
    );
    expect(overstressed.operating!.safetyFactor).toBeLessThan(1.0);
    expect(overstressed.warnings.some((w) => w.includes('exceeds') && w.includes('yield'))).toBe(true);

    // TPU has much higher yield strain than PLA/PETG, so the same deflection is safe
    const tpu = evaluateFlexureSpec(
      { kind: 'blade', filament: 'tpu', thicknessMm: 2.0, lengthMm: 8, widthMm: 10, targetDeflection: 30 },
      'hinge',
    );
    expect(tpu.yieldStrain).toBeGreaterThan(overstressed.yieldStrain * 10);
    expect(tpu.operating!.safetyFactor).toBeGreaterThan(2.0);
  });

  it('targets a named joint on multi-joint bodies via jointName', () => {
    const multiJoint: SceneNode = {
      id: 'carriage',
      name: 'Carriage',
      pos: [0, 0, 0],
      geoms: [{ name: 'block', type: 'box', size: [0.01, 0.01, 0.01] }],
      joints: [
        { name: 'j_hinge', type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0] },
        { name: 'j_slide', type: 'slide', axis: [0, 1, 0], pos: [0, 0, 0] },
      ],
      children: [],
    };
    const res = applyFlexureToNode(multiJoint, { kind: 'serpentine', filament: 'petg', jointName: 'j_slide' });
    expect(res).not.toBeNull();
    expect(res!.node.joints[0].stiffness).toBeUndefined();
    expect(res!.node.joints[1].stiffness).toBeGreaterThan(0);
    expect(res!.node.flexure?.kind).toBe('serpentine');
  });

  it('evaluates and builds a Howell PRBM cantilever pawl / snap-latch', () => {
    const ev = evaluateCantileverBeam({
      filament: 'petg',
      thicknessMm: 1.0,
      lengthMm: 20,
      widthMm: 8,
      deflectionMm: 2.0,
      rampAngleDeg: 30,
      frictionCoeff: 0.2,
    });
    const E = 2.1e9;
    const I = (0.008 * 0.001 ** 3) / 12;
    expect(ev.tipStiffnessNm).toBeCloseTo((3 * E * I) / 0.02 ** 3, 2);
    expect(ev.prbmStiffnessNmRad).toBeCloseTo((HOWELL_PRBM_GAMMA * HOWELL_PRBM_K_THETA * E * I) / 0.02, 5);
    expect(ev.prbmPivotOffsetMm).toBeCloseTo(3.0, 2);
    expect(ev.engageForceN).toBeGreaterThan(ev.tipForceN * 0.5);
    expect(ev.safetyFactor).toBeGreaterThan(1.4);

    const pawl = buildCantileverPawl({
      filament: 'petg',
      thicknessMm: 1.0,
      lengthMm: 20,
      widthMm: 8,
      idPrefix: 'latch1',
    });
    expect(pawl.addedIds).toEqual(['latch1_base', 'latch1_arm']);
    const arm = pawl.nodes[0].children![0];
    expect(arm.joints[0].type).toBe('hinge');
    expect(arm.joints[0].stiffness).toBeCloseTo(ev.prbmStiffnessNmRad, 4);
    expect(arm.geoms.some((g) => g.name === 'flexure_cantilever' && g.role === 'visual' && Boolean(g.bend))).toBe(true);
  });

  it('evaluates and builds a parallel-guiding flexure stage with parasitic shift and N-beam stiffness', () => {
    const ev2 = evaluateParallelFlexure({
      filament: 'petg',
      thicknessMm: 0.8,
      lengthMm: 24,
      widthMm: 10,
      numBeams: 2,
      deflectionMm: 3.0,
    });
    const ev3 = evaluateParallelFlexure({
      filament: 'petg',
      thicknessMm: 0.8,
      lengthMm: 24,
      widthMm: 10,
      numBeams: 3,
      deflectionMm: 3.0,
    });
    // 3 parallel beams are 1.5x stiffer than 2 parallel beams with identical peak stress
    expect(ev3.totalStiffnessNm / ev2.totalStiffnessNm).toBeCloseTo(1.5, 3);
    expect(ev3.peakStressMPa).toBeCloseTo(ev2.peakStressMPa, 2);
    // Parasitic foreshortening = 3 * delta^2 / (5 * L) = 3 * 9 / (5 * 24) = 0.225 mm
    expect(ev2.parasiticShiftMm).toBeCloseTo(0.225, 3);

    const stage = buildParallelFlexureStage({
      filament: 'petg',
      thicknessMm: 0.8,
      lengthMm: 24,
      widthMm: 10,
      numBeams: 3,
      idPrefix: 'pstage',
    });
    const stageNode = stage.nodes[0].children![0];
    expect(stageNode.joints[0].type).toBe('slide');
    expect(stageNode.joints[0].stiffness).toBeCloseTo(ev3.totalStiffnessNm, 1);
    const leaves = stageNode.geoms.filter((g) => g.name.startsWith('flexure_parallel_'));
    expect(leaves.length).toBe(3);
    expect(leaves.every((g) => g.role === 'visual' && Boolean(g.bend))).toBe(true);
  });

  it('builds a 6-flexure compliant parallel-jaw gripper, audits it, and bridges PRBM to monolithic print geometry', () => {
    const gripper = buildCompliantGripper({
      filament: 'petg',
      jawOpeningMm: 24,
      beamThicknessMm: 0.8,
      beamLengthMm: 22,
      beamWidthMm: 10,
      beamsPerJaw: 3,
      idPrefix: 'grip6',
    });
    expect(gripper.totalFlexureCount).toBe(6);
    expect(gripper.addedIds).toEqual(['grip6_base', 'grip6_jaw_left', 'grip6_jaw_right']);
    expect(gripper.pinchForceAtStrokeN).toBeGreaterThan(0);
    expect(gripper.parasiticShiftMm).toBeGreaterThan(0);
    expect(gripper.evaluation.safetyFactor).toBeGreaterThanOrEqual(1.39);

    const [base] = gripper.nodes;
    expect(base.children?.length).toBe(2);
    for (const jaw of base.children!) {
      expect(jaw.joints[0].type).toBe('slide');
      expect(jaw.joints[0].stiffness).toBeCloseTo(gripper.evaluation.totalStiffnessNm, 1);
      const leaves = jaw.geoms.filter((g) => g.name.startsWith('flexure_parallel_'));
      expect(leaves.length).toBe(3);
    }

    // Scene flexure audit sees both compliant jaws and all 6 printable leaves
    const audit = analyzeSceneFlexures(gripper.nodes);
    expect(audit.flexureCount).toBe(2);
    expect(audit.totalLeafCount).toBe(6);
    expect(audit.minSafetyFactor).toBeGreaterThan(1.0);

    // PRBM -> Monolithic 3D-print bridge merges base + jaws + 6 leaves into one solid body
    const mono = buildMonolithicPrintNodes(gripper.nodes);
    expect(mono.length).toBe(1);
    expect(mono[0].children).toEqual([]);
    expect(mono[0].joints).toEqual([]);
    expect(mono[0].flexure).toBeUndefined();
    // Base palm (1) + 2 jaws * (body + bridge + pad + 3 leaves = 6) = 13 solid geoms
    expect(mono[0].geoms.length).toBe(13);
    // All promoted flexure leaves are now solid printable geometry (no visual role, no bend)
    const promotedLeaves = mono[0].geoms.filter((g) => g.name.includes('flexure_parallel_'));
    expect(promotedLeaves.length).toBe(6);
    expect(promotedLeaves.every((g) => g.role === undefined && g.bend === undefined)).toBe(true);
    // Original PRBM gripper was not mutated
    expect(gripper.nodes[0].children?.length).toBe(2);
  });

  it('connects every compliant gripper flexure beam to its jaw and palm with center clearance > 2 * strokeMm and 0 default wall warnings', () => {
    // Bare buildCompliantGripper() defaults to PETG with beamThicknessMm >= minWallMm (0 warnings)
    const bare = buildCompliantGripper();
    expect(bare.evaluation.filament).toBe('petg');
    expect(bare.evaluation.thicknessMm).toBeGreaterThanOrEqual(1.0);
    expect(bare.warnings.filter((w) => w.includes('minimum reliable two-perimeter wall'))).toEqual([]);
    expect(bare.warnings).toEqual([]);

    // No filament emits a wall-thickness warning with default beamThicknessMm
    for (const filament of ['pla', 'petg', 'abs', 'asa', 'tpu'] as const) {
      const g = buildCompliantGripper({ filament });
      expect(g.warnings.filter((w) => w.includes('minimum reliable two-perimeter wall'))).toEqual([]);
    }

    // Check beam-to-jaw, beam-to-palm connectivity and center clearance across beam counts
    for (const beamsPerJaw of [2, 3, 4, 5]) {
      const g = buildCompliantGripper({ beamsPerJaw });
      const base = g.nodes[0];
      const palm = base.geoms.find((gm) => gm.name === 'gripper_palm')!;
      const palmMinX = (palm.pos?.[0] ?? 0) - palm.size[0];
      const palmMaxX = (palm.pos?.[0] ?? 0) + palm.size[0];
      const palmMaxY = (palm.pos?.[1] ?? 0) + palm.size[1];

      const halfThick = (g.evaluation.thicknessMm / 1000) * 0.5;
      const strokeM = g.evaluation.deflectionMm / 1000;
      const leftJaw = base.children!.find((c) => c.id.endsWith('_jaw_left'))!;
      const rightJaw = base.children!.find((c) => c.id.endsWith('_jaw_right'))!;

      const jawInnerEdgeX = (jaw: SceneNode, side: -1 | 1) => {
        const jx = jaw.pos?.[0] ?? 0;
        const solidGeoms = jaw.geoms.filter((gm) => gm.role !== 'visual' && !gm.name.startsWith('flexure_'));
        if (side < 0) {
          return Math.max(...solidGeoms.map((gm) => jx + (gm.pos?.[0] ?? 0) + gm.size[0]));
        }
        return Math.min(...solidGeoms.map((gm) => jx + (gm.pos?.[0] ?? 0) - gm.size[0]));
      };

      // Center clearance between left and right jaws strictly exceeds 2 * strokeMm
      const centerClearanceM = jawInnerEdgeX(rightJaw, 1) - jawInnerEdgeX(leftJaw, -1);
      expect(centerClearanceM).toBeGreaterThan(2 * strokeM);

      for (const jaw of [leftJaw, rightJaw]) {
        const jx = jaw.pos?.[0] ?? 0;
        const jy = jaw.pos?.[1] ?? 0;
        const solidGeoms = jaw.geoms.filter((gm) => gm.role !== 'visual' && !gm.name.startsWith('flexure_'));
        const leaves = jaw.geoms.filter((gm) => gm.name.startsWith('flexure_parallel_'));
        expect(leaves.length).toBe(beamsPerJaw);

        for (const leaf of leaves) {
          const from = leaf.bend!.from;
          const to = leaf.bend!.to;
          // Base-frame coordinates of both leaf ends
          const fromBaseX = jx + from[0];
          const fromBaseY = jy + from[1];
          const toBaseX = jx + to[0];
          const toBaseY = jy + to[1];

          // Leaf root connects solidly into gripper_palm at Y = 0
          expect(fromBaseY).toBeCloseTo(palmMaxY, 5);
          expect(fromBaseX - halfThick).toBeGreaterThanOrEqual(palmMinX - 1e-6);
          expect(fromBaseX + halfThick).toBeLessThanOrEqual(palmMaxX + 1e-6);

          // Leaf tip connects solidly into at least one rigid jaw geom (body or bridge) at Y = +lengthMm
          const connectsToJaw = solidGeoms.some((gm) => {
            const gMinX = jx + (gm.pos?.[0] ?? 0) - gm.size[0];
            const gMaxX = jx + (gm.pos?.[0] ?? 0) + gm.size[0];
            const gMinY = jy + (gm.pos?.[1] ?? 0) - gm.size[1];
            const gMaxY = jy + (gm.pos?.[1] ?? 0) + gm.size[1];
            const xInside = toBaseX - halfThick >= gMinX - 1e-6 && toBaseX + halfThick <= gMaxX + 1e-6;
            const yTouches = toBaseY >= gMinY - 1e-5 && toBaseY <= gMaxY + 1e-5;
            return xInside && yTouches;
          });
          expect(connectsToJaw).toBe(true);
        }
      }
    }
  });
});
