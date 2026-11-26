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

/** The bracket's cage: the L and its stiffening gusset as one watertight solid. */
export function bracketCage(): Lattice {
  const lattice = createLattice(DEFAULT_UNIT);
  const at = (x: number, y: number, z: number) => vertexAt(lattice, mm(x), mm(y), mm(z));

  // Side view. The wall plate rises in Z; the shelf arm runs out in X.
  //
  // The outline carries subdivision points at x = 30 and z = 30 (where the
  // triangular gusset meets the shelf and wall plate) as well as (5, 0) and
  // (0, 5) so the concave L caps tile cleanly into five convex quads with no
  // T-junctions. Along Y, the bracket is split into three spans: [-20, -2],
  // the 4 mm gusset rib [-2, 2], and [2, 20]. In the middle span the two
  // inner-corner edges [30,5]->[5,5]->[5,30] are replaced by the gusset
  // hypotenuse [30,5]->[5,30], capped on y = -2 and y = 2 by two triangles.
  // Every edge in the resulting cage is shared by exactly two faces (one
  // connected, watertight manifold shell).
  const outline: Profile = [
    [0, 0], [5, 0], [30, 0], [50, 0], [50, 5], [30, 5],
    [5, 5], [5, 30], [5, 60], [0, 60], [0, 30], [0, 5],
  ];
  const midOutline: Profile = [
    [0, 0], [5, 0], [30, 0], [50, 0], [50, 5], [30, 5],
    [5, 30], [5, 60], [0, 60], [0, 30], [0, 5],
  ];
  const caps: Profile[] = [
    [[0, 0], [5, 0], [5, 5], [0, 5]],       // corner where the two arms meet
    [[5, 0], [30, 0], [30, 5], [5, 5]],     // inner shelf arm under gusset
    [[30, 0], [50, 0], [50, 5], [30, 5]],   // outer shelf arm
    [[0, 5], [5, 5], [5, 30], [0, 30]],     // lower wall plate behind gusset
    [[0, 30], [5, 30], [5, 60], [0, 60]],   // upper wall plate
  ];

  // Outer Y end caps at y = -20 and y = 20.
  for (const cap of caps) {
    addFace(lattice, cap.map(([x, z]) => at(x, -20, z)));
    addFace(lattice, [...cap].reverse().map(([x, z]) => at(x, 20, z)));
  }

  // Extrude the L-outline across the two outer spans and the merged L+gusset
  // outline across the central 4 mm rib span.
  const bridgeRing = (ring: Profile, y0: number, y1: number) => {
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[(i + 1) % ring.length];
      addFace(lattice, [at(x0, y0, z0), at(x1, y0, z1), at(x1, y1, z1), at(x0, y1, z0)]);
    }
  };
  bridgeRing(outline, -20, -2);
  bridgeRing(midOutline, -2, 2);
  bridgeRing(outline, 2, 20);

  // Triangular gusset side cheeks closing the step at y = -2 and y = 2.
  addFace(lattice, [at(5, -2, 5), at(30, -2, 5), at(5, -2, 30)]);
  addFace(lattice, [at(5, 2, 5), at(5, 2, 30), at(30, 2, 5)]);

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
    for (let i = 0; i < outline.length; i++) {
      const [x0, z0] = outline[i];
      const [x1, z1] = outline[(i + 1) % outline.length];
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
