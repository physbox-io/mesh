/**
 * What a garment is unless it says otherwise: ease round the body, length,
 * flare, sleeves, fit, fabric and colour. A garment is modelled in 3D from these
 * and its body form (garmentShell.ts), then cut into flat pieces
 * (garmentFlatten.ts).
 */

import type { BodyFormMeasurements, GarmentDraft, GarmentKind } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { pieceNamePicks } from './clothNames';

type OptionalGarmentFields = 'collar' | 'lapels' | 'top' | 'legs' | 'over' | 'from' | 'to' | 'cap' | 'gores' | 'opening' | 'trims' | 'waistEase' | 'elastics' | 'pockets' | 'beltLoops' | 'belt' | 'pattern' | 'cuts' | 'seams' | 'rods' | 'darts' | 'fullness' | 'edges' | 'sculpt' | 'curves' | 'attached' | 'pressed' | 'sleeveL' | 'sleeveR' | 'pieceFabrics';

/** Settings every garment has; what it covers (`top`, `legs`, or a tube's `over`, `from`, `to`, `cap`) says which kind it is. */
export type GarmentSettings = Required<Omit<GarmentDraft, 'garment' | 'fitTo' | 'form' | OptionalGarmentFields>> & Pick<GarmentDraft, OptionalGarmentFields>;

export const GARMENT_DEFAULTS: Record<GarmentKind, GarmentSettings> = {
  tshirt: { top: 'neck', ease: 0.1, length: 0.22, flare: 1, train: 0, sleeve: 0.2, cuff: 0, armhole: 0, neckline: 0.09, fitted: false, material: 'jersey', rgba: [0.23, 0.48, 0.83, 1] },
  dress: { top: 'neck', ease: 0.06, length: 0.55, flare: 1.5, train: 0, sleeve: 0, cuff: 0, armhole: 0, neckline: 0.13, fitted: true, material: 'woven', rgba: [0.75, 0.22, 0.3, 1] },
  skirt: { top: 'waist', waistEase: 0.02, ease: 0.04, length: 0.5, flare: 1.6, train: 0, sleeve: 0, cuff: 0, armhole: 0, neckline: 0, fitted: true, material: 'woven', rgba: [0.2, 0.25, 0.35, 1] },
  // To the floor and full, with a train and batwing sleeves cut deep from
  // the waist to a narrow cuff.
  gown: { top: 'neck', ease: 0.06, length: 1.07, flare: 3, train: 0.7, sleeve: 0.5, cuff: 0.2, armhole: 0.2, neckline: 0.15, fitted: true, material: 'taffeta', rgba: [0.42, 0.18, 0.55, 1] },
  // Worn over a shirt: roomier, to the hip, long sleeves to a fitted cuff.
  // A plain woven jacket, zipped up the front; a look (leather, studs) is the draft's.
  jacket: { top: 'neck', opening: true, trims: [{ kind: 'zipper', along: 'opening', fastened: true }], ease: 0.22, length: 0.24, flare: 1, train: 0, sleeve: 0.6, cuff: 0.3, armhole: 0.02, neckline: 0.11, fitted: false, material: 'woven', rgba: [0.17, 0.21, 0.3, 1] },
  // Waistband just below the waist, to the ankle, the leg tapering a little.
  // Round any span of a limb (over, from, to; capped or open): a sleeve on
  // its own, a leg warmer, a cuff.
  tube: { ease: 0.04, length: 0, flare: 1, train: 0, sleeve: 0, cuff: 0, armhole: 0, neckline: 0, fitted: false, material: 'jersey', rgba: [0.55, 0.55, 0.6, 1], over: 'armL', from: 0.3, to: 0.7, cap: false, gores: 2 },
  // Knit, close: up the calf and over the foot, closed at the toe.
  sock: { ease: 0.01, length: 0, flare: 1, train: 0, sleeve: 0, cuff: 0, armhole: 0, neckline: 0, fitted: false, material: 'jersey', rgba: [0.85, 0.85, 0.8, 1], over: 'legL', from: 0.62, to: 1, cap: true, gores: 2 },
  // A knit hat: from the brow over the crown, in six gores.
  hat: { ease: 0.02, length: 0, flare: 1, train: 0, sleeve: 0, cuff: 0, armhole: 0, neckline: 0, fitted: false, material: 'jersey', rgba: [0.75, 0.6, 0.2, 1], over: 'head', from: 0.62, to: 1, cap: true, gores: 6 },
  // Snug at the waist (loose there, they fell off the form: nothing below holds trousers up).
  trousers: { top: 'waist', legs: true, waistEase: 0.02, ease: 0.06, length: 1.0, flare: 0.7, train: 0, sleeve: 0, cuff: 0, armhole: 0, neckline: 0, fitted: true, material: 'denim', rgba: [0.16, 0.24, 0.4, 1] },
};

/** A draft with its kind's defaults under it: every setting the builder reads, whatever the draft left out. */
export function garmentSettings(draft: GarmentDraft): GarmentSettings & GarmentDraft {
  // A null is an unset field (utils/withoutNulls), and leaves the kind's default.
  const given = Object.fromEntries(Object.entries(draft).filter(([, v]) => v != null));
  return { ...GARMENT_DEFAULTS[draft.garment], ...given } as GarmentSettings & GarmentDraft;
}

/**
 * The measurements a garment is cut to: those of the form it is fitted to,
 * found by name in `nodes`; or, on no form, its own. Undefined when the form
 * it names is not there.
 */
export function garmentForm(draft: GarmentDraft, nodes: SceneNode[]): BodyFormMeasurements | undefined {
  if (!draft.fitTo) return draft.form;
  const find = (list: SceneNode[]): SceneNode | undefined => {
    for (const n of list) {
      if ((n.name || n.id) === draft.fitTo && n.bodyForm) return n;
      const c = find(n.children ?? []);
      if (c) return c;
    }
    return undefined;
  };
  return find(nodes)?.bodyForm;
}

/** The colour a piece of a garment was given of its own (pieceFabrics, last first; an attachment's), or undefined when it takes the garment's. */
export function garmentPieceRgba(draft: GarmentDraft, piece: string): number[] | undefined {
  const fab = [...(draft.pieceFabrics ?? [])].reverse().find((f) => f.rgba && pieceNamePicks(piece, f.piece));
  return fab?.rgba ?? draft.attached?.find((a) => a.name === piece)?.rgba;
}
