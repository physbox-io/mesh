// ---------------------------------------------------------------------------
// Which hinged gears mesh with which, for the proximity coupling in mjcf.ts.
//
// Every hinge body whose id says 'gear' used to be coupled to every other
// within 1.2·(r1 + r2) of body origin to body origin, the radius being the
// first geom's, whatever plane or axis either turned in. A folded train of
// arbors (a 32 mm wheel and an 8 mm pinion on each) coupled pairs that only
// passed each other in different planes, the train locked, and its motor
// stalled at 0 rad/s with no word why.
//
// Two gears mesh here when their axes are parallel and they have a wheel each
// that overlaps the other along the axis (the same plane), at a centre
// distance between half and 1.2 times the sum of those two wheels' radii.
// Each wheel is a geom of its own: a body carrying a wheel and a pinion at
// different heights offers both. Gears already joined by explicit couplings
// (coupleTargetId), directly or along a chain, are left to those.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { quatRotateVec, type QuatWXYZ } from './sceneTree';

type V3 = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: number[]): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** One toothed wheel of a gear body: its radius and where it lies along the axis (world, m). */
export interface Wheel { radius: number; lo: number; hi: number }

export interface GearBody {
  jointName: string;
  nodeId: string;
  /** The hinge's anchor and unit axis, world. */
  origin: V3;
  axis: V3;
  wheels: Wheel[];
}

/**
 * A hinged gear body as the proximity coupling sees it. `pitchRadius` is a cut
 * gear's tooth form, which stands for every geom of it.
 */
export function gearBody(node: SceneNode, j: SceneJoint, world: { pos: number[]; quat: QuatWXYZ }, pitchRadius?: number): GearBody {
  const axis = unit(quatRotateVec(world.quat, j.axis ?? [0, 0, 1]));
  const origin = add(world.pos, quatRotateVec(world.quat, j.pos ?? [0, 0, 0]));
  const along = (p: number[]) => dot(sub(add(world.pos, quatRotateVec(world.quat, p)), origin), axis);
  const radial = (p: number[]) => {
    const d = sub(add(world.pos, quatRotateVec(world.quat, p)), origin);
    const a = dot(d, axis);
    return Math.hypot(...sub(d, scale(axis, a)));
  };
  const extent = (g: SceneGeom): { lo: number; hi: number; r: number } | null => {
    const gp = g.pos ?? [0, 0, 0];
    if (g.type === 'mesh') {
      const v = g.renderVertices;
      if (!v?.length) return null;
      let lo = Infinity, hi = -Infinity, r = 0;
      for (let i = 0; i < v.length; i += 3) {
        const p = [v[i] + gp[0], v[i + 1] + gp[1], v[i + 2] + gp[2]];
        const a = along(p);
        if (a < lo) lo = a;
        if (a > hi) hi = a;
        r = Math.max(r, radial(p));
      }
      return { lo, hi, r };
    }
    if (g.type === 'cylinder' || g.type === 'capsule') {
      const c = along(gp), h = g.size?.[1] ?? g.size?.[0] ?? 0;
      return { lo: c - h, hi: c + h, r: g.size?.[0] ?? 0 };
    }
    return null;
  };
  const solid = (node.geoms || []).filter((g) => g.csg !== 'difference');
  let wheels: Wheel[] = [];
  if (pitchRadius !== undefined) {
    // A cut gear is one wheel at its pitch circle, as thick as all of it.
    const spans = solid.map(extent).filter((e): e is NonNullable<typeof e> => !!e);
    const lo = spans.length ? Math.min(...spans.map((e) => e.lo)) : -Infinity;
    const hi = spans.length ? Math.max(...spans.map((e) => e.hi)) : Infinity;
    wheels = [{ radius: pitchRadius, lo, hi }];
  } else {
    for (const g of solid) {
      if (g.role === 'visual') continue;
      const e = extent(g);
      if (e && e.r > 0) wheels.push({ radius: e.r, lo: e.lo, hi: e.hi });
    }
    if (!wheels.length) {
      // Nothing round to go by: the first geom's size, in every plane.
      const r = node.geoms?.[0]?.size?.[0] ?? 0.25;
      wheels = [{ radius: r, lo: -Infinity, hi: Infinity }];
    }
  }
  return { jointName: j.name, nodeId: node.id, origin, axis, wheels };
}

export interface GearMesh { a: GearBody; b: GearBody; ratio: number }

/**
 * The pairs that mesh, with q(a) = ratio · q(b): meshing teeth roll the same
 * arc, r_a·θ_a = −r_b·θ_b, so ratio = −r_b / r_a.
 */
export function meshingGears(gears: GearBody[], sameChain: (a: string, b: string) => boolean): GearMesh[] {
  const out: GearMesh[] = [];
  for (let i = 0; i < gears.length; i++) {
    for (let k = i + 1; k < gears.length; k++) {
      const a = gears[i], b = gears[k];
      if (a.nodeId === b.nodeId || sameChain(a.jointName, b.jointName)) continue;
      const cos = dot(a.axis, b.axis);
      if (Math.abs(cos) < 0.999) continue;
      const d = sub(b.origin, a.origin);
      const centre = Math.hypot(...sub(d, scale(a.axis, dot(d, a.axis))));
      // b's axial positions in a's coordinate: shifted by b's origin along a's
      // axis, and reversed when b's axis points the other way.
      const shift = dot(d, a.axis);
      let best: { ratio: number; miss: number } | null = null;
      for (const wa of a.wheels) {
        for (const wb of b.wheels) {
          const lo = shift + Math.min(cos * wb.lo, cos * wb.hi);
          const hi = shift + Math.max(cos * wb.lo, cos * wb.hi);
          if (Math.min(wa.hi, hi) - Math.max(wa.lo, lo) < -1e-4) continue;
          const sum = wa.radius + wb.radius;
          if (!(sum > 0) || centre > 1.2 * sum || centre < 0.5 * sum) continue;
          const miss = Math.abs(centre - sum);
          // Opposite axes turn the other way round in a's frame.
          const ratio = -(wb.radius / wa.radius) * Math.sign(cos);
          if (!best || miss < best.miss) best = { ratio, miss };
        }
      }
      if (best) out.push({ a, b, ratio: best.ratio });
    }
  }
  return out;
}
