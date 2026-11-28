import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { useStore } from '../src/store/useStore';
import {
  applyDab,
  canvasFromLayer,
  compositePaintLayers,
  layerFromCanvas,
  paintMeshResolution,
  paintSurfacePositionsZup,
  subdivideMeshForPaint,
  transferPaintLayer,
} from '../src/utils/vertexPaint';
import { repairSceneGeom } from '../src/utils/meshRepair';
import {
  icosphere,
  isWatertight,
  meshBounds,
  toSceneGeom,
  type SculptMesh,
} from '../src/utils/sculptMesh';
import { applySculptStroke, BRUSH_TYPES } from '../src/utils/sculptCommands';
import { cutSculptWith, loadManifold } from '../src/utils/sculptCut';
import { grooveAlongSurface } from '../src/utils/sculptCarve';
import { applySinglePatternToBody, applyPaintStrokeToBody } from '../src/hooks/mcp/bodyFeatures';
import { sculptCommands } from '../src/hooks/mcp/sculptCommands';
import { applySurfaceTextures } from '../src/utils/surfaceTexture';
import type { SceneGeom, SceneNode } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

function makeSculptNode(id: string, mesh: SculptMesh): SceneNode {
  const { vertices, renderVertices, faces } = toSceneGeom(mesh);
  return {
    id,
    name: id,
    pos: [0, 0, 0.05],
    isSculpt: true,
    sculptBase: 'sphere',
    geoms: [{
      name: `${id}_mesh`,
      type: 'mesh',
      dynamic: true,
      vertices,
      renderVertices,
      faces,
      rgba: [0.8, 0.8, 0.8, 1],
    }],
  };
}

describe('Item 1: physics_apply_pattern preserves physics_paint vertex colors', () => {
  it('transfers vertex paint onto a patterned mesh and composites pattern color on top', () => {
    const ball = icosphere(0.03, 3);
    const { vertices, renderVertices, faces } = toSceneGeom(ball);
    // Paint +Z hemisphere bright red on the authored mesh.
    const res = paintMeshResolution(renderVertices);
    const sub = subdivideMeshForPaint(renderVertices, faces, res);
    const canvas = canvasFromLayer(undefined, sub.positions.length / 3, res);
    applyDab(canvas, sub.positions, {
      x: 0, y: 0, z: 0.03, radius: 0.025, color: [1, 0, 0], flow: 1, hardness: 0.8,
    }, sub.faces);
    const basePaint = layerFromCanvas(canvas)!;
    expect(basePaint.idx.length).toBeGreaterThan(20);

    // Build a patterned surface (different vertex count & re-meshed triangles).
    const geom: SceneGeom = {
      name: 'ball_mesh',
      type: 'mesh',
      dynamic: true,
      vertices,
      renderVertices,
      faces,
      rgba: [0.8, 0.8, 0.8, 1],
      paint: basePaint,
    };
    const textured = applySurfaceTextures(
      renderVertices,
      faces,
      [{
        pattern: 'fluted',
        options: { pitchMm: 6, profile: 'round', angleDeg: 0 },
        depthM: -0.001,
        borderM: 0.001,
        cellM: 0.0015,
        seedAt: [0, 0, 0.03],
        seedNormal: [0, 0, 1],
      }],
    );
    expect(textured.regions[0]?.applied).toBe(true);
    expect(textured.vertices.length).not.toBe(renderVertices.length);

    // Reconstruct Z-up paint source positions and transfer onto patterned vertices.
    const srcZup = paintSurfacePositionsZup({
      type: 'mesh',
      paint: basePaint,
      vertices: geom.vertices,
      renderVertices: geom.renderVertices,
      faces: geom.faces,
      dynamic: geom.dynamic,
    });
    expect(srcZup).not.toBeNull();
    const transferred = transferPaintLayer(srcZup!, basePaint, textured.vertices);
    expect(transferred).toBeDefined();
    expect(transferred!.idx.length).toBeGreaterThan(20);

    // Verify top (+Z) vertices of the patterned mesh are red, and bottom (-Z) are bare.
    const patCanvas = canvasFromLayer(transferred, textured.vertices.length / 3, []);
    let topRed = 0, bottomPainted = 0;
    for (let v = 0; v < patCanvas.count; v++) {
      const z = textured.vertices[v * 3 + 2];
      const r = patCanvas.data[v * 4];
      const a = patCanvas.data[v * 4 + 3];
      if (z > 0.025 && a > 0.5 && r > 0.8) topRed++;
      if (z < -0.02 && a > 0.1) bottomPainted++;
    }
    expect(topRed).toBeGreaterThan(5);
    expect(bottomPainted).toBe(0);

    // Compositing a blue pattern accent layer on top preserves red paint elsewhere.
    const patternAccent = { res: [], idx: [0], rgba: [0, 0, 255, 255] };
    const composited = compositePaintLayers(transferred, patternAccent, textured.vertices.length / 3)!;
    const compCanvas = canvasFromLayer(composited, textured.vertices.length / 3, []);
    expect(compCanvas.data[2]).toBeCloseTo(1, 2); // vertex 0 is blue
    expect(composited.idx.length).toBeGreaterThanOrEqual(transferred!.idx.length);
  });
});

describe('Item 2: physics_repair_mesh preserves physics_paint vertex colors', () => {
  it('remaps vertex paint cleanly when welding duplicate vertices and removing degenerates', () => {
    const ball = icosphere(0.03, 2);
    // Deliberately unweld every triangle (3x vertices) + append a degenerate face
    // so repairSceneGeom welds & compacts vertex indices heavily.
    const unweldedPos: number[] = [];
    const unweldedFaces: number[] = [];
    for (let f = 0; f < ball.faceCount; f++) {
      for (let k = 0; k < 3; k++) {
        const vi = ball.faces[f * 3 + k];
        unweldedFaces.push(unweldedPos.length / 3);
        unweldedPos.push(ball.positions[vi * 3], ball.positions[vi * 3 + 1], ball.positions[vi * 3 + 2]);
      }
    }
    // Add a degenerate triangle at index 0..2 by duplicating vertex 0.
    unweldedFaces.push(0, 0, 1);

    // Paint the +Z cap green on the unwelded mesh (res: []).
    const vCount = unweldedPos.length / 3;
    const canvas = canvasFromLayer(undefined, vCount, []);
    applyDab(canvas, unweldedPos, {
      x: 0, y: 0, z: 0.03, radius: 0.02, color: [0, 1, 0], flow: 1, hardness: 0.9,
    }, unweldedFaces);
    const paintBefore = layerFromCanvas(canvas)!;
    expect(paintBefore.idx.length).toBeGreaterThan(10);

    const geom: SceneGeom = {
      name: 'unwelded',
      type: 'mesh',
      dynamic: true,
      renderVertices: unweldedPos,
      faces: unweldedFaces,
      rgba: [0.8, 0.8, 0.8, 1],
      paint: paintBefore,
    };

    const repaired = repairSceneGeom(geom, { weldTolerance: 1e-5 });
    expect(repaired).not.toBeNull();
    expect(repaired!.report.weldedVertices).toBeGreaterThan(100);
    expect(repaired!.report.removedDegenerate).toBeGreaterThanOrEqual(1);

    const afterGeom = repaired!.geom;
    expect(afterGeom.paint).toBeDefined();
    const afterPos = afterGeom.renderVertices!;
    const afterCanvas = canvasFromLayer(afterGeom.paint, afterPos.length / 3, afterGeom.paint!.res);

    let topGreen = 0;
    let bottomPainted = 0;
    for (let v = 0; v < afterCanvas.count; v++) {
      const z = afterPos[v * 3 + 2];
      const g = afterCanvas.data[v * 4 + 1];
      const a = afterCanvas.data[v * 4 + 3];
      if (z > 0.024 && a > 0.5 && g > 0.8) topGreen++;
      if (z < -0.015 && a > 0.1) bottomPainted++;
    }
    expect(topGreen).toBeGreaterThan(3);
    expect(bottomPainted).toBe(0);
  });
});

describe('Item 3: physics_sculpt_carve(fill: true) performance on ~20k-face sculpts', () => {
  it('carves a closed filled pocket on a 20,480-face sculpt quickly and stays watertight', () => {
    // icosphere(r, 5) has 20 * 4^5 = 20,480 faces!
    const clay = icosphere(0.05, 5);
    expect(clay.faceCount).toBe(20480);

    // Closed 24mm diameter circle on the +Z crown.
    const rLoop = 0.012;
    const outline = Array.from({ length: 24 }, (_, i) => {
      const a = (i / 24) * Math.PI * 2;
      const x = Math.cos(a) * rLoop;
      const y = Math.sin(a) * rLoop;
      const z = Math.sqrt(Math.max(0, 0.05 * 0.05 - x * x - y * y));
      return [x, y, z];
    });

    const t0 = performance.now();
    const { spec } = grooveAlongSurface(clay, outline, {
      width: 0.003, depth: 0.003, profile: 'round', fill: true,
    });
    const result = cutSculptWith(wasm, clay, spec);
    const elapsedMs = performance.now() - t0;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(isWatertight(result.mesh)).toBe(true);
    // Must complete well under the 60s worker timeout (typically < 3-6s).
    expect(elapsedMs).toBeLessThan(15_000);

    // Verify center of pocket on +Z crown was carved down by ~3mm.
    let centerDeepest = 0;
    for (let i = 0; i < result.mesh.vertexCount; i++) {
      const x = result.mesh.positions[i * 3];
      const y = result.mesh.positions[i * 3 + 1];
      const z = result.mesh.positions[i * 3 + 2];
      if (z > 0.03 && Math.hypot(x, y) < 0.006) {
        centerDeepest = Math.max(centerDeepest, 0.05 - Math.hypot(x, y, z));
      }
    }
    expect(centerDeepest * 1000).toBeGreaterThan(2.5);
  }, 30_000);
});

describe('Item 4: physics_apply_pattern propagates top-level cellMm for kumiko & cell-based generators', () => {
  it('propagates top-level cellMm into options.cellMm for kumiko while keeping fine mesh cellM', async () => {
    const boxNode: SceneNode = {
      id: 'kumiko_box',
      name: 'kumiko_box',
      pos: [0, 0, 0.05],
      geoms: [{
        name: 'panel',
        type: 'box',
        size: [0.05, 0.05, 0.01],
        rgba: [0.8, 0.7, 0.5, 1],
      }],
    };
    useStore.setState((s) => ({
      sceneGraph: { ...s.sceneGraph, nodes: [boxNode] },
    }));

    const res = await applySinglePatternToBody('kumiko_box', {
      at: [0, 0, 10],
      normal: [0, 0, 1],
      pattern: 'kumiko',
      cellMm: 14,
      depthMm: 1.5,
    });
    expect(res.ok).toBe(true);
    expect((res.options as Record<string, unknown>).cellMm).toBe(14);

    // Stored texture keeps fine mesh sampling cellM (~0.4mm), NOT 14mm!
    const storedNode = useStore.getState().sceneGraph.nodes.find((n) => n.id === 'kumiko_box')!;
    const tex = storedNode.geoms[0].textures![0];
    expect(tex.options?.cellMm).toBe(14);
    expect(tex.cellM).toBeLessThan(0.002);

    // Explicit options.cellMm is respected while top-level cellMm sets mesh detail.
    const res2 = await applySinglePatternToBody('kumiko_box', {
      at: [0, 0, 10],
      normal: [0, 0, 1],
      pattern: 'kumiko',
      cellMm: 0.6,
      options: { cellMm: 18 },
      depthMm: 1.5,
    });
    expect(res2.ok).toBe(true);
    expect((res2.options as Record<string, unknown>).cellMm).toBe(18);
    const storedTex2 = useStore.getState().sceneGraph.nodes.find((n) => n.id === 'kumiko_box')!.geoms[0].textures![0];
    expect(storedTex2.cellM).toBeCloseTo(0.0006, 5);
  });
});

describe('Items 5 & 6: numeric maxDisplacement with dynamicTopology + clay & crease brushes', () => {
  it('returns finite numeric maxDisplacement when topologyChanged is true', () => {
    const mesh = icosphere(0.05, 2);
    const res = applySculptStroke(mesh, {
      brush: 'draw',
      at: [[0, 0, 0.05], [0.005, 0, 0.0497]],
      radius: 0.015,
      strength: 0.8,
      dynamicTopology: true,
    });
    expect(res.topologyChanged).toBe(true);
    expect(typeof res.maxDisplacement).toBe('number');
    expect(Number.isFinite(res.maxDisplacement)).toBe(true);
    expect(res.maxDisplacement).toBeGreaterThan(0.0005);
  });

  it('supports clay brush (additive buildup & inverted carve) and crease brush (sharp V-indent & inverted ridge)', () => {
    expect(BRUSH_TYPES).toContain('clay');
    expect(BRUSH_TYPES).toContain('crease');

    // Clay additive buildup raises the +Z crown and stays watertight.
    const clayMesh = icosphere(0.05, 3);
    const beforeClayMaxZ = meshBounds(clayMesh).max[2];
    const clayRes = applySculptStroke(clayMesh, {
      brush: 'clay',
      at: [[0, 0, 0.05], [0.004, 0, 0.0498], [-0.004, 0, 0.0498]],
      radius: 0.018,
      strength: 0.8,
      dynamicTopology: true,
    });
    expect(clayRes.applied).toBe(3);
    expect(clayRes.watertight).toBe(true);
    expect(clayRes.maxDisplacement).toBeGreaterThan(0.0005);
    expect(meshBounds(clayMesh).max[2]).toBeGreaterThan(beforeClayMaxZ);

    // Crease carves inward along -normal by default and stays watertight.
    const creaseMesh = icosphere(0.05, 3);
    const creaseRes = applySculptStroke(creaseMesh, {
      brush: 'crease',
      at: [[0, -0.01, 0.049], [0, 0, 0.05], [0, 0.01, 0.049]],
      radius: 0.012,
      strength: 0.8,
      dynamicTopology: true,
    });
    expect(creaseRes.applied).toBe(3);
    expect(creaseRes.watertight).toBe(true);
    expect(creaseRes.maxDisplacement).toBeGreaterThan(0.0005);
    // Crown center vertex should have moved inward (< 0.05).
    let minCenterR = Infinity;
    for (let i = 0; i < creaseMesh.vertexCount; i++) {
      const x = creaseMesh.positions[i * 3];
      const y = creaseMesh.positions[i * 3 + 1];
      const z = creaseMesh.positions[i * 3 + 2];
      if (z > 0.04 && Math.hypot(x, y) < 0.004) {
        minCenterR = Math.min(minCenterR, Math.hypot(x, y, z));
      }
    }
    expect(minCenterR).toBeLessThan(0.0495);

    // Inverted crease raises a sharp ridge outward.
    const ridgeMesh = icosphere(0.05, 3);
    const beforeRidgeMaxZ = meshBounds(ridgeMesh).max[2];
    const ridgeRes = applySculptStroke(ridgeMesh, {
      brush: 'crease',
      at: [[0, 0, 0.05]],
      radius: 0.015,
      strength: 0.8,
      invert: true,
      dynamicTopology: false,
    });
    expect(ridgeRes.watertight).toBe(true);
    expect(meshBounds(ridgeMesh).max[2]).toBeGreaterThan(beforeRidgeMaxZ);
  });
});

describe('Item 7: symmetry support in physics_paint', () => {
  it('mirrors paint strokes across x, y, or z axis in geom frame', () => {
    const mesh = icosphere(0.03, 3);
    const node = makeSculptNode('paint_sym_ball', mesh);
    useStore.setState((s) => ({
      sceneGraph: { ...s.sceneGraph, nodes: [node] },
    }));

    const res = applyPaintStrokeToBody('paint_sym_ball', {
      at: [0, 30, 0],
      radius: 10,
      rgba: [1, 0, 0],
      symmetry: 'y',
    });
    expect(res.ok).toBe(true);
    expect(res.dabsLanded).toBe(2);

    const updated = useStore.getState().sceneGraph.nodes.find((n) => n.id === 'paint_sym_ball')!;
    const geom = updated.geoms[0];
    const sub = subdivideMeshForPaint(geom.renderVertices!, geom.faces!, geom.paint!.res);
    const canvas = canvasFromLayer(geom.paint, sub.positions.length / 3, geom.paint!.res);

    let plusY = 0, minusY = 0;
    for (let v = 0; v < canvas.count; v++) {
      if (canvas.data[v * 4 + 3] > 0.5) {
        const y = sub.positions[v * 3 + 1];
        if (y > 0.02) plusY++;
        if (y < -0.02) minusY++;
      }
    }
    expect(plusY).toBeGreaterThan(5);
    expect(minusY).toBeGreaterThan(5);

    // Invalid symmetry axis is rejected.
    expect(() => applyPaintStrokeToBody('paint_sym_ball', {
      at: [0, 0.03, 0], rgba: [1, 0, 0], symmetry: 'w',
    })).toThrow(/symmetry/);
  });
});

describe('Item 8: fast vessel/planter hollowing on sculpts', () => {
  it('hollows a 20,480-face sculpt into a watertight flat-bottomed vessel quickly', () => {
    const clay = icosphere(0.05, 5);
    expect(clay.faceCount).toBe(20480);

    const t0 = performance.now();
    const res = cutSculptWith(wasm, clay, {
      kind: 'hollow',
      wall: 0.008,
      floor: 0.01,
      segments: 48,
    });
    const elapsedMs = performance.now() - t0;

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(isWatertight(res.mesh)).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);

    // Cavity floor should sit at zMin + floor = -0.05 + 0.01 = -0.04,
    // and bottom exterior should still reach -0.05.
    const bounds = meshBounds(res.mesh);
    expect(bounds.min[2]).toBeCloseTo(-0.05, 3);
    let floorVerts = 0;
    for (let i = 0; i < res.mesh.vertexCount; i++) {
      const x = res.mesh.positions[i * 3];
      const y = res.mesh.positions[i * 3 + 1];
      const z = res.mesh.positions[i * 3 + 2];
      if (Math.hypot(x, y) < 0.03 && Math.abs(z - (-0.04)) < 0.001) floorVerts++;
    }
    expect(floorVerts).toBeGreaterThan(5);
  }, 20_000);

  it('supports polygon + depthMm blind pocket on SCULPT_CUT without piercing the bottom', async () => {
    const clay = icosphere(0.04, 3);
    const node = makeSculptNode('blind_pocket_ball', clay);
    useStore.setState((s) => ({
      sceneGraph: { ...s.sceneGraph, nodes: [node] },
    }));

    const r = 15;
    const square = [[-r, -r, 40], [r, -r, 40], [r, r, 40], [-r, r, 40]];
    const res = await sculptCommands.SCULPT_CUT({
      targetId: 'blind_pocket_ball',
      polygon: square,
      direction: [0, 0, -1],
      depthMm: 20,
    }, { store: useStore.getState(), recompile: async () => {}, toId: (s) => s } as never) as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.watertight).toBe(true);
    // Pocket depth 20mm from z=0.04 stops at z=0.02; bottom of sphere at z=-0.04 is untouched.
    const bounds = res.bounds as { min: number[]; max: number[] };
    expect(bounds.min[2]).toBeCloseTo(-0.04, 3);
  });
});

describe('Item 9: mm convenience aliases (atMm / radiusMm) on sculpt & paint', () => {
  it('accepts atMm and radiusMm on physics_paint and physics_sculpt', async () => {
    const clay = icosphere(0.04, 3);
    const node = makeSculptNode('mm_alias_ball', clay);
    useStore.setState((s) => ({
      sceneGraph: { ...s.sceneGraph, nodes: [node] },
    }));

    const paintRes = applyPaintStrokeToBody('mm_alias_ball', {
      atMm: [0, 0, 40],
      radiusMm: 10,
      rgba: [0, 0, 1],
    });
    expect(paintRes.ok).toBe(true);
    expect(paintRes.dabsLanded).toBe(1);

    const sculptRes = await sculptCommands.SCULPT({
      targetId: 'mm_alias_ball',
      brush: 'clay',
      atMm: [0, 0, 40],
      radiusMm: 12,
      strength: 0.7,
    }, { store: useStore.getState(), recompile: async () => {}, toId: (s) => s } as never) as Record<string, unknown>;
    expect(sculptRes.ok).toBe(true);
    expect(sculptRes.applied).toBe(1);
    expect(typeof sculptRes.maxDisplacement).toBe('number');
    expect(sculptRes.maxDisplacement as number).toBeGreaterThan(0);
  });
});
