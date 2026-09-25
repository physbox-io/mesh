// ---------------------------------------------------------------------------
// Scaling a body, and everything under it
// ---------------------------------------------------------------------------
//
// Shared by the inspector's Scale card and by the S gesture in the viewport,
// which are two ways of asking for the same thing. It lives out here rather
// than in either of them because a module that exports a component and a
// function is a module that cannot hot-reload cleanly.
// ---------------------------------------------------------------------------

import { useStore, scaleMeshGeoms, cloneSceneGraph } from '../store/useStore';
import type { SceneGeom, SceneNode } from '../types/scene';
import * as THREE from 'three';
import { geomBounds, reconcileCuts } from './csg';

/**
 * How one geom's size responds to a per-axis scale.
 *
 * MuJoCo's size array means something different for every shape, and treating
 * it as three axes — or as one average — is how "make this cylinder longer"
 * came out as "make this cylinder fatter". Each shape is asked in its own
 * terms: a box has three half-extents, a cylinder has a radius and a length
 * along its own Z, and a sphere has neither.
 */
export function scaledSize(type: string | undefined, size: number[], sx: number, sy: number, sz: number): number[] {
  const mean = (sx + sy + sz) / 3;
  // A radius lies in the XY plane whatever else is happening, so the two
  // lateral factors are the ones that can change it.
  const radial = (sx + sy) / 2;
  switch (type) {
    case 'box':
    case 'ellipsoid':
      return size.length >= 3 ? [size[0] * sx, size[1] * sy, size[2] * sz, ...size.slice(3)] : size.map((v) => v * mean);
    case 'cylinder':
    case 'capsule':
      // [radius, half-length], the length along the geom's own Z.
      return size.length >= 2 ? [size[0] * radial, size[1] * sz, ...size.slice(2)] : size.map((v) => v * mean);
    case 'sphere':
      return size.map((v) => v * mean);
    case 'plane':
      return size;
    default:
      return size.map((v) => v * mean);
  }
}

/**
 * Scales what a cut MEANS — where it goes into the part, which way, how deep,
 * and its outline across the face — rather than the primitive it is built as.
 *
 * A cut is rebuilt from those numbers whenever the part changes (see
 * reconcileCuts), so scaling only its `size` and `pos` lasted until the next
 * edit, which put every hole back where and how big it was before the scale.
 *
 * The direction goes by the inverse-transpose, as a surface normal must: a
 * face at 45° on a block stretched in X is no longer at 45°. Lengths across
 * the face are read in the cut's own frame, before and after.
 */
function scaleCutIntent(g: SceneGeom, sx: number, sy: number, sz: number) {
  const S = new THREE.Vector3(sx, sy, sz);
  const Z = new THREE.Vector3(0, 0, 1);
  const n = new THREE.Vector3(...(g.cutNormal as [number, number, number])).normalize();
  const n2 = new THREE.Vector3(n.x / sx, n.y / sy, n.z / sz).normalize();
  const frame = (normal: THREE.Vector3) => {
    const q = new THREE.Quaternion().setFromUnitVectors(Z, normal);
    if (g.cutTwist) q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, g.cutTwist));
    return [new THREE.Vector3(1, 0, 0).applyQuaternion(q), new THREE.Vector3(0, 1, 0).applyQuaternion(q)];
  };
  const [ax, ay] = frame(n);
  const [bx, by] = frame(n2);
  const stretch = (v: THREE.Vector3) => v.clone().multiply(S).length();
  const across = (stretch(ax) + stretch(ay)) / 2;

  g.cutAt = (g.cutAt ?? [0, 0, 0]).map((v, a) => v * [sx, sy, sz][a]);
  // Depth is a distance between two faces parallel to the surface, so it is
  // measured along the NEW normal.
  if (g.cutDepth) g.cutDepth *= Math.abs(n.clone().multiply(S).dot(n2));
  g.cutNormal = n2.toArray();
  if (g.cutBorder) g.cutBorder *= across;
  if (g.cutOutline) {
    g.cutOutline = g.cutOutline.map(([x, y]) => {
      const p = ax.clone().multiplyScalar(x).addScaledVector(ay, y).multiply(S);
      return [p.dot(bx), p.dot(by)];
    });
  } else if (g.size) {
    const size = [...g.size];
    if (g.type === 'box') {
      size[0] *= stretch(ax);
      size[1] *= stretch(ay);
    } else if (g.type === 'sphere') {
      size[0] *= (sx + sy + sz) / 3;
    } else {
      size[0] *= across;
    }
    g.size = size;
  }
}

/**
 * Multiplies a body, and everything under it, by a per-axis factor.
 *
 * The axes are the BODY's own — the same ones its size and position rows use.
 * On an unrotated body they are the world's; on a rotated one they turn with
 * it, because that is the only frame a box's half-extents or a mesh's vertices
 * are expressed in.
 *
 * Parametric bodies (a wedge, a cone, a tube, a curve) carry both a generated
 * mesh and the numbers it was generated from, so both are scaled. Scaling only
 * the mesh would look right until the next time a parameter was touched, at
 * which point the shape would spring back to its old size.
 */
export function scaleNodeTree(nodeId: string, sx: number, sy: number, sz: number) {
  const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
  const find = (nodes: SceneNode[]): SceneNode | null => {
    for (const n of nodes) {
      if (n.id === nodeId) return n;
      const c = find(n.children ?? []);
      if (c) return c;
    }
    return null;
  };
  const node = find(newScene.nodes);
  if (!node) return;

  const mean = (sx + sy + sz) / 3;
  const radial = (sx + sy) / 2;

  const scaleNode = (n: SceneNode) => {
    // A gear is defined by its tooth count and pitch radius, and its geoms are
    // regenerated from those; scaling the shapes it happens to be drawn with
    // would put the teeth out of step with the mesh it has to run against.
    if ((n as { teeth?: number }).teeth !== undefined) return;

    scaleMeshGeoms(n, sx, sy, sz);
    let cuts = false;
    for (const g of n.geoms ?? []) {
      if (g.cutAt && g.cutNormal && !g.csgDerived) {
        scaleCutIntent(g, sx, sy, sz);
        cuts = true;
        continue;
      }
      if (g.type !== 'mesh' && g.size) g.size = scaledSize(g.type, g.size, sx, sy, sz);
      if (g.pos) g.pos = [g.pos[0] * sx, g.pos[1] * sy, g.pos[2] * sz];
      if (g.fromto) g.fromto = [
        g.fromto[0] * sx, g.fromto[1] * sy, g.fromto[2] * sz,
        g.fromto[3] * sx, g.fromto[4] * sy, g.fromto[5] * sz,
      ];
    }

    // The cuts are rebuilt now, against the shapes at their new size, rather
    // than left as whatever the next edit happens to make of them.
    if (cuts) reconcileCuts(n);

    // The numbers a generated shape is generated FROM. Named per shape rather
    // than scaled blindly: `radius` is lateral on a cone and `height` is along
    // Z, and a torus has two radii that mean different things.
    const p = n as unknown as Record<string, number | number[][] | undefined>;
    const times = (key: string, factor: number) => {
      const value = p[key];
      if (typeof value === 'number') p[key] = value * factor;
    };
    times('width', sx);
    times('depth', sy);
    times('height', sz);
    times('radius', radial);
    times('majorRadius', radial);
    times('tubeRadius', mean);
    times('innerRadius', radial);
    times('outerRadius', radial);
    times('pulleyRadius', radial);
    times('curveWidth', radial);
    times('curveThickness', sz);
    const points = p.curvePoints;
    if (Array.isArray(points)) {
      p.curvePoints = points.map((point) => [point[0] * sx, point[1] * sy, point[2] * sz]);
    }

    // Child offsets travel with the scale, or an assembly comes apart.
    for (const child of (n.children ?? [])) {
      if (child.pos) child.pos = [child.pos[0] * sx, child.pos[1] * sy, child.pos[2] * sz];
      scaleNode(child);
    }
  };
  scaleNode(node);
  useStore.getState().updateScene(newScene);
}

/**
 * Which way a bore runs through a body, in the body's own frame.
 *
 * `open` is the face it comes in from: 1 for the face on the + side of the
 * axis, -1 for the − side, and 0 for right through both. A bore open on one
 * face only is a pocket — a tray, a cup, a recess — with a floor left in it.
 */
export interface Bore {
  axis: 0 | 1 | 2;
  open: 1 | -1 | 0;
}

/**
 * How far a bore runs past a face it comes out of, as a fraction of the body's
 * length along it. A flush cut leaves coincident faces, which is the one thing
 * a boolean evaluator cannot decide about.
 */
export const BORE_OVERSHOOT = 0.025;

/**
 * The per-axis factors of the copy that cuts a bore, for a given wall.
 *
 * `wall` is the factor across the bore: 0.8 leaves walls a tenth of the body's
 * width each side. Along it, a bore right through is longer than the body at
 * both ends; a pocket is longer at its open end only and leaves a floor as
 * thick, in proportion, as the walls — on a cube, exactly as thick.
 */
export function boreFactors(wall: number, bore: Bore): [number, number, number] {
  const along = bore.open === 0 ? 1 + 2 * BORE_OVERSHOOT : 1 + BORE_OVERSHOOT - (1 - wall) / 2;
  return [0, 1, 2].map((a) => (a === bore.axis ? along : wall)) as [number, number, number];
}

/** Where a set of geoms starts and ends along one body axis, or null if they have no extent. */
function spanAlong(geoms: SceneGeom[], axis: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const g of geoms) {
    let b = geomBounds(g);
    // A static mesh keeps only its Y-up `vertices`, which geomBounds does not
    // read. Brought into the body's Z-up frame the way mjcf.ts does it.
    if (!b && g.type === 'mesh' && g.vertices?.length) {
      const v = g.vertices as number[];
      const off = g.pos || [0, 0, 0];
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < v.length; i += 3) {
        const p = [v[i], -v[i + 2], v[i + 1]];
        for (let a = 0; a < 3; a++) {
          const c = p[a] + (off[a] || 0);
          if (c < min[a]) min[a] = c;
          if (c > max[a]) max[a] = c;
        }
      }
      b = { min, max };
    }
    if (!b) continue;
    lo = Math.min(lo, b.min[axis]);
    hi = Math.max(hi, b.max[axis]);
  }
  return hi > lo ? [lo, hi] : null;
}

/** Slides a geom along one body axis, whatever it is made of. */
function shiftGeom(g: SceneGeom, axis: number, d: number) {
  if (g.type === 'mesh') {
    // renderVertices are Z-up like the body; `vertices` are Y-up, where the
    // body's Y is −Z and its Z is Y (see mjcf.ts).
    if (g.renderVertices) {
      const v = [...g.renderVertices];
      for (let i = axis; i < v.length; i += 3) v[i] += d;
      g.renderVertices = v;
    }
    if (g.vertices) {
      const v = [...(g.vertices as number[])];
      const [k, sign] = axis === 0 ? [0, 1] : axis === 1 ? [2, -1] : [1, 1];
      for (let i = k; i < v.length; i += 3) v[i] += sign * d;
      g.vertices = v;
    }
    return;
  }
  const pos = [...(g.pos ?? [0, 0, 0])];
  pos[axis] += d;
  g.pos = pos as typeof g.pos;
  if (g.fromto) {
    const f = [...g.fromto];
    f[axis] += d;
    f[axis + 3] += d;
    g.fromto = f as typeof g.fromto;
  }
}

/**
 * A scaled copy of a body's own shapes, marked as holes.
 *
 * The shortest path from a solid to a hollow one: a cylinder with a 0.9 copy of
 * itself subtracted is a pipe, a box with one inside it is a tray. Returned
 * rather than installed, so the arithmetic can be checked without a scene.
 *
 * Factors are per-axis, which is what makes it more than a shell: 1 on two of
 * them cuts a slot instead.
 *
 * With `pocket`, the copy is slid along that axis until its end stands just
 * past the face named, so it opens on that face alone — which is what makes a
 * pocket of a copy that would otherwise sit in the middle as a sealed cavity.
 */
export function insetNegatives(
  node: SceneNode,
  [fx, fy, fz]: [number, number, number],
  pocket?: { axis: 0 | 1 | 2; side: 1 | -1 },
): SceneGeom[] {
  // Above 1 on an axis is how a bore is asked to pass right THROUGH: a copy cut
  // flush with the surface it emerges from leaves two coincident faces, which
  // is the one thing a boolean evaluator cannot decide about. At least one axis
  // has to come in, or there is nothing left of the body to keep.
  if (![fx, fy, fz].every((f) => Number.isFinite(f) && f > 0 && f <= 4)) return [];
  if (fx >= 1 && fy >= 1 && fz >= 1) return [];

  // What there is to cut into: the body's own positive shapes. Derived boolean
  // output is not a source — copying it would nest one evaluation inside the
  // next — and a plane has no volume to hollow.
  const positives = (node.geoms ?? []).filter((g) =>
    !g.csgDerived && (!g.csg || g.csg === 'union') && g.type !== 'plane');
  if (positives.length === 0) return [];

  const copies = positives.map((g, i) => {
    const copy = {
      ...g,
      name: `${g.name || `geom${i}`}_inset`,
      csg: 'difference',
      // Red, like every other negative in this app: a hole you cannot see is a
      // hole you cannot aim.
      rgba: [0.9, 0.25, 0.35, 1],
    } as SceneGeom & { mass?: number; csgDerived?: unknown };
    // A hole weighs nothing — resolveCsgGeoms drops negatives before the mass
    // split — and a copied mass would be a lie in the inspector.
    delete copy.mass;
    delete copy.csgDerived;
    if (copy.size) copy.size = scaledSize(copy.type, copy.size, fx, fy, fz);
    if (copy.pos) copy.pos = [copy.pos[0] * fx, copy.pos[1] * fy, copy.pos[2] * fz];
    if (copy.fromto) copy.fromto = [
      copy.fromto[0] * fx, copy.fromto[1] * fy, copy.fromto[2] * fz,
      copy.fromto[3] * fx, copy.fromto[4] * fy, copy.fromto[5] * fz,
    ];
    return copy as SceneGeom;
  });

  // Mesh copies are scaled the way the inspector would scale them, about their
  // own centroid, so a hollowed mesh keeps its walls even in thickness.
  scaleMeshGeoms({ geoms: copies }, fx, fy, fz);

  if (pocket) {
    const body = spanAlong(positives, pocket.axis);
    const copy = spanAlong(copies, pocket.axis);
    if (body && copy) {
      const overshoot = BORE_OVERSHOOT * (body[1] - body[0]);
      const d = pocket.side > 0 ? body[1] + overshoot - copy[1] : body[0] - overshoot - copy[0];
      for (const g of copies) shiftGeom(g, pocket.axis, d);
    }
  }
  return copies;
}
