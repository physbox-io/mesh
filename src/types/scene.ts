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
  hardwareSpec?: any;
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
