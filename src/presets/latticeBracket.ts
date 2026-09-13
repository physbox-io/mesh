// ---------------------------------------------------------------------------
// Wall bracket — the lattice mode, showing what it is for
// ---------------------------------------------------------------------------
//
// Every other preset in this app demonstrates physics. This one demonstrates
// MODELLING: a part with dimensions, drawn on the grid, of the kind the lattice
// tools exist for. A 50 x 40 mm shelf arm off a 60 mm wall plate, both 5 mm
// thick, stiffened by a 4 mm gusset — every number a whole millimetre, every
// corner exactly on the grid, because that is the whole claim of the mode.
//
// It is built here in code rather than dumped as a literal cage for two
// reasons: the numbers stay readable as millimetres, and an extruded profile is
// exactly how somebody would build it by hand — draw the side view, push it out
// to width. What the file ships is the cage, so opening Edit Lattice hands over
// the same document that made it rather than a mesh nobody can take apart.
// ---------------------------------------------------------------------------

import {
  createLattice, vertexAt, addFace, orientFaces, serializeCage, toSceneGeom,
  setCrease, DEFAULT_UNIT, type Lattice, type LatticeCoord,
} from '../utils/latticeMesh';
import type { SceneGraph } from '../types/scene';

/** Millimetres to grid steps. The grid is 0.1 mm, so this is just a decade. */
const mm = (v: number) => Math.round(v / (DEFAULT_UNIT * 1000));

/** A closed profile in the XZ plane, as [x, z] pairs in millimetres. */
type Profile = [number, number][];

/**
 * Pushes a closed 2D profile out along Y into a solid.
 *
 * The two caps and one quad per profile edge — the same six-quad box that a new
 * lattice body starts as, generalised to any outline. Winding is left to
 * `orientFaces` at the end rather than being reasoned about per face: the
 * profile can be given either way round, and getting it wrong is a shape that
 * looks right until it is exported with its inside out.
 */
function extrudeProfile(lattice: Lattice, profile: Profile, y0: number, y1: number, caps: Profile[] = [profile]) {
  const at = (x: number, y: number, z: number) => vertexAt(lattice, mm(x), mm(y), mm(z));
  for (const cap of caps) {
    addFace(lattice, cap.map(([x, z]) => at(x, y0, z)));
    addFace(lattice, [...cap].reverse().map(([x, z]) => at(x, y1, z)));
  }
  for (let i = 0; i < profile.length; i++) {
    const [x0, z0] = profile[i];
    const [x1, z1] = profile[(i + 1) % profile.length];
    addFace(lattice, [at(x0, y0, z0), at(x1, y0, z1), at(x1, y1, z1), at(x0, y1, z0)]);
  }
}

/** The bracket's cage: the L, and the gusset standing in the corner of it. */
export function bracketCage(): Lattice {
  const lattice = createLattice(DEFAULT_UNIT);

  // Side view. The wall plate rises in Z; the shelf arm runs out in X.
  //
  // The outline carries two corners it does not strictly need — (5, 0) and
  // (0, 5) — because the L is CONCAVE, and a concave face is the one thing a
  // cage should not be asked to hold. Split into three quads that tile it, the
  // caps subdivide cleanly, export cleanly, and every edge is still shared by
  // exactly two faces. The extra corners are where those quads meet the wall.
  const outline: Profile = [
    [0, 0], [5, 0], [50, 0], [50, 5], [5, 5], [5, 60], [0, 60], [0, 5],
  ];
  const caps: Profile[] = [
    [[0, 0], [5, 0], [5, 5], [0, 5]],      // the corner where the two arms meet
    [[0, 5], [5, 5], [5, 60], [0, 60]],    // the wall plate above it
    [[5, 0], [50, 0], [50, 5], [5, 5]],    // the shelf arm out in front
  ];
  extrudeProfile(lattice, outline, -20, 20, caps);

  // The gusset: a right triangle in the same plane, standing on the shelf and
  // against the wall plate. Thinner than the arms, so it reads as a rib, and
  // buried a millimetre into both of them — two shells that merely touch share
  // coincident faces, which is the classic thing a slicer refuses.
  const gusset: Profile = [[4, 4], [30, 4], [4, 30]];
  extrudeProfile(lattice, gusset, -2, 2);

  orientFaces(lattice);

  // Sharp where a bracket is sharp. Nothing here is smoothed as it ships, but
  // the creases mean turning smoothing on rounds the corners and leaves the
  // mounting faces flat — which is the difference between a rounded-off part
  // and a pebble, and the thing worth showing.
  const crease = (a: LatticeCoord, b: LatticeCoord) => {
    const va = vertexAt(lattice, ...a);
    const vb = vertexAt(lattice, ...b);
    setCrease(lattice, va, vb, true);
  };
  for (const y of [-20, 20] as const) {
    const ring: Profile = outline;
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % ring.length];
      crease([mm(x0), mm(y), mm(z0)], [mm(x1), mm(y), mm(z1)]);
    }
  }
  return lattice;
}

export const latticeBracketPreset: SceneGraph = (() => {
  const lattice = bracketCage();
  const { vertices, renderVertices, faces, origin } = toSceneGeom(lattice, 0, 0);

  // Sat on the ground rather than dropped onto it: this is a part being looked
  // at, not an experiment being run, and a bracket that starts by falling over
  // is a worse first frame than one standing where it was drawn.
  let lowest = Infinity;
  for (let i = 2; i < renderVertices.length; i += 3) lowest = Math.min(lowest, renderVertices[i]);

  return {
    nodes: [{
      id: 'wall_bracket',
      name: 'Wall Bracket',
      type: 'body',
      pos: [0, 0, -lowest],
      geoms: [{
        name: 'wall_bracket_mesh',
        type: 'mesh',
        size: [1],
        rgba: [0.55, 0.68, 0.85, 1], // drafting blue, as every lattice body is
        mass: 0.12,
        condim: 3,
        dynamic: true,
        vertices,
        faces,
        renderVertices,
      }],
      joints: [{ name: 'wall_bracket_free', type: 'free' }],
      children: [],
      isLattice: true,
      latticeCage: serializeCage(lattice),
      latticeSubdiv: 0,
      latticeThickness: 0,
      latticeVersion: 1,
      latticeOrigin: origin,
      latticeEdited: true,
    }],
  } as SceneGraph;
})();

export default latticeBracketPreset;
