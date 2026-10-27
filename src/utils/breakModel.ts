// What breaks, and where, as MJCF: members that snap or bend under load, and
// joint blobs that weld whatever reaches into them.
//
// Run by the compiler on its own copy of the scene, after names are final. It
// rewrites the top-level nodes in place (a breakable member becomes two
// halves) and hands back the equalities, contact exclusions and numbers the
// compiler adds to the model.
//
// Every limit travels INSIDE the model, as a MuJoCo <numeric> named after the
// equality it belongs to. The physics worker reads them from there, so it never
// recomputes a blob's attachments from a scene it only holds a stripped copy
// of, and the two can never disagree about what holds what.
//
// The solver settings are the ones a 39-strut spaghetti tower, held up by
// nothing but these welds, stood still under: the shortest time constant
// MuJoCo allows at a 1 ms step (2 ms) and an impedance close to 1. MuJoCo
// scales a constraint's softness to the mass of what it joins, so a light
// part carrying a heavy load sags: at its default a 1 g blob under a 1 kg load
// let its welds stretch by millimetres, and even at 2 ms a 12 g plank holding
// 5.4 kg at its tip sags 9 mm where real oak would sag 4. What breaks, and
// when, is unaffected — the moments are statics — only how far it sags first.
// See plans/joints-and-member-fracture.md.
//
// PURE: no store, no MuJoCo.

import type { SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { faceJoinLimits, isJoinBlob, joinMaterial, rodJoinLimits, type JoinLimits } from './joinMaterials';
import { geomAxis, halveGeom, memberShape, sectionLimits, type Section, type SectionLimits } from './memberStrength';
import { nodeLocalQuat, quatMultiply, quatRotateVec, quatRotateVecInv, type QuatWXYZ } from './sceneTree';
import { DEFAULT_HOLD_STEPS } from './breakThresholds';
import { BREAK_FIELDS, BREAK_KIND, memberKey, joinKey, pinKey } from './breakKeys';
import { loadStrengthOf } from './deformMaterials';

type V3 = [number, number, number];

/** Stiff enough that a gram of putty can hold up a kilogram. */
export const STIFF_SOLREF = '0.002 1';
export const STIFF_SOLIMP = '0.999 0.9999 0.001 0.5 2';

export { BREAK_FIELDS, BREAK_KIND, memberKey, joinKey, pinKey, parseBreakKey } from './breakKeys';

export interface BreakModel {
  /** Ready-made <weld>/<connect> lines, without indentation. */
  equality: string[];
  /** Body-name pairs that must not collide. */
  excludes: [string, string][];
  numerics: { name: string; data: number[] }[];
}

const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const add = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const scale = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const unit = (p: V3): V3 => { const l = Math.hypot(...p); return l > 0 ? scale(p, 1 / l) : [0, 0, 0]; };
const fmt = (v: readonly number[]) => v.map((x) => +x.toFixed(7)).join(' ');
const lim = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? -1 : v);

function xmlAttr(name: string): string {
  return String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Pose { pos: V3; quat: QuatWXYZ }
const toWorld = (pose: Pose, p: readonly number[]): V3 => add(pose.pos, quatRotateVec(pose.quat, p) as V3);
const toLocal = (pose: Pose, p: V3): V3 => quatRotateVecInv(pose.quat, sub(p, pose.pos)) as V3;

/** One rod or bar end, or a whole part, that a blob might hold. */
interface Holdable {
  /** The body that is welded: a member's half, or the part itself. */
  body: SceneNode;
  pose: Pose;
  /** Whose id the key carries: the authored part, which a half is not. */
  partId: string;
  /**
   * `diameter` is the thin way across, `width` the wide way (the same for a
   * rod), and `wide` the direction of the wide way in the body's frame, for a
   * bar.
   */
  rod?: { end: V3; inward: V3; length: number; diameter: number; width: number; wide?: V3; reach: number; member?: SectionLimits };
  /** For anything without an axis: where it is pressed into this blob, or null. */
  pressed?: (b: Blob) => V3 | null;
}

/**
 * Builds the break model and splits the members, in place.
 *
 * `nodes` is the compiler's own copy. Only top-level free bodies can be
 * members: a half must be free to fall away, and a body inside another is
 * moved by its parent.
 */
export function buildBreakModel(nodes: SceneNode[]): BreakModel {
  const out: BreakModel = { equality: [], excludes: [], numerics: [] };
  const hasBlob = anyNode(nodes, isJoinBlob);
  const hasMember = nodes.some((n) => loadStrengthOf(n) && free(n) && memberShape(n));
  if (!hasBlob && !hasMember) return out;

  const halves = new Map<string, Split>();
  const added: SceneNode[] = [];
  for (const node of nodes) {
    const strength = loadStrengthOf(node);
    if (!strength || !free(node)) continue;
    const shape = memberShape(node);
    if (!shape) continue;
    const limits = sectionLimits(shape, strength);
    const g = node.geoms[shape.geomIndex];
    const [ga, gb] = halveGeom(g, shape);
    node.geoms = node.geoms.map((x, i) => (i === shape.geomIndex ? ga : x));
    const mid = scale(add(shape.a, shape.b), 0.5);
    const axis = unit(sub(shape.b, shape.a));
    const key = memberKey(node.id);
    const bar: Bar | undefined = shape.section.kind === 'rect' ? { strongNm: limits.bendingStrongNm, wide: shape.section.wide } : undefined;
    const geomB: SceneGeom = { ...gb, name: `${g.name}~2` };
    let b: SceneNode;
    if (strength.ductile) {
      // Bends: the far half hangs off the near one on a ball joint whose dry
      // friction IS the yield moment — a joint that does not move until it is
      // leaned on that hard, and stays wherever it is left. A lock holds it
      // rigid until then, and gives way to buckling too, which friction alone
      // never would: a straight column has nothing to turn it.
      const bend: SceneJoint = { name: key, type: 'ball', pos: mid, frictionloss: limits.bendingNm };
      b = { id: `${node.id}~2`, name: `${node.name}~2`, pos: [0, 0, 0], joints: [bend], geoms: [geomB], children: [] };
      node.children = [...(node.children || []), b];
      out.equality.push(`<weld name="${xmlAttr(key)}" body1="${xmlAttr(b.name)}" body2="${xmlAttr(node.name)}" anchor="${fmt(mid)}" solref="${STIFF_SOLREF}" solimp="${STIFF_SOLIMP}" />`);
      out.numerics.push({ name: key, data: breakData(BREAK_KIND.LOCK, -1, limits.bendingNm, limits.bucklingN, axis, 0, -1, bar) });
    } else {
      const freeJoint = (node.joints || []).find((j) => j.type === 'free')!;
      b = {
        id: `${node.id}~2`, name: `${node.name}~2`, pos: node.pos, quat: node.quat, euler: node.euler,
        joints: [{ ...freeJoint, name: `${freeJoint.name}~2` }], geoms: [geomB], children: [],
      };
      added.push(b);
      out.equality.push(`<weld name="${xmlAttr(key)}" body1="${xmlAttr(b.name)}" body2="${xmlAttr(node.name)}" anchor="${fmt(mid)}" solref="${STIFF_SOLREF}" solimp="${STIFF_SOLIMP}" />`);
      out.numerics.push({ name: key, data: breakData(BREAK_KIND.SNAP, limits.tensionN, limits.bendingNm, limits.bucklingN, axis, 0, -1, bar) });
      out.excludes.push([node.name, b.name]);
    }
    halves.set(node.id, { a: node, b, limits, ductile: !!strength.ductile });
  }
  nodes.push(...added);

  if (hasBlob) attachBlobs(nodes, halves, out);
  return out;
}

/** A bar's strong-way bending limit and the way its wide side runs (body1's frame). */
interface Bar { strongNm: number; wide: V3 }

function breakData(kind: number, force: number, torque: number, compression: number, axis: V3, also = 0, lateral = -1, bar?: Bar): number[] {
  const d = new Array(14).fill(0);
  d[BREAK_FIELDS.KIND] = kind;
  d[BREAK_FIELDS.FORCE] = lim(force);
  d[BREAK_FIELDS.TORQUE] = lim(torque);
  d[BREAK_FIELDS.COMPRESSION] = lim(compression);
  d[BREAK_FIELDS.AX] = axis[0]; d[BREAK_FIELDS.AY] = axis[1]; d[BREAK_FIELDS.AZ] = axis[2];
  d[BREAK_FIELDS.HOLD] = DEFAULT_HOLD_STEPS;
  d[BREAK_FIELDS.ALSO] = also;
  d[BREAK_FIELDS.LATERAL] = lim(lateral);
  if (bar) {
    d[BREAK_FIELDS.WX] = bar.wide[0]; d[BREAK_FIELDS.WY] = bar.wide[1]; d[BREAK_FIELDS.WZ] = bar.wide[2];
    d[BREAK_FIELDS.STRONG] = bar.strongNm;
  }
  return d;
}

interface Split { a: SceneNode; b: SceneNode; limits: SectionLimits; ductile: boolean }

const free = (n: SceneNode) => (n.joints || []).some((j) => j.type === 'free');

function anyNode(nodes: SceneNode[], f: (n: SceneNode) => boolean): boolean {
  return (nodes || []).some((n) => f(n) || anyNode(n.children || [], f));
}

/** Every body with its world pose, depth first. */
function poses(nodes: SceneNode[], parent: Pose = { pos: [0, 0, 0], quat: [1, 0, 0, 0] }, acc: { node: SceneNode; pose: Pose }[] = []) {
  for (const node of nodes || []) {
    const pose: Pose = { pos: toWorld(parent, node.pos || [0, 0, 0]), quat: quatMultiply(parent.quat, nodeLocalQuat(node)) };
    acc.push({ node, pose });
    poses(node.children || [], pose, acc);
  }
  return acc;
}

interface Blob { node: SceneNode; pose: Pose; centre: V3; rot: QuatWXYZ; semi: V3 }

function blobOf(node: SceneNode, pose: Pose): Blob | null {
  const g = (node.geoms || []).find((x) => x.type === 'ellipsoid' || x.type === 'sphere');
  if (!g) return null;
  const s = g.size || [];
  const semi: V3 = g.type === 'sphere' ? [s[0], s[0], s[0]] : [s[0], s[1] ?? s[0], s[2] ?? s[0]];
  if (!semi.every((v) => v > 0)) return null;
  const local = nodeLocalQuat({ quat: g.quat, euler: g.euler, geoms: [] } as unknown as SceneNode);
  return { node, pose, centre: toWorld(pose, g.pos || [0, 0, 0]), rot: quatMultiply(pose.quat, local), semi };
}

/** A point in the blob's own frame, scaled so the blob (grown by `grow`) is the unit sphere. */
function inBlob(b: Blob, p: V3, grow = 0): V3 {
  const q = quatRotateVecInv(b.rot, sub(p, b.centre));
  return [q[0] / (b.semi[0] + grow), q[1] / (b.semi[1] + grow), q[2] / (b.semi[2] + grow)];
}

/** How far from `p` along `dir` the line stays inside the blob, capped at `max`. */
function depthInside(b: Blob, p: V3, dir: V3, max: number): number {
  const o = inBlob(b, p);
  const d = inBlob(b, add(b.centre, dir));
  const aa = dot(d, d), bb = 2 * dot(o, d), cc = dot(o, o) - 1;
  const disc = bb * bb - 4 * aa * cc;
  if (aa <= 0 || disc < 0) return 0;
  const t = (-bb + Math.sqrt(disc)) / (2 * aa);
  return Math.max(0, Math.min(max, t));
}

function holdables(all: { node: SceneNode; pose: Pose }[], halves: Map<string, Split>): Holdable[] {
  const poseOf = new Map(all.map((x) => [x.node, x.pose]));
  const out: Holdable[] = [];
  for (const { node, pose } of all) {
    if (isJoinBlob(node) || node.id.endsWith('~2')) continue;
    const split = halves.get(node.id);
    if (split) {
      // A member's ends, each on its own half. The far half's geom is the one
      // the B end lies on; a ductile far half is a child at the same pose.
      const shape = memberShape({ ...node, geoms: [...node.geoms.filter((g) => g.role === 'visual'), mergedGeom(node, split.b)] });
      if (!shape) continue;
      const { d, width, wide, reach } = across(shape.section);
      const a = toWorld(pose, shape.a), bEnd = toWorld(pose, shape.b);
      const inward = unit(sub(bEnd, a));
      // A brittle member can snap where it enters a joint, so the joint holds
      // it no harder than its section does. A ductile one bends instead, and
      // it does that at its mid-span hinge: capping the joint would have it
      // snap off at the end like glass.
      const member = split.ductile ? undefined : split.limits;
      out.push({ body: split.a, pose, partId: node.id, rod: { end: a, inward, length: shape.length, diameter: d, width, wide, reach, member } });
      out.push({ body: split.b, pose: poseOf.get(split.b) ?? pose, partId: node.id, rod: { end: bEnd, inward: scale(inward, -1), length: shape.length, diameter: d, width, wide, reach, member } });
      continue;
    }
    for (const g of node.geoms || []) {
      if (g.role === 'visual' || g.csg === 'difference' || g.contactClass) continue;
      const ax = geomAxis(g);
      if (ax) {
        const a = toWorld(pose, ax.a), b = toWorld(pose, ax.b);
        const length = Math.hypot(...sub(b, a));
        const { d, width, wide, reach } = across(ax.section);
        const inward = unit(sub(b, a));
        out.push({ body: node, pose, partId: node.id, rod: { end: a, inward, length, diameter: d, width, wide, reach } });
        out.push({ body: node, pose, partId: node.id, rod: { end: b, inward: scale(inward, -1), length, diameter: d, width, wide, reach } });
      } else {
        out.push({ body: node, pose, partId: node.id, pressed: (b) => pressedInto(b, g, pose) });
      }
    }
  }
  return out;
}

/** A section's thin and wide sizes, its wide direction, and how far it reaches from its axis. */
function across(sec: Section): { d: number; width: number; wide?: V3; reach: number } {
  return sec.kind === 'round'
    ? { d: 2 * sec.r, width: 2 * sec.r, reach: sec.r }
    : { d: sec.h, width: sec.w, wide: sec.wide, reach: sec.w / 2 };
}

/** The whole member again, from its two halves, for its ends. */
function mergedGeom(a: SceneNode, b: SceneNode): SceneGeom {
  const ga = a.geoms.find((g) => g.role !== 'visual' && g.csg !== 'difference')!;
  const gb = b.geoms[0];
  const ea = geomAxis(ga)!, eb = geomAxis(gb)!;
  if (ga.fromto) return { ...ga, fromto: [...ea.a, ...eb.b] };
  // A bar: the two half-boxes' outer faces are the member's ends.
  const s = ga.size || [];
  const h = [s[0], s[1] ?? s[0], s[2] ?? s[0]];
  const k = h.indexOf(Math.max(...h));
  const size = [...h];
  size[k] = h[k] * 2;
  return { ...ga, size, pos: scale(add(ea.a, eb.b), 0.5) };
}

/**
 * How far a part has to be pressed into a blob to be stuck to it: a tenth of
 * the way in. Merely touching is not enough — a weight set down on a ball of
 * putty rests on it, it is not glued to it.
 */
const PRESSED = 0.9;

/** Where a non-rod geom is pressed into the blob: its nearest point to the centre, if that is inside. */
function pressedInto(b: Blob, g: SceneGeom, pose: Pose): V3 | null {
  const s = g.size || [];
  const inside = (p: V3) => { const q = inBlob(b, p); return dot(q, q) <= PRESSED * PRESSED; };
  if (g.type === 'mesh') {
    const v = g.renderVertices;
    if (!v) return null;
    for (let i = 0; i + 2 < v.length; i += 3) {
      const p = toWorld(pose, [v[i], v[i + 1], v[i + 2]]);
      if (inside(p)) return p;
    }
    return null;
  }
  const local = nodeLocalQuat({ quat: g.quat, euler: g.euler, geoms: [] } as unknown as SceneNode);
  const frame: Pose = { pos: toWorld(pose, g.pos || [0, 0, 0]), quat: quatMultiply(pose.quat, local) };
  const c = toLocal(frame, b.centre);
  let near: V3;
  if (g.type === 'box') {
    const h = [s[0] ?? 0, s[1] ?? s[0] ?? 0, s[2] ?? s[0] ?? 0];
    near = [0, 1, 2].map((k) => Math.max(-h[k], Math.min(h[k], c[k]))) as V3;
  } else {
    // A sphere, or anything else taken as the sphere around it.
    const r = Math.max(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0);
    const d = Math.hypot(...c);
    near = d <= r ? c : scale(c, r / d);
  }
  const p = toWorld(frame, near);
  return inside(p) ? p : null;
}

function attachBlobs(
  nodes: SceneNode[],
  halves: Map<string, Split>,
  out: BreakModel,
) {
  const all = poses(nodes);
  const blobs = all.filter((x) => isJoinBlob(x.node)).map((x) => blobOf(x.node, x.pose)).filter((b): b is Blob => !!b);
  const parts = holdables(all, halves);
  const exclude = new Set<string>();
  const pushExclude = (p: string, q: string) => {
    if (p === q) return;
    const k = p < q ? `${p}\u0000${q}` : `${q}\u0000${p}`;
    if (exclude.has(k)) return;
    exclude.add(k);
    out.excludes.push([p, q]);
  };

  // Bodies held on a pin: see grip() below.
  const gripped = new Set<SceneNode>();
  for (const blob of blobs) {
    const m = joinMaterial(blob.node.joinMaterial)!;
    const held: SceneNode[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      if (seen.has(part.body.id)) continue;
      let at: V3;
      let limits: JoinLimits;
      let memberWeaker = false;
      let strongNm: number | undefined;
      if (part.rod) {
        const r = part.rod;
        const q = inBlob(blob, r.end, r.reach);
        if (dot(q, q) > 1) continue;
        at = r.end;
        const embed = depthInside(blob, r.end, r.inward, r.length);
        limits = rodJoinLimits(m, r.diameter, embed);
        // The strong way, for a bar: it bears on the blob across its width.
        strongNm = r.wide ? rodJoinLimits(m, r.width, embed).torqueNm : undefined;
        if (r.member) {
          // The member is held as strongly as the weaker of the two: putty
          // lets a rod lean long before the rod would snap, but hot glue
          // outholds the pasta and the pasta breaks at the joint instead.
          memberWeaker = r.member.bendingNm < limits.torqueNm || r.member.tensionN < limits.pullN;
          limits = {
            pullN: Math.min(limits.pullN, r.member.tensionN),
            lateralN: Math.min(limits.lateralN ?? Infinity, r.member.tensionN),
            torqueNm: Math.min(limits.torqueNm, r.member.bendingNm),
          };
          if (strongNm !== undefined) strongNm = Math.min(strongNm, r.member.bendingStrongNm);
        }
      } else {
        const hit = part.pressed?.(blob);
        if (!hit) continue;
        at = hit;
        limits = faceJoinLimits(m, (blob.semi[0] + blob.semi[1] + blob.semi[2]) / 3);
      }
      seen.add(part.body.id);
      const anchor = toLocal(blob.pose, at);
      // Into the rod, in its own body's frame: see BREAK_FIELDS.
      const into: V3 = part.rod ? (quatRotateVecInv(part.pose.quat, part.rod.inward) as V3) : [0, 0, 0];
      const lateral = part.rod ? limits.lateralN : undefined;
      if (m.yields && !memberWeaker) {
        // Putty: a pin. The rod sits in it and turns freely until it is
        // pulled out or pushed out sideways. Not a weld that gives way: real
        // putty hardly resists turning, and a tower held rigid by its joints
        // until they all gave at once came down from the shock of the
        // hand-over, where the same tower on pins stood. A <connect> anchor
        // is in body1's frame.
        const pk = pinKey(blob.node.id, part.body.id);
        out.equality.push(`<connect name="${xmlAttr(pk)}" body1="${xmlAttr(part.body.name)}" body2="${xmlAttr(blob.node.name)}" anchor="${fmt(toLocal(part.pose, at))}" solref="${STIFF_SOLREF}" solimp="${STIFF_SOLIMP}" />`);
        out.numerics.push({ name: pk, data: breakData(BREAK_KIND.JOIN, limits.pullN, -1, -1, into, 0, lateral) });
      } else {
        // Glue, or a rod weaker than the putty around it (it snaps at the
        // joint before the putty lets it turn): rigid until it lets go.
        const key = joinKey(blob.node.id, part.body.id);
        out.equality.push(`<weld name="${xmlAttr(key)}" body1="${xmlAttr(part.body.name)}" body2="${xmlAttr(blob.node.name)}" anchor="${fmt(anchor)}" solref="${STIFF_SOLREF}" solimp="${STIFF_SOLIMP}" />`);
        const bar: Bar | undefined = part.rod?.wide && strongNm !== undefined
          ? { strongNm, wide: part.rod.wide }
          : undefined;
        out.numerics.push({ name: key, data: breakData(BREAK_KIND.JOIN, limits.pullN, limits.torqueNm, -1, into, 0, lateral, bar) });
      }
      pushExclude(part.body.name, blob.node.name);
      held.push(part.body);
      if (m.yields) gripped.add(part.body);
    }
    // Everything meeting at one blob overlaps inside it.
    for (let i = 0; i < held.length; i++) for (let j = i + 1; j < held.length; j++) pushExclude(held[i].name, held[j].name);
  }
  for (const node of gripped) grip(node);
  for (const b of blobs) if (joinMaterial(b.node.joinMaterial)!.yields) noSpin(b.node);
}

/**
 * A putty blob moves but never turns.
 *
 * Everything it holds is pinned at its centre, so its own turning carries
 * nothing — and left free, it is a ball bearing. Numerical noise spun the
 * blobs of a standing tower up over a few seconds until the ones on the floor
 * drove it away like wheels and the ones under a weight carried the weight off
 * sideways; the blob under a slate set on a tower was turning at 21 rad/s
 * within 0.1 s. Three slides in place of the free joint: it falls, slides and
 * is carried like anything else, and a ball of uniform colour turning or not
 * looks the same. A glue blob keeps its rotation, since what it holds is
 * welded to it and has to turn with it.
 */
function noSpin(node: SceneNode) {
  const free = (node.joints || []).find((j) => j.type === 'free');
  if (!free) return;
  const axes: [string, number[]][] = [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]];
  node.joints = [
    ...node.joints.filter((j) => j !== free),
    ...axes.map(([k, axis]): SceneJoint => ({ name: `${free.name}_${k}`, type: 'slide', axis, pos: [0, 0, 0] })),
  ];
}

/**
 * Rolling friction, for everything on a pin and the blobs holding it.
 *
 * A pin leaves a round rod free to spin about its own axis, and a blob with
 * all its pins at its centre free to spin about any: nothing anyone can see,
 * until something rests on them. Then they are rollers and ball bearings, and
 * a weight set on a tower or a bridge deck rolled straight off. Real putty
 * grips. MuJoCo's rolling friction (condim 6) resists a turn under a contact
 * by a lever of this many metres times the load — longer than these parts'
 * radii, so nothing rolls on them at all.
 */
const ROLLING_FRICTION = 0.01;
function grip(node: SceneNode) {
  node.geoms = (node.geoms || []).map((g) => {
    if (g.role === 'visual' || g.csg === 'difference') return g;
    const f = g.friction ?? [1, 0.005, 0.0001];
    return { ...g, condim: 6, friction: [f[0], Math.max(f[1] ?? 0, 0.005), Math.max(f[2] ?? 0, ROLLING_FRICTION)] };
  });
}
