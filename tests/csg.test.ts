// Unit tests for the boolean-modifier geometry: the OpenSCAD emitter, mesh
// measurement, hole-axis detection, sector decomposition, and the outline
// clipping used to draw negative shapes.
//
// Everything here is pure geometry — csg.ts imports ./openscad lazily (inside
// evaluateNodeCsg) precisely so these run without a browser, a worker pool, or
// the MuJoCo wasm module.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { generateTorusMeshData } from '../src/utils/geom';
import {
  primitiveToScad, csgProgram, hasBooleanOps, csgHashOf,
  meshVolumeAndCentroid, convexHullOf, primitiveVolume,
  detectHoleAxis, decomposeAroundAxis,
  positiveBounds, sourcePositiveBounds, geomBounds, clipSegmentsToBox, geomMatrixOf,
  resolveCsgGeoms, cutGeometry, cutDepthOf, reconcileCuts, surfaceUnder, pickCutSpot,
} from '../src/utils/csg';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const body = (geoms: SceneGeom[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'b', name: 'b', type: 'body', pos: [0, 0, 0.3], geoms, joints: [], children: [], ...extra,
});

// A washer: 0.12-radius disc, 0.028 half-thickness, with a 0.062-radius hole
// punched through. Note the negative is WIDER than it is deep — the ordinary case
// for a hole in a thin plate, and the one that broke axis detection once.
const washer = () => body([
  { name: 'plate', type: 'ellipsoid', size: [0.11, 0.11, 0.028], mass: 1 },
  { name: 'hole', type: 'ellipsoid', size: [0.062, 0.062, 0.05], csg: 'difference' },
], { csgEnabled: true });

describe('primitiveToScad', () => {
  it('maps MuJoCo size conventions onto OpenSCAD solids', () => {
    // box size is HALF-extents; OpenSCAD's cube() takes full extents.
    expect(primitiveToScad({ name: 'x', type: 'box', size: [0.1, 0.2, 0.3] } as SceneGeom))
      .toContain('cube([0.2, 0.4, 0.6], center=true)');
    expect(primitiveToScad({ name: 'x', type: 'sphere', size: [0.05] } as SceneGeom))
      .toContain('sphere(r=0.05');
    // cylinder is [radius, HALF-length] along local Z.
    expect(primitiveToScad({ name: 'x', type: 'cylinder', size: [0.05, 0.1] } as SceneGeom))
      .toContain('cylinder(h=0.2, r=0.05, center=true');
    expect(primitiveToScad({ name: 'x', type: 'ellipsoid', size: [0.1, 0.2, 0.3] } as SceneGeom))
      .toContain('scale([0.1, 0.2, 0.3]) sphere(r=1');
  });

  it('emits a capsule as the hull of its two end spheres', () => {
    const out = primitiveToScad({ name: 'x', type: 'capsule', size: [0.02, 0.15] } as SceneGeom)!;
    expect(out).toContain('hull()');
    expect(out).toContain('translate([0, 0, -0.15])');
    expect(out).toContain('translate([0, 0, 0.15])');
  });

  it('wraps a transformed geom in multmatrix, and omits it when identity', () => {
    expect(primitiveToScad({ name: 'x', type: 'sphere', size: [0.05], pos: [0, 0, 0.2] } as SceneGeom))
      .toContain('multmatrix');
    expect(primitiveToScad({ name: 'x', type: 'sphere', size: [0.05] } as SceneGeom))
      .not.toContain('multmatrix');
  });

  it('reduces fromto to a centre, a rotation and a half-length', () => {
    const out = primitiveToScad({ name: 'x', type: 'capsule', size: [0.02], fromto: [0, 0, 0, 0, 0, 0.3] } as SceneGeom)!;
    expect(out).toContain('multmatrix');           // translated to the midpoint
    expect(out).toContain('translate([0, 0, 0.15])'); // half of the 0.3 length
  });

  it('reverses mesh face winding, because OpenSCAD wants clockwise-from-outside', () => {
    const out = primitiveToScad({
      name: 'x', type: 'mesh', size: [1],
      renderVertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      faces: [0, 1, 2],
    } as SceneGeom)!;
    expect(out).toContain('polyhedron(');
    expect(out).toContain('faces=[[2,1,0]]');
  });

  it('returns null for shapes with no volume', () => {
    expect(primitiveToScad({ name: 'x', type: 'plane', size: [0, 0, 1] } as SceneGeom)).toBeNull();
    expect(primitiveToScad({ name: 'x', type: 'mesh', size: [1] } as SceneGeom)).toBeNull();
  });
});

describe('csgProgram', () => {
  it('subtracts negatives from the union of positives', () => {
    const prog = csgProgram(washer())!;
    expect(prog).toContain('difference()');
    expect((prog.match(/\{/g) || []).length).toBe((prog.match(/\}/g) || []).length);
  });

  it('skips the union() wrapper for a single positive', () => {
    expect(csgProgram(washer())).not.toContain('union()');
  });

  it('wraps multiple positives in union()', () => {
    const n = body([
      { name: 'a', type: 'box', size: [0.1, 0.1, 0.1] },
      { name: 'b', type: 'sphere', size: [0.08], pos: [0.1, 0, 0] },
      { name: 'c', type: 'cylinder', size: [0.04, 0.3], csg: 'difference' },
    ], { csgEnabled: true });
    expect(csgProgram(n)).toContain('union()');
  });

  it('nests intersection inside difference', () => {
    const n = body([
      { name: 'a', type: 'box', size: [0.1, 0.1, 0.1] },
      { name: 'b', type: 'sphere', size: [0.12], csg: 'intersection' },
      { name: 'c', type: 'cylinder', size: [0.03, 0.3], csg: 'difference' },
    ], { csgEnabled: true });
    const prog = csgProgram(n)!;
    expect(prog.indexOf('difference()')).toBeLessThan(prog.indexOf('intersection()'));
  });

  it('is null when there is nothing to cut, or nothing to cut into', () => {
    expect(csgProgram(body([{ name: 'a', type: 'box', size: [0.1, 0.1, 0.1] }]))).toBeNull();
    expect(csgProgram(body([{ name: 'a', type: 'box', size: [0.1, 0.1, 0.1], csg: 'difference' }]))).toBeNull();
    expect(hasBooleanOps(washer())).toBe(true);
  });

  it('changes its hash when any input the mesh depends on changes', () => {
    const base = washer();
    const h = csgHashOf(base);
    expect(csgHashOf(washer())).toBe(h);                                  // stable
    const resized = washer();
    resized.geoms[1].size = [0.07, 0.07, 0.05];
    expect(csgHashOf(resized)).not.toBe(h);                               // geometry
    expect(csgHashOf({ ...base, csgSectors: 24 })).not.toBe(h);            // sector count
    expect(csgHashOf({ ...base, csgCollision: 'hull' })).not.toBe(h);      // strategy
    expect(csgHashOf({ ...base, csgMass: 9 })).not.toBe(h);                // mass split
  });
});

describe('meshVolumeAndCentroid', () => {
  const torus = generateTorusMeshData(0.15, 0.04, 96, 48);

  it('measures a faceted torus just under its ideal volume', () => {
    const ideal = 2 * Math.PI ** 2 * 0.15 * 0.04 ** 2;
    const { volume } = meshVolumeAndCentroid(torus.renderVertices, torus.faces);
    expect(volume).toBeLessThan(ideal);
    expect(volume).toBeGreaterThan(ideal * 0.99);
  });

  it('puts a symmetric shape\'s centroid at the origin', () => {
    const { centroid } = meshVolumeAndCentroid(torus.renderVertices, torus.faces);
    for (const c of centroid) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('returns magnitude, so a consistently inverted mesh still measures positive', () => {
    const flipped = [...torus.faces];
    for (let i = 0; i < flipped.length; i += 3) {
      const t = flipped[i + 1]; flipped[i + 1] = flipped[i + 2]; flipped[i + 2] = t;
    }
    expect(meshVolumeAndCentroid(torus.renderVertices, flipped).volume)
      .toBeCloseTo(meshVolumeAndCentroid(torus.renderVertices, torus.faces).volume, 12);
  });

  it('degrades safely on a mesh with no volume', () => {
    expect(meshVolumeAndCentroid([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))
      .toEqual({ volume: 0, centroid: [0, 0, 0] });
  });
});

describe('primitiveVolume', () => {
  it.each([
    ['sphere', { type: 'sphere', size: [0.1] }, (4 / 3) * Math.PI * 0.1 ** 3],
    ['box', { type: 'box', size: [0.1, 0.2, 0.3] }, 8 * 0.1 * 0.2 * 0.3],
    ['ellipsoid', { type: 'ellipsoid', size: [0.12, 0.12, 0.04] }, (4 / 3) * Math.PI * 0.12 * 0.12 * 0.04],
    ['cylinder', { type: 'cylinder', size: [0.05, 0.1] }, Math.PI * 0.05 ** 2 * 0.2],
    ['capsule', { type: 'capsule', size: [0.02, 0.1] }, Math.PI * 0.02 ** 2 * 0.2 + (4 / 3) * Math.PI * 0.02 ** 3],
  ])('is analytic for a %s', (_name, geom, expected) => {
    expect(primitiveVolume({ name: 'g', ...geom } as SceneGeom)).toBeCloseTo(expected as number, 12);
  });
});

describe('detectHoleAxis', () => {
  it('finds the axis a negative pierces, not its longest axis', () => {
    // The regression this guards: the washer's negative is 0.062 wide and only
    // 0.05 deep, so "longest axis" would pick X and slice the hole shut.
    expect(detectHoleAxis(washer())?.axis).toEqual([0, 0, 1]);
  });

  it('returns null for a sealed cavity', () => {
    const n = body([
      { name: 'a', type: 'sphere', size: [0.1] },
      { name: 'b', type: 'sphere', size: [0.05], csg: 'difference' },
    ], { csgEnabled: true });
    expect(detectHoleAxis(n)).toBeNull();
  });

  it('returns null when the negative only bites one face', () => {
    const n = body([
      { name: 'a', type: 'box', size: [0.1, 0.1, 0.1] },
      { name: 'b', type: 'box', size: [0.04, 0.04, 0.04], pos: [0, 0, 0.1], csg: 'difference' },
    ], { csgEnabled: true });
    expect(detectHoleAxis(n)).toBeNull();
  });

  it('returns null when the negative engulfs the solid entirely', () => {
    const n = body([
      { name: 'a', type: 'box', size: [0.05, 0.05, 0.05] },
      { name: 'b', type: 'box', size: [0.2, 0.2, 0.2], csg: 'difference' },
    ], { csgEnabled: true });
    expect(detectHoleAxis(n)).toBeNull();
  });

  it('finds an obliquely rotated hole via the negative\'s own axes', () => {
    const n = body([
      { name: 'a', type: 'box', size: [0.1, 0.1, 0.1] },
      { name: 'b', type: 'cylinder', size: [0.03, 0.4], euler: [45, 0, 0], csg: 'difference' },
    ], { csgEnabled: true });
    const axis = detectHoleAxis(n)!.axis;
    // Rx(45) takes local +Z to (0, -sin45, cos45).
    expect(axis[0]).toBeCloseTo(0, 6);
    expect(Math.abs(axis[1])).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(axis[2])).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('honours an explicit csgHoleAxis override', () => {
    expect(detectHoleAxis({ ...washer(), csgHoleAxis: 'x' })?.axis).toEqual([1, 0, 0]);
    expect(detectHoleAxis({ ...washer(), csgHoleAxis: 'y' })?.axis).toEqual([0, 1, 0]);
  });

  it('centres slicing on the negative, so an offset bite works', () => {
    const n = body([
      { name: 'a', type: 'cylinder', size: [0.1, 0.022] },
      { name: 'b', type: 'cylinder', size: [0.085, 0.04], pos: [0.062, 0, 0], csg: 'difference' },
    ], { csgEnabled: true });
    expect(detectHoleAxis(n)).toEqual({ origin: [0.062, 0, 0], axis: [0, 0, 1] });
  });
});

describe('decomposeAroundAxis', () => {
  const R = 0.15, tubeR = 0.04;
  const torus = generateTorusMeshData(R, tubeR, 96, 48);
  const verts = torus.renderVertices, faces = torus.faces;
  const holeRadius = R - tubeR;
  const trueVolume = meshVolumeAndCentroid(verts, faces).volume;

  /** Outward face planes of a convex hull, for point-in-hull testing. */
  const planesOf = (h: { verts: number[]; faces: number[]; centroid: number[] }) => {
    const out: Array<[number, number, number, number]> = [];
    for (let i = 0; i < h.faces.length; i += 3) {
      const a = h.faces[i] * 3, b = h.faces[i + 1] * 3, c = h.faces[i + 2] * 3;
      const u = new THREE.Vector3(h.verts[b] - h.verts[a], h.verts[b + 1] - h.verts[a + 1], h.verts[b + 2] - h.verts[a + 2]);
      const v = new THREE.Vector3(h.verts[c] - h.verts[a], h.verts[c + 1] - h.verts[a + 1], h.verts[c + 2] - h.verts[a + 2]);
      const n = new THREE.Vector3().crossVectors(u, v);
      if (n.length() < 1e-12) continue;
      n.normalize();
      let d = n.x * h.verts[a] + n.y * h.verts[a + 1] + n.z * h.verts[a + 2];
      if (n.x * h.centroid[0] + n.y * h.centroid[1] + n.z * h.centroid[2] - d > 0) { n.negate(); d = -d; }
      out.push([n.x, n.y, n.z, d]);
    }
    return out;
  };
  const insideAny = (all: Array<Array<[number, number, number, number]>>, p: number[]) =>
    all.some(pl => pl.every(([nx, ny, nz, d]) => nx * p[0] + ny * p[1] + nz * p[2] - d <= 1e-9));

  /** Largest radius in the z=0 plane that no collider reaches into. */
  const clearHoleRadius = (hulls: ReturnType<typeof decomposeAroundAxis>) => {
    const planes = hulls.map(planesOf);
    for (let r = holeRadius; r > 0; r -= holeRadius / 400) {
      let hit = false;
      for (let a = 0; a < 720 && !hit; a++) {
        const t = (a / 720) * Math.PI * 2;
        if (insideAny(planes, [r * Math.cos(t), r * Math.sin(t), 0])) hit = true;
      }
      if (!hit) return r;
    }
    return 0;
  };

  it.each([8, 16, 20, 32])('produces %i convex colliders', sectors => {
    expect(decomposeAroundAxis(verts, faces, [0, 0, 0], [0, 0, 1], sectors)).toHaveLength(sectors);
  });

  it.each([8, 16, 20, 32])('at N=%i, total volume converges down to the true volume', sectors => {
    const sum = decomposeAroundAxis(verts, faces, [0, 0, 0], [0, 0, 1], sectors)
      .reduce((s, h) => s + h.volume, 0);
    // Hulls fill within-sector concavity, so never less than true; the excess
    // falls off as 1/N^2 (the chord sagitta).
    expect(sum).toBeGreaterThanOrEqual(trueVolume * 0.999);
    expect(sum).toBeLessThanOrEqual(trueVolume * (1 + 8 / sectors ** 2));
  });

  it.each([
    [8, 0.076], [16, 0.019], [20, 0.012], [32, 0.005],
  ])('at N=%i, the hole stays open to within %f of its radius', (sectors, predictedIntrusion) => {
    const clear = clearHoleRadius(decomposeAroundAxis(verts, faces, [0, 0, 0], [0, 0, 1], sectors));
    expect(clear).toBeGreaterThan(0);
    // Each sector's hull spans a chord of the hole's circle, so the clear radius
    // should land at holeRadius * cos(pi/N).
    expect(1 - clear / holeRadius).toBeCloseTo(predictedIntrusion as number, 2);
  });

  it('is the whole point: a single convex hull closes the hole', () => {
    const hull = convexHullOf(Array.from({ length: verts.length / 3 }, (_, i) =>
      [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]));
    expect(insideAny([planesOf(hull!)], [0, 0, 0])).toBe(true);
    expect(hull!.volume).toBeGreaterThan(trueVolume * 1.5);
  });

  it('rejects a degenerate point cloud rather than returning a flat hull', () => {
    expect(convexHullOf([[0, 0, 0], [1, 0, 0], [0, 1, 0]])).toBeNull();           // too few
    expect(convexHullOf([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]])).toBeNull(); // coplanar
  });
});

describe('bounds and outline clipping', () => {
  it('bounds a rotated geom by its transformed corners', () => {
    const flat = geomBounds({ name: 'g', type: 'box', size: [0.1, 0.02, 0.02] } as SceneGeom)!;
    expect(flat.max[0]).toBeCloseTo(0.1, 9);
    const turned = geomBounds({ name: 'g', type: 'box', size: [0.1, 0.02, 0.02], euler: [0, 0, 90] } as SceneGeom)!;
    expect(turned.max[1]).toBeCloseTo(0.1, 6);   // the long axis is now Y
    expect(turned.max[0]).toBeCloseTo(0.02, 6);
  });

  it('takes bounds from the positives only, ignoring the negatives', () => {
    const b = positiveBounds(washer())!;
    expect(b.max[2]).toBeCloseTo(0.028, 9);   // the plate, not the 0.05-deep hole
    expect(b.max[0]).toBeCloseTo(0.11, 9);
  });

  it('keeps a segment that lies inside the box', () => {
    expect(clipSegmentsToBox([0, 0, 0, 0.05, 0, 0], [-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]))
      .toEqual([0, 0, 0, 0.05, 0, 0]);
  });

  it('shortens a segment that straddles the boundary', () => {
    const out = clipSegmentsToBox([0, 0, 0, 0, 0, 1], [-1, -1, -1], [1, 1, 0.25]);
    expect(out[5]).toBeCloseTo(0.25, 9);
  });

  it('drops a segment entirely outside', () => {
    expect(clipSegmentsToBox([5, 5, 5, 6, 6, 6], [-1, -1, -1], [1, 1, 1])).toEqual([]);
  });

  it('drops a segment running parallel to and outside a slab', () => {
    expect(clipSegmentsToBox([0, 0, 5, 1, 0, 5], [-1, -1, -1], [1, 1, 1])).toEqual([]);
  });

  it('never draws a negative outline beyond the solid it cuts', () => {
    // The reported bug: the outline of a piercing negative sprawled far past the
    // thin solid, because a negative must overshoot to cut cleanly.
    const node = washer();
    const bounds = positiveBounds(node)!;
    const neg = node.geoms[1];

    const base = new THREE.SphereGeometry(1, 16, 10);
    base.scale(neg.size[0], neg.size[1], neg.size[2]);
    const edges = new THREE.EdgesGeometry(base, 1);
    const m = geomMatrixOf(neg);
    const src = edges.getAttribute('position').array as ArrayLike<number>;
    const baked: number[] = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
      baked.push(v.x, v.y, v.z);
    }

    // Unclipped, it reaches the negative's full 0.05 depth...
    expect(Math.max(...baked.filter((_, i) => i % 3 === 2))).toBeCloseTo(0.05, 2);
    // ...clipped, it stops at the plate's surface.
    const clipped = clipSegmentsToBox(baked, bounds.min, bounds.max);
    expect(clipped.length).toBeGreaterThan(0);
    for (let i = 0; i < clipped.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        expect(clipped[i + a]).toBeGreaterThanOrEqual(bounds.min[a] - 1e-9);
        expect(clipped[i + a]).toBeLessThanOrEqual(bounds.max[a] + 1e-9);
      }
    }
  });
});

describe('resolveCsgGeoms', () => {
  const derivedMesh: SceneGeom = {
    name: 'b_csg', type: 'mesh', size: [1], role: 'visual', csgDerived: 'visual', mass: 0,
  };
  const collider: SceneGeom = {
    name: 'b_col0', type: 'mesh', size: [1], role: 'collision', csgDerived: 'collider', mass: 1,
  };

  it('leaves a plain body untouched', () => {
    const n = body([{ name: 'g', type: 'box', size: [0.1, 0.1, 0.1] }]);
    expect(resolveCsgGeoms(n, 'physics')).toHaveLength(1);
    expect(resolveCsgGeoms(n, 'render')).toHaveLength(1);
  });

  it('never treats a negative as a solid, even without csgEnabled', () => {
    // Guards a hand-authored or older scene: showing a solid lump exactly where
    // the hole belongs is much worse than showing an un-subtracted solid.
    for (const node of [washer(), { ...washer(), csgEnabled: false }]) {
      for (const target of ['physics', 'render'] as const) {
        expect(resolveCsgGeoms(node, target).some(g => g.csg === 'difference')).toBe(false);
      }
    }
  });

  it('honours role independently of CSG', () => {
    const n = body([{ name: 'g', type: 'box', size: [0.1, 0.1, 0.1], role: 'collision' }]);
    expect(resolveCsgGeoms(n, 'physics')).toHaveLength(1);
    expect(resolveCsgGeoms(n, 'render')).toHaveLength(0);
  });

  it('draws the boolean mesh instead of the primitives it was cut from', () => {
    const n = washer();
    n.geoms.push(derivedMesh, collider);
    expect(resolveCsgGeoms(n, 'render').map(g => g.name)).toEqual(['b_csg']);
  });

  it('falls back to the positives while the mesh is still compiling', () => {
    expect(resolveCsgGeoms(washer(), 'render').map(g => g.name)).toEqual(['plate']);
    expect(resolveCsgGeoms(washer(), 'physics').map(g => g.name)).toEqual(['plate']);
  });

  it('collides the sectors, not the source primitives, once decomposed', () => {
    const n = washer();
    n.geoms.push(derivedMesh, collider);
    const names = resolveCsgGeoms(n, 'physics').map(g => g.name);
    expect(names).toContain('b_col0');
    expect(names).toContain('b_csg');       // present but contype-zeroed by mjcf
    expect(names).not.toContain('plate');
  });

  it('splits an explicit total mass across primitive colliders by volume', () => {
    const n = body([
      { name: 'big', type: 'sphere', size: [0.1] },
      { name: 'small', type: 'sphere', size: [0.05] },
      { name: 'hole', type: 'cylinder', size: [0.02, 0.4], csg: 'difference' },
    ], { csgEnabled: true, csgMass: 9 });
    const masses = resolveCsgGeoms(n, 'physics').map(g => g.mass!);
    expect(masses[0] + masses[1]).toBeCloseTo(9, 6);
    expect(masses[0] / masses[1]).toBeCloseTo(8, 6);   // radius ratio 2 -> volume ratio 8
  });
});
// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------
//
// A cut is stated as a spot on the surface, the way that surface faces, and a
// depth into the material. Everything the primitive is made of — where its
// middle is, how long it is, which way it is turned — is derived from those.
//
// Two things these exist to prevent, both of which shipped and had to be found:
//
//   Measuring depth from the bounding box. Right on a cube and wrong on
//   everything else — on an L-bracket a hole over the low arm was measured from
//   the top of the TALL arm, and when the step was deeper than the hole the
//   cutter never reached the material and the hole silently did not happen.
//
//   Snapping the direction to the nearest axis. A lattice VERTEX is three
//   integers, but a face joining any three of them can point anywhere; so can a
//   bevel, a smoothed surface, an imported STL. Snapping gives a hole that is
//   not square to the face it was asked for, and says nothing about it.

const block = (halfX = 0.02, halfY = 0.02, halfZ = 0.02) => body([
  { name: 'block', type: 'box', size: [halfX, halfY, halfZ], mass: 1 },
], { csgEnabled: true });

/** A 40 mm cube with a 40 mm tower on its +X half: a step 20 mm down at x < 0. */
const bracket = () => body([
  { name: 'low', type: 'box', size: [0.02, 0.02, 0.01], pos: [-0.02, 0, 0], mass: 1 },
  { name: 'tall', type: 'box', size: [0.02, 0.02, 0.02], pos: [0.02, 0, 0], mass: 1 },
], { csgEnabled: true });

const cut = (extra: Partial<SceneGeom> = {}): SceneGeom => ({
  name: 'cut', type: 'cylinder', size: [0.003, 0], csg: 'difference',
  cutNormal: [0, 0, 1], cutAt: [0, 0, 0.02], ...extra,
} as SceneGeom);

/** The cutter's two ends along its own axis, as points. */
function cutSpan(geom: SceneGeom): { out: number[]; in: number[] } {
  const n = geom.cutNormal!;
  const half = geom.size[geom.type === 'box' ? 2 : 1];
  const p = geom.pos!;
  return {
    out: [0, 1, 2].map(a => p[a] + n[a] * half),
    in: [0, 1, 2].map(a => p[a] - n[a] * half),
  };
}

describe('probing a body', () => {
  it('finds the top of whatever is actually under the spot', () => {
    const node = bracket();
    expect(surfaceUnder(node, [0.02, 0, 0], [0, 0, 1])!.entry[2]).toBeCloseTo(0.02, 9);
    expect(surfaceUnder(node, [-0.02, 0, 0], [0, 0, 1])!.entry[2]).toBeCloseTo(0.01, 9);
  });

  it('measures a curved surface where the hole is, not at its pole', () => {
    const dome = body([{ name: 'ball', type: 'sphere', size: [0.02], mass: 1 }], { csgEnabled: true });
    expect(surfaceUnder(dome, [0, 0, 0], [0, 0, 1])!.entry[2]).toBeCloseTo(0.02, 9);
    // 12 mm off centre on a 20 mm sphere: sqrt(20² − 12²) = 16.
    expect(surfaceUnder(dome, [0.012, 0, 0], [0, 0, 1])!.entry[2]).toBeCloseTo(0.016, 6);
  });

  it('reads a cylinder analytically, whichever way it is turned', () => {
    const rod = body([
      { name: 'rod', type: 'cylinder', size: [0.01, 0.05], euler: [0, 90, 0], mass: 1 },
    ], { csgEnabled: true });
    expect(surfaceUnder(rod, [0, 0, 0], [0, 0, 1])!.entry[2]).toBeCloseTo(0.01, 9);
    expect(surfaceUnder(rod, [0.03, 0.006, 0], [0, 0, 1])!.entry[2]).toBeCloseTo(0.008, 6);
    // Straight down the axis, i.e. onto a flat end cap.
    expect(surfaceUnder(rod, [0, 0, 0], [1, 0, 0])!.entry[0]).toBeCloseTo(0.05, 9);
  });

  it('reports how much material a line passes through, not the part height', () => {
    // The low arm is 20 mm thick; the bounding box is 40 mm tall.
    expect(surfaceUnder(bracket(), [-0.02, 0, 0], [0, 0, 1])!.thickness).toBeCloseTo(0.02, 9);
    expect(surfaceUnder(bracket(), [0.02, 0, 0], [0, 0, 1])!.thickness).toBeCloseTo(0.04, 9);
  });

  it('says nothing when the line misses the part', () => {
    expect(surfaceUnder(bracket(), [10, 0, 0], [0, 0, 1])).toBeNull();
  });
});

describe('pickCutSpot', () => {
  it('turns a look into a point and the way the surface faces there', () => {
    const spot = pickCutSpot(block(), [0, 0, 1], [0, 0, -1])!;
    expect(spot.at[2]).toBeCloseTo(0.02, 9);
    expect(spot.normal).toEqual([0, 0, 1]);
  });

  it('faces the normal back at the ray, whatever the winding says', () => {
    // A mesh wound the wrong way round — which the lattice editor draws in red
    // precisely because it happens — would otherwise hand back an inward normal
    // and put the hole on the far side of the surface.
    const flipped = body([{
      name: 'plate', type: 'mesh', size: [1], mass: 1,
      renderVertices: [-0.02, -0.02, 0.005, 0.02, -0.02, 0.005, 0.02, 0.02, 0.005, -0.02, 0.02, 0.005],
      faces: [0, 2, 1, 0, 3, 2],
    }], { csgEnabled: true });
    const spot = pickCutSpot(flipped, [0, 0, 1], [0, 0, -1])!;
    expect(spot.normal[2]).toBeGreaterThan(0);
  });

  it('reads a mesh from its own triangles, and misses when it should', () => {
    const plate = body([{
      name: 'plate', type: 'mesh', size: [1], mass: 1,
      renderVertices: [-0.02, -0.02, 0.005, 0.02, -0.02, 0.005, 0.02, 0.02, 0.005, -0.02, 0.02, 0.005],
      faces: [0, 1, 2, 0, 2, 3],
    }], { csgEnabled: true });
    expect(pickCutSpot(plate, [0, 0, 1], [0, 0, -1])!.at[2]).toBeCloseTo(0.005, 9);
    expect(pickCutSpot(plate, [0.5, 0, 1], [0, 0, -1])).toBeNull();
  });
});

describe('cutGeometry', () => {
  it('turns a depth into a cutter that overshoots the surface it enters', () => {
    // 40 mm cube, 10 mm deep into the top. The hole runs 20 down to 10; the
    // cutter runs from 10 up past 20, so it breaks the surface rather than
    // ending flush on it — coincident faces are how a boolean stops being solid.
    const geom = cut({ cutDepth: 0.01 });
    Object.assign(geom, cutGeometry(block(), geom));
    const span = cutSpan(geom);
    expect(span.in[2]).toBeCloseTo(0.01, 6);        // bottoms out 10 mm down
    expect(span.out[2]).toBeGreaterThan(0.02);      // and pokes out past the top
    expect(geom.size[1] * 2).toBeLessThan(0.013);   // barely longer than the hole
  });

  it('goes clear out of both sides when it goes through', () => {
    const geom = cut({ cutDepth: 0 });
    Object.assign(geom, cutGeometry(block(), geom));
    const span = cutSpan(geom);
    expect(span.out[2]).toBeGreaterThan(0.02);
    expect(span.in[2]).toBeLessThan(-0.02);
  });

  /*
   * The whole point of the rewrite. A face at 45 degrees is ordinary here — a
   * bevel makes them deliberately, and a face joining any three grid points can
   * point anywhere at all — and a hole in one has to be square to it.
   */
  it('runs square to a slanted surface, not to the nearest axis', () => {
    const root = Math.SQRT1_2;
    const geom = cut({ cutNormal: [root, 0, root], cutAt: [0.02, 0, 0.02], cutDepth: 0.01 });
    Object.assign(geom, cutGeometry(block(), geom));
    const span = cutSpan(geom);
    // 10 mm along the diagonal is 7.07 mm on each of the two axes.
    const travelled = Math.hypot(span.out[0] - span.in[0], span.out[2] - span.in[2]);
    expect(travelled).toBeCloseTo(geom.size[1] * 2, 9);
    expect(span.out[0] - span.in[0]).toBeCloseTo(span.out[2] - span.in[2], 9);
    // And the quaternion turns the cylinder's own +Z onto that same line.
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(
      new THREE.Quaternion(geom.quat![1], geom.quat![2], geom.quat![3], geom.quat![0]),
    );
    expect(axis.x).toBeCloseTo(root, 6);
    expect(axis.z).toBeCloseTo(root, 6);
  });

  it('keeps a slot square to the surface, sized in its own frame', () => {
    const geom = cut({ type: 'box', size: [0.004, 0.006, 0], cutDepth: 0.01 });
    Object.assign(geom, cutGeometry(block(), geom));
    expect(geom.size[0]).toBeCloseTo(0.004, 9);   // across, untouched
    expect(geom.size[1]).toBeCloseTo(0.006, 9);
    expect(cutSpan(geom).in[2]).toBeCloseTo(0.01, 6);
  });

  it('sinks a dish so its deepest point is the depth asked for', () => {
    const geom = cut({ type: 'sphere', size: [0.005], cutDepth: 0.003 });
    Object.assign(geom, cutGeometry(block(), geom));
    expect(geom.pos![2] - 0.005).toBeCloseTo(0.017, 6);  // 3 mm below the top face
    expect(geom.pos![2] + 0.005).toBeGreaterThan(0.02);  // and still breaks it
  });

  it('will not sink a dish deeper than the ball can reach', () => {
    // Past its own diameter the sphere would clear the surface entirely and cut
    // a bubble inside the part — a void nobody asked for and nothing can see.
    const geom = cut({ type: 'sphere', size: [0.005], cutDepth: 0.05 });
    Object.assign(geom, cutGeometry(block(), geom));
    expect(geom.pos![2] + 0.005).toBeCloseTo(0.02, 6);
  });

  it('scales the overshoot to the part, with a floor under it', () => {
    // 2% of the part's diagonal, so turning a hole does not change it, with a
    // floor far below: a fixed 1 mm is invisible on a 2 m beam and half the
    // model on a 2 mm one.
    const big = cut({ cutAt: [0, 0, 1], cutDepth: 0.5 });
    Object.assign(big, cutGeometry(block(1, 1, 1), big));
    expect(cutSpan(big).out[2] - 1).toBeCloseTo(2 * Math.sqrt(3) * 0.02, 6);
    const tiny = cut({ cutAt: [0, 0, 0.001], cutDepth: 0.0005 });
    Object.assign(tiny, cutGeometry(block(0.001, 0.001, 0.001), tiny));
    expect(cutSpan(tiny).out[2] - 0.001).toBeCloseTo(0.0001, 9);
  });
});

describe('cutDepthOf', () => {
  it('reports the hole, not the cutter', () => {
    expect(cutDepthOf(block(), cut({ cutDepth: 0.01 }))).toBeCloseTo(0.01, 9);
    // A hole with no depth of its own is as deep as the material under it —
    // and on a stepped part that is not the height of the whole thing.
    expect(cutDepthOf(block(), cut({ cutDepth: 0 }))).toBeCloseTo(0.04, 9);
    expect(cutDepthOf(bracket(), cut({ cutDepth: 0, cutAt: [-0.02, 0, 0.01] }))).toBeCloseTo(0.02, 9);
  });
});

describe('reconcileCuts', () => {
  it('keeps a hole in the surface it names when the part grows', () => {
    const node = block();
    node.geoms.push(cut({ cutDepth: 0.01 }));
    reconcileCuts(node);
    expect(cutSpan(node.geoms[1]).in[2]).toBeCloseTo(0.01, 6);

    // The block gets 20 mm taller. Left alone the hole would stay where it was
    // and end up sealed inside the material, 20 mm under the new surface.
    node.geoms[0].size = [0.02, 0.02, 0.04];
    expect(reconcileCuts(node)).toBe(true);
    expect(cutSpan(node.geoms[1]).in[2]).toBeCloseTo(0.03, 6);      // still 10 mm down
    expect(cutSpan(node.geoms[1]).out[2]).toBeGreaterThan(0.04);    // still breaks the top
  });

  it('goes the depth asked for into the arm it is over', () => {
    const node = bracket();
    // 10 mm into the low arm, whose top is at 10 mm. Before this, the cutter
    // ran from the tall arm's 20 mm down to 10 mm and removed nothing at all.
    node.geoms.push(cut({ cutDepth: 0.01, cutAt: [-0.02, 0, 0.01] }));
    reconcileCuts(node);
    expect(cutSpan(node.geoms[2]).in[2]).toBeCloseTo(0, 6);
    expect(cutSpan(node.geoms[2]).out[2]).toBeGreaterThan(0.01);
  });

  it('passes through only the thickness it is actually in', () => {
    const node = bracket();
    node.geoms.push(cut({ cutDepth: 0, cutAt: [-0.02, 0, 0.01] }));
    reconcileCuts(node);
    const geom = node.geoms[2];
    // The low arm is 20 mm thick, not the 40 mm the bounding box would claim.
    expect(cutSpan(geom).out[2]).toBeGreaterThan(0.01);
    expect(cutSpan(geom).in[2]).toBeLessThan(-0.01);
    expect(geom.size[1] * 2).toBeLessThan(0.04);
  });

  it('says when it changed nothing, so a recompile can be skipped', () => {
    const node = block();
    node.geoms.push(cut({ cutDepth: 0.01 }));
    reconcileCuts(node);
    expect(reconcileCuts(node)).toBe(false);
  });

  /*
   * The ring preset, every hand-authored scene, and every negative an agent has
   * ever placed by coordinates. They carry no direction, so there is no intent
   * to honour and their numbers are theirs.
   */
  it('will not touch a negative that never claimed a direction', () => {
    const node = block();
    node.geoms.push({ name: 'authored', type: 'cylinder', size: [0.003, 0.05], csg: 'difference', pos: [0, 0, 0.1] });
    expect(reconcileCuts(node)).toBe(false);
    expect(node.geoms[1].pos).toEqual([0, 0, 0.1]);
  });

  it('leaves a cut alone when its line has stopped meeting the part', () => {
    // Not an error, and not a reason to move it somewhere arbitrary: the
    // outline stays visible where it was, which is what lets you drag it back.
    const node = block();
    node.geoms.push(cut({ cutDepth: 0.01, cutAt: [10, 0, 0.02] }));
    const before = cutGeometry(node, node.geoms[1]);
    expect(before).not.toBeNull();
    expect(before!.pos[0]).toBeCloseTo(10, 6);
  });
});

describe('source and compiled bounds', () => {
  it('differ by the shift a compiled solid was re-origined with', () => {
    const node = block();
    node.csgCentroid = [0.01, -0.02, 0.5];
    const source = sourcePositiveBounds(node)!;
    const compiled = positiveBounds(node)!;
    // X and Y move; Z is deliberately left where it was modelled.
    expect(compiled.min[0]).toBeCloseTo(source.min[0] - 0.01, 9);
    expect(compiled.min[1]).toBeCloseTo(source.min[1] + 0.02, 9);
    expect(compiled.min[2]).toBeCloseTo(source.min[2], 9);
  });
});
