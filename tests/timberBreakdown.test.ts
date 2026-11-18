import { describe, expect, it, vi } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import {
  buildSinglePlankScene,
  decomposeSolidIntoPlanks,
  extractTimberMembers,
  meshMmToManifold,
  meshToBinaryStl,
  packPartsLayFlatMetres,
} from '../src/utils/timberBreakdown';
import { stlToMesh } from '../src/utils/stlMesh';
import type { SceneGraph } from '../src/types/scene';

const MM = 1000;

/** Convert a Manifold in mm to a triangle soup in metres (9 numbers per triangle). */
function manifoldMmToSoupMetres(m: import('manifold-3d').Manifold): Float64Array {
  const mesh = m.getMesh();
  const p = mesh.numProp;
  const soup = new Float64Array(mesh.numTri * 9);
  for (let t = 0; t < mesh.numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k];
      soup[t * 9 + k * 3] = mesh.vertProperties[v * p] / MM;
      soup[t * 9 + k * 3 + 1] = mesh.vertProperties[v * p + 1] / MM;
      soup[t * 9 + k * 3 + 2] = mesh.vertProperties[v * p + 2] / MM;
    }
  }
  return soup;
}

/** Verify that no two planks in a breakdown result have 3D boolean intersection. */
function measureTotalInterferenceMm3(
  wasm: import('manifold-3d').ManifoldToplevel,
  planks: { positionsMm: Float32Array; faces: Uint32Array }[],
): number {
  const manifolds = planks.map((p) => meshMmToManifold(wasm, p.positionsMm, p.faces));
  try {
    let total = 0;
    for (let i = 0; i < manifolds.length; i++) {
      for (let j = i + 1; j < manifolds.length; j++) {
        const inter = manifolds[i].intersect(manifolds[j]);
        total += inter.volume();
        inter.delete();
      }
    }
    return total;
  } finally {
    for (const m of manifolds) m.delete();
  }
}

function makeCubeSoupMetres(
  wasm: import('manifold-3d').ManifoldToplevel,
  sizeMm: [number, number, number],
): Float64Array {
  const cube = wasm.Manifold.cube(sizeMm, true);
  const soup = manifoldMmToSoupMetres(cube);
  cube.delete();
  return soup;
}

describe('Timber Plank & Hollow-Shell Breakdown Engine', () => {
  it('1. decomposes a solid block into a 6-wall hollow shell with interlocking rabbet joints and zero 3D overlap', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [160, 140, 120]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'rabbet',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
      maxBoardWidthMm: 200,
      maxBoardLengthMm: 1200,
      dowelDiaMm: 6,
      hollowInterior: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.planks.length).toBe(6);
    expect(res.hollowedVolumeMm3).toBeGreaterThan(500_000);
    expect(res.totalVolumeMm3).toBeLessThan(res.originalVolumeMm3);
    expect(measureTotalInterferenceMm3(wasm, res.planks)).toBeLessThan(0.5);
  });

  it('2. decomposes a solid block with 45° miter corner joints and zero 3D overlap', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [150, 150, 150]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'miter',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
      maxBoardWidthMm: 200,
      dowelDiaMm: 0,
      hollowInterior: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.planks.length).toBe(6);
    // In a symmetric 150mm cube with 45° mitered walls on all 12 edges, all 6 walls have equal volume!
    const v0 = res.planks[0].volumeMm3;
    for (const p of res.planks) {
      expect(p.volumeMm3).toBeCloseTo(v0, -2);
    }
    expect(measureTotalInterferenceMm3(wasm, res.planks)).toBeLessThan(0.5);
  });

  it('3. decomposes a solid block with interlocking finger (box) joints and zero 3D overlap', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [160, 140, 120]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'finger',
      fingerWidthMm: 20,
      boardThicknessMm: 16,
      wallThicknessMm: 16,
      maxBoardWidthMm: 200,
      dowelDiaMm: 0,
      hollowInterior: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.planks.length).toBe(6);
    expect(measureTotalInterferenceMm3(wasm, res.planks)).toBeLessThan(0.5);
  });

  it('4. decomposes a solid block with butt joints and bores alignment dowel holes across corners', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [180, 160, 140]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'butt',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
      maxBoardWidthMm: 220,
      dowelDiaMm: 8,
      dowelLengthMm: 30,
      hollowInterior: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.planks.length).toBe(6);
    const totalDowelHoles = res.planks.reduce((s, p) => s + p.dowelHoles.length, 0);
    expect(totalDowelHoles).toBeGreaterThanOrEqual(16);
    expect(measureTotalInterferenceMm3(wasm, res.planks)).toBeLessThan(0.5);
  });

  it('5. disabling dowels (dowelDiaMm: 0) omits dowel holes and leaves higher plank volume', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [160, 160, 120]);

    const withDowels = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'butt',
      dowelDiaMm: 8,
      maxBoardWidthMm: 200,
    });
    const noDowels = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'butt',
      dowelDiaMm: 0,
      maxBoardWidthMm: 200,
    });

    expect(withDowels.ok && noDowels.ok).toBe(true);
    if (!withDowels.ok || !noDowels.ok) return;

    expect(noDowels.planks.every((p) => p.dowelHoles.length === 0)).toBe(true);
    expect(noDowels.totalVolumeMm3).toBeGreaterThan(withDowels.totalVolumeMm3);
  });

  it('6. splits wide walls across the grain when width exceeds maxBoardWidthMm and adds seam dowels', async () => {
    const wasm = await loadManifold();
    // 320 x 320 x 160 mm box with maxBoardWidthMm = 120 -> 320 mm walls split into 3 planks each
    const soup = makeCubeSoupMetres(wasm, [320, 320, 160]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'rabbet',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
      maxBoardWidthMm: 120,
      dowelDiaMm: 8,
      hollowInterior: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.planks.length).toBeGreaterThan(10);
    for (const p of res.planks) {
      expect(p.dimensionsMm[1]).toBeLessThanOrEqual(120.5);
    }
    expect(res.warnings.some((w) => w.includes('exceeds max board width'))).toBe(true);
  });

  it('7. splices planks along the grain when length exceeds maxBoardLengthMm', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [500, 120, 120]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'butt',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
      maxBoardWidthMm: 150,
      maxBoardLengthMm: 220,
      hollowInterior: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const p of res.planks) {
      expect(p.dimensionsMm[0]).toBeLessThanOrEqual(220.5);
    }
    expect(res.warnings.some((w) => w.includes('exceeds max board length'))).toBe(true);
  });

  it('8. slices a solid into laminated board layers when hollowInterior is false', async () => {
    const wasm = await loadManifold();
    // 200 x 150 x 54 mm block with boardThicknessMm = 18 -> 3 laminated Z layers
    const soup = makeCubeSoupMetres(wasm, [200, 150, 54]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      hollowInterior: false,
      boardThicknessMm: 18,
      maxBoardWidthMm: 200,
      dowelDiaMm: 8,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.planks.length).toBe(3);
    expect(res.hollowedVolumeMm3).toBe(0);
    for (const p of res.planks) {
      expect(p.wallFace).toBe('layer');
      expect(p.dimensionsMm[2]).toBeCloseTo(18, 0);
    }
  });

  it('9. falls back to laminated layers with a warning when hollowInterior is true on a thin slab', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [240, 180, 24]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      hollowInterior: true,
      boardThicknessMm: 12,
      wallThicknessMm: 18,
      maxBoardWidthMm: 100,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.warnings.some((w) => w.includes('too thin for a 18 mm hollow shell'))).toBe(true);
    expect(res.planks.length).toBe(4); // 2 layers x 2 planks wide
  });

  it('10. varying wallThicknessMm changes hollowedVolumeMm3 and shell board thickness', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [200, 200, 200]);

    const thinShell = decomposeSolidIntoPlanks(wasm, [soup], {
      hollowInterior: true,
      wallThicknessMm: 12,
      boardThicknessMm: 12,
      maxBoardWidthMm: 250,
    });
    const thickShell = decomposeSolidIntoPlanks(wasm, [soup], {
      hollowInterior: true,
      wallThicknessMm: 28,
      boardThicknessMm: 28,
      maxBoardWidthMm: 250,
    });

    expect(thinShell.ok && thickShell.ok).toBe(true);
    if (!thinShell.ok || !thickShell.ok) return;

    expect(thinShell.hollowedVolumeMm3).toBeGreaterThan(thickShell.hollowedVolumeMm3);
    expect(thickShell.totalVolumeMm3).toBeGreaterThan(thinShell.totalVolumeMm3);
  });

  it('11. computes outward explodedOffsetMm vectors pointing away from assembly centroid', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [180, 160, 140]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'rabbet',
      maxBoardWidthMm: 200,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    for (const p of res.planks) {
      const dotOutward =
        p.centerMm[0] * p.explodedOffsetMm[0] +
        p.centerMm[1] * p.explodedOffsetMm[1] +
        p.centerMm[2] * p.explodedOffsetMm[2];
      expect(dotOutward).toBeGreaterThan(0);
      expect(Math.hypot(...p.explodedOffsetMm)).toBeGreaterThan(20);
    }
  });

  it('12. packs planks onto a 2D Lay-Flat Sheet (layFlatPositionsM) with thickness along Z and zero 2D overlap', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [180, 150, 120]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'rabbet',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
      maxBoardWidthMm: 200,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.layFlatSheetMm[0]).toBeGreaterThan(150);
    expect(res.layFlatSheetMm[1]).toBeGreaterThan(100);

    // Every plank in layFlatPositionsM must have Z span equal to its board thickness (~18 mm = 0.018 m)
    const boxes2d: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
    for (const p of res.planks) {
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < p.layFlatPositionsM.length; i += 3) {
        const x = p.layFlatPositionsM[i];
        const y = p.layFlatPositionsM[i + 1];
        const z = p.layFlatPositionsM[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      expect((maxZ - minZ) * MM).toBeCloseTo(18, 0);
      boxes2d.push({ minX, maxX, minY, maxY });
    }

    // Check that no two 2D footprints on the lay-flat sheet overlap
    for (let i = 0; i < boxes2d.length; i++) {
      for (let j = i + 1; j < boxes2d.length; j++) {
        const a = boxes2d[i], b = boxes2d[j];
        const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
        const overlapY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
        expect(overlapX > 1e-4 && overlapY > 1e-4).toBe(false);
      }
    }
  });

  it('13. generates Markdown Bill of Materials (bomMarkdown) with per-plank dimensions, grain axis, and volume', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [160, 140, 120]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'finger',
      fingerWidthMm: 20,
      dowelDiaMm: 0,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.bomMarkdown).toContain('# Timber Plank Breakdown & Bill of Materials');
    expect(res.bomMarkdown).toContain('FINGER');
    expect(res.bomMarkdown).toContain('Plank_Bottom');
    expect(res.bomMarkdown).toContain('Plank_Top');
    expect(res.bomMarkdown).toContain('X-axis');
  });

  it('14. serializes plank meshes to binary STL (meshToBinaryStl) and round-trips through stlToMesh', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [140, 120, 100]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'rabbet',
      dowelDiaMm: 6,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const p0 = res.planks[0];
    const stlBytes = meshToBinaryStl(p0.positionsMm, p0.faces, p0.id);
    expect(stlBytes.byteLength).toBe(84 + (p0.faces.length / 3) * 50);

    const parsed = stlToMesh(stlBytes);
    expect(parsed.faces.length).toBe(p0.faces.length);
    expect(parsed.positions.length).toBeGreaterThanOrEqual(24);
  });

  it('15. builds a laid-flat single-plank SceneGraph (buildSinglePlankScene) ready for ExportSolidMachiningModal', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [180, 140, 120]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'rabbet',
      boardThicknessMm: 18,
      wallThicknessMm: 18,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Pick a vertical wall plank (e.g. Plank_Left whose normal in the assembly is [-1, 0, 0])
    const leftPlank = res.planks.find((p) => p.wallFace === '-x')!;
    const baseScene: SceneGraph = { nodes: [] };
    const { scene, sizeMm } = buildSinglePlankScene(baseScene, leftPlank);

    expect(scene.nodes.length).toBe(1);
    expect(scene.nodes[0].id).toBe(leftPlank.id);
    // Laid flat, its Z thickness must be ~18 mm!
    expect(sizeMm[2]).toBeCloseTo(18, 0);
    expect(sizeMm[0]).toBeGreaterThanOrEqual(sizeMm[1]);
  });

  it('16. packs arbitrary sections onto a 2D sheet via packPartsLayFlatMetres', async () => {
    const wasm = await loadManifold();
    const soup = makeCubeSoupMetres(wasm, [150, 120, 100]);

    const res = decomposeSolidIntoPlanks(wasm, [soup], { jointType: 'butt', dowelDiaMm: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const packed = packPartsLayFlatMetres(
      res.planks.map((p) => ({
        positionsM: p.section.positions,
        upNormal: p.upNormal,
        grainAxis: p.grainAxis,
      })),
    );
    expect(packed.layFlatPositionsM.length).toBe(res.planks.length);
    expect(packed.sheetSizeMm[0]).toBeGreaterThan(100);
    expect(packed.sheetSizeMm[1]).toBeGreaterThan(100);
  });

  it('17. classifies 45° knee braces as rails (Brace_*) and vertical bookcase side walls as Side_Left/Side_Right', async () => {
    const wasm = await loadManifold();
    // 1. 45° knee brace alongside two legs and an apron
    const legL = wasm.Manifold.cube([45, 45, 600], true).translate([-177.5, 0, 300]);
    const legR = wasm.Manifold.cube([45, 45, 600], true).translate([177.5, 0, 300]);
    const apron = wasm.Manifold.cube([310, 22, 60], true).translate([0, 0, 560]);
    const braceRaw = wasm.Manifold.cube([160, 22, 35], true).rotate([0, -45, 0]);
    const brace = braceRaw.translate([-105, 0, 480]);
    braceRaw.delete();

    const frameSoups = [legL, legR, apron, brace].map(manifoldMmToSoupMetres);
    legL.delete(); legR.delete(); apron.delete(); brace.delete();

    const extracted = extractTimberMembers(wasm, frameSoups, { splitWidePanels: false });
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.members.filter((m) => m.role === 'leg').length).toBe(2);
    expect(extracted.members.filter((m) => m.role === 'rail').length).toBe(2);
    expect(extracted.members.some((m) => m.id.startsWith('Brace_'))).toBe(true);

    // 2. Vertical bookcase side walls (20 x 300 x 800) + horizontal shelf (380 x 300 x 20)
    const sideL = wasm.Manifold.cube([20, 300, 800], true).translate([-200, 0, 400]);
    const sideR = wasm.Manifold.cube([20, 300, 800], true).translate([200, 0, 400]);
    const shelf = wasm.Manifold.cube([380, 300, 20], true).translate([0, 0, 400]);
    const caseSoups = [sideL, sideR, shelf].map(manifoldMmToSoupMetres);
    sideL.delete(); sideR.delete(); shelf.delete();

    const caseRes = extractTimberMembers(wasm, caseSoups, { maxBoardWidthMm: 350, splitWidePanels: true });
    expect(caseRes.ok).toBe(true);
    if (!caseRes.ok) return;
    const ids = caseRes.members.map((m) => m.id).sort();
    expect(ids).toEqual(['Shelf_1', 'Side_Left', 'Side_Right']);
    // Neither vertical side wall should be misclassified as a coplanar tabletop plank
    for (const m of caseRes.members) {
      expect(m.plankInfo).toBeUndefined();
    }
    const left = caseRes.members.find((m) => m.id === 'Side_Left')!;
    const right = caseRes.members.find((m) => m.id === 'Side_Right')!;
    expect(left.face1.normal[0]).toBeLessThan(-0.9);
    expect(right.face1.normal[0]).toBeGreaterThan(0.9);
  });

  it('18. resolves bodyId and withIds by human-readable body name via toId in BREAKDOWN_JOINERY', async () => {
    if (typeof globalThis.navigator === 'undefined') {
      vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    }
    const { partBuildCommands } = await import('../src/hooks/mcp/partBuildCommands');
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'node_uuid_leg_1',
          name: 'MyLeftLeg',
          pos: [-0.1775, 0, 0.3],
          geoms: [{ name: 'g', type: 'box', size: [0.0225, 0.0225, 0.3] }],
          joints: [],
          children: [],
        },
        {
          id: 'node_uuid_leg_2',
          name: 'MyRightLeg',
          pos: [0.1775, 0, 0.3],
          geoms: [{ name: 'g', type: 'box', size: [0.0225, 0.0225, 0.3] }],
          joints: [],
          children: [],
        },
        {
          id: 'node_uuid_rail',
          name: 'MyFrontApron',
          pos: [0, 0, 0.56],
          geoms: [{ name: 'g', type: 'box', size: [0.155, 0.011, 0.03] }],
          joints: [],
          children: [],
        },
      ],
    };
    const toId = (v: unknown) => {
      const hit = scene.nodes.find((n) => n.id === v || n.name === v);
      return hit ? hit.id : v;
    };
    const res = (await partBuildCommands.BREAKDOWN_JOINERY(
      {
        body_id: 'MyLeftLeg',
        with_ids: ['MyRightLeg', 'MyFrontApron'],
        mode: 'frame',
        joint_mode: 'mortise_tenon',
      },
      {
        store: {
          sceneGraph: scene,
          selectedNodeId: null,
          cncBed: { widthMm: 300, depthMm: 300, heightMm: 60 },
        } as never,
        toId,
      },
    )) as { ok: boolean; parts?: unknown[]; joints?: unknown[] };
    expect(res.ok).toBe(true);
    expect(res.parts?.length).toBe(3);
    expect(res.joints?.length).toBe(2);
  });
});

