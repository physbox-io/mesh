import { describe, it, expect } from 'vitest';
import {
  addFacesMm, removeFacesMm, extrudeMm, findFaceMm, coordFromMm, mmFromCoord,
  describeLattice, latticeSummary, sharpenEdgesMm, insetFaceMm, bevelFaceMm, bridgeFacesMm,
  selectionBoundsMm, dimensionMm, dimensionSelectionMm, bevelEdgesMm, addRingMm, revolveMm,
} from '../src/utils/latticeCommands';
import {
  boxLattice, createLattice, DEFAULT_UNIT, faceCount, findVertex, isWatertight,
  vertexCount, latticeBounds, vertexAt, addFace,
} from '../src/utils/latticeMesh';

const square = (z = 0) => [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]];

describe('millimetres in, millimetres out', () => {
  it('converts both ways on a 0.1 mm grid', () => {
    expect(coordFromMm([1, -2.5, 0.3], DEFAULT_UNIT)).toEqual([10, -25, 3]);
    expect(mmFromCoord([10, -25, 3], DEFAULT_UNIT)).toEqual([1, -2.5, 0.3]);
  });

  /*
   * 6.35 / 0.1 is 63.49999999999999 in binary floating point, and a plain round
   * of that is 63 — a tenth of a millimetre short of a number somebody typed.
   * Halfway cases land just UNDER far more often than just over, so this is the
   * common direction of the error rather than a curiosity.
   */
  it('rounds a half-step up rather than a tenth short', () => {
    expect(coordFromMm([6.35, -6.35, 0.15], DEFAULT_UNIT)).toEqual([64, -63, 2]);
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

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------
//
// The other tools say how far to push something. These say how big it should
// end up, which is the number a part is specified by — and the reason is that
// arriving at 40 mm by pushing 7 mm and then 3 mm more is arithmetic nobody
// should be doing in their head.

/** Every corner of the cage, which is what "select all" amounts to. */
const allCorners = (l: ReturnType<typeof boxLattice>) =>
  Array.from({ length: vertexCount(l) }, (_, v) => v);

/** The whole cage's size in millimetres, per axis. */
const sizeMm = (l: ReturnType<typeof boxLattice>) => {
  const b = latticeBounds(l)!;
  return [0, 1, 2].map((k) => (b.max[k] - b.min[k]) * l.unit * 1000);
};

describe('measuring a selection', () => {
  it('reports the corners it was given, in millimetres', () => {
    const l = boxLattice(DEFAULT_UNIT, 200); // 40 mm across, centred
    const bounds = selectionBoundsMm(l, allCorners(l))!;
    expect(bounds.minMm).toEqual([-20, -20, -20]);
    expect(bounds.maxMm).toEqual([20, 20, 20]);
  });

  it('has nothing to say about nothing', () => {
    expect(selectionBoundsMm(boxLattice(DEFAULT_UNIT, 200), [])).toBeNull();
    expect(selectionBoundsMm(boxLattice(DEFAULT_UNIT, 200), [999])).toBeNull();
  });
});

describe('typing a dimension', () => {
  it('makes the shape the size that was asked for', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(dimensionMm(l, allCorners(l), 'x', 'size', 60)).toBe(true);
    expect(sizeMm(l)[0]).toBeCloseTo(60, 6);
    // And only on the axis it was told about.
    expect(sizeMm(l)[1]).toBeCloseTo(40, 6);
  });

  it('scales about the middle, so the shape stays where it is', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    dimensionMm(l, allCorners(l), 'z', 'size', 10);
    const bounds = selectionBoundsMm(l, allCorners(l))!;
    expect(bounds.minMm[2]).toBeCloseTo(-5, 6);
    expect(bounds.maxMm[2]).toBeCloseTo(5, 6);
  });

  it('moves a selection to where it was told, measured from its middle', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(dimensionMm(l, allCorners(l), 'z', 'position', 100)).toBe(true);
    const bounds = selectionBoundsMm(l, allCorners(l))!;
    expect(bounds.minMm[2]).toBeCloseTo(80, 6);
    expect(bounds.maxMm[2]).toBeCloseTo(120, 6);
    // The shape itself is untouched — a move is a move.
    expect(sizeMm(l)).toEqual([40, 40, 40]);
  });

  it('rounds onto the grid rather than inventing a corner between steps', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    // 0.1 mm grid: 6.35 is not on it, 6.4 is. The cage can hold one and not
    // the other, and it is better to be a tenth out than to be off the grid.
    dimensionMm(l, allCorners(l), 'x', 'size', 6.35);
    expect(sizeMm(l)[0]).toBeCloseTo(6.4, 6);
  });

  it('refuses a size for a selection that is flat on that axis', () => {
    const l = createLattice(DEFAULT_UNIT);
    const plate = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0]];
    addFacesMm(l, [plate]);
    const corners = allCorners(l);
    // The plate lies in Z, so it has no thickness to set — and stretching it
    // by any factor would leave it exactly as flat.
    expect(dimensionMm(l, corners, 'z', 'size', 5)).toBe(false);
    // Its other two dimensions are perfectly ordinary.
    expect(dimensionMm(l, corners, 'x', 'size', 80)).toBe(true);
    expect(sizeMm(l)[0]).toBeCloseTo(80, 6);
  });

  it('refuses a size of nothing, rather than collapsing the shape', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(dimensionMm(l, allCorners(l), 'x', 'size', 0)).toBe(false);
    expect(dimensionMm(l, allCorners(l), 'x', 'size', -10)).toBe(false);
    expect(sizeMm(l)[0]).toBeCloseTo(40, 6);
  });

  it('reports that a number it is already at changed nothing', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    // Not an error — just no edit, so the caller can skip the undo step.
    expect(dimensionMm(l, allCorners(l), 'z', 'position', 0)).toBe(false);
    expect(dimensionMm(l, allCorners(l), 'z', 'position', 0.04)).toBe(false);
  });

  it('sets one face\'s place without dragging the rest of the shape with it', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    const top = l.faces.findIndex((verts) => verts?.every((v) => l.coords[v * 3 + 2] === 200));
    expect(top).toBeGreaterThan(-1);
    expect(dimensionMm(l, l.faces[top]!, 'z', 'position', 50)).toBe(true);
    // The box is now 70 mm tall: its floor stayed at -20 and its lid is at 50.
    const bounds = selectionBoundsMm(l, allCorners(l))!;
    expect(bounds.minMm[2]).toBeCloseTo(-20, 6);
    expect(bounds.maxMm[2]).toBeCloseTo(50, 6);
    expect(isWatertight(l)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chamfer, fillet, circles and revolve, over the millimetre interface
// ---------------------------------------------------------------------------

describe('bevelEdgesMm', () => {
  /** A 10 mm cube on the 1 mm grid, corners on 0 and 10. */
  const cube = () => {
    const l = createLattice(0.001);
    const v = (i: number, j: number, k: number) => vertexAt(l, i * 10, j * 10, k * 10);
    addFace(l, [v(0,0,0), v(0,1,0), v(1,1,0), v(1,0,0)]);
    addFace(l, [v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1)]);
    addFace(l, [v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)]);
    addFace(l, [v(0,1,0), v(0,1,1), v(1,1,1), v(1,1,0)]);
    addFace(l, [v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0)]);
    addFace(l, [v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1)]);
    return l;
  };

  it('chamfers an edge named in millimetres', () => {
    const l = cube();
    const result = bevelEdgesMm(l, [[[0, 0, 10], [10, 0, 10]]], 2);
    expect(result.strips).toBe(1);
    expect(result.radiusMm).toBe(2);
    expect(isWatertight(l)).toBe(true);
  });

  it('takes a whole face border as one edge list', () => {
    const l = cube();
    // The top face's four corners: the rim of a cap, chamfered in one call.
    const result = bevelEdgesMm(l, [[[0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]], 2);
    expect(result.edges).toBe(4);
    expect(result.strips).toBe(4);
    expect(isWatertight(l)).toBe(true);
  });

  it('rounds instead, when asked for a fillet', () => {
    const l = cube();
    bevelEdgesMm(l, [[[0, 0, 10], [10, 0, 10]]], 2, 'fillet');
    // A fillet leaves the strip soft so smoothing rounds it; a chamfer would
    // have creased its two long sides.
    expect(l.creases.size).toBe(0);
  });

  it('says what to do about a radius that will not fit', () => {
    const l = cube();
    expect(() => bevelEdgesMm(l, [[[0, 0, 10], [10, 0, 10]]], 9)).toThrow(/smaller radius/i);
  });

  it('refuses a corner that is not there', () => {
    const l = cube();
    expect(() => bevelEdgesMm(l, [[[0, 0, 10], [3, 3, 3]]], 1)).toThrow(/no corner/i);
  });

  it('leaves the cage alone when it refuses', () => {
    const l = cube();
    const before = faceCount(l);
    expect(() => bevelEdgesMm(l, [[[0, 0, 10], [10, 0, 10]]], 9)).toThrow();
    expect(faceCount(l)).toBe(before);
  });
});

describe('addRingMm', () => {
  it('places a circle and reports corners that can be used again', () => {
    const l = createLattice(0.0001);
    const result = addRingMm(l, [0, 0, 0], 20, 'z');
    expect(result.diameterMm).toBe(20);
    expect(result.corners.length).toBe(result.sides);
    // The corners it reports name the face it just made.
    expect(findFaceMm(l, result.corners)).not.toBe(-1);
  });

  it('draws a regular polygon when told how many sides', () => {
    const l = createLattice(0.0001);
    expect(addRingMm(l, [0, 0, 0], 20, 'z', 6).sides).toBe(6);
  });

  it('refuses a ring too small to have three distinct corners', () => {
    const l = createLattice(0.001);
    expect(() => addRingMm(l, [0, 0, 0], 0.5, 'z', 12)).toThrow();
  });
});

describe('revolveMm', () => {
  it('sweeps a profile that was never drawn', () => {
    const l = createLattice(0.001);
    const result = revolveMm(l, [[20, 0, 0], [20, 0, 30]], 'z');
    expect(result.degrees).toBe(360);
    expect(result.facesAdded).toBeGreaterThan(0);
  });

  it('closes a closed profile into a solid', () => {
    const l = createLattice(0.001);
    revolveMm(l, [[20, 0, -5], [30, 0, -5], [30, 0, 5], [20, 0, 5]], 'z', 360, { segments: 16, closed: true });
    expect(isWatertight(l)).toBe(true);
  });

  it('makes a cone from a profile that touches the axis', () => {
    const l = createLattice(0.001);
    const result = revolveMm(l, [[0, 0, 40], [30, 0, 0]], 'z', 360, { segments: 12 });
    expect(result.facesAdded).toBe(12);
  });

  it('refuses a sweep of nothing', () => {
    const l = createLattice(0.001);
    expect(() => revolveMm(l, [[20, 0, 0], [20, 0, 30]], 'z', 0)).toThrow(/between 1 and 360/);
    expect(() => revolveMm(l, [[20, 0, 0]], 'z')).toThrow(/two or more points/);
  });
});

describe('naming the corners to measure', () => {
  const face = (z: number) => [[-20, -20, z], [20, -20, z], [20, 20, z], [-20, 20, z]];

  it('moves a face named by its corners', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    const result = dimensionSelectionMm(l, face(20), 'z', 'position', 50);
    expect(result.changed).toBe(true);
    const b = latticeBounds(l)!;
    expect(b.max[2] * l.unit * 1000).toBeCloseTo(50, 6);
    expect(b.min[2] * l.unit * 1000).toBeCloseTo(-20, 6);
  });

  /*
   * Refused rather than applied to the corners it did find. A dimension that
   * moves three corners of the four you meant does not fail, it quietly pulls
   * the shape out of square — and the next thing you hear about it is a part
   * that will not sit flat.
   */
  it('refuses when a named corner is not there', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(() => dimensionSelectionMm(l, [[-20, -20, 20], [999, 0, 0]], 'z', 'position', 30))
      .toThrow(/No corner of this shape is at \[999, 0, 0\]/);
    // And nothing moved.
    expect(latticeBounds(l)!.max[2]).toBe(200);
  });

  it('asks for corners rather than guessing when given none', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    expect(() => dimensionSelectionMm(l, [], 'x', 'size', 10)).toThrow(/Give the corners/);
    expect(() => dimensionSelectionMm(l, [[0, 0]], 'x', 'size', 10)).toThrow(/\[x, y, z\] point/);
  });

  it('reads the corners back where they ended up', () => {
    const l = boxLattice(DEFAULT_UNIT, 200);
    const result = dimensionSelectionMm(l, face(20), 'z', 'position', 30);
    expect(result.corners.every(c => c[2] === 30)).toBe(true);
  });
});

describe('faces with more than four corners', () => {
  it('takes an eight-cornered profile, which is what a T is', () => {
    const l = createLattice(0.001);
    const tee = [
      [-15, 5, 0], [-5, 5, 0], [-5, -15, 0], [5, -15, 0],
      [5, 5, 0], [15, 5, 0], [15, 15, 0], [-15, 15, 0],
    ];
    const result = addFacesMm(l, [tee]);
    expect(result.added).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(l.faces[0]!.length).toBe(8);
    // And it can be named again by its corners, so it can be extruded.
    expect(findFaceMm(l, tee)).toBe(0);
  });

  it('still refuses fewer than three', () => {
    const l = createLattice(0.001);
    expect(addFacesMm(l, [[[0, 0, 0], [10, 0, 0]]]).added).toBe(0);
  });
})
