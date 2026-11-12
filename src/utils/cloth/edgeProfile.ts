/**
 * Edge profiles (GarmentDraft.edges): a level that varies along a garment's
 * open edge. Read by the plan (which cut each shapes) and the shell (where
 * along the edge a point is, and the level there).
 */

import type { EdgeProfile, GarmentDraft, GarmentEdge } from '../../types/cloth';

/** The profile's value at t (0 to 1, repeated `repeat` times), straight between its points, level past its ends. */
export function profileAt(pr: EdgeProfile, t: number): number {
  const pts = [...pr.points].filter((q) => q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1])).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return 0;
  const n = Math.max(1, Math.round(pr.repeat ?? 1));
  let u = t * n;
  u -= Math.floor(u);
  if (n === 1) u = Math.min(1, Math.max(0, t));
  if (u <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    if (u <= pts[k][0]) {
      const [t0, v0] = pts[k - 1], [t1, v1] = pts[k];
      return t1 > t0 ? v0 + ((u - t0) / (t1 - t0)) * (v1 - v0) : v1;
    }
  }
  return pts[pts.length - 1][1];
}

/** The draft's profile for one edge (the last given wins), or none. */
export function edgeOf(draft: GarmentDraft, along: GarmentEdge['along'], side?: 'front' | 'back'): GarmentEdge | undefined {
  const all = (draft.edges ?? []).filter((e) => e.along === along && (along !== 'neckline' || (e.side ?? 'front') === (side ?? 'front')));
  return all[all.length - 1];
}

/** Turn round an axis, 0 to 1: 0 along `zero`, a quarter along `quarter`. */
export function turnRound(dx: number, dy: number, dz: number, zero: number[], quarter: number[]): number {
  const a = dx * zero[0] + dy * zero[1] + dz * zero[2], b = dx * quarter[0] + dy * quarter[1] + dz * quarter[2];
  const t = Math.atan2(b, a) / (2 * Math.PI);
  return t < 0 ? t + 1 : t;
}
