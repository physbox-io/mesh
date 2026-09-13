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
    for (const g of n.geoms ?? []) {
      if (g.type !== 'mesh' && g.size) g.size = scaledSize(g.type, g.size, sx, sy, sz);
      if (g.pos) g.pos = [g.pos[0] * sx, g.pos[1] * sy, g.pos[2] * sz];
      if (g.fromto) g.fromto = [
        g.fromto[0] * sx, g.fromto[1] * sy, g.fromto[2] * sz,
        g.fromto[3] * sx, g.fromto[4] * sy, g.fromto[5] * sz,
      ];
    }

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
 * A scaled copy of a body's own shapes, marked as holes.
 *
 * The shortest path from a solid to a hollow one: a cylinder with a 0.9 copy of
 * itself subtracted is a pipe, a box with one inside it is a tray. Returned
 * rather than installed, so the arithmetic can be checked without a scene.
 *
 * Factors are per-axis, which is what makes it more than a shell: 1 on two of
 * them cuts a slot instead.
 */
export function insetNegatives(node: SceneNode, [fx, fy, fz]: [number, number, number]): SceneGeom[] {
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
  return copies;
}
