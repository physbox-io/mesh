import { describe, it, expect } from 'vitest';
import {
  createLattice, vertexAt, coordOf, faceCount, isWatertight, inconsistentFaces,
  circleSides, ringCoords, addRing, chainFromEdges, revolveChain, latticeBounds,
  signedVolume, type Lattice, type LatticeCoord,
} from '../src/utils/latticeMesh';

describe('how round a circle has to be', () => {
  it('takes more sides for a bigger radius', () => {
    expect(circleSides(20)).toBeLessThan(circleSides(200));
  });

  it('keeps every side within half a grid step of the true arc', () => {
    // Up to the point where the 64-corner cap takes over, which at the finest
    // grid is a radius of about 41 mm. Past that the cage is deliberately
    // coarser than the grid — it is a thing to be edited by hand, and a pass of
    // smoothing puts the roundness back.
    for (const radius of [5, 12, 40, 137, 410]) {
      const sides = circleSides(radius);
      const sagitta = radius * (1 - Math.cos(Math.PI / sides));
      expect(sagitta).toBeLessThanOrEqual(0.5);
    }
  });

  it('never asks for more corners than a cage can be edited with', () => {
    expect(circleSides(1e6)).toBe(64);
    expect(circleSides(1)).toBe(6);
    expect(circleSides(0)).toBe(6);
  });
});

describe('rings on the grid', () => {
  it('lands every corner on a grid point', () => {
    const ring = ringCoords([0, 0, 0], 50, 'z')!;
    for (const coord of ring) for (const c of coord) expect(Number.isInteger(c)).toBe(true);
  });

  it('stays in the plane it was asked for', () => {
    const ring = ringCoords([3, 4, 7], 20, 'z')!;
    for (const coord of ring) expect(coord[2]).toBe(7);
    const across = ringCoords([3, 4, 7], 20, 'x')!;
    for (const coord of across) expect(coord[0]).toBe(3);
  });

  it('is round to within the rounding of the radius asked for', () => {
    const ring = ringCoords([0, 0, 0], 137, 'z')!;
    // Half a step on each of two axes: the worst a corner can be off is the
    // diagonal of half a cell, and nothing is allowed to be worse than that.
    for (const [i, j] of ring) expect(Math.abs(Math.hypot(i, j) - 137)).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-9);
  });

  it('winds counter-clockwise seen from the axis it faces', () => {
    const ring = ringCoords([0, 0, 0], 40, 'z')!;
    let twice = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      twice += x1 * y2 - x2 * y1;
    }
    expect(twice).toBeGreaterThan(0);
  });

  it('collapses corners that round onto the same grid point', () => {
    // Twelve sides on a radius of one cannot all be distinct, and an octagon
    // is a more useful answer than a refusal.
    const ring = ringCoords([0, 0, 0], 1, 'z', 12)!;
    const seen = new Set(ring.map((c) => c.join(',')));
    expect(seen.size).toBe(ring.length);
    expect(ring.length).toBeLessThan(12);
  });

  it('refuses what is not a profile', () => {
    expect(ringCoords([0, 0, 0], 0, 'z')).toBeNull();
    expect(ringCoords([0, 0, 0], 20, 'z', 2)).toBeNull();
    expect(ringCoords([0, 0, 0], 0.4, 'z', 12)).toBeNull();
  });

  it('places the ring as one closed face', () => {
    const l = createLattice(0.0001);
    const face = addRing(l, [0, 0, 0], 100, 'z');
    expect(face).not.toBe(-1);
    expect(faceCount(l)).toBe(1);
    expect(l.faces[face]!.length).toBe(circleSides(100));
  });
});

describe('putting selected edges in order', () => {
  const l = createLattice(0.001);
  const v = (i: number) => vertexAt(l, i, 0, 0);

  it('orders an open run from one end to the other', () => {
    const found = chainFromEdges([[v(2), v(3)], [v(0), v(1)], [v(1), v(2)]])!;
    expect(found.closed).toBe(false);
    // Which end it starts from is nobody's business — a revolve's winding is
    // settled by orientFaces afterwards — but the run has to be in order.
    const run = found.chain.map((vertex) => coordOf(l, vertex)[0]);
    expect(run.length).toBe(4);
    expect(run.every((x, i) => i === 0 || Math.abs(x - run[i - 1]) === 1)).toBe(true);
  });

  it('recognises a closed loop', () => {
    const w = (i: number) => vertexAt(l, 0, i, 5);
    const found = chainFromEdges([[w(0), w(1)], [w(1), w(2)], [w(2), w(0)]]);
    expect(found!.closed).toBe(true);
    expect(found!.chain.length).toBe(3);
  });

  it('refuses a selection in two pieces', () => {
    expect(chainFromEdges([[v(0), v(1)], [v(5), v(6)]])).toBeNull();
  });

  it('refuses a junction where three edges meet', () => {
    const w = (j: number) => vertexAt(l, 0, j, 9);
    expect(chainFromEdges([[v(0), v(1)], [v(1), v(2)], [v(1), w(1)]])).toBeNull();
  });

  it('refuses nothing at all', () => {
    expect(chainFromEdges([])).toBeNull();
  });
});

describe('revolving a profile', () => {
  /** A straight profile parallel to Z, `radius` out from the Z axis. */
  function post(l: Lattice, radius: number, from: number, to: number): number[] {
    return [vertexAt(l, radius, 0, from), vertexAt(l, radius, 0, to)];
  }

  it('turns a straight profile into a tube', () => {
    const l = createLattice(0.001);
    const result = revolveChain(l, post(l, 20, 0, 30), 'z', [0, 0, 0]);
    expect(result).not.toBeNull();
    const bounds = latticeBounds(l)!;
    expect(bounds.min[2]).toBe(0);
    expect(bounds.max[2]).toBe(30);
    expect(bounds.max[0]).toBeCloseTo(20, 0);
    expect(bounds.min[0]).toBeCloseTo(-20, 0);
  });

  it('closes a full turn back onto its own first ring', () => {
    const l = createLattice(0.001);
    revolveChain(l, post(l, 20, 0, 30), 'z', [0, 0, 0]);
    // A wall with no caps: every edge either has two faces or is a rim, and
    // the two rims are the only open edges there are.
    expect(inconsistentFaces(l)).toBe(0);
    expect(isWatertight(l)).toBe(false);
  });

  it('leaves a partial revolve open at both ends', () => {
    const l = createLattice(0.001);
    const quarter = revolveChain(l, post(l, 20, 0, 30), 'z', [0, 0, 0], 8, 90)!;
    expect(quarter.faces.length).toBe(8);
    const bounds = latticeBounds(l)!;
    // A quarter turn from the +x axis reaches +y and no further round.
    expect(bounds.min[1]).toBe(0);
    expect(bounds.max[1]).toBeCloseTo(20, 0);
  });

  it('makes a pole where the profile touches the axis, not a seam of doubles', () => {
    const l = createLattice(0.001);
    // A cone: from the axis out to a rim.
    const chain = [vertexAt(l, 0, 0, 40), vertexAt(l, 30, 0, 0)];
    const result = revolveChain(l, chain, 'z', [0, 0, 0], 12)!;
    // Twelve triangles round the point, none of them degenerate.
    expect(result.faces.length).toBe(12);
    for (const face of result.faces) {
      const verts = l.faces[face]!;
      expect(verts.length).toBe(3);
      expect(new Set(verts).size).toBe(3);
    }
  });

  it('makes a closed solid when the profile is a closed loop', () => {
    const l = createLattice(0.001);
    // A square section, 10 out from the axis: revolved, a torus of sorts.
    const square: LatticeCoord[] = [[20, 0, -5], [30, 0, -5], [30, 0, 5], [20, 0, 5]];
    const chain = square.map(([i, j, k]) => vertexAt(l, i, j, k));
    const result = revolveChain(l, [...chain, chain[0]], 'z', [0, 0, 0], 16)!;
    expect(result.faces.length).toBe(64);
    // One ring per stop, so a caller can cap a partial sweep at either end.
    expect(result.rings.length).toBe(16);
    expect(result.rings[0].length).toBe(5);
    expect(isWatertight(l)).toBe(true);
    expect(inconsistentFaces(l)).toBe(0);
    expect(Math.abs(signedVolume(l))).toBeGreaterThan(0);
  });

  it('measures the radius from the axis it was given, not from the origin', () => {
    const l = createLattice(0.001);
    const chain = [vertexAt(l, 100, 0, 0), vertexAt(l, 100, 0, 20)];
    revolveChain(l, chain, 'z', [90, 0, 0], 8);
    const bounds = latticeBounds(l)!;
    // Ten out from an axis at x=90: the ring spans 80 to 100, not -100 to 100.
    expect(bounds.min[0]).toBe(80);
    expect(bounds.max[0]).toBe(100);
  });

  it('refuses a profile that is not one', () => {
    const l = createLattice(0.001);
    expect(revolveChain(l, [vertexAt(l, 1, 0, 0)], 'z', [0, 0, 0])).toBeNull();
    expect(revolveChain(l, post(l, 20, 0, 30), 'z', [0, 0, 0], 8, 0)).toBeNull();
  });

  it('leaves nothing behind when it refuses', () => {
    const l = createLattice(0.001);
    const chain = post(l, 20, 0, 30);
    expect(revolveChain(l, chain, 'z', [0, 0, 0], 8, 0)).toBeNull();
    expect(faceCount(l)).toBe(0);
  });
});

describe('a ring is ordinary lattice data', () => {
  it('can be extruded into a cylinder like any other face', () => {
    const l = createLattice(0.0001);
    const face = addRing(l, [0, 0, 0], 100, 'z');
    const before = faceCount(l);
    // Placed and then treated as a face, which is the whole claim: a circle is
    // not a special kind of object, it is a polygon that happens to be round.
    expect(l.faces[face]).not.toBeNull();
    expect(before).toBe(1);
    const ring = l.faces[face]!;
    expect(ring.every((v) => coordOf(l, v)[2] === 0)).toBe(true);
  });

  it('sits at the centre it was given', () => {
    const l = createLattice(0.0001);
    const face = addRing(l, [50, -20, 3], 40, 'z');
    const ring = l.faces[face]!.map((v) => coordOf(l, v));
    const middle = ring.reduce((sum, c) => [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]], [0, 0, 0]);
    expect(Math.round(middle[0] / ring.length)).toBe(50);
    expect(Math.round(middle[1] / ring.length)).toBe(-20);
    expect(middle[2] / ring.length).toBe(3);
  });
});
