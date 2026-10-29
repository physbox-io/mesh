// A cage of flush boxes: oriented part by part, and fused into one solid.
//
// A chair drawn as six boxes (seat, four legs, a back standing on the seat),
// each wound outward, reported `inconsistent: 5`, and physics_lattice_orient
// then turned five of the back's six faces inward: it walked from the seat's
// top face across the edge the back shares with it (an edge four faces meet
// at) and "corrected" the back against it. And the same cage made over MCP
// stayed six touching boxes, not watertight, weighed by its hull (28.5 kg
// against 9.7 kg), where the editor fuses flush faces on every commit.

import { describe, it, expect } from 'vitest';
import { createLattice, deserializeCage, isWatertight, orientFaces, serializeCage, toSceneGeom, DEFAULT_UNIT, latticeStats } from '../src/utils/latticeMesh';
import { runLatticeOps } from '../src/hooks/mcp/latticeState';
import { checkMeshInertia } from '../src/utils/meshInertiaCheck';

type P = [number, number, number];

/** The six faces of a box, in mm, each wound counter-clockwise seen from outside. */
function box(min: P, max: P): P[][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], // -z
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], // +z
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], // -y
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], // +y
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], // -x
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], // +x
  ];
}

const CHAIR: P[][] = [
  ...box([-180, -180, 410], [180, 180, 440]), // seat
  ...box([-180, -180, 0], [-150, -150, 410]), // legs
  ...box([150, -180, 0], [180, -150, 410]),
  ...box([-180, 150, 0], [-150, 180, 410]),
  ...box([150, 150, 0], [180, 180, 410]),
  ...box([-180, 150, 440], [180, 180, 840]), // back, standing on the seat
];

/** mm³ of solid: seat + 4 legs + back. */
const TRUE_VOLUME_MM3 = 360 * 360 * 30 + 4 * 30 * 30 * 410 + 360 * 30 * 400;

function volumeMm3(lattice: ReturnType<typeof createLattice>): number {
  const { renderVertices, faces } = toSceneGeom(deserializeCage(serializeCage(lattice)), 0, 0);
  return checkMeshInertia(renderVertices, faces).volume * 1e9;
}

describe('orienting a cage of flush parts', () => {
  it('leaves parts that are already outward alone', () => {
    const lattice = createLattice(DEFAULT_UNIT);
    runLatticeOps(lattice, [{ op: 'faces', faces: CHAIR }], 0, 0, { fuse: false });
    expect(orientFaces(lattice)).toBe(0);
  });

  it('turns a part drawn inside out by its own volume, not its neighbour', () => {
    const lattice = createLattice(DEFAULT_UNIT);
    const back = box([-180, 150, 440], [180, 180, 840]).map((f) => [...f].reverse());
    runLatticeOps(lattice, [{ op: 'faces', faces: [...box([-180, -180, 410], [180, 180, 440]), ...back] }], 0, 0, { fuse: false });
    // The back's six faces, and nothing of the seat's.
    expect(orientFaces(lattice)).toBe(6);
    expect(orientFaces(lattice)).toBe(0);
  });
});

describe('flush parts drawn over MCP', () => {
  it('fuse into one watertight solid that weighs its real volume', () => {
    const lattice = createLattice(DEFAULT_UNIT);
    runLatticeOps(lattice, [{ op: 'faces', faces: CHAIR }]);
    expect(isWatertight(lattice)).toBe(true);
    const stats = latticeStats(lattice);
    expect(stats.parts).toBe(1);
    expect(stats.inconsistent).toBe(0);
    expect(volumeMm3(lattice) / TRUE_VOLUME_MM3).toBeCloseTo(1, 6);
  });
});
