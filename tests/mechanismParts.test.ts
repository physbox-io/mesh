import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { compileToMJCF } from '../src/utils/mjcf';
import {
  STANDARD_MODULES_MM,
  buildCamMechanism,
  buildCamProfile,
  buildFourBarLinkage,
  buildGt2BeltDrive,
  buildGt2PulleyNode,
  buildInvoluteGearNode,
  buildInvoluteGearProfile,
  buildInvoluteRackNode,
  buildInvoluteRackProfile,
  buildLeadscrewDrive,
  buildMeshingGearPair,
  buildRackAndPinionPair,
  fourBarMetrics,
  gt2PulleyMetrics,
  hasSelfIntersection,
  involuteGearMetrics,
  signedPolygonArea2,
  type CamProfileKind,
  type GearBoreKind,
} from '../src/utils/mechanismParts';

function assertWatertightGeom(renderVertices: number[] | undefined, faces: number[] | undefined) {
  expect(renderVertices).toBeDefined();
  expect(faces).toBeDefined();
  expect(renderVertices!.length).toBeGreaterThan(18);
  expect(faces!.length).toBeGreaterThan(12);
  const integrity = analyzeMesh(renderVertices!, faces!);
  expect(integrity).not.toBeNull();
  expect(integrity!.closed).toBe(true);
  expect(integrity!.consistentlyWound).toBe(true);
  expect(integrity!.boundaryEdges).toBe(0);
  expect(integrity!.nonManifoldEdges).toBe(0);
  expect(integrity!.volume).toBeGreaterThan(0);
}

describe('Manufacturable Mechanism & Transmission Synthesis (mechanismParts)', () => {
  describe('1. True Involute Spur Gears', () => {
    it('computes accurate ISO metric gear geometry across standard modules (1.0, 1.5, 2.0)', () => {
      expect(STANDARD_MODULES_MM).toContain(1.0);
      expect(STANDARD_MODULES_MM).toContain(1.5);
      expect(STANDARD_MODULES_MM).toContain(2.0);

      for (const m of [1.0, 1.5, 2.0] as const) {
        const z = 24;
        const metrics = involuteGearMetrics({ moduleMm: m, teeth: z, pressureAngleDeg: 20, backlashMm: 0.1 });
        expect(metrics.pitchDiameterMm).toBeCloseTo(m * z, 6);
        expect(metrics.pitchRadiusMm).toBeCloseTo((m * z) / 2, 6);
        expect(metrics.baseRadiusMm).toBeCloseTo(((m * z) / 2) * Math.cos((20 * Math.PI) / 180), 5);
        expect(metrics.addendumRadiusMm).toBeCloseTo((m * z) / 2 + m, 6);
        expect(metrics.rootRadiusMm).toBeCloseTo((m * z) / 2 - 1.25 * m, 6);
        expect(metrics.circularPitchMm).toBeCloseTo(Math.PI * m, 6);
        expect(metrics.contactRatio).toBeGreaterThan(1.4);
      }
    });

    it('generates watertight manifold gear meshes with round, d_shaft, hex, and bearing_608 bores', () => {
      const boreKinds: GearBoreKind[] = ['none', 'round', 'd_shaft', 'hex', 'bearing_608'];
      for (const boreKind of boreKinds) {
        const node = buildInvoluteGearNode({
          moduleMm: 2.0,
          teeth: 20,
          thicknessMm: 8,
          boreKind,
          boreDiameterMm: 5.0,
        });
        expect(node.teeth).toBe(20);
        expect(node.joints[0]?.type).toBe('hinge');
        expect(node.joints[0]?.axis).toEqual([0, 0, 1]);

        const meshGeom = node.geoms.find((g) => g.type === 'mesh');
        expect(meshGeom).toBeDefined();
        assertWatertightGeom(meshGeom!.renderVertices, meshGeom!.faces);
      }
    });

    it('places meshing gear pairs at exact center distance a = m(z1 + z2)/2 and couples at -z1/z2', () => {
      const pair = buildMeshingGearPair(
        { moduleMm: 1.5, teeth: 18, profileShift: 0 },
        { moduleMm: 1.5, teeth: 36, profileShift: 0 },
        { origin: [0, 0, 0.05], meshAngleDeg: 0 },
      );

      // a = 1.5 * (18 + 36) / 2 = 40.5 mm
      expect(pair.centerDistanceMm).toBeCloseTo(40.5, 5);
      expect(pair.gearRatio).toBeCloseTo(2.0, 5);
      expect(pair.coupleRatio).toBeCloseTo(-0.5, 5);

      const dx = pair.drivenNode.pos[0] - pair.driverNode.pos[0];
      const dy = pair.drivenNode.pos[1] - pair.driverNode.pos[1];
      expect(Math.hypot(dx, dy)).toBeCloseTo(0.0405, 6);
      expect(pair.drivenNode.coupleTargetId).toBe(pair.driverNode.id);
      expect(pair.drivenNode.coupleRatio).toBeCloseTo(-18 / 36, 6);

      const xml = compileToMJCF({ nodes: pair.nodes });
      expect(xml).toContain('explicit_coupling_1');
      expect(xml).toContain('polycoef="0 -0.5 0 0 0"');
    });

    it('prevents undercutting on low tooth count gears (z = 10) via profile shift without self-intersecting outlines', () => {
      const profile10 = buildInvoluteGearProfile({ moduleMm: 1.5, teeth: 10 });
      expect(profile10.metrics.profileShift).toBeGreaterThan(0.35);
      expect(signedPolygonArea2(profile10.outline)).toBeGreaterThan(0);
      expect(hasSelfIntersection(profile10.outline)).toBe(false);

      const lowPair = buildMeshingGearPair(
        { moduleMm: 1.5, teeth: 10 },
        { moduleMm: 1.5, teeth: 24 },
      );
      for (const n of lowPair.nodes) {
        const mesh = n.geoms.find((g) => g.type === 'mesh')!;
        assertWatertightGeom(mesh.renderVertices, mesh.faces);
      }
    });
  });

  describe('2. Involute Rack & Pinion', () => {
    it('builds a watertight linear trapezoidal rack and couples rack slide to pinion hinge by pitchRadiusMeters', () => {
      const rackProfile = buildInvoluteRackProfile({
        moduleMm: 2.0,
        teeth: 10,
        pressureAngleDeg: 20,
        baseHeightMm: 6,
      });
      expect(signedPolygonArea2(rackProfile.outline)).toBeGreaterThan(0);
      expect(hasSelfIntersection(rackProfile.outline)).toBe(false);

      const rackNode = buildInvoluteRackNode({ moduleMm: 2.0, teeth: 10 });
      const rackMesh = rackNode.geoms.find((g) => g.type === 'mesh')!;
      assertWatertightGeom(rackMesh.renderVertices, rackMesh.faces);

      const rp = buildRackAndPinionPair(
        { moduleMm: 1.5, teeth: 20, profileShift: 0 },
        { moduleMm: 1.5, teeth: 12 },
      );
      // Pitch radius = 1.5 * 20 / 2 = 15 mm = 0.015 m
      expect(rp.pitchRadiusMm).toBeCloseTo(15.0, 5);
      expect(rp.pitchRadiusM).toBeCloseTo(0.015, 6);
      expect(rp.rackNode.coupleTargetId).toBe(rp.pinionNode.id);
      expect(rp.rackNode.coupleRatio).toBeCloseTo(0.015, 6);
      expect(rp.rackNode.joints[0]?.type).toBe('slide');

      const xml = compileToMJCF({ nodes: rp.nodes });
      expect(xml).toContain('explicit_coupling_1');
      expect(xml).toContain('polycoef="0 0.015 0 0 0"');
    });
  });

  describe('3. GT2 Timing Belt Drive & T8 Leadscrew', () => {
    it('computes accurate GT2-2mm pulley diameters, closed belt lengths, and same-direction coupling ratios', () => {
      const m20 = gt2PulleyMetrics({ teeth: 20 });
      // d_p = 20 * 2 / π = 12.7324 mm
      expect(m20.pitchDiameterMm).toBeCloseTo(40 / Math.PI, 4);

      const pulleyNode = buildGt2PulleyNode({ teeth: 20, boreKind: 'd_shaft', boreDiameterMm: 5 });
      const pulleyMesh = pulleyNode.geoms.find((g) => g.type === 'mesh')!;
      assertWatertightGeom(pulleyMesh.renderVertices, pulleyMesh.faces);

      const drive = buildGt2BeltDrive({
        driverTeeth: 20,
        drivenTeeth: 40,
        centerDistanceMm: 60,
      });
      expect(drive.coupleRatio).toBeCloseTo(20 / 40, 6);
      expect(drive.reductionRatio).toBeCloseTo(2.0, 6);
      expect(drive.drivenNode.coupleTargetId).toBe(drive.driverNode.id);
      expect(drive.drivenNode.coupleRatio).toBeCloseTo(0.5, 6);

      // L ≈ 2*60 + (π/2)*(d1 + d2) + (d2 - d1)^2 / (4*60)
      const d1 = 40 / Math.PI;
      const d2 = 80 / Math.PI;
      const expectedBeltMm = 120 + (Math.PI / 2) * (d1 + d2) + ((d2 - d1) ** 2) / 240;
      expect(drive.beltLengthMm).toBeCloseTo(expectedBeltMm, 2);

      const beltMesh = drive.beltNode.geoms.find((g) => g.type === 'mesh')!;
      assertWatertightGeom(beltMesh.renderVertices, beltMesh.faces);
    });

    it('builds a T8 leadscrew and child nut carriage with exact (leadMm / 1000) / (2π) coupling ratio', () => {
      for (const leadMm of [2, 4, 8] as const) {
        const ls = buildLeadscrewDrive({ lengthMm: 200, leadMm, pitchMm: 2, diameterMm: 8 });
        const expectedRatio = (leadMm / 1000) / (2 * Math.PI);
        expect(ls.coupleRatio).toBeCloseTo(expectedRatio, 7);
        expect(ls.nutNode.coupleTargetId).toBe(ls.leadscrewNode.id);
        expect(ls.nutNode.coupleRatio).toBeCloseTo(expectedRatio, 7);
        expect(ls.leadscrewNode.children).toContain(ls.nutNode);

        const screwMesh = ls.leadscrewNode.geoms.find((g) => g.type === 'mesh')!;
        assertWatertightGeom(screwMesh.renderVertices, screwMesh.faces);
        const nutMesh = ls.nutNode.geoms.find((g) => g.type === 'mesh')!;
        assertWatertightGeom(nutMesh.renderVertices, nutMesh.faces);
      }
    });
  });

  describe('4. Cam & Follower + Planar Grashof 4-Bar Linkage', () => {
    it('generates watertight cams for all 4 profile types (eccentric, snail, heart, harmonic) with follower coupling', () => {
      const kinds: CamProfileKind[] = ['eccentric', 'snail', 'heart', 'harmonic'];
      for (const kind of kinds) {
        const profile = buildCamProfile({ kind, baseRadiusMm: 18, liftMm: 10 });
        expect(profile.displacementAtAngle(0)).toBeCloseTo(0, 3);
        expect(signedPolygonArea2(profile.outline)).toBeGreaterThan(0);
        expect(hasSelfIntersection(profile.outline)).toBe(false);

        const mech = buildCamMechanism({ kind, baseRadiusMm: 18, liftMm: 10 });
        expect(mech.followerNode.coupleTargetId).toBe(mech.camNode.id);
        expect(mech.followerNode.joints[0]?.type).toBe('slide');

        const camMesh = mech.camNode.geoms.find((g) => g.type === 'mesh')!;
        assertWatertightGeom(camMesh.renderVertices, camMesh.faces);
        const followerMesh = mech.followerNode.geoms.find((g) => g.type === 'mesh')!;
        assertWatertightGeom(followerMesh.renderVertices, followerMesh.faces);
      }
    });

    it('classifies Grashof 4-bar linkages accurately and synthesizes a 4-body closed loop with <connect> constraint', () => {
      // Crank-rocker: s = crank = 25, l = ground = 80, p = 70, q = 55 -> s + l = 105 <= p + q = 125
      const crankRocker = fourBarMetrics({ groundMm: 80, crankMm: 25, couplerMm: 70, rockerMm: 55 });
      expect(crankRocker.isGrashof).toBe(true);
      expect(crankRocker.classification).toBe('crank_rocker');
      expect(crankRocker.transmissionAngleMinDeg).toBeGreaterThan(25);
      expect(crankRocker.transmissionAngleMaxDeg).toBeLessThan(155);

      // Double-crank (drag link): s = ground = 25, l = coupler = 80, crank = 65, rocker = 60 -> 25+80=105 <= 125
      const doubleCrank = fourBarMetrics({ groundMm: 25, crankMm: 65, couplerMm: 80, rockerMm: 60 });
      expect(doubleCrank.classification).toBe('double_crank');

      // Non-Grashof triple rocker: s = 50, l = 90, p = 60, q = 65 -> s + l = 140 > p + q = 125
      const nonGrashof = fourBarMetrics({ groundMm: 90, crankMm: 50, couplerMm: 60, rockerMm: 65 });
      expect(nonGrashof.isGrashof).toBe(false);
      expect(nonGrashof.classification).toBe('non_grashof');

      // Invalid linkage (cannot close loop): l = 200 > 20 + 30 + 40
      const invalid = fourBarMetrics({ groundMm: 200, crankMm: 20, couplerMm: 30, rockerMm: 40 });
      expect(invalid.classification).toBe('invalid');
      expect(invalid.validAssembly).toBe(false);

      const linkage = buildFourBarLinkage({
        groundMm: 80,
        crankMm: 25,
        couplerMm: 70,
        rockerMm: 55,
        crankAngleDeg: 60,
      });
      expect(linkage.nodes).toHaveLength(4);
      expect(linkage.couplerNode.connectTargetId).toBe(linkage.rockerNode.id);
      expect(linkage.couplerNode.connectAnchor).toHaveLength(3);

      for (const linkNode of linkage.nodes) {
        const mesh = linkNode.geoms.find((g) => g.type === 'mesh')!;
        assertWatertightGeom(mesh.renderVertices, mesh.faces);
      }

      const xml = compileToMJCF({ nodes: linkage.nodes });
      expect(xml).toContain('connect_constraint_1');
    });
  });
});

describe('mechanism meshes move with their bodies', () => {
  // A mesh geom without `dynamic` is drawn from world-baked vertices, so a
  // gear moved off where it was built kept being drawn at the origin.
  it('every mesh geom of every family is on the dynamic render path', () => {
    const families = [
      buildMeshingGearPair().nodes,
      buildRackAndPinionPair().nodes,
      buildGt2BeltDrive().nodes,
      buildLeadscrewDrive().nodes,
      buildCamMechanism().nodes,
      buildFourBarLinkage().nodes,
    ];
    const meshes: { name: string; dynamic?: boolean }[] = [];
    const walk = (nodes: { geoms?: { type: string; name: string; dynamic?: boolean }[]; children?: unknown[] }[]) => {
      for (const n of nodes) {
        for (const g of n.geoms ?? []) if (g.type === 'mesh') meshes.push(g);
        walk((n.children ?? []) as typeof nodes);
      }
    };
    families.forEach((nodes) => walk(nodes));
    expect(meshes.length).toBeGreaterThan(6);
    expect(meshes.filter((g) => !g.dynamic).map((g) => g.name)).toEqual([]);
  });
});
