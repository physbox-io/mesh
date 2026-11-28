/**
 * A garment's draft turned into another kind, keeping all of it that still
 * applies. A kind is only a preset of the draft (GARMENT_DEFAULTS): changing a
 * dress to a gown to try the look used to throw away the fabric, the colour,
 * the drawn curves, the sculpt, the trims and the collar. Now only what the new
 * kind decides for itself (where it starts and what it covers) is taken from
 * it, and what has nothing to apply to on it (a neckline on a skirt, a hem on a
 * sock) is left out and said.
 */

import type { GarmentDraft, GarmentEdge, GarmentKind } from '../../types/cloth';
import { garmentSettings } from './garments';

/**
 * What makes a kind that kind: where it starts and what it covers. Carried
 * only where the old kind and the new agree on it (a strapless dress made a
 * gown stays strapless); otherwise the new kind's own (a dress made a skirt
 * starts at the waist).
 */
const KIND_FIELDS = ['top', 'legs', 'over', 'from', 'to', 'cap', 'gores'] as const satisfies readonly (keyof GarmentDraft)[];

type Shape = { fromNeck: boolean; fromBand: boolean; body: boolean; tube: boolean };

/** The fields that need a part of the garment only some kinds have, and which. */
const NEEDS: Partial<Record<keyof GarmentDraft, (k: Shape) => boolean>> = {
  neckline: (k) => k.fromNeck, sleeve: (k) => k.fromNeck, sleeveL: (k) => k.fromNeck, sleeveR: (k) => k.fromNeck,
  cuff: (k) => k.fromNeck, armhole: (k) => k.fromNeck, collar: (k) => k.fromNeck, lapels: (k) => k.fromNeck, opening: (k) => k.fromNeck,
  waistEase: (k) => k.fromBand,
  length: (k) => k.body, flare: (k) => k.body, train: (k) => k.body, fitted: (k) => k.body,
  pockets: (k) => k.body, belt: (k) => k.body, beltLoops: (k) => k.body,
};

/** Which shapes of garment each edge is on. */
const EDGE_NEEDS: Record<GarmentEdge['along'], (k: Shape) => boolean> = {
  neckline: (k) => k.fromNeck, cuff: (k) => k.fromNeck, hem: (k) => k.body, top: (k) => !k.fromNeck, end: (k) => k.tube,
};

export interface KindChange {
  draft: GarmentDraft;
  /** What was left out, each with why, in words. */
  dropped: string[];
}

/** `draft` as a garment of `kind`: everything it set that still applies kept, the form it is fitted to kept. */
export function changeGarmentKind(draft: GarmentDraft, kind: GarmentKind): KindChange {
  if (kind === draft.garment) return { draft, dropped: [] };
  const was = garmentSettings({ garment: draft.garment }), own = garmentSettings({ garment: kind });
  const out: Record<string, unknown> = { garment: kind };
  const dropped: string[] = [];
  for (const k of KIND_FIELDS) {
    const value = draft[k];
    if (value == null) continue;
    if (JSON.stringify(was[k]) === JSON.stringify(own[k])) out[k] = value;
    // Said only when it was an edit: the old kind's own value is not one.
    else if (JSON.stringify(value) !== JSON.stringify(own[k]) && JSON.stringify(value) !== JSON.stringify(was[k])) dropped.push(`${k} ${JSON.stringify(value)} (a ${kind}'s own is ${JSON.stringify(own[k] ?? 'none')})`);
  }
  // Its shape as it will be, what it starts from carried or not.
  const s = garmentSettings(out as unknown as GarmentDraft);
  const shape: Shape = { tube: !!s.over, body: !s.over, fromNeck: !s.over && s.top === 'neck', fromBand: !s.over && s.top !== 'neck' };
  const none = `a ${kind} like this has none`;
  for (const [key, value] of Object.entries(draft) as [keyof GarmentDraft, unknown][]) {
    if (key === 'garment' || value == null || (KIND_FIELDS as readonly string[]).includes(key)) continue;
    const need = NEEDS[key];
    if (need && !need(shape)) { dropped.push(`${key} (${none})`); continue; }
    if (key === 'edges') {
      const edges = (value as GarmentEdge[]).filter((e) => {
        const ok = EDGE_NEEDS[e.along]?.(shape) ?? true;
        if (!ok) dropped.push(`the ${e.along}'s shape (${none})`);
        return ok;
      });
      if (edges.length) out.edges = edges;
      continue;
    }
    out[key] = value;
  }
  return { draft: out as unknown as GarmentDraft, dropped };
}
