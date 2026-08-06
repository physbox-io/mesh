import { describe, it, expect } from 'vitest';
import { analyzeSceneMechanicalWeaknesses } from '../src/utils/printAnalysis';
import {
  createHeatSetBossNode,
  createHexNutTrapNode,
  createBearingPocketNode,
  createDShaftHubNode,
  createCounterboreHoleNode,
} from '../src/utils/hardwareComponents';
import type { SceneGraph } from '../src/types/scene';

describe('printAnalysis & hardwareComponents', () => {
  it('creates standardized 3D hardware components with meter-scaling SCAD', () => {
    const boss = createHeatSetBossNode('M3');
    expect(boss.name).toContain('M3 Insert Boss');
    expect(boss.isHardwareComponent).toBe(true);
    expect(boss.scad).toContain('scale(0.001)');

    const nut = createHexNutTrapNode('M4');
    expect(nut.name).toContain('M4 Nut Trap');
    expect(nut.scad).toContain('scale(0.001)');

    const bearing = createBearingPocketNode('608');
    expect(bearing.name).toContain('608 Bearing Housing');
    expect(bearing.scad).toContain('scale(0.001)');

    const dshaft = createDShaftHubNode(5.0);
    expect(dshaft.name).toContain('5mm D-Shaft Hub');
    expect(dshaft.scad).toContain('scale(0.001)');

    const counterbore = createCounterboreHoleNode('M3');
    expect(counterbore.name).toContain('M3 Cap Screw Recess');
    expect(counterbore.isHardwareComponent).toBe(true);
    expect(counterbore.scad).toContain('scale(0.001)');
    expect(counterbore.geoms.some(g => g.csg === 'difference')).toBe(true);
  });

  it('evaluates structural, thin wall, and pin weak spots', () => {
    const testScene: SceneGraph = {
      nodes: [
        // A tall slender column prone to buckling (0.01m x 0.01m width, 0.2m height -> 20:1 ratio)
        {
          id: 'tall_column',
          name: 'Tall Column',
          pos: [0, 0, 0.1],
          geoms: [{ type: 'box', size: [0.005, 0.005, 0.1], dynamic: true }],
          joints: [{ type: 'free' }],
          children: [],
        },
        // A thin wall box (0.4mm thickness = 0.0002m half-size)
        {
          id: 'thin_box_node',
          name: 'Thin Box',
          pos: [0.5, 0, 0.05],
          geoms: [{ type: 'box', size: [0.0002, 0.05, 0.05], dynamic: true }],
          joints: [],
          children: [],
        },
        // A fragile vertical pin (1.5mm diameter = 0.00075m radius)
        {
          id: 'thin_pin_node',
          name: 'Thin Pin',
          pos: [1.0, 0, 0.05],
          geoms: [{ type: 'cylinder', size: [0.00075, 0.015], dynamic: true }],
          joints: [],
          children: [],
        },
        // An un-scaled millimeter model compiling >20m
        {
          id: 'huge_scad',
          name: 'Unscaled SCAD',
          pos: [2, 0, 0],
          geoms: [{ type: 'box', size: [15.0, 15.0, 15.0], dynamic: true }],
          joints: [],
          children: [],
        },
      ],
    };

    const result = analyzeSceneMechanicalWeaknesses(testScene);
    expect(result.weakSpots.length).toBeGreaterThanOrEqual(4);
    expect(result.score).toBeLessThan(80);

    const bucklingSpot = result.weakSpots.find(w => w.id.startsWith('buckling_'));
    expect(bucklingSpot).toBeDefined();

    const thinWallSpot = result.weakSpots.find(w => w.id.startsWith('thin_wall_'));
    expect(thinWallSpot).toBeDefined();
    expect(thinWallSpot?.title).toContain('Ultra-Thin Wall Section');

    const thinPinSpot = result.weakSpots.find(w => w.id.startsWith('thin_pin_'));
    expect(thinPinSpot).toBeDefined();
    expect(thinPinSpot?.title).toContain('Fragile Vertical Pin');

    const scaleSpot = result.weakSpots.find(w => w.id.startsWith('scale_large_'));
    expect(scaleSpot).toBeDefined();
    expect(scaleSpot?.severity).toBe('critical');
  });

  it('detects mesh downward face overhang clusters', () => {
    // Downward-facing horizontal plane (Normal = [0, 0, -1], elevated at z=0.05m)
    const downwardRenderVerts = [
      -0.05, 0.05, 0.05,   0.05, -0.05, 0.05,  -0.05, -0.05, 0.05, // Tri 1 (clockwise)
       0.05, 0.05, 0.05,   0.05, -0.05, 0.05,  -0.05,  0.05, 0.05  // Tri 2 (clockwise)
    ];

    const meshScene: SceneGraph = {
      nodes: [
        {
          id: 'overhang_mesh_node',
          name: 'Overhang Model',
          pos: [0, 0, 0.05],
          geoms: [{ type: 'mesh', name: 'overhang_g', renderVertices: downwardRenderVerts, dynamic: true }],
          joints: [],
          children: [],
        },
      ],
    };

    const result = analyzeSceneMechanicalWeaknesses(meshScene);
    const overhangSpot = result.weakSpots.find(w => w.id.startsWith('mesh_overhang_'));
    expect(overhangSpot).toBeDefined();
    expect(overhangSpot?.title).toContain('Unsupported Mesh Overhang');
  });

  it('accurately positions weak spots for nodes at non-zero world pos without double offset', () => {
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'offset_node',
          name: 'Offset Thin Box',
          pos: [0.35, 0.45, 0.15],
          geoms: [{ type: 'box', name: 'box_g', size: [0.0002, 0.05, 0.05], dynamic: true }],
          joints: [],
          children: [],
        },
      ],
    };

    const result = analyzeSceneMechanicalWeaknesses(scene);
    const thinWallSpot = result.weakSpots.find(w => w.id.startsWith('thin_wall_'));
    expect(thinWallSpot).toBeDefined();
    // Position must match single node pos [0.35, 0.45, 0.15], NOT doubled [0.70, 0.90, 0.30]
    expect(thinWallSpot?.position[0]).toBeCloseTo(0.35, 3);
    expect(thinWallSpot?.position[1]).toBeCloseTo(0.45, 3);
    expect(thinWallSpot?.position[2]).toBeCloseTo(0.15, 3);
  });

  it('correctly transforms weak spots when a node is rotated in 3D space', () => {
    // Horizontal plane (Normal = [0, 0, 1] in unrotated space - top face)
    const topRenderVerts = [
      -0.05, -0.05, 0.05,   0.05, -0.05, 0.05,  -0.05, 0.05, 0.05,
       0.05, -0.05, 0.05,   0.05,  0.05, 0.05,  -0.05, 0.05, 0.05,
    ];

    // Rotate 180 degrees around X axis so top face becomes downward facing overhang
    const rotatedScene: SceneGraph = {
      nodes: [
        {
          id: 'rotated_overhang_node',
          name: 'Rotated Mesh',
          pos: [0.2, 0.2, 0.1],
          rot: [Math.PI, 0, 0], // 180 degrees X flip
          geoms: [{ type: 'mesh', name: 'mesh_g', renderVertices: topRenderVerts, dynamic: true }],
          joints: [],
          children: [],
        },
      ],
    };

    const result = analyzeSceneMechanicalWeaknesses(rotatedScene);
    const overhangSpot = result.weakSpots.find(w => w.id.startsWith('mesh_overhang_'));
    expect(overhangSpot).toBeDefined();
    // After 180 deg X flip, the face points down and its Z position is rotated to world pos
    expect(overhangSpot?.position[0]).toBeCloseTo(0.2, 2);
    expect(overhangSpot?.position[1]).toBeCloseTo(0.2, 2);
  });
});
