// ---------------------------------------------------------------------------
// Measuring the drawn scene, for a caller with no pointer
// ---------------------------------------------------------------------------
//
// The viewport's measure tool snaps a CLICK to the nearest interesting feature.
// An agent has no click; what it has is a coordinate it worked out from the
// scene graph, which is nearly always a little off the thing it meant — the
// centre of a bounding box rather than the centre of the hole in it, or a
// corner named to the tenth of a millimetre on a part that got recentred on its
// own centre of mass.
//
// So the same snapping runs here, against the drawn scene rather than the
// document. The drawn scene is the right thing to measure: it is where the
// transforms have actually been applied, where a boolean has already been
// evaluated, and where a lattice cage has already become the smoothed, walled,
// recentred mesh that anybody would put a caliper on. Measuring the document
// instead would answer questions about a shape that is not the one on screen.
//
// Coordinates in and out are the MuJoCo frame in metres, like every other MCP
// call; the Z-up/Y-up swap into the renderer's frame happens here and nowhere
// else.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  chooseSnapNear, detectCircle, formatMm, measureAngle, measureDistance, nearbyVertices,
  type SnapCandidate, type Vec3,
} from './measureSnap';

/** A scene point in the frame bodies are drawn in, from a MuJoCo coordinate. */
export const toThree = (p: Vec3): Vec3 => [p[0], p[2], -p[1]];
/** And back. */
export const toMujoco = (p: Vec3): Vec3 => [p[0], -p[2], p[1]];

export interface SceneSnap extends SnapCandidate {
  /** Which body it belongs to, so a reply can say what was measured. */
  nodeId?: string;
  /** How far the given point had to move to land on it, in metres. */
  movedBy: number;
}

/** True when `object` or any ancestor is an overlay or background scenery rather than model geometry. */
export function isIgnoredSceneObject(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node.userData?.isOverlay || node.userData?.isBackground) return true;
  }
  return false;
}

/** True when a mesh's material is actually visible (not hidden or translucent-zero `rgba[3] === 0`). */
export function isMeshMaterialVisible(mesh: THREE.Mesh): boolean {
  const mat = mesh.material;
  if (!mat) return true;
  const visibleOne = (m: THREE.Material) => m.visible !== false && !(m.transparent && m.opacity <= 0);
  return Array.isArray(mat) ? mat.some(visibleOne) : visibleOne(mat);
}

/** True when a transform matrix has finite entries and non-zero scale on all three axes. */
export function hasNonZeroScale(matrix: THREE.Matrix4): boolean {
  const e = matrix.elements;
  for (let i = 0; i < 16; i++) if (!Number.isFinite(e[i])) return false;
  const sx = Math.hypot(e[0], e[1], e[2]);
  const sy = Math.hypot(e[4], e[5], e[6]);
  const sz = Math.hypot(e[8], e[9], e[10]);
  return sx > 1e-9 && sy > 1e-9 && sz > 1e-9;
}

/**
 * True when this object is part of a body rather than part of the scenery.
 *
 * Every geom is drawn inside a `<group name={nodeId}>` and nothing else in the
 * canvas is, which separates the model from the floor grid and the overlays
 * without keeping a list of them. Walks all the way to the root so an
 * `isOverlay` or `isBackground` ancestor always wins over a named descendant.
 */
export function bodyOf(object: THREE.Object3D): string | null {
  let found: string | null = null;
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node.userData?.isOverlay || node.userData?.isBackground) return null;
    if (found === null) {
      // Said outright by a layer that draws a body outside the body's own group —
      // the lattice editor's is named `<id>_lattice`, which is no body's name.
      if (typeof node.userData?.bodyId === 'string' && node.userData.bodyId) found = node.userData.bodyId;
      else if (node.type === 'Group' && node.name) found = node.name;
    }
  }
  return found;
}

/**
 * The twelve edge midpoints of a box, as offsets in its own half-extents.
 *
 * An edge is the pair of axes whose sign is fixed; the third runs along it and
 * is zero at the middle. Written out as the axis left free rather than as
 * twelve literals, so it cannot be one corner short.
 *
 * Only for boxes, and deliberately so. A midpoint recovered from triangle soup
 * is the middle of whatever edge the tessellator happened to draw, which moves
 * when the mesh is re-tessellated and means nothing on a curved surface — it
 * would be noise competing with the corners that ARE real.
 */
function boxEdgeMidpoints(): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let along = 0; along < 3; along++) {
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const offset: [number, number, number] = [0, 0, 0];
      const others = [0, 1, 2].filter((i) => i !== along);
      offset[others[0]] = a;
      offset[others[1]] = b;
      out.push(offset);
    }
  }
  return out;
}

/** The centres a primitive has by construction, in world space. */
function analyticCentres(mesh: THREE.Mesh, nodeId: string | null): SnapCandidate[] {
  const parameters = (mesh.geometry as unknown as { parameters?: Record<string, number> }).parameters;
  const type = mesh.geometry.type;
  const out: SnapCandidate[] = [];
  const world = (x: number, y: number, z: number): Vec3 => {
    const point = mesh.localToWorld(new THREE.Vector3(x, y, z));
    return [point.x, point.y, point.z];
  };
  const named = (label: string) => (nodeId ? `${label} of ${nodeId}` : label);
  const id = nodeId ?? undefined;

  const scale = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
  const e = mesh.matrixWorld.elements;

  if (type === 'SphereGeometry') {
    const even = scale.x > 1e-9 &&
      Math.abs(scale.x - scale.y) <= 1e-3 * scale.x &&
      Math.abs(scale.x - scale.z) <= 1e-3 * scale.x;
    const radius = even && parameters?.radius !== undefined ? parameters.radius * scale.x : undefined;
    out.push({
      point: world(0, 0, 0),
      kind: 'centre',
      label: named(even ? 'sphere centre' : 'ellipsoid centre'),
      radius,
      nodeId: id,
    });
  } else if (type === 'CylinderGeometry' || type === 'CapsuleGeometry') {
    const half = ((parameters?.height ?? parameters?.length ?? 0) as number) / 2;
    const rawRadius = (parameters?.radiusTop ?? parameters?.radius) as number | undefined;
    const evenRadial = Math.max(scale.x, scale.z) > 1e-9 &&
      Math.abs(scale.x - scale.z) <= 1e-3 * Math.max(scale.x, scale.z);
    const radius = evenRadial && rawRadius !== undefined ? rawRadius * scale.x : undefined;
    /*
     * A cylinder is built along its OWN +Y whatever the group holding it has
     * been turned to, so the axis in world space is that direction carried
     * through the mesh's world matrix (column 1, which handles both rotations
     * and reflections).
     */
    const dir = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const axis: Vec3 = [dir.x, dir.y, dir.z];
    out.push({ point: world(0, 0, 0), kind: 'centre', label: named('axis centre'), radius, nodeId: id, normal: axis });
    if (half > 0) {
      out.push({ point: world(0, half, 0), kind: 'centre', label: named('end centre'), radius, nodeId: id, normal: axis });
      out.push({ point: world(0, -half, 0), kind: 'centre', label: named('end centre'), radius, nodeId: id, normal: axis });
    }
  } else if (type === 'BoxGeometry') {
    // Every corner, because corner-to-corner is the commonest measurement there
    // is and a box's corners are exact rather than tessellated.
    const [w, h, d] = [parameters?.width ?? 0, parameters?.height ?? 0, parameters?.depth ?? 0];
    const half: [number, number, number] = [w / 2, h / 2, d / 2];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      out.push({ point: world(sx * half[0], sy * half[1], sz * half[2]), kind: 'vertex', label: named('corner'), nodeId: id });
    }
    for (const [ex, ey, ez] of boxEdgeMidpoints()) {
      out.push({
        point: world(ex * half[0], ey * half[1], ez * half[2]),
        kind: 'midpoint',
        label: named('edge midpoint'),
        nodeId: id,
      });
    }
    out.push({ point: world(0, 0, 0), kind: 'centre', label: named('centre'), nodeId: id });
  }
  return out;
}

/**
 * The corners and centres of the boxes inside an InstancedMesh.
 *
 * Exact rather than tessellated: the shared geometry is a unit cube, so a
 * corner is one matrix multiply away and there is nothing to search. Only
 * instances near the point are considered, which is what keeps a track of forty
 * boxes from contributing three hundred and sixty candidates.
 */
function instancedCandidates(
  mesh: THREE.InstancedMesh, near: THREE.Vector3, radius: number, exclude?: string,
): SnapCandidate[] {
  if (isIgnoredSceneObject(mesh) || !isMeshMaterialVisible(mesh)) return [];
  const parameters = (mesh.geometry as unknown as { parameters?: Record<string, number> }).parameters;
  if (mesh.geometry.type !== 'BoxGeometry' || !parameters) return [];
  const ids = (mesh.userData?.nodeIds ?? []) as string[];
  const out: SnapCandidate[] = [];
  const matrix = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const instScale = new THREE.Vector3();
  const [w, h, d] = [parameters.width ?? 1, parameters.height ?? 1, parameters.depth ?? 1];

  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix);
    world.multiplyMatrices(mesh.matrixWorld, matrix);
    // StaticBoxInstances zeros hidden/uncompiled slots with makeScale(0, 0, 0);
    // never emit phantom candidates at the origin for them.
    if (!hasNonZeroScale(world)) continue;
    const centre = new THREE.Vector3().setFromMatrixPosition(world);
    // The half-diagonal of the instance, so a box is considered whenever any
    // part of it could be within reach rather than only when its middle is.
    instScale.setFromMatrixScale(world);
    const spread = Math.hypot(instScale.x * w, instScale.y * h, instScale.z * d) / 2;
    if (centre.distanceTo(near) > radius + spread) continue;

    const id = ids[i];
    if (exclude && id === exclude) continue;
    const label = id ? `corner of ${id}` : 'corner';
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const corner = new THREE.Vector3((sx * w) / 2, (sy * h) / 2, (sz * d) / 2).applyMatrix4(world);
      out.push({ point: [corner.x, corner.y, corner.z], kind: 'vertex', label, nodeId: id });
    }
    for (const [ex, ey, ez] of boxEdgeMidpoints()) {
      const mid = new THREE.Vector3((ex * w) / 2, (ey * h) / 2, (ez * d) / 2).applyMatrix4(world);
      out.push({
        point: [mid.x, mid.y, mid.z],
        kind: 'midpoint',
        label: id ? `edge midpoint of ${id}` : 'edge midpoint',
        nodeId: id,
      });
    }
    out.push({
      point: [centre.x, centre.y, centre.z],
      kind: 'centre',
      label: id ? `centre of ${id}` : 'centre',
      nodeId: id,
    });
  }
  return out;
}

/**
 * Everything worth snapping to within `radius` of a point in the drawn scene.
 *
 * The vertex scan is bounded twice — by the mesh's own bounding sphere, so a
 * body across the room is never walked at all, and by a vertex budget, so an
 * imported STL with a million triangles cannot stall the bridge.
 */
export function sceneCandidates(
  root: THREE.Object3D,
  world: Vec3,
  radius: number,
  options: { exclude?: string; maxMeshVertices?: number; vertexLimit?: number } = {},
): SnapCandidate[] {
  const here = new THREE.Vector3(...world);
  const found: SnapCandidate[] = [];
  const exclude = options.exclude;
  const maxMeshVertices = options.maxMeshVertices ?? 400_000;
  const vertexLimit = options.vertexLimit ?? 4096;

  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!isMeshMaterialVisible(mesh)) return;

    // Static boxes are drawn as ONE InstancedMesh of unit cubes — one draw call
    // for a whole curve track — so they have no named group and their real
    // transforms live in the instance matrices rather than in matrixWorld.
    // Skipping them would mean the corners of most of the scenery in a scene
    // could not be measured to.
    const instanced = mesh as unknown as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      found.push(...instancedCandidates(instanced, here, radius, exclude));
      return;
    }

    const nodeId = bodyOf(mesh);
    if (!nodeId) return;
    if (!hasNonZeroScale(mesh.matrixWorld)) return;
    /*
     * Dropped BEFORE the vertex scan, not filtered out of the result. A body
     * dragging against its own features would go nowhere, and the scan — a
     * walk of the positions plus a circle fit — is the expensive part, so the
     * body most likely to be near the point is exactly the one worth skipping
     * early.
     */
    if (exclude && nodeId === exclude) return;

    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const sphere = mesh.geometry.boundingSphere?.clone();
    if (sphere) {
      sphere.applyMatrix4(mesh.matrixWorld);
      if (sphere.distanceToPoint(here) > radius) return;
    }

    found.push(...analyticCentres(mesh, nodeId));

    const position = mesh.geometry.getAttribute('position');
    if (!position || position.count > maxMeshVertices) return;
    const local = mesh.worldToLocal(here.clone());
    const spread = new THREE.Vector3();
    mesh.getWorldScale(spread);
    // Use the smallest scale axis as the local search bound so non-uniformly
    // scaled meshes never miss vertices within `radius` in world space.
    const minScale = Math.max(1e-9, Math.min(Math.abs(spread.x), Math.abs(spread.y), Math.abs(spread.z)));
    const near = nearbyVertices(position.array as ArrayLike<number>, [local.x, local.y, local.z], radius / minScale, vertexLimit);

    const worldNear: Vec3[] = [];
    const v = new THREE.Vector3();
    const rLimit = radius + 1e-9;
    for (const point of near) {
      v.set(point[0], point[1], point[2]).applyMatrix4(mesh.matrixWorld);
      if (v.distanceTo(here) > rLimit) continue;
      const wp: Vec3 = [v.x, v.y, v.z];
      worldNear.push(wp);
      found.push({ point: wp, kind: 'vertex', label: `corner of ${nodeId}`, nodeId });
    }
    // The circle hunt in world space: exact even when the mesh is non-uniformly
    // scaled or reflected, where a local-space fit would skew radius and normal.
    const circle = detectCircle(worldNear);
    if (circle) {
      found.push({
        point: circle.centre,
        kind: 'centre',
        label: `circle centre on ${nodeId}`,
        radius: circle.radius,
        nodeId,
        normal: circle.normal,
      });
    }
  });

  return found;
}

/**
 * The feature nearest a MuJoCo-frame point, or the point itself if nothing is
 * near enough to have been meant.
 */
export function snapInScene(root: THREE.Object3D, point: Vec3, radius: number): SceneSnap {
  const world = toThree(point);
  const candidates = sceneCandidates(root, world, radius);
  const best = chooseSnapNear(candidates, world, radius);
  if (!best) {
    return { point, kind: 'surface', label: 'the point as given — nothing was near it', movedBy: 0 };
  }
  const at = toMujoco(best.point);
  return {
    ...best,
    point: at,
    movedBy: measureDistance(point, at).distance,
  };
}

export interface MeasureReply {
  distanceMm: number;
  distance: number;
  deltaMm: number[];
  angleDegrees?: number;
  from: { at: number[]; snappedTo: string; movedByMm: number; diameterMm?: number };
  to: { at: number[]; snappedTo: string; movedByMm: number; diameterMm?: number };
  corner?: { at: number[]; snappedTo: string; movedByMm: number };
  said: string;
}

const mm = (metres: number) => Math.round(metres * 1000 * 1000) / 1000;

/**
 * Distance between two points, or the angle at a corner between three.
 *
 * Snapping is on by default, because a coordinate an agent worked out is
 * nearly always a little off the feature it meant, and a measurement to three
 * decimal places of the wrong point is worse than no measurement. Every reply
 * says what each end landed on and how far it had to move to get there, so a
 * snap that went somewhere unexpected is visible rather than silent.
 */
export function measureInScene(
  root: THREE.Object3D | null,
  from: Vec3,
  to: Vec3,
  options: { corner?: Vec3; snap?: boolean; withinMm?: number } = {},
): MeasureReply {
  const radius = Math.max(0, (options.withinMm ?? 3) / 1000);
  const wanted = options.snap !== false && root !== null && radius > 0;
  const resolve = (point: Vec3): SceneSnap => (wanted
    ? snapInScene(root!, point, radius)
    : { point, kind: 'surface', label: 'the point as given', movedBy: 0 });

  const a = resolve(from);
  const b = resolve(to);
  const corner = options.corner ? resolve(options.corner) : null;

  const reading = corner
    ? measureDistance(a.point, b.point)
    : measureDistance(a.point, b.point);
  const angle = corner ? measureAngle(a.point, corner.point, b.point) : null;

  const end = (snap: SceneSnap) => ({
    at: snap.point.map((v) => Math.round(v * 1e6) / 1e6),
    snappedTo: snap.label,
    movedByMm: mm(snap.movedBy),
    ...(snap.radius ? { diameterMm: mm(snap.radius * 2) } : {}),
  });

  return {
    distanceMm: mm(reading.distance),
    distance: reading.distance,
    deltaMm: reading.delta.map(mm),
    ...(angle !== null ? { angleDegrees: Math.round(angle * 1000) / 1000 } : {}),
    from: end(a),
    to: end(b),
    ...(corner ? { corner: end(corner) } : {}),
    said: angle !== null
      ? `${angle.toFixed(2)}° at ${corner!.label}, between ${a.label} and ${b.label}`
      : `${formatMm(reading.distance)} from ${a.label} to ${b.label}`,
  };
}
