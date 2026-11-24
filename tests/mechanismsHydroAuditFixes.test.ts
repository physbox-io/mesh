import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SceneNode } from '../src/types/scene';
import {
  buildGt2BeltDrive,
  buildLeadscrewDrive,
  fourBarMetrics,
} from '../src/utils/mechanismParts';
import {
  buildHydroBodyModel,
  collectWaterBasins,
  evaluateSubmerged,
  integrateSubmergedTris,
  measureContainerBasin,
  meshVolumeAndCentroid,
  resolveWaterSurfaceAt,
} from '../src/utils/hydrostatics';
import { createDShaftHubNode } from '../src/utils/hardwareComponents';
import { visiblePulleyRopeMarkers } from '../src/utils/pulleyRope';
import { restPoses } from '../src/utils/sceneCouplings';
import { gearBody } from '../src/utils/gearMeshing';
import { applyFlexureToNode, revertFlexure } from '../src/utils/flexure';

const ROOT = path.resolve(__dirname, '..');

describe('Section 4C Audit Fixes — Hardware, Mechanisms, Flexures & Hydrodynamics', () => {
  // -------------------------------------------------------------------------
  // P1 #1: GT2 belt tangent angle β wraps larger pulley by π + 2β, smaller by π - 2β
  // -------------------------------------------------------------------------
  describe('P1 #1: GT2 belt loop external tangent geometry', () => {
    it('never slices through the larger pulley whether driven or driver is larger', () => {
      for (const [driverTeeth, drivenTeeth] of [[16, 48], [48, 16]] as const) {
        const res = buildGt2BeltDrive({
          driverTeeth,
          drivenTeeth,
          centerDistanceMm: 80,
          beltWidthMm: 6,
          origin: [0, 0, 0],
        });
        const beltGeom = res.beltNode.geoms[0];
        const verts = beltGeom.renderVertices!;
        expect(verts.length).toBeGreaterThan(0);

        const r1M = res.driverMetrics.pitchRadiusMm / 1000;
        const r2M = res.drivenMetrics.pitchRadiusMm / 1000;
        const cM = res.centerDistanceMm / 1000;
        const halfBeltThickM = 1.38 / 2 / 1000;

        // Every belt vertex must stay at or outside both pulleys' inner belt pitch radii
        let minDistDriver = Infinity;
        let minDistDriven = Infinity;
        for (let i = 0; i < verts.length; i += 3) {
          const x = verts[i];
          const y = verts[i + 1];
          const d1 = Math.hypot(x, y);
          const d2 = Math.hypot(x - cM, y);
          if (d1 < minDistDriver) minDistDriver = d1;
          if (d2 < minDistDriven) minDistDriven = d2;
        }

        // With the inverted-beta bug, the belt span sliced deep into the larger pulley
        // (min distance ~3-4 mm inside r_large - halfBeltThick).
        expect(minDistDriver).toBeGreaterThanOrEqual(r1M - halfBeltThickM - 2e-4);
        expect(minDistDriven).toBeGreaterThanOrEqual(r2M - halfBeltThickM - 2e-4);

        // Signed volume of the belt prism must be strictly positive (watertight, non-inverted)
        const { volume } = meshVolumeAndCentroid(verts, beltGeom.faces!);
        expect(volume).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // P1 #2: Open-vessel CoB exact moment weights (no solid-volume double-counting)
  // -------------------------------------------------------------------------
  describe('P1 #2: Open-vessel CoB moment weighting', () => {
    function makeOpenBoxVessel(): SceneNode {
      // 100×100×80 mm open-top box with thick 16 mm floor and thin 4 mm walls
      // so solid.cob.z is much lower than hull.cob.z
      return {
        id: 'vessel_box',
        name: 'Open Box Vessel',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [
          { name: 'floor', type: 'box', pos: [0, 0, 0.008], size: [0.05, 0.05, 0.008] },
          { name: 'w_nx', type: 'box', pos: [-0.048, 0, 0.048], size: [0.002, 0.05, 0.032] },
          { name: 'w_px', type: 'box', pos: [0.048, 0, 0.048], size: [0.002, 0.05, 0.032] },
          { name: 'w_ny', type: 'box', pos: [0, -0.048, 0.048], size: [0.046, 0.002, 0.032] },
          { name: 'w_py', type: 'box', pos: [0, 0.048, 0.048], size: [0.046, 0.002, 0.032] },
        ],
        joints: [],
        children: [],
      };
    }

    it('matches hull.cob at flooded=0, solid.cob at flooded=1, and exact linear moment weights in between', () => {
      const node = makeOpenBoxVessel();
      const hydro = buildHydroBodyModel(node)!;
      expect(hydro?.vessel).toBeDefined();

      const pos = [0, 0, 0];
      const eye = [1, 0, 0, 0, 1, 0, 0, 0, 1];

      // 1. Unflooded (waterline at z = 0.05, well below rim at z = 0.08)
      const wlDry = 0.05;
      const subDry = evaluateSubmerged(hydro, pos, eye, wlDry);
      const hullDry = integrateSubmergedTris(hydro.vessel!.hullTris, pos, eye, wlDry);
      const solidDry = integrateSubmergedTris(hydro.solidTris, pos, eye, wlDry);
      expect(subDry.floodedFraction).toBe(0);
      expect(hullDry.cob[2]).toBeGreaterThan(solidDry.cob[2] + 0.003);
      expect(subDry.cob[0]).toBeCloseTo(hullDry.cob[0], 9);
      expect(subDry.cob[1]).toBeCloseTo(hullDry.cob[1], 9);
      expect(subDry.cob[2]).toBeCloseTo(hullDry.cob[2], 9);

      // 2. Partially flooded (waterline inside spillBandM above rim at z = 0.08)
      const wlMid = 0.08 + hydro.vessel!.spillBandM * 0.4;
      const subMid = evaluateSubmerged(hydro, pos, eye, wlMid);
      const hullMid = integrateSubmergedTris(hydro.vessel!.hullTris, pos, eye, wlMid);
      const solidMid = integrateSubmergedTris(hydro.solidTris, pos, eye, wlMid);
      expect(subMid.floodedFraction).toBeGreaterThan(0.1);
      expect(subMid.floodedFraction).toBeLessThan(0.9);
      const f = subMid.floodedFraction;
      const expectedVol = f * solidMid.volume + (1 - f) * hullMid.volume;
      const expectedCobZ =
        (f * solidMid.volume * solidMid.cob[2] + (1 - f) * hullMid.volume * hullMid.cob[2]) /
        expectedVol;
      expect(subMid.volume).toBeCloseTo(expectedVol, 10);
      expect(subMid.cob[2]).toBeCloseTo(expectedCobZ, 9);

      // 3. Fully flooded
      const wlFull = 0.08 + hydro.vessel!.spillBandM * 2;
      const subFull = evaluateSubmerged(hydro, pos, eye, wlFull);
      const solidFull = integrateSubmergedTris(hydro.solidTris, pos, eye, wlFull);
      expect(subFull.floodedFraction).toBe(1);
      expect(subFull.cob[2]).toBeCloseTo(solidFull.cob[2], 9);
    });
  });

  // -------------------------------------------------------------------------
  // P1 #3: PulleyWheelCard bench-scale slider bounds
  // -------------------------------------------------------------------------
  describe('P1 #3: PulleyWheelCard bench-scale slider bounds', () => {
    it('uses bench-scale radius bounds (10 mm – 500 mm, step 5 mm, fallback 50 mm)', () => {
      const src = fs.readFileSync(
        path.join(ROOT, 'src/components/inspector/PulleyWheelCard.tsx'),
        'utf8',
      );
      expect(src).toContain('min={0.01}');
      expect(src).toContain('max={0.5}');
      expect(src).toContain('min="0.01"');
      expect(src).toContain('max="0.5"');
      expect(src).toContain('step="0.005"');
      expect(src).toContain('node.pulleyRadius || 0.05');
      expect(src).not.toContain('min={0.15}');
      expect(src).not.toContain('min="0.15"');
    });
  });

  // -------------------------------------------------------------------------
  // P1 #4: buildLeadscrewDrive scales nut radii from boreR
  // -------------------------------------------------------------------------
  describe('P1 #4: buildLeadscrewDrive nut mesh validity across diameters', () => {
    it('preserves exact T8 dimensions at diameterMm=8 and produces positive-volume meshes for diameterMm >= 10', () => {
      const t8 = buildLeadscrewDrive({ diameterMm: 8 });
      const t8Col = t8.nutNode.geoms.find((g) => g.role === 'collision')!;
      expect(t8Col.size![0]).toBeCloseTo(0.011, 6); // 11 mm exact T8 flangeR

      for (const diameterMm of [6, 8, 10, 12, 16, 20]) {
        const res = buildLeadscrewDrive({ diameterMm });
        const flange = res.nutNode.geoms.find((g) => g.name.endsWith('_flange'))!;
        const barrel = res.nutNode.geoms.find((g) => g.name.endsWith('_barrel'))!;
        const flangeVol = meshVolumeAndCentroid(flange.renderVertices!, flange.faces!).volume;
        const barrelVol = meshVolumeAndCentroid(barrel.renderVertices!, barrel.faces!).volume;
        expect(flangeVol, `flange volume for T${diameterMm}`).toBeGreaterThan(0);
        expect(barrelVol, `barrel volume for T${diameterMm}`).toBeGreaterThan(0);

        // Barrel outer radius must exceed bore radius
        let barrelMaxR = 0;
        const bv = barrel.renderVertices!;
        for (let i = 0; i < bv.length; i += 3) {
          barrelMaxR = Math.max(barrelMaxR, Math.hypot(bv[i], bv[i + 1]));
        }
        const boreRM = (diameterMm / 2 + 0.1) / 1000;
        expect(barrelMaxR).toBeGreaterThan(boreRM + 0.0008);
      }
    });
  });

  // -------------------------------------------------------------------------
  // P2 #5 & P3 #11: MechanismBuilderModal 4-bar blocking, bore controls, pitch clamp
  // -------------------------------------------------------------------------
  describe('P2 #5 & P3 #11: MechanismBuilderModal validation, bore controls & pitch clamp', () => {
    it('flags invalid 4-bar linkages via fourBarMetrics and blocks insert in modal', () => {
      const invalid = fourBarMetrics({
        groundMm: 200,
        crankMm: 20,
        couplerMm: 20,
        rockerMm: 20,
        crankAngleDeg: 0,
      });
      expect(invalid.validAssembly).toBe(false);

      const src = fs.readFileSync(
        path.join(ROOT, 'src/components/MechanismBuilderModal.tsx'),
        'utf8',
      );
      // Finding 5a: four_bar sets blocked: !fb.validAssembly and preview preserves it
      expect(src).toContain('blocked: !fb.validAssembly');
      expect(src).toContain('if (preview.blocked) return;');

      // Finding 5b: bore controls appear on gear_pair, rack_pinion, and cam_follower (3 times)
      const boreSelectMatches = src.match(/setBoreKind\(e\.target\.value as GearBoreKind\)/g) ?? [];
      expect(boreSelectMatches.length).toBeGreaterThanOrEqual(3);

      // Finding 11: leadscrew preview clamps screwPitchMm before dividing
      expect(src).toContain('Math.max(1, screwPitchMm || 1)');
    });
  });

  // -------------------------------------------------------------------------
  // P2 #6: createDShaftHubNode outerR matches OpenSCAD script
  // -------------------------------------------------------------------------
  describe('P2 #6: createDShaftHubNode cylinder outerR matches SCAD', () => {
    it('sets cylinder geom radius to (shaftDiameterMm / 2 + 5.0) / 1000', () => {
      for (const shaftDiameterMm of [5, 6, 8]) {
        const hub = createDShaftHubNode(shaftDiameterMm);
        const expectedR = (shaftDiameterMm / 2 + 5.0) / 1000;
        expect(hub.geoms[0].size![0]).toBeCloseTo(expectedR, 9);
        expect(hub.scad).toContain(`cylinder(r = ${shaftDiameterMm / 2 + 5.0},`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // P2 #7: Water basin detection & world placement with rotations and parent transforms
  // -------------------------------------------------------------------------
  describe('P2 #7: Water basin orientation & parent transform propagation', () => {
    function makeRotatedWallTank(id: string, pos: [number, number, number], euler?: [number, number, number]): SceneNode {
      // 200×120×100 mm tank where the ±X walls are authored along X and rotated 90° around Z
      return {
        id,
        name: 'Tank',
        type: 'body',
        pos,
        ...(euler ? { euler } : {}),
        waterFill: 0.5,
        geoms: [
          { name: 'floor', type: 'box', pos: [0, 0, 0.005], size: [0.1, 0.06, 0.005] },
          { name: 'wall_ny', type: 'box', pos: [0, -0.055, 0.05], size: [0.1, 0.005, 0.05] },
          { name: 'wall_py', type: 'box', pos: [0, 0.055, 0.05], size: [0.1, 0.005, 0.05] },
          // Rotated 90° around Z: local size [0.06, 0.005, 0.05] becomes world half-extents [0.005, 0.06, 0.05]
          { name: 'wall_nx', type: 'box', pos: [-0.095, 0, 0.05], size: [0.06, 0.005, 0.05], euler: [0, 0, 90] },
          { name: 'wall_px', type: 'box', pos: [0.095, 0, 0.05], size: [0.06, 0.005, 0.05], euler: [0, 0, 90] },
        ],
        joints: [],
        children: [],
      };
    }

    it('accounts for box wall orientation in measureContainerBasin', () => {
      const tank = makeRotatedWallTank('tank_rot_walls', [0, 0, 0]);
      const local = measureContainerBasin(tank);
      expect(local).not.toBeNull();
      expect(local!.shape).toBe('box');
      expect(local!.minX).toBeCloseTo(-0.09, 4);
      expect(local!.maxX).toBeCloseTo(0.09, 4);
      expect(local!.minY).toBeCloseTo(-0.05, 4);
      expect(local!.maxY).toBeCloseTo(0.05, 4);
      expect(local!.floorZ).toBeCloseTo(0.01, 4);
      expect(local!.rimZ).toBeCloseTo(0.1, 4);
    });

    it('propagates parent translation & rotation in collectWaterBasins and resolveWaterSurfaceAt', () => {
      // Parent at (1, 0, 0.2) rotated +90° around Z.
      // Child tank at local (0.5, 0, 0) -> world (1, 0.5, 0.2), with local X/Y swapped by 90° yaw:
      // world X span = [1 - 0.05, 1 + 0.05], world Y span = [0.5 - 0.09, 0.5 + 0.09],
      // world floorZ = 0.21, rimZ = 0.30, surfaceZ = 0.255.
      const tank = makeRotatedWallTank('child_tank', [0.5, 0, 0]);
      const parent: SceneNode = {
        id: 'platform',
        name: 'Platform',
        type: 'body',
        pos: [1, 0, 0.2],
        euler: [0, 0, 90],
        geoms: [],
        joints: [],
        children: [tank],
      };

      // A second distractor tank at the origin with a very different surfaceZ
      const otherTank = makeRotatedWallTank('other_tank', [0, 0, 2.0]);

      // Target body nested under a translated+rotated parent so its world XY is (1.0, 0.52) -> inside child_tank!
      // Its raw local pos is [0.52, 0, 0] which is NOT inside child_tank if parent transform were ignored.
      const floater: SceneNode = {
        id: 'floater',
        name: 'Floater',
        type: 'body',
        pos: [0.52, 0, 0.05],
        geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01] }],
        joints: [],
        children: [],
      };
      const floaterCarrier: SceneNode = {
        id: 'carrier',
        name: 'Carrier',
        type: 'body',
        pos: [1, 0, 0.2],
        euler: [0, 0, 90],
        geoms: [],
        joints: [],
        children: [floater],
      };

      const nodes = [otherTank, parent, floaterCarrier];
      const basins = collectWaterBasins(nodes);
      const childBasin = basins.find((b) => b.containerNodeId === 'child_tank')!;
      expect(childBasin).toBeDefined();
      expect(childBasin.minX).toBeCloseTo(0.95, 4);
      expect(childBasin.maxX).toBeCloseTo(1.05, 4);
      expect(childBasin.minY).toBeCloseTo(0.41, 4);
      expect(childBasin.maxY).toBeCloseTo(0.59, 4);
      expect(childBasin.surfaceZ).toBeCloseTo(0.255, 4);

      const resolved = resolveWaterSurfaceAt(nodes, floater, -999);
      expect(resolved).toBeCloseTo(0.255, 4);
    });
  });

  // -------------------------------------------------------------------------
  // P2 #8: PulleyRopeMarkers respects hiddenNodeIds and parent transforms
  // -------------------------------------------------------------------------
  describe('P2 #8: PulleyRopeMarkers visibility & parent rest-pose transforms', () => {
    it('filters hidden ropes and hidden ancestors, and computes worldPos via restPoses', () => {
      const ropeVisible: SceneNode = {
        id: 'rope_vis',
        name: 'Visible Rope',
        type: 'body',
        isPulleyRope: true,
        pos: [0.2, 0, 0.1],
        geoms: [],
        joints: [],
        children: [],
      };
      const ropeSelfHidden: SceneNode = {
        id: 'rope_hidden',
        name: 'Hidden Rope',
        type: 'body',
        isPulleyRope: true,
        pos: [0, 0, 0],
        geoms: [],
        joints: [],
        children: [],
      };
      const ropeUnderHiddenParent: SceneNode = {
        id: 'rope_child_hidden',
        name: 'Child Hidden Rope',
        type: 'body',
        isPulleyRope: true,
        pos: [0, 0, 0],
        geoms: [],
        joints: [],
        children: [],
      };

      const rotatedParent: SceneNode = {
        id: 'stand',
        name: 'Stand',
        type: 'body',
        pos: [1.0, 2.0, 0.5],
        euler: [0, 0, 90], // +90° Z maps local (0.2, 0, 0.1) -> (0, 0.2, 0.1)
        geoms: [],
        joints: [],
        children: [ropeVisible, ropeSelfHidden],
      };
      const hiddenGroup: SceneNode = {
        id: 'hidden_group',
        name: 'Hidden Group',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [],
        joints: [],
        children: [ropeUnderHiddenParent],
      };

      const tree = [rotatedParent, hiddenGroup];
      const markers = visiblePulleyRopeMarkers(
        tree,
        ['rope_hidden', 'hidden_group'],
        restPoses(tree),
      );
      expect(markers).toHaveLength(1);
      expect(markers[0].rope.id).toBe('rope_vis');
      expect(markers[0].worldPos[0]).toBeCloseTo(1.0, 5);
      expect(markers[0].worldPos[1]).toBeCloseTo(2.2, 5);
      expect(markers[0].worldPos[2]).toBeCloseTo(0.6, 5);
    });
  });

  // -------------------------------------------------------------------------
  // P3 #9: gearMeshing meshExtent rotates renderVertices by geom quat/euler
  // -------------------------------------------------------------------------
  describe('P3 #9: gearMeshing meshExtent respects local geom orientation & cache key', () => {
    it('rotates mesh vertices by geom euler/quat and differentiates cache entries by orientation', () => {
      // A flat thin disk of radius 0.04 m and thickness 0.006 m lying in local XY (normal along local Z)
      const verts: number[] = [];
      const N = 32;
      for (const z of [-0.003, 0.003]) {
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          verts.push(0.04 * Math.cos(a), 0.04 * Math.sin(a), z);
        }
      }

      const joint = { name: 'h', type: 'hinge' as const, axis: [1, 0, 0], pos: [0, 0, 0] };
      const world = { pos: [0, 0, 0], quat: [1, 0, 0, 0] as [number, number, number, number] };

      // Unrotated: disk lies in XY, so along hinge X its span is [-0.04, 0.04]
      const unrotatedNode: SceneNode = {
        id: 'g1',
        name: 'Gear 1',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [{ name: 'm', type: 'mesh', renderVertices: verts }],
        joints: [joint],
        children: [],
      };
      const gbUnrot = gearBody(unrotatedNode, joint, world);
      expect(gbUnrot.wheels[0].hi - gbUnrot.wheels[0].lo).toBeCloseTo(0.08, 4);

      // Rotated 90° about Y (same vertex array reference!): disk normal maps Z -> X,
      // so along hinge X its span must now be [-0.003, 0.003] and radius 0.04!
      const rotatedNode: SceneNode = {
        ...unrotatedNode,
        geoms: [{ name: 'm', type: 'mesh', renderVertices: verts, euler: [0, 90, 0] }],
      };
      const gbRot = gearBody(rotatedNode, joint, world);
      expect(gbRot.wheels[0].hi - gbRot.wheels[0].lo).toBeCloseTo(0.006, 4);
      expect(gbRot.wheels[0].radius).toBeCloseTo(0.04, 4);
    });
  });

  // -------------------------------------------------------------------------
  // P3 #10: Flexure bistable travel label & revertFlexure joint-index match
  // -------------------------------------------------------------------------
  describe('P3 #10: Flexure bistable label & revertFlexure joint index', () => {
    it('reverts the same non-zero joint index that applyFlexureToNode modified', () => {
      const node: SceneNode = {
        id: 'multi_joint_body',
        name: 'Multi Joint',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [{ name: 'body', type: 'box', size: [0.02, 0.01, 0.005] }],
        joints: [
          { name: 'j_ball', type: 'ball', stiffness: 12, damping: 0.5 },
          { name: 'j_hinge', type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0] },
        ],
        children: [],
      };

      const applied = applyFlexureToNode(node, { kind: 'living_hinge' })!;
      expect(applied).not.toBeNull();
      expect(applied.node.joints[1].stiffness).toBeGreaterThan(0);
      expect(applied.node.joints[1].limited).toBe(true);
      expect(applied.node.joints[0].stiffness).toBe(12);

      const reverted = revertFlexure(applied.node);
      expect(reverted.flexure).toBeUndefined();
      // Joint 0 (ball) must remain untouched
      expect(reverted.joints[0].stiffness).toBe(12);
      expect(reverted.joints[0].damping).toBe(0.5);
      // Joint 1 (hinge) must be reset cleanly
      expect(reverted.joints[1].stiffness).toBe(0);
      expect(reverted.joints[1].damping).toBe(0);
      expect(reverted.joints[1].limited).toBe(false);
      expect(reverted.joints[1].range).toBeUndefined();
    });

    it('renders Stroke (not Safe travel ±) for bistable flexures in FlexureCard', () => {
      const src = fs.readFileSync(
        path.join(ROOT, 'src/components/inspector/FlexureCard.tsx'),
        'utf8',
      );
      expect(src).toContain("spec.kind === 'bistable' ?");
      expect(src).toContain('Stroke <b>{spec.maxTravel.toFixed(1)} mm</b>');
    });
  });
});
