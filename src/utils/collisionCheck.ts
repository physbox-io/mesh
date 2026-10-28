/**
 * Which bodies of a scene are inside one another before anything has moved.
 *
 * Two answers, from the cheap to the exact:
 *
 * - `boundsOverlaps` works from the graph alone. Every geom that can touch
 *   anything is boxed in world space from its real shape and pose (its own
 *   pos/quat/euler or fromto, and the pose of its body and every body above
 *   it), and two bodies are reported when a box of one overlaps a box of the
 *   other by more than the tolerance. It is conservative: a box round a
 *   diagonal strut is bigger than the strut.
 * - `contactOverlaps` reads the contacts MuJoCo itself generates on the first
 *   step, and so answers exactly what the solver will see. It is what the MCP
 *   command uses whenever the worker can run the scene.
 *
 * Both leave out the pairs the solver never collides, which a box test alone
 * reported: a body and its parent (MuJoCo filters those), two bodies welded
 * into the same rigid piece (both fixed to the world, say), geoms with contact
 * switched off (contype and conaffinity 0, or role 'visual'), and pairs whose
 * contact bits do not meet.
 */
import type { SceneGeom, SceneNode } from '../types/scene';
import { geomBounds, resolveCsgGeoms } from './csg';
import { transformBox, walkBodiesWorld, type Box3Like } from './bodyWorld';

/** Penetration below this is resting contact, not an overlap (metres). */
export const DEFAULT_OVERLAP_TOLERANCE = 0.0001;

export interface OverlapPair {
  bodyA: string;
  bodyB: string;
  geomA: string;
  geomB: string;
  /** How far the two are inside one another, in mm. For boxes, the smallest axis overlap. */
  depthMm: number;
}

interface BoxedGeom {
  body: string;
  geom: string;
  contype: number;
  conaffinity: number;
  box: Box3Like;
}

interface BodyInfo {
  name: string;
  /** The body this one is rigidly part of: itself when it has a joint, 'world' when fixed to the world. */
  weldRoot: string;
  /** The weld root of the body that piece hangs off ('world' at the top). */
  weldParent: string;
}

/** The body names the solver sees, keyed by node id, with parentage and welds. */
function bodyTable(nodes: SceneNode[]): Map<string, BodyInfo> {
  const table = new Map<string, BodyInfo>();
  const walk = (list: SceneNode[] | undefined, parent: SceneNode | null) => {
    for (const node of list || []) {
      const name = node.name || node.id;
      const parentInfo = parent ? table.get(parent.id) : null;
      // No joint: fixed to its parent, and part of whatever that is fixed to.
      // A top-level body with no joint is fixed to the world.
      const jointed = (node.joints || []).length > 0;
      const weldRoot = jointed ? node.id : parentInfo ? parentInfo.weldRoot : 'world';
      const weldParent = jointed ? (parentInfo ? parentInfo.weldRoot : 'world') : parentInfo ? parentInfo.weldParent : 'world';
      table.set(node.id, { name, weldRoot, weldParent });
      walk(node.children, node);
    }
  };
  walk(nodes, null);
  return table;
}

const contactBits = (g: SceneGeom): [number, number] => g.role === 'visual'
  ? [0, 0]
  : [g.contype ?? 1, g.conaffinity ?? 1];

/** MuJoCo's own test: either geom's contype shares a bit with the other's conaffinity. */
const bitsMeet = (a: BoxedGeom, b: BoxedGeom) => (a.contype & b.conaffinity) !== 0 || (b.contype & a.conaffinity) !== 0;

/** Every geom that takes part in contact, boxed in world space. */
export function collidingGeomBoxes(nodes: SceneNode[]): BoxedGeom[] {
  const out: BoxedGeom[] = [];
  walkBodiesWorld(nodes, (node, world) => {
    for (const g of resolveCsgGeoms(node, 'physics')) {
      if (g.type === 'plane') continue;
      const [contype, conaffinity] = contactBits(g);
      if (contype === 0 && conaffinity === 0) continue;
      const local = geomBounds(g);
      if (!local) continue;
      out.push({ body: node.id, geom: g.name, contype, conaffinity, box: transformBox(local, world) });
    }
  });
  return out;
}

/**
 * Bodies the solver never collides with each other: MuJoCo skips two geoms of
 * one rigid piece (same weld body), and, with its default filterparent, a
 * piece and the piece it hangs off by a joint — unless that is the world.
 */
function neverCollide(a: string, b: string, table: Map<string, BodyInfo>): boolean {
  if (a === b) return true;
  const A = table.get(a);
  const B = table.get(b);
  if (!A || !B) return false;
  if (A.weldRoot === B.weldRoot) return true;
  if (A.weldRoot === 'world' || B.weldRoot === 'world') return false;
  return A.weldParent === B.weldRoot || B.weldParent === A.weldRoot;
}

const boxOverlap = (a: Box3Like, b: Box3Like): number => {
  let depth = Infinity;
  for (let k = 0; k < 3; k++) {
    const d = Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
    if (d < depth) depth = d;
  }
  return depth;
};

const mm = (m: number) => +(m * 1000).toFixed(2);

/**
 * Pairs of bodies whose colliding geoms' world boxes overlap by more than
 * `tolerance` metres. One entry per pair of bodies, for its deepest geoms.
 */
export function boundsOverlaps(nodes: SceneNode[], tolerance = DEFAULT_OVERLAP_TOLERANCE): OverlapPair[] {
  const table = bodyTable(nodes);
  const boxes = collidingGeomBoxes(nodes);
  const best = new Map<string, OverlapPair>();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (neverCollide(a.body, b.body, table) || !bitsMeet(a, b)) continue;
      const depth = boxOverlap(a.box, b.box);
      if (!(depth > tolerance)) continue;
      const key = a.body < b.body ? `${a.body}\u0000${b.body}` : `${b.body}\u0000${a.body}`;
      const prev = best.get(key);
      if (prev && prev.depthMm >= mm(depth)) continue;
      best.set(key, {
        bodyA: table.get(a.body)!.name, bodyB: table.get(b.body)!.name,
        geomA: a.geom, geomB: b.geom, depthMm: mm(depth),
      });
    }
  }
  return [...best.values()];
}

/** Geoms whose world box reaches below the floor by more than `tolerance`. */
export function belowFloor(nodes: SceneNode[], tolerance = DEFAULT_OVERLAP_TOLERANCE): Array<{ body: string; geom: string; depthMm: number }> {
  const table = bodyTable(nodes);
  const deepest = new Map<string, { body: string; geom: string; depthMm: number }>();
  for (const g of collidingGeomBoxes(nodes)) {
    // The floor is contype 1 / conaffinity 1; a geom that cannot meet it is not on it.
    if ((g.contype & 1) === 0 && (g.conaffinity & 1) === 0) continue;
    if (table.get(g.body)?.weldRoot === 'world') continue;
    const depth = -g.box.min[2];
    if (!(depth > tolerance)) continue;
    const prev = deepest.get(g.body);
    if (!prev || prev.depthMm < mm(depth)) deepest.set(g.body, { body: table.get(g.body)!.name, geom: g.geom, depthMm: mm(depth) });
  }
  return [...deepest.values()];
}

/**
 * The geom name the compiled model uses, back to the body that owns it.
 *
 * mjcf.ts emits each geom under its own name, and the colliders it derives
 * under the source's name plus a suffix, so an exact match is tried first and
 * then the longest geom name the contact's name starts with.
 */
export function geomOwnerIndex(nodes: SceneNode[]): (geomName: string) => string | null {
  const exact = new Map<string, string>();
  const table = bodyTable(nodes);
  walkBodiesWorld(nodes, (node) => {
    for (const g of node.geoms || []) if (g.name) exact.set(g.name, table.get(node.id)!.name);
  });
  const names = [...exact.keys()].sort((a, b) => b.length - a.length);
  return (geomName: string) => {
    const hit = exact.get(geomName);
    if (hit) return hit;
    const prefix = names.find((n) => geomName.startsWith(n));
    return prefix ? exact.get(prefix)! : null;
  };
}

/**
 * Overlaps from the contacts MuJoCo generated (geom names and signed distance,
 * negative inside). Contact with the floor is reported against 'floor'.
 */
export function contactOverlaps(
  contacts: Array<{ geom1: string; geom2: string; dist: number }>,
  nodes: SceneNode[],
  tolerance = DEFAULT_OVERLAP_TOLERANCE,
): OverlapPair[] {
  const owner = geomOwnerIndex(nodes);
  const best = new Map<string, OverlapPair>();
  for (const c of contacts) {
    if (!(c.dist < -tolerance)) continue;
    const a = c.geom1 === 'floor' ? 'floor' : owner(c.geom1) ?? c.geom1;
    const b = c.geom2 === 'floor' ? 'floor' : owner(c.geom2) ?? c.geom2;
    if (a === b) continue;
    // The floor always second, as the box check reports it.
    const inOrder = b === 'floor' || (a !== 'floor' && a <= b);
    const [bodyA, bodyB, geomA, geomB] = inOrder ? [a, b, c.geom1, c.geom2] : [b, a, c.geom2, c.geom1];
    const key = `${bodyA}\u0000${bodyB}`;
    const depthMm = mm(-c.dist);
    const prev = best.get(key);
    if (!prev || prev.depthMm < depthMm) best.set(key, { bodyA, bodyB, geomA, geomB, depthMm });
  }
  return [...best.values()];
}
