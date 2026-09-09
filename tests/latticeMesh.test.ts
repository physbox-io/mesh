import { describe, it, expect } from 'vitest';
import {
  createLattice, vertexAt, findVertex, addFace, findFace, removeFace, flipFace,
  moveVertex, moveVertices, removeVertex, faceNormal, dominantAxis, extrudeFace, mirrorFace,
  isWatertight, latticeStats, latticeBounds, toSceneGeom, toPolyMesh, cageEdges, coordOf,
  signedVolume, orientFaces, inconsistentFaces, faceCentre,
  serializeCage, deserializeCage, cloneLattice, restoreLattice, faceCount,
  boxLattice, SNAP_MULTIPLES, DEFAULT_UNIT, setCrease, isCrease, edgeLoop,
  facesAlong, edgeExists, type Lattice,
} from '../src/utils/latticeMesh';
import { meshCentroid } from '../src/utils/latticeMesh';
import { subdivide } from '../src/utils/subdivide';

/** The unit cube as six outward-wound quads, corners on 0/1 in each axis. */
function unitCube(unit = 0.01): Lattice {
  const l = createLattice(unit);
  const v = (i: number, j: number, k: number) => vertexAt(l, i, j, k);
  addFace(l, [v(0,0,0), v(0,1,0), v(1,1,0), v(1,0,0)]); // -z
  addFace(l, [v(0,0,1), v(1,0,1), v(1,1,1), v(0,1,1)]); // +z
  addFace(l, [v(0,0,0), v(1,0,0), v(1,0,1), v(0,0,1)]); // -y
  addFace(l, [v(0,1,0), v(0,1,1), v(1,1,1), v(1,1,0)]); // +y
  addFace(l, [v(0,0,0), v(0,0,1), v(0,1,1), v(0,1,0)]); // -x
  addFace(l, [v(1,0,0), v(1,1,0), v(1,1,1), v(1,0,1)]); // +x
  return l;
}

describe('lattice vertices', () => {
  it('gives the same vertex back for the same grid coordinates', () => {
    const l = createLattice();
    const a = vertexAt(l, 2, -3, 4);
    const b = vertexAt(l, 2, -3, 4);
    expect(b).toBe(a);
    expect(l.coords.length).toBe(3);
  });

  it('reports nothing at an unplaced node', () => {
    const l = createLattice();
    expect(findVertex(l, 0, 0, 0)).toBe(-1);
  });
});

describe('lattice faces', () => {
  it('refuses degenerate and duplicate faces', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    expect(addFace(l, [a, b])).toBe(-1);
    expect(addFace(l, [a, b, a])).toBe(-1);
    expect(addFace(l, [a, b, c])).toBe(0);
    expect(addFace(l, [b, c, a])).toBe(-1); // same cycle, rotated
  });

  it('lets a face be re-drawn the other way round, as the flip', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    addFace(l, [a, b, c]);
    expect(addFace(l, [c, b, a])).toBe(1);
  });

  it('finds a face however it is rotated', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    const f = addFace(l, [a, b, c]);
    expect(findFace(l, [c, a, b])).toBe(f);
  });

  it('keeps face indices stable when one is removed', () => {
    const l = unitCube();
    removeFace(l, 2);
    expect(faceCount(l)).toBe(5);
    expect(l.faces[5]).not.toBeNull(); // the last face did not slide down
  });
});

describe('face geometry', () => {
  it('normals point out of a correctly wound cube', () => {
    const l = unitCube();
    expect(dominantAxis(faceNormal(l, 0)!)).toEqual({ axis: 'z', sign: -1 });
    expect(dominantAxis(faceNormal(l, 1)!)).toEqual({ axis: 'z', sign: 1 });
    expect(dominantAxis(faceNormal(l, 2)!)).toEqual({ axis: 'y', sign: -1 });
    expect(dominantAxis(faceNormal(l, 3)!)).toEqual({ axis: 'y', sign: 1 });
    expect(dominantAxis(faceNormal(l, 4)!)).toEqual({ axis: 'x', sign: -1 });
    expect(dominantAxis(faceNormal(l, 5)!)).toEqual({ axis: 'x', sign: 1 });
  });

  it('flipping reverses the normal', () => {
    const l = unitCube();
    const before = faceNormal(l, 1)!;
    flipFace(l, 1);
    const after = faceNormal(l, 1)!;
    after.forEach((n, i) => expect(-n).toBeCloseTo(before[i]));
  });
});

describe('moving and welding', () => {
  it('moves a vertex to a free node', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0);
    expect(moveVertex(l, a, 5, 0, 0)).toBe(true);
    expect(findVertex(l, 0, 0, 0)).toBe(-1);
    expect(findVertex(l, 5, 0, 0)).toBe(a);
  });

  it('welds onto an occupied node, collapsing the quad it shared', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    addFace(l, [a, b, c, d]);
    moveVertex(l, b, 1, 1, 0); // b onto c
    expect(l.faces[0]).toEqual([a, c, d]);
    expect(l.vertexFaces.get(b)?.size ?? 0).toBe(0);
  });

  it('drops a face that welds down to a line', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 2, 0, 0);
    addFace(l, [a, b, c]);
    moveVertex(l, c, 1, 0, 0); // c onto b
    expect(faceCount(l)).toBe(0);
  });

  it('removing a vertex takes its faces with it', () => {
    const l = unitCube();
    removeVertex(l, findVertex(l, 0, 0, 0));
    expect(faceCount(l)).toBe(3); // the three faces meeting at that corner are gone
  });
});

describe('extrude', () => {
  it('walls in the gap and caps it', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]); // faces +z
    const result = extrudeFace(l, f, 2)!;
    expect(result.sides.length).toBe(4);
    expect(faceCount(l)).toBe(5); // four sides plus the cap, base consumed
    // The face pointed at +z, so two steps "out" is two steps up.
    expect(findVertex(l, 0, 0, 2)).toBeGreaterThan(-1);
  });

  it('keeps the cap facing the way the original did', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]); // faces +z
    const { cap } = extrudeFace(l, f, 3)!;
    expect(dominantAxis(faceNormal(l, cap)!)).toEqual({ axis: 'z', sign: 1 });
    expect(findVertex(l, 0, 0, 3)).toBeGreaterThan(-1);
  });

  it('makes a closed solid out of an open quad plus its flip', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]); // +z
    extrudeFace(l, f, 1);
    expect(isWatertight(l)).toBe(false); // open where the base was
    addFace(l, [a, d, c, b]);            // close it, wound the other way
    expect(isWatertight(l)).toBe(true);
  });

  it('extrudes along a named axis when one is given', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const f = addFace(l, [a, b, c, d]);
    extrudeFace(l, f, 2, 'x');
    expect(findVertex(l, 3, 1, 0)).toBeGreaterThan(-1);
  });
});

describe('mirror', () => {
  it('reflects a face and reverses its winding', () => {
    const l = createLattice();
    const a = vertexAt(l, 1, 0, 0), b = vertexAt(l, 2, 0, 0), c = vertexAt(l, 2, 1, 0);
    const f = addFace(l, [a, b, c]);
    const m = mirrorFace(l, f, 'x');
    expect(m).toBeGreaterThan(-1);
    const normal = faceNormal(l, f)!;
    const mirrored = faceNormal(l, m)!;
    // Reflected across x, a normal along z stays along z and keeps its sign;
    // that only holds if the winding was reversed too.
    expect(dominantAxis(mirrored)).toEqual(dominantAxis(normal));
    expect(findVertex(l, -2, 1, 0)).toBeGreaterThan(-1);
  });
});

describe('health and stats', () => {
  it('a cube is watertight, a cube missing a face is not', () => {
    const l = unitCube();
    expect(isWatertight(l)).toBe(true);
    removeFace(l, 0);
    expect(isWatertight(l)).toBe(false);
  });

  it('nothing at all is not watertight', () => {
    expect(isWatertight(createLattice())).toBe(false);
  });

  it('counts only vertices some face still uses', () => {
    const l = unitCube();
    vertexAt(l, 9, 9, 9); // placed and never joined to anything
    expect(latticeStats(l)).toMatchObject({ vertices: 8, faces: 6, quads: 6, tris: 0, watertight: true });
  });

  it('reports bounds in grid steps', () => {
    const l = unitCube();
    expect(latticeBounds(l)).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
  });

  it('lists each cage edge once', () => {
    expect(cageEdges(unitCube()).length / 2).toBe(12);
  });
});

describe('out to a mesh', () => {
  it('scales grid steps by the unit and drops orphans', () => {
    const l = unitCube(0.02);
    vertexAt(l, 9, 9, 9);
    const poly = toPolyMesh(l);
    expect(poly.positions.length / 3).toBe(8);
    expect(Math.max(...poly.positions)).toBeCloseTo(0.02);
  });

  it('triangulates quads and emits the Y-up copy the renderer wants', () => {
    const geom = toSceneGeom(unitCube(0.01));
    expect(geom.faces.length).toBe(6 * 2 * 3);
    const n = geom.renderVertices.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = geom.renderVertices.slice(i * 3, i * 3 + 3);
      expect(geom.vertices.slice(i * 3, i * 3 + 3)).toEqual([x, z, -y]);
    }
  });

  it('subdivision quadruples the faces and shrinks towards a sphere', () => {
    const cube = toPolyMesh(unitCube(0.01));
    const once = subdivide(cube, 1);
    const twice = subdivide(cube, 2);
    expect(once.faces.length).toBe(24);
    expect(twice.faces.length).toBe(96);
    for (const face of twice.faces) expect(face.length).toBe(4);

    // Every subdivided point lies inside the cage, and the corner has pulled in
    // most: that is the cube on its way to a rounded solid.
    const centre = 0.005;
    const radius = (p: number[], i: number) =>
      Math.hypot(p[i * 3] - centre, p[i * 3 + 1] - centre, p[i * 3 + 2] - centre);
    let maxRadius = 0;
    for (let i = 0; i < twice.positions.length / 3; i++) maxRadius = Math.max(maxRadius, radius(twice.positions, i));
    expect(maxRadius).toBeLessThan(Math.hypot(centre, centre, centre));
  });

  it('leaves an open cage its outline', () => {
    const l = createLattice(0.01);
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 2, 0, 0);
    const c = vertexAt(l, 2, 2, 0), d = vertexAt(l, 0, 2, 0);
    addFace(l, [a, b, c, d]);
    const once = subdivide(toPolyMesh(l), 1);
    // The four corners are pinned (three boundary edges meet at none of them,
    // but each has exactly two, so they move only along the border) and the
    // patch stays flat at z = 0.
    for (let i = 0; i < once.positions.length / 3; i++) expect(once.positions[i * 3 + 2]).toBe(0);
  });

  it('subdivides through toSceneGeom when asked', () => {
    const flat = toSceneGeom(unitCube(0.01), 0);
    const smooth = toSceneGeom(unitCube(0.01), 2);
    expect(smooth.faces.length).toBeGreaterThan(flat.faces.length);
    expect(smooth.faces.length).toBe(96 * 2 * 3);
  });
});

describe('persistence and history', () => {
  it('round-trips a cage through serialisation', () => {
    const l = unitCube(0.02);
    removeFace(l, 3);
    vertexAt(l, 9, 9, 9);
    const back = deserializeCage(serializeCage(l));
    expect(back.unit).toBe(0.02);
    expect(latticeStats(back)).toMatchObject(latticeStats(l));
    expect(toSceneGeom(back).renderVertices).toEqual(toSceneGeom(l).renderVertices);
  });

  it('restores a snapshot in place', () => {
    const l = unitCube();
    const snapshot = cloneLattice(l);
    removeFace(l, 0);
    removeFace(l, 1);
    expect(isWatertight(l)).toBe(false);
    restoreLattice(l, snapshot);
    expect(isWatertight(l)).toBe(true);
    expect(faceCount(l)).toBe(6);
  });

  it('a snapshot is not a view of the live cage', () => {
    const l = unitCube();
    const snapshot = cloneLattice(l);
    extrudeFace(l, 1, 4);
    expect(faceCount(snapshot)).toBe(6);
  });
});

describe('the starting box', () => {
  it('is a closed, outward-wound cube centred on the origin', () => {
    const l = boxLattice(0.005, 4);
    expect(isWatertight(l)).toBe(true);
    expect(latticeStats(l)).toMatchObject({ vertices: 8, quads: 6 });
    expect(latticeBounds(l)).toEqual({ min: [-4, -4, -4], max: [4, 4, 4] });
    // Outward: the +x face's normal points along +x.
    const right = l.faces.findIndex((f) => f && f.every((v) => l.coords[v * 3] === 4));
    expect(dominantAxis(faceNormal(l, right)!)).toEqual({ axis: 'x', sign: 1 });
  });
});

describe('the grid steps', () => {
  it('nest, so a coarse point is always also a fine point', () => {
    expect([...SNAP_MULTIPLES]).toEqual([1, 10, 100, 1000]);
    for (let i = 1; i < SNAP_MULTIPLES.length; i++) {
      expect(SNAP_MULTIPLES[i] % SNAP_MULTIPLES[i - 1]).toBe(0);
    }
    // 0.1 mm at the fine end, 100 mm at the coarse end.
    expect(DEFAULT_UNIT * 1000).toBeCloseTo(0.1);
    expect(DEFAULT_UNIT * SNAP_MULTIPLES[3] * 1000).toBeCloseTo(100);
  });

  it('places a coarsely snapped corner exactly on the fine grid', () => {
    const l = createLattice(DEFAULT_UNIT);
    const coarse = vertexAt(l, 1000, 0, 0);   // one 100 mm step out
    const fine = vertexAt(l, 1000, 0, 0);     // the same point, reached finely
    expect(fine).toBe(coarse);
  });
});

describe('centring on the centre of mass', () => {
  /** The starting box, moved bodily off the origin. */
  function offsetCube(): Lattice {
    const l = boxLattice(0.01, 2); // corners at +/-2 steps
    for (let v = 0; v < l.coords.length / 3; v++) {
      const [i, j, k] = coordOf(l, v);
      moveVertex(l, v, i + 10, j + 4, k);
    }
    return l;
  }

  it('finds the volume centroid of a closed solid', () => {
    const l = offsetCube();
    const centre = meshCentroid(toPolyMesh(l));
    expect(centre[0]).toBeCloseTo(0.1, 6);   // 10 steps of 0.01 m
    expect(centre[1]).toBeCloseTo(0.04, 6);
    expect(centre[2]).toBeCloseTo(0, 6);
  });

  it('falls back to the corner average when there is no volume', () => {
    const l = createLattice(0.01);
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 2, 0, 0), c = vertexAt(l, 2, 2, 0), d = vertexAt(l, 0, 2, 0);
    addFace(l, [a, b, c, d]);
    const centre = meshCentroid(toPolyMesh(l));
    expect(centre[0]).toBeCloseTo(0.01, 6);
    expect(centre[1]).toBeCloseTo(0.01, 6);
  });

  it('hands back a mesh centred on the body origin, and says how far it moved', () => {
    const geom = toSceneGeom(offsetCube());
    expect(geom.origin[0]).toBeCloseTo(0.1, 6);
    expect(geom.origin[1]).toBeCloseTo(0.04, 6);
    // MuJoCo moves a mesh onto its own centre of mass whatever we do, so what
    // is handed over has to be centred already or the body spins about a point
    // outside the shape.
    const centred = meshCentroid({
      positions: geom.renderVertices,
      faces: Array.from({ length: geom.faces.length / 3 }, (_, t) => geom.faces.slice(t * 3, t * 3 + 3)),
    });
    for (const c of centred) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('does not change the shape, only where it sits', () => {
    const moved = toSceneGeom(offsetCube());
    const home = toSceneGeom(boxLattice(0.01, 2));
    expect(moved.renderVertices.length).toBe(home.renderVertices.length);
    for (let i = 0; i < home.renderVertices.length; i++) {
      expect(moved.renderVertices[i]).toBeCloseTo(home.renderVertices[i], 9);
    }
  });
});

describe('creases', () => {
  /** The four vertices of the cube's top face, in order. */
  function topRing(l: Lattice): number[] {
    return [
      findVertex(l, 0, 0, 1), findVertex(l, 1, 0, 1),
      findVertex(l, 1, 1, 1), findVertex(l, 0, 1, 1),
    ];
  }

  it('only marks edges a face actually runs along', () => {
    const l = unitCube();
    const [a, b, c] = topRing(l);
    expect(setCrease(l, a, b, true)).toBe(true);   // an edge of the top face
    expect(isCrease(l, b, a)).toBe(true);          // undirected
    expect(setCrease(l, a, c, true)).toBe(false);  // a diagonal: no face runs along it
    expect(setCrease(l, a, b, true)).toBe(false);  // already sharp
    expect(setCrease(l, a, b, false)).toBe(true);
    expect(isCrease(l, a, b)).toBe(false);
  });

  it('holds a creased edge in place while the rest rounds off', () => {
    const plain = subdivide(toPolyMesh(unitCube(0.01)), 2);

    const creased = unitCube(0.01);
    const ring = topRing(creased);
    for (let i = 0; i < 4; i++) setCrease(creased, ring[i], ring[(i + 1) % 4], true);
    const sharp = subdivide(toPolyMesh(creased), 2);

    const top = (mesh: { positions: number[] }) => Math.max(...mesh.positions.filter((_, i) => i % 3 === 2));
    // Smoothed alone, the top face sags away from the cage; creased all round,
    // it stays exactly where it was drawn.
    expect(top(plain)).toBeLessThan(0.01);
    expect(top(sharp)).toBeCloseTo(0.01, 9);
  });

  it('keeps creases sharp through every level', () => {
    const l = unitCube(0.01);
    const ring = topRing(l);
    for (let i = 0; i < 4; i++) setCrease(l, ring[i], ring[(i + 1) % 4], true);
    const once = subdivide(toPolyMesh(l), 1);
    // Four creased edges become eight, and they are still marked.
    expect(once.creases?.size).toBe(8);
    expect(subdivide(toPolyMesh(l), 2).creases?.size).toBe(16);
  });

  it('forgets a crease when its edge stops existing', () => {
    const l = unitCube();
    const ring = topRing(l);
    setCrease(l, ring[0], ring[1], true);
    expect(latticeStats(l).creases).toBe(1);
    // Both faces along that edge gone means the edge is gone.
    removeFace(l, 1);
    removeFace(l, 2);
    expect(latticeStats(l).creases).toBe(0);
  });

  it('follows a welded corner rather than dangling', () => {
    const l = unitCube();
    const ring = topRing(l);
    setCrease(l, ring[0], ring[1], true);
    moveVertex(l, ring[0], 0, 1, 1); // weld the first corner onto the fourth
    expect(isCrease(l, ring[3], ring[1])).toBe(true);
  });

  it('survives being saved and reopened', () => {
    const l = unitCube(0.02);
    const ring = topRing(l);
    setCrease(l, ring[0], ring[1], true);
    setCrease(l, ring[1], ring[2], true);
    const back = deserializeCage(serializeCage(l));
    expect(latticeStats(back).creases).toBe(2);
    expect(toSceneGeom(back, 2).renderVertices).toEqual(toSceneGeom(l, 2).renderVertices);
  });

  it('reads a cage saved before creases existed', () => {
    const cage = serializeCage(unitCube());
    delete (cage as { creases?: number[] }).creases;
    expect(latticeStats(deserializeCage(cage)).creases).toBe(0);
  });

  it('comes back on the snapshot an undo restores', () => {
    const l = unitCube();
    const ring = topRing(l);
    setCrease(l, ring[0], ring[1], true);
    const snapshot = cloneLattice(l);
    setCrease(l, ring[0], ring[1], false);
    expect(latticeStats(l).creases).toBe(0);
    restoreLattice(l, snapshot);
    expect(latticeStats(l).creases).toBe(1);
  });
});

describe('edge loops', () => {
  /** A quad extruded twice: a tube whose middle ring is four-way all round. */
  function tube(): Lattice {
    const l = createLattice(0.01);
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const face = addFace(l, [a, b, c, d]);
    const first = extrudeFace(l, face, 1)!;
    extrudeFace(l, first.cap, 1);
    return l;
  }

  it('runs a ring right round the middle of a tube', () => {
    const l = tube();
    const loop = edgeLoop(l, findVertex(l, 0, 0, 1), findVertex(l, 1, 0, 1));
    expect(loop).toHaveLength(4);
    const keys = new Set(loop.map(([p, q]) => (p < q ? `${p}:${q}` : `${q}:${p}`)));
    expect(keys.size).toBe(4);
    for (const [p, q] of loop) expect(edgeExists(l, p, q)).toBe(true);
  });

  it('runs a side edge along the tube instead of round it', () => {
    const l = tube();
    const loop = edgeLoop(l, findVertex(l, 0, 0, 0), findVertex(l, 0, 0, 1));
    // Two steps up the tube, stopping at the three-way corners on both caps.
    expect(loop).toHaveLength(2);
  });

  it('finds nothing to follow on a box, where every corner is three-way', () => {
    // Not a shortcoming: a box has no straight-on at any corner, and picking one
    // of the two turns arbitrarily is how a "loop" ends up somewhere nobody
    // pointed at.
    const l = unitCube();
    expect(edgeLoop(l, findVertex(l, 0, 0, 0), findVertex(l, 1, 0, 0))).toHaveLength(1);
  });

  it('follows the border of an open surface', () => {
    // A 2x2 patch: its border is eight edges, its inner edges are not a border.
    const l = createLattice(0.01);
    const v = (i: number, j: number) => vertexAt(l, i, j, 0);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) addFace(l, [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)]);
    }
    const loop = edgeLoop(l, v(0, 0), v(1, 0));
    expect(loop).toHaveLength(8);
    // It is the border, so every edge in it has exactly one face.
    for (const [p, q] of loop) expect(facesAlong(l, p, q)).toHaveLength(1);
  });

  it('stops where there is no straight on', () => {
    // Two quads meeting along an edge: the shared edge's ends are three-way
    // corners, so the loop is just the edge itself.
    const l = createLattice(0.01);
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    const e = vertexAt(l, 1, 0, 1), f = vertexAt(l, 0, 0, 1);
    addFace(l, [a, b, c, d]);
    addFace(l, [a, f, e, b]);
    const loop = edgeLoop(l, a, b);
    expect(loop.length).toBeGreaterThanOrEqual(1);
    for (const [p, q] of loop) expect(edgeExists(l, p, q)).toBe(true);
  });

  it('refuses an edge that is not there', () => {
    const l = unitCube();
    expect(edgeLoop(l, findVertex(l, 0, 0, 0), findVertex(l, 1, 1, 1))).toEqual([]);
  });
});

describe('moving several corners at once', () => {
  it('translates them all without welding them to each other', () => {
    const l = unitCube();
    const top = [
      findVertex(l, 0, 0, 1), findVertex(l, 1, 0, 1),
      findVertex(l, 1, 1, 1), findVertex(l, 0, 1, 1),
    ];
    expect(moveVertices(l, top, 0, 0, 3)).toBe(true);
    expect(latticeStats(l).vertices).toBe(8);
    expect(latticeBounds(l)).toEqual({ min: [0, 0, 0], max: [1, 1, 4] });
    expect(isWatertight(l)).toBe(true);
  });

  it('would collapse if it moved them one at a time', () => {
    // Two corners a step apart, moved a step: done singly the first welds onto
    // the second's old position and one of them disappears.
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0), c = vertexAt(l, 1, 1, 0);
    addFace(l, [a, b, c]);
    moveVertices(l, [a, b], 1, 0, 0);
    expect(latticeStats(l).vertices).toBe(3);
    expect(findVertex(l, 1, 0, 0)).toBe(a);
    expect(findVertex(l, 2, 0, 0)).toBe(b);
  });

  it('welds onto a corner that is standing still', () => {
    const l = createLattice();
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 2, 0, 0), d = vertexAt(l, 2, 1, 0);
    addFace(l, [a, b, d]);
    addFace(l, [b, c, d]);
    // b moves onto c, which is not moving.
    moveVertices(l, [b], 1, 0, 0);
    expect(latticeStats(l).vertices).toBe(3);
  });

  it('does nothing for a zero step or an empty selection', () => {
    const l = unitCube();
    expect(moveVertices(l, [0, 1], 0, 0, 0)).toBe(false);
    expect(moveVertices(l, [], 1, 0, 0)).toBe(false);
  });
});

describe('extruding backwards', () => {
  /** A quad on z = 0 facing +z. */
  function plate(): { l: Lattice; face: number } {
    const l = createLattice(0.01);
    const a = vertexAt(l, 0, 0, 0), b = vertexAt(l, 1, 0, 0);
    const c = vertexAt(l, 1, 1, 0), d = vertexAt(l, 0, 1, 0);
    return { l, face: addFace(l, [a, b, c, d]) };
  }

  /** Every face's normal, as an axis and a sign. */
  function facings(l: Lattice) {
    return l.faces
      .map((verts, f) => (verts ? dominantAxis(faceNormal(l, f)!) : null))
      .filter(Boolean) as { axis: string; sign: number }[];
  }

  it('puts the cap on the far side, facing away from the solid', () => {
    const { l, face } = plate();
    const { cap } = extrudeFace(l, face, -3)!; // dragged back through the plate
    expect(findVertex(l, 0, 0, -3)).toBeGreaterThan(-1);
    // The solid now lies above the cap, so the cap faces down.
    expect(dominantAxis(faceNormal(l, cap)!)).toEqual({ axis: 'z', sign: -1 });
  });

  it('leaves every face of a backwards extrusion facing outwards', () => {
    const { l, face } = plate();
    extrudeFace(l, face, -3);
    addFace(l, [ // cap the open top, wound to face +z
      findVertex(l, 0, 0, 0), findVertex(l, 1, 0, 0),
      findVertex(l, 1, 1, 0), findVertex(l, 0, 1, 0),
    ]);
    expect(isWatertight(l)).toBe(true);
    // A correctly wound closed solid encloses a positive volume; inside-out, the
    // same shape encloses a negative one.
    expect(signedVolume(l)).toBeGreaterThan(0);
  });

  it('leaves an open backwards shell with nothing to repair', () => {
    const { l, face } = plate();
    extrudeFace(l, face, -3);
    // The shell is open where the plate was, so there is no volume to take the
    // sign of — but every face still has to lean away from the middle.
    expect(inconsistentFaces(l)).toBe(0);
    expect(facings(l)).toHaveLength(5);
  });
});

describe('turning faces the right way round', () => {
  it('finds nothing to fix on a correctly built box', () => {
    expect(inconsistentFaces(boxLattice(0.01, 2))).toBe(0);
  });

  it('turns an entirely inside-out solid outwards', () => {
    const l = boxLattice(0.01, 2);
    for (const verts of l.faces) verts?.reverse();
    expect(signedVolume(l)).toBeLessThan(0);
    expect(orientFaces(l)).toBe(6);
    expect(signedVolume(l)).toBeGreaterThan(0);
  });

  it('makes one disagreeing face agree with the rest', () => {
    const l = boxLattice(0.01, 2);
    l.faces[3]!.reverse();
    expect(orientFaces(l)).toBe(1);
    expect(signedVolume(l)).toBeGreaterThan(0);
    expect(inconsistentFaces(l)).toBe(0);
  });

  it('turns an open shell out, where there is no volume to judge by', () => {
    // Five faces of a box, inside-out: exactly what a backwards extrude used to
    // leave behind, and what a hand-built shape can still be.
    const l = boxLattice(0.01, 2);
    removeFace(l, 0);
    for (const verts of l.faces) verts?.reverse();
    expect(orientFaces(l)).toBe(5);
    const centre = [0, 0, 0];
    for (let f = 0; f < l.faces.length; f++) {
      if (!l.faces[f]) continue;
      const at = faceCentre(l, f)!;
      const normal = faceNormal(l, f)!;
      const lean = (at[0] - centre[0]) * normal[0] + (at[1] - centre[1]) * normal[1] + (at[2] - centre[2]) * normal[2];
      expect(lean).toBeGreaterThan(0);
    }
  });

  it('treats separate pieces separately', () => {
    // Two boxes, one of them inside-out: only that one is turned.
    const l = boxLattice(0.01, 2);
    const far = boxLattice(0.01, 2);
    for (const verts of far.faces) {
      if (!verts) continue;
      const moved = verts.map((v) => {
        const [i, j, k] = coordOf(far, v);
        return vertexAt(l, i + 20, j, k);
      });
      addFace(l, moved.reverse());
    }
    expect(orientFaces(l)).toBe(6);
    expect(inconsistentFaces(l)).toBe(0);
  });
});
