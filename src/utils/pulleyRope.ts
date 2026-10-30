// ---------------------------------------------------------------------------
// A pulley rope: what it couples, and where it is drawn.
//
// A rope (isPulleyRope) ties two slide ends, leftTargetId and rightTargetId,
// optionally over a hinged wheel (pulleyWheelId). It is always taut, so its
// length is fixed: each end moved toward the wheel by d takes up strands·d of
// rope on its side, and what one side takes up the other pays out,
//
//   nL·sL·qL + nR·sR·qR = 0,
//
// n being the strands that hold that end (leftStrands, rightStrands: 2 for a
// load hung in a movable pulley, 4 for a four-fall block and tackle) and s = ±1
// whether the slide's +q runs toward the wheel. The wheel's rim moves with
// the rope where it leaves it for the left end: r·θ̇·(a × ρ̂)·u = rope speed,
// ρ̂ pointing from the axis to that tangent point and u along the strand.
//
// It used to be two joint equalities at MuJoCo's default softness, a fixed
// left = −right and left = r·θ: the wheel lagged the rope by 33-43 mm and
// the two ends drifted 5.4 mm apart. Now both are rigid tendon couplings,
// as gears are (utils/jointCoupling.ts).
//
// The same rest-pose geometry places the drawn rope: from the top of each end
// (the side facing the wheel, whatever the body's size), up to the wheel's
// tangent point on that end's side, and over the rim between them.
// ---------------------------------------------------------------------------

import type { SceneJoint, SceneNode } from '../types/scene';
import { geomBounds } from './csg';
import { quatRotateVec, type QuatWXYZ } from './sceneTree';

export type V3 = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: number[]): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

interface Pose { pos: number[]; quat: QuatWXYZ }

export interface RopeEnd {
  nodeId: string;
  jointName: string;
  /** Strands holding this end: its mechanical advantage. */
  strands: number;
  /** +1 when the slide's positive travel runs toward the wheel. */
  sign: 1 | -1;
  /** The slide axis, body frame. */
  axisLocal: V3;
  /** Where the rope ties on, body frame: the middle of the face toward the wheel. */
  attachLocal: V3;
}

export interface RopeWheel {
  nodeId: string;
  jointName: string;
  radius: number;
  /** The hinge axis, body frame. */
  axisLocal: V3;
  /** Wheel angle per metre of rope taken up on the left side. */
  turnsPerMetre: number;
}

export interface RopeLayout {
  left: RopeEnd;
  right: RopeEnd;
  wheel?: RopeWheel;
  /** qL = linearRatio · qR. */
  linearRatio: number;
}

/** A positive strand count; 1 when unset or nonsense. */
const strandsOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1);

/** The wheel's radius: as set, else its largest round geom. */
export function wheelRadius(wheel: SceneNode): number {
  if (wheel.pulleyRadius && wheel.pulleyRadius > 0) return wheel.pulleyRadius;
  const round = (wheel.geoms || []).filter((g) => (g.type === 'cylinder' || g.type === 'sphere') && g.size?.[0]).map((g) => g.size[0]);
  return round.length ? Math.max(...round) : 0.08;
}

/** The middle of a body's face toward `dirLocal` (body frame), from its solid geoms' bounds. */
function faceToward(node: SceneNode, dirLocal: V3): V3 {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of node.geoms || []) {
    if (g.csg === 'difference' || g.role === 'visual') continue;
    const b = geomBounds(g);
    if (!b) continue;
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  }
  if (!(max[0] >= min[0])) return [0, 0, 0];
  const c: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let reach = 0;
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    reach = Math.max(reach, dot(sub(p, c), dirLocal));
  }
  return add(c, scale(dirLocal, reach));
}

/** From the wheel's axis toward where a strand leaves it, square to the axis and the strand; null when the end is on the axis line. */
function tangentDir(centre: V3, axis: V3, attach: V3, along: V3): V3 | null {
  const d = sub(attach, centre);
  const off = sub(sub(d, scale(axis, dot(d, axis))), scale(along, dot(d, along)));
  return len(off) > 1e-9 ? unit(off) : null;
}

const firstSlide = (node: SceneNode): SceneJoint | undefined => (node.joints || []).find((j) => j.type === 'slide');
const firstHinge = (node: SceneNode): SceneJoint | undefined => (node.joints || []).find((j) => j.type === 'hinge');

/**
 * A rope's ends and wheel at the rest pose, with the problems that keep any
 * part of it from being coupled, by name.
 */
export function ropeLayout(rope: SceneNode, byId: Map<string, SceneNode>, poses: Record<string, Pose>): { layout?: RopeLayout; problems: string[] } {
  const problems: string[] = [];
  const ids = { left: rope.leftTargetId, right: rope.rightTargetId };
  if (!ids.left || !ids.right) return { problems: [`Rope '${rope.id}' needs both leftTargetId and rightTargetId, the bodies at its two ends.`] };
  const wheelNode = rope.pulleyWheelId ? byId.get(rope.pulleyWheelId) : undefined;
  const wheelJoint = wheelNode && firstHinge(wheelNode);
  if (wheelNode && !wheelJoint) problems.push(`Rope '${rope.id}' runs over '${wheelNode.id}', which has no hinge, so the wheel does not turn with it. Give it a hinge on its axle.`);
  const centre: V3 | null = wheelNode && poses[wheelNode.id] ? [...poses[wheelNode.id].pos] as V3 : null;

  const end = (side: 'left' | 'right'): RopeEnd | null => {
    const node = byId.get(ids[side]!);
    if (!node) return null;
    const j = firstSlide(node);
    if (!j) {
      const kinds = [...new Set((node.joints || []).map((x) => x.type))];
      problems.push(`Rope '${rope.id}': its ${side} end '${node.id}' has ${kinds.length ? `only a ${kinds.join(' and a ')} joint` : 'no joint'}, and a rope end must slide (a slide joint along the rope), so the rope was left out.`);
      return null;
    }
    const axisLocal = unit(j.axis ?? [0, 0, 1]);
    const pose = poses[node.id];
    let sign: 1 | -1 = 1;
    if (centre && pose) {
      const toward = dot(quatRotateVec(pose.quat, axisLocal), sub(centre, pose.pos));
      if (toward < 0) sign = -1;
    }
    return {
      nodeId: node.id, jointName: j.name, strands: strandsOf(rope[side === 'left' ? 'leftStrands' : 'rightStrands']),
      sign, axisLocal, attachLocal: faceToward(node, scale(axisLocal, sign)),
    };
  };
  const left = end('left'), right = end('right');
  if (!left || !right) return { problems };
  const linearRatio = -(right.strands * right.sign) / (left.strands * left.sign);
  const layout: RopeLayout = { left, right, linearRatio };

  if (wheelNode && wheelJoint && centre) {
    const wp = poses[wheelNode.id];
    const axisLocal = unit(wheelJoint.axis ?? [0, 0, 1]);
    const a = unit(quatRotateVec(wp.quat, axisLocal));
    const radius = wheelRadius(wheelNode);
    // Rope taken up on the left side runs toward the wheel there (+u) and
    // away from it on the right (−u): whichever side is not on the axis line.
    let spin: number | null = null;
    for (const [e, way] of [[left, 1], [right, -1]] as const) {
      const pose = poses[e.nodeId];
      if (!pose) continue;
      const u = scale(unit(quatRotateVec(pose.quat, e.axisLocal)), e.sign);
      const attach = add(pose.pos, quatRotateVec(pose.quat, e.attachLocal));
      const rho = tangentDir(centre, a, attach, u);
      if (!rho) continue;
      const k = dot(cross(a, rho), u);
      if (Math.abs(k) < 0.5) continue;
      spin = way * Math.sign(k);
      break;
    }
    if (spin === null) {
      problems.push(`Rope '${rope.id}': neither end's strand meets '${wheelNode.id}' square to its axle, so the wheel was not coupled. Hang the ends beside the wheel, sliding in its plane.`);
    } else {
      layout.wheel = { nodeId: wheelNode.id, jointName: wheelJoint.name, radius, axisLocal, turnsPerMetre: spin / radius };
    }
  }
  return { layout, problems };
}

/** One end as the renderer has it this frame. */
export interface LiveEnd { attach: V3; axis: V3; sign: 1 | -1; strands: number }

/**
 * The rope as polylines, world frame: from each end's attach point up to the
 * wheel's tangent point on its side, over the rim between them, and each
 * further strand of an end straight up to the wheel's level beside it.
 */
export function ropePolylines(left: LiveEnd, right: LiveEnd, wheel: { centre: V3; axis: V3; radius: number } | null, segments = 16): V3[][] {
  if (!wheel) return [[left.attach, right.attach]];
  const { centre: c, axis: a, radius: r } = wheel;
  const uL = scale(unit(left.axis), left.sign), uR = scale(unit(right.axis), right.sign);
  const rhoL = tangentDir(c, a, left.attach, uL), rhoR = tangentDir(c, a, right.attach, uR);
  if (!rhoL || !rhoR) return [[left.attach, c, right.attach]];
  // Over the far side of the rim from the ends.
  let up = add(uL, uR);
  up = sub(up, scale(a, dot(up, a)));
  const b1 = len(up) > 1e-9 ? unit(up) : unit(cross(rhoL, a));
  const b2 = cross(a, b1);
  const angle = (v: V3) => Math.atan2(dot(v, b2), dot(v, b1));
  const phiL = angle(rhoL), phiR = angle(rhoR);
  const main: V3[] = [left.attach];
  for (let i = 0; i <= segments; i++) {
    const phi = phiL + ((phiR - phiL) * i) / segments;
    main.push(add(c, add(scale(b1, r * Math.cos(phi)), scale(b2, r * Math.sin(phi)))));
  }
  main.push(right.attach);
  const lines: V3[][] = [main];
  for (const [e, u, rho] of [[left, uL, rhoL], [right, uR, rhoR]] as const) {
    const gap = Math.max(0.004, 0.4 * r);
    const rise = dot(sub(c, e.attach), u);
    for (let k = 1; k < Math.round(e.strands); k++) {
      const foot = add(e.attach, scale(rho, k * gap));
      lines.push([foot, add(foot, scale(u, rise))]);
    }
  }
  return lines;
}
