import { describe, it, expect } from 'vitest';
import { latticeBoolean, mergeCoplanarFaces, dissolveCollinearCorners } from '../src/utils/latticeBoolean';
import {
  createLattice, vertexAt, addFace, extrudeFace, isWatertight, inconsistentFaces,
  signedVolume, faceCount, latticeStats, latticeBounds, facesAlong, coordOf,
  setCrease, isCrease, findVertex, type Lattice,
} from '../src/utils/latticeMesh';

const UNIT = 0.001; // 1 mm per step, so grid steps read as millimetres

/** A closed prism from a profile on z = 0 — what the Place + Extrude tools make. */
function prism(profile: [number, number][], height: number, at: [number, number, number] = [0, 0, 0]): Lattice {
  const l = createLattice(UNIT);
  const face = addFace(l, profile.map(([i, j]) => vertexAt(l, i + at[0], j + at[1], at[2])));
  extrudeFace(l, face, height);
  return l;
}

const box = (w: number, d: number, at: [number, number, number] = [0, 0, 0], h = 10) =>
  prism([[0, 0], [w, 0], [w, d], [0, d]], h, at);

/** Volume in cubic millimetres, positive for a correctly wound solid. */
const mm3 = (l: Lattice) => signedVolume(l) / UNIT ** 3;

/** Edges with anything other than exactly two faces on them. */
function badEdges(l: Lattice): number {
  let bad = 0;
  for (let f = 0; f < l.faces.length; f++) {
    const verts = l.faces[f];
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      if (facesAlong(l, verts[i], verts[(i + 1) % verts.length]).length !== 2) bad++;
    }
  }
  return bad;
}

/** Asserts the cage is a well-formed solid, whatever shape it came out. */
function expectSolid(l: Lattice) {
  expect(isWatertight(l)).toBe(true);
  expect(inconsistentFaces(l)).toBe(0);
  expect(badEdges(l)).toBe(0);
  expect(mm3(l)).toBeGreaterThan(0);
}

describe('union', () => {
  it('joins two overlapping boxes into one solid, not two', () => {
    const a = box(20, 20);
    const b = box(20, 20, [10, 0, 0]);
    const out = latticeBoolean(a, b, 'union')!;
    expect(out).not.toBeNull();
    expectSolid(out);
    // 20x20x10 twice, less the 10x20x10 they share.
    expect(mm3(out)).toBeCloseTo(4000 + 4000 - 2000, 6);
    expect(latticeStats(out).parts).toBe(1);
  });

  it('deletes the wall where two boxes are butted together', () => {
    const a = box(20, 20);
    const b = box(20, 20, [20, 0, 0]);
    const out = latticeBoolean(a, b, 'union')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(8000, 6);
    // No corner survives in the middle of the joined slab: the shared wall and
    // its four corners are gone, which is the whole complaint.
    expect(findVertex(out, 20, 0, 0)).toBe(-1);
    expect(findVertex(out, 20, 20, 10)).toBe(-1);
    // One box's worth of faces, because the result IS one box.
    expect(faceCount(out)).toBe(6);
  });

  it('leaves two separate solids alone', () => {
    const a = box(20, 20);
    const b = box(20, 20, [60, 0, 0]);
    const out = latticeBoolean(a, b, 'union')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(8000, 6);
    expect(latticeStats(out).parts).toBe(2);
  });

  it('keeps a face that neither solid cut as the quad it was drawn as', () => {
    const a = box(20, 20);
    const b = box(20, 20, [10, 0, 0]);
    const out = latticeBoolean(a, b, 'union')!;
    // A triangle-soup kernel would have handed back nothing but triangles, and
    // Catmull-Clark puts a pole at every triangle corner.
    expect(latticeStats(out).quads).toBeGreaterThan(0);
    expect(latticeStats(out).tris).toBe(0);
  });

  it('does the box and the T from the report', () => {
    const tee: [number, number][] = [
      [0, 30], [30, 30], [30, 20], [20, 20], [20, 0], [10, 0], [10, 20], [0, 20],
    ];
    const a = box(20, 30);
    const b = prism(tee, 10, [10, 0, 0]);
    const out = latticeBoolean(a, b, 'union')!;
    expectSolid(out);
    expect(latticeStats(out).parts).toBe(1);
    // Nothing of the T is left standing inside the box.
    const inside = out.faces.filter((verts) => verts && verts.every((v) => {
      const [i, j, k] = coordOf(out, v);
      return i > 10 && i < 20 && j > 0 && j < 30 && k > 0 && k < 10;
    }));
    expect(inside.length).toBe(0);
  });
});

describe('difference', () => {
  it('takes the overlap out of the first solid', () => {
    const a = box(20, 20);
    const b = box(20, 20, [10, 0, 0]);
    const out = latticeBoolean(a, b, 'difference')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(4000 - 2000, 6);
    expect(latticeBounds(out)!.max[0]).toBe(10);
  });

  it('bores a hole right through when the cutter is longer', () => {
    const plate = box(40, 40, [0, 0, 0], 10);
    const bore = box(10, 10, [15, 15, -5], 20);
    const out = latticeBoolean(plate, bore, 'difference')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(40 * 40 * 10 - 10 * 10 * 10, 6);
    // A through hole has an inner wall: more faces than the plate started with.
    expect(faceCount(out)).toBeGreaterThan(6);
  });

  it('gives nothing back when the cutter swallows the part', () => {
    const a = box(10, 10);
    const b = box(40, 40, [-10, -10, -10], 40);
    expect(latticeBoolean(a, b, 'difference')).toBeNull();
  });

  it('leaves the part alone when the cutter misses it', () => {
    const a = box(20, 20);
    const b = box(20, 20, [60, 0, 0]);
    const out = latticeBoolean(a, b, 'difference')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(4000, 6);
  });
});

describe('intersection', () => {
  it('keeps only what both solids cover', () => {
    const a = box(20, 20);
    const b = box(20, 20, [10, 0, 0]);
    const out = latticeBoolean(a, b, 'intersection')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(2000, 6);
    expect(latticeBounds(out)).toEqual({ min: [10, 0, 0], max: [20, 20, 10] });
  });

  it('gives nothing back when they do not meet', () => {
    const a = box(20, 20);
    const b = box(20, 20, [60, 0, 0]);
    expect(latticeBoolean(a, b, 'intersection')).toBeNull();
  });

  it('gives the whole of one when it sits inside the other', () => {
    const outer = box(40, 40, [0, 0, 0], 40);
    const inner = box(10, 10, [10, 10, 10], 10);
    const out = latticeBoolean(outer, inner, 'intersection')!;
    expectSolid(out);
    expect(mm3(out)).toBeCloseTo(1000, 6);
  });
});

describe('what it refuses', () => {
  it('refuses an open cage, rather than guessing which side is inside', () => {
    const open = createLattice(UNIT);
    addFace(open, [
      vertexAt(open, 0, 0, 0), vertexAt(open, 10, 0, 0),
      vertexAt(open, 10, 10, 0), vertexAt(open, 0, 10, 0),
    ]);
    expect(isWatertight(open)).toBe(false);
    expect(latticeBoolean(open, box(20, 20), 'union')).toBeNull();
    expect(latticeBoolean(box(20, 20), open, 'union')).toBeNull();
  });

  it('refuses an empty cage', () => {
    expect(latticeBoolean(createLattice(UNIT), box(20, 20), 'union')).toBeNull();
  });
});

describe('creases', () => {
  it('carries a sharp edge through, including the pieces a cut left of it', () => {
    const a = box(20, 20);
    // The whole top rim of the first box, marked sharp.
    const rim: [number, number, number][] = [[0, 0, 10], [20, 0, 10], [20, 20, 10], [0, 20, 10]];
    for (let i = 0; i < rim.length; i++) {
      const p = findVertex(a, ...rim[i]);
      const q = findVertex(a, ...rim[(i + 1) % rim.length]);
      setCrease(a, p, q, true);
    }
    const b = box(20, 20, [10, 0, 0]);
    const out = latticeBoolean(a, b, 'union')!;
    const at = (i: number, j: number, k: number) => findVertex(out, i, j, k);
    // The union runs from x=0 to x=30 and only the first box's rim was sharp,
    // so the corner at x=20 has to survive the tidy-up: it is what keeps the
    // sharp half sharp and the half that came from the other box soft.
    expect(at(20, 0, 10)).not.toBe(-1);
    expect(isCrease(out, at(0, 0, 10), at(20, 0, 10))).toBe(true);
    expect(isCrease(out, at(20, 0, 10), at(30, 0, 10))).toBe(false);
    // The side the cut never reached is sharp end to end, as it was drawn.
    expect(isCrease(out, at(0, 20, 10), at(0, 0, 10))).toBe(true);
  });

  it('does not run a sharp edge and a soft one together', () => {
    const a = box(20, 20);
    const front = [findVertex(a, 0, 0, 10), findVertex(a, 20, 0, 10)] as const;
    setCrease(a, front[0], front[1], true);
    const out = latticeBoolean(a, box(20, 20, [20, 0, 0]), 'union')!;
    // Butted end to end, the two front-top edges are collinear and would have
    // been dissolved into one. One of them is sharp, so the corner between them
    // stays — as a collinear corner on the merged face's boundary, which is the
    // only thing that can hold a crease that stops halfway along a straight run.
    const at = (i: number, j: number, k: number) => findVertex(out, i, j, k);
    expect(at(20, 0, 10)).not.toBe(-1);
    expect(isCrease(out, at(0, 0, 10), at(20, 0, 10))).toBe(true);
    expect(isCrease(out, at(20, 0, 10), at(40, 0, 10))).toBe(false);
    // And the seam itself is still gone: one box's worth of faces.
    expect(faceCount(out)).toBe(6);
    expect(mm3(out)).toBeCloseTo(8000, 6);
  });
});

describe('shapes that are not axis-aligned', () => {
  it('handles a sloped solid without falling apart', () => {
    // A wedge: the sloping face is the case where an intersection can land off
    // the grid and has to be rounded onto it.
    const wedge = createLattice(UNIT);
    const v = (i: number, j: number, k: number) => vertexAt(wedge, i, j, k);
    addFace(wedge, [v(0, 0, 0), v(0, 20, 0), v(20, 20, 0), v(20, 0, 0)]);
    addFace(wedge, [v(0, 0, 0), v(20, 0, 0), v(0, 0, 20)]);
    addFace(wedge, [v(0, 20, 0), v(0, 20, 20), v(20, 20, 0)]);
    addFace(wedge, [v(0, 0, 0), v(0, 0, 20), v(0, 20, 20), v(0, 20, 0)]);
    addFace(wedge, [v(20, 0, 0), v(20, 20, 0), v(0, 20, 20), v(0, 0, 20)]);
    expect(isWatertight(wedge)).toBe(true);

    const cutter = box(30, 30, [-5, -5, -5], 12);
    const out = latticeBoolean(wedge, cutter, 'intersection')!;
    expectSolid(out);
    // The wedge below z = 7: less than the whole wedge, more than nothing.
    expect(mm3(out)).toBeGreaterThan(0);
    expect(mm3(out)).toBeLessThan(20 * 20 * 20 / 2);
  });
});

describe('the seam a boolean really leaves', () => {
  /**
   * The cage read back out of the app after combining a drawn square and T —
   * two coplanar faces at z = 20 meeting along a run of TWO edges, which the
   * merge used to refuse because it only ever joined faces sharing exactly one.
   * That refusal is what left corners standing in the middle of a flat face.
   */
  function reported(): Lattice {
    const l = createLattice(UNIT);
    const v = (i: number, j: number, k: number) => vertexAt(l, Math.round(i * 10), j * 10, k * 10);
    const F = [
      [[40,30,20],[50,30,20],[50,30,40],[40,30,40]],
      [[40,10,20],[40,30,20],[40,30,40],[40,10,40]],
      [[50,30,20],[50,40,20],[50,40,40],[50,30,40]],
      [[30,30,20],[30,10,20],[0.1,10,20],[0.1,30,20]],
      [[50,40,20],[50,30,20],[40,30,20],[40,10,20],[30,10,20],[30,30,20],[0.1,30,20],[0.1,40,20]],
      [[0.1,30,20],[0.1,10,20],[0.1,10,40],[0.1,40,40],[0.1,40,20]],
      [[0.1,10,40],[0.1,10,20],[30,10,20],[40,10,20],[40,10,40],[30.1,10,40]],
      [[20,30,40],[20,40,40],[0.1,40,40],[0.1,10,40],[30.1,10,40],[30.1,30,40]],
      [[0.1,40,20],[0.1,40,40],[20,40,40],[50,40,40],[50,40,20]],
      [[20,40,40],[20,30,40],[30.1,30,40],[30.1,10,40],[40,10,40],[40,30,40],[50,30,40],[50,40,40]],
    ];
    for (const face of F) addFace(l, face.map(([i, j, k]) => v(i, j, k)));
    return l;
  }

  it('starts out watertight, with a corner sitting in the middle of a flat face', () => {
    const l = reported();
    expect(isWatertight(l)).toBe(true);
    // (30, 30, 20) belongs to two faces and to nothing else: it is not a corner
    // of the solid, it is a leftover of the cut.
    const stranded = findVertex(l, 300, 300, 200);
    expect(stranded).not.toBe(-1);
    expect(l.vertexFaces.get(stranded)!.size).toBe(2);
  });

  it('tidies it away, and the flat face becomes one face', () => {
    const l = reported();
    const before = faceCount(l);
    mergeCoplanarFaces(l);
    dissolveCollinearCorners(l);
    expect(faceCount(l)).toBeLessThan(before);
    expect(findVertex(l, 300, 300, 200)).toBe(-1);
    // No corner is left with fewer than three faces on it — below that it is
    // not holding anything together.
    for (const [, users] of l.vertexFaces) expect(users.size).toBeGreaterThanOrEqual(3);
    expect(isWatertight(l)).toBe(true);
    expect(inconsistentFaces(l)).toBe(0);
  });

  it('keeps the shape while it tidies', () => {
    const l = reported();
    const was = signedVolume(l);
    mergeCoplanarFaces(l);
    dissolveCollinearCorners(l);
    expect(signedVolume(l)).toBeCloseTo(was, 12);
    expect(latticeBounds(l)).toEqual({ min: [1, 100, 200], max: [500, 400, 400] });
  });
});
