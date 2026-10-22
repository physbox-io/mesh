import { describe, expect, it } from 'vitest';
import { boxLattice, vertexAt, addFace, extrudeFace, coordOf, latticeStats, setCrease, findVertex, isCrease } from '../src/utils/latticeMesh';
import { hostFaceOf, splitHostAround, splitHostByChord } from '../src/utils/latticeSketch';

const top = (l: ReturnType<typeof boxLattice>) => l.faces.findIndex((f) => f && f.every((v) => coordOf(l, v)[2] === 200));

describe('drawing on a face', () => {
  it('finds the face a coplanar inner polygon lies in', () => {
    const l = boxLattice(0.0001, 200);
    const inner = [[-100, -100], [100, -100], [100, 100], [-100, 100]].map(([x, y]) => vertexAt(l, x, y, 200));
    expect(hostFaceOf(l, inner)).toBe(top(l));
    // Off the plane: nobody's.
    const lifted = [[-100, -100], [100, -100], [100, 100]].map(([x, y]) => vertexAt(l, x, y, 250));
    expect(hostFaceOf(l, lifted)).toBeNull();
  });

  it('an island cuts the host into a ring of two pieces, and extruding the island leaves the ring alone', () => {
    const l = boxLattice(0.0001, 200);
    const inner = [[-100, -100], [100, -100], [100, 100], [-100, 100]].map(([x, y]) => vertexAt(l, x, y, 200));
    const result = splitHostAround(l, inner);
    expect(result).not.toBeNull();
    expect(result!.pieces.length).toBe(2);
    const island = addFace(l, result!.inner);
    expect(island).not.toBe(-1);
    expect(latticeStats(l).faces).toBe(6 - 1 + 2 + 1);
    const before = result!.pieces.map((f) => l.faces[f]!.map((v) => coordOf(l, v)));
    expect(extrudeFace(l, island, 50)).not.toBeNull();
    const after = result!.pieces.map((f) => l.faces[f]!.map((v) => coordOf(l, v)));
    expect(after).toEqual(before);
  });

  it('a bite sharing an edge with the host leaves one host piece around it', () => {
    const l = boxLattice(0.0001, 200);
    const t = top(l);
    const a = findVertex(l, -200, -200, 200);
    const b = findVertex(l, 200, -200, 200);
    const p = vertexAt(l, 200, 0, 200);
    const q = vertexAt(l, -200, 0, 200);
    const result = splitHostAround(l, [a, b, p, q]);
    expect(result).not.toBeNull();
    expect(result!.host).toBe(t);
    expect(result!.pieces.length).toBe(1);
    const piece = l.faces[result!.pieces[0]]!;
    expect(piece.length).toBe(4);
    expect(new Set(piece)).toEqual(new Set([q, p, findVertex(l, 200, 200, 200), findVertex(l, -200, 200, 200)]));
    addFace(l, result!.inner);
    expect(latticeStats(l).faces).toBe(7);
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('keeps the host\'s creases on the piece that still has the edge', () => {
    const l = boxLattice(0.0001, 200);
    const c = findVertex(l, 200, 200, 200);
    const d = findVertex(l, -200, 200, 200);
    setCrease(l, c, d, true);
    const inner = [[-100, -100], [100, -100], [100, 100], [-100, 100]].map(([x, y]) => vertexAt(l, x, y, 200));
    splitHostAround(l, inner);
    expect(isCrease(l, c, d)).toBe(true);
  });

  it('leaves a face that is the host itself alone', () => {
    const l = boxLattice(0.0001, 200);
    expect(splitHostAround(l, [...l.faces[top(l)]!])).toBeNull();
  });

  it('a strip across the middle of a face splits the host into two flanking pieces', () => {
    const l = boxLattice(0.0001, 200);
    const strip = [[-50, -200], [50, -200], [50, 200], [-50, 200]].map(([x, y]) => vertexAt(l, x, y, 200));
    const result = splitHostAround(l, strip);
    expect(result).not.toBeNull();
    expect(result!.pieces.length).toBe(2);
    const added = addFace(l, result!.inner);
    expect(added).not.toBe(-1);
    expect(latticeStats(l).faces).toBe(8);
    expect(latticeStats(l).watertight).toBe(true);
    expect(extrudeFace(l, added, 50)).not.toBeNull();
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('an inscribed diamond touching all four edges cuts the host into four corner triangles', () => {
    const l = boxLattice(0.0001, 200);
    const diamond = [[0, -200], [200, 0], [0, 200], [-200, 0]].map(([x, y]) => vertexAt(l, x, y, 200));
    const result = splitHostAround(l, diamond);
    expect(result).not.toBeNull();
    expect(result!.pieces.length).toBe(4);
    addFace(l, result!.inner);
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('a polygon touching the host boundary at a single corner splits the pinched ring into two pieces', () => {
    const l = boxLattice(0.0001, 200);
    const singleTouch = [[-200, -200], [0, -100], [0, 0], [-100, 0]].map(([x, y]) => vertexAt(l, x, y, 200));
    const result = splitHostAround(l, singleTouch);
    expect(result).not.toBeNull();
    expect(result!.pieces.length).toBe(2);
    addFace(l, result!.inner);
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('splits a face in two along a 2-point chord from edge to edge or corner to corner', () => {
    const l = boxLattice(0.0001, 200);
    const a = vertexAt(l, -200, 0, 200);
    const b = vertexAt(l, 200, 0, 200);
    const split = splitHostByChord(l, [a, b]);
    expect(split).not.toBeNull();
    expect(split!.pieces.length).toBe(2);
    expect(latticeStats(l).faces).toBe(7);
    expect(latticeStats(l).watertight).toBe(true);
    expect(extrudeFace(l, split!.pieces[0], 50)).not.toBeNull();
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('splits a corner off a face along a 3-point L-chord between adjacent edges', () => {
    const l = boxLattice(0.0001, 200);
    const chain = [[0, -200], [0, 0], [-200, 0]].map(([x, y]) => vertexAt(l, x, y, 200));
    const split = splitHostByChord(l, chain);
    expect(split).not.toBeNull();
    expect(split!.pieces.length).toBe(2);
    expect(latticeStats(l).watertight).toBe(true);
  });
});

describe('fuseFlushFaces', () => {
  it('two boxes touching over a whole face become one solid with no wall between', async () => {
    const { mergeLattice } = await import('../src/utils/latticeMesh');
    const { fuseFlushFaces } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    mergeLattice(l, boxLattice(0.0001, 200), ([i, j, k]) => [i + 400, j, k]);
    expect(latticeStats(l).faces).toBe(12);
    expect(fuseFlushFaces(l)).toBe(1);
    expect(latticeStats(l).faces).toBe(10);
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('a smaller box flush against a bigger face cuts the face around it', async () => {
    const { mergeLattice } = await import('../src/utils/latticeMesh');
    const { fuseFlushFaces } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    // Half-size box, its -x face flush on the big box's +x face, well inside it.
    mergeLattice(l, boxLattice(0.0001, 100), ([i, j, k]) => [i + 300, j, k]);
    expect(latticeStats(l).faces).toBe(12);
    expect(fuseFlushFaces(l)).toBe(1);
    // The big face becomes two ring pieces (+1) and the small box's flush face goes (-1).
    expect(latticeStats(l).faces).toBe(12);
    expect(latticeStats(l).watertight).toBe(true);
  });

  it('is what an extrusion pushed into the far side of its own body gets', async () => {
    const { mergeLattice } = await import('../src/utils/latticeMesh');
    const { fuseFlushFaces } = await import('../src/utils/latticeSketch');
    // A U: base plus two arms; extrude the left arm's inner face across the gap
    // until it lands flush on the right arm's inner face.
    const l = boxLattice(0.0001, 100);                                   // left arm  x∈[-100,100]
    mergeLattice(l, boxLattice(0.0001, 100), ([i, j, k]) => [i + 600, j, k]); // right arm x∈[500,700]
    const left = l.faces.findIndex((f) => f && f.every((v) => coordOf(l, v)[0] === 100));
    expect(extrudeFace(l, left, 400)).not.toBeNull();                    // cap now at x=500
    // Not watertight yet: the cap's edges carry four faces where it landed.
    expect(latticeStats(l).watertight).toBe(false);
    expect(fuseFlushFaces(l)).toBe(1);
    expect(latticeStats(l).watertight).toBe(true);
    // No face left in the x=500 plane: the arms are one piece now.
    expect(l.faces.some((f) => f && f.every((v) => coordOf(l, v)[0] === 500))).toBe(false);
  });

  it('leaves faces that only partly overlap alone', async () => {
    const { mergeLattice } = await import('../src/utils/latticeMesh');
    const { fuseFlushFaces } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    mergeLattice(l, boxLattice(0.0001, 200), ([i, j, k]) => [i + 400, j + 200, k]);
    expect(fuseFlushFaces(l)).toBe(0);
    expect(latticeStats(l).faces).toBe(12);
  });
});

describe('pushing a part through another', () => {
  it('a plain extrude into empty space is left as it is', async () => {
    const { resolveExtrusion } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    const right = l.faces.findIndex((f) => f && f.every((v) => coordOf(l, v)[0] === 200));
    expect(resolveExtrusion(l, right, 300)).toBeNull();
  });

  it('an extrude that runs into another piece becomes the union', async () => {
    const { mergeLattice, latticeBounds } = await import('../src/utils/latticeMesh');
    const { resolveExtrusion } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    mergeLattice(l, boxLattice(0.0001, 200), ([i, j, k]) => [i + 500, j, k]); // x 300..700
    const right = l.faces.findIndex((f) => f && f.every((v) => coordOf(l, v)[0] === 200));
    const result = resolveExtrusion(l, right, 300); // cap at x=500, inside the second box
    expect(result).not.toBeNull();
    expect(latticeStats(result!).watertight).toBe(true);
    expect(latticeStats(result!).parts).toBe(1);
    expect(latticeBounds(result!)).toEqual({ min: [-200, -200, -200], max: [700, 200, 200] });
    // No face left anywhere strictly inside: the cap at x=500 is gone.
    expect(result!.faces.some((f) => f && f.every((v) => coordOf(result!, v)[0] === 500))).toBe(false);
  });

  it('a face pushed in through the far side leaves a hole', async () => {
    const { resolveExtrusion, splitHostAround } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    const inner = [[-100, -100], [100, -100], [100, 100], [-100, 100]].map(([y, z]) => vertexAt(l, 200, y, z));
    const split = splitHostAround(l, inner);
    const island = addFace(l, split!.inner);
    const result = resolveExtrusion(l, island, -500); // out through x=-200
    expect(result).not.toBeNull();
    expect(latticeStats(result!).watertight).toBe(true);
    // A tunnel: the far face is pierced, so there is more than one face in the x=-200 plane, and no cap at x=-300.
    const atMinus200 = result!.faces.filter((f) => f && f.every((v) => coordOf(result!, v)[0] === -200)).length;
    expect(atMinus200).toBeGreaterThan(1);
    expect(result!.faces.some((f) => f && f.every((v) => coordOf(result!, v)[0] === -300))).toBe(false);
  });

  it('resolveExtrusion preserves unrelated coplanar face splits on the body', async () => {
    const { resolveExtrusion } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    // Split the top face (z=200) along y=0 into two halves.
    splitHostByChord(l, [vertexAt(l, -200, 0, 200), vertexAt(l, 200, 0, 200)]);
    // Also split the front half along x=0, then push one top-front quadrant down by 100.
    const frontHalf = l.faces.findIndex((f) => f && f.every((v) => coordOf(l, v)[2] === 200 && coordOf(l, v)[1] <= 0));
    expect(frontHalf).not.toBe(-1);
    splitHostByChord(l, [vertexAt(l, 0, -200, 200), vertexAt(l, 0, 0, 200)]);
    const quadToPush = l.faces.findIndex((f) => f && f.every((v) => coordOf(l, v)[2] === 200 && coordOf(l, v)[0] <= 0 && coordOf(l, v)[1] <= 0));
    const result = resolveExtrusion(l, quadToPush, -100)!;
    expect(result).not.toBeNull();
    expect(latticeStats(result).watertight).toBe(true);
    // The remaining two quadrants at z=200 stay two separate faces rather than being merged into an L-gon.
    const topFaces = result.faces.filter((f) => f && f.every((v) => coordOf(result, v)[2] === 200));
    expect(topFaces.length).toBe(2);
  });

  it('keeps a drawn seam but not the bridges cut to a shape drawn inside a face', async () => {
    const { existingCoplanarSeams } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    // A drawn line across the top, from edge to edge.
    splitHostByChord(l, [vertexAt(l, -200, 0, 200), vertexAt(l, 200, 0, 200)]);
    // A square drawn inside the front half, touching nothing: the host is cut
    // to it with two bridges.
    const island = [[-50, -150], [50, -150], [50, -50], [-50, -50]].map(([x, y]) => vertexAt(l, x, y, 200));
    const split = splitHostAround(l, island)!;
    expect(split).not.toBeNull();
    const inner = addFace(l, split.inner);
    const seams = existingCoplanarSeams(l, inner);
    const onY0 = (s: number[][]) => s.every((p) => p[1] === 0 && p[2] === 200);
    // The drawn line, whole, and nothing else: no bridge runs to the island.
    expect(seams.length).toBeGreaterThan(0);
    expect(seams.every(onY0)).toBe(true);
  });

  it('two separate pieces that overlap become one', async () => {
    const { mergeLattice, latticeBounds } = await import('../src/utils/latticeMesh');
    const { unionOverlappingPieces } = await import('../src/utils/latticeSketch');
    const l = boxLattice(0.0001, 200);
    mergeLattice(l, boxLattice(0.0001, 200), ([i, j, k]) => [i + 300, j, k]); // x 100..500 overlaps
    expect(latticeStats(l).parts).toBe(2);
    const out = unionOverlappingPieces(l);
    expect(out).not.toBeNull();
    expect(latticeStats(out!).parts).toBe(1);
    expect(latticeStats(out!).watertight).toBe(true);
    expect(latticeBounds(out!)).toEqual({ min: [-200, -200, -200], max: [500, 200, 200] });
    // Apart, they stay apart.
    const apart = boxLattice(0.0001, 200);
    mergeLattice(apart, boxLattice(0.0001, 200), ([i, j, k]) => [i + 1000, j, k]);
    expect(unionOverlappingPieces(apart)).toBeNull();
  });
});
