// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  exportContourSliceSvg,
  unionSegments,
  chainSegments,
  DEFAULT_CONTOUR_OPTIONS,
} from '../src/utils/contourSliceExporter';
import { generateContourSliceGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import { contourSheetParts, runSheetJob } from '../src/utils/sheetSimulation';
import { simulateMilling } from '../src/utils/cutSimulation';
import { simulatedBody } from '../src/utils/simulatedPart';
import { measureGcodeBounds } from '../src/utils/workEnvelope';
import { nestingBowls } from './helpers/bowls';
import { useStore } from '../src/store/useStore';
import { webSerialManager } from '../src/utils/webSerialManager';
import { ExportContourSliceModal } from '../src/components/ExportContourSliceModal';
import type { SceneGraph, SceneGeom } from '../src/types/scene';
import type { Point2D } from '../src/utils/laserCutExporter';

function bodyWith(geom: Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] }, pos = [0, 0, 0]): SceneGraph {
  return {
    nodes: [{
      id: 'b1',
      name: 'part',
      type: 'body',
      pos,
      geoms: [{ name: 'g1', ...geom } as SceneGeom],
      joints: [],
      children: [],
    }],
  };
}

function nodeExtentMm(node: SceneGraph['nodes'][0]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const g of node.geoms || []) {
    const rv = g.renderVertices || [];
    for (let i = 0; i < rv.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const w = (node.pos[a] + rv[i + a]) * 1000;
        if (w < min[a]) min[a] = w;
        if (w > max[a]) max[a] = w;
      }
    }
  }
  return { min, max };
}

function boxMeshArrays(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, vOffset = 0) {
  const verts = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ];
  const local = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ];
  return { verts, faces: local.map((idx) => idx + vOffset) };
}

describe('Contour Slice Outputter Audit Fixes (C-*)', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  // -------------------------------------------------------------------------
  // C-C1: Engraved layer numbers never land inside dowel holes, and multi-island
  // layers receive per-island labels.
  // -------------------------------------------------------------------------
  describe('C-C1: Label anchors avoid dowel holes and number every island', () => {
    it('places labelPos2D strictly outside dowel holes with solid clearance on symmetric shapes', () => {
      const cube = bodyWith({ type: 'box', size: [0.04, 0.04, 0.02] }, [0, 0, 0.02]);
      const pinDiameter = 0.004;
      const pinRadiusMm = (pinDiameter * 1000) / 2;

      const res = exportContourSliceSvg(cube, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        pinHoles: true,
        pinCount: 2,
        pinDiameter,
        includeLabels: true,
      });

      expect(res.success).toBe(true);
      expect(res.pins).toHaveLength(2);

      for (const layer of res.layers!) {
        expect(layer.labelPos2D).toBeDefined();
        for (const pin of res.pins!) {
          const dist = Math.hypot(layer.labelPos2D!.x - pin.x, layer.labelPos2D!.y - pin.y);
          // Must clear the nominal dowel hole radius by at least 3 mm!
          expect(dist).toBeGreaterThanOrEqual(pinRadiusMm + 3 - 1e-3);
        }
      }

      // Verify emitted SVG <text> anchors in #engrave-labels also avoid dowel holes on the sheet
      const layer0 = res.layers![0];
      const pos = layer0.placedPos2D!;
      const off = layer0.modelOffset2D!;
      const labelMatches = [...res.svg!.matchAll(/<g id="engrave-labels"[^>]*>([\s\S]*?)<\/g>/g)];
      expect(labelMatches).toHaveLength(1);
      const firstText = /<text x="(-?[\d.]+)" y="(-?[\d.]+)">1<\/text>/.exec(labelMatches[0][1]);
      expect(firstText).not.toBeNull();
      const svgX = parseFloat(firstText![1]);
      const svgY = parseFloat(firstText![2]);
      for (const pin of res.pins!) {
        const pinSvgX = pos.x - off.x + pin.x;
        const pinSvgY = pos.y + off.y - pin.y;
        expect(Math.hypot(svgX - pinSvgX, svgY - pinSvgY)).toBeGreaterThanOrEqual(pinRadiusMm + 2.9);
      }
    });

    it('assigns per-island labelPositions2D and emits SVG labels for all disconnected islands', () => {
      const twoPillars: SceneGraph = {
        nodes: [{
          id: 'pillars',
          name: 'pillars',
          type: 'body',
          pos: [0, 0, 0.01],
          joints: [],
          children: [],
          geoms: [
            { name: 'left', type: 'box', size: [0.02, 0.02, 0.01], pos: [-0.04, 0, 0] },
            { name: 'right', type: 'box', size: [0.02, 0.02, 0.01], pos: [0.04, 0, 0] },
          ],
        }],
      };

      const res = exportContourSliceSvg(twoPillars, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        pinHoles: true,
        pinCount: 2,
        pinDiameter: 0.003,
        includeLabels: true,
      });

      expect(res.success).toBe(true);
      for (const layer of res.layers!) {
        expect(layer.pieceCount).toBe(2);
        expect(layer.labelPositions2D).toHaveLength(2);
        expect(layer.labelPos2D).toEqual(layer.labelPositions2D![0]);
        // One label on negative-X pillar, one on positive-X pillar
        const xs = layer.labelPositions2D!.map((p) => p.x).sort((a, b) => a - b);
        expect(xs[0]).toBeLessThan(-20);
        expect(xs[1]).toBeGreaterThan(20);
        for (const anchor of layer.labelPositions2D!) {
          for (const pin of res.pins!) {
            expect(Math.hypot(anchor.x - pin.x, anchor.y - pin.y)).toBeGreaterThanOrEqual(1.5 + 3 - 1e-3);
          }
        }
      }

      // Layer 1 ("1") appears twice in #engrave-labels (once per island)
      const labelBlock = /<g id="engrave-labels"[^>]*>([\s\S]*?)<\/g>/.exec(res.svg!)![1];
      const layer1Texts = [...labelBlock.matchAll(/<text [^>]*>1<\/text>/g)];
      expect(layer1Texts).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // C-C2: Explicit sliceCount override stacks full-thickness sheets without
  // facing every sheet down or leaving floating air gaps in simulation.
  // -------------------------------------------------------------------------
  describe('C-C2: sliceCount override does not face sheets or float simulation slabs', () => {
    it('cuts full-thickness sheets with no CNC facing passes and stacks contiguously', () => {
      // 50 mm cube sliced into 20 layers of 5 mm stock (stretched stack = 100 mm)
      const cube50 = bodyWith({ type: 'box', size: [0.025, 0.025, 0.025] }, [0, 0, 0.025]);
      const res = exportContourSliceSvg(cube50, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        sliceCount: 20,
        pinHoles: false,
        kerf: 0,
      });

      expect(res.success).toBe(true);
      expect(res.layers).toHaveLength(20);
      expect(res.stackHeight).toBeCloseTo(0.1, 6);
      for (const layer of res.layers!) {
        expect(layer.facedToMm).toBeUndefined();
      }

      const gcode = generateContourSliceGcode(res, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 5,
        bitDiameterMm: 3.175,
      });
      expect(gcode.success).toBe(true);
      expect(gcode.operations.filter((op) => op.type === 'facing')).toHaveLength(0);

      // Verify 3D sheet simulation builds a flush 100 mm stack with zero air gaps
      const parts = contourSheetParts(res.layers!, 5);
      expect(parts).toHaveLength(20);
      for (let i = 0; i < parts.length; i++) {
        expect(parts[i].origin[2]).toBeCloseTo(i * 5, 6);
        expect(parts[i].zTo).toBeCloseTo(5, 6);
      }

      const simMesh = runSheetJob({ parts, routerRadiusMm: 0 });
      // Volume of 20 contiguous 50 x 50 x 5 mm slabs (minus tiny 0.25 mm visual seam chamfers) ≈ 250,000 mm³
      expect(simMesh.volumeMm3).toBeGreaterThan(245_000);
      expect(simMesh.volumeMm3).toBeLessThanOrEqual(250_001);

      const beside = simulatedBody(
        { ...simMesh, cellMm: 0, toleranceMm: 0 },
        res.stockTransform!,
        { id: 'sim_b', name: 'sim_b', kind: 'contour', placement: 'beside' },
      );
      const bExt = nodeExtentMm(beside);
      expect(bExt.max[2] - bExt.min[2]).toBeCloseTo(100, 2);

      const overlay = simulatedBody(
        { ...simMesh, cellMm: 0, toleranceMm: 0 },
        res.stockTransform!,
        { id: 'sim_o', name: 'sim_o', kind: 'contour', placement: 'overlay' },
      );
      const oExt = nodeExtentMm(overlay);
      expect(oExt.min[2]).toBeCloseTo(0, 2);
      expect(oExt.max[2]).toBeCloseTo(50, 2);
    });
  });

  // -------------------------------------------------------------------------
  // C-C3: Uniform 3D scaling (scaleFactor & autoScale) scales XYZ before slicing.
  // -------------------------------------------------------------------------
  describe('C-C3: Uniform 3D scaling for scaleFactor and autoScale', () => {
    it('scales Z layer count alongside XY dimensions to preserve 3D aspect ratio', () => {
      // 100 mm cube sitting on z = 20 mm (z = 20..120 mm)
      const cube100 = bodyWith({ type: 'box', size: [0.05, 0.05, 0.05] }, [0, 0, 0.07]);
      const res = exportContourSliceSvg(cube100, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        scaleFactor: 0.5,
        kerf: 0,
        pinHoles: false,
      });

      expect(res.success).toBe(true);
      // 100 mm * 0.5 = 50 mm -> 10 layers of 5 mm stock (not 20!)
      expect(res.layers).toHaveLength(10);
      expect(res.stackHeight).toBeCloseTo(0.05, 6);
      expect(res.modelHeight).toBeCloseTo(0.1, 6);
      expect(res.stockTransform!.scale).toEqual([0.5, 0.5, 0.5]);

      for (const layer of res.layers!) {
        expect(layer.width2D).toBeCloseTo(50, 1);
        expect(layer.height2D).toBeCloseTo(50, 1);
      }

      // Should NOT falsely warn about stack height mismatch when sliceCount is auto
      expect((res.warnings ?? []).some((w) => w.includes('stack up to'))).toBe(false);

      // Verify both 'beside' (50x50x50 mm) and 'overlay' (100x100x100 mm at z=20..120 mm)
      const sim = runSheetJob({ parts: contourSheetParts(res.layers!, 5), routerRadiusMm: 0 });
      const beside = simulatedBody(
        { ...sim, cellMm: 0, toleranceMm: 0 },
        res.stockTransform!,
        { id: 's_beside', name: 's_beside', kind: 'contour', placement: 'beside' },
      );
      const bExt = nodeExtentMm(beside);
      expect(bExt.max[0] - bExt.min[0]).toBeCloseTo(50, 1);
      expect(bExt.max[1] - bExt.min[1]).toBeCloseTo(50, 1);
      expect(bExt.max[2] - bExt.min[2]).toBeCloseTo(50, 1);
      expect(bExt.min[2]).toBeCloseTo(20, 1);

      const overlay = simulatedBody(
        { ...sim, cellMm: 0, toleranceMm: 0 },
        res.stockTransform!,
        { id: 's_overlay', name: 's_overlay', kind: 'contour', placement: 'overlay' },
      );
      const oExt = nodeExtentMm(overlay);
      expect(oExt.min[0]).toBeCloseTo(-50, 1);
      expect(oExt.max[0]).toBeCloseTo(50, 1);
      expect(oExt.min[2]).toBeCloseTo(20, 1);
      expect(oExt.max[2]).toBeCloseTo(120, 1);
    });

    it('reduces both Z layer count and XY slice size during autoScale to fit maxSheets', () => {
      // 120 x 120 x 120 mm cube on a 200 x 200 mm sheet with 10 mm stock (12 layers unscaled -> won't fit 1 sheet)
      const bigCube = bodyWith({ type: 'box', size: [0.06, 0.06, 0.06] }, [0, 0, 0.06]);
      const res = exportContourSliceSvg(bigCube, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.01,
        sheetWidth: 0.2,
        sheetHeight: 0.2,
        autoScale: true,
        maxSheets: 1,
        pinHoles: false,
        kerf: 0,
      });

      expect(res.success).toBe(true);
      expect(res.sheetCount).toBe(1);
      expect(res.scaleFactor!).toBeLessThan(1.0);
      expect(res.scaleFactor!).toBeGreaterThan(0.4);
      // Layer count scaled down in Z alongside XY!
      expect(res.layers!.length).toBeLessThan(12);
    });
  });

  // -------------------------------------------------------------------------
  // C-H1: CNC dowel hole boring (plunge when holeDia == bitDia, climb circle
  // when holeDia > bitDia, clear warning when holeDia < bitDia).
  // -------------------------------------------------------------------------
  describe('C-H1: CNC alignment dowel holes are bored instead of dropped', () => {
    const block = bodyWith({ type: 'box', size: [0.03, 0.03, 0.005] }, [0, 0, 0.005]);

    it('emits CNC peck plunge bores when pinDiameter equals bitDiameter (3.175 mm)', () => {
      const sliced = exportContourSliceSvg(block, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        kerf: 0,
        pinHoles: true,
        pinCount: 2,
        pinDiameter: 0.003175,
      });
      expect(sliced.success).toBe(true);
      expect(sliced.pins).toHaveLength(2);

      const gcode = generateContourSliceGcode(sliced, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 5,
        zStepdown: 2,
        bitDiameterMm: 3.175,
      });
      expect(gcode.success).toBe(true);
      expect(gcode.warnings ?? []).toHaveLength(0);
      expect(gcode.operations.filter((o) => o.id.includes('_bore_'))).toHaveLength(4); // 2 pins * 2 layers

      // Verify milling simulation actually drills through the stock at the pin coordinates
      const layer0 = sliced.layers![0];
      const offX = layer0.placedPos2D!.x - layer0.modelOffset2D!.x;
      const offY = layer0.placedPos2D!.y - (layer0.modelOffset2D!.y - layer0.height2D!);
      const cut = simulateMilling(gcode.gcode, {
        widthMm: 200,
        depthMm: 200,
        tools: { 1: { shape: 'flat', diameterMm: 3.175 } },
        initialTool: 1,
        cellMm: 0.5,
      });
      for (const pin of sliced.pins!) {
        const px = offX + pin.x;
        const py = offY + pin.y;
        const col = Math.floor(px / cut.cell);
        const row = Math.floor(py / cut.cell);
        expect(cut.heights[row * cut.cols + col]).toBeLessThanOrEqual(-5.1);
      }
    });

    it('emits analytical circular climb-milled bores when pinDiameter barely exceeds bitDiameter (3.20 mm vs 3.175 mm)', () => {
      const sliced = exportContourSliceSvg(block, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.01,
        kerf: 0,
        pinHoles: true,
        pinCount: 2,
        pinDiameter: 0.0032,
      });
      const gcode = generateContourSliceGcode(sliced, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 10,
        bitDiameterMm: 3.175,
      });
      expect(gcode.success).toBe(true);
      expect(gcode.warnings ?? []).toHaveLength(0);
      // 1 outer contour + 2 circular pin bores = 3 cut operations
      expect(gcode.operations.filter((o) => o.type === 'cut')).toHaveLength(3);
    });

    it('warns clearly when pinDiameter is narrower than bitDiameter (3.0 mm vs 3.175 mm)', () => {
      const sliced = exportContourSliceSvg(block, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.01,
        kerf: 0,
        pinHoles: true,
        pinCount: 2,
        pinDiameter: 0.003,
      });
      const gcode = generateContourSliceGcode(sliced, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 10,
        bitDiameterMm: 3.175,
      });
      expect(gcode.success).toBe(true);
      expect(gcode.warnings).toBeDefined();
      expect(gcode.warnings!.some((w) => w.includes('⌀3.000mm') && w.includes('3.175mm cutter'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // C-H2: Sub-cell holes on large parts are never intersected by dowels.
  // -------------------------------------------------------------------------
  describe('C-H2: Analytical pin clearance avoids sub-cell holes', () => {
    it('keeps alignment dowels clear of a tiny central bolt hole on a wide plate', () => {
      // Build a 300 x 300 x 10 mm plate mesh with a 1.4 mm central hole at (0, 0)
      // (smaller than the old 300 / 160 = 1.875 mm raster cell!)
      const segs = 24;
      const rIn = 0.0007; // 0.7 mm radius = 1.4 mm diameter hole at (0,0)
      const half = 0.15;  // 300 mm wide
      const verts: number[] = [];
      const faces: number[] = [];

      // Outer box corners 0..7 (bottom z=0: 0..3, top z=0.01: 4..7)
      verts.push(
        -half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0,
        -half, -half, 0.01, half, -half, 0.01, half, half, 0.01, -half, half, 0.01,
      );
      // Outer vertical walls
      faces.push(
        0, 1, 5, 0, 5, 4,
        1, 2, 6, 1, 6, 5,
        2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
      );
      // Inner hole cylinder walls (inward-facing so slicing at z=0.005 produces CW hole)
      const base = 8;
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        verts.push(Math.cos(a) * rIn, Math.sin(a) * rIn, 0);
        verts.push(Math.cos(a) * rIn, Math.sin(a) * rIn, 0.01);
      }
      for (let k = 0; k < segs; k++) {
        const b0 = base + k * 2;
        const t0 = b0 + 1;
        const b1 = base + ((k + 1) % segs) * 2;
        const t1 = b1 + 1;
        faces.push(b0, t0, t1, b0, t1, b1);
      }
      // Top & bottom caps connecting inner ring to outer corners so signedVolume > 0
      for (let k = 0; k < segs; k++) {
        const b0 = base + k * 2;
        const t0 = b0 + 1;
        const b1 = base + ((k + 1) % segs) * 2;
        const t1 = b1 + 1;
        const corner = Math.floor((k / segs) * 4) % 4;
        const nextCorner = Math.floor((((k + 1) % segs) / segs) * 4) % 4;
        faces.push(corner, b1, b0);
        if (nextCorner !== corner) faces.push(corner, nextCorner, b1);
        faces.push(4 + corner, t0, t1);
        if (nextCorner !== corner) faces.push(4 + corner, t1, 4 + nextCorner);
      }

      const plate = bodyWith({ type: 'mesh', size: [1], renderVertices: verts, faces } as never);
      const res = exportContourSliceSvg(plate, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        sheetWidth: 0.4,
        sheetHeight: 0.4,
        pinHoles: true,
        pinCount: 2,
        pinDiameter: 0.003,
        kerf: 0,
      });

      expect(res.success).toBe(true);
      expect(res.pins).toHaveLength(2);
      // Every pin must clear the central 0.7 mm radius hole by at least requiredMm (4.5 mm)
      for (const pin of res.pins!) {
        const distFromHoleEdge = Math.hypot(pin.x, pin.y) - 0.7;
        expect(distFromHoleEdge).toBeGreaterThanOrEqual(4.5 - 0.05);
      }
    });
  });

  // -------------------------------------------------------------------------
  // C-M1: generateContourSliceGcode never drives placed layers to X < 0 or Y < 0.
  // -------------------------------------------------------------------------
  describe('C-M1: Negative X/Y toolpath guard in generateContourSliceGcode', () => {
    it('shifts placed layers onto X >= 0, Y >= 0 when cutter radius exceeds sheet margin', () => {
      const cube = bodyWith({ type: 'box', size: [0.02, 0.02, 0.005] }, [0, 0, 0.005]);
      const sliced = exportContourSliceSvg(cube, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.01,
        margin: 0.001, // 1 mm margin, smaller than 5 mm cutter radius!
        kerf: 0,
        pinHoles: false,
      });
      expect(sliced.success).toBe(true);

      const gcode = generateContourSliceGcode(sliced, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 10,
        bitDiameterMm: 10, // 5 mm radius would push X/Y to 1 - 5 = -4 mm without guard!
      });

      expect(gcode.success).toBe(true);
      const env = measureGcodeBounds(gcode.gcode)!;
      expect(env.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(env.minY).toBeGreaterThanOrEqual(-1e-6);
      expect(gcode.bounds.minX).toBeGreaterThanOrEqual(-1e-6);
      expect(gcode.bounds.minY).toBeGreaterThanOrEqual(-1e-6);
      expect(gcode.warnings!.some((w) => w.includes('shifted toolpath'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // C-M2: Single-geom multi-shell overlapping meshes union cleanly.
  // -------------------------------------------------------------------------
  describe('C-M2: Single-geom multi-shell and self-overlapping boolean union', () => {
    it('unions two overlapping cube shells inside a single mesh SceneGeom with no internal seam', () => {
      // Box A: [-30..+10] x [-20..+20] x [0..10] mm; Box B: [-10..+30] x [-20..+20] x [0..10] mm
      // Union is [-30..+30] x [-20..+20] = 60 x 40 mm = 2400 mm² (not 3200 mm² or internal seams!)
      const a = boxMeshArrays(-0.03, 0.01, -0.02, 0.02, 0, 0.01, 0);
      const b = boxMeshArrays(-0.01, 0.03, -0.02, 0.02, 0, 0.01, 8);
      const singleGeomScene = bodyWith({
        type: 'mesh',
        size: [1],
        renderVertices: [...a.verts, ...b.verts],
        faces: [...a.faces, ...b.faces],
      } as never);

      const res = exportContourSliceSvg(singleGeomScene, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        kerf: 0,
        pinHoles: false,
      });

      expect(res.success).toBe(true);
      const layer = res.layers![0];
      expect(layer.loops).toHaveLength(1);
      expect(layer.pieceCount).toBe(1);
      expect(layer.areaMm2).toBeCloseTo(60 * 40, 0);
    });

    it('unions crossing contours even when every segment carries the same solid id', () => {
      const sqSegs = (x0: number, x1: number, y0: number, y1: number) => {
        const pts: Point2D[] = [
          { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
        ];
        return pts.map((p, i) => ({ a: p, b: pts[(i + 1) % 4], solid: 0 }));
      };
      const merged = unionSegments([...sqSegs(0, 40, 0, 40), ...sqSegs(20, 60, 0, 40)]);
      const loops = chainSegments(merged);
      expect(loops).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // C-M3: Concentric rings (nestingBowls) tab inner islands AND enclosing moat
  // holes on CNC, and warn on under-pinned disconnected islands.
  // -------------------------------------------------------------------------
  describe('C-M3: Concentric ring CNC tabbing, cut order, and island pin warnings', () => {
    it('cuts inner islands before enclosing moat holes and tabs both on CNC', () => {
      const bowlsScene: SceneGraph = { nodes: nestingBowls(8, (i) => [0, 0, 0.008 * i]) };
      const res = exportContourSliceSvg(bowlsScene, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        kerf: 0,
        pinHoles: false,
      });
      expect(res.success).toBe(true);
      // Find a layer above the bases where the bowls slice into concentric rings (4+ loops, depth 0..3+)
      const ringLayer = res.layers!.find((l) => l.loops.length >= 4)!;
      expect(ringLayer).toBeDefined();

      const singleLayerRes = { ...res, layers: [ringLayer], sheetCount: 1 };
      const gcode = generateContourSliceGcode(singleLayerRes, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 5,
        zStepdown: 2,
        bitDiameterMm: 2,
        attachmentsEnabled: true,
        attachmentWidthMm: 3,
        attachmentSpacingMm: 50,
      });

      expect(gcode.success).toBe(true);
      // Split G-code into individual contour blocks (each begins with G0 Z5 then G0 X... Y...)
      const blocks: { lines: string[]; maxR: number; tabbed: boolean }[] = [];
      const cx = ringLayer.placedPos2D!.x + ringLayer.width2D! / 2;
      const cy = ringLayer.placedPos2D!.y + ringLayer.height2D! / 2;
      let cur: { lines: string[]; maxR: number; tabbed: boolean } | null = null;
      for (const line of gcode.gcode.split('\n')) {
        if (/^G0 X/.test(line)) {
          cur = { lines: [], maxR: 0, tabbed: false };
          blocks.push(cur);
        }
        if (!cur) continue;
        cur.lines.push(line);
        const xm = /X(-?[\d.]+)/.exec(line);
        const ym = /Y(-?[\d.]+)/.exec(line);
        if (/^G1 X/.test(line) && xm && ym) {
          const r = Math.hypot(parseFloat(xm[1]) - cx, parseFloat(ym[1]) - cy);
          if (r > cur.maxR) cur.maxR = r;
          if (/Z-?[\d.]+/.test(line)) cur.tabbed = true;
        }
      }
      const cutBlocks = blocks.filter((b) => b.lines.some((l) => /^G1 X/.test(l)));
      expect(cutBlocks.length).toBeGreaterThanOrEqual(4);

      // Radii must increase monotonically from innermost cavity out to outermost wall!
      for (let i = 1; i < cutBlocks.length; i++) {
        expect(cutBlocks[i].maxR).toBeGreaterThan(cutBlocks[i - 1].maxR - 1);
      }
      // Innermost hole (leaf cavity) has NO tabs; every outer island AND every moat hole enclosing an island IS tabbed!
      expect(cutBlocks[0].tabbed).toBe(false);
      for (let i = 1; i < cutBlocks.length; i++) {
        expect(cutBlocks[i].tabbed).toBe(true);
      }

      // Also verify warning when attachmentsEnabled is false on CNC with nested islands
      const untabbed = generateContourSliceGcode(singleLayerRes, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        cutDepthZ: 15,
        bitDiameterMm: 2,
        attachmentsEnabled: false,
      });
      expect(untabbed.warnings!.some((w) => w.includes('nested concentric islands'))).toBe(true);
    });

    it('warns when disconnected islands receive 0 or 1 alignment pins', () => {
      const threePillars: SceneGraph = {
        nodes: [{
          id: 'p3',
          name: 'p3',
          type: 'body',
          pos: [0, 0, 0.01],
          joints: [],
          children: [],
          geoms: [
            { name: 'p1', type: 'box', size: [0.015, 0.015, 0.01], pos: [-0.05, 0, 0] },
            { name: 'p2', type: 'box', size: [0.015, 0.015, 0.01], pos: [0, 0, 0] },
            { name: 'p3', type: 'box', size: [0.015, 0.015, 0.01], pos: [0.05, 0, 0] },
          ],
        }],
      };
      const res = exportContourSliceSvg(threePillars, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        pinHoles: true,
        pinCount: 2,
        pinDiameter: 0.003,
      });
      expect(res.success).toBe(true);
      expect(res.warnings!.some((w) => w.includes('Disconnected island registration') && w.includes('0 alignment pins'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // C-M4: Open / non-manifold mesh slice chains heal bidirectionally and warn.
  // -------------------------------------------------------------------------
  describe('C-M4: Open / non-manifold mesh contour healing and warning', () => {
    it('bridges an open contour crack into a single loop and warns the operator', () => {
      // A box missing its +X wall (only 3 vertical walls + top/bottom -> open 2D C-channel at mid-height)
      const verts = [
        -0.02, -0.02, 0, 0.02, -0.02, 0, 0.02, 0.02, 0, -0.02, 0.02, 0,
        -0.02, -0.02, 0.02, 0.02, -0.02, 0.02, 0.02, 0.02, 0.02, -0.02, 0.02, 0.02,
      ];
      // Omit the +X wall (1,2,6 / 1,6,5) so every Z slice has a 40 mm open gap!
      const faces = [
        0, 2, 1, 0, 3, 2,
        4, 5, 6, 4, 6, 7,
        0, 1, 5, 0, 5, 4,
        2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
      ];
      const broken = bodyWith({ type: 'mesh', size: [1], renderVertices: verts, faces } as never);
      const res = exportContourSliceSvg(broken, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        pinHoles: false,
      });

      expect(res.success).toBe(true);
      expect(res.layers![0].loops).toHaveLength(1);
      expect(res.warnings!.some((w) => w.includes('Non-manifold or open mesh edges'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // C-L1: Laser kerf does not inflate simulated 3D stack, and empty layers skip.
  // -------------------------------------------------------------------------
  describe('C-L1: Uncompensated nominalLoops in simulation and empty layer handling', () => {
    it('keeps simulated stack dimensions at nominal 100 mm while SVG/loops carry laser kerf offset', () => {
      const cube = bodyWith({ type: 'box', size: [0.05, 0.05, 0.005] }, [0, 0, 0.005]);
      const res = exportContourSliceSvg(cube, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        kerf: 0.0005, // 0.5 mm kerf -> cut loop is 100.5 mm, nominal is 100.0 mm
        pinHoles: false,
      });

      expect(res.success).toBe(true);
      expect(res.layers![0].width2D).toBeCloseTo(100.5, 2);

      const parts = contourSheetParts([
        { index: 0, z: 0, loops: [], pieceCount: 0, areaMm2: 0 }, // synthetic empty layer
        ...res.layers!,
      ], 5);
      expect(parts).toHaveLength(res.layers!.length);
      expect(parts[0].seamMm).toBe(0);

      const xs = parts[0].loops[0].map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100.0, 3);
    });
  });

  // -------------------------------------------------------------------------
  // C-L2 & C-H1 (UI): ExportContourSliceModal defaults CNC dowel >= bitDia and
  // invalidates probedGrid when scale / stock / scene changes.
  // -------------------------------------------------------------------------
  describe('C-L2 & C-H1 UI: ExportContourSliceModal dowel sync and probe invalidation', () => {
    it('defaults CNC Dowel ⌀ to Bit Ø (3.175 mm) and resets Bed Levelled when scale or scene changes', async () => {
      vi.useFakeTimers();
      const probeSpy = vi.spyOn(webSerialManager, 'probeGrid').mockResolvedValue({
        minX: 0, maxX: 100, minY: 0, maxY: 100, cols: 3, rows: 3, zOffsets: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
      });
      const getStateSpy = vi.spyOn(webSerialManager, 'getState').mockReturnValue({
        ...webSerialManager.getState(),
        connected: true,
        status: 'IDLE',
        portName: 'ttyUSB0',
      });

      useStore.setState({ machineTarget: 'cnc' });
      const sceneA = bodyWith({ type: 'box', size: [0.02, 0.02, 0.005] }, [0, 0, 0.005]);
      const sceneB = bodyWith({ type: 'box', size: [0.03, 0.03, 0.005] }, [0, 0, 0.005]);

      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(React.createElement(ExportContourSliceModal, {
            isOpen: true,
            onClose: () => {},
            scene: sceneA,
          }));
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(600);
        });

        // Wait for inline export jobs (contour + contourGcode) to settle
        for (let k = 0; k < 5; k++) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
          });
        }

        // Verify no red "Left out of the program" dowel warning appears on default CNC settings!
        expect(host.textContent).not.toContain('Left out of the program');

        // Probe the bed -> button switches from "Probe Bed" to "Bed Levelled"
        const findProbeBtn = () =>
          Array.from(host.querySelectorAll('button')).find(
            (b) => b.textContent?.includes('Probe Bed') || b.textContent?.includes('Bed Levelled'),
          );
        const probeBtn = findProbeBtn();
        expect(probeBtn?.textContent).toContain('Probe Bed');

        await act(async () => {
          probeBtn!.click();
          await Promise.resolve();
        });
        expect(probeSpy).toHaveBeenCalledTimes(1);
        expect(findProbeBtn()?.textContent).toContain('Bed Levelled');

        // Change scene -> probedGrid must immediately reset to "Probe Bed"!
        await act(async () => {
          root.render(React.createElement(ExportContourSliceModal, {
            isOpen: true,
            onClose: () => {},
            scene: sceneB,
          }));
        });
        expect(findProbeBtn()?.textContent).toContain('Probe Bed');

        // Probe again on sceneB, then change stock sheet width -> must immediately reset to "Probe Bed"!
        for (let k = 0; k < 5; k++) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
          });
        }
        await act(async () => {
          findProbeBtn()!.click();
          await Promise.resolve();
        });
        expect(findProbeBtn()?.textContent).toContain('Bed Levelled');

        await act(async () => {
          useStore.setState((s) => ({ stock: { ...s.stock, widthMm: s.stock.widthMm + 50 } }));
        });
        expect(findProbeBtn()?.textContent).toContain('Probe Bed');
      } finally {
        await act(async () => root.unmount());
        host.remove();
        probeSpy.mockRestore();
        getStateSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });
});
