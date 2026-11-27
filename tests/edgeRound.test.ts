import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { EdgeRoundFeature, RoundEdge, SceneNode } from '../src/types/scene';
import {
  crossSection, setbackOf, edgeSolidScad, cornerPatchesScad, edgeRoundSolids,
  normalizeRoundEdge, reconcileEdgeRounds, keepFoundEdges, planClampedRoundings,
} from '../src/utils/edgeRound';
import { relaxFacetedCurveSetbacks } from '../src/utils/edgeRoundBase';
import { findFeatureEdges, maxSizeFor } from '../src/utils/featureEdges';
import { csgProgram, csgHashOf, hasBooleanOps, meshShells, primitiveToScad } from '../src/utils/csg';

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

  it('cuts a stopped edge short at its stops', () => {
    const scad = edgeSolidScad({ ...topFront, stops: [{ point: topFront.a, normal: [1, 0, 0] }] }, 'fillet', 0.002, 32);
    expect(scad).toMatch(/^intersection\(\) \{ multmatrix\(.*linear_extrude.*; multmatrix\(.*cube\(/);
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

describe('keepFoundEdges', () => {
  it('drops the edges that are no longer on the part, and a feature left empty', () => {
    const moved: RoundEdge = { ...topFront, a: [-0.01, -0.02, 0.01], b: [0.01, -0.02, 0.01] };
    const other: RoundEdge = { ...topFront, a: [-0.01, 0.01, 0.01], b: [0.01, 0.01, 0.01] };
    const { features, lost } = keepFoundEdges([
      { mode: 'fillet', size: 0.002, edges: [topFront, other] },
      { mode: 'chamfer', size: 0.001, edges: [moved] },
    ], [topFront]);
    expect(lost).toBe(2);
    expect(features).toHaveLength(1);
    expect(features[0].edges).toEqual([topFront]);
  });

  it('hands back the same list when nothing was lost', () => {
    const features = [{ mode: 'fillet' as const, size: 0.002, edges: [topFront] }];
    expect(keepFoundEdges(features, [topFront]).features).toBe(features);
  });
});

describe('meshShells', () => {
  it('hands OpenSCAD each closed shell of a mesh separately, so buried faces are merged away', () => {
    const cube = (dx: number) => {
      const g = new THREE.BoxGeometry(0.02, 0.02, 0.02).toNonIndexed().translate(dx, 0, 0);
      return Array.from(g.attributes.position.array as ArrayLike<number>);
    };
    const points = [...cube(0), ...cube(0.01)];
    const faces = points.map((_, i) => i).filter((i) => i < points.length / 3);
    const shells = meshShells(points, faces);
    expect(shells).toHaveLength(2);
    expect(shells.every((s) => s.faces.length === 36)).toBe(true);
    const scad = primitiveToScad({ name: 'm', type: 'mesh', size: [1], renderVertices: points, faces }, 32, '')!;
    expect(scad.startsWith('union() { polyhedron(')).toBe(true);
    expect(scad.match(/polyhedron\(/g)).toHaveLength(2);
  });
});

describe('an outside edge ending in a rounded inside corner', () => {
  it('stops at the top of the fillet, not at the face under it', () => {
    // A rib standing on a floor at z = 0: its top edge runs down to the floor at
    // the origin, and the rib's foot along x is an inside corner.
    const slope: RoundEdge = {
      kind: 'line', a: [0, -0.002, 0], b: [-0.02, -0.002, 0.02],
      n1: [0, -1, 0], n2: [Math.SQRT1_2, 0, Math.SQRT1_2],
      t1: [-Math.SQRT1_2, 0, Math.SQRT1_2], t2: [0, 1, 0], convex: true,
      stops: [{ point: [0, -0.002, 0], normal: [0, 0, 1] }],
    };
    const foot: RoundEdge = {
      kind: 'line', a: [-0.02, -0.002, 0], b: [0, -0.002, 0],
      n1: [0, 0, 1], n2: [0, -1, 0], t1: [0, -1, 0], t2: [0, 0, 1], convex: false,
    };
    const alone = edgeRoundSolids([{ mode: 'fillet', size: 0.002, edges: [slope] }], 16).cutters[0];
    const withFoot = edgeRoundSolids([{ mode: 'fillet', size: 0.002, edges: [slope, foot] }], 16).cutters[0];
    // Alone, the stop is the floor; with the foot filleted, 2 mm above it.
    expect(alone).toMatch(/\[0, 0, 1, 0\]/);
    expect(withFoot).toMatch(/\[0, 0, 1, 0\.002\]/);
  });

  it('also stops short of circular concave rim fillets (boss foot / counterbore floor)', () => {
    // A straight rib edge ending on a z = 0 floor right at a boss foot (r = 8 mm).
    const ribTop: RoundEdge = {
      kind: 'line', a: [0.0085, 0, 0], b: [0.02, 0, 0.01],
      n1: [0, -1, 0], n2: [Math.SQRT1_2, 0, Math.SQRT1_2],
      t1: [-Math.SQRT1_2, 0, Math.SQRT1_2], t2: [0, 1, 0], convex: true,
      stops: [{ point: [0.0085, 0, 0], normal: [0, 0, 1] }],
    };
    const bossFoot: RoundEdge = {
      kind: 'circle', centre: [0, 0, 0], axis: [0, 0, 1], radius: 0.008, ref: [1, 0, 0], segments: 32,
      n1: [0, 0, 1], n2: [1, 0, 0], t1: [1, 0, 0], t2: [0, 0, 1], convex: false,
    };
    const alone = edgeRoundSolids([{ mode: 'fillet', size: 0.0015, edges: [ribTop] }], 16).cutters[0];
    const withBoss = edgeRoundSolids([{ mode: 'fillet', size: 0.0015, edges: [ribTop, bossFoot] }], 16).cutters[0];
    expect(alone).toMatch(/\[0, 0, 1, 0\]/);
    expect(withBoss).toMatch(/\[0, 0, 1, 0\.0015\]/);
  });

  it('repairs circular hole rims whose t1/convex was flipped by flat-face triangulation', () => {
    // A counterbore inner through-hole rim (n1 = +Z, wall goes down t2 = -Z, wall normal n2 = -X):
    // true geometry is convex with t1 = +X, but a wrapped flat-face triangle flipped t1 = -X and convex = false.
    const flippedHoleRim: RoundEdge = {
      kind: 'circle', centre: [0, 0, 0], axis: [0, 0, 1], radius: 0.00275, ref: [1, 0, 0], segments: 32,
      n1: [0, 0, 1], n2: [-1, 0, 0], t1: [-1, 0, 0], t2: [0, 0, -1], convex: false,
    };
    const fixed = normalizeRoundEdge(flippedHoleRim);
    expect(fixed.convex).toBe(true);
    expect(fixed.kind === 'circle' && fixed.t1).toEqual([1, 0, 0]);

    // edgeRoundSolids routes the repaired rim to cutters, never fillers.
    const { cutters, fillers } = edgeRoundSolids([{ mode: 'chamfer', size: 0.0008, edges: [flippedHoleRim] }], 32);
    expect(cutters).toHaveLength(1);
    expect(fillers).toHaveLength(0);

    // A genuine concave counterbore outer floor rim (n1 = +Z, wall goes UP t2 = +Z, n2 = -X, t1 = -X) stays concave.
    const concaveFloorRim: RoundEdge = {
      kind: 'circle', centre: [0, 0, 0], axis: [0, 0, 1], radius: 0.00475, ref: [1, 0, 0], segments: 32,
      n1: [0, 0, 1], n2: [-1, 0, 0], t1: [-1, 0, 0], t2: [0, 0, 1], convex: false,
    };
    expect(normalizeRoundEdge(concaveFloorRim)).toBe(concaveFloorRim);
  });
});

describe('faceted curves and per-edge clamping', () => {
  /** Extrudes a 2D CCW polygon along Z in [0, h] into a closed outward-wound mesh. */
  function extrudePolygon(pts: [number, number][], h: number): { positions: number[]; faces: number[] } {
    const n = pts.length;
    const positions: number[] = [];
    for (const [x, y] of pts) positions.push(x, y, 0);
    for (const [x, y] of pts) positions.push(x, y, h);
    const botCenter = 2 * n;
    const topCenter = 2 * n + 1;
    let cx = 0, cy = 0;
    for (const [x, y] of pts) { cx += x / n; cy += y / n; }
    positions.push(cx, cy, 0, cx, cy, h);
    const faces: number[] = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      // Bottom (-Z)
      faces.push(botCenter, next, i);
      // Top (+Z)
      faces.push(topCenter, n + i, n + next);
      // Side wall (outward)
      faces.push(i, next, n + next, i, n + next, n + i);
    }
    return { positions, faces };
  }

  it('does not cap a faceted curve loop to half of a single tiny facet', () => {
    // 20x10 mm plate, 4 mm thick, with faceted 90° corners (2 facets per corner:
    // normals at 22.5° and 67.5°, each > 20° crease from neighbours so every
    // corner facet is its own straight edge ~0.76 mm long on an R = 1 mm corner).
    const r = 0.001;
    const hx = 0.01, hy = 0.005;
    const stepsPerCorner = 2;
    const pts: [number, number][] = [];
    const corners: [number, number, number][] = [
      [hx - r, hy - r, 0],
      [-hx + r, hy - r, Math.PI / 2],
      [-hx + r, -hy + r, Math.PI],
      [hx - r, -hy + r, (3 * Math.PI) / 2],
    ];
    for (const [cx, cy, a0] of corners) {
      for (let k = 0; k <= stepsPerCorner; k++) {
        const a = a0 + (k / stepsPerCorner) * (Math.PI / 2);
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    const { positions, faces } = extrudePolygon(pts, 0.004);
    const found = findFeatureEdges(positions, faces, { up: [0, 0, 1] });
    const topBefore = found.edges.filter((e) => e.top);
    expect(topBefore.length).toBe(12);
    // Before relaxation, adjacent-hop curve facets crush maxSizeFor below 0.4 mm (~0.38 mm).
    const maxBefore = maxSizeFor(topBefore, 'chamfer');
    expect(maxBefore).toBeLessThan(0.0004);

    relaxFacetedCurveSetbacks(found, positions, faces);
    const topAfter = found.edges.filter((e) => e.top);
    const maxAfter = maxSizeFor(topAfter, 'chamfer');
    // After relaxation, a practical 0.4 mm bevel easily fits the top loop (~0.707 mm),
    // while still respecting the 4 mm plate thickness (max <= 2 mm).
    expect(maxAfter).toBeGreaterThanOrEqual(0.0004);
    expect(maxAfter).toBeLessThanOrEqual(0.002 + 1e-6);
  });

  it('clamps tight facet edges individually while keeping roomy edges at requested size', () => {
    const roomy = {
      id: 0, edge: topFront, points: [topFront.a as [number, number, number], topFront.b as [number, number, number]],
      closed: false, surfaces: [0, 1] as [number, number], angleDeg: 90, maxSetback: 0.005,
      top: true, bottom: false, vertical: false,
    };
    const tightEdge: RoundEdge = { ...topFront, a: [0.01, -0.01, 0.01], b: [0.0101, -0.0099, 0.01] };
    const tight = {
      ...roomy, id: 1, edge: tightEdge, maxSetback: 0.00012,
    };
    const tinyEdge: RoundEdge = { ...topFront, a: [0.0101, -0.0099, 0.01], b: [0.01011, -0.00989, 0.01] };
    const tiny = {
      ...roomy, id: 2, edge: tinyEdge, maxSetback: 0.000005, // < 0.01 mm
    };

    const plan = planClampedRoundings([roomy, tight, tiny], 'chamfer', 0.0004);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.clampedCount).toBe(1);
    expect(plan.skippedCount).toBe(1);
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups.find((g) => Math.abs(g.size - 0.0004) < 1e-9)?.edges).toEqual([topFront]);
    expect(plan.groups.find((g) => g.size < 0.0004)?.size).toBeCloseTo(0.00012, 6);

    // Every planned group emits valid OpenSCAD cutters.
    const { cutters } = edgeRoundSolids(
      plan.groups.map((g) => ({ mode: 'chamfer' as const, size: g.size, edges: g.edges })),
      32,
    );
    expect(cutters).toHaveLength(2);

    // Rejects when a single picked edge cannot fit, or when no edge fits.
    expect(planClampedRoundings([tight], 'chamfer', 0.0004).ok).toBe(false);
    expect(planClampedRoundings([roomy, tight], 'chamfer', 0.01).ok).toBe(false);

    // Skips microscopic edges (< 10% of requested size) on large fillet requests
    // rather than generating 0.01–0.16 mm CSG slivers.
    const largePlan = planClampedRoundings([roomy, tight, tiny], 'chamfer', 0.003);
    expect(largePlan.ok).toBe(true);
    if (largePlan.ok) {
      expect(largePlan.clampedCount).toBe(0);
      expect(largePlan.skippedCount).toBe(2);
      expect(largePlan.groups).toHaveLength(1);
    }
  });
});
