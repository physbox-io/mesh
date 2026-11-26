import { describe, expect, it, vi } from 'vitest';
import { brickworkInScene } from '../src/utils/brickwork';
import { compileToMJCF } from '../src/utils/mjcf';
import { meshVolumeAndCentroid } from '../src/utils/csg';
import { isVisualOnlyNode, summarizeNode } from '../src/utils/sceneSummary';
import { dropStaleColliders } from '../src/store/geomEdits';
import { collisionHashOf } from '../src/utils/convexDecomposition';
import { decomposeSolid } from '../src/utils/solidDecomposition';
import { decomposeMesh } from '../src/utils/vhacd';
import { brickCommands } from '../src/hooks/mcp/brickCommands';
import { viewCommands } from '../src/hooks/mcp/viewCommands';
import { useStore } from '../src/store/useStore';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/**
 * Builds a closed, outward-wound 12-vertex, 20-face extruded V-bar (ridge cap)
 * with ~22:1 aspect ratio: length 1.0 m along Y, 45 mm wide in X, 45 mm high in Z,
 * wall thickness ~8 mm.
 */
function makeExtrudedVBar(lengthM = 1.0, halfWidth = 0.0225, peakZ = 0.0225, thick = 0.008): { verts: number[]; faces: number[] } {
  // 2D chevron cross-section in XZ (CCW in XZ viewed from -Y so extrusion along +Y is outward):
  // 0: left outer bottom, 1: outer apex, 2: right outer bottom,
  // 3: right inner bottom, 4: inner apex (reflex!), 5: left inner bottom.
  const profile: [number, number][] = [
    [-halfWidth, 0],
    [0, peakZ],
    [halfWidth, 0],
    [halfWidth - thick, 0],
    [0, peakZ - thick],
    [-halfWidth + thick, 0],
  ];
  const halfL = lengthM / 2;
  const verts: number[] = [];
  // Front cap (y = -halfL): indices 0..5
  for (const [x, z] of profile) verts.push(x, -halfL, z);
  // Back cap (y = +halfL): indices 6..11
  for (const [x, z] of profile) verts.push(x, halfL, z);

  const faces: number[] = [];
  // Side quads (6 quads = 12 triangles), outward normals
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const f0 = i, f1 = j, b0 = i + 6, b1 = j + 6;
    faces.push(f0, b1, b0, f0, f1, b1);
  }
  // Front cap (y = -halfL, normal -Y): 4 triangles splitting chevron cleanly at apex (1) and reflex (4)
  // Left wing: (0, 4, 1), (0, 5, 4); Right wing: (1, 3, 2), (1, 4, 3)
  faces.push(0, 4, 1, 0, 5, 4, 1, 3, 2, 1, 4, 3);
  // Back cap (y = +halfL, normal +Y): reversed winding
  faces.push(6, 7, 10, 6, 10, 11, 7, 8, 9, 7, 9, 10);

  return { verts, faces };
}

/** Single-leaf UK brick wall with a centered doorway of `doorWidthM` and total width `wallWidthM`. */
function narrowDoorwayWall(wallWidthM: number, doorWidthM: number): SceneGraph {
  const t = 0.1025; // UK half-brick thickness
  const totalH = 0.74; // 10 courses
  const doorH = 0.44; // 6 courses
  const jambW = (wallWidthM - doorWidthM) / 2;
  const lintelH = totalH - doorH;
  return {
    nodes: [{
      id: 'front_wall',
      name: 'Front Wall',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [
        { name: 'left_jamb', type: 'box', size: [jambW / 2, t / 2, doorH / 2], pos: [-(doorWidthM / 2 + jambW / 2), 0, doorH / 2] },
        { name: 'right_jamb', type: 'box', size: [jambW / 2, t / 2, doorH / 2], pos: [doorWidthM / 2 + jambW / 2, 0, doorH / 2] },
        { name: 'over_door', type: 'box', size: [wallWidthM / 2, t / 2, lintelH / 2], pos: [0, 0, doorH + lintelH / 2] },
      ],
    }],
  };
}

describe('R2 Item 1: BUILD_BRICKWORK(replace) preserves unrelated concave body colliders', () => {
  it('dropStaleColliders keeps colliders when hash matches unless forced, and drops when stale', () => {
    const { verts, faces } = makeExtrudedVBar(0.4);
    const meshGeom: SceneGeom = {
      name: 'vbar_mesh',
      type: 'mesh',
      dynamic: true,
      vertices: verts,
      renderVertices: verts,
      faces,
    };
    const colliderA: SceneGeom = {
      name: 'vbar_col_0',
      type: 'mesh',
      role: 'collision',
      csgDerived: 'collider',
      vertices: verts,
      renderVertices: verts,
      faces,
    };
    const node: SceneNode = {
      id: 'ridge_cap',
      name: 'Ridge Cap',
      type: 'body',
      pos: [0, 0, 0.5],
      joints: [],
      children: [],
      geoms: [meshGeom, colliderA],
      collisionDecomposed: true,
    };
    node.collisionHash = collisionHashOf(node);

    // Same mesh -> colliders are NOT stale -> dropStaleColliders must NOT wipe them
    expect(dropStaleColliders(node)).toBe(false);
    expect(node.collisionDecomposed).toBe(true);
    expect(node.geoms.filter((g) => g.csgDerived === 'collider')).toHaveLength(1);

    // Forced drop (e.g. decomposition error) still clears them
    expect(dropStaleColliders(node, true)).toBe(true);
    expect(node.collisionDecomposed).toBeUndefined();
    expect(node.geoms.filter((g) => g.csgDerived === 'collider')).toHaveLength(0);
  });

  it('BUILD_BRICKWORK(placement="replace") preserves colliderGeoms and collisionDecomposed on unrelated SCAD bodies', async () => {
    const { verts, faces } = makeExtrudedVBar(0.5);
    const makeConcaveScadNode = (id: string, name: string, colliderCount: number): SceneNode => {
      const colliders: SceneGeom[] = Array.from({ length: colliderCount }, (_, idx) => ({
        name: `${id}_col_${idx}`,
        type: 'mesh',
        role: 'collision',
        csgDerived: 'collider',
        vertices: verts,
        renderVertices: verts,
        faces,
      }));
      const node: SceneNode = {
        id,
        name,
        type: 'body',
        pos: [0, 0, 0.5],
        joints: [],
        children: [],
        scad: 'cube([10, 10, 10]);',
        geoms: [
          { name: `${id}_mesh`, type: 'mesh', dynamic: true, vertices: verts, renderVertices: verts, faces },
          ...colliders,
        ],
        collisionDecomposed: true,
      };
      node.collisionHash = collisionHashOf(node);
      return node;
    };

    const wallNode = narrowDoorwayWall(0.89, 0.35).nodes[0];
    wallNode.id = 'kennel_walls';
    const dogBowl = makeConcaveScadNode('dog_bowl', 'Dog Bowl', 4);
    const ridgeCap = makeConcaveScadNode('ridge_cap', 'Ridge Cap', 2);

    const prevGraph = useStore.getState().sceneGraph;
    const recompileSpy = vi.spyOn(useStore.getState(), 'recompile').mockResolvedValue(undefined);
    try {
      useStore.getState().updateScene({ nodes: [wallNode, dogBowl, ridgeCap] }, true);

      const res = await brickCommands.BUILD_BRICKWORK(
        { bodyId: 'kennel_walls', placement: 'replace', includeMortar: true },
        { store: useStore.getState() } as never,
      ) as Record<string, unknown>;

      expect(res.ok).toBe(true);
      expect(res.laid).toBe(true);

      const nodesAfter = useStore.getState().sceneGraph.nodes;
      const bowlAfter = nodesAfter.find((n) => n.id === 'dog_bowl')!;
      const ridgeAfter = nodesAfter.find((n) => n.id === 'ridge_cap')!;

      expect(bowlAfter).toBeDefined();
      expect(bowlAfter.collisionDecomposed).toBe(true);
      expect(bowlAfter.geoms.filter((g) => g.csgDerived === 'collider')).toHaveLength(4);

      expect(ridgeAfter).toBeDefined();
      expect(ridgeAfter.collisionDecomposed).toBe(true);
      expect(ridgeAfter.geoms.filter((g) => g.csgDerived === 'collider')).toHaveLength(2);
    } finally {
      recompileSpy.mockRestore();
      useStore.getState().updateScene(prevGraph, true);
    }
  });
});

describe('R2 Item 2: Lintel geom clamping to wall corners & short-bearing warning', () => {
  it('clamps a 750 mm stock lintel to a 665 mm front wall span so it never protrudes past corners', () => {
    const wallWidthMm = 665;
    const doorWidthMm = 347.5;
    const scene = narrowDoorwayWall(wallWidthMm / 1000, doorWidthMm / 1000);
    const out = brickworkInScene(scene, null, { standardId: 'uk', bond: 'stretcher', placement: 'replace' });

    // BOM still orders the 750 mm stock lintel
    expect(out.result.lintels).toEqual([{ lengthMm: 750, count: 1 }]);
    expect(out.result.placedLintels).toHaveLength(1);

    const placed = out.result.placedLintels![0];
    expect(placed.lengthMm).toBeLessThanOrEqual(wallWidthMm + 0.5);
    expect(Math.abs(placed.x) + placed.lengthMm / 2).toBeLessThanOrEqual(wallWidthMm / 2 + 0.5);

    const lintelGeoms = out.nodes.flatMap((n) => n.geoms).filter((g) => /_lintel_/.test(g.name));
    expect(lintelGeoms).toHaveLength(1);
    const halfSpanM = lintelGeoms[0].size![0];
    const centerXM = lintelGeoms[0].pos![0];
    expect(Math.abs(centerXM) + halfSpanM).toBeLessThanOrEqual(wallWidthMm / 2000 + 0.001);
  });

  it('pushes a clear warning when clamped lintel bearing is shorter than standard 150 mm', () => {
    // 560 mm wall with 347.5 mm doorway -> ~106 mm bearing each side (< 150 mm)
    const wallWidthMm = 560;
    const doorWidthMm = 347.5;
    const scene = narrowDoorwayWall(wallWidthMm / 1000, doorWidthMm / 1000);
    const out = brickworkInScene(scene, null, { standardId: 'uk', bond: 'stretcher', placement: 'replace' });

    expect(out.result.placedLintels).toHaveLength(1);
    expect(out.result.placedLintels![0].lengthMm).toBeLessThanOrEqual(wallWidthMm + 0.5);
    expect(out.result.warnings.some((w) => /lintel/i.test(w) && /bearing/i.test(w) && /150/.test(w))).toBe(true);
  });
});

describe('R2 Item 3: Visual-only mortar core reports 0 inertial mass and 0 fixedMassKg', () => {
  it('sets mass: 0 on mortar core geoms and emits mass="0" in MJCF', () => {
    const scene = narrowDoorwayWall(0.89, 0.35);
    const out = brickworkInScene(scene, null, { standardId: 'uk', placement: 'replace', includeMortar: true });
    const mortarNode = out.nodes.find((n) => /_mortar$/.test(n.id));
    expect(mortarNode).toBeDefined();
    expect(mortarNode!.geoms.length).toBeGreaterThan(0);
    for (const g of mortarNode!.geoms) {
      expect(g.role).toBe('visual');
      expect(g.mass).toBe(0);
    }
    expect(isVisualOnlyNode(mortarNode!)).toBe(true);

    const xml = compileToMJCF({ nodes: [mortarNode!] });
    expect(xml).toContain('mass="0"');
    expect(xml).toContain('contype="0" conaffinity="0"');
  });

  it('reports inertial.massKg: 0 in summarizeNode and excludes visual-only bodies from fixedMassKg', async () => {
    const mortarNode: SceneNode = {
      id: 'brick_test_mortar',
      name: 'Mortar Core',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [
        { name: 'brick_test_mortar_1_1', type: 'box', role: 'visual', size: [0.4, 0.05, 0.3], pos: [0, 0, 0.3] },
      ],
    };
    const brickNode: SceneNode = {
      id: 'brick_test_course_1',
      name: 'Course 1',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [
        { name: 'brick_test_1_1', type: 'box', size: [0.1, 0.05, 0.03], pos: [0, 0, 0.03], density: 1900 },
      ],
    };

    // Even if a stale/mock model reports non-zero body_mass for the visual-only mortar body:
    const mockModel = {
      body_mass: [0, 131.548, 25.0],
      body_dofnum: [0, 0, 0],
      body_parentid: [0, 0, 0],
      body_ipos: [0, 0, 0, 0, 0, 0.3, 0, 0, 0.03],
      body_inertia: [0, 0, 0, 10, 10, 10, 1, 1, 1],
      _idMaps: { body: { brick_test_mortar: 1, brick_test_course_1: 2 } },
    };

    const mortarSummary = summarizeNode(mortarNode, { model: mockModel });
    expect((mortarSummary.inertial as { massKg: number }).massKg).toBe(0);

    const brickSummary = summarizeNode(brickNode, { model: mockModel });
    expect((brickSummary.inertial as { massKg: number }).massKg).toBe(25);

    const summaryReply = await viewCommands.GET_SCENE_SUMMARY(
      {},
      {
        store: {
          ...useStore.getState(),
          sceneGraph: { nodes: [mortarNode, brickNode] },
          model: mockModel,
          data: null,
        },
      } as never,
    ) as Record<string, unknown>;

    expect(summaryReply.fixedMassKg).toBe(25);
  });
});

describe('R2 Item 4: Fast, reliable decomposition of 12-vertex, 20-face 22:1 extruded V-bar', () => {
  it('decomposes a 22:1 extruded V-bar into 2 exact convex pieces almost instantaneously', async () => {
    const { verts, faces } = makeExtrudedVBar(1.0, 0.0225, 0.0225, 0.008);
    expect(verts.length / 3).toBe(12);
    expect(faces.length / 3).toBe(20);
    expect(meshVolumeAndCentroid(verts, faces).volume).toBeGreaterThan(0);

    const t0 = performance.now();
    const res = await decomposeSolid(verts, faces, { maxPieces: 16 });
    const dt = performance.now() - t0;

    expect(res.hulls.length).toBe(2);
    expect(res.cavities).toHaveLength(0);
    expect(res.intrusion).toBe(0);
    expect(res.uncovered).toBeLessThanOrEqual(1e-4);
    expect(dt).toBeLessThan(2_000);

    // Also works when explicit voxelResolution is requested
    const resWithVoxel = await decomposeSolid(verts, faces, { maxPieces: 16, voxelResolution: 25_000 });
    expect(resWithVoxel.hulls.length).toBe(2);
    expect(resWithVoxel.cavities).toHaveLength(0);
  });

  it('V-HACD direct decomposeMesh handles 22:1 V-bar cleanly via aspect-ratio normalization', async () => {
    const { verts, faces } = makeExtrudedVBar(1.0, 0.0225, 0.0225, 0.008);
    const hulls = await decomposeMesh(verts, faces, { maxHulls: 8, voxelResolution: 25_000 });
    expect(hulls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('R2 Item 5: BUILD_BRICKWORK returns createdIds when placement !== "none"', () => {
  it('returns createdIds for placement="replace" and omits createdIds for placement="none"', async () => {
    const wallScene = narrowDoorwayWall(0.89, 0.35);
    const prevGraph = useStore.getState().sceneGraph;
    const recompileSpy = vi.spyOn(useStore.getState(), 'recompile').mockResolvedValue(undefined);
    try {
      useStore.getState().updateScene(wallScene, true);

      const countOnly = await brickCommands.BUILD_BRICKWORK(
        { placement: 'none' },
        { store: useStore.getState() } as never,
      ) as Record<string, unknown>;
      expect(countOnly.ok).toBe(true);
      expect(countOnly.laid).toBe(false);
      expect(countOnly.createdIds).toBeUndefined();

      const placed = await brickCommands.BUILD_BRICKWORK(
        { placement: 'replace', includeMortar: true },
        { store: useStore.getState() } as never,
      ) as Record<string, unknown>;
      expect(placed.ok).toBe(true);
      expect(placed.laid).toBe(true);
      const createdIds = placed.createdIds as string[];
      expect(Array.isArray(createdIds)).toBe(true);
      expect(createdIds.length).toBeGreaterThan(1);
      expect(createdIds.some((id) => /_course_1$/.test(id))).toBe(true);
      expect(createdIds.some((id) => /_mortar$/.test(id))).toBe(true);
      const sceneIds = new Set(useStore.getState().sceneGraph.nodes.map((n) => n.id));
      for (const id of createdIds) expect(sceneIds.has(id)).toBe(true);
    } finally {
      recompileSpy.mockRestore();
      useStore.getState().updateScene(prevGraph, true);
    }
  });
});

describe('R2 Item 6: GET_OBJECTS names_only / namesOnly lightweight mode', () => {
  it('returns lightweight summaries without geom blobs when names_only or namesOnly is true', async () => {
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'wall_1',
          name: 'Course 1',
          type: 'body',
          pos: [0, 0, 0.03],
          joints: [],
          geoms: [
            { name: 'b1', type: 'box', size: [0.1, 0.05, 0.03], pos: [0, 0, 0] },
            { name: 'b2', type: 'box', size: [0.1, 0.05, 0.03], pos: [0.22, 0, 0] },
          ],
          children: [
            {
              id: 'child_1',
              name: 'Child Bracket',
              type: 'body',
              pos: [0.1, 0, 0],
              joints: [],
              children: [],
              geoms: [{ name: 'c1', type: 'box', size: [0.02, 0.02, 0.02] }],
            },
          ],
        },
      ],
    };

    const ctx = { store: { sceneGraph: scene } } as never;

    const snake = await viewCommands.GET_OBJECTS({ names_only: true }, ctx) as Record<string, unknown>[];
    const camel = await viewCommands.GET_OBJECTS({ namesOnly: true }, ctx) as Record<string, unknown>[];
    expect(snake).toEqual(camel);
    expect(snake).toHaveLength(1);
    expect(snake[0]).toEqual({
      id: 'wall_1',
      name: 'Course 1',
      type: 'body',
      pos: [0, 0, 0.03],
      geomCount: 2,
      childCount: 1,
      children: [
        {
          id: 'child_1',
          name: 'Child Bracket',
          type: 'body',
          pos: [0.1, 0, 0],
          geomCount: 1,
          childCount: 0,
        },
      ],
    });
    expect(snake[0].geoms).toBeUndefined();

    // Default mode still returns full stateNode with geoms
    const full = await viewCommands.GET_OBJECTS({}, ctx) as Record<string, unknown>[];
    expect(Array.isArray(full[0].geoms)).toBe(true);
    expect((full[0].geoms as unknown[]).length).toBe(2);
  });
});
