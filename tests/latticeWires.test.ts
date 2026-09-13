import { describe, expect, it } from 'vitest';
import {
  boxLattice, createLattice, vertexAt, addWire, removeWire, wireEndingAt, removeWireEdge, removeVertex,
  cageEdges, wireEdges, serializeCage, deserializeCage, latticeBounds, cloneLattice, restoreLattice,
} from '../src/utils/latticeMesh';

const chain = (lattice: ReturnType<typeof createLattice>, points: [number, number, number][]) =>
  points.map(([i, j, k]) => vertexAt(lattice, i, j, k));

describe('wires', () => {
  it('keeps an open chain and counts it among the edges and the bounds', () => {
    const lattice = createLattice();
    const w = addWire(lattice, chain(lattice, [[0, 0, 0], [10, 0, 0], [10, 10, 0]]));
    expect(w).toBe(0);
    expect(cageEdges(lattice).length).toBe(4);
    expect(wireEdges(lattice).length).toBe(4);
    expect(latticeBounds(lattice)).toEqual({ min: [0, 0, 0], max: [10, 10, 0] });
  });

  it('refuses a chain with fewer than two distinct corners', () => {
    const lattice = createLattice();
    const v = vertexAt(lattice, 0, 0, 0);
    expect(addWire(lattice, [v, v])).toBe(-1);
    expect(lattice.wires.length).toBe(0);
  });

  it('finds the wire a corner ends', () => {
    const lattice = createLattice();
    const verts = chain(lattice, [[0, 0, 0], [10, 0, 0], [20, 0, 0]]);
    addWire(lattice, verts);
    expect(wireEndingAt(lattice, verts[0])).toEqual({ wire: 0, atStart: true });
    expect(wireEndingAt(lattice, verts[2])).toEqual({ wire: 0, atStart: false });
    expect(wireEndingAt(lattice, verts[1])).toBeNull();
  });

  it('survives being saved and loaded', () => {
    const lattice = boxLattice(0.0001, 200);
    addWire(lattice, chain(lattice, [[300, 0, 0], [400, 50, 0], [500, 0, 0]]));
    const back = deserializeCage(serializeCage(lattice));
    expect(back.wires.length).toBe(1);
    expect(back.wires[0].length).toBe(3);
    expect(wireEdges(back).length).toBe(4);
    // Faces untouched by the wire's presence.
    expect(back.faces.filter(Boolean).length).toBe(6);
  });

  it('loads a cage saved before wires existed', () => {
    const cage = serializeCage(boxLattice(0.0001, 200));
    delete cage.wires;
    delete cage.wireSizes;
    expect(deserializeCage(cage).wires).toEqual([]);
  });

  it('splits a wire where a corner is deleted, and where an edge is', () => {
    const lattice = createLattice();
    const verts = chain(lattice, [[0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0], [40, 0, 0]]);
    addWire(lattice, verts);
    removeVertex(lattice, verts[2]);
    expect(lattice.wires).toEqual([[verts[0], verts[1]], [verts[3], verts[4]]]);

    const again = createLattice();
    const v2 = chain(again, [[0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0]]);
    addWire(again, v2);
    expect(removeWireEdge(again, v2[2], v2[1])).toBe(true);
    expect(again.wires).toEqual([[v2[0], v2[1]], [v2[2], v2[3]]]);
    expect(removeWireEdge(again, v2[0], v2[3])).toBe(false);
  });

  it('is part of what undo snapshots', () => {
    const lattice = createLattice();
    const snapshot = cloneLattice(lattice);
    addWire(lattice, chain(lattice, [[0, 0, 0], [10, 0, 0]]));
    expect(lattice.wires.length).toBe(1);
    restoreLattice(lattice, snapshot);
    expect(lattice.wires.length).toBe(0);
    expect(removeWire(lattice, 0)).toBe(false);
  });
});

describe('splitLattice', () => {
  it('finds the pieces that share no corner', async () => {
    const { splitLattice, latticeStats } = await import('../src/utils/latticeMesh');
    const lattice = boxLattice(0.0001, 200);
    // A second box well clear of the first, and a wire on its own.
    const far = boxLattice(0.0001, 100);
    const { mergeLattice: merge } = await import('../src/utils/latticeMesh');
    merge(lattice, far, ([i, j, k]) => [i + 1000, j, k]);
    addWire(lattice, chain(lattice, [[0, 3000, 0], [100, 3000, 0]]));
    expect(latticeStats(lattice).parts).toBe(2);
    const pieces = splitLattice(lattice);
    expect(pieces.map((p) => p.faces.filter(Boolean).length).sort()).toEqual([0, 6, 6]);
    expect(pieces.filter((p) => p.wires.length === 1).length).toBe(1);
  });

  it('keeps two boxes sharing a wall as one piece', async () => {
    const { splitLattice, mergeLattice: merge } = await import('../src/utils/latticeMesh');
    const lattice = boxLattice(0.0001, 200);
    merge(lattice, boxLattice(0.0001, 200), ([i, j, k]) => [i + 400, j, k]);
    expect(splitLattice(lattice).length).toBe(1);
  });
});
