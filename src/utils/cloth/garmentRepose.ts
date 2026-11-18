/**
 * What is drawn on a garment (its curves, sculpting, trims, darts, planes and
 * pulls: points in the form's frame) carried over when its form is posed
 * differently, so it stays where it was on the body, like skin. A point over
 * a limb keeps its distance along that limb and its offset round it in the
 * limb's own frame; one over the body moves as the body does (down with the
 * hips, on bent knees). Between the two, near where a limb leaves the body,
 * it blends from the one to the other.
 *
 * Done to the garment's data when the form changes (the store's updateNode,
 * which UI and MCP edits both go through), so what a garment says is always
 * in the frame of the form as it now is, as it is drawn and read back.
 */

import type { BodyFormMeasurements, ClothPull, FormLimbName, GarmentDraft, GarmentPoint } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { formLimbs, type FormLimb } from './formLimbs';
import { proportions } from './formProportions';
import { bodyFormSection, bodyLandmarks } from './bodyForm';

/** The measurements that pose the form rather than size it. */
export const POSE_FIELDS = ['armAngle', 'elbowBend', 'stance', 'kneeBend'] as const;

export const posedDifferently = (a: BodyFormMeasurements, b: BodyFormMeasurements) => POSE_FIELDS.some((k) => (a[k] ?? 0) !== (b[k] ?? 0));

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map((v) => v / l); };
const smooth = (t: number) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };

/** A limb's frame at its root: along it, forward (or up, for one running front to back), and the third. */
function rootFrame(l: FormLimb) {
  const t = l.path.tangent(0), ref = Math.abs(t[1]) > 0.9 ? [0, 0, 1] : [0, -1, 0];
  const f = unit(ref.map((v, k) => v - t[k] * dot(ref, t)));
  return [t, f, cross(t, f)];
}

/** How far past a limb's surface a point may be and still be on it (a padded sleeve stands well off), at a 1.75 m figure. */
const REACH = 0.15;
/** Over how much of a limb, from its root, a point goes over from moving with the body to moving with the limb, at a 1.75 m figure. */
const BLEND = 0.08;

/** Maps points (and directions at them) drawn on a form posed as `from` to the same places on it posed as `to`. */
export function reposer(from: BodyFormMeasurements, to: BodyFormMeasurements, names: readonly FormLimbName[] = ['armL', 'armR', 'legL', 'legR']) {
  const A = formLimbs(from), B = formLimbs(to), S = from.height / 1.75;
  const dz = proportions(from).drop - proportions(to).drop;
  const frames = names.map((n) => ({ a: A[n], b: B[n], fa: rootFrame(A[n]), fb: rootFrame(B[n]) }));
  // How far a point is off the body's own surface (none below the crotch, where the legs are).
  const crotch = bodyLandmarks(from).crotchZ;
  const offBody = (p: number[]) => {
    if (p[2] < crotch) return Infinity;
    const sec = bodyFormSection(from, p[2]), n = sec.radii.length, a = Math.atan2(p[1] - sec.centreY, p[0]);
    return Math.hypot(p[0], p[1] - sec.centreY) - sec.radii[((Math.round((a / (2 * Math.PI)) * n) % n) + n) % n];
  };
  /** The limb a point is on (nearer it than the body), where along it, and how much it moves with it. */
  const owner = (p: number[]) => {
    let best: { i: number; s: number; c: number[]; w: number } | null = null, bd = Math.min(REACH * S, offBody(p));
    frames.forEach((f, i) => {
      const cl = f.a.path.closest(p, f.a.length), sec = f.a.section(Math.min(f.a.length, Math.max(0, cl.s)));
      const d = Math.hypot(p[0] - cl.p[0], p[1] - cl.p[1], p[2] - cl.p[2]) - Math.max(sec.w, sec.h);
      if (d < bd) { bd = d; best = { i, s: cl.s, c: cl.p, w: smooth(cl.s / (BLEND * S)) }; }
    });
    return best as { i: number; s: number; c: number[]; w: number } | null;
  };
  // Back to the limb's root frame as drawn, then out along it as posed.
  const turn = (i: number, s: number, v: number[]) => {
    const f = frames[i], u = f.a.path.carry(v, s, 0), k = f.fa.map((e) => dot(e, u));
    return f.b.path.carry([0, 1, 2].map((q) => f.fb[0][q] * k[0] + f.fb[1][q] * k[1] + f.fb[2][q] * k[2]), 0, s);
  };
  const point = (p: number[]): number[] => {
    const body = [p[0], p[1], p[2] + dz], o = owner(p);
    if (!o || o.w <= 0) return body;
    const v = turn(o.i, o.s, [p[0] - o.c[0], p[1] - o.c[1], p[2] - o.c[2]]), c = frames[o.i].b.path.at(o.s);
    return [0, 1, 2].map((k) => body[k] + (c[k] + v[k] - body[k]) * o.w);
  };
  const direction = (p: number[], d: number[]): number[] => { const o = owner(p); return o && o.w > 0.5 ? turn(o.i, o.s, d) : d; };
  return { point, direction, dz };
}

const r6 = (v: number) => +v.toFixed(6);
const pt3 = (p: number[]) => p.map(r6) as [number, number, number];

/** A garment's drawn data carried from its form posed as `from` to `to`. */
export function reposeDraft(draft: GarmentDraft, from: BodyFormMeasurements, to: BodyFormMeasurements): GarmentDraft {
  const R = reposer(from, to), P = (p: number[]) => pt3(R.point(p));
  // Planes and heights are drawn on the legs hung straight from the hips
  // (garmentShell, straightened): over a leg they go down with the hips only.
  const Rs = reposer(from, to, ['armL', 'armR']);
  const gp = (g: GarmentPoint | undefined): GarmentPoint | undefined => (Array.isArray(g) ? P(g) : g);
  const plane = <T extends { point: number[]; normal: number[]; z?: [number, number] }>(pl: T): T => ({
    ...pl, point: pt3(Rs.point(pl.point)), normal: Rs.direction(pl.point, pl.normal).map(r6),
    ...(pl.z ? { z: [r6(pl.z[0] + R.dz), r6(pl.z[1] + R.dz)] as [number, number] } : {}),
  });
  const out: GarmentDraft = { ...draft };
  if (typeof draft.top === 'number') out.top = r6(draft.top + R.dz);
  if (draft.curves) out.curves = draft.curves.map((c) => ({ ...c, points: c.points.map(P) }));
  if (draft.sculpt) out.sculpt = draft.sculpt.map((d) => ({ ...d, at: P(d.at) }));
  if (draft.trims) out.trims = draft.trims.map((t) => (t.at ? { ...t, at: P(t.at) } : t));
  if (draft.cuts) out.cuts = draft.cuts.map(plane);
  if (draft.seams) out.seams = draft.seams.map(plane);
  if (Array.isArray(draft.darts)) {
    out.darts = draft.darts.map((d) => ({
      ...d, apex: gp(d.apex)!, ...(d.to !== undefined ? { to: gp(d.to) } : {}),
      ...(d.direction && Array.isArray(d.apex) ? { direction: R.direction(d.apex, d.direction).map(r6) } : {}),
    }));
  }
  if (draft.belt && typeof draft.belt === 'object' && draft.belt.at !== undefined) out.belt = { ...draft.belt, at: r6(draft.belt.at + R.dz) };
  return out;
}

const reposePull = (pull: ClothPull, R: ReturnType<typeof reposer>): ClothPull => ({
  ...pull, to: pt3(R.point(pull.to)), ...(pull.via ? { via: pull.via.map((p) => pt3(R.point(p))) } : {}),
});

/**
 * `nodes` with every garment fitted to the form named `form` carried from its
 * pose `from` to `to`; the same array when there is none, or the pose is the same.
 */
export function reposeGarments(nodes: SceneNode[], form: string, from: BodyFormMeasurements, to: BodyFormMeasurements): SceneNode[] {
  if (!posedDifferently(from, to)) return nodes;
  let R: ReturnType<typeof reposer> | null = null;
  const one = (n: SceneNode): SceneNode => {
    const children = n.children?.length ? walk(n.children) : n.children;
    const draft = n.cloth?.garment;
    if (draft?.fitTo !== form) return children === n.children ? n : { ...n, children };
    R ??= reposer(from, to);
    const arrange = n.cloth!.arrange;
    return { ...n, children, cloth: { ...n.cloth!, garment: reposeDraft(draft, from, to), ...(arrange ? { arrange: arrange.map((a) => ('to' in a ? reposePull(a, R!) : a)) } : {}) } };
  };
  const walk = (list: SceneNode[]): SceneNode[] => { const out = list.map(one); return out.every((n, i) => n === list[i]) ? list : out; };
  return walk(nodes);
}
