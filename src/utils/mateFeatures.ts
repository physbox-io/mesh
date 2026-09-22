// ---------------------------------------------------------------------------
// Reading matable features off the drawn scene
// ---------------------------------------------------------------------------
//
// `mateSnap.ts` solves a mate given two lists of features. This finds them, and
// it reads them from the DRAWN scene rather than from the document — for the
// same reason `measureScene.ts` does. The drawn scene is where transforms have
// actually been applied, where a boolean has already been evaluated, and where
// a lattice cage has already become the smoothed, walled, recentred mesh that
// anyone would put a part against. The document describes a shape that is often
// not the one on screen.
//
// Most of the work is already done: `sceneCandidates` hunts down corners, edge
// midpoints, analytic centres and — the one that matters most here — the centre
// of a circle refitted from the vertices around a hole's rim, which is how a
// hole survives the boolean that created it. What this file adds is the two
// things a measurement never needed:
//
// - FACES, which no candidate hunt produces because measuring never wanted one.
//   Taken from each drawn mesh's bounding box: six centres and six outward
//   normals. Exact for a box and for anything whose outer faces are square to
//   its own frame, which here is nearly everything — extrusions, lattice parts,
//   most boolean results. For a wedge or a revolve it simply declines to offer
//   a face rather than offering a wrong one, and the part still mates by its
//   corners and its holes.
//
// - A BUDGET. This runs against a live drag, so both lists are capped and the
//   caps are spent on the most specific features first. The moving body is kept
//   deliberately lean — its features are re-transformed every frame — and is
//   built from exact construction parameters and its bounding box only, never
//   from vertex soup. The expensive hunt, circle fitting included, is done once
//   on the STATIONARY side, where it is centred on the drag and can be reused
//   until the drag wanders away from where it was gathered.
//
// Everything leaves here in the MuJoCo Z-up frame, in metres — the frame the
// gizmo's drag arithmetic is written in — converted exactly once, at the bottom
// of this file. Directions go through the same map as points, which is sound
// because the map is a pure rotation.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { sceneCandidates, toMujoco, toThree } from './measureScene';
import { csgFrameOffset, csgSourceGeoms, geomMatrixOf, fromtoFrame } from './csg';
import type { SceneGeom, SceneNode } from '../types/scene';
import type { SnapCandidate, Vec3 } from './measureSnap';
import type { AxisFeature, FaceFeature, MateFeature, PointFeature } from './mateSnap';

/** Where a body actually is: its origin and its rotation, in MuJoCo world. */
export interface Pose {
  pos: THREE.Vector3;
  rot: THREE.Matrix3;
}

/**
 * The holes and bosses a body's DOCUMENT describes.
 *
 * The one thing the drawn scene cannot reliably give back. A hole here is a
 * cylinder subtracted from a solid, and once the boolean is evaluated all that
 * survives on screen is a ring of vertices around its mouth — which the measure
 * tool recovers by fitting a circle to them, but only when it is looking at a
 * small patch right at the rim. A drag has no such patch: it needs every hole
 * on a part at once, from wherever the part happens to be, and a circle fit
 * over a whole body finds nothing at all because most of a body is not a
 * circle. The cut that made the hole is still in the document, exact, with its
 * radius and its axis — so that is where to read it from.
 *
 * Positives count too: a cylinder added to a body is a boss, and a boss going
 * into a counterbore is the same gesture the other way round.
 *
 * TWO FRAMES, and they are not the same one. A negative's `pos` is written in
 * the frame the body was AUTHORED in, while the compiled solid is re-origined
 * on its own centre of mass — `csgFrameOffset` is the difference, and skipping
 * it puts a hole a few millimetres to one side of where it is drawn. The plate
 * in this app's own docs is off by 4.5 mm that way.
 */
export function documentAxes(node: SceneNode, pose: Pose): AxisFeature[] {
  const offset = csgFrameOffset(node);
  const out: AxisFeature[] = [];

  for (const geom of csgSourceGeoms(node)) {
    if (geom.type !== 'cylinder') continue;
    const bore = geom.csg === 'difference';

    // A cylinder may be authored as two endpoints instead of a centre and a
    // length; `fromtoFrame` reduces that to the same thing.
    const matrix = geom.fromto && geom.fromto.length >= 6
      ? fromtoFrame(geom.fromto).matrix
      : geomMatrixOf(geom);

    const local = new THREE.Vector3().setFromMatrixPosition(matrix);
    local.set(local.x - (offset[0] ?? 0), local.y - (offset[1] ?? 0), local.z - (offset[2] ?? 0));
    const at = local.clone().applyMatrix3(pose.rot).add(pose.pos);

    // A cylinder geom runs along its own +Z, MuJoCo's convention.
    const dir = new THREE.Vector3(0, 0, 1)
      .applyMatrix4(new THREE.Matrix4().extractRotation(matrix))
      .applyMatrix3(pose.rot)
      .normalize();

    const radius = radiusOf(geom);
    if (!(radius > 0)) continue;

    out.push({
      kind: 'axis',
      point: [at.x, at.y, at.z],
      dir: [dir.x, dir.y, dir.z],
      radius,
      label: `${bore ? 'hole' : 'boss'} in ${node.name || node.id}`,
      nodeId: node.id,
    });
  }
  return out;
}

const radiusOf = (geom: SceneGeom): number => geom.size?.[0] ?? 0;

/**
 * Every hole and boss in the scene graph near a point, except one body's.
 *
 * `poseOf` is passed in rather than read from the store, so this stays a
 * function of its arguments and can be tested without a running simulation.
 */
export function graphAxes(
  nodes: SceneNode[],
  poseOf: (nodeId: string, fallback: number[]) => Pose,
  options: { exclude?: string; near: Vec3; radius: number },
): AxisFeature[] {
  const here = new THREE.Vector3(...options.near);
  const out: AxisFeature[] = [];
  const walk = (list: SceneNode[]) => {
    for (const node of list) {
      if (node.id !== options.exclude) {
        for (const axis of documentAxes(node, poseOf(node.id, node.pos))) {
          // Judged on the axis POINT rather than on the body, so a long bar's
          // far end does not drag every hole in it into reach.
          if (here.distanceTo(new THREE.Vector3(...axis.point)) <= options.radius) out.push(axis);
        }
      }
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/** The dragged body is re-transformed every frame, so it stays small. */
export const MAX_MOVING_FEATURES = 64;
/** The rest of the scene is gathered once, so it can afford to be richer. */
export const MAX_FIXED_FEATURES = 256;

/** A face smaller than this is a sliver from a degenerate box; it mates with nothing. */
const MIN_FACE_EXTENT = 1e-5;

/** Which features are worth keeping when the budget runs out. */
const KEEP_ORDER: Record<MateFeature['kind'], number> = { axis: 0, face: 1, point: 2 };

const capped = (features: MateFeature[], limit: number): MateFeature[] => (
  features.length <= limit
    ? features
    : [...features].sort((a, b) => KEEP_ORDER[a.kind] - KEEP_ORDER[b.kind]).slice(0, limit)
);

/** The body a drawn object belongs to: the nearest named group above it. */
function bodyOf(object: THREE.Object3D): string | null {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node.type === 'Group' && node.name) return node.name;
  }
  return null;
}

/**
 * The six faces of a mesh's bounding box, in three.js world space.
 *
 * The box is in the mesh's own frame, so its centres go through `matrixWorld`
 * and its normals through the rotation alone. `extent` is half the LARGER of
 * the two in-plane dimensions: it is used to ask whether two faces overlap at
 * all, and being generous there only means a mate is offered in a case a person
 * would call reasonable.
 */
function boxFaces(mesh: THREE.Mesh, nodeId: string): FaceFeature[] {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) return [];
  const centre = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  if (!(half.x > 0) || !(half.y > 0) || !(half.z > 0)) return [];

  const turn = mesh.getWorldQuaternion(new THREE.Quaternion());
  const scale = mesh.getWorldScale(new THREE.Vector3());
  const out: FaceFeature[] = [];
  const axes: [keyof THREE.Vector3 & ('x' | 'y' | 'z'), Vec3][] = [
    ['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]],
  ];

  axes.forEach(([key, unit], i) => {
    for (const sign of [-1, 1]) {
      const local = centre.clone();
      local[key] += sign * half[key];
      const at = mesh.localToWorld(local);
      const normal = new THREE.Vector3(...unit).multiplyScalar(sign).applyQuaternion(turn).normalize();
      // The two dimensions that lie IN this face, scaled into world units.
      const spread = [half.x * Math.abs(scale.x), half.y * Math.abs(scale.y), half.z * Math.abs(scale.z)];
      const inPlane = [0, 1, 2].filter((k) => k !== i).map((k) => spread[k]);
      const extent = Math.max(inPlane[0], inPlane[1]);
      if (!(extent > MIN_FACE_EXTENT)) continue;
      out.push({
        kind: 'face',
        point: [at.x, at.y, at.z],
        normal: [normal.x, normal.y, normal.z],
        extent,
        label: `${key === 'z' ? (sign > 0 ? 'top' : 'bottom') : 'side'} face of ${nodeId}`,
        nodeId,
      });
    }
  });
  return out;
}

/** A snap candidate as a matable feature, where it is one. */
function asFeature(candidate: SnapCandidate): MateFeature | null {
  const { point, label, nodeId } = candidate;
  if (candidate.kind === 'centre' && candidate.normal && candidate.radius !== undefined) {
    const axis: AxisFeature = {
      kind: 'axis', point, dir: candidate.normal, radius: candidate.radius, label, nodeId,
    };
    return axis;
  }
  if (candidate.kind === 'centre' || candidate.kind === 'vertex' || candidate.kind === 'midpoint') {
    const at: PointFeature = { kind: 'point', point, label, nodeId };
    return at;
  }
  // An `edge` or a `surface` is a place on a body, not a feature of it: mating
  // to the middle of a face you happened to be pointing at would snap to noise.
  return null;
}

/** Every mesh drawn under these objects, skipping the overlays that opt out. */
function meshesUnder(roots: THREE.Object3D[]): { mesh: THREE.Mesh; nodeId: string }[] {
  const found: { mesh: THREE.Mesh; nodeId: string }[] = [];
  for (const root of roots) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
      const nodeId = bodyOf(mesh);
      if (nodeId) found.push({ mesh, nodeId });
    });
  }
  return found;
}

/**
 * The dragged body's own features, in the MuJoCo frame, at the pose it is in.
 *
 * Analytic centres and bounding-box faces only — see the header. Call this once
 * when the drag starts and carry the result through the drag with
 * `transformFeatures`, rather than re-reading a scene that is mid-move.
 */
export function bodyFeatures(groups: THREE.Object3D[], nodeId: string): MateFeature[] {
  const meshes = meshesUnder(groups).filter((m) => m.nodeId === nodeId);
  if (meshes.length === 0) return [];

  const centre = new THREE.Vector3();
  for (const { mesh } of meshes) centre.add(mesh.getWorldPosition(new THREE.Vector3()));
  centre.divideScalar(meshes.length);

  const found: MateFeature[] = [];
  for (const { mesh } of meshes) found.push(...boxFaces(mesh, nodeId));

  /*
   * The analytic features — a cylinder's axis, a box's corners — plus the hole
   * the circle hunt recovers, which is worth having on this side too: dropping
   * a plate onto a peg is the same gesture as dropping a peg into a plate.
   *
   * Asked of THIS BODY'S GROUPS, not of the scene. The hunt culls by distance,
   * but the radius here has to cover the whole part rather than a pointer's
   * neighbourhood, so pointing it at the scene root would walk every other body
   * as well and throw the answers away.
   */
  const reach = boundsRadius(groups) * 2 + 0.01;
  const at: Vec3 = [centre.x, centre.y, centre.z];
  for (const group of groups) {
    for (const candidate of sceneCandidates(group, at, reach)) {
      if (candidate.nodeId !== nodeId) continue;
      const feature = asFeature(candidate);
      if (feature) found.push(feature);
    }
  }

  return capped(found.map(intoMujoco), MAX_MOVING_FEATURES);
}

/**
 * Everything ELSE near the drag that could be mated to.
 *
 * `near` is in the MuJoCo frame, like the drag. The dragged body is excluded
 * before the scan rather than after, because a body mating with its own
 * features would simply hold still.
 */
export function neighbourFeatures(
  root: THREE.Object3D,
  exclude: string,
  near: Vec3,
  radius: number,
): MateFeature[] {
  const here = toThree(near);
  const found: MateFeature[] = [];

  for (const candidate of sceneCandidates(root, here, radius, { exclude })) {
    const feature = asFeature(candidate);
    if (feature) found.push(feature);
  }

  const at = new THREE.Vector3(...here);
  for (const { mesh, nodeId } of meshesUnder([root])) {
    if (nodeId === exclude) continue;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere?.clone();
    if (sphere) {
      sphere.applyMatrix4(mesh.matrixWorld);
      if (sphere.distanceToPoint(at) > radius) continue;
    }
    found.push(...boxFaces(mesh, nodeId));
  }

  return capped(found.map(intoMujoco), MAX_FIXED_FEATURES);
}

/**
 * Carries start-of-drag features through to where the drag has got to.
 *
 * `turn`, `pivot` and `delta` are exactly what `TransformGizmo.preview` applies
 * to the drawn groups, and deliberately so: if these two disagreed, the part
 * would mate to a place it is not drawn. For a straight move `turn` is the
 * identity and this is a translation.
 */
export function transformFeatures(
  features: MateFeature[],
  turn: THREE.Quaternion,
  pivot: THREE.Vector3,
  delta: THREE.Vector3,
): MateFeature[] {
  const movePoint = (p: Vec3): Vec3 => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).sub(pivot).applyQuaternion(turn).add(pivot).add(delta);
    return [v.x, v.y, v.z];
  };
  const turnDir = (d: Vec3): Vec3 => {
    const v = new THREE.Vector3(d[0], d[1], d[2]).applyQuaternion(turn);
    return [v.x, v.y, v.z];
  };
  return features.map((feature) => {
    if (feature.kind === 'point') return { ...feature, point: movePoint(feature.point) };
    if (feature.kind === 'axis') return { ...feature, point: movePoint(feature.point), dir: turnDir(feature.dir) };
    return { ...feature, point: movePoint(feature.point), normal: turnDir(feature.normal) };
  });
}

// ---------------------------------------------------------------------------
// Frames and bounds
// ---------------------------------------------------------------------------

/** How far this body reaches from its own middle, in world units. */
function boundsRadius(groups: THREE.Object3D[]): number {
  const box = new THREE.Box3();
  for (const group of groups) box.union(new THREE.Box3().setFromObject(group));
  if (box.isEmpty()) return 0.05;
  return box.getSize(new THREE.Vector3()).length() / 2;
}

/**
 * Three's Y-up world into MuJoCo's Z-up, for a whole feature.
 *
 * The one place the swap happens. `toMujoco` is a pure rotation, so a direction
 * takes exactly the same map as a point — no inverse-transpose is needed, and
 * a normal stays a unit vector.
 */
function intoMujoco(feature: MateFeature): MateFeature {
  if (feature.kind === 'point') return { ...feature, point: toMujoco(feature.point) };
  if (feature.kind === 'axis') return { ...feature, point: toMujoco(feature.point), dir: toMujoco(feature.dir) };
  return { ...feature, point: toMujoco(feature.point), normal: toMujoco(feature.normal) };
}
