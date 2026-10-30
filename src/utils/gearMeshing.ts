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

/**
 * One toothed wheel of a gear body: its radius and where it lies along the
 * axis (world, m), and its tooth count when its outline shows one.
 */
export interface Wheel { radius: number; lo: number; hi: number; teeth?: number }

/**
 * Teeth counted on a mesh's outline: the angular bins (about the axis) whose
 * outermost point is nearer the tip than the root, counted as runs. Only an
 * outline whose depth is a gear's for that many teeth counts: a standard
 * tooth is 2.25 modules deep on a tip radius of (N + 2)/2 modules, so
 * depth/tip·N = 4.5·N/(N + 2), 3.2 to 4.5. A hexagon (0.8) is not a gear.
 */
export function countTeeth(points: { angle: number; r: number }[]): number | undefined {
  let rMax = 0;
  for (const p of points) rMax = Math.max(rMax, p.r);
  if (!(rMax > 0)) return undefined;
  const BINS = 720;
  const bins = new Float64Array(BINS).fill(-1);
  for (const p of points) {
    // Bores and hubs are well inside any root circle.
    if (p.r < 0.5 * rMax) continue;
    const b = Math.floor(((p.angle / (2 * Math.PI)) % 1 + 1) % 1 * BINS) % BINS;
    if (p.r > bins[b]) bins[b] = p.r;
  }
  const filled = [...bins].filter((r) => r >= 0);
  if (filled.length < 10) return undefined;
  const rLow = Math.min(...filled);
  const depth = rMax - rLow;
  if (depth < 0.04 * rMax) return undefined;
  const mid = (rMax + rLow) / 2;
  const high = filled.map((r) => r > mid);
  let teeth = 0;
  for (let i = 0; i < high.length; i++) if (high[i] && !high[(i + high.length - 1) % high.length]) teeth++;
  const q = (depth / rMax) * teeth;
  return teeth >= 5 && q >= 1.5 && q <= 9 ? teeth : undefined;
}

export interface GearBody {
  jointName: string;
  nodeId: string;
  /** The hinge's anchor and unit axis, world. */
  origin: V3;
  axis: V3;
  wheels: Wheel[];
  /** Nothing round to go by: its wheel is the first geom's size. */
  guessed?: boolean;
}

interface MeshExtent { lo: number; hi: number; r: number; teeth?: number }

/**
 * A mesh's span along a hinge and its widest radius from it, with its teeth:
 * in the body frame, so the same whatever the pose, and kept per vertex array.
 * Every hinged body is weighed as a possible pinion on every compile.
 */
const meshExtents = new WeakMap<number[], Map<string, MeshExtent>>();
function meshExtent(v: number[], gp: number[], j: SceneJoint): MeshExtent {
  const axis = unit(j.axis ?? [0, 0, 1]);
  const jp = j.pos ?? [0, 0, 0];
  const key = [...gp, ...jp, ...axis].join(',');
  let byKey = meshExtents.get(v);
  const hit = byKey?.get(key);
  if (hit) return hit;
  // A basis square to the axis, for angles about it.
  const e1 = unit(Math.abs(axis[0]) < 0.9 ? [0, -axis[2], axis[1]] : [-axis[2], 0, axis[0]]);
  const e2: V3 = [axis[1] * e1[2] - axis[2] * e1[1], axis[2] * e1[0] - axis[0] * e1[2], axis[0] * e1[1] - axis[1] * e1[0]];
  let lo = Infinity, hi = -Infinity, r = 0;
  const outline: { angle: number; r: number }[] = [];
  for (let i = 0; i < v.length; i += 3) {
    const d = [v[i] + gp[0] - jp[0], v[i + 1] + gp[1] - jp[1], v[i + 2] + gp[2] - jp[2]];
    const a = dot(d, axis);
    if (a < lo) lo = a;
    if (a > hi) hi = a;
    const x = dot(d, e1), y = dot(d, e2);
    const rad = Math.hypot(x, y);
    if (rad > r) r = rad;
    outline.push({ angle: Math.atan2(y, x), r: rad });
  }
  const teeth = countTeeth(outline);
  const out: MeshExtent = { lo, hi, r, ...(teeth ? { teeth } : {}) };
  if (!byKey) meshExtents.set(v, (byKey = new Map()));
  byKey.set(key, out);
  return out;
}

/**
 * A hinged gear body as the proximity coupling sees it. `pitchRadius` is a cut
 * gear's tooth form, which stands for every geom of it.
 */
export function gearBody(node: SceneNode, j: SceneJoint, world: { pos: number[]; quat: QuatWXYZ }, pitchRadius?: number): GearBody {
  const axis = unit(quatRotateVec(world.quat, j.axis ?? [0, 0, 1]));
  const origin = add(world.pos, quatRotateVec(world.quat, j.pos ?? [0, 0, 0]));
  const along = (p: number[]) => dot(sub(add(world.pos, quatRotateVec(world.quat, p)), origin), axis);
  const extent = (g: SceneGeom): MeshExtent | null => {
    const gp = g.pos ?? [0, 0, 0];
    if (g.type === 'mesh') return g.renderVertices?.length ? meshExtent(g.renderVertices, gp, j) : null;
    if (g.type === 'cylinder' || g.type === 'capsule') {
      const c = along(gp), h = g.size?.[1] ?? g.size?.[0] ?? 0;
      return { lo: c - h, hi: c + h, r: g.size?.[0] ?? 0 };
    }
    return null;
  };
  const solid = (node.geoms || []).filter((g) => g.csg !== 'difference' && g.role !== 'visual');
  const cylinders: Wheel[] = [];
  const meshes: Wheel[] = [];
  for (const g of solid) {
    const e = extent(g);
    if (!e || !(e.r > 0)) continue;
    // A toothed outline's radius is its pitch circle, (N + 2)/2 modules
    // inside a tip of N/2: what two such wheels' centres are apart.
    if (e.teeth) meshes.push({ radius: (e.r * e.teeth) / (e.teeth + 2), lo: e.lo, hi: e.hi, teeth: e.teeth });
    else (g.type === 'mesh' ? meshes : cylinders).push({ radius: e.r, lo: e.lo, hi: e.hi });
  }
  let wheels: Wheel[];
  let guessed = false;
  if (cylinders.length) {
    // Round colliders are the pitch circles: a mechanism-builder gear's, or
    // each gear of a compound arbor built onto one hinge.
    wheels = cylinders;
  } else if (pitchRadius !== undefined) {
    // A cut gear is one wheel at its pitch circle, as thick as all of it.
    const spans = (node.geoms || []).filter((g) => g.csg !== 'difference').map(extent).filter((e): e is NonNullable<typeof e> => !!e);
    const lo = spans.length ? Math.min(...spans.map((e) => e.lo)) : -Infinity;
    const hi = spans.length ? Math.max(...spans.map((e) => e.hi)) : Infinity;
    const teeth = node.toothForm?.kind === 'involute' ? node.toothForm.teeth : undefined;
    wheels = [{ radius: pitchRadius, lo, hi, ...(teeth ? { teeth } : {}) }];
  } else if (meshes.length) {
    wheels = meshes;
  } else {
    // Nothing round to go by: the first geom's size, in every plane.
    wheels = [{ radius: node.geoms?.[0]?.size?.[0] ?? 0.25, lo: -Infinity, hi: Infinity }];
    guessed = true;
  }
  return { jointName: j.name, nodeId: node.id, origin, axis, wheels, ...(guessed ? { guessed } : {}) };
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
          // Opposite axes turn the other way round in a's frame. Teeth, when
          // both outlines show them, are the exact ratio.
          const ratio = -(wa.teeth && wb.teeth ? wb.teeth / wa.teeth : wb.radius / wa.radius) * Math.sign(cos);
          if (!best || miss < best.miss) best = { ratio, miss };
        }
      }
      if (best) out.push({ a, b, ratio: best.ratio });
    }
  }
  return out;
}
