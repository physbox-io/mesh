import type { PaintLayer } from '../utils/vertexPaint';
export type GeomType = 'capsule' | 'sphere' | 'box' | 'plane' | 'cylinder' | 'ellipsoid' | 'mesh';
export type JointType = 'hinge' | 'slide' | 'ball' | 'free';

// How a geom takes part in a body's CSG (boolean) program. Only meaningful on a
// node with csgEnabled — elsewhere every geom is an independent solid, which is
// what 'union' means anyway.
export type CsgOp = 'union' | 'difference' | 'intersection';

// What a geom is FOR. Undefined (the default, and every pre-CSG geom) means
// both: it renders and it collides, as geoms always have.
//   'visual'    — drawn, but contype/conaffinity forced to 0 and carries no mass
//   'collision' — simulated, never drawn
export type GeomRole = 'visual' | 'collision';

export interface SceneGeom {
  name: string;
  type: GeomType;
  size: number[];
  // CSG authoring (source primitives). 'difference' geoms are cut OUT of the
  // union of the body's positive geoms; they are never emitted to MJCF.
  csg?: CsgOp;
  role?: GeomRole;
  // Set on geoms *generated* by evaluating the body's CSG program, so a
  // recompile can replace them wholesale and tell them from authored ones.
  csgDerived?: 'visual' | 'collider';
  rgba?: number[];
  // Colour brushed onto part of this geom's surface (see utils/vertexPaint).
  // Purely decorative: nothing in the physics, the MJCF emitter or any exporter
  // reads it.
  paint?: PaintLayer;
  fromto?: number[];
  pos?: number[];
  quat?: number[];
  euler?: number[];
  mass?: number;
  contype?: number;
  conaffinity?: number;
  condim?: number;
  friction?: number[];
  solref?: number[];
  solimp?: number[];
  margin?: number;
  gap?: number;
  // For type='mesh': flat array of vertex positions (x0,y0,z0, x1,y1,z1, ...) and
  // flat array of triangle face indices (i0,j0,k0, i1,j1,k1, ...).
  // vertices are in Three.js Y-up space; the mjcf builder swaps Y↔Z for MuJoCo.
  vertices?: number[];
  faces?: number[];
  // When true, the mesh participates in simulation and its transform is tracked from MuJoCo.
  // The renderer uses renderVertices (Z-up, centroid at origin) inside the rotated group.
  dynamic?: boolean;
  /**
   * For a geom that cuts (csg:'difference'): where it goes into the part, and
   * how far.
   *
   * The authoring intent, from which `pos`, `quat` and the length in `size` are
   * DERIVED — see cutGeometry in utils/csg.ts. Stored because those cannot be
   * read back into it: a cylinder from 10 to 22 is a 12 mm cutter centred at 16,
   * and recovering "10 mm in, perpendicular to that face" from it would mean
   * knowing which end was the entry and how much was overshoot.
   *
   * `cutNormal` is the OUTWARD direction of the surface, and it is a direction
   * rather than a choice of six axes on purpose. A lattice vertex is three
   * integers, but a face joining any three of them can point anywhere, and a
   * bevelled, smoothed or imported surface certainly does — snapping to the
   * nearest axis puts the hole at an angle to the face it was asked for,
   * quietly.
   *
   * Nothing downstream reads these. The boolean, the MJCF and every exporter
   * see an ordinary positioned primitive, exactly as they did before.
   */
  cutNormal?: number[];
  /** The point on that surface the cut is centred on, in the body frame. */
  cutAt?: number[];
  /** Depth in metres into the material from `cutAt`. 0 or absent cuts through. */
  cutDepth?: number;
  /**
   * This is the geom the body's lattice cage owns — the one `applyLattice`
   * rewrites on every edit.
   *
   * It exists so a lattice body can carry OTHER geoms: the moment a cut is
   * added to one, "the body's mesh geom" stops naming one thing, because the
   * boolean evaluator's own output is a mesh too. Picking the first mesh in the
   * list would eventually pick the derived one and overwrite the boolean result
   * with the un-cut cage.
   */
  latticeGeom?: boolean;
  // Centroid-recentered vertices in MuJoCo Z-up space for dynamic mesh rendering.
  renderVertices?: number[];
}

export interface SceneJoint {
  name: string;
  type: JointType;
  axis?: number[];
  pos?: number[];
  damping?: number;
  stiffness?: number;
  springref?: number;
  limited?: boolean;
  range?: number[];
  actuator?: {
    type: 'velocity' | 'motor';
    kv?: number; // For velocity actuators
    gear?: number; // Optional gear ratio
    ctrlValue?: number; // Target speed or force from UI
  };
  initialVelocity?: number[]; // [lin_x, lin_y, lin_z, ang_x, ang_y, ang_z]
}

export interface SceneNode {
  id: string;
  name: string;
  type: 'body';
  pos: number[];
  quat?: number[];
  euler?: number[];
  geoms: SceneGeom[];
  joints: SceneJoint[];
  children: SceneNode[];
  allowCoupling?: boolean;
  coupleTargetId?: string;
  coupleRatio?: number;
  weldTargetId?: string;
  connectTargetId?: string;
  connectAnchor?: number[];
  isWedge?: boolean;
  width?: number;
  depth?: number;
  height?: number;
  wedgeAngle?: number;
  isPyramid?: boolean;
  isCone?: boolean;
  isTorus?: boolean;
  isTube?: boolean;
  radius?: number;
  majorRadius?: number;
  tubeRadius?: number;
  innerRadius?: number;
  outerRadius?: number;
  isCurve?: boolean;
  curvePoints?: number[][]; // body-local Z-up control points; spline = rolling surface
  curveWidth?: number;
  curveThickness?: number;
  curveSegments?: number;
  curveClosed?: boolean; // wrap the spline into a seamless loop
  curveBank?: number; // bank (roll) angle in degrees; positive raises the left-of-travel edge
  isPulleyWheel?: boolean;
  leftTargetId?: string;
  rightTargetId?: string;
  pulleyRadius?: number;
  isPulleyRope?: boolean;
  pulleyWheelId?: string;
  isAerodynamic?: boolean;
  rot?: number[];
  isHardwareComponent?: boolean;
  hardwareType?: string;
  hardwareSpec?: Record<string, number | string>;
  script?: string;
  scad?: string;
  // --- CSG (boolean modifiers) ---------------------------------------------
  // When true, the body's geoms are treated as a CSG program rather than as a
  // set of independent solids: positives are unioned, geoms marked
  // csg:'difference' are subtracted, csg:'intersection' geoms intersect. The
  // result is compiled to a mesh via OpenSCAD; see src/utils/csg.ts.
  csgEnabled?: boolean;
  // How the boolean result collides:
  //   'auto'       — decompose into convex angular sectors around the hole axis
  //                  when one can be found, else fall back to 'primitives'
  //   'decompose'  — force sector decomposition
  //   'primitives' — the positive source primitives are the colliders; the
  //                  boolean mesh is visual only (holes don't collide)
  //   'hull'       — the boolean mesh itself collides, i.e. as its convex hull
  csgCollision?: 'auto' | 'decompose' | 'primitives' | 'hull';
  csgSectors?: number;      // sector count for decomposition (default 16)
  csgFn?: number;           // OpenSCAD $fn for generated primitives (default 32)
  csgHoleAxis?: 'x' | 'y' | 'z' | 'auto'; // hole axis for decomposition
  csgMass?: number;         // total mass of the boolean solid, split across colliders
  // Set by the evaluator, read by the UI. csgHash fingerprints the inputs the
  // derived geoms were built from, so the auto-compiler knows when they're stale.
  csgHash?: string;
  csgScad?: string;         // the generated OpenSCAD source (read-only, for inspection)
  csgVolume?: number;       // true volume of the boolean solid (m³)
  csgHullVolume?: number;   // volume of its convex hull (m³) — the 'hull' mode figure
  csgCentroid?: number[];   // centroid offset applied to the compiled body frame
  csgWarning?: string;      // e.g. "no hole axis found, colliding as primitives"
  csgError?: string;
  /**
   * A free-form sculpted body: its mesh geom is not derived from parameters, so
   * nothing may regenerate it. The sculpt tools own it, and the primitive
   * sliders in the inspector have nothing to act on.
   */
  isSculpt?: boolean;
  /** Which base shape it was started from. See utils/sculptBases.ts. */
  sculptBase?: string;
  /**
   * Bumped whenever the mesh is replaced wholesale rather than edited — picking
   * a different base. The viewport keys its sculpting surface on this, so the
   * new mesh is loaded instead of the old one being carried on with.
   */
  sculptVersion?: number;
  /** Set once a stroke has landed, so switching base can warn before discarding it. */
  sculptEdited?: boolean;

  /**
   * A lattice body: built by connecting points on a grid rather than by
   * describing it or by brushing it. See utils/latticeMesh.ts.
   *
   * Its mesh geom holds the SUBDIVIDED result, which cannot be turned back into
   * the cage that produced it — so `latticeCage` is the real document and the
   * geom is output. Without the cage stored, a saved lattice would reopen as
   * something that can be looked at and never edited again.
   */
  isLattice?: boolean;
  latticeCage?: { unit: number; coords: number[]; faces: number[]; faceSizes: number[] };
  /** How many Catmull-Clark passes the mesh geom was built with (0, 1 or 2). */
  latticeSubdiv?: number;
  /**
   * Wall thickness in metres, or 0 for none. A lattice is drawn as a surface,
   * and a surface has no inside for a slicer or a CAM job to fill; this is what
   * turns one into a shell. Applied when the mesh is built, never to the cage,
   * so it can be changed or taken off without the shape remembering it.
   */
  latticeThickness?: number;
  /**
   * How far the mesh geom was shifted to put its centre of mass on the body
   * origin, in the body's own axes. Bodies rotate about their origin and MuJoCo
   * moves a mesh asset onto its own centre of mass, so a shape built off to one
   * side has to be recentred and the body moved to compensate; this is what was
   * compensated for last time, so the next commit can apply the difference.
   */
  latticeOrigin?: number[];
  /** Bumped when the cage is replaced wholesale, to remount the editor on it. */
  latticeVersion?: number;
  /**
   * The cage has been APPLIED: this body's mesh is now its own document, and
   * the lattice tools are closed on it for good.
   *
   * Sculpting is what asks for this. The two cannot both own the same mesh —
   * the cage regenerates it from scratch on every edit, so a sculpted lattice
   * body loses its sculpting the moment a face is moved, silently and much
   * later. So sculpting a lattice body bakes it: `isLattice` goes off, this
   * goes on, and the cage stays in the file. Undo puts all three back.
   */
  latticeBaked?: boolean;
  /** Set once a face has been drawn, so a reset can warn before discarding it. */
  latticeEdited?: boolean;
  isComposite?: boolean;
  compositeType?: 'cable' | 'grid' | 'rope' | 'cloth';
  compositeCount?: string;
  compositeSize?: string;
  compositePrefix?: string;
  compositeCurve?: string;
  weldLastToId?: string;
}

export interface SceneGraph {
  nodes: SceneNode[];
}
