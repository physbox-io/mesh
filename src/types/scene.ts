export type GeomType = 'capsule' | 'sphere' | 'box' | 'plane' | 'cylinder' | 'ellipsoid' | 'mesh';
export type JointType = 'hinge' | 'slide' | 'ball' | 'free';

export interface SceneGeom {
  name: string;
  type: GeomType;
  size: number[];
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
  script?: string;
  scad?: string;
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
