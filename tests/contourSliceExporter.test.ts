import { describe, it, expect } from 'vitest';
import {
  exportContourSliceSvg,
  collectSceneTriangles,
  sliceTrianglesAtZ,
  chainSegments,
  DEFAULT_CONTOUR_OPTIONS,
} from '../src/utils/contourSliceExporter';
import { birdhousePreset } from '../src/presets/presetScenes';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

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

// A 100 mm cube, sitting with its base on z = 0.
const cube = bodyWith({ type: 'box', size: [0.05, 0.05, 0.05] }, [0, 0, 0.05]);

describe('Contour Slice Exporter', () => {
  it('cuts one layer per material thickness of model height', () => {
    const result = exportContourSliceSvg(cube, { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.005 });

    expect(result.success).toBe(true);
    expect(result.layers).toHaveLength(20); // 100 mm / 5 mm
    expect(result.modelHeight).toBeCloseTo(0.1, 6);
    expect(result.stackHeight).toBeCloseTo(0.1, 6);
    expect(result.svg).toContain('<svg');
    expect(result.svg).toContain('stroke="#FF0000"');
  });

  it('cuts a square of the modelled size at every height of a cube', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
    });

    expect(result.success).toBe(true);
    for (const layer of result.layers!) {
      expect(layer.pieceCount).toBe(1);
      expect(layer.areaMm2).toBeCloseTo(100 * 100, 0);
      expect(layer.width2D).toBeCloseTo(100, 1);
      expect(layer.height2D).toBeCloseTo(100, 1);
    }
  });

  it('follows a sphere\'s profile, widest at its equator', () => {
    const ball = bodyWith({ type: 'sphere', size: [0.05] }, [0, 0, 0.05]);
    const result = exportContourSliceSvg(ball, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
    });

    expect(result.success).toBe(true);
    const layers = result.layers!;
    const widths = layers.map(l => l.width2D!);
    const widest = widths.indexOf(Math.max(...widths));

    expect(widest).toBeGreaterThan(2);
    expect(widest).toBeLessThan(layers.length - 3);
    // Sampled at the middle of the layer straddling the equator: a hair under 100 mm.
    expect(Math.max(...widths)).toBeGreaterThan(95);
    expect(Math.max(...widths)).toBeLessThanOrEqual(100.5);
    expect(widths[0]).toBeLessThan(Math.max(...widths));
    expect(widths[widths.length - 1]).toBeLessThan(Math.max(...widths));
  });

  it('slices a hollow tube into rings, so each layer has an inner contour', () => {
    const tube: SceneGraph = {
      nodes: [{
        id: 'b1',
        name: 'tube',
        type: 'body',
        pos: [0, 0, 0.05],
        csgEnabled: true,
        geoms: [
          { name: 'outer', type: 'cylinder', size: [0.04, 0.05] },
          { name: 'bore', type: 'cylinder', size: [0.02, 0.06], csg: 'difference' },
          {
            name: 'csg_visual',
            type: 'mesh',
            size: [1, 1, 1],
            csgDerived: 'visual',
            faces: [],
            renderVertices: [],
          },
        ],
        joints: [],
        children: [],
      }],
    };

    // Stand in for a compiled CSG result: an annulus extruded over the height.
    const mesh = tube.nodes[0].geoms[2];
    const { verts, faces } = annulusPrism(0.04, 0.02, 0.05, 48);
    mesh.renderVertices = verts;
    mesh.faces = faces;

    const result = exportContourSliceSvg(tube, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
    });

    expect(result.success).toBe(true);
    const mid = result.layers![Math.floor(result.layers!.length / 2)];
    expect(mid.loops.length).toBe(2);        // outer wall and bore
    expect(mid.pieceCount).toBe(1);
    // Ring area: π(40² - 20²) = 3770 mm².
    expect(mid.areaMm2).toBeGreaterThan(3600);
    expect(mid.areaMm2).toBeLessThan(3800);
  });

  it('punches the same alignment holes through every layer', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: true,
      pinCount: 2,
      pinDiameter: 0.003,
    });

    expect(result.success).toBe(true);
    expect(result.pins).toHaveLength(2);
    // Cut undersize by half a kerf so a 3 mm dowel ends up a press fit.
    expect(result.pins![0].radiusMm).toBeCloseTo(1.5 - 0.075, 4);
    // Well apart, and clear of the 100 mm square's edges.
    const [p, q] = result.pins!;
    expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(20);
    for (const pin of result.pins!) {
      expect(Math.abs(pin.x)).toBeLessThan(46);
      expect(Math.abs(pin.y)).toBeLessThan(46);
    }
    for (const layer of result.layers!) {
      expect(layer.loops).toHaveLength(1 + 2); // outline plus both pin holes
    }
  });

  it('places no pins when nothing clears every layer, and says so', () => {
    const cone = bodyWith({ type: 'sphere', size: [0.05] }, [0, 0, 0.05]);
    const result = exportContourSliceSvg(cone, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.005,
      pinHoles: true,
      pinDiameter: 0.02, // far too fat for the sphere's poles
    });

    expect(result.success).toBe(true);
    expect(result.pins).toHaveLength(0);
    expect(result.warnings!.some(w => w.includes('No dowel position'))).toBe(true);
  });

  it('honours a layer-count override and flags the height it builds', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.003,
      sliceCount: 5,
    });

    expect(result.success).toBe(true);
    expect(result.layers).toHaveLength(5);
    expect(result.stackHeight).toBeCloseTo(0.015, 6);
    expect(result.warnings!.some(w => w.includes('stack up to'))).toBe(true);
  });

  it('samples bottom / middle / top within each layer', () => {
    const opts = { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.01, pinHoles: false };
    const ball = bodyWith({ type: 'sphere', size: [0.05] }, [0, 0, 0.05]);

    const bottom = exportContourSliceSvg(ball, { ...opts, slicePosition: 'bottom' });
    const top = exportContourSliceSvg(ball, { ...opts, slicePosition: 'top' });

    // The lower half of a sphere widens with height, so a layer sampled at its
    // top is wider than the same layer sampled at its bottom.
    expect(top.layers![1].width2D!).toBeGreaterThan(bottom.layers![1].width2D!);
  });

  it('mirrors nothing: SVG y is flipped so the stack is not handed', () => {
    // An L, asymmetric in both axes, at a known place in the plan.
    const ell: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'ell', type: 'body', pos: [0, 0, 0.01], joints: [], children: [],
        geoms: [
          { name: 'a', type: 'box', size: [0.04, 0.01, 0.01], pos: [0, 0, 0] },
          { name: 'b', type: 'box', size: [0.01, 0.04, 0.01], pos: [-0.03, 0.03, 0] },
        ],
      }],
    };
    const result = exportContourSliceSvg(ell, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
      includeLabels: false,
      includeSheetOutline: false,
    });

    expect(result.success).toBe(true);
    // The tall arm reaches to model +y, which must land at the *small* SVG y of
    // the placed part rather than the large one.
    const layer = result.layers![0];
    const pos = layer.placedPos2D!;
    const numbers = [...result.svg!.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)];
    const armPoints = numbers.filter(m => parseFloat(m[1]) < pos.x + 20);
    const armYs = armPoints.map(m => parseFloat(m[2]));
    expect(Math.min(...armYs)).toBeLessThan(pos.y + 5);
  });

  it('unions overlapping solids instead of cutting a seam through the layer', () => {
    // Two bars crossing in plan, overlapping over a 20 x 20 mm square. Sliced
    // naively that overlap shows up as two rectangles, and the laser would saw
    // the layer apart along the seam between them.
    const cross: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'cross', type: 'body', pos: [0, 0, 0.01], joints: [], children: [],
        geoms: [
          { name: 'a', type: 'box', size: [0.05, 0.01, 0.01], pos: [0, 0, 0] },
          { name: 'b', type: 'box', size: [0.01, 0.05, 0.01], pos: [0, 0, 0] },
        ],
      }],
    };

    const result = exportContourSliceSvg(cross, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
    });

    expect(result.success).toBe(true);
    const layer = result.layers![0];
    expect(layer.loops).toHaveLength(1);
    expect(layer.pieceCount).toBe(1);
    // A plus sign: 12 corners, and the area of two bars less the shared square.
    expect(layer.loops[0]).toHaveLength(12);
    expect(layer.areaMm2).toBeCloseTo(100 * 20 + 100 * 20 - 20 * 20, 0);
  });

  it('cuts a shared edge once when two solids sit flush side by side', () => {
    const pair: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'pair', type: 'body', pos: [0, 0, 0.01], joints: [], children: [],
        geoms: [
          { name: 'a', type: 'box', size: [0.02, 0.02, 0.01], pos: [-0.02, 0, 0] },
          { name: 'b', type: 'box', size: [0.02, 0.02, 0.01], pos: [0.02, 0, 0] },
        ],
      }],
    };

    const result = exportContourSliceSvg(pair, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
    });

    // One 80 x 40 rectangle, with no cut along the join the two boxes share.
    const layer = result.layers![0];
    expect(layer.loops).toHaveLength(1);
    expect(layer.loops[0]).toHaveLength(4);
    expect(layer.areaMm2).toBeCloseTo(80 * 40, 0);
  });

  it('keeps genuinely separate solids as separate pieces', () => {
    const apart: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'apart', type: 'body', pos: [0, 0, 0.01], joints: [], children: [],
        geoms: [
          { name: 'a', type: 'box', size: [0.02, 0.02, 0.01], pos: [-0.05, 0, 0] },
          { name: 'b', type: 'box', size: [0.02, 0.02, 0.01], pos: [0.05, 0, 0] },
        ],
      }],
    };

    const result = exportContourSliceSvg(apart, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.01,
      pinHoles: false,
    });

    expect(result.layers![0].loops).toHaveLength(2);
    expect(result.layers![0].pieceCount).toBe(2);
    expect(result.warnings!.some(w => w.includes('separate pieces'))).toBe(true);
  });

  it('slices a real preset scene into stackable layers', () => {
    const result = exportContourSliceSvg(birdhousePreset, {
      ...DEFAULT_CONTOUR_OPTIONS,
      materialThickness: 0.006,
    });

    expect(result.success).toBe(true);
    expect(result.layers!.length).toBeGreaterThan(3);
    expect(result.sheetCount).toBeGreaterThanOrEqual(1);
    expect(result.mapSvg).toContain('<svg');
    expect(result.mapSvg).toContain('hsl(');
  });

  it('reports a scene with nothing to slice rather than emitting an empty sheet', () => {
    const empty: SceneGraph = { nodes: [] };
    expect(exportContourSliceSvg(empty).success).toBe(false);
    expect(exportContourSliceSvg(empty).error).toContain('No solid geometry');

    const flat = bodyWith({ type: 'plane', size: [1, 1, 0.1] });
    expect(exportContourSliceSvg(flat).success).toBe(false);
  });

  it('slices a mesh whose faces are wound inside out', () => {
    // Mesh data does not always arrive wound outward — a renderer with
    // double-sided materials never has to care. Slicing does: it reads winding
    // to decide which side of a contour is material, so an inverted solid used
    // to union itself away and the export came back with no closed contours.
    const cubeVerts = [
      -0.05, -0.05, 0, 0.05, -0.05, 0, 0.05, 0.05, 0, -0.05, 0.05, 0,
      -0.05, -0.05, 0.1, 0.05, -0.05, 0.1, 0.05, 0.05, 0.1, -0.05, 0.05, 0.1,
    ];
    const outward = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ];
    const inverted = outward.slice();
    for (let i = 0; i < inverted.length; i += 3) {
      const t = inverted[i + 1];
      inverted[i + 1] = inverted[i + 2];
      inverted[i + 2] = t;
    }

    const results = [outward, inverted].map(faces =>
      exportContourSliceSvg(
        bodyWith({ type: 'mesh', size: [1], renderVertices: cubeVerts, faces } as never),
        DEFAULT_CONTOUR_OPTIONS
      )
    );

    for (const r of results) {
      expect(r.success, r.error).toBe(true);
      expect(r.layers!.length).toBeGreaterThan(10);
    }
    // ...and both windings describe the same solid, so they slice the same.
    expect(results[1].layers!.length).toBe(results[0].layers!.length);
    expect(results[1].layers![5].areaMm2).toBeCloseTo(results[0].layers![5].areaMm2, 3);
  });

  it('calls out a run of identical layers instead of silently nesting them', () => {
    // A straight post has a constant cross-section, so it slices into a stack of
    // identical discs. Cutting one and repeating it is the sensible move, and
    // the export should say so rather than quietly filling sheets with copies.
    const post = bodyWith({ type: 'cylinder', size: [0.01, 0.15] }, [0, 0, 0.15]);
    const result = exportContourSliceSvg(post, DEFAULT_CONTOUR_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.warnings!.some(w => /copies of the same cross-section/.test(w))).toBe(true);
  });

  it('cuts without dowels when asked, and says why when they will not fit', () => {
    const noPins = exportContourSliceSvg(cube, { ...DEFAULT_CONTOUR_OPTIONS, pinCount: 0, pinHoles: false });
    expect(noPins.success).toBe(true);
    expect(noPins.pins ?? []).toHaveLength(0);
    expect(noPins.warnings!.some(w => /dowel/i.test(w))).toBe(false);

    // A dowel far thicker than the part cannot clear any layer's edge; that is a
    // note about glue-up, not a failure.
    const tooFat = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS, pinCount: 2, pinHoles: true, pinDiameter: 0.08,
    });
    expect(tooFat.success).toBe(true);
    expect(tooFat.pins ?? []).toHaveLength(0);
    expect(tooFat.warnings!.some(w => /without alignment holes/.test(w))).toBe(true);
  });
});

describe('Contour slicing internals', () => {
  it('cuts a closed contour through a box, with the solid on the left', () => {
    const { tris } = collectSceneTriangles(cube);
    const segs = sliceTrianglesAtZ(tris, 0.05);
    expect(segs.length).toBeGreaterThan(0);

    const loops = chainSegments(segs);
    expect(loops).toHaveLength(1);

    // Positive shoelace area means counter-clockwise: an outer boundary.
    const pts = loops[0];
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      area += p.x * q.y - q.x * p.y;
    }
    expect(area / 2).toBeCloseTo(100 * 100, 0);
  });

  it('cuts through vertices without dropping the contour', () => {
    const { tris } = collectSceneTriangles(cube);
    // Exactly the height of the box's own top face — every vertex on the plane.
    const atFace = chainSegments(sliceTrianglesAtZ(tris, 0.1));
    expect(atFace.every(l => l.length >= 3)).toBe(true);
  });
});

/** An extruded annulus in Z-up metres, as flat vertex and face arrays. */
function annulusPrism(rOuter: number, rInner: number, halfHeight: number, segments: number) {
  const verts: number[] = [];
  const faces: number[] = [];

  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (const z of [-halfHeight, halfHeight]) {
      verts.push(rOuter * c, rOuter * s, z);
    }
    for (const z of [-halfHeight, halfHeight]) {
      verts.push(rInner * c, rInner * s, z);
    }
  }

  const V = (k: number, which: number) => ((k % segments) * 4 + which);
  for (let k = 0; k < segments; k++) {
    const oB = V(k, 0), oT = V(k, 1), iB = V(k, 2), iT = V(k, 3);
    const nB = V(k + 1, 0), nT = V(k + 1, 1), nIB = V(k + 1, 2), nIT = V(k + 1, 3);

    faces.push(oB, nB, nT, oB, nT, oT);       // outer wall
    faces.push(iB, iT, nIT, iB, nIT, nIB);    // inner wall (inward facing)
    faces.push(oB, iB, nIB, oB, nIB, nB);     // bottom ring
    faces.push(oT, nT, nIT, oT, nIT, iT);     // top ring
  }

  return { verts, faces };
}
