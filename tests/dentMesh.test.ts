// Turning a primitive into something that can take a dent.
//
// The point of this module is that the answer to "can I dent a box?" should be
// yes. A box in MuJoCo is six numbers, so it has no vertices to push in; making
// it dentable means rebuilding it as the mesh it already looked like. What must
// be true of that mesh is that it is CLOSED (an open shell is the wrong thing to
// hand a physics engine or an exporter), wound OUTWARD (single-sided rendering
// draws an inside-out mesh as a half-transparent ghost), the right SIZE, and
// fine enough that a brush can make a dish in it rather than a crease.

import { describe, it, expect } from 'vitest';
import {
  boxMeshForDenting, cylinderMeshForDenting, ellipsoidMeshForDenting,
  fromtoCenter, isDentable, meshForDenting, needsConversionForDenting,
} from '../src/utils/dentMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGeom } from '../src/types/scene';

const bounds = (v: number[]) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  }
  return { lo, hi };
};

describe('boxMeshForDenting', () => {
  it('is a closed, outward-wound solid of the right size', () => {
    const { vertices, faces } = boxMeshForDenting(0.2, 0.05, 0.1);
    const report = analyzeMesh(vertices, faces);
    expect(report.closed).toBe(true);
    expect(report.consistentlyWound).toBe(true);
    expect(report.boundaryEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    // Outward, or it renders as a see-through ghost.
    expect(report.volume).toBeGreaterThan(0);
    // ...and it is the box it claims to be: 0.4 x 0.1 x 0.2 = 0.008 m^3.
    expect(report.volume).toBeCloseTo(0.4 * 0.1 * 0.2, 9);
    const { lo, hi } = bounds(vertices);
    expect(lo).toEqual([-0.2, -0.05, -0.1]);
    expect(hi).toEqual([0.2, 0.05, 0.1]);
  });

  it('has enough vertices across a face to hold a dish rather than a crease', () => {
    const { vertices } = boxMeshForDenting(0.2, 0.01, 0.15);
    // A six-vertex box is the thing this exists to avoid.
    expect(vertices.length / 3).toBeGreaterThan(200);
  });

  it('shares its corners, so a dent cannot tear it open at a seam', () => {
    const { vertices, faces } = boxMeshForDenting(0.1, 0.1, 0.1);
    expect(analyzeMesh(vertices, faces).boundaryEdges).toBe(0);
  });
});

describe('cylinderMeshForDenting', () => {
  it('is closed, outward, and about the right volume', () => {
    const r = 0.04, h = 0.05;
    const { vertices, faces } = cylinderMeshForDenting(r, h);
    const report = analyzeMesh(vertices, faces);
    expect(report.closed).toBe(true);
    expect(report.consistentlyWound).toBe(true);
    expect(report.volume).toBeGreaterThan(0);
    // A polygon inscribes slightly under the true circle.
    const analytic = Math.PI * r * r * 2 * h;
    expect(report.volume).toBeGreaterThan(analytic * 0.95);
    expect(report.volume).toBeLessThanOrEqual(analytic);
  });
});

describe('ellipsoidMeshForDenting', () => {
  it('is closed, outward, and about the right volume', () => {
    const { vertices, faces } = ellipsoidMeshForDenting(0.05, 0.03, 0.05);
    const report = analyzeMesh(vertices, faces);
    expect(report.closed).toBe(true);
    expect(report.consistentlyWound).toBe(true);
    const analytic = (4 / 3) * Math.PI * 0.05 * 0.03 * 0.05;
    expect(report.volume).toBeGreaterThan(analytic * 0.9);
    expect(report.volume).toBeLessThanOrEqual(analytic);
  });
});

describe('meshForDenting', () => {
  const geom = (g: Partial<SceneGeom>): SceneGeom =>
    ({ name: 'g', type: 'box', size: [0.1, 0.1, 0.1], ...g }) as SceneGeom;

  it('converts every primitive somebody might want to dent', () => {
    for (const type of ['box', 'cylinder', 'capsule', 'sphere', 'ellipsoid'] as const) {
      const mesh = meshForDenting(geom({ type, size: [0.05, 0.05, 0.05] }));
      expect(mesh, `${type} should convert`).not.toBeNull();
      expect(analyzeMesh(mesh!.vertices, mesh!.faces).volume).toBeGreaterThan(0);
    }
  });

  it('declines a plane, which is infinite in the solver and has no surface', () => {
    expect(meshForDenting(geom({ type: 'plane' }))).toBeNull();
    expect(needsConversionForDenting(geom({ type: 'plane' }))).toBe(false);
  });

  it('declines a mesh, which needs no conversion', () => {
    const already = geom({ type: 'mesh', vertices: [0, 0, 0], faces: [0, 0, 0] });
    expect(meshForDenting(already)).toBeNull();
    expect(isDentable(already)).toBe(true);
    expect(needsConversionForDenting(already)).toBe(false);
  });

  it('knows a primitive has to be converted first', () => {
    expect(isDentable(geom({ type: 'box' }))).toBe(false);
    expect(needsConversionForDenting(geom({ type: 'box' }))).toBe(true);
  });

  it('takes a capsule\'s length from its fromto when it has one', () => {
    const short = meshForDenting(geom({ type: 'capsule', size: [0.01], fromto: [0, 0, 0, 0, 0, 0.1] }))!;
    const long = meshForDenting(geom({ type: 'capsule', size: [0.01], fromto: [0, 0, 0, 0, 0, 0.4] }))!;
    expect(bounds(long.vertices).hi[1] - bounds(long.vertices).lo[1])
      .toBeGreaterThan(bounds(short.vertices).hi[1] - bounds(short.vertices).lo[1]);
  });

  /*
    A fromto says which way the shape runs, not just how long it is. The double
    pendulum's lower arm is a capsule from the body origin out to +X, with its
    bob a second geom at the far end; converting it for shattering used to
    return an upright cylinder, so the arm stood vertical and parted company
    with the bob still out at 0.22.

    The direction goes into the vertices; the OFFSET deliberately does not, and
    is asserted separately below. fromto is MuJoCo's Z-up body frame while these
    vertices are Three's Y-up, so MuJoCo +X stays Three +X here and MuJoCo +Z
    would become Three +Y.
  */
  it('points the mesh down the fromto axis, not just along +Y', () => {
    const r = 0.005;
    const mesh = meshForDenting(geom({ type: 'capsule', size: [r], fromto: [0, 0, 0, 0.22, 0, 0] }))!;
    const { lo, hi } = bounds(mesh.vertices);

    // Long axis is X, the fromto's length...
    expect(hi[0] - lo[0]).toBeCloseTo(0.22, 6);
    // ...and thin across the other two, not 0.22 tall in Y as it was.
    expect(hi[1] - lo[1]).toBeCloseTo(2 * r, 6);
    expect(hi[2] - lo[2]).toBeCloseTo(2 * r, 6);
  });

  /*
    The offset is carried TWICE, and that is deliberate. For a dynamic mesh the
    renderer draws renderVertices at the body's transform and never reads the
    geom's pos, while MuJoCo recentres a mesh asset on its volume centroid and
    places that at the geom's pos. Feed only one and the body collides half its
    own length away from where it is drawn. A cylinder's centroid is its axis
    midpoint, so both want the same number.
  */
  it('carries the fromto offset in the vertices, for the renderer', () => {
    const mesh = meshForDenting(geom({ type: 'cylinder', size: [0.01], fromto: [0.5, 0, 0.1, 0.5, 0, 0.3] }))!;
    const { lo, hi } = bounds(mesh.vertices);
    // MuJoCo (0.5, 0, 0.1..0.3) -> Three (0.5, 0.1..0.3, 0).
    expect((lo[0] + hi[0]) / 2).toBeCloseTo(0.5, 6);
    expect(lo[1]).toBeCloseTo(0.1, 6);
    expect(hi[1]).toBeCloseTo(0.3, 6);
  });

  it('and repeats it on the geom pos, in the fromto\'s own frame, for MuJoCo', () => {
    expect(fromtoCenter([0.5, 0, 0.1, 0.5, 0, 0.3])).toEqual([0.5, 0, 0.2]);
    expect(fromtoCenter([0, 0, 0, 0.22, 0, 0])).toEqual([0.11, 0, 0]);
  });
});
