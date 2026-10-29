// ---------------------------------------------------------------------------
// Dry friction on a coupled joint, moved to where the chain can feel it.
//
// MuJoCo's friction is a soft constraint whose give is scaled by the joint's
// OWN inverse inertia, with no knowledge of what it is coupled to. On the
// light output of a 256:1 train that give is huge next to the chain's: the
// friction crept at whatever speed the motor drove, so 0.5, 10 and 100 N·m on
// the output gave bit-identical runs and never reached the motor.
//
// Through a rigid coupling, friction τ on joint f is the same thing as τ/|r|
// on joint T, where r = dq_T/dq_f (virtual work). So it is emitted on the
// member of the coupled chain that carries the most of the chain's inertia
// in its own coordinate: the one with the largest I_T·r_T². There its give is
// small next to the chain's, and it holds: a 100 N·m output load stalls a
// 0.05 N·m motor, as 100/256 > 0.05 says it must.
// tests/coupledFriction.test.ts.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { geomVolume } from './deformMaterials';

/** A coupling: q(joint1) = ratio · q(joint2). */
export interface CouplingEdge { joint1: string; joint2: string; ratio: number }

type V3 = [number, number, number];
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm2 = (a: number[]) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];

function geomMass(g: SceneGeom): number {
  if (g.role === 'visual' || g.csg === 'difference') return 0;
  return typeof g.mass === 'number' ? g.mass : (g.density ?? 1000) * geomVolume(g);
}

/** A geom's moment of inertia about a line through `p` along unit `a`, in the frame `offset` is added in. Rough: orientation is ignored. */
function geomMoment(g: SceneGeom, offset: number[], p: number[], a: number[]): number {
  const m = geomMass(g);
  if (!(m > 0)) return 0;
  if (g.type === 'mesh') {
    const v = g.renderVertices || g.vertices;
    if (!v?.length) return 0;
    // Spread over its vertices: about right for a gear or a link bar.
    let sum = 0;
    const n = v.length / 3;
    for (let i = 0; i < v.length; i += 3) sum += norm2(cross(sub([v[i] + offset[0], v[i + 1] + offset[1], v[i + 2] + offset[2]], p), a));
    return 0.6 * m * (sum / n);
  }
  const s = g.size || [];
  const c = g.fromto
    ? [(g.fromto[0] + g.fromto[3]) / 2, (g.fromto[1] + g.fromto[4]) / 2, (g.fromto[2] + g.fromto[5]) / 2]
    : (g.pos ?? [0, 0, 0]);
  const d2 = norm2(cross(sub([c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]], p), a));
  let own: number;
  switch (g.type) {
    case 'sphere': own = 0.4 * (s[0] ?? 0) ** 2; break;
    case 'cylinder': case 'capsule': own = 0.5 * (s[0] ?? 0) ** 2; break;
    case 'ellipsoid': own = 0.2 * ((s[0] ?? 0) ** 2 + (s[1] ?? 0) ** 2); break;
    default: own = ((s[0] ?? 0) ** 2 + (s[1] ?? 0) ** 2 + (s[2] ?? 0) ** 2) * (2 / 9);
  }
  return m * (own + d2);
}

/**
 * Roughly what joint `j` of `node` carries: kg·m² about a hinge's axis, kg
 * along a slide, its armature included. Everything below the body counts.
 */
export function estimateJointInertia(node: SceneNode, j: SceneJoint): number {
  const p = j.pos ?? [0, 0, 0];
  const ax = j.axis ?? [0, 0, 1];
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const a = [ax[0] / l, ax[1] / l, ax[2] / l];
  let total = j.armature ?? 0;
  const walk = (n: SceneNode, offset: number[]) => {
    for (const g of n.geoms || []) total += j.type === 'slide' ? geomMass(g) : geomMoment(g, offset, p, a);
    for (const c of n.children || []) walk(c, [offset[0] + (c.pos?.[0] ?? 0), offset[1] + (c.pos?.[1] ?? 0), offset[2] + (c.pos?.[2] ?? 0)]);
  };
  walk(node, [0, 0, 0]);
  return total;
}

/**
 * Where each coupled joint's dry friction goes: joint name -> frictionloss it
 * is emitted with. Joints not named keep their own. Only joints in a coupled
 * chain with friction on some member are named.
 */
export function relocateCoupledFriction(
  edges: CouplingEdge[],
  joints: Map<string, { node: SceneNode; joint: SceneJoint }>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!edges.length) return out;
  const adj = new Map<string, { to: string; ratio: number }[]>();
  const link = (a: string, b: string, r: number) => {
    if (!(Number.isFinite(r) && Math.abs(r) > 1e-12)) return;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, ratio: r });
  };
  // q1 = r·q2, so dq1/dq2 = r and dq2/dq1 = 1/r.
  for (const e of edges) { link(e.joint2, e.joint1, e.ratio); link(e.joint1, e.joint2, 1 / e.ratio); }
  const inertia = new Map<string, number>();
  const inertiaOf = (name: string) => {
    let v = inertia.get(name);
    if (v === undefined) {
      const it = joints.get(name);
      v = it ? estimateJointInertia(it.node, it.joint) : 0;
      inertia.set(name, v);
    }
    return v;
  };
  for (const [name, { joint }] of joints) {
    const f = joint.frictionloss;
    if (!f || !adj.has(name)) continue;
    // r_k = dq_k / dq_f over the chain.
    const r = new Map<string, number>([[name, 1]]);
    const queue = [name];
    while (queue.length) {
      const at = queue.shift()!;
      for (const { to, ratio } of adj.get(at) ?? []) {
        if (r.has(to)) continue;
        r.set(to, r.get(at)! * ratio);
        queue.push(to);
      }
    }
    let best = name;
    let bestScore = inertiaOf(name);
    for (const [k, rk] of r) {
      const score = inertiaOf(k) * rk * rk;
      if (joints.has(k) && score > bestScore * 1.0001) { best = k; bestScore = score; }
    }
    if (best === name) continue;
    out.set(name, out.get(name) ?? 0);
    out.set(best, (out.get(best) ?? joints.get(best)!.joint.frictionloss ?? 0) + f / Math.abs(r.get(best)!));
  }
  return out;
}
