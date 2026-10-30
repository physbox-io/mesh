// ---------------------------------------------------------------------------
// Which racks mesh with which pinions, for the proximity coupling.
//
// Every slide body whose id contained 'rack' used to be coupled to every hinge
// whose id contained 'pinion' within 0.5 m, at x = +r·θ: a 'bracket' sliding
// in Z 360 mm away moved with the pinion, and a rack above it moved the same
// way as one below, which teeth cannot do.
//
// A rack is a slide body that says it is one: cut as a rack (toothForm), or
// marked isRack. It meshes with a hinged wheel (a round geom, or a cut gear's
// pitch circle) when the slide runs square to the hinge axis, the rack lies
// in the wheel's plane, its face toward the wheel is about one pitch radius
// from the axis, and the wheel sits over the rack's length. A cut rack's
// origin is on its pitch line, so that is the face. Rolling without slip at
// the contact point n (from the axis to the rack): r·θ̇·(a × n̂) = ẋ·s, so
// θ = x / (r·k) with k = (a × n̂)·s, ±1 by the side the rack is on.
// ---------------------------------------------------------------------------

import type { SceneJoint, SceneNode } from '../types/scene';
import type { GearBody } from './gearMeshing';
import { geomBounds } from './csg';
import { quatRotateVec, type QuatWXYZ } from './sceneTree';

type V3 = [number, number, number];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: number[], b: number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Whether a body is a rack: cut as one, or marked so. */
export const isRackBody = (node: SceneNode): boolean => node.isRack === true || node.toothForm?.kind === 'rack';

export interface RackBody {
  jointName: string;
  nodeId: string;
  /** The body's origin and the slide's unit axis, world. */
  origin: V3;
  axis: V3;
  /** Its origin is on the pitch line (a cut rack), rather than inside the bar. */
  pitchAtOrigin: boolean;
  /** The corners of its solid geoms' bounds, world. */
  corners: V3[];
}

export function rackBody(node: SceneNode, j: SceneJoint, world: { pos: number[]; quat: QuatWXYZ }): RackBody {
  const toWorld = (p: number[]) => add(world.pos, quatRotateVec(world.quat, p));
  const corners: V3[] = [];
  for (const g of node.geoms || []) {
    if (g.csg === 'difference' || g.role === 'visual') continue;
    const b = geomBounds(g);
    if (!b) continue;
    for (let i = 0; i < 8; i++) {
      corners.push(toWorld([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]));
    }
  }
  return {
    jointName: j.name, nodeId: node.id,
    origin: toWorld(j.pos ?? [0, 0, 0]),
    axis: unit(quatRotateVec(world.quat, j.axis ?? [0, 0, 1])),
    pitchAtOrigin: node.toothForm?.kind === 'rack',
    corners: corners.length ? corners : [toWorld([0, 0, 0])],
  };
}

export interface RackMesh { pinion: GearBody; rack: RackBody; radius: number; turnsPerMetre: number }

/** How far the rack's face may sit off the pitch radius, as a share of it. */
const FACE_TOLERANCE = 0.3;

/** The rack-pinion pairs that mesh, with θ(pinion) = turnsPerMetre · x(rack). */
export function meshingRacks(pinions: GearBody[], racks: RackBody[], sameChain: (a: string, b: string) => boolean): RackMesh[] {
  const out: RackMesh[] = [];
  for (const rack of racks) {
    for (const p of pinions) {
      if (p.nodeId === rack.nodeId || sameChain(p.jointName, rack.jointName)) continue;
      const a = p.axis, s = rack.axis;
      // The slide runs square to the axis: a tangent at the contact point.
      if (Math.abs(dot(a, s)) > 0.05) continue;
      // From the axis to the rack's line, square to both.
      const w = sub(rack.origin, p.origin);
      const perp = sub(sub(w, scale(a, dot(w, a))), scale(s, dot(w, s)));
      const dist = Math.hypot(...perp);
      if (!(dist > 1e-6)) continue;
      const n = scale(perp, 1 / dist);
      const face = rack.pitchAtOrigin ? dist : Math.min(...rack.corners.map((c) => dot(sub(c, p.origin), n)));
      // The wheel sits over the rack's length, not past its end.
      const along = rack.corners.map((c) => dot(sub(c, rack.origin), s));
      const t = -dot(w, s);
      // Within the wheel's plane.
      const axial = rack.corners.map((c) => dot(sub(c, p.origin), a));
      const lo = Math.min(...axial), hi = Math.max(...axial);
      let best: { radius: number; miss: number } | null = null;
      for (const wheel of p.wheels) {
        if (Math.min(wheel.hi, hi) - Math.max(wheel.lo, lo) < -1e-4) continue;
        const r = wheel.radius;
        if (!(r > 0)) continue;
        const miss = Math.abs(face - r);
        if (miss > Math.max(FACE_TOLERANCE * r, 0.001)) continue;
        if (t < Math.min(...along) - r || t > Math.max(...along) + r) continue;
        if (!best || miss < best.miss) best = { radius: r, miss };
      }
      if (!best) continue;
      const k = dot(cross(a, n), s);
      out.push({ pinion: p, rack, radius: best.radius, turnsPerMetre: 1 / (best.radius * (k >= 0 ? 1 : -1)) });
    }
  }
  return out;
}
