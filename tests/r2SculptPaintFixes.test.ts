import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { applyDab, canvasFromLayer, emptyCanvas, paintArgsFromSize, paintResolution, buildPaintGeometry } from '../src/utils/vertexPaint';
import { applyPaintStrokeToBody } from '../src/hooks/mcp/bodyFeatures';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { sculptCommands, withSculptBodyLock } from '../src/hooks/mcp/sculptCommands';
import { sculptHistory } from '../src/hooks/mcp/sculptState';
import { toSceneGeom } from '../src/utils/sculptMesh';
import { buildSculptBaseSized } from '../src/utils/sculptBases';
import { applySculptStroke } from '../src/utils/sculptCommands';
import { analyseDfm, narrowestAirGap, PRINT_MIN_AIR_GAP_MM } from '../src/utils/dfm';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { McpContext } from '../src/hooks/mcp/types';

function makeSphereNode(id: string, radius = 0.02): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos: [0, 0, radius],
    quat: [1, 0, 0, 0],
    geoms: [
      {
        name: `${id}_geom`,
        type: 'sphere',
        size: [radius],
        rgba: [0.8, 0.8, 0.8, 1],
      },
    ],
    joints: [],
    children: [],
  };
}

function makeSculptNode(id: string, diameter = 0.08): SceneNode {
  const mesh = buildSculptBaseSized('sphere', diameter);
  const { vertices, renderVertices, faces } = toSceneGeom(mesh);
  return {
    id,
    name: id,
    type: 'body',
    pos: [0, 0, diameter / 2],
    quat: [1, 0, 0, 0],
    isSculpt: true,
    sculptBase: 'sphere',
    sculptVersion: 1,
    geoms: [
      {
        name: `${id}_clay`,
        type: 'mesh',
        size: [1],
        rgba: [0.82, 0.72, 0.62, 1],
        vertices,
        renderVertices,
        faces,
      },
    ],
    joints: [],
    children: [],
  };
}

function mockCtx(): McpContext {
  return {
    store: useStore.getState(),
    recompile: async () => {},
  } as unknown as McpContext;
}

/** Extrudes a 2D closed CCW polygon in the XZ plane along Y in [-halfY, +halfY] into an outward-wound mesh. */
function extrudeXZPolygon(poly: [number, number][], halfY: number): { verts: number[]; faces: number[] } {
  const n = poly.length;
  const verts: number[] = [];
  for (const [x, z] of poly) verts.push(x, -halfY, z);
  for (const [x, z] of poly) verts.push(x, halfY, z);
  const faces: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(i, n + i, n + j);
    faces.push(i, n + j, j);
  }
  const idx = Array.from({ length: n }, (_, k) => k);
  const cross2 = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => {
    const c1 = cross2(a, b, p), c2 = cross2(b, c, p), c3 = cross2(c, a, p);
    return c1 >= -1e-12 && c2 >= -1e-12 && c3 >= -1e-12;
  };
  const capTris: [number, number, number][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 500) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length];
      const b = idx[k];
      const c = idx[(k + 1) % idx.length];
      if (cross2(poly[a], poly[b], poly[c]) <= 1e-12) continue;
      let contains = false;
      for (const m of idx) {
        if (m === a || m === b || m === c) continue;
        if (inTri(poly[m], poly[a], poly[b], poly[c])) { contains = true; break; }
      }
      if (!contains) {
        capTris.push([a, b, c]);
        idx.splice(k, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) capTris.push([idx[0], idx[1], idx[2]]);
  for (const [a, b, c] of capTris) {
    faces.push(a, b, c);
    faces.push(n + a, n + c, n + b);
  }
  return { verts, faces };
}

function meshToFlatTris(m: { verts: number[]; faces: number[] }): Float64Array {
  const out = new Float64Array(m.faces.length * 3);
  for (let i = 0; i < m.faces.length; i++) {
    const vi = m.faces[i] * 3;
    out[i * 3] = m.verts[vi];
    out[i * 3 + 1] = m.verts[vi + 1];
    out[i * 3 + 2] = m.verts[vi + 2];
  }
  return out;
}

describe('Round 2 Sculpt / Paint / DFM fixes', () => {
  beforeEach(() => {
    sculptHistory.clear();
  });

  // -------------------------------------------------------------------------
  // Item 1: physics_paint overwrites already-painted vertices (flow=1)
  // -------------------------------------------------------------------------
  describe('Item 1: src-over vertex painting overwrites already-painted vertices', () => {
    it('applyDab with flow=1 overwrites opaque white with charcoal', () => {
      const positions = new Float32Array([0, 0, 0, 0.001, 0, 0, 0.01, 0, 0]);
      const canvas = emptyCanvas(3, []);
      const white = [0.97, 0.96, 0.92];
      const charcoal = [0.09, 0.09, 0.12];

      applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.005, color: white, flow: 1, hardness: 0.5 });
      expect(canvas.data[0]).toBeCloseTo(0.97, 3);
      expect(canvas.data[3]).toBeCloseTo(1, 3);

      applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.005, color: charcoal, flow: 1, hardness: 0.5 });
      expect(canvas.data[0]).toBeCloseTo(0.09, 3);
      expect(canvas.data[1]).toBeCloseTo(0.09, 3);
      expect(canvas.data[2]).toBeCloseTo(0.12, 3);
      expect(canvas.data[3]).toBeCloseTo(1, 3);
    });

    it('applyDab with partial flow blends over already-opaque paint instead of stalling', () => {
      const positions = new Float32Array([0, 0, 0]);
      const canvas = emptyCanvas(1, []);
      applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.005, color: [1, 1, 1], flow: 1 });
      applyDab(canvas, positions, { x: 0, y: 0, z: 0, radius: 0.005, color: [0, 0, 0], flow: 0.5 });

      expect(canvas.data[0]).toBeCloseTo(0.5, 3);
      expect(canvas.data[3]).toBeCloseTo(1, 3);
    });

    it('physics_paint overwrites white vertices with charcoal on a body geom', () => {
      const ball = makeSphereNode('r2_paint_ball', 0.02);
      useStore.setState({ sceneGraph: { nodes: [ball] } });

      // Coat top of sphere white (flow=1)
      const whiteRes = applyPaintStrokeToBody('r2_paint_ball', {
        atMm: [0, 0, 20],
        radiusMm: 10,
        rgba: [0.97, 0.96, 0.92],
        flow: 1,
        hardness: 0.5,
      });
      expect(whiteRes.ok).toBe(true);
      expect(whiteRes.verticesPainted).toBeGreaterThan(0);

      // Paint charcoal dot over the white coat (flow=1)
      const charcoalRes = applyPaintStrokeToBody('r2_paint_ball', {
        atMm: [0, 0, 20],
        radiusMm: 5,
        rgba: [0.09, 0.09, 0.12],
        flow: 1,
        hardness: 0.5,
      });
      expect(charcoalRes.ok).toBe(true);
      expect(charcoalRes.dabsLanded).toBe(1);
      expect(charcoalRes.verticesPainted).toBeGreaterThan(0);

      const geom = useStore.getState().sceneGraph.nodes[0].geoms[0];
      expect(geom.paint).toBeDefined();
      const args = paintArgsFromSize('sphere', geom.size);
      const res = geom.paint!.res.length ? geom.paint!.res : paintResolution('sphere', args);
      const built = buildPaintGeometry('sphere', args, res)!;
      const pos = built.getAttribute('position').array as Float32Array;
      const canvas = canvasFromLayer(geom.paint, pos.length / 3, res);
      built.dispose();

      // Find vertices near the pole (0, 0, 0.02) and verify they are charcoal, NOT white!
      let charcoalVerts = 0;
      for (let v = 0; v < canvas.count; v++) {
        const dx = pos[v * 3], dy = pos[v * 3 + 1], dz = pos[v * 3 + 2] - 0.02;
        if (dx * dx + dy * dy + dz * dz < 0.002 * 0.002) {
          expect(canvas.data[v * 4]).toBeLessThan(0.15);
          expect(canvas.data[v * 4 + 1]).toBeLessThan(0.15);
          expect(canvas.data[v * 4 + 2]).toBeLessThan(0.2);
          expect(canvas.data[v * 4 + 3]).toBeGreaterThan(0.95);
          charcoalVerts++;
        }
      }
      expect(charcoalVerts).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Item 2: physics_paint(erase=true) does not require rgba
  // -------------------------------------------------------------------------
  describe('Item 2: physics_paint(erase=true) allows omitting rgba', () => {
    it('succeeds top-level and inside strokes when erase=true and rgba is omitted', async () => {
      const ball = makeSphereNode('r2_erase_ball', 0.02);
      useStore.setState({ sceneGraph: { nodes: [ball] } });

      // First paint some vertices red
      const paintRes = await objectCommands.PAINT(
        { targetId: 'r2_erase_ball', atMm: [0, 0, 20], radiusMm: 8, rgba: [1, 0, 0], flow: 1 },
        mockCtx(),
      ) as Record<string, unknown>;
      expect(paintRes.ok).toBe(true);
      expect(paintRes.verticesPainted).toBeGreaterThan(0);

      // Erase top-level without rgba
      const eraseTop = await objectCommands.PAINT(
        { targetId: 'r2_erase_ball', atMm: [0, 0, 20], radiusMm: 4, erase: true, flow: 1 },
        mockCtx(),
      ) as Record<string, unknown>;
      expect(eraseTop.ok).toBe(true);
      expect(eraseTop.verticesPainted).toBeGreaterThan(0);

      // Erase inside strokes: [...] without rgba
      const eraseBatch = await objectCommands.PAINT(
        {
          targetId: 'r2_erase_ball',
          strokes: [{ atMm: [0, 0, 20], radiusMm: 8, erase: true, flow: 1 }],
        },
        mockCtx(),
      ) as { ok: boolean; verticesPainted: number; results: Record<string, unknown>[] };
      expect(eraseBatch.ok).toBe(true);
      expect(eraseBatch.results[0].ok).toBe(true);
      expect(eraseBatch.verticesPainted).toBeGreaterThan(0);

      // Non-erase stroke without rgba still fails validation
      const invalidRes = await objectCommands.PAINT(
        { targetId: 'r2_erase_ball', atMm: [0, 0, 20], radiusMm: 4 },
        mockCtx(),
      ) as Record<string, unknown>;
      expect(invalidRes.ok).toBe(false);
      expect(String(invalidRes.error)).toMatch(/rgba must be/);
    });
  });

  // -------------------------------------------------------------------------
  // Item 3: physics_paint reports verticesPainted
  // -------------------------------------------------------------------------
  describe('Item 3: physics_paint reply reports verticesPainted', () => {
    it('reports exact verticesPainted for single, no-op, miss, and batch strokes', async () => {
      const ball = makeSphereNode('r2_count_ball', 0.02);
      useStore.setState({ sceneGraph: { nodes: [ball] } });

      // Erasing bare surface modifies 0 vertices
      const eraseBare = await objectCommands.PAINT(
        { targetId: 'r2_count_ball', atMm: [0, 0, 20], radiusMm: 5, erase: true },
        mockCtx(),
      ) as Record<string, unknown>;
      expect(eraseBare.ok).toBe(true);
      expect(eraseBare.verticesPainted).toBe(0);

      // Missing surface reports verticesPainted: 0
      const miss = await objectCommands.PAINT(
        { targetId: 'r2_count_ball', atMm: [100, 100, 100], radiusMm: 5, rgba: [1, 0, 0] },
        mockCtx(),
      ) as Record<string, unknown>;
      expect(miss.ok).toBe(false);
      expect(miss.verticesPainted).toBe(0);

      // Batch strokes report per-stroke and total verticesPainted
      const batch = await objectCommands.PAINT(
        {
          targetId: 'r2_count_ball',
          strokes: [
            { atMm: [0, 0, 20], radiusMm: 6, rgba: [0.95, 0.95, 0.95], flow: 1, hardness: 0.95 },
            { atMm: [0, 0, 20], radiusMm: 3, rgba: [0.95, 0.95, 0.95], flow: 1, hardness: 0.95 },
            { atMm: [0, 0, 20], radiusMm: 3, rgba: [0.1, 0.1, 0.1], flow: 1, hardness: 0.95 },
          ],
        },
        mockCtx(),
      ) as { ok: boolean; verticesPainted: number; results: { ok: boolean; verticesPainted: number }[] };
      expect(batch.ok).toBe(true);
      expect(batch.results).toHaveLength(3);
      expect(batch.results[0].verticesPainted).toBeGreaterThan(0);
      // Stroke 2 paints identical white over already-opaque white -> 0 vertices changed
      expect(batch.results[1].verticesPainted).toBe(0);
      // Stroke 3 paints dark over white -> >0 vertices changed
      expect(batch.results[2].verticesPainted).toBeGreaterThan(0);
      expect(batch.verticesPainted).toBe(
        batch.results[0].verticesPainted + batch.results[1].verticesPainted + batch.results[2].verticesPainted,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Item 4: print_narrow_gap does not flag sharp sculpted V-creases
  // -------------------------------------------------------------------------
  describe('Item 4: print_narrow_gap skips sharp sculpted V-creases while keeping real gaps', () => {
    it('does not flag a steep 10-degree concave V-crease (dot <= -0.98) sharing a crease edge', () => {
      // Single solid block with a very steep 10° concave V-groove carved into its top face
      // (walls at ±85° -> opposing normals have dot ≈ -0.985 <= -0.98, meeting at shared apex [0, 0.008]).
      const steepVPoly: [number, number][] = [
        [-0.015, 0.000],
        [0.015, 0.000],
        [0.015, 0.025],
        [0.0015, 0.025],
        [0.000, 0.008],
        [-0.0015, 0.025],
        [-0.015, 0.025],
      ];
      const vMesh = extrudeXZPolygon(steepVPoly, 0.015);
      expect(narrowestAirGap(meshToFlatTris(vMesh), PRINT_MIN_AIR_GAP_MM)).toBeNull();

      const node: SceneNode = {
        id: 'steep_v_body',
        name: 'steep_v_body',
        type: 'body',
        pos: [0, 0, 0],
        quat: [1, 0, 0, 0],
        geoms: [{
          name: 'steep_v_mesh',
          type: 'mesh',
          size: [1],
          renderVertices: vMesh.verts,
          vertices: vMesh.verts,
          faces: vMesh.faces,
          dynamic: true,
        }],
        joints: [],
        children: [],
      };
      const report = analyseDfm({ nodes: [node] } as SceneGraph, 'print', { asPlaced: true });
      expect(report.findings.find((f) => f.id === 'print_narrow_gap')).toBeUndefined();
    });

    it('does not flag sharp sculpted V-creases on a single-body organic sculpt', () => {
      const mesh = buildSculptBaseSized('sphere', 0.08);
      // Carve a sharp V-crease across the front of the sculpt with crease + pinch brushes
      applySculptStroke(mesh, {
        brush: 'crease',
        at: [[-0.015, 0.038, 0.0], [0.0, 0.04, 0.0], [0.015, 0.038, 0.0]],
        radius: 0.008,
        strength: 0.9,
      });
      applySculptStroke(mesh, {
        brush: 'pinch',
        at: [[-0.015, 0.038, 0.0], [0.0, 0.04, 0.0], [0.015, 0.038, 0.0]],
        radius: 0.007,
        strength: 0.8,
      });
      const { vertices, renderVertices, faces } = toSceneGeom(mesh);
      const sculptNode: SceneNode = {
        id: 'organic_sculpt',
        name: 'organic_sculpt',
        type: 'body',
        pos: [0, 0, 0.04],
        quat: [1, 0, 0, 0],
        isSculpt: true,
        sculptBase: 'sphere',
        geoms: [{
          name: 'organic_sculpt_clay',
          type: 'mesh',
          size: [1],
          vertices,
          renderVertices,
          faces,
        }],
        joints: [],
        children: [],
      };
      const report = analyseDfm({ nodes: [sculptNode] } as SceneGraph, 'print', { asPlaced: true });
      const gapFinding = report.findings.find((f) => f.id === 'print_narrow_gap' || f.id.endsWith(':print_narrow_gap'));
      expect(gapFinding).toBeUndefined();
    });

    it('still flags genuine single-part parallel-wall 0.15 mm U-slots as critical print_narrow_gap', () => {
      const uSlotPoly: [number, number][] = [
        [-0.006075, 0.000],
        [0.006075, 0.000],
        [0.006075, 0.020],
        [0.000075, 0.020],
        [0.000075, 0.004],
        [-0.000075, 0.004],
        [-0.000075, 0.020],
        [-0.006075, 0.020],
      ];
      const uMesh = extrudeXZPolygon(uSlotPoly, 0.015);
      const gap = narrowestAirGap(meshToFlatTris(uMesh), PRINT_MIN_AIR_GAP_MM);
      expect(gap).not.toBeNull();
      expect(gap!.mm).toBeCloseTo(0.15, 1);
    });
  });

  // -------------------------------------------------------------------------
  // Item 5: Guard concurrent dynamicTopology: true SCULPT calls on same body
  // -------------------------------------------------------------------------
  describe('Item 5: per-body serialization guards concurrent SCULPT calls', () => {
    it('withSculptBodyLock serializes same-body ops, isolates different bodies, and recovers after errors', async () => {
      const events: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((r) => { releaseFirst = r; });

      const p1 = withSculptBodyLock('bodyA', async () => {
        events.push('A1-start');
        await firstGate;
        events.push('A1-end');
        return 1;
      });
      const p2 = withSculptBodyLock('bodyA', async () => {
        events.push('A2-start');
        events.push('A2-end');
        return 2;
      });
      const pOther = withSculptBodyLock('bodyB', async () => {
        events.push('B1');
        return 99;
      });

      // bodyB completes immediately while bodyA's first op is still held
      expect(await pOther).toBe(99);
      expect(events).toEqual(['A1-start', 'B1']);

      releaseFirst();
      expect(await Promise.all([p1, p2])).toEqual([1, 2]);
      expect(events).toEqual(['A1-start', 'B1', 'A1-end', 'A2-start', 'A2-end']);

      // Error in one op must not wedge subsequent ops on the same body
      await expect(withSculptBodyLock('bodyA', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(await withSculptBodyLock('bodyA', async () => 'recovered')).toBe('recovered');
    });

    it('serializes concurrent dynamicTopology SCULPT calls on the same body without losing edits', async () => {
      const sculpt = makeSculptNode('r2_dyntopo_body', 0.08);
      useStore.setState({ sceneGraph: { nodes: [sculpt] } });

      // Fire two concurrent dynamicTopology: true SCULPT calls on opposite poles of the same body
      const ctx = mockCtx();
      const [res1, res2] = await Promise.all([
        sculptCommands.SCULPT({
          targetId: 'r2_dyntopo_body',
          brush: 'draw',
          atMm: [0, 0, 40],
          radiusMm: 10,
          strength: 0.7,
          dynamicTopology: true,
          detail: 0.003,
        }, ctx) as Promise<Record<string, unknown>>,
        sculptCommands.SCULPT({
          targetId: 'r2_dyntopo_body',
          brush: 'draw',
          atMm: [0, 0, -40],
          radiusMm: 10,
          strength: 0.7,
          dynamicTopology: true,
          detail: 0.003,
        }, ctx) as Promise<Record<string, unknown>>,
      ]);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res1.undoDepth).toBe(1);
      expect(res2.undoDepth).toBe(2);

      const finalNode = useStore.getState().sceneGraph.nodes[0];
      // Both strokes incremented sculptVersion cleanly (1 -> 2 -> 3)
      expect(finalNode.sculptVersion).toBe(3);
      // Both strokes' dynamic topology subdivisions accumulated
      expect(Number(res2.vertices)).toBeGreaterThanOrEqual(Number(res1.vertices));
    });
  });
});
