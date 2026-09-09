import { describe, it, expect } from 'vitest';
import {
  addFacesMm, removeFacesMm, extrudeMm, findFaceMm, coordFromMm, mmFromCoord,
  describeLattice, latticeSummary, sharpenEdgesMm, insetFaceMm, bevelFaceMm, bridgeFacesMm,
} from '../src/utils/latticeCommands';
import { boxLattice, createLattice, DEFAULT_UNIT, faceCount, findVertex, isWatertight } from '../src/utils/latticeMesh';

const square = (z = 0) => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];

describe('millimetres in, millimetres out', () => {
  it('converts both ways on a 0.1 mm grid', () => {
    expect(coordFromMm([1, -2.5, 0.3], DEFAULT_UNIT)).toEqual([10, -25, 3]);
    expect(mmFromCoord([10, -25, 3], DEFAULT_UNIT)).toEqual([1, -2.5, 0.3]);
  });

  it('snaps a point that is off the grid, and says how far', () => {
    const l = createLattice();
    const { added, snappedBy } = addFacesMm(l, [[[0, 0, 0], [10, 0, 0], [10, 10.04, 0]]]);
    expect(added).toBe(1);
    expect(snappedBy).toBeCloseTo(0.04, 5);
    expect(findVertex(l, 100, 100, 0)).toBeGreaterThan(-1);
  });
});

describe('adding faces', () => {
  it('adds and reports what it refused', () => {
    const l = createLattice();
    const result = addFacesMm(l, [
      square(),
      square(),                              // the same face again
      [[0, 0, 0], [1, 1, 1]],                // too few corners
      [[0, 0, 0], [0, 0, 0], [5, 0, 0]],     // a repeated corner
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped[0].reason).toMatch(/already exists/);
    expect(result.skipped[2].reason).toMatch(/same point/);
  });

  it('mirrors when asked', () => {
    const l = createLattice();
    addFacesMm(l, [[[10, 0, 0], [20, 0, 0], [20, 10, 0], [10, 10, 0]]], 'x');
    expect(faceCount(l)).toBe(2);
    expect(findVertex(l, -200, 100, 0)).toBeGreaterThan(-1);
  });

  it('refuses a request that is not a list of faces', () => {
    expect(() => addFacesMm(createLattice(), [])).toThrow(/list of faces/);
  });
});

describe('finding a face again', () => {
  it('matches whatever order the corners are given in', () => {
    const l = createLattice();
    addFacesMm(l, [square()]);
    expect(findFaceMm(l, square())).toBe(0);
    expect(findFaceMm(l, [...square()].reverse())).toBe(0);
    expect(findFaceMm(l, [square()[2], square()[3], square()[0], square()[1]])).toBe(0);
    expect(findFaceMm(l, square(5))).toBe(-1);
  });
});

describe('extruding', () => {
  it('pushes a face out in whole steps and reports the new cap', () => {
    const l = createLattice();
    addFacesMm(l, [square()]);
    const result = extrudeMm(l, square(), 5);
    expect(result.steps).toBe(50);
    expect(result.distanceMm).toBe(5);
    expect(result.sides).toBe(4);
    expect(result.cap.every((corner) => corner[2] === 5)).toBe(true);
    // The cap it reports is a face that can be extruded again.
    expect(findFaceMm(l, result.cap)).toBeGreaterThan(-1);
  });

  it('refuses a distance that rounds to nothing', () => {
    const l = createLattice();
    addFacesMm(l, [square()]);
    expect(() => extrudeMm(l, square(), 0.04)).toThrow(/less than half a grid step/);
  });

  it('refuses a face that is not there', () => {
    const l = createLattice();
    expect(() => extrudeMm(l, square(), 5)).toThrow(/No face has those corners/);
  });
});

describe('removing faces', () => {
  it('removes by corners and reports the ones it could not find', () => {
    const l = boxLattice(DEFAULT_UNIT, 100); // 20 mm cube, corners at +/-10
    expect(isWatertight(l)).toBe(true);
    const top = [[-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10]];
    const result = removeFacesMm(l, [top, square(999)]);
    expect(result.removed).toBe(1);
    expect(result.missing).toHaveLength(1);
    expect(isWatertight(l)).toBe(false);
  });
});

describe('reading a shape back', () => {
  it('reports faces as corners that can be fed straight back in', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    const described = describeLattice(l);
    expect(described.faces).toHaveLength(6);
    expect(described.watertight).toBe(true);
    expect(described.sizeMm).toEqual([20, 20, 20]);
    expect(described.stepMm).toBeCloseTo(0.1);
    // Every face it describes is a face it can find again.
    for (const face of described.faces) expect(findFaceMm(l, face.corners)).toBeGreaterThan(-1);
    // And the normals are outward, as the six axis directions.
    expect(described.faces.map((f) => f.normal).sort()).toEqual(['+x', '+y', '+z', '-x', '-y', '-z']);
  });

  it('summarises an empty cage without falling over', () => {
    expect(latticeSummary(createLattice())).toMatchObject({ faces: 0, bounds: null, sizeMm: null });
  });
});

describe('creasing over MCP', () => {
  const topFace = [[-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10]];

  it('marks an edge sharp and reports it back on the face it belongs to', () => {
    const l = boxLattice(DEFAULT_UNIT, 100); // 20 mm cube
    const edge = [topFace[0], topFace[1]];
    expect(sharpenEdgesMm(l, [edge], true).changed).toBe(1);
    expect(latticeSummary(l).creases).toBe(1);

    const described = describeLattice(l);
    const withCrease = described.faces.filter((f) => f.sharpEdges.length > 0);
    // One edge, shared by the two faces that meet along it.
    expect(withCrease).toHaveLength(2);
    // And the corners it reports are the ones that were sent in.
    expect(withCrease[0].sharpEdges[0].flat()).toEqual(expect.arrayContaining(edge.flat()));
  });

  it('takes a crease off again', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    const edge = [topFace[0], topFace[1]];
    sharpenEdgesMm(l, [edge], true);
    expect(sharpenEdgesMm(l, [edge], false).changed).toBe(1);
    expect(latticeSummary(l).creases).toBe(0);
  });

  it('explains what it could not crease', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    const result = sharpenEdgesMm(l, [
      [topFace[0], topFace[2]],           // a diagonal: no face runs along it
      [[99, 99, 99], [98, 99, 99]],       // nothing is there at all
      [topFace[0]],                       // not an edge
    ], true);
    expect(result.changed).toBe(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped[1].reason).toMatch(/no corner of the shape/);
    expect(result.skipped[2].reason).toMatch(/two corners, or three and up/);
  });

  it('mirrors a crease when asked', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    sharpenEdgesMm(l, [[[-10, -10, 10], [-10, 10, 10]]], true, 'x');
    expect(latticeSummary(l).creases).toBe(2);
  });
});

describe('creasing a whole loop over MCP', () => {
  /** A 20 mm plate extruded twice, so its middle ring is a real loop. */
  function tube() {
    const l = createLattice(DEFAULT_UNIT);
    const plate = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]];
    addFacesMm(l, [plate]);
    const first = extrudeMm(l, plate, 10);
    extrudeMm(l, first.cap, 10);
    return l;
  }

  it('grows one edge into the ring it belongs to', () => {
    const l = tube();
    const oneEdge = [[-10, -10, 10], [10, -10, 10]];
    expect(sharpenEdgesMm(l, [oneEdge], true, undefined, true).changed).toBe(4);
    expect(latticeSummary(l).creases).toBe(4);
  });

  it('creases only the edge given without it', () => {
    const l = tube();
    expect(sharpenEdgesMm(l, [[[-10, -10, 10], [10, -10, 10]]], true).changed).toBe(1);
  });

  it('takes a whole loop off again', () => {
    const l = tube();
    const oneEdge = [[-10, -10, 10], [10, -10, 10]];
    sharpenEdgesMm(l, [oneEdge], true, undefined, true);
    expect(sharpenEdgesMm(l, [oneEdge], false, undefined, true).changed).toBe(4);
    expect(latticeSummary(l).creases).toBe(0);
  });
});

describe('creasing a face border over MCP', () => {
  const top = [[-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10]];

  it('reads four corners as a face and marks its whole rim', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    expect(sharpenEdgesMm(l, [top], true).changed).toBe(4);
    expect(latticeSummary(l).creases).toBe(4);
  });

  it('is the answer where a loop is not — a cap has no loop through it', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    // Every corner of a box is three-way, so growing an edge finds only itself.
    expect(sharpenEdgesMm(l, [[top[0], top[1]]], true, undefined, true).changed).toBe(1);
  });

  it('refuses corners that are not a face', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    const result = sharpenEdgesMm(l, [[top[0], top[1], [0, 0, 99]]], true);
    expect(result.changed).toBe(0);
    expect(result.skipped[0].reason).toMatch(/no corner of the shape/);
  });
});

describe('holes and joins over MCP', () => {
  const wall = (sign: number) => {
    const x = sign * 20;
    return [[x, -20, -20], [x, 20, -20], [x, 20, 20], [x, -20, 20]];
  };

  it('insets a face and reports the smaller one it made', () => {
    const l = boxLattice(DEFAULT_UNIT, 200); // 40 mm cube
    const result = insetFaceMm(l, wall(1), 5);
    expect(result.amountMm).toBe(5);
    expect(result.border).toBe(4);
    for (const corner of result.inner) {
      expect(corner[0]).toBe(20);
      expect([Math.abs(corner[1]), Math.abs(corner[2])]).toEqual([15, 15]);
    }
    expect(latticeSummary(l).watertight).toBe(true);
  });

  it('bores a tunnel: inset both walls, then join the smaller faces', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    const east = insetFaceMm(l, wall(1), 10).inner;
    const west = insetFaceMm(l, wall(-1), 10).inner;
    expect(bridgeFacesMm(l, east, west).walls).toBe(4);

    const summary = latticeSummary(l);
    expect(summary.watertight).toBe(true);
    expect(summary.inconsistent).toBe(0);
  });

  it('refuses to join two whole walls, and says what to do instead', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(() => bridgeFacesMm(l, wall(1), wall(-1))).toThrow(/inset each of them first/);
  });

  it('bevels a lone plate towards a circle', () => {
    const l = createLattice(DEFAULT_UNIT);
    const plate = [[-20, -20, 0], [20, -20, 0], [20, 20, 0], [-20, 20, 0]];
    addFacesMm(l, [plate]);
    expect(bevelFaceMm(l, plate, 10).amountMm).toBe(10);
    expect(latticeSummary(l)).toMatchObject({ vertices: 8, faces: 1 });
  });

  it('refuses to bevel a face that is part of a solid', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(() => bevelFaceMm(l, wall(1), 5)).toThrow(/belong to no other face/);
  });

  it('refuses a change smaller than the grid', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(() => insetFaceMm(l, wall(1), 0.04)).toThrow(/less than one grid step/);
  });
});
