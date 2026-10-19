import type { SceneGeom, SceneNode } from '../types/scene';

// Helper to find a node by ID in hierarchy
/** Whether a body sits at the top of the scene rather than inside another. */
export function isTopLevel(nodes: SceneNode[], id: string): boolean {
  return nodes.some((n) => n.id === id);
}

export function findNodeById(nodes: SceneNode[], targetId: string): SceneNode | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children) {
      const res = findNodeById(node.children, targetId);
      if (res) return res;
    }
  }
  return null;
}

export type QuatWXYZ = [number, number, number, number];

const IDENTITY_QUAT: QuatWXYZ = [1, 0, 0, 0];

/** Whether a mesh body's rotation is already baked into its vertices (so MJCF emits no body rotation). */
export function isNodeRotationBaked(node: SceneNode): boolean {
  const geoms = node.geoms || [];
  if (geoms.length === 0) return false;
  if (!geoms.every((g) => g.type === 'mesh')) return false;
  return geoms.some(
    (g) =>
      (Array.isArray(g.baseVertices) && g.baseVertices.length > 0) ||
      (Array.isArray(g.baseRenderVertices) && g.baseRenderVertices.length > 0),
  );
}

/** Local body quaternion [w, x, y, z] as MJCF interprets `node.quat` or intrinsic XYZ `node.euler` (degrees). */
export function nodeLocalQuat(node: SceneNode): QuatWXYZ {
  if (isNodeRotationBaked(node)) return IDENTITY_QUAT;
  if (node.quat && node.quat.length === 4) {
    const [w, x, y, z] = node.quat;
    const len = Math.hypot(w, x, y, z);
    return len > 1e-12 ? [w / len, x / len, y / len, z / len] : IDENTITY_QUAT;
  }
  if (node.euler && (node.euler[0] !== 0 || node.euler[1] !== 0 || node.euler[2] !== 0)) {
    const hx = ((node.euler[0] || 0) * Math.PI) / 360;
    const hy = ((node.euler[1] || 0) * Math.PI) / 360;
    const hz = ((node.euler[2] || 0) * Math.PI) / 360;
    const cx = Math.cos(hx), sx = Math.sin(hx);
    const cy = Math.cos(hy), sy = Math.sin(hy);
    const cz = Math.cos(hz), sz = Math.sin(hz);
    // Intrinsic XYZ: qx * qy * qz
    return [
      cx * cy * cz - sx * sy * sz,
      sx * cy * cz + cx * sy * sz,
      cx * sy * cz - sx * cy * sz,
      cx * cy * sz + sx * sy * cz,
    ];
  }
  return IDENTITY_QUAT;
}

export function quatMultiply(a: QuatWXYZ, b: QuatWXYZ): QuatWXYZ {
  if (b[0] === 1 && b[1] === 0 && b[2] === 0 && b[3] === 0) return a;
  if (a[0] === 1 && a[1] === 0 && a[2] === 0 && a[3] === 0) return b;
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function quatRotateVec(q: QuatWXYZ, v: readonly number[]): [number, number, number] {
  const [w, x, y, z] = q;
  if (x === 0 && y === 0 && z === 0) return [v[0], v[1], v[2]];
  const vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

export function quatRotateVecInv(q: QuatWXYZ, v: readonly number[]): [number, number, number] {
  return quatRotateVec([q[0], -q[1], -q[2], -q[3]], v);
}

// Helper to get recursive world position of a node, accounting for parent rotations
export function getNodeWorldPos(
  nodes: SceneNode[],
  targetId: string,
  currentOffset: [number, number, number] = [0, 0, 0],
  parentQuat: QuatWXYZ = IDENTITY_QUAT,
): [number, number, number] | null {
  for (const node of nodes) {
    const rotatedOffset = quatRotateVec(parentQuat, node.pos);
    const nodeWorld: [number, number, number] = [
      currentOffset[0] + rotatedOffset[0],
      currentOffset[1] + rotatedOffset[1],
      currentOffset[2] + rotatedOffset[2],
    ];
    if (node.id === targetId) return nodeWorld;
    if (node.children) {
      const worldQuat = quatMultiply(parentQuat, nodeLocalQuat(node));
      const childResult = getNodeWorldPos(node.children, targetId, nodeWorld, worldQuat);
      if (childResult) return childResult;
    }
  }
  return null;
}

/**
 * Merges `updates` into the geom called `geomName` on the body `ownerId`, in
 * place, and says whether it found one. Pass a cloned tree.
 *
 * Addressed by owner as well as name because geom names are not unique in the
 * scene graph — mjcf.ts renames clashes only in the copy it compiles — so a
 * lookup by name alone could write one body's edit into another's mesh.
 */
export function patchGeom(nodes: SceneNode[], ownerId: string, geomName: string, updates: Partial<SceneGeom>): boolean {
  const owner = findNodeById(nodes, ownerId);
  const idx = owner?.geoms?.findIndex((g) => g.name === geomName) ?? -1;
  if (!owner || idx < 0) return false;
  owner.geoms[idx] = { ...owner.geoms[idx], ...updates };
  return true;
}
