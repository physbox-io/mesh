import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { EdgeRoundFeature, RoundEdge, SceneNode } from '../src/types/scene';
import { crossSection, setbackOf, edgeSolidScad, cornerPatchesScad, edgeRoundSolids, reconcileEdgeRounds } from '../src/utils/edgeRound';
import { findFeatureEdges } from '../src/utils/featureEdges';
import { csgProgram, csgHashOf, hasBooleanOps } from '../src/utils/csg';

/** The top-front edge of a 20 mm cube centred on the origin, along X. */
const topFront: RoundEdge = {
  kind: 'line',
  a: [-0.01, -0.01, 0.01],
  b: [0.01, -0.01, 0.01],
  n1: [0, 0, 1], n2: [0, -1, 0],
  t1: [0, 1, 0], t2: [0, 0, -1],
  convex: true,
};

function cubeEdges(): RoundEdge[] {
  const g = new THREE.BoxGeometry(0.02, 0.02, 0.02).toNonIndexed();
  const positions = Array.from(g.attributes.position.array as ArrayLike<number>);
  const faces = positions.map((_, i) => i).filter((i) => i < positions.length / 3);
  return findFeatureEdges(positions, faces).edges.map((e) => e.edge);
}

function cubeNode(edgeRounds?: EdgeRoundFeature[]): SceneNode {
  return {
    id: 'cube', name: 'cube', pos: [0, 0, 0.01],
    geoms: [{ name: 'g', type: 'box', size: [0.01, 0.01, 0.01] }],
    ...(edgeRounds ? { edgeRounds, csgEnabled: true } : {}),
  } as SceneNode;
}

describe('cross-section', () => {
  it('sets a fillet back by its radius on a square edge, and further on a shallow one', () => {
    expect(setbackOf(topFront, 'fillet', 0.002)).toBeCloseTo(0.002, 9);
    const shallow: RoundEdge = { ...topFront, t2: [0, -Math.SQRT1_2, -Math.SQRT1_2] }; // faces at 135°
    expect(setbackOf(shallow, 'fillet', 0.002)).toBeCloseTo(0.002 / Math.tan((135 * Math.PI) / 360), 9);
    expect(setbackOf(shallow, 'chamfer', 0.002)).toBe(0.002);
  });

  it('keeps the fillet\'s arc a radius from its centre, between the two tangent points', () => {
    const r = 0.002;
    const pts = crossSection(topFront, 'fillet', r, 8);
    // pushed-T1, T1, 7 arc points, T2, pushed-T2, pushed-C
    expect(pts).toHaveLength(12);
    const centre = [0, r, -r]; // back r along +Y and down r along -Z
    for (const p of pts.slice(1, 10)) {
      expect(Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])).toBeCloseTo(r, 9);
    }
    // T1 on the top face, T2 on the front face.
    expect(pts[1][1]).toBeCloseTo(r, 12);
    expect(pts[1][2]).toBeCloseTo(0, 12);
    expect(pts[9][2]).toBeCloseTo(-r, 12);
  });

  it('pushes a cutter out past the faces and a filler into the part', () => {
    const cut = crossSection(topFront, 'chamfer', 0.002, 2);
    expect(cut[0][2]).toBeGreaterThan(0); // above the top face
    const fill = crossSection({ ...topFront, convex: false }, 'chamfer', 0.002, 2);
    expect(fill[0][2]).toBeLessThan(0);
  });
});

describe('OpenSCAD', () => {
  it('extrudes a straight edge along itself', () => {
    const scad = edgeSolidScad(topFront, 'fillet', 0.002, 32);
    expect(scad).toMatch(/^multmatrix\(.*\) linear_extrude\(height=0\.02002\) polygon\(\[/);
  });

  it('spins a rim, with as many facets as the rim has', () => {
    const rim: RoundEdge = {
      kind: 'circle', centre: [0, 0, 0.01], axis: [0, 0, 1], radius: 0.005, ref: [1, 0, 0], segments: 24,
      n1: [0, 0, 1], n2: [-1, 0, 0], t1: [1, 0, 0], t2: [0, 0, -1], convex: true,
    };
    const scad = edgeSolidScad(rim, 'chamfer', 0.001, 32);
    expect(scad).toContain('rotate_extrude($fn=24)');
    // The profile sits out at the rim's radius, clear of the axis.
    const xs = [...scad.matchAll(/\[(-?[\d.e-]+),(-?[\d.e-]+)\]/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(0);
  });

  it('patches all eight corners of a cube filleted all round, and none for a chamfer', () => {
    const edges = cubeEdges();
    expect(cornerPatchesScad({ mode: 'fillet', size: 0.002, edges }, 32)).toHaveLength(8);
    expect(cornerPatchesScad({ mode: 'chamfer', size: 0.002, edges }, 32)).toHaveLength(0);
    // Only the top four edges: no corner has three.
    const top = edges.filter((e) => e.kind === 'line' && e.a[2] > 0.009 && e.b[2] > 0.009);
    expect(cornerPatchesScad({ mode: 'fillet', size: 0.002, edges: top }, 32)).toHaveLength(0);
  });

  it('cuts convex edges and fills concave ones', () => {
    const { cutters, fillers } = edgeRoundSolids([
      { mode: 'chamfer', size: 0.001, edges: [topFront, { ...topFront, convex: false }] },
    ], 32);
    expect(cutters).toHaveLength(1);
    expect(fillers).toHaveLength(1);
  });
});

describe('the boolean program', () => {
  it('makes a plain box with rounded edges a boolean body', () => {
    expect(hasBooleanOps(cubeNode())).toBe(false);
    expect(hasBooleanOps(cubeNode([{ mode: 'fillet', size: 0.002, edges: [topFront] }]))).toBe(true);
    expect(hasBooleanOps(cubeNode([{ mode: 'fillet', size: 0, edges: [topFront] }]))).toBe(false);
  });

  it('takes the roundings off the finished shape, and can leave them out for picking', () => {
    const node = cubeNode([{ mode: 'fillet', size: 0.002, edges: [topFront] }]);
    const scad = csgProgram(node)!;
    expect(scad).toMatch(/difference\(\) \{\n\s+multmatrix|difference\(\) \{\n\s+cube/);
    expect(scad).toContain('linear_extrude');
    const base = csgProgram(node, { rounds: false, always: true })!;
    expect(base).not.toContain('linear_extrude');
    expect(base).toContain('cube(');
  });

  it('recompiles when a rounding changes', () => {
    const a = csgHashOf(cubeNode([{ mode: 'fillet', size: 0.002, edges: [topFront] }]));
    const b = csgHashOf(cubeNode([{ mode: 'fillet', size: 0.003, edges: [topFront] }]));
    const c = csgHashOf(cubeNode([{ mode: 'chamfer', size: 0.002, edges: [topFront] }]));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('reconcileEdgeRounds', () => {
  it('moves the edges of a box that has been made longer', () => {
    const node = cubeNode([{ mode: 'fillet', size: 0.002, edges: [topFront] }]);
    const moved = reconcileEdgeRounds(
      node,
      { min: [-0.01, -0.01, -0.01], max: [0.01, 0.01, 0.01] },
      { min: [-0.02, -0.01, -0.01], max: [0.02, 0.01, 0.01] },
    );
    expect(moved).toBe(true);
    const e = node.edgeRounds![0].edges[0];
    expect(e.kind === 'line' && e.a[0]).toBeCloseTo(-0.02, 9);
    expect(e.kind === 'line' && e.b[0]).toBeCloseTo(0.02, 9);
    expect(e.kind === 'line' && e.a[2]).toBeCloseTo(0.01, 9);
    // The size is a size, not a proportion: it stays.
    expect(node.edgeRounds![0].size).toBe(0.002);
  });
});
