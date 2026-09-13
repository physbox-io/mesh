import { describe, it, expect } from 'vitest';
import {
  createLattice, vertexAt, findVertex, addFace, faceCount, isWatertight,
  inconsistentFaces, signedVolume, bevelEdges, isCrease, setCrease,
  latticeBounds, type Lattice,
} from '../src/utils/latticeMesh';

/** A cube `size` steps on a side, corners on 0 and `size`, wound outwards. */
function cube(size = 10, unit = 0.001): Lattice {
  const l = createLattice(unit);
  const v = (i: number, j: number, k: number) => vertexAt(l, i * size, j * size, k * size);
  addFace(l, [v(0,0,0), v(0,1,0), v(1,1,0), v(1,0,0)]); // -z
  addFace(l, [v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1)]); // +z
  addFace(l, [v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)]); // -y
  addFace(l, [v(0,1,0), v(0,1,1), v(1,1,1), v(1,1,0)]); // +y
  addFace(l, [v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0)]); // -x
  addFace(l, [v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1)]); // +x
  return l;
}

const corner = (l: Lattice, i: number, j: number, k: number) => findVertex(l, i, j, k);

/** Every edge of a `size` cube, as vertex pairs. */
function cubeEdges(l: Lattice, size = 10): [number, number][] {
  const out: [number, number][] = [];
  const at = (i: number, j: number, k: number) => corner(l, i * size, j * size, k * size);
  for (let axis = 0; axis < 3; axis++) {
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const low = [0, 0, 0];
        const high = [0, 0, 0];
        const others = [0, 1, 2].filter((x) => x !== axis);
        low[others[0]] = a; high[others[0]] = a;
        low[others[1]] = b; high[others[1]] = b;
        low[axis] = 0; high[axis] = 1;
        out.push([at(low[0], low[1], low[2]), at(high[0], high[1], high[2])]);
      }
    }
  }
  return out;
}

describe('beveling one edge of a solid', () => {
  it('stitches the tear instead of refusing, and stays watertight', () => {
    const l = cube();
    const a = corner(l, 0, 0, 10);
    const b = corner(l, 10, 0, 10);
    const result = bevelEdges(l, [[a, b]], 2);
    expect(result).not.toBeNull();
    expect(result!.strips.length).toBe(1);
    expect(isWatertight(l)).toBe(true);
    expect(inconsistentFaces(l)).toBe(0);
  });

  it('turns the two faces that merely touch the edge into pentagons', () => {
    const l = cube();
    const a = corner(l, 0, 0, 10);
    const b = corner(l, 10, 0, 10);
    bevelEdges(l, [[a, b]], 2);
    const sizes = l.faces.filter(Boolean).map((f) => f!.length).sort();
    // Six faces became: two quads pulled back, two pentagons on the ends, two
    // untouched quads, and the new strip.
    expect(sizes).toEqual([4, 4, 4, 4, 4, 5, 5]);
    expect(faceCount(l)).toBe(7);
  });

  it('takes material away rather than adding it', () => {
    const before = cube();
    const l = cube();
    bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 2);
    expect(Math.abs(signedVolume(l))).toBeLessThan(Math.abs(signedVolume(before)));
  });

  it('cuts exactly as deep as it was asked to', () => {
    const l = cube();
    bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 3);
    // The +z face has retreated from y=0 to y=3, and the -y face from z=10 to 7.
    expect(findVertex(l, 0, 3, 10)).not.toBe(-1);
    expect(findVertex(l, 0, 0, 7)).not.toBe(-1);
    expect(findVertex(l, 0, 0, 10)).toBe(-1);
  });

  it('leaves the overall size alone — a bevel cuts a corner, it does not shrink', () => {
    const l = cube();
    bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 2);
    const bounds = latticeBounds(l)!;
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([10, 10, 10]);
  });
});

describe('beveling several edges', () => {
  it('handles two beveled edges meeting at a corner', () => {
    const l = cube();
    const top = corner(l, 0, 0, 10);
    bevelEdges(l, [[top, corner(l, 10, 0, 10)], [top, corner(l, 0, 10, 10)]], 2);
    expect(isWatertight(l)).toBe(true);
    expect(inconsistentFaces(l)).toBe(0);
  });

  it('closes the corner where three beveled edges meet', () => {
    const l = cube();
    const v = corner(l, 0, 0, 10);
    const result = bevelEdges(l, [
      [v, corner(l, 10, 0, 10)],
      [v, corner(l, 0, 10, 10)],
      [v, corner(l, 0, 0, 0)],
    ], 2);
    expect(result).not.toBeNull();
    expect(isWatertight(l)).toBe(true);
    expect(inconsistentFaces(l)).toBe(0);
  });

  it('bevels every edge of a cube at once', () => {
    const l = cube(10);
    const result = bevelEdges(l, cubeEdges(l), 2);
    expect(result).not.toBeNull();
    expect(result!.strips.length).toBe(12);
    expect(isWatertight(l)).toBe(true);
    expect(inconsistentFaces(l)).toBe(0);
    // Six faces, twelve strips and eight corner patches: the classic result.
    expect(faceCount(l)).toBe(26);
    const sizes = l.faces.filter(Boolean).map((f) => f!.length);
    // The original faces stay SQUARES — they retreat from all four of their own
    // edges rather than getting notched at each corner.
    expect(sizes.filter((n) => n === 4).length).toBe(18);
    expect(sizes.filter((n) => n === 3).length).toBe(8);
  });

  it('cuts the same shape whichever order the edges are given in', () => {
    const forwards = cube(10);
    const backwards = cube(10);
    bevelEdges(forwards, cubeEdges(forwards), 2);
    bevelEdges(backwards, [...cubeEdges(backwards)].reverse(), 2);
    expect(faceCount(backwards)).toBe(faceCount(forwards));
    expect(signedVolume(backwards)).toBeCloseTo(signedVolume(forwards), 12);
  });

  it('takes exactly the wedge off that the arithmetic says', () => {
    const l = cube(10);
    bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 2);
    // A 10 mm cube at 1 mm per step, chamfered 2 mm along one edge: a wedge of
    // triangular section 2x2/2, the full 10 mm of the edge, and nothing else.
    const mm3 = (v: number) => v / 0.001 ** 3;
    expect(mm3(Math.abs(signedVolume(l)))).toBeCloseTo(1000 - ((2 * 2) / 2) * 10, 6);
  });

  it('pulls the corner in diagonally where two chamfers meet', () => {
    const l = cube(10);
    bevelEdges(l, cubeEdges(l), 2);
    // The top face stays a square, inset by the chamfer on all four sides —
    // which is what a beveled cube looks like, and what a corner notched twice
    // instead of cut once would have got wrong.
    expect(findVertex(l, 2, 2, 10)).not.toBe(-1);
    expect(findVertex(l, 2, 0, 8)).not.toBe(-1);
  });
});

describe('what a bevel refuses', () => {
  it('refuses to cut deeper than half the edge it is cutting from', () => {
    const l = cube(10);
    expect(bevelEdges(l, cubeEdges(l), 6)).toBeNull();
    // And left the cage exactly as it found it.
    expect(faceCount(l)).toBe(6);
  });

  it('refuses an edge no face runs along', () => {
    const l = cube();
    expect(bevelEdges(l, [[corner(l, 0, 0, 0), corner(l, 10, 10, 10)]], 1)).toBeNull();
  });

  it('refuses nothing to do', () => {
    const l = cube();
    expect(bevelEdges(l, [], 2)).toBeNull();
    expect(bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 0)).toBeNull();
  });

  it('refuses an edge with only one face on it', () => {
    const l = createLattice(0.001);
    const v = (i: number, j: number) => vertexAt(l, i, j, 0);
    addFace(l, [v(0, 0), v(10, 0), v(10, 10), v(0, 10)]);
    expect(bevelEdges(l, [[v(0, 0), v(10, 0)]], 2)).toBeNull();
  });
});

describe('chamfer and fillet', () => {
  it('creases the strip so a chamfer stays flat under smoothing', () => {
    const l = cube();
    const result = bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 2, 'chamfer')!;
    const strip = l.faces[result.strips[0]]!;
    const creased = strip.filter((v, i) => isCrease(l, v, strip[(i + 1) % strip.length])).length;
    expect(creased).toBe(2);
  });

  it('leaves a fillet soft, so smoothing rounds it', () => {
    const l = cube();
    const result = bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 2, 'fillet')!;
    const strip = l.faces[result.strips[0]]!;
    const creased = strip.filter((v, i) => isCrease(l, v, strip[(i + 1) % strip.length])).length;
    expect(creased).toBe(0);
  });

  it('keeps a crease that was on a neighbouring edge', () => {
    const l = cube();
    // The bottom-front edge, nowhere near the one being cut.
    const keep: [number, number] = [corner(l, 0, 0, 0), corner(l, 10, 0, 0)];
    setCrease(l, keep[0], keep[1], true);
    bevelEdges(l, [[corner(l, 0, 0, 10), corner(l, 10, 0, 10)]], 2);
    expect(isCrease(l, findVertex(l, 0, 0, 0), findVertex(l, 10, 0, 0))).toBe(true);
  });

  it('carries a crease across an edge whose end moved', () => {
    const l = cube();
    // The vertical front-left edge: its top end is an endpoint of the bevel.
    const a = corner(l, 0, 0, 0);
    const b = corner(l, 0, 0, 10);
    setCrease(l, a, b, true);
    bevelEdges(l, [[b, corner(l, 10, 0, 10)]], 2);
    // Its top end is now two vertices, one in each of the faces that met there,
    // and the crease follows both.
    expect(isCrease(l, findVertex(l, 0, 0, 0), findVertex(l, 0, 0, 8))).toBe(true);
    expect(isCrease(l, findVertex(l, 0, 0, 0), findVertex(l, 0, 2, 0))).toBe(false);
  });

  it('drops the crease that was on the edge it cut away', () => {
    const l = cube();
    const a = corner(l, 0, 0, 10);
    const b = corner(l, 10, 0, 10);
    setCrease(l, a, b, true);
    bevelEdges(l, [[a, b]], 2);
    expect([...l.creases].length).toBe(2); // the chamfer's own two, and nothing else
  });
});
