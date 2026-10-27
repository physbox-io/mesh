import { describe, it, expect } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import {
  exportSheetUnfold,
  buildSheetUnfoldEtchUrl,
  computeBendAllowanceMm,
  bendSetbackMm,
  polygonsOverlap2D,
} from '../src/utils/sheetUnfoldExporter';
import { boxLattice, serializeCage, createLattice, vertexAt, addFace } from '../src/utils/latticeMesh';

function makeScene(nodes: SceneNode[]): SceneGraph {
  return {
    nodes,
    joints: [],
    actuators: [],
    sensors: [],
  } as unknown as SceneGraph;
}

/** Builds a 12-triangle closed cube mesh (side = 2 * halfExtentM) in Z-up renderVertices. */
function makeTriangulatedCubeNode(id: string, name: string, halfExtentM = 0.03): SceneNode {
  const h = halfExtentM;
  const renderVertices = [
    -h, -h, -h, // 0
     h, -h, -h, // 1
     h,  h, -h, // 2
    -h,  h, -h, // 3
    -h, -h,  h, // 4
     h, -h,  h, // 5
     h,  h,  h, // 6
    -h,  h,  h, // 7
  ];

  // 12 triangles (2 per quad face), wound CCW seen from outside
  const faces = [
    // Bottom (-Z): 0, 3, 2, 1
    0, 3, 2, 0, 2, 1,
    // Top (+Z): 4, 5, 6, 7
    4, 5, 6, 4, 6, 7,
    // Front (-Y): 0, 1, 5, 4
    0, 1, 5, 0, 5, 4,
    // Back (+Y): 2, 3, 7, 6
    2, 3, 7, 2, 7, 6,
    // Left (-X): 0, 4, 7, 3
    0, 4, 7, 0, 7, 3,
    // Right (+X): 1, 2, 6, 5
    1, 2, 6, 1, 6, 5,
  ];

  return {
    id,
    name,
    pos: [0, 0, 0],
    geoms: [
      {
        name: `${name}_mesh`,
        type: 'mesh',
        size: [h, h, h],
        renderVertices,
        faces,
      },
    ],
    joints: [],
    children: [],
  };
}

/** Builds a square-base pyramid mesh (1 quad base + 4 triangular sides = 5 faces). */
function makeSquarePyramidNode(id: string, name: string, halfBaseM = 0.03, heightM = 0.04): SceneNode {
  const h = halfBaseM;
  const renderVertices = [
    -h, -h, 0,       // 0: base SW
     h, -h, 0,       // 1: base SE
     h,  h, 0,       // 2: base NE
    -h,  h, 0,       // 3: base NW
     0,  0, heightM, // 4: apex
  ];

  const faces = [
    // Base (-Z normal): 0, 3, 2, 1
    0, 3, 2, 0, 2, 1,
    // 4 triangular sides
    0, 1, 4,
    1, 2, 4,
    2, 3, 4,
    3, 0, 4,
  ];

  return {
    id,
    name,
    pos: [0, 0, 0],
    geoms: [
      {
        name: `${name}_mesh`,
        type: 'mesh',
        size: [h, h, heightM],
        renderVertices,
        faces,
      },
    ],
    joints: [],
    children: [],
  };
}

describe('sheetUnfoldExporter', () => {
  it('unfolds a 12-triangle cube mesh into a 6-face non-overlapping 2D cross net with 5 folds and 7 split seams with glue tabs', () => {
    const cubeNode = makeTriangulatedCubeNode('cube_1', 'CubeBox', 0.025); // 50 mm cube
    const scene = makeScene([cubeNode]);

    const res = exportSheetUnfold(scene, {
      mode: 'papercraft',
      tabWidthMm: 6,
      tabAngleDeg: 45,
      sheetWidthMm: 600,
      sheetHeightMm: 400,
    });

    expect(res.success).toBe(true);
    expect(res.totalFaces).toBe(6);
    expect(res.islands).toHaveLength(1);

    const island = res.islands[0];
    expect(island.faceCount).toBe(6);
    expect(res.foldCount).toBe(5);
    expect(res.seamCount).toBe(7);
    expect(res.glueTabCount).toBe(7);

    // Every fold on a convex cube is a 90 deg mountain fold
    for (const fold of island.foldEdges) {
      expect(fold.kind).toBe('mountain');
      expect(fold.angleDeg).toBeCloseTo(90, 2);
    }

    // Verify zero 2D face-face overlaps among all 6 unfolded faces
    for (let i = 0; i < island.faces.length; i++) {
      expect(island.faces[i].areaMm2).toBeCloseTo(50 * 50, 1);
      for (let j = i + 1; j < island.faces.length; j++) {
        expect(polygonsOverlap2D(island.faces[i].polygon2D, island.faces[j].polygon2D)).toBe(false);
      }
    }

    // Verify each of the 7 split edge pairs has a pairId from 1..7 on both sides of the split seam
    const pairCounts = new Map<number, number>();
    for (const seam of island.cutSeams) {
      expect(seam.pairId).toBeGreaterThanOrEqual(1);
      expect(seam.pairId).toBeLessThanOrEqual(7);
      pairCounts.set(seam.pairId, (pairCounts.get(seam.pairId) ?? 0) + 1);
    }
    expect(pairCounts.size).toBe(7);
    for (let id = 1; id <= 7; id++) {
      expect(pairCounts.get(id)).toBe(2);
    }

    // Verify SVG layers and edge-pair numbers
    expect(res.svg).toContain('id="layer-cut"');
    expect(res.svg).toContain('id="layer-mountain-folds"');
    expect(res.svg).toContain('id="layer-seams-tabs"');
    expect(res.svg).toContain('id="layer-labels"');
    for (let id = 1; id <= 7; id++) {
      expect(res.svg).toContain(`>${id}</text>`);
    }
  });

  it('unfolds a pyramid mesh and a latticeCage body with zero 2D face-face overlaps and distinguishes mountain vs valley folds', () => {
    const pyramid = makeSquarePyramidNode('pyr_1', 'Pyramid', 0.025, 0.04);
    const pyrRes = exportSheetUnfold(makeScene([pyramid]), { mode: 'papercraft' });

    expect(pyrRes.success).toBe(true);
    expect(pyrRes.totalFaces).toBe(5);
    expect(pyrRes.foldCount).toBe(4);
    expect(pyrRes.seamCount).toBe(4);
    expect(pyrRes.glueTabCount).toBe(4);

    const pyrFaces = pyrRes.islands[0].faces;
    for (let i = 0; i < pyrFaces.length; i++) {
      for (let j = i + 1; j < pyrFaces.length; j++) {
        expect(polygonsOverlap2D(pyrFaces[i].polygon2D, pyrFaces[j].polygon2D)).toBe(false);
      }
    }

    // Build a latticeCage L-step bracket with both a convex (mountain) fold and a concave (valley) fold
    const lat = createLattice(0.001); // 1 mm per grid step
    // Face 0: horizontal bottom plate (z = 0, x in [0, 40], y in [0, 30]), normal -Z
    const v0 = vertexAt(lat, 0, 0, 0);
    const v1 = vertexAt(lat, 0, 30, 0);
    const v2 = vertexAt(lat, 40, 30, 0);
    const v3 = vertexAt(lat, 40, 0, 0);
    // Face 1: vertical riser at x = 40 going up to z = 30, normal +X (convex / mountain fold with Face 0)
    const v4 = vertexAt(lat, 40, 0, 30);
    const v5 = vertexAt(lat, 40, 30, 30);
    // Face 2: horizontal top step from x = 40 to x = 70 at z = 30, normal -Z (concave / valley fold with Face 1)
    const v6 = vertexAt(lat, 70, 0, 30);
    const v7 = vertexAt(lat, 70, 30, 30);

    addFace(lat, [v0, v1, v2, v3]);
    addFace(lat, [v3, v2, v5, v4]);
    addFace(lat, [v4, v5, v7, v6]);

    const latticeNode: SceneNode = {
      id: 'lat_step',
      name: 'LatticeStep',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: serializeCage(lat),
      geoms: [],
      joints: [],
      children: [],
    };

    const latRes = exportSheetUnfold(makeScene([latticeNode]), { mode: 'papercraft', tabWidthMm: 0 });
    expect(latRes.success).toBe(true);
    expect(latRes.totalFaces).toBe(3);
    expect(latRes.foldCount).toBe(2);

    const kinds = latRes.islands[0].foldEdges.map((f) => f.kind).sort();
    expect(kinds).toEqual(['mountain', 'valley']);
    expect(latRes.svg).toContain('id="layer-mountain-folds"');
    expect(latRes.svg).toContain('id="layer-valley-folds"');
  });

  it('applies K-factor bend allowance BA = theta * (R + K * T) in sheet_metal mode and emits UP 90° bend callouts and relief notches', () => {
    // 50 mm cube primitive (size half-extents = [0.025, 0.025, 0.025] -> 50 x 50 x 50 mm)
    const boxNode: SceneNode = {
      id: 'metal_box',
      name: 'EnclosureBox',
      pos: [0, 0, 0],
      geoms: [
        {
          name: 'body',
          type: 'box',
          size: [0.025, 0.025, 0.025],
        },
      ],
      joints: [],
      children: [],
    };
    const scene = makeScene([boxNode]);

    // Compare flat net span without bend allowance vs with sheet_metal bend allowance
    const flatRes = exportSheetUnfold(scene, {
      mode: 'papercraft',
      tabWidthMm: 0,
      sheetWidthMm: 600,
      sheetHeightMm: 400,
    });

    const thicknessMm = 2.0;
    const bendRadiusMm = 1.5;
    const kFactor = 0.44;
    const expectedBaPer90 = computeBendAllowanceMm(90, bendRadiusMm, thicknessMm, kFactor);
    // BA = (pi / 2) * (1.5 + 0.44 * 2.0) = (pi / 2) * 2.38 ≈ 3.7385 mm
    expect(expectedBaPer90).toBeCloseTo((Math.PI / 2) * (1.5 + 0.44 * 2.0), 5);

    const metalRes = exportSheetUnfold(scene, {
      mode: 'sheet_metal',
      thicknessMm,
      bendRadiusMm,
      kFactor,
      bendReliefWidthMm: 1.5,
      bendReliefDepthMm: 2.0,
      sheetWidthMm: 600,
      sheetHeightMm: 400,
    });

    expect(metalRes.success).toBe(true);
    expect(metalRes.foldCount).toBe(5);
    expect(metalRes.totalBendAllowanceMm).toBeCloseTo(5 * expectedBaPer90, 3);

    // On a 6-face cross net, one dimension has 3 faces (2 bends) and the other has 4 faces (3 bends)
    const flatBounds = flatRes.islands[0].boundsMm;
    const metalBounds = metalRes.islands[0].boundsMm;

    const flatShort = Math.min(flatBounds.width, flatBounds.height);
    const flatLong = Math.max(flatBounds.width, flatBounds.height);
    const metalShort = Math.min(metalBounds.width, metalBounds.height);
    const metalLong = Math.max(metalBounds.width, metalBounds.height);

    expect(flatShort).toBeCloseTo(150, 2); // 3 * 50 mm
    expect(flatLong).toBeCloseTo(200, 2);  // 4 * 50 mm
    // The cube is its outside size: each flat stops the outside setback
    // (R + T) tan 45° short of the corner, and the bend's length goes
    // between, so each bend takes off the bend deduction 2 * OSSB - BA.
    const ossb = bendRadiusMm + thicknessMm;
    expect(bendSetbackMm(90, bendRadiusMm, thicknessMm)).toBeCloseTo(ossb, 9);
    const deduction = 2 * ossb - expectedBaPer90;
    expect(metalShort).toBeCloseTo(150 - 2 * deduction, 2);
    expect(metalLong).toBeCloseTo(200 - 3 * deduction, 2);

    // Check bend callouts and relief notches
    for (const fe of metalRes.islands[0].foldEdges) {
      expect(fe.callout).toBe('UP 90° R1.5');
      expect(fe.bendAllowanceMm).toBeCloseTo(expectedBaPer90, 4);
    }
    expect(metalRes.svg).toContain('UP 90° R1.5');
    expect(metalRes.islands[0].reliefNotches.length).toBeGreaterThan(0);
  });

  it('adds outward seam allowance, alignment notches, and equidistant stitch holes in soft_goods mode', () => {
    const cubeNode = makeTriangulatedCubeNode('leather_cube', 'LeatherPouch', 0.025); // 50 mm cube
    const scene = makeScene([cubeNode]);

    const seamAllowanceMm = 6;
    const stitchPitchMm = 4.0;

    const softRes = exportSheetUnfold(scene, {
      mode: 'soft_goods',
      seamAllowanceMm,
      stitchPitchMm,
      notchLengthMm: 2.5,
      sheetWidthMm: 600,
      sheetHeightMm: 400,
    });

    expect(softRes.success).toBe(true);
    const island = softRes.islands[0];

    // Cross net base is 150 x 200 mm; outward seam allowance of 6 mm on all sides expands bounds by +12 mm
    const shortSpan = Math.min(island.boundsMm.width, island.boundsMm.height);
    const longSpan = Math.max(island.boundsMm.width, island.boundsMm.height);
    expect(shortSpan).toBeCloseTo(150 + 2 * seamAllowanceMm, 1);
    expect(longSpan).toBeCloseTo(200 + 2 * seamAllowanceMm, 1);

    // Verify stitch holes along the 14 exterior seam edges
    expect(softRes.stitchHoleCount).toBeGreaterThan(100);
    expect(island.stitchHoles.length).toBe(softRes.stitchHoleCount);
    expect(softRes.svg).toContain('id="layer-stitch-holes"');
    expect(softRes.svg).toContain('<circle');

    // Verify alignment notches on mating seams
    const totalNotches = island.cutSeams.reduce(
      (acc, s) => acc + (s.alignmentNotches?.length ?? 0),
      0
    );
    expect(totalNotches).toBe(14);
  });

  it('builds a valid Etch handoff URL carrying the unfolded SVG and stock thickness', async () => {
    const cubeNode = makeTriangulatedCubeNode('etch_cube', 'EtchBox', 0.02);
    const res = exportSheetUnfold(makeScene([cubeNode]), {
      mode: 'papercraft',
      thicknessMm: 0.8,
    });

    expect(res.etchUrl).toBeDefined();
    expect(res.etchUrl).toContain('#v=1');
    expect(res.etchUrl).toContain('thickness=0.8');

    const asyncUrl = await buildSheetUnfoldEtchUrl(
      res,
      { thicknessMm: 0.8 },
      'https://etch.physbox.io/'
    );
    expect(asyncUrl.startsWith('https://etch.physbox.io/#')).toBe(true);
    expect(asyncUrl).toContain('v=1');
    expect(asyncUrl).toContain('thickness=0.8');
    expect(asyncUrl).toContain('name=unfold_papercraft');
  });

  it('unfolds a boxLattice and hexagonal prism and packs multiple parts across sheets', () => {
    const cage = serializeCage(boxLattice(0.0001, 200)); // 40 mm lattice cube
    const latCube: SceneNode = {
      id: 'lat_cube',
      name: 'LatticeCube',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: cage,
      geoms: [],
      joints: [],
      children: [],
    };

    const hexPrism: SceneNode = {
      id: 'hex_prism',
      name: 'HexPrism',
      pos: [0.1, 0, 0],
      geoms: [
        {
          name: 'hex',
          type: 'cylinder',
          size: [0.025, 0.03],
          facets: 6,
        },
      ],
      joints: [],
      children: [],
    };

    const res = exportSheetUnfold(
      makeScene([latCube, hexPrism]),
      {
        mode: 'papercraft',
        sheetWidthMm: 220,
        sheetHeightMm: 220,
      }
    );

    expect(res.success).toBe(true);
    // 6 faces from lattice cube + 8 faces from hex prism (6 sides + 2 caps) = 14 faces
    expect(res.totalFaces).toBe(14);
    expect(res.sheets.length).toBeGreaterThanOrEqual(2);

    // Verify targetNodeIds filter
    const filtered = exportSheetUnfold(makeScene([latCube, hexPrism]), { mode: 'papercraft' }, ['lat_cube']);
    expect(filtered.totalFaces).toBe(6);
    expect(filtered.islands).toHaveLength(1);
  });
});
