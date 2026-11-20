// Shared by the garments test files: the garments every one is draped as, and helpers.

import { GARMENT_DEFAULTS } from '../src/utils/cloth/garments';
import type { BodyFormMeasurements, GarmentDraft, GarmentKind } from '../src/types/cloth';

/** Perimeter of a section given as radii at even angles round a centre. */
export const girth = (sec: { radii: number[] }) => {
  const n = sec.radii.length;
  let L = 0;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n, ra = sec.radii[i], rb = sec.radii[(i + 1) % n];
    L += Math.hypot(rb * Math.cos(b) - ra * Math.cos(a), rb * Math.sin(b) - ra * Math.sin(a));
  }
  return L;
};


export const FEMALE = { figure: 'female' as const };
export const cases: [string, GarmentKind, Partial<BodyFormMeasurements>, Partial<GarmentDraft>?][] = [
  ['t-shirt on a male form', 'tshirt', {}],
  ['t-shirt on a bigger male form, arms higher', 'tshirt', { armAngle: 40, chest: 1.1, waist: 0.95 }],
  ['t-shirt on a female form', 'tshirt', FEMALE],
  ['dress on a female form', 'dress', FEMALE],
  ['dress on a fuller female form', 'dress', { ...FEMALE, chest: 1.02, underbust: 0.84, waist: 0.82, hip: 1.08 }],
  ['dress with sleeves', 'dress', FEMALE, { sleeve: 0.2 }],
  ['knit dress', 'dress', FEMALE, { material: 'jersey' }],
  ['woven shirt on a female form, darted', 'tshirt', FEMALE, { material: 'woven' }],
  ['skirt', 'skirt', FEMALE],
  // The same machinery for everything else: trousers, a jacket, a gown with
  // a train and batwing sleeves, and tubes round any span of a limb.
  ['jeans on a male form', 'trousers', {}],
  ['leather jacket on a male form', 'jacket', {}],
  ['ballgown with a train and batwing sleeves', 'gown', FEMALE],
  ['sock', 'sock', {}],
  ['knit hat', 'hat', FEMALE],
  ['leg warmer, open at both ends', 'tube', {}, { over: 'legR', from: 0.55, to: 0.8, cap: false }],
];

/**
 * The panels each is cut in: bodices front and back, with their set-in
 * sleeves (a batwing's are cut in one with the body; a sleeve past the
 * elbow is cut round there, upper and lower); the rest as named.
 */
export const expectedPanels = (garment: GarmentKind, options: Partial<GarmentDraft>): string[] | null => {
  const d = { ...GARMENT_DEFAULTS[garment], ...options };
  if (d.legs) return ['backL', 'backR', 'frontL', 'frontR'];
  if (garment === 'hat') return ['gore1', 'gore2', 'gore3', 'gore4', 'gore5', 'gore6'];
  if (garment === 'sock') return ['gore1', 'gore2', 'gore3', 'gore4'];
  if (d.over) return null;
  const fronts = d.opening ? ['frontL', 'frontR'] : ['front'];
  if (d.top === 'waist' || d.sleeve <= 0.03 || d.armhole > 0.05) return ['back', ...fronts];
  return d.sleeve > 0.35 ? ['back', ...fronts, 'sleeveLLower', 'sleeveLUpper', 'sleeveRLower', 'sleeveRUpper'] : ['back', ...fronts, 'sleeveL', 'sleeveR'];
};
