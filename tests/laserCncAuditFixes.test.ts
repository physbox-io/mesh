import { describe, it, expect } from 'vitest';
import {
  exportLaserCutSvg,
  extractPanelsFromScene,
  DEFAULT_LASER_OPTIONS,
  type Point2D,
  type StockItem,
} from '../src/utils/laserCutExporter';
import {
  generateLaserCutGcode,
  DEFAULT_GCODE_OPTIONS,
} from '../src/utils/gcodeExporter';
import {
  laserSheetParts,
  laserStockTransform,
  runSheetJob,
} from '../src/utils/sheetSimulation';
import { simulatedBody } from '../src/utils/simulatedPart';
import { offsetLoop } from '../src/utils/polygonOffset';
import { routerStepdownMm, layoutMargin, layoutCutOutset } from '../src/utils/sheetCutRecipe';
import { castingFlaskPreset } from '../src/presets/presetScenes';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

function sceneOf(...nodes: SceneNode[]): SceneGraph {
  return { nodes };
}

function bodyNode(
  id: string,
  geoms: SceneGeom[],
  pos: [number, number, number] = [0, 0, 0],
  euler?: [number, number, number]
): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos,
    ...(euler ? { euler } : {}),
    geoms,
    joints: [],
    children: [],
  };
}

function segCrossProper(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): boolean {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return false;
  const dx = b1.x - a1.x, dy = b1.y - a1.y;
  const t = (dx * d2y - dy * d2x) / den;
  const u = (dx * d1y - dy * d1x) / den;
  return t > 1e-5 && t < 1 - 1e-5 && u > 1e-5 && u < 1 - 1e-5;
}

function hasSelfIntersection(loop: Point2D[]): boolean {
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a1 = loop[i], a2 = loop[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segCrossProper(a1, a2, loop[j], loop[(j + 1) % n])) return true;
    }
  }
  return false;
}

function distToLoop(pt: Point2D, loop: Point2D[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2)) : 0;
    const d = Math.hypot(pt.x - (a.x + abx * t), pt.y - (a.y + aby * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Builds a watertight 3D triangle mesh of a rectangular slab `[0..W] x [0..H] x [0..T]`
 * with a rectangular blind pocket `[px0..px1] x [py0..py1]` recessed from the top face
 * (`z = T`) down to `z = T - pocketDepth` (in mm, converted to metres).
 */
function slabWithTopBlindPocketMesh(
  wMm: number,
  hMm: number,
  tMm: number,
  px0Mm: number,
  py0Mm: number,
  px1Mm: number,
  py1Mm: number,
  depthMm: number,
  reverseFaceOrder = false
): SceneGeom {
  const W = wMm / 1000, H = hMm / 1000, T = tMm / 1000;
  const x0 = px0Mm / 1000, y0 = py0Mm / 1000, x1 = px1Mm / 1000, y1 = py1Mm / 1000;
  const zFloor = (tMm - depthMm) / 1000;

  const verts: number[] = [];
  const faces: number[] = [];
  const addQuad = (
    p0: [number, number, number],
    p1: [number, number, number],
    p2: [number, number, number],
    p3: [number, number, number]
  ) => {
    const base = verts.length / 3;
    verts.push(...p0, ...p1, ...p2, ...p3);
    faces.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // Bottom full skin (normal -Z)
  addQuad([0, 0, 0], [0, H, 0], [W, H, 0], [W, 0, 0]);

  // 4 outer side walls
  addQuad([0, 0, 0], [W, 0, 0], [W, 0, T], [0, 0, T]);
  addQuad([W, 0, 0], [W, H, 0], [W, H, T], [W, 0, T]);
  addQuad([W, H, 0], [0, H, 0], [0, H, T], [W, H, T]);
  addQuad([0, H, 0], [0, 0, 0], [0, 0, T], [0, H, T]);

  // Top skin around the pocket (4 frame strips, normal +Z)
  addQuad([0, 0, T], [W, 0, T], [W, y0, T], [0, y0, T]);
  addQuad([0, y1, T], [W, y1, T], [W, H, T], [0, H, T]);
  addQuad([0, y0, T], [x0, y0, T], [x0, y1, T], [0, y1, T]);
  addQuad([x1, y0, T], [W, y0, T], [W, y1, T], [x1, y1, T]);

  // Pocket floor at zFloor (normal +Z)
  addQuad([x0, y0, zFloor], [x1, y0, zFloor], [x1, y1, zFloor], [x0, y1, zFloor]);

  // 4 inner vertical pocket walls
  addQuad([x0, y0, T], [x1, y0, T], [x1, y0, zFloor], [x0, y0, zFloor]);
  addQuad([x1, y0, T], [x1, y1, T], [x1, y1, zFloor], [x1, y0, zFloor]);
  addQuad([x1, y1, T], [x0, y1, T], [x0, y1, zFloor], [x1, y1, zFloor]);
  addQuad([x0, y1, T], [x0, y0, T], [x0, y0, zFloor], [x0, y1, zFloor]);

  let finalFaces = faces;
  if (reverseFaceOrder) {
    finalFaces = [];
    for (let t = faces.length - 3; t >= 0; t -= 3) {
      finalFaces.push(faces[t], faces[t + 1], faces[t + 2]);
    }
  }

  return {
    name: 'pocketed_slab',
    type: 'mesh',
    size: [1],
    renderVertices: verts,
    faces: finalFaces,
  };
}

describe('CNC Slotted & Finger-Jointed Sheet Decomposition (End-to-End)', () => {
  it('cuts complementary cross-lap slots on intersecting egg-crate / X-stand plates with CNC dogbone & tbone relief', () => {
    for (const bitMm of [3.175, 6.35]) {
      const bitM = bitMm / 1000;
      const stockMm = bitMm > 6 ? 9 : 6;
      const stockM = stockMm / 1000;
      const clearanceM = 0.0002; // 0.2 mm slide-fit clearance
      // Two 120 x 80 x stockMm vertical plates crossing orthogonally through their centres.
      const crossScene = sceneOf(
        bodyNode('plate_x', [{ name: 'gx', type: 'box', size: [0.06, stockM / 2, 0.04] }], [0, 0, 0.04]),
        bodyNode('plate_y', [{ name: 'gy', type: 'box', size: [stockM / 2, 0.06, 0.04] }], [0, 0, 0.04])
      );

      const bare = exportLaserCutSvg(crossScene, {
        ...DEFAULT_LASER_OPTIONS,
        materialThickness: stockM,
        jointMode: 'slot',
        kerf: 0,
        jointClearance: clearanceM,
        cornerRelief: 'none',
        bitDiameter: bitM,
        margin: layoutMargin('cnc', bitM),
        cutOutset: layoutCutOutset('cnc', bitM),
      });
      expect(bare.success).toBe(true);
      expect(bare.panels).toHaveLength(2);
      expect((bare.warnings ?? []).some((w) => w.includes('No joints were cut'))).toBe(false);

      // Each plate has a single half-height open slot (40 + clearance/2 mm deep, stockMm + 0.2 mm wide)
      const expectedSlotWidthMm = stockMm + clearanceM * 1000;
      const expectedSlotDepthMm = 40 + (clearanceM * 1000) / 2;
      for (const p of bare.panels!) {
        expect(p.outerPolygon2D.length).toBe(8);
        expect(hasSelfIntersection(p.outerPolygon2D)).toBe(false);
        const xs = [...new Set(p.outerPolygon2D.map((q) => +q.x.toFixed(2)))].sort((a, b) => a - b);
        const ys = [...new Set(p.outerPolygon2D.map((q) => +q.y.toFixed(2)))].sort((a, b) => a - b);
        // Depending on packing rotation, the slot runs along X or Y:
        const widths = [
          ...xs.slice(1).map((v, i) => v - xs[i]),
          ...ys.slice(1).map((v, i) => v - ys[i]),
        ];
        expect(widths.some((w) => Math.abs(w - expectedSlotWidthMm) < 0.05)).toBe(true);
        expect(widths.some((w) => Math.abs(w - expectedSlotDepthMm) < 0.05)).toBe(true);
      }

      for (const relief of ['dogbone', 'tbone'] as const) {
        const cncRes = exportLaserCutSvg(crossScene, {
          ...DEFAULT_LASER_OPTIONS,
          materialThickness: stockM,
          jointMode: 'slot',
          kerf: 0,
          jointClearance: clearanceM,
          cornerRelief: relief,
          bitDiameter: bitM,
          margin: layoutMargin('cnc', bitM),
          cutOutset: layoutCutOutset('cnc', bitM),
        });
        expect(cncRes.success).toBe(true);
        expect(cncRes.panels).toHaveLength(2);

        const r = bitMm / 2;
        for (let idx = 0; idx < 2; idx++) {
          const rawPoly = bare.panels![idx].outerPolygon2D;
          const relievedPoly = cncRes.panels![idx].outerPolygon2D;
          expect(hasSelfIntersection(relievedPoly)).toBe(false);
          expect(relievedPoly.length).toBeGreaterThan(rawPoly.length);

          // Cutter centre path at +r around the outer outline must reach within r of EVERY
          // internal bottom corner of the cross-lap slot so mating sheets bottom out cleanly!
          const toolPaths = offsetLoop(relievedPoly, r);
          expect(toolPaths.length).toBe(1);
          for (const v of rawPoly) {
            // Find the two concave bottom corners of the slot (strictly interior to bbox)
            const inInteriorX = v.x > 1 && v.x < bare.panels![idx].width2D! - 1;
            const inInteriorY = v.y > 1 && v.y < bare.panels![idx].height2D! - 1;
            if (inInteriorX && inInteriorY) {
              expect(distToLoop(v, toolPaths[0])).toBeLessThanOrEqual(r + 0.05);
            }
          }
        }

        const g = generateLaserCutGcode(cncRes.panels!, {
          ...DEFAULT_GCODE_OPTIONS,
          machineMode: 'cnc',
          bitDiameterMm: bitMm,
          cutDepthZ: stockMm,
          zStepdown: routerStepdownMm(stockMm, bitMm),
          attachmentsEnabled: true,
        });
        expect(g.success).toBe(true);
        expect(g.warnings).toBeUndefined();
        expect(g.attachmentCount).toBeGreaterThanOrEqual(4);
        expect(g.compensationMm).toBeCloseTo(bitMm / 2, 4);
      }
    }
  });

  it('handles narrow cross-lap slots (slotWidth < 1.71 * bitDiameter) by merging adjacent dogbones cleanly', () => {
    // 4.5 mm stock cut with 3.175 mm (1/8") bit + 0.2 mm clearance -> 4.7 mm slot (< 1.71 * 3.175 = 5.43 mm)
    const narrowCross = sceneOf(
      bodyNode('a', [{ name: 'ga', type: 'box', size: [0.05, 0.00225, 0.03] }], [0, 0, 0.03]),
      bodyNode('b', [{ name: 'gb', type: 'box', size: [0.00225, 0.05, 0.03] }], [0, 0, 0.03])
    );
    const bitM = 0.003175;
    const bare = exportLaserCutSvg(narrowCross, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.0045,
      jointMode: 'slot',
      kerf: 0,
      jointClearance: 0.0002,
      cornerRelief: 'none',
      bitDiameter: bitM,
    });
    const dogboned = exportLaserCutSvg(narrowCross, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.0045,
      jointMode: 'slot',
      kerf: 0,
      jointClearance: 0.0002,
      cornerRelief: 'dogbone',
      bitDiameter: bitM,
    });
    expect(dogboned.success).toBe(true);
    const r = 3.175 / 2;
    for (let i = 0; i < 2; i++) {
      const poly = dogboned.panels![i].outerPolygon2D;
      expect(hasSelfIntersection(poly)).toBe(false);
      const toolPaths = offsetLoop(poly, r);
      expect(toolPaths.length).toBe(1);
      for (const v of bare.panels![i].outerPolygon2D) {
        const inInteriorX = v.x > 1 && v.x < bare.panels![i].width2D! - 1;
        const inInteriorY = v.y > 1 && v.y < bare.panels![i].height2D! - 1;
        if (inInteriorX && inInteriorY) {
          expect(distToLoop(v, toolPaths[0])).toBeLessThanOrEqual(r + 0.05);
        }
      }
    }
  });

  it('cuts T-joint edge tenons and interior mortises with CNC dogbone relief', () => {
    // Vertical back wall (160 x 120 x 6 mm at y = 0) and a horizontal shelf (140 x 80 x 6 mm)
    // whose back edge butts flush into the middle of the back wall at z = 60 mm.
    const tJointScene = sceneOf(
      bodyNode('wall', [{ name: 'wall_panel', type: 'box', size: [0.08, 0.003, 0.06] }], [0, 0, 0.06]),
      bodyNode('shelf', [{ name: 'shelf_panel', type: 'box', size: [0.07, 0.04, 0.003] }], [0, 0.043, 0.06])
    );

    const res = exportLaserCutSvg(tJointScene, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
      jointMode: 'slot',
      kerf: 0,
      jointClearance: 0.0002,
      cornerRelief: 'dogbone',
      bitDiameter: 0.003175,
      margin: layoutMargin('cnc', 0.003175),
      cutOutset: layoutCutOutset('cnc', 0.003175),
    });

    expect(res.success).toBe(true);
    expect(res.panels).toHaveLength(2);
    const wall = res.panels!.find((p) => p.name.includes('wall'))!;
    const shelf = res.panels!.find((p) => p.name.includes('shelf'))!;
    expect(wall.innerCutouts2D.length).toBeGreaterThanOrEqual(1);
    expect(shelf.outerPolygon2D.length).toBeGreaterThan(4);
    expect(hasSelfIntersection(shelf.outerPolygon2D)).toBe(false);
    for (const mortise of wall.innerCutouts2D) {
      expect(hasSelfIntersection(mortise)).toBe(false);
    }

    const g = generateLaserCutGcode(res.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: 3.175,
      cutDepthZ: 6,
      zStepdown: routerStepdownMm(6, 3.175),
    });
    expect(g.success).toBe(true);
    expect(g.warnings).toBeUndefined();
    expect(g.operations.filter((o) => o.type === 'cut').length).toBe(2 + wall.innerCutouts2D.length);
  });

  it('decomposes a closed 3D box in both slot and finger modes across multi-sheet CNC stock cleanly', () => {
    const boxScene = sceneOf(
      bodyNode('crate', [{ name: 'gc', type: 'box', size: [0.075, 0.06, 0.05] }], [0, 0, 0.05])
    );
    const smallStock: StockItem[] = [{ widthMm: 220, heightMm: 180, thicknessMm: 6, quantity: null }];

    for (const jointMode of ['slot', 'finger'] as const) {
      const res = exportLaserCutSvg(boxScene, {
        ...DEFAULT_LASER_OPTIONS,
        materialThickness: 0.006,
        jointMode,
        kerf: 0,
        jointClearance: 0.00015,
        cornerRelief: 'dogbone',
        bitDiameter: 0.003175,
        margin: layoutMargin('cnc', 0.003175),
        cutOutset: layoutCutOutset('cnc', 0.003175),
        stock: smallStock,
      });
      expect(res.success).toBe(true);
      expect(res.panels).toHaveLength(6);
      expect(res.sheetCount).toBeGreaterThanOrEqual(2);
      expect(res.offSheet ?? []).toHaveLength(0);
      for (const p of res.panels!) {
        expect(hasSelfIntersection(p.outerPolygon2D)).toBe(false);
        for (const h of p.innerCutouts2D) expect(hasSelfIntersection(h)).toBe(false);
      }

      const g = generateLaserCutGcode(res.panels!, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        bitDiameterMm: 3.175,
        cutDepthZ: 6,
        zStepdown: 3,
      });
      expect(g.success).toBe(true);
      expect(g.warnings).toBeUndefined();
      expect(g.sheetCount).toBe(res.sheetCount);
    }
  });
});

describe('Audit Fixes L-C1..L-L2', () => {
  it('L-C1: extracts mesh-baked blind pockets independently of geom.faces order and mills them to exact depth in CNC G-code', () => {
    for (const reverse of [false, true]) {
      const mesh = slabWithTopBlindPocketMesh(120, 80, 10, 30, 20, 90, 60, 4, reverse);
      const scene = sceneOf(bodyNode('tray', [mesh]));

      const res = exportLaserCutSvg(scene, {
        ...DEFAULT_LASER_OPTIONS,
        materialThickness: 0.01,
        kerf: 0,
      });
      expect(res.success).toBe(true);
      expect(res.panels).toHaveLength(1);
      const panel = res.panels![0];
      // Outer footprint is the full 120 x 80 mm slab, NOT pierced by a through-hole!
      expect(panel.innerCutouts2D).toHaveLength(0);
      expect(Math.max(panel.width2D!, panel.height2D!)).toBeCloseTo(120, 1);
      expect(Math.min(panel.width2D!, panel.height2D!)).toBeCloseTo(80, 1);

      expect(panel.blindPockets2D).toBeDefined();
      expect(panel.blindPockets2D).toHaveLength(1);
      expect(panel.blindPockets2D![0].depthMm).toBeCloseTo(4, 2);
      expect(res.svg).toContain('id="blind-pockets"');
      expect(res.svg).toContain('data-operation="fill"');
      expect(res.svg).toContain('data-depth-mm="4.00"');

      const g = generateLaserCutGcode(res.panels!, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        bitDiameterMm: 3.175,
        cutDepthZ: 10,
        zStepdown: 2.5,
      });
      expect(g.success).toBe(true);
      const pocketOps = g.operations.filter((o) => o.type === 'pocket');
      expect(pocketOps).toHaveLength(1);
      // Pocket reaches Z = -4.000 mm while through-cut outline reaches Z = -10.200 mm
      expect(g.gcode).toContain('Z-4.000');
      expect(g.gcode).toContain('Z-10.200');
    }
  });

  it('L-C2: simulates split rectangular rings (splitOversized: true) with finite 3D bounds and zero NaNs', () => {
    const bar: StockItem[] = [{ widthMm: 320, heightMm: 40, thicknessMm: 60, quantity: 16 }];
    const result = exportLaserCutSvg(castingFlaskPreset, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.06,
      stock: bar,
      splitOversized: true,
    });
    expect(result.success).toBe(true);
    expect(result.panels).toHaveLength(8);
    for (const p of result.panels!) {
      expect(p.edges3D.length).toBeGreaterThanOrEqual(3);
    }

    const transform = laserStockTransform(result.panels!, result.scaleFactor ?? 1);
    for (const v of [...transform.modelMinMm, ...transform.modelMaxMm]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    const job = runSheetJob({ parts: laserSheetParts(result.panels!, result.sheets) });
    expect(job.positions.length).toBeGreaterThan(0);
    for (const placement of ['beside', 'overlay'] as const) {
      const simNode = simulatedBody({ ...job, cellMm: 0, toleranceMm: 0 }, transform, {
        id: `sim_${placement}`,
        name: 'Flask sim',
        kind: 'laser',
        placement,
      });
      for (const c of simNode.pos) expect(Number.isFinite(c)).toBe(true);
      for (const c of simNode.geoms[0].renderVertices!) expect(Number.isFinite(c)).toBe(true);
    }
  });

  it('L-H1 & L-H2: cuts subtractive ellipsoid and concave mesh CSG cutters, clips edge notches, and unions overlapping holes', () => {
    // Concave L-shaped prism cutter spanning z in [-20..20] mm
    const lOutline: [number, number][] = [[-15, -15], [15, -15], [15, -5], [-5, -5], [-5, 15], [-15, 15]];
    const n = lOutline.length;
    const verts: number[] = [];
    for (const [x, y] of lOutline) verts.push(x / 1000, y / 1000, 0.02);
    for (const [x, y] of lOutline) verts.push(x / 1000, y / 1000, -0.02);
    const faces: number[] = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, n + 2, n + 1, n, n + 3, n + 2, n, n + 4, n + 3, n, n + 5, n + 4, n];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(i, n + i, n + j, i, n + j, j);
    }

    const scene = sceneOf(
      bodyNode('plate', [
        { name: 'base', type: 'box', size: [0.1, 0.08, 0.003] },
        // Concave L-mesh hole on the left
        { name: 'l_cut', type: 'mesh', size: [1], pos: [-0.045, 0, 0], renderVertices: verts, faces, csg: 'difference' },
        // Ellipsoid hole on the right
        { name: 'oval', type: 'ellipsoid', size: [0.018, 0.01, 0.02], pos: [0.045, 0, 0], csg: 'difference' },
        // Edge-straddling box notch on top edge (y = +80 mm)
        { name: 'top_notch', type: 'box', size: [0.01, 0.01, 0.02], pos: [0, 0.08, 0], csg: 'difference' },
      ])
    );

    const { panels, invalidGeoms } = extractPanelsFromScene(scene, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
    });
    expect(invalidGeoms).toHaveLength(0);
    expect(panels).toHaveLength(1);
    // Two interior holes (concave 6-vertex L-hole + smooth oval) and one perimeter notch on outerPolygon2D!
    expect(panels[0].innerCutouts2D).toHaveLength(2);
    expect(panels[0].innerCutouts2D.some((h) => h.length === 6)).toBe(true);
    expect(panels[0].innerCutouts2D.some((h) => h.length >= 16)).toBe(true);
    expect(panels[0].outerPolygon2D.length).toBe(8);
  });

  it('L-M1: laserSheetParts respects CNC faceToThickness when simulating thicker rack stock', () => {
    const scene = sceneOf(bodyNode('plate', [{ name: 'g', type: 'box', size: [0.04, 0.03, 0.003] }]));
    const res = exportLaserCutSvg(scene, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
      stock: [{ widthMm: 300, heightMm: 200, thicknessMm: 10, quantity: 2 }],
    });
    expect(res.success).toBe(true);
    const unfaced = laserSheetParts(res.panels!, res.sheets, { faceToThickness: false });
    const faced = laserSheetParts(res.panels!, res.sheets, { faceToThickness: true });
    expect(unfaced[0].zTo - unfaced[0].zFrom).toBeCloseTo(10, 3);
    expect(faced[0].zTo - faced[0].zFrom).toBeCloseTo(6, 3);
  });

  it('L-M2: splitOversized applies jointClearance & dogbone on finger splice seams and avoids stale/false warnings', () => {
    // 300 x 300 x 6 mm rectangular frame (35 mm border) with central 230 x 230 mm window
    const frameScene = sceneOf(
      bodyNode('frame', [
        { name: 'outer_frame', type: 'box', size: [0.15, 0.15, 0.003] },
        { name: 'window_void', type: 'box', size: [0.115, 0.115, 0.01], csg: 'difference' },
      ], [0, 0, 0.003])
    );
    const offcutBars: StockItem[] = [{ widthMm: 180, heightMm: 60, thicknessMm: 6, quantity: 16 }];

    // 1) Manual scaleFactor 0.9 (270 x 270 mm frame) splits into 4 mitred strips AND finger-splices
    //    each strip across 180 mm bars (= 8 pieces), applies jointClearance + dogbone relief cleanly,
    //    and suppresses false "No joints were cut" warning!
    const splitRes = exportLaserCutSvg(frameScene, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
      stock: offcutBars,
      kerf: 0,
      jointClearance: 0.0003,
      cornerRelief: 'dogbone',
      bitDiameter: 0.003175,
      scaleFactor: 0.9,
      splitOversized: true,
    });
    expect(splitRes.success).toBe(true);
    expect(splitRes.panels!.length).toBe(8);
    expect((splitRes.warnings ?? []).some((w) => w.includes('finger-spliced pieces'))).toBe(true);
    expect((splitRes.warnings ?? []).some((w) => w.includes('No joints were cut'))).toBe(false);
    for (const p of splitRes.panels!) {
      expect(p.outerPolygon2D.length).toBeGreaterThan(12);
      expect(hasSelfIntersection(p.outerPolygon2D)).toBe(false);
    }

    // 2) autoScale + maxSheets: 1 shrinking to fit a single 200 x 200 mm sheet without splitting
    //    emits NO stale s=1.0 split warning!
    const autoScaled = exportLaserCutSvg(frameScene, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
      sheetWidth: 0.2,
      sheetHeight: 0.2,
      maxSheets: 1,
      autoScale: true,
      splitOversized: true,
    });
    expect(autoScaled.success).toBe(true);
    expect(autoScaled.panels).toHaveLength(1);
    expect((autoScaled.warnings ?? []).some((w) => w.includes('split into 4 mitred'))).toBe(false);
  });

  it('L-M3: generateLaserCutGcode applies per-sheet zStepdown on mixed-thickness stock', () => {
    const thinAndThick = sceneOf(
      bodyNode('thin_p', [{ name: 'g1', type: 'box', size: [0.03, 0.03, 0.001] }], [-0.05, 0, 0.001]),
      bodyNode('thick_p', [{ name: 'g2', type: 'box', size: [0.03, 0.03, 0.006] }], [0.05, 0, 0.006])
    );
    const res = exportLaserCutSvg(thinAndThick, {
      ...DEFAULT_LASER_OPTIONS,
      stock: [
        { widthMm: 200, heightMm: 200, thicknessMm: 2, quantity: 1 },
        { widthMm: 200, heightMm: 200, thicknessMm: 12, quantity: 1 },
      ],
    });
    expect(res.success).toBe(true);
    expect(res.sheets).toHaveLength(2);

    const bitMm = 6.35;
    const g = generateLaserCutGcode(res.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: bitMm,
      cutDepthZ: res.sheets![0].thicknessMm,
      zStepdown: routerStepdownMm(res.sheets![0].thicknessMm, bitMm), // Row 1 is 2 mm -> stepdown 2 mm
      sheetStockThicknessMm: res.sheets!.map((s) => s.thicknessMm),
      sheetZStepdownMm: res.sheets!.map((s) => routerStepdownMm(s.thicknessMm, bitMm)), // [2, 3]
    });
    expect(g.success).toBe(true);
    // Sheet 2 (12 mm stock with 3 mm per-sheet stepdown) takes 4 passes, NOT 6 passes of 2 mm!
    expect(g.gcode).toContain('; Pass 1/4');
    expect(g.gcode).not.toContain('; Pass 1/6');
  });

  it('L-M4: groups each panel outer + inner holes into one compound <path> with d= first and data-panel attributes', () => {
    const holedPlate = sceneOf(
      bodyNode('holed', [
        { name: 'base', type: 'box', size: [0.05, 0.04, 0.003] },
        { name: 'hole1', type: 'cylinder', size: [0.008, 0.02], pos: [-0.02, 0, 0], csg: 'difference' },
        { name: 'hole2', type: 'cylinder', size: [0.008, 0.02], pos: [0.02, 0, 0], csg: 'difference' },
      ])
    );
    const res = exportLaserCutSvg(holedPlate, { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006 });
    expect(res.success).toBe(true);
    const cutGroupMatch = /<g id="cut-paths"[^>]*>([\s\S]*?)<\/g>/.exec(res.svg!);
    expect(cutGroupMatch).not.toBeNull();
    const pathTags = [...cutGroupMatch![1].matchAll(/<path\s+([^/>]+)\/>/g)];
    expect(pathTags).toHaveLength(1);
    expect(pathTags[0][1].trim().startsWith('d="')).toBe(true);
    expect(pathTags[0][1]).toContain('fill-rule="evenodd"');
    expect(pathTags[0][1]).toContain('data-panel="base"');
    // Outer + 2 holes = 3 closed 'M ... Z' subpaths inside the single compound <path>
    expect(pathTags[0][1].match(/\bM\s/g)).toHaveLength(3);
  });

  it('L-L2: laserStockTransform includes half-thickness normal bounds so horizontal single plates rest flush at Z=0', () => {
    const flatPlate = sceneOf(
      bodyNode('flat', [{ name: 'gf', type: 'box', size: [0.05, 0.04, 0.003] }], [0, 0, 0.003])
    );
    const res = exportLaserCutSvg(flatPlate, { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006 });
    expect(res.success).toBe(true);
    const transform = laserStockTransform(res.panels!, res.scaleFactor ?? 1);
    expect(transform.modelMinMm[2]).toBeCloseTo(0, 5);
    expect(transform.modelMaxMm[2]).toBeCloseTo(6, 5);
  });
});
