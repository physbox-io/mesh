/**
 * What a garment is, as data the builder (garmentShell) reads: the parts of
 * the form it covers and how far off each it stands, the cuts that open it,
 * and the seams that cut it into panels. Every primitive here is generic (a
 * plane at a height, a ring round a limb, the boundary between two parts);
 * what makes a t-shirt a t-shirt and not a skirt is only which of them its
 * draft asks for. `garmentPlan` turns a draft into one; the kinds in
 * GARMENT_DEFAULTS are presets of the draft, nothing more.
 *
 * Z-up, metres, in the form's frame; +x the wearer's left, -y the front.
 */

import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import { bodyLandmarks } from './bodyForm';
import { formLimbs, type LimbName } from './formLimbs';
import { GARMENT_DEFAULTS } from './garments';
import { CLOTH_MATERIALS } from './clothMesh';

/** A part of the form, or a web: a sheet strung between a limb's underside and the body's side, as a batwing is. */
export type Part = 'skin' | LimbName | 'webL' | 'webR';

/** A part the garment covers, and how far off it the cloth stands. */
export interface PartCover {
  part: Part;
  /** Stand-off from the part, metres. */
  off: number;
  /** Growing stand-off by height: nothing at z0, `add` at z1, and on past it (a flared skirt). */
  flare?: { z0: number; z1: number; add: number };
  /** A snug band: stand-off `off` at height z (and within radius `r` if given), easing to the cover's own over `over` metres. */
  snug?: { z: number; r?: number; off: number; over: number };
  /** Along a limb: `off` at the root easing to `end` at `len`. */
  taper?: { len: number; end: number };
  /** A web: from the limb's root `along` it, and `depth` down the body's side from the limb's root. */
  web?: { limb: LimbName; along: number; depth: number };
  /** The skin's mesh: hung straight below `hangFrom` (no shaping under the bust), carried down as the hips to `downTo` (a skirt). */
  skin?: { hangFrom?: number; downTo?: number };
  /** How its panels are named: front and back (and which side), a sleeve, or numbered gores. */
  names: 'frontBack' | 'frontBackSide' | 'sleeve' | 'gore';
}

/** Where the surface is cut open. Negative is cut away. `on`: only where the cloth is nearest one of these parts. */
export type GarmentCut =
  | { kind: 'neckline'; half: number; front: number; back: number }
  /** Keep above z; lower at the centre back by `train`, tapering off to the sides. */
  | { kind: 'hem'; z: number; train: number; on: Part[] }
  /** Keep below z. */
  | { kind: 'waist'; z: number; on: Part[] }
  /** Keep within `s` of a limb's root (a sleeve's end), or beyond it. */
  | { kind: 'limbEnd'; limb: LimbName; s: number; on: Part[] }
  | { kind: 'limbStart'; limb: LimbName; s: number; on: Part[] }
  /** Round where a limb leaves the body, as deep as asked past its section. */
  | { kind: 'armhole'; limb: LimbName; extra: number };

/** A seam: a generic line the surface is cut through, and where. */
export type GarmentSeam =
  /** The plane between front and back: side and shoulder seams, inside and outside leg. */
  | { kind: 'frontBack'; on: Part[] }
  /** The centre plane: a pair of trousers' front and back rise. */
  | { kind: 'centre' }
  /** The centre front cut open and left open (a jacket): its two edges are not sewn. */
  | { kind: 'frontOpening'; on: Part[] }
  /** Where the cloth stops being nearer `a` and is nearer `b`, within `within` of b's root (an armhole). */
  | { kind: 'partBoundary'; name: string; a: Part; b: LimbName; within: number }
  /** A line along a limb, under it; `over` the top as well (a two-piece sleeve). */
  | { kind: 'alongLimb'; name: string; limb: LimbName; over: boolean }
  /** Lines evenly round a limb, along it. */
  | { kind: 'roundLimb'; limb: LimbName; n: number }
  /** A ring round a limb, `s` along it: a tube past a bent joint cut in two there, each half straight enough to lie flat. */
  | { kind: 'limbRing'; name: string; limb: LimbName; s: number }
  /** Gores: vertical planes through the hip centre, below `belowZ`. */
  | { kind: 'gores'; n: number; belowZ: number }
  /** A dart: a horizontal plane at z, or a vertical one at side * x, within a mask. */
  | { kind: 'dart'; name: string; axis: 'x' | 'z'; at: number; side: 1 | -1; on: Part; front?: boolean; xBeyond?: number; zRange?: [number, number] };

export interface GarmentPlan {
  covers: PartCover[];
  cuts: GarmentCut[];
  seams: GarmentSeam[];
}

/** Over this much bend at a joint, a tube past it is cut round at the joint (a bent tube cannot lie flat). */
const RING_BEND = 30;

/** How much a knit gives: a bust it goes over as it is, with no dart. */
const BUST_STRETCH = 0.08;
/** A garment worn over another stands this much further off the body per layer. */
const LAYER_GAP = 0.008;

const standOff = (ease: number, layer: number) => Math.max(0, ease) / (2 * Math.PI) + 0.004 + LAYER_GAP * layer;

/** The plan for a draft on a form, worn as `layer` (0 next to the body). */
export function garmentPlan(draft: GarmentDraft, form: BodyFormMeasurements, layer = 0): GarmentPlan {
  const d = { ...GARMENT_DEFAULTS[draft.garment], ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) } as Required<GarmentDraft>;
  const L = bodyLandmarks(form), s = form.height / 1.75, limbs = formLimbs(form);
  const off = standOff(d.ease, layer);
  const covers: PartCover[] = [], cuts: GarmentCut[] = [], seams: GarmentSeam[] = [];

  // ---- Round a span of one limb: a sock, a hat, a leg warmer.
  if (d.over) {
    const limb = limbs[d.over];
    covers.push({ part: d.over, off, names: 'gore' });
    cuts.push({ kind: 'limbStart', limb: d.over, s: (d.from ?? 0) * limb.length, on: [d.over] });
    if (!d.cap) cuts.push({ kind: 'limbEnd', limb: d.over, s: (d.to ?? 1) * limb.length, on: [d.over] });
    seams.push({ kind: 'roundLimb', limb: d.over, n: Math.max(2, Math.round(d.gores ?? 2)) });
    const joint = limb.path.jointAt + 0.006 * s;
    if (limb.path.bend > RING_BEND && (d.from ?? 0) * limb.length < joint && (d.cap || (d.to ?? 1) * limb.length > joint)) seams.push({ kind: 'limbRing', name: 'joint', limb: d.over, s: joint });
    return { covers, cuts, seams };
  }

  // ---- On the body: from the neck (a bodice) or a waistband, down to a hem.
  const fromWaist = d.top === 'waist';
  const waistTop = L.waistZ - (d.legs ? 0.02 * s : 0);
  const topZ = fromWaist ? waistTop : L.hpsZ;
  const topOff = standOff(d.waistEase ?? 0.02, layer);
  const hem = d.legs ? Math.max(0.06 * form.height, waistTop - d.length) : L.waistZ - Math.max(L.waistZ - L.hipZ + 0.05, d.length);
  const sleeved = !fromWaist && d.sleeve > 0.03;
  // A batwing: sleeve and bodice cut in one, very full under the arm.
  const batwing = sleeved && d.armhole > 0.05;
  // Not following the legs and reaching past the seat: hangs from the hips.
  const hangsFromHips = !d.legs && (fromWaist || hem < L.crotchZ + 0.05);
  const hipR = form.hip / (2 * Math.PI);
  const flare = !d.legs && d.flare !== 1 ? { z0: L.hipZ, z1: hem, add: hipR * (d.flare - 1) } : undefined;
  const bodyParts: Part[] = ['skin', ...(d.legs ? (['legL', 'legR'] as Part[]) : [])];

  covers.push({
    part: 'skin', off, flare, names: 'frontBack',
    snug: { z: topZ, r: fromWaist ? undefined : L.neckRadius + topOff, off: topOff, over: 0.06 },
    skin: { hangFrom: !fromWaist && !d.fitted ? L.bustZ : undefined, downTo: hangsFromHips ? Math.min(hem, 0) - d.train - 0.1 : undefined },
  });
  if (d.legs) for (const leg of ['legL', 'legR'] as const) covers.push({ part: leg, off, names: 'frontBackSide' });
  // The armholes are cut first: the seams that end on them (side, underarm)
  // are run on across them and trimmed back to where they cross.
  const armholes: GarmentSeam[] = [], underarms: GarmentSeam[] = [];
  if (sleeved) {
    const sleeveOff = standOff(Math.max(0.12, d.ease + 0.02), layer);
    const sleeveLen = Math.max(0.05, d.sleeve);
    for (const arm of ['armL', 'armR'] as const) {
      const limb = limbs[arm];
      const wrist = limb.section(Math.min(limb.length, sleeveLen));
      const cuffOff = d.cuff > 0 ? Math.max(0.004, d.cuff / (2 * Math.PI) - (wrist.w + wrist.h) / 2) : sleeveOff * 0.8;
      covers.push({ part: arm, off: sleeveOff, taper: { len: sleeveLen, end: cuffOff }, names: batwing ? 'frontBack' : 'sleeve' });
      cuts.push({ kind: 'limbEnd', limb: arm, s: sleeveLen, on: [arm] });
      // A batwing: sleeve and body in one, the cloth strung under the upper
      // arm down the side, as deep as asked (a bulge of ease there instead
      // made a saddle between arm and body, which no flat piece can be; and
      // strung on past a bent elbow, the sheet twisted, which cannot either).
      if (batwing) covers.push({ part: `web${arm.slice(3) as 'L' | 'R'}`, off: sleeveOff, names: 'frontBack', web: { limb: arm, along: Math.min(sleeveLen, limb.path.jointAt), depth: d.armhole * s } });
      else {
        armholes.push({ kind: 'partBoundary', name: `armhole${arm.slice(3)}`, a: 'skin', b: arm, within: 0.45 });
        underarms.push({ kind: 'alongLimb', name: `underarm${arm.slice(3)}`, limb: arm, over: false });
        if (sleeveLen > limb.path.jointAt && limb.path.bend > RING_BEND) underarms.push({ kind: 'limbRing', name: `elbow${arm.slice(3)}`, limb: arm, s: limb.path.jointAt });
      }
    }
  }

  // ---- Openings.
  if (fromWaist) cuts.push({ kind: 'waist', z: waistTop, on: bodyParts });
  else {
    cuts.push({ kind: 'neckline', half: L.neckRadius + topOff + 0.01 * s, front: Math.max(0.03, d.neckline) * s, back: 0.025 * s });
    if (!sleeved) for (const arm of ['armL', 'armR'] as const) cuts.push({ kind: 'armhole', limb: arm, extra: 0.01 * s + d.armhole * s });
  }
  cuts.push({ kind: 'hem', z: hem, train: d.legs ? 0 : d.train, on: [...bodyParts, 'webL', 'webR'] });


  // ---- Seams: front from back, everywhere but on a set-in sleeve.
  seams.push(...armholes);
  seams.push({ kind: 'frontBack', on: sleeved && !batwing ? bodyParts : [...bodyParts, 'armL', 'armR', 'webL', 'webR'] });
  if (d.legs) seams.push({ kind: 'centre' });
  if (d.opening) seams.push({ kind: 'frontOpening', on: bodyParts });
  seams.push(...underarms);
  if (d.gores) seams.push({ kind: 'gores', n: d.gores, belowZ: L.hipZ - 0.02 * s });
  // Darts over a bust, unless the fabric gives enough to go over it as it
  // is (a knit), and always when fitted under it: from the side seam toward
  // the bust point, and down from under it to the hip, front and back.
  if (!fromWaist && L.bustProminence > 0.01 && (d.fitted || CLOTH_MATERIALS[d.material].give < BUST_STRETCH)) {
    const bx = L.bustPoint[0];
    for (const side of [1, -1] as const) {
      const tag = side > 0 ? 'L' : 'R';
      seams.push({ kind: 'dart', name: `dart${tag}`, axis: 'z', at: L.bustZ - 0.02 * s, side, on: 'skin', front: true, xBeyond: bx + 0.015 * s });
      if (d.fitted) for (const [nm, front] of [['waistDartFront', true], ['waistDartBack', false]] as const) {
        seams.push({ kind: 'dart', name: `${nm}${tag}`, axis: 'x', at: bx * 0.95, side, on: 'skin', front, zRange: [L.hipZ + 0.03 * s, L.bustZ - 0.04 * s] });
      }
    }
  }
  return { covers, cuts, seams };
}
