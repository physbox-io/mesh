import { describe, it, expect } from 'vitest';
import {
  PIPE_STANDARDS,
  DEFAULT_PIPE_FRAME_OPTIONS,
  generatePipeStructurePreset,
  breakdownPipeFrame,
  buildPipeHubNode,
  buildAllCustomHubNodes,
} from '../src/utils/tubeAndWireExporter';
import type { SceneGraph } from '../src/types/scene';

describe('tubeAndWireExporter', () => {
  describe('1. Hardware-Store Pipe & Conduit Standards (PIPE_STANDARDS)', () => {
    it('contains the US Schedule 40 PVC, EMT conduit, Metric PVC and small aluminium tube standards', () => {
      const ids = Object.keys(PIPE_STANDARDS);
      expect(ids).toHaveLength(21);
      expect(PIPE_STANDARDS.spaghetti.idMm).toBe(0);
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

    it('reads a box only once Frame a Shape has made it pipes: 12 struts and 8 three-way corners', async () => {
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

      // A plain box is not a frame: it used to be read as twelve pipes.
      expect(breakdownPipeFrame(boxScene).struts).toHaveLength(0);
      const { frameBodyInScene } = await import('../src/utils/pipeSkeleton');
      const framed = { nodes: frameBodyInScene({ nodes: [{ ...boxScene.nodes[0], pos: [0, 0, 0.5], joints: [], children: [] }] } as unknown as SceneGraph,
        'box_frame', { pipeStandardId: 'pvc_sch40_1' }).nodes } as SceneGraph;
      const bd = breakdownPipeFrame(framed, { pipeStandardId: 'pvc_sch40_1' });
      expect(bd.struts).toHaveLength(12);
      expect(bd.hubs).toHaveLength(8);
      expect(bd.shoppingList.standardCorners3Way).toBe(8);
      expect(bd.shoppingList.customPrintedHubs).toBe(0);
    });

    it('models an elbow about its centre of mass, so it compiles where its pipes are', async () => {
      const { solidCentroidXY } = await import('../src/utils/tubeAndWireExporter');
      const hub = {
        id: 'hub_1', name: 'Hub 1', centerMm: [100, 200, 300] as [number, number, number], minAngleDeg: 90,
        classification: '90_elbow' as const, needsCustomPrint: false,
        ports: [{ strutId: 'a', dir: [-1, 0, 0] as [number, number, number], shoulderOffsetMm: 13 }, { strutId: 'b', dir: [0, -1, 0] as [number, number, number], shoulderOffsetMm: 13 }],
      };
      const node = buildPipeHubNode(hub);
      // Its solid's centre of mass is its origin in X and Y, as the compile makes it.
      const [cx, cy] = solidCentroidXY(node.geoms!, 60);
      expect(Math.abs(cx)).toBeLessThan(0.0003);
      expect(Math.abs(cy)).toBeLessThan(0.0003);
      // Which is off the joint: an elbow's mass leans towards its arms.
      expect(node.pos[0]).toBeLessThan(0.1 - 0.002);
      expect(node.pos[1]).toBeLessThan(0.2 - 0.002);
      // Yet every socket still starts on the joint's own line, in world space.
      for (const g of node.geoms!.filter((x) => x.name?.startsWith('sleeve_'))) {
        expect((g.fromto![0] + node.pos[0]) * 1000).toBeCloseTo(100, 6);
        expect((g.fromto![1] + node.pos[1]) * 1000).toBeCloseTo(200, 6);
      }
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
});
