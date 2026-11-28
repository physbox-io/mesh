/**
 * Darts anywhere, in any direction: a draft's darts (GarmentDart) placed on
 * the form, and the slit each cuts in a garment's surface.
 *
 * A dart is a line on the garment from its apex: the garment's surface cut
 * by the plane through the apex that holds the dart's direction and the way
 * the garment faces there (seen from the apex's side, a straight line). Only
 * the run of that line through the panel the apex lies in, starting at the
 * apex, is slit: on to a seam or an edge (single-ended, open there), or as
 * far as asked each way (double-ended, closed at both ends inside the panel).
 * The flattener opens the slit into the dart's wedge (garmentFlatten), and
 * worn, its two sides are the same points: sewn closed.
 *
 * Z-up, metres, in the form's frame; +x the wearer's left, -y the front.
 */

import type { BodyFormMeasurements, BodyHeight, GarmentDart, GarmentPoint } from '../../types/cloth';
import { bodyFormSection, bodyLandmarks } from './bodyForm';
import { formLimbs } from './formLimbs';
import { mirrorSide } from './garmentCurves';

/** A place on the form: a point, and the way out from the body there, if it says (a ray out to the garment). */
export interface FormPlace { point: number[]; facing?: number[] }

/** A dart placed on the form, as the shell cuts it. */
export interface DartLine {
  name: string;
  apex: FormPlace;
  direction?: number[];
  to?: FormPlace;
  /** Along the direction from the apex, metres; Infinity: on to a seam or an edge. */
  length: number;
  back: number;
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? a.map((v) => v / l) : null; };

const HEIGHT_KEY: Record<BodyHeight, 'hpsZ' | 'shoulderZ' | 'bustZ' | 'waistZ' | 'hipZ' | 'crotchZ'> = {
  hps: 'hpsZ', shoulder: 'shoulderZ', bust: 'bustZ', waist: 'waistZ', hip: 'hipZ', crotch: 'crotchZ',
};

/** Where a GarmentPoint is on this form. */
export function formPlace(at: GarmentPoint, form: BodyFormMeasurements): FormPlace {
  if (Array.isArray(at)) return { point: at.slice(0, 3) };
  const L = bodyLandmarks(form);
  if ('landmark' in at) {
    const o = at.offset ?? [0, 0, 0];
    return { point: L[at.landmark].map((v, k) => v + (o[k] ?? 0)) };
  }
  if ('limb' in at) {
    const limb = formLimbs(form)[at.limb];
    const s = Math.min(limb.length, Math.max(0, (at.along === 'joint' ? limb.path.jointAt : at.along * limb.length) + (at.dAlong ?? 0)));
    const t = limb.path.tangent(s), f = at.face, sec = limb.section(s);
    // The face square to the limb there: out from its line to that side, to its surface.
    const facing = unit(sub(f, t.map((v) => v * dot(f, t))));
    if (!facing) return { point: sec.c };
    const r = 1 / Math.hypot(dot(facing, sec.side) / sec.w, dot(facing, sec.up) / sec.h);
    return { point: sec.c.map((v, k) => v + facing[k] * r), facing };
  }
  // On the body: out from its middle at that height, front or back, to its surface.
  const z = (typeof at.z === 'number' ? at.z : L[HEIGHT_KEY[at.z]]) + (at.dz ?? 0);
  const sec = bodyFormSection(form, Math.min(L.hpsZ, z)), n = sec.radii.length, sy = at.back ? 1 : -1, x = at.x ?? 0;
  const radiusAt = (th: number) => { const u = ((((th / (2 * Math.PI)) % 1) + 1) % 1) * n, i = Math.floor(u), w = u - i; return sec.radii[i % n] * (1 - w) + sec.radii[(i + 1) % n] * w; };
  let y = 0;
  while (y < 0.5 && Math.hypot(x, y) < radiusAt(Math.atan2(sy * y, x))) y += 0.001;
  return { point: [x, sec.centreY + sy * y, z], facing: [0, sy, 0] };
}

const mirrorPlace = (p: FormPlace): FormPlace => ({ point: [-p.point[0], p.point[1], p.point[2]], ...(p.facing ? { facing: [-p.facing[0], p.facing[1], p.facing[2]] } : {}) });

/** A draft's darts placed on the form, each with its mirror image if asked (a pair named L and R, by the side each is on). */
export function dartLines(darts: GarmentDart[], form: BodyFormMeasurements): DartLine[] {
  return darts.flatMap((d) => {
    const line: DartLine = {
      name: d.name,
      apex: formPlace(d.apex, form),
      ...(d.to ? { to: formPlace(d.to, form) } : d.direction ? { direction: d.direction.slice(0, 3) } : {}),
      length: d.length ?? Infinity,
      back: Math.max(0, d.back ?? 0),
    };
    if (!d.mirror) return [line];
    const m: DartLine = { ...line, apex: mirrorPlace(line.apex), ...(line.to ? { to: mirrorPlace(line.to) } : {}), ...(line.direction ? { direction: [-line.direction[0], line.direction[1], line.direction[2]] } : {}) };
    // By its apex's side, else the way it runs (an apex on the centre line); its own mirror image, one dart.
    const side = mirrorSide([line.apex.point[0], (line.to?.point[0] ?? 0) - line.apex.point[0], line.direction?.[0] ?? 0]);
    if (!side) return [line];
    return [{ ...line, name: `${d.name}${side}` }, { ...m, name: `${d.name}${side === 'L' ? 'R' : 'L'}` }];
  });
}

/**
 * The darts a bodice gets where it covers a bust in a cloth that will not go
 * over it as it is: from the side seam toward the bust point, ending short
 * of it (sloped down under a batwing's arm, and run on onto its web, short
 * of the shoulder); and, fitted under the bust, down from under it to the
 * hip, front and back, double-ended. `seamed` says where the draft's own
 * seams already shape it (a princess line takes the waist dart in).
 */
export function bodiceDarts(form: BodyFormMeasurements, fitted: boolean, slope: number, seamed: (p: number[], front: boolean) => boolean): GarmentDart[] {
  const L = bodyLandmarks(form), s = form.height / 1.75;
  const bx = L.bustPoint[0], zBust = L.bustZ - 0.02 * s, xTip = bx + 0.015 * s;
  const out: GarmentDart[] = [];
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'L' : 'R';
    out.push({
      name: `dart${tag}`, apex: { z: zBust, x: side * xTip }, direction: [side, 0, slope],
      ...(slope ? { length: (0.92 * L.shoulderPoint[0] - xTip) * Math.hypot(1, slope) } : {}),
    });
    if (!fitted) continue;
    const z0 = L.hipZ + 0.03 * s, z1 = L.bustZ - 0.04 * s, mid = (L.hipZ + L.bustZ) / 2;
    for (const [nm, front] of [['waistDartFront', true], ['waistDartBack', false]] as const) {
      if (seamed([side * bx * 0.95, front ? L.bustPoint[1] : -L.bustPoint[1], mid], front)) continue;
      out.push({ name: `${nm}${tag}`, apex: { z: mid, x: side * bx * 0.95, back: !front }, direction: [0, 0, 1], length: z1 - mid, back: mid - z0 });
    }
  }
  return out;
}

/** Whether one of `lines` already shapes near `p` (its apex within `r`). */
export const dartNear = (lines: DartLine[], p: number[], r: number) => lines.some((l) => Math.hypot(...sub(l.apex.point, p)) < r);

/** Where a place on the form is on the garment's surface: along its ray out, the first the surface meets; or the nearest. */
function onSurface(place: FormPlace, points: number[][], tris: number[]): { p: number[]; tri: number } | null {
  // From a little inside where it says, so a place on the skin still finds the garment out past it.
  const o = place.facing ? place.point.map((v, k) => v - 0.02 * place.facing![k]) : place.point;
  let best: { p: number[]; tri: number } | null = null, bt = Infinity;
  if (place.facing) {
    const dir = place.facing, d0 = dir[0], d1 = dir[1], d2 = dir[2];
    const o0 = o[0], o1 = o[1], o2 = o[2];
    for (let t = 0; t < tris.length; t += 3) {
      // Moller-Trumbore without inner-loop array allocations.
      const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
      const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
      const pvx = d1 * e2z - d2 * e2y, pvy = d2 * e2x - d0 * e2z, pvz = d0 * e2y - d1 * e2x;
      const det = e1x * pvx + e1y * pvy + e1z * pvz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det, tvx = o0 - a[0], tvy = o1 - a[1], tvz = o2 - a[2];
      const u = (tvx * pvx + tvy * pvy + tvz * pvz) * inv;
      if (u < 0 || u > 1) continue;
      const qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
      const v = (d0 * qvx + d1 * qvy + d2 * qvz) * inv;
      if (v < 0 || u + v > 1) continue;
      const d = (e2x * qvx + e2y * qvy + e2z * qvz) * inv;
      if (d > 0 && d < bt) { bt = d; best = { p: [o0 + d0 * d, o1 + d1 * d, o2 + d2 * d], tri: t / 3 }; }
    }
    if (best) return best;
  }
  // Nearest corner, then the nearest point of the triangles round it.
  let vi = -1, vd = Infinity;
  for (let i = 0; i < points.length; i++) { const d = Math.hypot(...sub(points[i], o)); if (d < vd) { vd = d; vi = i; } }
  if (vi < 0) return null;
  for (let t = 0; t < tris.length; t += 3) {
    if (tris[t] !== vi && tris[t + 1] !== vi && tris[t + 2] !== vi) continue;
    const q = closestOnTriangle(o, points[tris[t]], points[tris[t + 1]], points[tris[t + 2]]), d = Math.hypot(...sub(q, o));
    if (d < bt) { bt = d; best = { p: q, tri: t / 3 }; }
  }
  return best;
}

function closestOnTriangle(p: number[], a: number[], b: number[], c: number[]): number[] {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return a.map((x, k) => x + v * ab[k]); }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return a.map((x, k) => x + w * ac[k]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return b.map((x, k) => x + w * (c[k] - b[k])); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return a.map((x, k) => x + ab[k] * v + ac[k] * w);
}

/**
 * The slit a dart cuts: the plane it lies in (as a signed distance, for
 * splitAlong) and the triangles of the run to cut, those the plane crosses
 * in the apex's panel, joined to the apex along the line without crossing
 * a seam (`seamPaths`: the seams and open edges cut so far), as far as it
 * runs each way. Null where the dart misses the garment.
 */
export function dartSlit(line: DartLine, points: number[][], tris: number[], panels: number[][], seamPaths: number[][]): { f: (p: number[]) => number; tris: Set<number> } | null {
  const hit = onSurface(line.apex, points, tris);
  if (!hit) return null;
  const q = hit.p;
  const corner = (t: number, k: number) => points[tris[3 * t + k]];
  const facing = line.apex.facing ?? unit(cross(sub(corner(hit.tri, 1), corner(hit.tri, 0)), sub(corner(hit.tri, 2), corner(hit.tri, 0))));
  if (!facing) return null;
  let d = line.direction;
  if (line.to) { const to = onSurface(line.to, points, tris); if (!to) return null; d = sub(to.p, q); }
  if (!d) return null;
  // The direction as it runs on the garment there: square to the way it faces.
  const along = unit(sub(d, facing.map((v) => v * dot(d!, facing))));
  if (!along) return null;
  const m = unit(cross(along, facing))!;
  const f = (p: number[]) => dot(sub(p, q), m);
  const progress = (p: number[]) => dot(sub(p, q), along);

  const panel = panels.find((pl) => pl.includes(hit.tri));
  if (!panel) return null;
  // The triangles of the apex's panel the plane crosses, and the middle of
  // the line across each.
  const mids = new Map<number, number[]>();
  for (const t of panel) {
    const v = [0, 1, 2].map((k) => f(corner(t, k)));
    if (!(Math.min(...v) <= 0 && Math.max(...v) >= 0 && Math.max(...v) > Math.min(...v))) continue;
    const on: number[][] = [];
    for (let k = 0; k < 3; k++) {
      const a = corner(t, k), b = corner(t, (k + 1) % 3), va = v[k], vb = v[(k + 1) % 3];
      if (va === 0) on.push(a);
      else if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) { const u = va / (va - vb); on.push(a.map((x, j) => x + (b[j] - x) * u)); }
    }
    if (on.length) mids.set(t, [0, 1, 2].map((j) => on.reduce((acc, p) => acc + p[j], 0) / on.length));
  }
  if (!mids.size) return null;
  let seed = hit.tri;
  if (!mids.has(seed)) {
    let bd = Infinity;
    for (const [t, c] of mids) { const dd = Math.hypot(...sub(c, q)); if (dd < bd) { bd = dd; seed = t; } }
  }
  // Walked out from the apex along the line, each way: each crossed
  // triangle joined to one already reached across an edge (or a point on
  // the line) that no seam runs along, so the run stops at the first seam
  // or edge it meets; on the side of the apex its first step went (so a run
  // that bends round a limb keeps its side).
  const n = points.length, key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const seamEdge = new Set<number>(), seamPoint = new Set<number>();
  for (const path of seamPaths) for (let k = 0; k < path.length; k++) { seamPoint.add(path[k]); if (k) seamEdge.add(key(path[k - 1], path[k])); }
  const byPoint = new Map<number, number[]>();
  for (const t of mids.keys()) for (let k = 0; k < 3; k++) { const g = tris[3 * t + k]; (byPoint.get(g) ?? byPoint.set(g, []).get(g)!).push(t); }
  const joined = (t: number, u: number) => {
    const a = [0, 1, 2].map((k) => tris[3 * t + k]), shared = a.filter((g) => tris[3 * u] === g || tris[3 * u + 1] === g || tris[3 * u + 2] === g);
    if (shared.length === 2) return !seamEdge.has(key(shared[0], shared[1]));
    return shared.length === 1 && !seamPoint.has(shared[0]) && Math.abs(f(points[shared[0]])) < 1e-9;
  };
  const within = (t: number, branch: number) => {
    const s = progress(mids.get(t)!);
    return branch > 0 ? s <= line.length : -s <= line.back;
  };
  const branchOf = new Map<number, number>([[seed, progress(mids.get(seed)!) >= 0 ? 1 : -1]]);
  const out = new Set<number>();
  if (within(seed, branchOf.get(seed)!)) out.add(seed);
  const queue = [seed];
  while (queue.length) {
    const t = queue.shift()!;
    for (let k = 0; k < 3; k++) for (const u of byPoint.get(tris[3 * t + k]) ?? []) {
      if (branchOf.has(u) || !joined(t, u)) continue;
      const branch = t === seed ? (progress(mids.get(u)!) >= 0 ? 1 : -1) : branchOf.get(t)!;
      branchOf.set(u, branch);
      if (!within(u, branch)) continue;
      out.add(u);
      queue.push(u);
    }
  }
  return out.size ? { f, tris: out } : null;
}
