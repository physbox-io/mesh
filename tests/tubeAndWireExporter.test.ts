import { describe, it, expect } from 'vitest';
import {
  PIPE_STANDARDS,
  DEFAULT_PIPE_FRAME_OPTIONS,
  generatePipeStructurePreset,
  breakdownPipeFrame,
  buildPipeHubNode,
  buildAllCustomHubNodes,
  computeTubeCopeJoint,
  extractSceneTubeJoints,
  exportTubeCopeSvg,
  buildTubeCopeEtchUrl,
  computeWireBendSchedule,
  extractSceneWireCurves,
  buildWireBendingJigNode,
} from '../src/utils/tubeAndWireExporter';
import type { SceneGraph } from '../src/types/scene';

describe('tubeAndWireExporter', () => {
  describe('1. Hardware-Store Pipe & Conduit Standards (PIPE_STANDARDS)', () => {
    it('contains the US Schedule 40 PVC, EMT conduit, Metric PVC and small aluminium tube standards', () => {
      const ids = Object.keys(PIPE_STANDARDS);
      expect(ids).toHaveLength(14);
      expect(PIPE_STANDARDS.alu_8.material).toBe('aluminium');
      expect(PIPE_STANDARDS.pvc_sch40_3_4.odMm).toBeCloseTo(26.67, 2);
      expect(PIPE_STANDARDS.pvc_sch40_3_4.stockLengthMm).toBe(3048);
      expect(PIPE_STANDARDS.emt_3_4.material).toBe('emt');
      expect(PIPE_STANDARDS.emt_3_4.odMm).toBeCloseTo(23.42, 2);
      expect(PIPE_STANDARDS.pvc_metric_20.odMm).toBe(20);
      expect(PIPE_STANDARDS.pvc_metric_20.stockLengthMm).toBe(3000);
      expect(PIPE_STANDARDS.pvc_metric_25.odMm).toBe(25);
    });
  });

  describe('2. PVC / EMT Pipe Frame Breakdown, Presets & Printable 3D Hub Connectors', () => {
    it('generates 3D pipe frame presets (mini_greenhouse, yard_pub, carport, geodesic_dome)', () => {
      const ghNodes = generatePipeStructurePreset('mini_greenhouse', {
        widthMm: 1200,
        depthMm: 1800,
        heightMm: 1200,
        roofPitchDeg: 30,
      });
      expect(ghNodes.length).toBeGreaterThanOrEqual(20);
      expect(ghNodes[0].geoms[0].type).toBe('cylinder');
      expect(ghNodes[0].geoms[0].fromto).toHaveLength(6);

      const pubNodes = generatePipeStructurePreset('yard_pub');
      expect(pubNodes.length).toBeGreaterThanOrEqual(18);

      const carportNodes = generatePipeStructurePreset('carport');
      expect(carportNodes.length).toBeGreaterThanOrEqual(22);

      const domeNodes = generatePipeStructurePreset('geodesic_dome');
      expect(domeNodes.length).toBe(25);
    });

    it('breaks down a mini greenhouse frame into struts, hubs, 10ft sticks, and shopping list', () => {
      const ghNodes = generatePipeStructurePreset('mini_greenhouse', {
        widthMm: 1200,
        depthMm: 1800,
        heightMm: 1200,
        roofPitchDeg: 30,
      });
      const scene: SceneGraph = { nodes: ghNodes };
      const bd = breakdownPipeFrame(scene, {
        ...DEFAULT_PIPE_FRAME_OPTIONS,
        pipeStandardId: 'pvc_sch40_3_4',
      });

      expect(bd.struts.length).toBe(ghNodes.length);
      expect(bd.hubs.length).toBeGreaterThanOrEqual(12);
      // Rafters meet ridge & eaves at non-90° angles -> requires custom 3D printed hubs
      expect(bd.shoppingList.customPrintedHubs).toBeGreaterThan(0);
      expect(bd.sticksRequired).toBeGreaterThan(0);
      expect(bd.shoppingList.sticksToBuy).toBe(bd.sticksRequired);

      // Verify hub shoulder deduction shortened cutLengthMm relative to nodeToNodeLengthMm
      for (const s of bd.struts) {
        expect(s.cutLengthMm).toBeLessThan(s.nodeToNodeLengthMm);
        expect(s.startDeductionMm).toBeGreaterThan(0);
        expect(s.endDeductionMm).toBeGreaterThan(0);
      }

      // Verify stick packing respects stockLengthMm
      for (const stick of bd.sticks) {
        expect(stick.usedMm).toBeLessThanOrEqual(stick.stockLengthMm);
        expect(stick.utilizationPct).toBeGreaterThan(0);
      }
    });

    it('converts a simple volumetric box scene into a 12-strut orthogonal PVC frame with 8 3-way 90° corners', () => {
      const boxScene: SceneGraph = {
        nodes: [
          {
            id: 'box_frame',
            name: 'Cube Enclosure',
            type: 'mesh',
            position: [0, 0, 0.5],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            geoms: [{ type: 'box', size: [0.4, 0.3, 0.5] }],
          },
        ],
      };

      const bd = breakdownPipeFrame(boxScene, { pipeStandardId: 'pvc_sch40_1' });
      expect(bd.struts).toHaveLength(12);
      expect(bd.hubs).toHaveLength(8);
      expect(bd.shoppingList.standardCorners3Way).toBe(8);
      expect(bd.shoppingList.customPrintedHubs).toBe(0);
    });

    it('builds printable CSG hub nodes in both socket and spigot fit styles', () => {
      const ghNodes = generatePipeStructurePreset('mini_greenhouse');
      const bd = breakdownPipeFrame({ nodes: ghNodes });
      const customHub = bd.hubs.find((h) => h.needsCustomPrint) ?? bd.hubs[0];

      const socketNode = buildPipeHubNode(customHub, {
        pipeStandardId: 'pvc_sch40_3_4',
        hubFitStyle: 'socket',
        crossBoltHoleMm: 4.2,
      });
      expect(socketNode.csgEnabled).toBe(true);
      const unionGeoms = socketNode.geoms.filter((g) => g.csg === 'union');
      const diffGeoms = socketNode.geoms.filter((g) => g.csg === 'difference');
      expect(unionGeoms.length).toBe(1 + customHub.ports.length);
      expect(diffGeoms.length).toBe(customHub.ports.length * 2); // bore + cross-bolt hole per port

      const spigotNode = buildPipeHubNode(customHub, {
        pipeStandardId: 'emt_3_4',
        hubFitStyle: 'spigot',
      });
      expect(spigotNode.csgEnabled).toBe(true);
      expect(spigotNode.geoms.every((g) => g.csg === 'union')).toBe(true);

      const allCustomNodes = buildAllCustomHubNodes(bd);
      expect(allCustomNodes.length).toBe(bd.shoppingList.customPrintedHubs);
    });
  });

  describe('3. Tube & Pipe Coping ("Fish-Mouth" Wrap-Around Cut Templates)', () => {
    it('computes a 90° equal-diameter tube-to-tube saddle cope with exact analytical depth R', () => {
      const od = 40; // R = 20mm
      const profile = computeTubeCopeJoint({
        cutTubeOdMm: od,
        cutTubeWallMm: 2.0,
        targetKind: 'tube',
        targetTubeOdMm: od,
        angleDeg: 90,
        samples: 72,
      });

      expect(profile.circumferenceMm).toBeCloseTo(Math.PI * od, 1);
      // For equal tubes at 90°, outer saddle depth is R = 20mm
      expect(profile.peakToValleyOuterMm).toBeCloseTo(20.0, 1);
      expect(profile.points.length).toBe(73);
      // At 90° intersection, outerZMm >= innerZMm at peaks so bevelGrindMm > 0
      const maxBevel = Math.max(...profile.points.map((p) => p.bevelGrindMm));
      expect(maxBevel).toBeGreaterThan(1.5);
    });

    it('computes a 45° plane miter cut and an angled tube-to-tube joint', () => {
      const miter = computeTubeCopeJoint({
        cutTubeOdMm: 30,
        cutTubeWallMm: 2.0,
        targetKind: 'plane',
        angleDeg: 45,
      });
      // For 45° miter on OD=30 (R=15), peak-to-valley outer = 2 * R / tan(45°) = 30mm
      expect(miter.peakToValleyOuterMm).toBeCloseTo(30.0, 1);

      const angled = computeTubeCopeJoint({
        cutTubeOdMm: 25,
        cutTubeWallMm: 2.0,
        targetKind: 'tube',
        targetTubeOdMm: 50,
        angleDeg: 45,
      });
      expect(angled.peakToValleyOuterMm).toBeGreaterThan(15);
      expect(angled.warnings).toHaveLength(0);
    });

    it('extracts intersecting cylinder joints from a SceneGraph and exports 1:1 SVG + Etch URL', async () => {
      const scene: SceneGraph = {
        nodes: [
          {
            id: 'main_tube',
            name: 'Main Chord',
            type: 'mesh',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            geoms: [
              {
                type: 'cylinder',
                size: [0.02, 0.5],
                fromto: [-0.5, 0, 0, 0.5, 0, 0],
              },
            ],
          },
          {
            id: 'branch_tube',
            name: 'Branch Strut',
            type: 'mesh',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            geoms: [
              {
                type: 'cylinder',
                size: [0.015, 0.25],
                fromto: [0, 0, 0, 0, 0, 0.5],
              },
            ],
          },
        ],
      };

      const members = extractSceneTubeJoints(scene, { wallThicknessMm: 2.0 });
      expect(members).toHaveLength(2);
      const branch = members.find((m) => m.name === 'Branch Strut')!;
      expect(branch.startCope).toBeDefined();
      expect(branch.startCope!.spec.angleDeg).toBeCloseTo(90, 1);

      const exported = exportTubeCopeSvg(members, {
        includeBevelLine: true,
        includeDegreeMarks: true,
        includeScaleBar: true,
      });
      expect(exported.svg).toContain('<svg');
      expect(exported.svg).toContain('50 mm Scale Check');
      expect(exported.svg).toContain('data-line-role="inner-bevel"');
      expect(exported.widthMm).toBeGreaterThan(90);

      const url = await buildTubeCopeEtchUrl(exported, 'Test Roll Cage Cope');
      expect(url).toContain('#v=1');
    });
  });

  describe('4. 3D Wire Bending Schedule (LRA) & Printable Wire Bending Jig', () => {
    it('computes LRA schedule and arc/setback length deduction for a planar U-bracket', () => {
      // 100mm leg -> 90° turn -> 100mm base -> 90° turn -> 100mm leg (sharp polyline = 300mm)
      const pts: [number, number, number][] = [
        [0, 100, 0],
        [0, 0, 0],
        [100, 0, 0],
        [100, 100, 0],
      ];
      const sched = computeWireBendSchedule(pts, {
        wireDiameterMm: 3.0,
        bendRadiusMm: 10.0,
        springbackFactor: 1.05,
        simplifyToleranceMm: 0,
      });

      expect(sched.isPlanar).toBe(true);
      expect(sched.steps).toHaveLength(2);
      expect(sched.sharpPolylineLengthMm).toBeCloseTo(300, 2);

      // At 90° bend with R=10mm: setback = 10 * tan(45°) = 10mm, arc = 10 * pi/2 = 15.71mm
      expect(sched.steps[0].bendAngleDeg).toBeCloseTo(90, 1);
      expect(sched.steps[0].overbendAngleDeg).toBeCloseTo(94.5, 1);
      expect(sched.steps[0].setbackMm).toBeCloseTo(10, 1);
      expect(sched.steps[0].straightFeedMm).toBeCloseTo(90, 1); // 100 - 10
      expect(sched.steps[1].straightFeedMm).toBeCloseTo(80, 1); // 100 - 10 - 10
      expect(sched.finalStraightMm).toBeCloseTo(90, 1); // 100 - 10
      // Total cut length = 90 + 80 + 90 + 2 * (5 * pi) = 260 + 31.42 = 291.42mm (< 300mm sharp length)
      expect(sched.totalCutLengthMm).toBeCloseTo(291.42, 1);
      expect(sched.totalCutLengthMm).toBeLessThan(sched.sharpPolylineLengthMm);
    });

    it('computes non-zero rotation (R) angle for a 3D out-of-plane wire bend and builds a CSG bending jig', () => {
      const pts3D: [number, number, number][] = [
        [0, 0, 0],
        [60, 0, 0],
        [60, 60, 0],
        [60, 60, 60],
      ];
      const { jigNode, schedule, isPlanar } = buildWireBendingJigNode(pts3D, {
        wireDiameterMm: 3.0,
        bendRadiusMm: 6.0,
      });

      expect(isPlanar).toBe(false);
      expect(schedule.steps).toHaveLength(2);
      expect(Math.abs(schedule.steps[1].rotateAngleDeg)).toBeCloseTo(90, 1);

      expect(jigNode.csgEnabled).toBe(true);
      const base = jigNode.geoms.find((g) => g.name === 'jig_base_plate');
      const pegs = jigNode.geoms.filter((g) => g.name?.startsWith('bend_peg_'));
      const grooves = jigNode.geoms.filter((g) => g.name?.startsWith('wire_groove_'));
      expect(base).toBeDefined();
      expect(pegs).toHaveLength(2);
      expect(grooves).toHaveLength(3);
    });

    it('extracts chained wire curves from scene cylinders', () => {
      const scene: SceneGraph = {
        nodes: [
          {
            id: 'seg1',
            name: 'Wire Hook',
            type: 'mesh',
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            geoms: [
              { type: 'cylinder', size: [0.0015, 0.025], fromto: [0, 0, 0, 0.05, 0, 0] },
              { type: 'cylinder', size: [0.0015, 0.025], fromto: [0.05, 0, 0, 0.05, 0.05, 0] },
            ],
          },
        ],
      };

      const curves = extractSceneWireCurves(scene);
      expect(curves).toHaveLength(1);
      expect(curves[0].pointsMm).toHaveLength(3);
    });
  });
});
