// A long, thin part as a structural member: where its axis runs, what its
// cross-section is, and what that section carries before it fails.
//
// MuJoCo bodies are rigid, so nothing inside one ever feels a load. A member
// that is to break under load is therefore compiled as TWO halves welded at
// the middle (see utils/breakModel.ts), and the solver reports the moment and
// force it spends holding that weld — the bending moment and the axial force
// at mid-span, which for a beam loaded anywhere between its supports, and for
// a column, is where the worst of them is. The ends, where a member meets a
// joint, are covered by the joint's own weld, which takes the lower of the
// joint's limit and the member's.
//
// The limits are ordinary strength of materials:
//
//   bending   M = sigma_flex * S     S = pi r^3 / 4 (rod), b h^2 / 6 (bar)
//   pulling   F = sigma_tensile * A
//   buckling  P = pi^2 E I / L^2     (pinned ends, the whole length)
//
// Buckling needs its own limit because a straight column never buckles in the
// solver: nothing pushes it sideways. Measured on a spaghetti tower, a 1 kg
// load bent the posts' mid-span welds by a tenth of what snaps them, when a
// real 100 mm post buckles at about 2 N.
//
// PURE. MuJoCo Z-up body frame throughout, metres.

import type { LoadStrength, SceneGeom, SceneNode } from '../types/scene';
import { nodeLocalQuat, quatRotateVec } from './sceneTree';

type V3 = [number, number, number];

/**
 * Long against thick, below which a part is not a member. A stubby block
 * breaks by being hit (shattering), not by being leaned on; and the two-half
 * model reads the bending at a weld across a section as wide as the halves
 * are long, which stops meaning anything for a cube.
 */
export const MIN_SLENDERNESS = 8;

/**
 * A cross-section. A bar's `w` is its wide side and `h` its thin one, and
 * `wide` is the direction `w` runs in, in the body frame: a plank bends
 * easily one way and hardly at all the other (a joist stood on edge is five
 * times stiffer than laid flat), so which way it is loaded matters.
 */
export type Section = { kind: 'round'; r: number } | { kind: 'rect'; w: number; h: number; wide: V3 };

export interface MemberShape {
  /** The geom that is the member. */
  geomIndex: number;
  /** Its axis, end to end, in the body frame. */
  a: V3;
  b: V3;
  length: number;
  section: Section;
}

const sub = (p: V3, q: V3): V3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const add = (p: V3, q: V3): V3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
const scale = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const len = (p: V3) => Math.hypot(p[0], p[1], p[2]);

/** A geom's own rotation, as MJCF reads its `quat` or (degrees, intrinsic XYZ) `euler`. */
function geomQuat(g: SceneGeom) {
  return nodeLocalQuat({ quat: g.quat, euler: g.euler, geoms: [] } as unknown as SceneNode);
}

/** The geoms that carry the body: not cutters, not decoration. */
function solidGeoms(node: SceneNode): number[] {
  const out: number[] = [];
  (node.geoms || []).forEach((g, i) => {
    if (g.role !== 'visual' && g.csg !== 'difference' && !g.contactClass) out.push(i);
  });
  return out;
}

/**
 * The axis and section of one rod- or bar-shaped geom, or null for any other
 * shape. Not judged for slenderness: a joint blob asks this of short pegs too.
 */
export function geomAxis(g: SceneGeom): { a: V3; b: V3; section: Section } | null {
  const s = g.size || [];
  if (g.type === 'cylinder' || g.type === 'capsule') {
    const r = s[0] ?? 0;
    if (!(r > 0)) return null;
    if (g.fromto && g.fromto.length === 6) {
      const f = g.fromto;
      return { a: [f[0], f[1], f[2]], b: [f[3], f[4], f[5]], section: { kind: 'round', r } };
    }
    const hl = s[1] ?? 0;
    if (!(hl > 0)) return null;
    const c = (g.pos ?? [0, 0, 0]) as V3;
    const axis = quatRotateVec(geomQuat(g), [0, 0, hl]) as V3;
    return { a: sub(c, axis), b: add(c, axis), section: { kind: 'round', r } };
  }
  if (g.type === 'box') {
    const h = [s[0] ?? 0, s[1] ?? s[0] ?? 0, s[2] ?? s[0] ?? 0];
    if (!h.every((v) => v > 0)) return null;
    const k = h.indexOf(Math.max(...h));
    const [i, j] = [0, 1, 2].filter((x) => x !== k);
    const wi = h[i] >= h[j] ? i : j;
    const c = (g.pos ?? [0, 0, 0]) as V3;
    const q = geomQuat(g);
    const unit: V3 = [0, 0, 0];
    unit[k] = h[k];
    const axis = quatRotateVec(q, unit) as V3;
    const wideUnit: V3 = [0, 0, 0];
    wideUnit[wi] = 1;
    const wide = quatRotateVec(q, wideUnit) as V3;
    return { a: sub(c, axis), b: add(c, axis), section: { kind: 'rect', w: 2 * h[wi], h: 2 * h[wi === i ? j : i], wide } };
  }
  return null;
}

/** The section's greatest thickness, for slenderness. */
export function sectionDepth(s: Section): number {
  return s.kind === 'round' ? 2 * s.r : s.w;
}

/**
 * This body as a member, or null. It must be one solid rod or bar — a part
 * with several solid geoms is an assembly, and which of them would break is a
 * different question — and at least MIN_SLENDERNESS times as long as it is
 * thick.
 */
export function memberShape(node: SceneNode): MemberShape | null {
  const solid = solidGeoms(node);
  if (solid.length !== 1) return null;
  const g = node.geoms[solid[0]];
  const ax = geomAxis(g);
  if (!ax) return null;
  const length = len(sub(ax.b, ax.a));
  // A capsule's ends are rounded caps beyond the axis: part of how long it is.
  const overall = length + (g.type === 'capsule' && ax.section.kind === 'round' ? 2 * ax.section.r : 0);
  if (!(length > 0) || overall < MIN_SLENDERNESS * sectionDepth(ax.section)) return null;
  return { geomIndex: solid[0], a: ax.a, b: ax.b, length, section: ax.section };
}

export interface SectionLimits {
  /** Bending moment that snaps it (brittle) or bends it for good (ductile), N*m: the weak way. */
  bendingNm: number;
  /** The same, the strong way: across a bar's wide side. A rod's is the same as bendingNm. */
  bendingStrongNm: number;
  /** Pull that tears it apart, N. */
  tensionN: number;
  /** End-on push that buckles it, over its whole length, N. */
  bucklingN: number;
}

export function sectionProps(s: Section): { area: number; iMin: number; sMin: number; sMax: number } {
  if (s.kind === 'round') {
    const sec = (Math.PI * s.r ** 3) / 4;
    return { area: Math.PI * s.r * s.r, iMin: (Math.PI * s.r ** 4) / 4, sMin: sec, sMax: sec };
  }
  return { area: s.w * s.h, iMin: (s.w * s.h ** 3) / 12, sMin: (s.w * s.h * s.h) / 6, sMax: (s.h * s.w * s.w) / 6 };
}

export function sectionLimits(shape: Pick<MemberShape, 'section' | 'length'>, st: LoadStrength): SectionLimits {
  const { area, iMin, sMin, sMax } = sectionProps(shape.section);
  return {
    bendingNm: st.flexuralMPa * 1e6 * sMin,
    bendingStrongNm: st.flexuralMPa * 1e6 * sMax,
    tensionN: st.tensileMPa * 1e6 * area,
    bucklingN: (Math.PI ** 2 * st.modulusGPa * 1e9 * iMin) / (shape.length * shape.length),
  };
}

/**
 * The geom cut into its two halves, each a geom of the same kind. A rod comes
 * back as two `fromto` cylinders (or capsules); a bar as two boxes along its
 * long axis. An explicit mass is shared between them.
 */
export function halveGeom(g: SceneGeom, shape: MemberShape): [SceneGeom, SceneGeom] {
  const mid = scale(add(shape.a, shape.b), 0.5);
  const mass = typeof g.mass === 'number' ? { mass: g.mass / 2 } : {};
  if (shape.section.kind === 'round') {
    const base: SceneGeom = { ...g, ...mass, pos: undefined, quat: undefined, euler: undefined };
    return [
      { ...base, fromto: [...shape.a, ...mid] },
      { ...base, fromto: [...mid, ...shape.b] },
    ];
  }
  const s = g.size || [];
  const h = [s[0] ?? 0, s[1] ?? s[0] ?? 0, s[2] ?? s[0] ?? 0];
  const k = h.indexOf(Math.max(...h));
  const size = [...h];
  size[k] = h[k] / 2;
  const quarter = scale(sub(shape.b, shape.a), 0.25);
  return [
    { ...g, ...mass, size, pos: sub(mid, quarter) },
    { ...g, ...mass, size, pos: add(mid, quarter) },
  ];
}
