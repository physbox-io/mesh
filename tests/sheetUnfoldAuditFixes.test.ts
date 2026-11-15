import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import {
  exportSheetUnfold,
  clusterTrianglesToPolyFaces,
  polygonsOverlap2D,
  type Point2D,
  type UnfoldIsland,
} from '../src/utils/sheetUnfoldExporter';
import { foldSheetUnfold, sheetFoldSimulationRequest } from '../src/utils/sheetFoldSimulation';
import { createLattice, vertexAt, addFace, serializeCage } from '../src/utils/latticeMesh';
import { latticeBracketPreset } from '../src/presets/latticeBracket';

function makeScene(nodes: SceneNode[]): SceneGraph {
  return {
    nodes,
    joints: [],
    actuators: [],
    sensors: [],
  } as unknown as SceneGraph;
}

interface Seg2D {
  a: Point2D;
  b: Point2D;
}

function parseSvgGroupSegments(svg: string, groupId: string): Seg2D[] {
  const groupRegex = new RegExp(`<g[^>]*id="${groupId}"[^>]*>([\\s\\S]*?)<\\/g>`);
  const match = svg.match(groupRegex);
  if (!match) return [];
  const inner = match[1];
  const segs: Seg2D[] = [];

  for (const pm of inner.matchAll(/<path[^>]*\bd="([^"]+)"/g)) {
    const d = pm[1].trim();
    const tokens = d.split(/\s+/);
    const pts: Point2D[] = [];
    let closed = false;
    for (let i = 0; i < tokens.length; ) {
      const cmd = tokens[i];
      if (cmd === 'M' || cmd === 'L') {
        pts.push({ x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) });
        i += 3;
      } else if (cmd === 'Z' || cmd === 'z') {
        closed = true;
        i += 1;
      } else {
        i += 1;
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      segs.push({ a: pts[i], b: pts[i + 1] });
    }
    if (closed && pts.length >= 3) {
      segs.push({ a: pts[pts.length - 1], b: pts[0] });
    }
  }

  for (const lm of inner.matchAll(/<line[^>]*\bx1="([^"]+)"[^>]*\by1="([^"]+)"[^>]*\bx2="([^"]+)"[^>]*\by2="([^"]+)"/g)) {
    segs.push({
      a: { x: Number(lm[1]), y: Number(lm[2]) },
      b: { x: Number(lm[3]), y: Number(lm[4]) },
    });
  }

  return segs;
}

function segmentsProperlyCross(s1: Seg2D, s2: Seg2D, eps = 0.05): boolean {
  const d1x = s1.b.x - s1.a.x;
  const d1y = s1.b.y - s1.a.y;
  const d2x = s2.b.x - s2.a.x;
  const d2y = s2.b.y - s2.a.y;
  const l1 = Math.hypot(d1x, d1y);
  const l2 = Math.hypot(d2x, d2y);
  if (l1 < eps || l2 < eps) return false;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-6 * l1 * l2) return false;
  const dx = s2.a.x - s1.a.x;
  const dy = s2.a.y - s1.a.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;
  const mt = eps / l1;
  const mu = eps / l2;
  return t > mt && t < 1 - mt && u > mu && u < 1 - mu;
}

function segmentsCollinearOverlap(s1: Seg2D, s2: Seg2D, eps = 0.05): boolean {
  const dx = s1.b.x - s1.a.x;
  const dy = s1.b.y - s1.a.y;
  const len = Math.hypot(dx, dy);
  const len2 = Math.hypot(s2.b.x - s2.a.x, s2.b.y - s2.a.y);
  if (len < eps || len2 < eps) return false;
  const ux = dx / len;
  const uy = dy / len;
  // Perpendicular distances of s2 endpoints from s1 line
  const pA = Math.abs((s2.a.x - s1.a.x) * uy - (s2.a.y - s1.a.y) * ux);
  const pB = Math.abs((s2.b.x - s1.a.x) * uy - (s2.b.y - s1.a.y) * ux);
  if (pA > eps || pB > eps) return false;
  const tA = (s2.a.x - s1.a.x) * ux + (s2.a.y - s1.a.y) * uy;
  const tB = (s2.b.x - s1.a.x) * ux + (s2.b.y - s1.a.y) * uy;
  const lo = Math.max(0, Math.min(tA, tB));
  const hi = Math.min(len, Math.max(tA, tB));
  return hi - lo > 0.2;
}

function pointToSegDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

describe('Sheet Unfold Outputter Audit Regression Suite (U-C1 .. U-L1)', () => {
  it('U-C1: preserves true 3D chirality on enantiomorphic asymmetric brackets and matches foldSheetUnfold without mirroring', () => {
    // Build a chiral 3-face bracket in Z-up mm (converted to m):
    //   Face 0 (Base): z = 0, x in [0, 80], y in [0, 40], normal +Z
    //   Face 1 (Right flange): x = 80, y in [0, 40], z in [-35, 0] (mountain +90 deg away from +Z)
    //   Face 2 (Front asymmetric tab): y = 0, x in [0, 25], z in [0, +20] (valley -90 deg towards +Z)
    // This 3D shape has NO mirror symmetry plane, so a Y-reflected flat pattern folds into its non-superimposable enantiomer!
    const lat = createLattice(0.001);
    const b0 = vertexAt(lat, 0, 0, 0);
    const b1 = vertexAt(lat, 25, 0, 0);
    const b2 = vertexAt(lat, 80, 0, 0);
    const b3 = vertexAt(lat, 80, 40, 0);
    const b4 = vertexAt(lat, 0, 40, 0);

    const r0 = vertexAt(lat, 80, 0, -35);
    const r1 = vertexAt(lat, 80, 40, -35);

    const t0 = vertexAt(lat, 0, 0, 20);
    const t1 = vertexAt(lat, 25, 0, 20);

    // Base polygon wound CCW around +Z: (0,0)->(25,0)->(80,0)->(80,40)->(0,40)
    addFace(lat, [b0, b1, b2, b3, b4]);
    // Right flange wound CCW around +X: (80,0,0)->(80,0,-35)->(80,40,-35)->(80,40,0)
    addFace(lat, [b2, r0, r1, b3]);
    // Front tab wound CCW around +Y? Wait: Base has +Z normal; for valley fold towards +Z, Front tab at y=0 has +Y inward?
    // Check edge b0->b1: in Base, edge is (0,0)->(25,0), so child traverses b1->b0 = (25,0,0)->(0,0,0)->(0,0,20)->(25,0,20), normal is (0, +1, 0)!
    addFace(lat, [b1, b0, t0, t1]);

    const chiralNode: SceneNode = {
      id: 'chiral_bracket',
      name: 'ChiralBracket',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: serializeCage(lat),
      geoms: [],
      joints: [],
      children: [],
    };
    const scene = makeScene([chiralNode]);

    for (const mode of ['papercraft', 'sheet_metal', 'soft_goods'] as const) {
      const opts = {
        mode,
        thicknessMm: 1.5,
        bendRadiusMm: 1.5,
        kFactor: 0.44,
        tabWidthMm: 0,
        seamAllowanceMm: 0,
      };
      const res = exportSheetUnfold(scene, opts);
      expect(res.success).toBe(true);
      expect(res.totalFaces).toBe(3);
      expect(res.foldCount).toBe(2);

      const folded = foldSheetUnfold(res, { ...opts, scaleFactor: 1 });
      expect(folded.folds).toBe(2);
      expect(folded.deviation.maxMm).toBeLessThan(0.05);
    }

    // Verify both directly in SVG coordinates and via 3D folding that top-down SVG
    // emits the exact un-mirrored island coordinates verified by foldSheetUnfold:
    const goodRes = exportSheetUnfold(scene, { mode: 'papercraft', tabWidthMm: 0 });
    for (const fe of goodRes.islands[0].foldEdges) {
      const expectedAttr = `x1="${Number(fe.p1.x.toFixed(3))}" y1="${Number(fe.p1.y.toFixed(3))}" x2="${Number(fe.p2.x.toFixed(3))}" y2="${Number(fe.p2.y.toFixed(3))}"`;
      expect(goodRes.svg).toContain(expectedAttr);
    }

    // Simulating the pre-fix U-C1 bug (Y-reflected sheet cut with etched Mountain/Valley lines
    // still folded toward -Z/+Z across each hinge) produces the mirror-image enantiomer
    // and cannot align under any proper 3D rotation in SO(3):
    const flipY = (p: Point2D): Point2D => ({ x: p.x, y: 200 - p.y });
    const mirroredIsland: UnfoldIsland = {
      ...goodRes.islands[0],
      faces: goodRes.islands[0].faces.map((f) => ({
        ...f,
        polygon2D: f.polygon2D.map(flipY),
        centroid2D: flipY(f.centroid2D),
      })),
      foldEdges: goodRes.islands[0].foldEdges.map((fe) => ({
        ...fe,
        // Swap p1/p2 under 2D reflection so outward hinge normal `o` still points
        // from faceA -> faceB and Mountain still bends toward -Z (away from etched top):
        p1: flipY(fe.p2),
        p2: flipY(fe.p1),
      })),
      cutSeams: goodRes.islands[0].cutSeams.map((cs) => ({
        ...cs,
        p1: flipY(cs.p1),
        p2: flipY(cs.p2),
      })),
    };
    const mirroredFold = foldSheetUnfold(
      { islands: [mirroredIsland], mode: 'papercraft' },
      { thicknessMm: 1.5, bendRadiusMm: 1.5, kFactor: 0.44 }
    );
    expect(mirroredFold.deviation.maxMm).toBeGreaterThan(8.0);
  });

  it('U-C2: emits zero interior bend-zone cut slits and zero duplicate overlapping cut segments in sheet_metal mode', () => {
    const boxNode: SceneNode = {
      id: 'sm_box',
      name: 'SheetMetalBox',
      pos: [0, 0, 0],
      geoms: [{ name: 'b', type: 'box', size: [0.03, 0.025, 0.02] }],
      joints: [],
      children: [],
    };
    const res = exportSheetUnfold(makeScene([boxNode]), {
      mode: 'sheet_metal',
      thicknessMm: 2.0,
      bendRadiusMm: 2.0,
      kFactor: 0.44,
      bendReliefWidthMm: 1.5,
      bendReliefDepthMm: 2.0,
    });

    expect(res.success).toBe(true);
    const cutSegs = parseSvgGroupSegments(res.svg, 'layer-cut');
    expect(cutSegs.length).toBeGreaterThan(10);

    // 1. No two segments in layer-cut may cross or collinearly overlap (no double-cut bridges)
    for (let i = 0; i < cutSegs.length; i++) {
      for (let j = i + 1; j < cutSegs.length; j++) {
        expect(segmentsProperlyCross(cutSegs[i], cutSegs[j], 0.02)).toBe(false);
        expect(segmentsCollinearOverlap(cutSegs[i], cutSegs[j], 0.02)).toBe(false);
      }
    }

    // 2. Single closed outer cut path (no stray <line> slits or floating relief <path> chads)
    const layerCutMatch = res.svg.match(/<g id="layer-cut"[^>]*>([\s\S]*?)<\/g>/);
    expect(layerCutMatch).not.toBeNull();
    expect(layerCutMatch![1]).not.toContain('<line ');
    const pathMatches = [...layerCutMatch![1].matchAll(/<path /g)];
    expect(pathMatches).toHaveLength(1);
    expect(layerCutMatch![1]).toContain(' Z"');
  });

  it('U-C3: preserves planar interior hole cutouts on layer-cut, filters internal bore facets, and triangulates holes in foldSheetUnfold', () => {
    // Build a 60 x 50 x 15 mm thick block with a 20 x 16 mm rectangular through-hole in the middle
    // (top face at z=15, bottom face at z=0, 4 outer walls, and 4 internal bore walls).
    const vertsM = [
      // Outer bottom z = 0 (0..3)
      0, 0, 0,
      0.06, 0, 0,
      0.06, 0.05, 0,
      0, 0.05, 0,
      // Outer top z = 0.015 (4..7)
      0, 0, 0.015,
      0.06, 0, 0.015,
      0.06, 0.05, 0.015,
      0, 0.05, 0.015,
      // Inner hole bottom z = 0: x in [0.02, 0.04], y in [0.017, 0.033] (8..11)
      0.02, 0.017, 0,
      0.04, 0.017, 0,
      0.04, 0.033, 0,
      0.02, 0.033, 0,
      // Inner hole top z = 0.015 (12..15)
      0.02, 0.017, 0.015,
      0.04, 0.017, 0.015,
      0.04, 0.033, 0.015,
      0.02, 0.033, 0.015,
    ];

    const tris: number[] = [
      // Top annular ring (+Z normal): 4 quads around hole (4,5,6,7 outer; 12,13,14,15 inner)
      4, 5, 13, 4, 13, 12,
      5, 6, 14, 5, 14, 13,
      6, 7, 15, 6, 15, 14,
      7, 4, 12, 7, 12, 15,
      // Bottom annular ring (-Z normal): (0,3,2,1 outer; 8,11,10,9 inner)
      0, 8, 9, 0, 9, 1,
      1, 9, 10, 1, 10, 2,
      2, 10, 11, 2, 11, 3,
      3, 11, 8, 3, 8, 0,
      // 4 outer side walls (outward normals)
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
      // 4 internal bore walls (normals pointing inward into the hole cavity)
      8, 12, 13, 8, 13, 9,
      9, 13, 14, 9, 14, 10,
      10, 14, 15, 10, 15, 11,
      11, 15, 12, 11, 12, 8,
    ];

    // Verify direct clusterTrianglesToPolyFaces preserves holesVerts and net area
    const vec3s: THREE.Vector3[] = [];
    for (let i = 0; i < vertsM.length; i += 3) {
      vec3s.push(new THREE.Vector3(vertsM[i], vertsM[i + 1], vertsM[i + 2]));
    }
    const rawClustered = clusterTrianglesToPolyFaces(vec3s, tris, 2.5);
    const facesWithHoles = rawClustered.filter((f) => f.holesVerts && f.holesVerts.length === 1);
    expect(facesWithHoles).toHaveLength(2);
    // Outer = 60 * 50 = 3000 mm^2, Hole = 20 * 16 = 320 mm^2 -> Net = 2680 mm^2 = 0.00268 m^2
    expect(facesWithHoles[0].areaM2 * 1e6).toBeCloseTo(2680, 1);

    const node: SceneNode = {
      id: 'holed_block',
      name: 'HoledBlock',
      pos: [0, 0, 0],
      geoms: [{ name: 'm', type: 'mesh', size: [0.03, 0.025, 0.0075], renderVertices: vertsM, faces: tris }],
      joints: [],
      children: [],
    };
    const res = exportSheetUnfold(makeScene([node]), {
      mode: 'papercraft',
      thicknessMm: 0.5,
      tabWidthMm: 0,
    });

    expect(res.success).toBe(true);
    // 4 internal bore facets filtered out -> clean 6-face holed box!
    expect(res.totalFaces).toBe(6);
    expect(res.islands).toHaveLength(1);
    const holedUnfolded = res.islands[0].faces.filter((f) => f.holes2D && f.holes2D.length === 1);
    expect(holedUnfolded).toHaveLength(2);
    // 1 outer cut loop + 2 interior hole cut loops = 3 cut polylines
    expect(res.islands[0].cutPolylines2D).toHaveLength(3);

    // Verify foldSheetUnfold triangulates the cutouts (missing slab volume = 2 * 320 mm^2 * drawnThicknessMm)
    const folded = foldSheetUnfold(res, { thicknessMm: 0.5, bendRadiusMm: 0, kFactor: 0.5, scaleFactor: 1 });
    const solidFacesVolMm3 = (2 * 3000 + 2 * (60 * 15) + 2 * (50 * 15)) * folded.drawnThicknessMm;
    const expectedVolMm3 = (2 * 2680 + 2 * (60 * 15) + 2 * (50 * 15)) * folded.drawnThicknessMm;
    expect(folded.volumeMm3).toBeCloseTo(expectedVolMm3, 0);
    expect(folded.volumeMm3).toBeLessThan(solidFacesVolMm3 - 100);
  });

  it('U-C4: extracts a single outer skin for thin-walled solid shells (latticeBracketPreset & open-top hollow tray) while keeping solid cubes closed', () => {
    // 1. latticeBracketPreset (5 mm thick L-bracket + 4 mm thick triangular gusset)
    const bracketRes = exportSheetUnfold(latticeBracketPreset, {
      mode: 'sheet_metal',
      thicknessMm: 5.0,
      bendRadiusMm: 2.0,
      kFactor: 0.44,
    });
    expect(bracketRes.success).toBe(true);
    // 2-face L-bracket + 1-face triangular gusset = 3 faces across 2 islands (not 14+ double-skin/rim faces!)
    expect(bracketRes.islands).toHaveLength(2);
    expect(bracketRes.totalFaces).toBe(3);
    expect(bracketRes.foldCount).toBe(1);

    // 2. Thin-walled open-top rectangular tray (100 x 80 x 40 mm outer, 2 mm wall thickness)
    // Outer box: x in [0, 0.1], y in [0, 0.08], z in [0, 0.04] (missing +Z top)
    // Inner cavity: x in [0.002, 0.098], y in [0.002, 0.078], z in [0.002, 0.04]
    const trayVerts = [
      // Outer bottom z=0 (0..3)
      0, 0, 0,  0.1, 0, 0,  0.1, 0.08, 0,  0, 0.08, 0,
      // Outer top rim z=0.04 (4..7)
      0, 0, 0.04,  0.1, 0, 0.04,  0.1, 0.08, 0.04,  0, 0.08, 0.04,
      // Inner floor z=0.002 (8..11)
      0.002, 0.002, 0.002,  0.098, 0.002, 0.002,  0.098, 0.078, 0.002,  0.002, 0.078, 0.002,
      // Inner top rim z=0.04 (12..15)
      0.002, 0.002, 0.04,  0.098, 0.002, 0.04,  0.098, 0.078, 0.04,  0.002, 0.078, 0.04,
    ];
    const trayTris = [
      // Outer floor (-Z)
      0, 3, 2,  0, 2, 1,
      // 4 outer walls
      0, 1, 5,  0, 5, 4,
      1, 2, 6,  1, 6, 5,
      2, 3, 7,  2, 7, 6,
      3, 0, 4,  3, 4, 7,
      // Inner floor (+Z)
      8, 9, 10,  8, 10, 11,
      // 4 inner walls (facing cavity)
      8, 12, 13,  8, 13, 9,
      9, 13, 14,  9, 14, 10,
      10, 14, 15,  10, 15, 11,
      11, 15, 12,  11, 12, 8,
      // 4 top rim strips at z=0.04 (+Z)
      4, 5, 13,  4, 13, 12,
      5, 6, 14,  5, 14, 13,
      6, 7, 15,  6, 15, 14,
      7, 4, 12,  7, 12, 15,
    ];
    const trayNode: SceneNode = {
      id: 'open_tray',
      name: 'OpenTray',
      pos: [0, 0, 0],
      geoms: [{ name: 'm', type: 'mesh', size: [0.05, 0.04, 0.02], renderVertices: trayVerts, faces: trayTris }],
      joints: [],
      children: [],
    };
    const trayRes = exportSheetUnfold(makeScene([trayNode]), {
      mode: 'sheet_metal',
      thicknessMm: 2.0,
      bendRadiusMm: 2.0,
      kFactor: 0.44,
    });
    expect(trayRes.success).toBe(true);
    expect(trayRes.islands).toHaveLength(1);
    expect(trayRes.totalFaces).toBe(5);
    expect(trayRes.foldCount).toBe(4);
    const trayFolded = foldSheetUnfold(trayRes, { thicknessMm: 2.0, bendRadiusMm: 2.0, kFactor: 0.44, scaleFactor: 1 });
    expect(trayFolded.deviation.maxMm).toBeLessThan(0.05);

    // 3. Solid closed 40 mm cube mesh still unfolds as all 6 faces
    const solidCube: SceneNode = {
      id: 'solid_cube',
      name: 'SolidCube',
      pos: [0, 0, 0],
      geoms: [{ name: 'b', type: 'box', size: [0.02, 0.02, 0.02] }],
      joints: [],
      children: [],
    };
    const cubeRes = exportSheetUnfold(makeScene([solidCube]), { mode: 'papercraft' });
    expect(cubeRes.totalFaces).toBe(6);
  });

  it('U-C5: emits closed outer cut outline when soft_goods has seamAllowanceMm = 0 (butt-stitched leather)', () => {
    const boxNode: SceneNode = {
      id: 'butt_pouch',
      name: 'ButtPouch',
      pos: [0, 0, 0],
      geoms: [{ name: 'b', type: 'box', size: [0.025, 0.025, 0.025] }],
      joints: [],
      children: [],
    };
    const res = exportSheetUnfold(makeScene([boxNode]), {
      mode: 'soft_goods',
      seamAllowanceMm: 0,
      stitchPitchMm: 5,
    });
    expect(res.success).toBe(true);
    expect(res.islands[0].cutPolylines2D.length).toBeGreaterThanOrEqual(1);
    expect(res.svg).toContain('id="layer-cut"');
    const shortSpan = Math.min(res.islands[0].boundsMm.width, res.islands[0].boundsMm.height);
    const longSpan = Math.max(res.islands[0].boundsMm.width, res.islands[0].boundsMm.height);
    expect(shortSpan).toBeCloseTo(150, 1);
    expect(longSpan).toBeCloseTo(200, 1);

    const { request } = sheetFoldSimulationRequest(res, {
      thicknessMm: 1.5,
      bendRadiusMm: 0,
      kFactor: 0.5,
      scaleFactor: 1,
    });
    expect(request.details.some((d) => d.includes('seam allowances left off'))).toBe(true);
  });

  it('U-C6: foldSheetUnfold never welds non-coplanar faces flat across zero-width 2D relief slits', () => {
    // 4-face corner where Front Flap and Right Wall touch along a zero-width 2D cut slit in papercraft mode:
    //   Face 0 (Floor): [0..50] x [0..50], z=0, normal -Z
    //   Face 1 (Front Wall): y=0, x in [0..50], z in [0..40], normal -Y (90 deg fold to Floor)
    //   Face 2 (Right Wall): x=50, y in [0..40], z in [0..40], normal +X (90 deg fold to Floor, AND shares vertical edge x=50,y=0,z=0..40 with Front Wall -> wait: make Right Wall NOT share 3D edge, or make a 4th face off Front Wall!)
    // Better yet: Floor (50x50) + Front Wall (50x40) + Right Wall (50x40):
    //   If Front Wall has a 40x40 side return at x=50 going into +Y (coincident in 3D? No, let Front Wall be 50x40, Right Wall be 50x40, and add a 4th face off Front Wall's bottom? Wait:
    //   In 2D, Floor is [0..50, 0..50]; Front Wall unfolds to [0..50, -40..0]; Right Wall unfolds to [50..90, 0..50].
    //   Attach a 4th face to Front Wall along x=50, z=0..40 going in +X (x in [50..90], y=0, z in [0..40], i.e. coplanar extension? No, bent 90 deg from Front Wall so in 3D it lies at x=50, y in [0..40], z in [0..40] — wait that's Right Wall itself!).
    //   Instead: bend Face 3 by -90 deg (valley) from Front Wall along x=50, z=0..40 so in 3D Face 3 goes to x=50, y in [-40..0], z in [0..40]!
    //   Look where Face 3 unfolds in 2D: off Front Wall's right edge x=50, y in [-40..0] -> Face 3 lands at [50..90, -40..0], whose top edge y=0, x in [50..90] COINCIDES AT ZERO WIDTH in 2D with Right Wall's bottom edge [50..90, 0]!!
    const lat = createLattice(0.001);
    const p00 = vertexAt(lat, 0, 0, 0);
    const p50 = vertexAt(lat, 50, 0, 0);
    const p55 = vertexAt(lat, 50, 50, 0);
    const p05 = vertexAt(lat, 0, 50, 0);

    const f0 = vertexAt(lat, 0, 0, 40);
    const f5 = vertexAt(lat, 50, 0, 40);
    const r5 = vertexAt(lat, 50, 50, 40);
    const wing0 = vertexAt(lat, 50, -40, 0);
    const wing4 = vertexAt(lat, 50, -40, 40);

    // Floor (-Z normal): (0,0,0)->(0,50,0)->(50,50,0)->(50,0,0)
    addFace(lat, [p00, p05, p55, p50]);
    // Front wall (-Y normal): (0,0,0)->(50,0,0)->(50,0,40)->(0,0,40)
    addFace(lat, [p00, p50, f5, f0]);
    // Right wall (+X normal): (50,0,0)->(50,50,0)->(50,50,40)->(50,0,40)
    addFace(lat, [p50, p55, r5, f5]);
    // Outward wing from Front wall at x=50 going to y=-40 (+X normal): (50,-40,0)->(50,0,0)?? Wait: shares edge (p50, f5) with BOTH Front wall and Right wall? Avoid non-manifold 3-face edge: start wing at x=49? No, start Right wall on Floor edge y=50 (Back wall)!
    // Wait: if Floor has Front wall (y=0, length 50) and Right wall (x=50, y in [1..50]), let's make Floor a 5-gon or L-step so every edge is 2-manifold!
    const lat2 = createLattice(0.001);
    // Step along zero-width relief slit:
    //   Face A (Floor): [0..50] x [0..50], z=0 (-Z)
    //   Face B (Right Wall): x=50, y in [0..50], z in [0..40] (+X), unfolds to [50..90] x [0..50]
    //   Face C (Front Wall): y=0, x in [0..49], z in [0..40] (-Y), unfolds to [0..49] x [-40..0]
    //   Wait: to touch at EXACT zero width (<= 1e-3 mm) in 2D without sharing a 3D edge:
    //   Face A (Floor): [0..60] x [0..50], z=0
    //   Face B (Front Wall): y=0, x in [0..30], z in [0..40] (-Y) -> unfolds to [0..30] x [-40..0]
    //   Face C (Right Wing off Front Wall at x=30): x=30, y in [-30..0], z in [0..40] (+X) -> unfolds to [30..70] x [-40..-10]? Wait: z in [0..40] is along Y in 2D (-40..0), y in [-30..0] is width 30 along X in 2D ([30..60] x [-40..0]), whose top edge is [30..60] at y=0 — COINCIDING EXACTLY with Floor's front-right edge [30..60] at y=0!!
    const q0 = vertexAt(lat2, 0, 0, 0);
    const qMid = vertexAt(lat2, 30, 0, 0);
    const q1 = vertexAt(lat2, 60, 0, 0);
    const q2 = vertexAt(lat2, 60, 50, 0);
    const q3 = vertexAt(lat2, 0, 50, 0);

    const fw0 = vertexAt(lat2, 0, 0, 40);
    const fwMid = vertexAt(lat2, 30, 0, 40);

    const rwBot = vertexAt(lat2, 30, -30, 0);
    const rwTop = vertexAt(lat2, 30, -30, 40);

    // Floor (5 vertices: q0 -> q3 -> q2 -> q1 -> qMid, -Z normal)
    addFace(lat2, [q0, q3, q2, q1, qMid]);
    // Front wall on x in [0..30], y=0 (-Y normal)
    addFace(lat2, [q0, qMid, fwMid, fw0]);
    // Wing on x=30, y in [-30..0] (+X normal, valley -90 deg fold off Front wall)
    addFace(lat2, [rwBot, qMid, fwMid, rwTop]);

    const slitNode: SceneNode = {
      id: 'slit_part',
      name: 'SlitPart',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: serializeCage(lat2),
      geoms: [],
      joints: [],
      children: [],
    };
    const res = exportSheetUnfold(makeScene([slitNode]), {
      mode: 'papercraft',
      tabWidthMm: 6,
    });

    expect(res.success).toBe(true);
    expect(res.totalFaces).toBe(3);
    expect(res.foldCount).toBe(2);

    // Verify U-H3 at the same time: the zero-clearance slit must NOT get a glue tab cutting across Floor!
    for (const gt of res.islands[0].glueTabs) {
      for (const f of res.islands[0].faces) {
        expect(polygonsOverlap2D(gt.polygon2D, f.polygon2D, 0.05)).toBe(false);
      }
    }

    // Verify U-C6: foldSheetUnfold folds BOTH hinges instead of welding Wing flat to Floor across the zero-width slit!
    const folded = foldSheetUnfold(res, { thicknessMm: 0.5, bendRadiusMm: 0, kFactor: 0.5, scaleFactor: 1 });
    expect(folded.folds).toBe(2);
    expect(folded.deviation.maxMm).toBeLessThan(0.05);
  });

  it('U-H1: EXPORT_SHEET_UNFOLD MCP handler returns ok: false when scene has no unfoldable faces', async () => {
    if (typeof globalThis.navigator === 'undefined') {
      vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    }
    const { partBuildCommands } = await import('../src/hooks/mcp/partBuildCommands');
    const emptyScene = makeScene([]);
    const resEmpty = await partBuildCommands.EXPORT_SHEET_UNFOLD(
      {},
      { store: { sceneGraph: emptyScene } as never, toId: (s: string) => s } as never
    );
    expect(resEmpty.ok).toBe(false);
    expect(String(resEmpty.error)).toContain('No unfoldable 3D faces');

    const sphereScene = makeScene([
      {
        id: 'ball',
        name: 'Ball',
        pos: [0, 0, 0],
        geoms: [{ name: 's', type: 'sphere', size: [0.02] }],
        joints: [],
        children: [],
      },
    ]);
    const resSphere = await partBuildCommands.EXPORT_SHEET_UNFOLD(
      {},
      { store: { sceneGraph: sphereScene } as never, toId: (s: string) => s } as never
    );
    expect(resSphere.ok).toBe(false);
    expect(Array.isArray(resSphere.warnings)).toBe(true);
    expect((resSphere.warnings as string[]).length).toBeGreaterThan(0);
  });

  it('U-H2: clamps setbacks on narrow sheet-metal webs instead of inverting polygons inside-out', () => {
    // 3-face Z-bracket whose middle web is only 3 mm tall, unfolded with R=2.5, T=2.0 (raw setback = 4.5 mm > 3 mm)
    const lat = createLattice(0.001);
    const v0 = vertexAt(lat, 0, 0, 0);
    const v1 = vertexAt(lat, 0, 30, 0);
    const v2 = vertexAt(lat, 40, 30, 0);
    const v3 = vertexAt(lat, 40, 0, 0);
    const v4 = vertexAt(lat, 40, 0, 3);
    const v5 = vertexAt(lat, 40, 30, 3);
    const v6 = vertexAt(lat, 80, 0, 3);
    const v7 = vertexAt(lat, 80, 30, 3);

    addFace(lat, [v0, v1, v2, v3]);
    addFace(lat, [v3, v2, v5, v4]);
    addFace(lat, [v4, v5, v7, v6]);

    const narrowNode: SceneNode = {
      id: 'narrow_z',
      name: 'NarrowZ',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: serializeCage(lat),
      geoms: [],
      joints: [],
      children: [],
    };

    const res = exportSheetUnfold(makeScene([narrowNode]), {
      mode: 'sheet_metal',
      thicknessMm: 2.0,
      bendRadiusMm: 2.5,
      kFactor: 0.44,
    });

    expect(res.success).toBe(true);
    expect(res.totalFaces).toBe(3);
    for (const f of res.islands[0].faces) {
      expect(f.areaMm2).toBeGreaterThan(1.0);
    }
    expect(res.warnings.some((w) => w.includes('clamped setback'))).toBe(true);
  });

  it('U-H3 & U-H4: prevents colliding glue tabs and concave soft_goods bowties on a 12-facet cylinder, and omits stitch holes/notches on open mouths', () => {
    const cylNode: SceneNode = {
      id: 'cyl_12',
      name: 'Cyl12',
      pos: [0, 0, 0],
      geoms: [{ name: 'c', type: 'cylinder', size: [0.025, 0.03], facets: 12 }],
      joints: [],
      children: [],
    };

    // U-H3: papercraft glue tabs on 12-gon cap never overlap any face
    const paperRes = exportSheetUnfold(makeScene([cylNode]), {
      mode: 'papercraft',
      tabWidthMm: 7,
    });
    expect(paperRes.success).toBe(true);
    for (const isl of paperRes.islands) {
      for (const gt of isl.glueTabs) {
        for (const f of isl.faces) {
          expect(polygonsOverlap2D(gt.polygon2D, f.polygon2D, 0.05)).toBe(false);
        }
      }
    }

    // U-H4 (part 1): soft_goods outward seam offset on 12-gon cylinder has zero self-intersecting bowties
    const softCyl = exportSheetUnfold(makeScene([cylNode]), {
      mode: 'soft_goods',
      seamAllowanceMm: 6,
      stitchPitchMm: 4,
      notchLengthMm: 2.5,
    });
    expect(softCyl.success).toBe(true);
    for (const loop of softCyl.islands[0].cutPolylines2D) {
      const segs: Seg2D[] = [];
      for (let i = 0; i + 1 < loop.length; i++) {
        segs.push({ a: loop[i], b: loop[i + 1] });
      }
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 2; j < segs.length; j++) {
          if (i === 0 && j === segs.length - 1) continue;
          expect(segmentsProperlyCross(segs[i], segs[j], 0.02)).toBe(false);
        }
      }
    }

    // U-H4 (part 2): 5-face open-top leather pouch has ZERO stitch holes and ZERO alignment notches on its 4 open mouth edges,
    // and mated seam notches sit inside the seam allowance margin (starting on outer cut line, stopping short of stitch line)
    const lat = createLattice(0.001);
    const c0 = vertexAt(lat, 0, 0, 0);
    const c1 = vertexAt(lat, 50, 0, 0);
    const c2 = vertexAt(lat, 50, 50, 0);
    const c3 = vertexAt(lat, 0, 50, 0);
    const c4 = vertexAt(lat, 0, 0, 50);
    const c5 = vertexAt(lat, 50, 0, 50);
    const c6 = vertexAt(lat, 50, 50, 50);
    const c7 = vertexAt(lat, 0, 50, 50);
    addFace(lat, [c0, c3, c2, c1]); // bottom
    addFace(lat, [c0, c1, c5, c4]); // front
    addFace(lat, [c1, c2, c6, c5]); // right
    addFace(lat, [c2, c3, c7, c6]); // back
    addFace(lat, [c3, c0, c4, c7]); // left

    const openPouch: SceneNode = {
      id: 'open_pouch',
      name: 'OpenPouch',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: serializeCage(lat),
      geoms: [],
      joints: [],
      children: [],
    };
    const pouchRes = exportSheetUnfold(makeScene([openPouch]), {
      mode: 'soft_goods',
      seamAllowanceMm: 6,
      stitchPitchMm: 5,
      notchLengthMm: 2.5,
    });
    expect(pouchRes.success).toBe(true);
    const pouchIsl = pouchRes.islands[0];
    const unmatedSeams = pouchIsl.cutSeams.filter((s) => s.matingFaceIndex === null);
    const matedSeams = pouchIsl.cutSeams.filter((s) => s.matingFaceIndex !== null);
    expect(unmatedSeams).toHaveLength(4);
    expect(matedSeams).toHaveLength(8);

    for (const openEdge of unmatedSeams) {
      expect(openEdge.alignmentNotches).toBeUndefined();
      for (const sh of pouchIsl.stitchHoles) {
        expect(pointToSegDist(sh, openEdge.p1, openEdge.p2)).toBeGreaterThan(1.5);
      }
    }

    const outerLoop = pouchIsl.cutPolylines2D[0];
    let matedNotchCount = 0;
    for (const ms of matedSeams) {
      for (const [outerPt, innerPt] of ms.alignmentNotches || []) {
        matedNotchCount++;
        // outerPt lies on the outer offset cut loop
        let minOuterDist = Infinity;
        for (let i = 0; i + 1 < outerLoop.length; i++) {
          minOuterDist = Math.min(minOuterDist, pointToSegDist(outerPt, outerLoop[i], outerLoop[i + 1]));
        }
        expect(minOuterDist).toBeLessThan(0.05);
        // innerPt stops safely outside the stitch line (ms.p1 -> ms.p2)
        const distToStitchLine = pointToSegDist(innerPt, ms.p1, ms.p2);
        expect(distToStitchLine).toBeGreaterThan(1.5);
      }
    }
    expect(matedNotchCount).toBe(8);
  });

  it('U-H5: handles baked-rotation latticeCage transforms, CSG compiledVisual fallback, and 4-quad coplanar window merging', () => {
    // 1. 4-quad coplanar picture frame in a latticeCage merges into 1 face with 1 interior hole and 0 cut seams
    const frameLat = createLattice(0.001);
    const o0 = vertexAt(frameLat, 0, 0, 0);
    const o1 = vertexAt(frameLat, 60, 0, 0);
    const o2 = vertexAt(frameLat, 60, 50, 0);
    const o3 = vertexAt(frameLat, 0, 50, 0);
    const i0 = vertexAt(frameLat, 15, 12, 0);
    const i1 = vertexAt(frameLat, 45, 12, 0);
    const i2 = vertexAt(frameLat, 45, 38, 0);
    const i3 = vertexAt(frameLat, 15, 38, 0);
    addFace(frameLat, [o0, o1, i1, i0]);
    addFace(frameLat, [o1, o2, i2, i1]);
    addFace(frameLat, [o2, o3, i3, i2]);
    addFace(frameLat, [o3, o0, i0, i3]);

    const frameNode: SceneNode = {
      id: 'window_frame',
      name: 'WindowFrame',
      pos: [0, 0, 0],
      euler: [0, 0, 90],
      isLattice: true,
      latticeCage: serializeCage(frameLat),
      // Simulate a geom whose vertices were baked (`isNodeRotationBaked(node) === true`)
      geoms: [{ name: 'baked_mesh', type: 'mesh', size: [1], vertices: [0, 0, 0], baseVertices: [0, 0, 0], faces: [] }],
      joints: [],
      children: [],
    };

    const frameRes = exportSheetUnfold(makeScene([frameNode]), { mode: 'sheet_metal', marginMm: 10, sheetWidthMm: 400, sheetHeightMm: 400 });
    expect(frameRes.success).toBe(true);
    expect(frameRes.totalFaces).toBe(1);
    expect(frameRes.foldCount).toBe(0);
    expect(frameRes.islands[0].faces[0].holes2D).toHaveLength(1);
    expect(frameRes.islands[0].cutPolylines2D).toHaveLength(2);
    // Because euler=[0,0,90] WAS applied to the 60x50 cage despite baseVertices being present, width is ~50 and height is ~60!
    expect(frameRes.islands[0].boundsMm.width).toBeCloseTo(50, 1);
    expect(frameRes.islands[0].boundsMm.height).toBeCloseTo(60, 1);

    // 2. When compiledVisual CSG mesh is present on a latticeCage node, exportSheetUnfold uses compiledVisual so CSG holes appear
    const csgVerts = [
      0, 0, 0,  0.06, 0, 0,  0.06, 0.05, 0,  0, 0.05, 0,
      0.02, 0.015, 0,  0.04, 0.015, 0,  0.04, 0.035, 0,  0.02, 0.035, 0,
    ];
    const csgTris = [
      0, 1, 5,  0, 5, 4,
      1, 2, 6,  1, 6, 5,
      2, 3, 7,  2, 7, 6,
      3, 0, 4,  3, 4, 7,
    ];
    const solidPlateLat = createLattice(0.001);
    addFace(solidPlateLat, [
      vertexAt(solidPlateLat, 0, 0, 0),
      vertexAt(solidPlateLat, 60, 0, 0),
      vertexAt(solidPlateLat, 60, 50, 0),
      vertexAt(solidPlateLat, 0, 50, 0),
    ]);
    const csgNode: SceneNode = {
      id: 'csg_lat',
      name: 'CsgLattice',
      pos: [0, 0, 0],
      csgEnabled: true,
      isLattice: true,
      latticeCage: serializeCage(solidPlateLat),
      geoms: [
        {
          name: 'compiled',
          type: 'mesh',
          csgDerived: 'visual',
          size: [1],
          renderVertices: csgVerts,
          faces: csgTris,
        },
      ],
      joints: [],
      children: [],
    };
    const csgRes = exportSheetUnfold(makeScene([csgNode]), { mode: 'sheet_metal' });
    expect(csgRes.success).toBe(true);
    expect(csgRes.islands[0].faces[0].holes2D).toHaveLength(1);
    expect(csgRes.islands[0].cutPolylines2D).toHaveLength(2);
  });

  it('U-M1: handles non-convex U-shaped faces accurately in polygonsOverlap2D, area computation, and foldSheetUnfold', () => {
    // Concave U-shape: [0..60] x [0..50] with bay [12..48] x [10..50] removed
    // Area = 60*50 - 36*40 = 3000 - 1440 = 1560 mm^2
    // Notice the U-shape's arms extend up to y=50, overhanging well past the bay floor hinge at y=10!
    const uPoly: Point2D[] = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 50 },
      { x: 48, y: 50 },
      { x: 48, y: 10 },
      { x: 12, y: 10 },
      { x: 12, y: 50 },
      { x: 0, y: 50 },
    ];
    const baySquare: Point2D[] = [
      { x: 18, y: 15 },
      { x: 42, y: 15 },
      { x: 42, y: 45 },
      { x: 18, y: 45 },
    ];
    expect(polygonsOverlap2D(uPoly, baySquare)).toBe(false);

    // Build 3D U-face + vertical tab hinged on the inner bay edge (12,10)->(48,10), folding UP into -Z (mountain)
    const lat = createLattice(0.001);
    const uVerts = uPoly.map((p) => vertexAt(lat, p.x, p.y, 0));
    const tabTop1 = vertexAt(lat, 48, 10, -25);
    const tabTop2 = vertexAt(lat, 12, 10, -25);

    // U-face (+Z normal)
    addFace(lat, uVerts);
    // Tab hinged along uVerts[4]=(48,10,0) -> uVerts[5]=(12,10,0), so child traverses uVerts[5]->uVerts[4]->tabTop1->tabTop2
    // Notice the U-face's centroid is at y ~ 19.6 > 10 (on the SAME +Y side of the hinge y=10 as the bay, where the unfolded tab ALSO lands at y in [10..35]!)
    addFace(lat, [uVerts[5], uVerts[4], tabTop1, tabTop2]);

    const uNode: SceneNode = {
      id: 'u_part',
      name: 'UPart',
      pos: [0, 0, 0],
      isLattice: true,
      latticeCage: serializeCage(lat),
      geoms: [],
      joints: [],
      children: [],
    };
    const res = exportSheetUnfold(makeScene([uNode]), { mode: 'papercraft', tabWidthMm: 0 });
    expect(res.success).toBe(true);
    expect(res.totalFaces).toBe(2);
    expect(res.foldCount).toBe(1);
    const uFaceUnfolded = res.islands[0].faces.find((f) => f.polygon2D.length === 8)!;
    expect(uFaceUnfolded.areaMm2).toBeCloseTo(1560, 1);

    const folded = foldSheetUnfold(res, { thicknessMm: 0.5, bendRadiusMm: 0, kFactor: 0.5, scaleFactor: 1 });
    expect(folded.deviation.maxMm).toBeLessThan(0.05);
  });

  it('U-M2: normalizes inverted and mixed-winding closed triangle meshes so convex folds remain mountain bends', () => {
    const h = 0.025;
    const verts = [
      -h, -h, -h,  h, -h, -h,  h,  h, -h, -h,  h, -h,
      -h, -h,  h,  h, -h,  h,  h,  h,  h, -h,  h,  h,
    ];
    const outwardFaces = [
      0, 3, 2,  0, 2, 1,
      4, 5, 6,  4, 6, 7,
      0, 1, 5,  0, 5, 4,
      2, 3, 7,  2, 7, 6,
      0, 4, 7,  0, 7, 3,
      1, 2, 6,  1, 6, 5,
    ];

    // 1. Completely inside-out mesh (all 12 triangles reversed)
    const invertedFaces: number[] = [];
    for (let i = 0; i < outwardFaces.length; i += 3) {
      invertedFaces.push(outwardFaces[i], outwardFaces[i + 2], outwardFaces[i + 1]);
    }

    // 2. Mixed-winding mesh (4 of 12 triangles reversed)
    const mixedFaces = [...outwardFaces];
    for (const triIdx of [1, 4, 7, 10]) {
      const base = triIdx * 3;
      const tmp = mixedFaces[base + 1];
      mixedFaces[base + 1] = mixedFaces[base + 2];
      mixedFaces[base + 2] = tmp;
    }

    for (const [label, faces] of [['inverted', invertedFaces], ['mixed', mixedFaces]] as const) {
      const node: SceneNode = {
        id: `box_${label}`,
        name: `Box_${label}`,
        pos: [0, 0, 0],
        geoms: [{ name: 'm', type: 'mesh', size: [h, h, h], renderVertices: verts, faces }],
        joints: [],
        children: [],
      };
      const res = exportSheetUnfold(makeScene([node]), {
        mode: 'sheet_metal',
        thicknessMm: 2.0,
        bendRadiusMm: 1.5,
        kFactor: 0.44,
      });
      expect(res.success).toBe(true);
      expect(res.totalFaces).toBe(6);
      expect(res.foldCount).toBe(5);
      for (const fe of res.islands[0].foldEdges) {
        expect(fe.kind).toBe('mountain');
        expect(fe.callout).toBe('UP 90° R1.5');
      }
    }
  });

  it('U-M3 & Etch invariants: distinct stitch-hole stroke color, Z-closed cut paths, ghost sheet bounds, and 0mm multi-sheet stacking', () => {
    const b1: SceneNode = {
      id: 'b1',
      name: 'Pouch1',
      pos: [0, 0, 0],
      geoms: [{ name: 'g1', type: 'box', size: [0.025, 0.025, 0.025] }],
      joints: [],
      children: [],
    };
    const b2: SceneNode = {
      id: 'b2',
      name: 'Pouch2',
      pos: [0.1, 0, 0],
      geoms: [{ name: 'g2', type: 'box', size: [0.025, 0.025, 0.025] }],
      joints: [],
      children: [],
    };

    const res = exportSheetUnfold(makeScene([b1, b2]), {
      mode: 'soft_goods',
      seamAllowanceMm: 5,
      stitchPitchMm: 5,
      sheetWidthMm: 220,
      sheetHeightMm: 240,
      thicknessMm: 1.8,
    });

    expect(res.success).toBe(true);
    expect(res.sheets).toHaveLength(2);

    // 1. Exact SVG header & settings comment invariants
    expect(res.svg.startsWith('<svg width="220mm" height="480mm" viewBox="0 0 220 480" xmlns="http://www.w3.org/2000/svg">')).toBe(true);
    expect(res.svg).toContain('<!-- Settings: Mode=soft_goods, Thickness=1.8mm, Scale=100% -->');
    expect(res.svg).toContain('<g id="layer-sheet-bounds" data-operation="ghost">');

    // 2. Distinct stroke color between layer-seams-tabs (#9333ea) and layer-stitch-holes (#d97706)
    expect(res.svg).toContain('<g id="layer-seams-tabs" data-operation="etch" fill="none" stroke="#9333ea"');
    expect(res.svg).toContain('<g id="layer-stitch-holes" data-operation="cut" fill="none" stroke="#d97706"');

    // 3. Closed cut paths end with Z
    expect(res.svg).toMatch(/<g id="layer-cut"[\s\S]*?<path d="M [^"]+Z" \/>/);

    // 4. Stacked 0mm-gap multi-sheet <rect> and Sheet N captions inside layer-sheet-bounds
    expect(res.svg).toContain('<rect x="0" y="0" width="220" height="240" data-operation="ghost"');
    expect(res.svg).toContain('<rect x="0" y="240" width="220" height="240" data-operation="ghost"');
    expect(res.svg).toContain('Sheet 1 (220mm x 240mm, soft_goods)');
    expect(res.svg).toContain('Sheet 2 (220mm x 240mm, soft_goods)');
  });
});
