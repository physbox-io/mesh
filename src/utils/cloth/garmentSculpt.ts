import type { GarmentSculpt } from '../../types/cloth';

/**
 * A garment's sculpted stand-off (GarmentDraft.sculpt) as a field: how much
 * further off the body the cloth stands at a point, the dabs added up, each
 * falling smoothly to nothing at its radius. Asked of every cell near the
 * garment, so the dabs are bucketed by where they reach.
 */
export interface SculptField {
  at: (p: number[]) => number;
  /** The most it pushes out anywhere (0 for none): how much further the garment can reach. */
  most: number;
}

const NONE: SculptField = { at: () => 0, most: 0 };

/** The dabs that do anything. */
export function sculptDabs(list: GarmentSculpt[] | undefined): GarmentSculpt[] {
  return (list ?? []).filter((d) => d.radius > 0 && d.amount);
}

/**
 * A dab's reach at a point: 1 at its middle, falling smoothly to 0 at its
 * radius. Mirrored, the nearer of it and its mirror: one dab either side,
 * not two at the centre where they overlap.
 */
function reachOf(d: GarmentSculpt, p: number[]): number {
  const r2 = d.radius * d.radius, dy = (p[1] - d.at[1]) ** 2 + (p[2] - d.at[2]) ** 2;
  let q = ((p[0] - d.at[0]) ** 2 + dy) / r2;
  if (d.mirror !== false) q = Math.min(q, ((p[0] + d.at[0]) ** 2 + dy) / r2);
  return q < 1 ? (1 - q) * (1 - q) : 0;
}

export function sculptField(list: GarmentSculpt[] | undefined): SculptField {
  const dabs = sculptDabs(list);
  if (!dabs.length) return NONE;
  const cell = Math.max(...dabs.map((d) => d.radius));
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const buckets = new Map<string, GarmentSculpt[]>();
  for (const d of dabs) {
    const keys = new Set<string>();
    for (const x of d.mirror !== false ? [d.at[0], -d.at[0]] : [d.at[0]]) {
      const c = [x, d.at[1], d.at[2]];
      const lo = c.map((v) => Math.floor((v - d.radius) / cell)), hi = c.map((v) => Math.floor((v + d.radius) / cell));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) keys.add(key(i, j, k));
    }
    for (const kk of keys) {
      const b = buckets.get(kk);
      if (b) b.push(d); else buckets.set(kk, [d]);
    }
  }
  const at = (p: number[]) => {
    const b = buckets.get(key(Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)));
    if (!b) return 0;
    let v = 0;
    for (const d of b) v += d.amount * reachOf(d, p);
    return v;
  };
  // Overlapping dabs add: the most is bounded by every positive one at once,
  // which is far too much for a stroke; sampled at each dab's middle instead.
  let most = 0;
  for (const d of dabs) most = Math.max(most, at(d.at));
  return { at, most };
}

/** Dabs along a stroke this far apart, as a fraction of their radius. */
export const STROKE_SPACING = 0.3;

/**
 * A brush stroke as dabs: its points (form frame) each a dab of the brush,
 * scaled so a stroke raises a ridge of `strength` along it, as one dab does
 * at its middle (dabs `spacing` apart add up to about 16r / 15 / spacing of
 * one, along a line).
 */
export function strokeDabs(points: number[][], radius: number, strength: number, mirror: boolean): GarmentSculpt[] {
  if (!points.length || !(radius > 0) || !strength) return [];
  const scale = points.length === 1 ? 1 : Math.min(1, (STROKE_SPACING * 15) / 16);
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return points.map((p) => ({ at: [round(p[0]), round(p[1]), round(p[2])], radius: round(radius), amount: round(strength * scale), ...(mirror ? {} : { mirror: false }) }));
}
