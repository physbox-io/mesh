/**
 * How much of the world the viewport shows, and where the camera sits to show
 * it.
 *
 * The viewport used to open every scene from the same pose — 0.8 m out at 45°,
 * which puts about 660 mm of world across the window — and drew 100 mm grid
 * cells under it. That is a framing for a bench-scale rig, and the work people
 * actually do here is a part up to about 250 mm: at that distance a millimetre
 * is a pixel and a bit, a 35 mm relief carve is a smudge a twentieth of the
 * window across, and the 100 mm graph paper says the whole part is a third of
 * one square.
 *
 * So the default view is a 160 mm window instead — the same scene, drawn about
 * four times larger — and the grid cell is chosen to suit what is in
 * it. Nothing here scales a model: it is only how close the camera stands.
 *
 * A scene BIGGER than that window is pulled back far enough to fit, because the
 * alternative is opening it clipped through the middle. Nothing is ever pushed
 * in closer than the default, so a small part and a large one are not each
 * blown up to fill the window — the whole point is that a millimetre is the
 * same size in the view wherever you are.
 *
 * Everything here is MuJoCo world space (Z-up, metres), because that is what
 * the store's `cameraOverride` is in and what a preset's own `camera` is
 * written in — CameraController does the Z-up→Y-up swap when it applies one.
 */
import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { geomBounds, positiveBounds, resolveCsgGeoms } from './csg';
import { transformBox, walkBodiesWorld } from './bodyWorld';

const ORIGIN = [0, 0, 0];

export interface SceneFraming {
  position: [number, number, number];
  target: [number, number, number];
}

export interface SceneBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * The direction the camera looks from, matching the pose the viewport has
 * always opened in: front-right and above. Only the distance is computed; the
 * angle is kept so a scene still lands in the view people know.
 */
const VIEW_DIR = new THREE.Vector3(0.8, -0.8, 0.45).normalize();

/** Vertical field of view of the viewport camera, in degrees (CAMERA_CONFIG). */
const FOV_DEG = 45;

/**
 * Air around the content, for a scene too big for the default window. 1.0 puts
 * the bounding sphere exactly against the edges, which reads as cramped and
 * leaves no room for the gizmos drawn around a selected body.
 */
const MARGIN = 1.35;

/**
 * How much world the window shows by default, in metres. Most of what is made
 * here is under 160 mm, so a part that size fills the view and everything under
 * it is drawn to the same scale rather than zoomed to fit; a bigger one is
 * pulled back for. It was 250 mm, which opened an 80 mm part small.
 */
export const DEFAULT_VIEW_EXTENT = 0.16;

/**
 * The distance that puts DEFAULT_VIEW_EXTENT across the window vertically, and
 * the floor under every framing below. Also what App's CAMERA_CONFIG and
 * CameraController's default pose are built from, so the app opens at this
 * scale before any scene has been framed.
 */
export const DEFAULT_VIEW_DISTANCE =
  (DEFAULT_VIEW_EXTENT / 2) / Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2);

/**
 * Bounds of a mesh geom that only carries Y-up `vertices`.
 *
 * `geomBounds` reads `renderVertices`, the Z-up copy, and a preset written by
 * hand often has only the Three-space one — californiaRelief is built that way
 * — so it answers null for exactly the meshes worth framing. Y-up (x, y, z)
 * becomes Z-up (x, −z, y), the same swap mjcf.ts makes on the way out.
 */
function meshVertexBounds(g: SceneGeom): { min: number[]; max: number[] } | null {
  if (g.type !== 'mesh') return null;
  const v = g.vertices;
  if (!v || v.length < 3) return null;
  const off = g.pos || [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    const c = [v[i], -v[i + 2], v[i + 1]];
    for (let a = 0; a < 3; a++) {
      const p = c[a] + (off[a] || 0);
      if (p < min[a]) min[a] = p;
      if (p > max[a]) max[a] = p;
    }
  }
  return { min, max };
}

/**
 * The union of every body's bounds, in world space.
 *
 * Each body's box is taken in its own frame and carried out through the real
 * pose of the body and every parent above it. Summing positions alone put a
 * wheel's gondolas where they would hang if the wheel were not turned, and a
 * ride built on a rotated hub framed its base and left the hub out of shot.
 * Planes are skipped (`geomBounds` returns null for them): the ground is
 * unbounded, and framing it would mean framing nothing.
 */
export function sceneContentBounds(nodes: SceneNode[]): SceneBounds | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let any = false;

  const add = (offset: number[], b: { min: number[]; max: number[] }) => {
    for (let a = 0; a < 3; a++) {
      const lo = b.min[a] + (offset[a] || 0);
      const hi = b.max[a] + (offset[a] || 0);
      if (!isFinite(lo) || !isFinite(hi)) return;
      if (lo < min[a]) min[a] = lo;
      if (hi > max[a]) max[a] = hi;
      any = true;
    }
  };

  walkBodiesWorld(nodes, (node, world) => {
    // A compiled body reports the bounds of its positive source geoms, already
    // moved into the frame the compiled mesh is drawn in.
    const csg = positiveBounds(node);
    if (csg) {
      add(ORIGIN, transformBox(csg, world));
    } else {
      for (const g of [...(node.geoms || []), ...resolveCsgGeoms(node, 'render')]) {
        const b = geomBounds(g) ?? meshVertexBounds(g);
        if (b) add(ORIGIN, transformBox(b, world));
      }
    }
  });
  return any ? { min, max } : null;
}

/** Bigger than this is the floor or the sky, not a part. */
const MAX_PART_M = 10;

/**
 * The content's bounds as it is drawn, document frame: every shadow-casting
 * mesh of a body in the scene graph, at its real pose. sceneContentBounds adds
 * up authored positions and leaves rotations out, which is close enough for
 * the perspective view's generous framing, but not for a drawing view's: a
 * windmill's blade turned 120° stood out past the top of the sheet. Null when
 * nothing of the current scene is drawn yet (just after a load), so the caller
 * can fall back.
 */
export function drawnContentBounds(root: THREE.Object3D, nodes: SceneNode[]): SceneBounds | null {
  const ids = new Set<string>();
  const walk = (list: SceneNode[] | undefined) => {
    for (const node of list ?? []) { ids.add(node.id); walk(node.children); }
  };
  walk(nodes);
  const total = new THREE.Box3();
  const piece = new THREE.Box3();
  const instance = new THREE.Matrix4();
  const take = (box: THREE.Box3) => {
    const size = box.getSize(new THREE.Vector3());
    if (box.isEmpty() || Math.max(size.x, size.y, size.z) > MAX_PART_M) return;
    total.union(box);
  };
  const bodyOf = (object: THREE.Object3D) => {
    for (let node: THREE.Object3D | null = object; node; node = node.parent) {
      if (node.type === 'Group' && node.name) return node.name;
    }
    return null;
  };
  root.updateMatrixWorld();
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || !mesh.castShadow) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox!;
    const instanced = mesh as unknown as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      const owners = (instanced.userData?.nodeIds ?? []) as string[];
      for (let i = 0; i < instanced.count; i++) {
        if (!ids.has(owners[i])) continue;
        instanced.getMatrixAt(i, instance);
        take(piece.copy(local).applyMatrix4(instance.premultiply(instanced.matrixWorld)));
      }
      return;
    }
    const id = bodyOf(mesh);
    if (!id || !ids.has(id)) return;
    take(piece.copy(local).applyMatrix4(mesh.matrixWorld));
  });
  if (total.isEmpty()) return null;
  // Three's Y-up back to the document's Z-up: (x, y, z) → (x, −z, y).
  return {
    min: [total.min.x, -total.max.z, total.min.y],
    max: [total.max.x, -total.min.z, total.max.y],
  };
}

/**
 * A camera pose that shows `bounds` at the default scale, backing off only far
 * enough to fit a scene too big for it.
 *
 * Both axes are checked, as in ToolpathView: in a wide viewport the horizontal
 * angle is the larger one and the vertical is what binds, but a tall window
 * flips that, and the distance taken is whichever of the two asks for more
 * room.
 */
export function framingForBounds(bounds: SceneBounds, aspect = 1): SceneFraming {
  const box = new THREE.Box3(
    new THREE.Vector3(...bounds.min),
    new THREE.Vector3(...bounds.max)
  );
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;

  const vFov = THREE.MathUtils.degToRad(FOV_DEG);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.0001, aspect));
  const fit = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * MARGIN;
  // Never closer than the default: a 20 mm part is drawn at the size a 20 mm
  // part is, not blown up to fill the window.
  const dist = Math.max(DEFAULT_VIEW_DISTANCE, fit);

  const eye = centre.clone().addScaledVector(VIEW_DIR, dist);
  return {
    position: [eye.x, eye.y, eye.z],
    target: [centre.x, centre.y, centre.z],
  };
}

/** Both steps: bounds of the scene, then a pose that fits them. */
export function framingForScene(nodes: SceneNode[], aspect = 1): SceneFraming | null {
  const bounds = sceneContentBounds(nodes);
  return bounds ? framingForBounds(bounds, aspect) : null;
}

/**
 * The grid cell that suits a scene this size — display only, exactly like the
 * dropdown that also sets it, which still overrides it.
 *
 * 100 mm cells under a 35 mm carve is the other half of why a small part reads
 * as small: there is nothing else in the window to judge it against, and the
 * graph paper says the whole part is a third of one square. The options are the
 * ones the dropdown offers; the target is roughly ten cells across the scene,
 * measured in log space so that 2 across and 50 across are judged equally wrong
 * rather than the larger count always winning on absolute difference.
 */
export function gridCellForBounds(bounds: SceneBounds | null): number {
  if (!bounds) return 10;
  const extentMm = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ) * 1000;
  if (!isFinite(extentMm) || extentMm <= 0) return 10;
  const options = [1, 10, 100];
  let best = options[0];
  let bestErr = Infinity;
  for (const cell of options) {
    const err = Math.abs(Math.log(extentMm / cell) - Math.log(10));
    if (err < bestErr) { bestErr = err; best = cell; }
  }
  return best;
}

/**
 * The same default view, in the Three.js Y-up space the viewport's own camera
 * lives in (MuJoCo x,y,z → Three x,z,−y).
 *
 * App's `CAMERA_CONFIG` and CameraController's reset both pose the camera
 * directly rather than through a framing, so this is where they get the
 * distance from — one place to change how big the world is drawn, instead of
 * three literals that have to be kept in step.
 *
 * The target sits a little above the floor rather than on it: a part rests on
 * the ground, so aiming at the origin puts half the window under the world.
 */
export const DEFAULT_TARGET_Y = 0.05;

export const DEFAULT_EYE: [number, number, number] = [
  VIEW_DIR.x * DEFAULT_VIEW_DISTANCE,
  DEFAULT_TARGET_Y + VIEW_DIR.z * DEFAULT_VIEW_DISTANCE,
  -VIEW_DIR.y * DEFAULT_VIEW_DISTANCE,
];

