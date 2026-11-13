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

import type { BodyFormMeasurements, EdgeProfile, GarmentDraft, GarmentCurve, GarmentPlane, GarmentPlaneSeam } from '../../types/cloth';
import { draftLines } from './garmentCurves';
import { bodyFormSection, bodyLandmarks } from './bodyForm';
import { formLimbs, type LimbName } from './formLimbs';
import { garmentSettings } from './garments';
import { CLOTH_MATERIALS } from './clothMesh';
import { bodiceDarts, dartLines, dartNear, type DartLine } from './garmentDarts';
import { lapelCuts } from './garmentCollars';
import { edgeOf } from './edgeProfile';
import { CAP_NEED } from './garmentFullness';

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
  /** `shapeFront`/`shapeBack`: its drop across, as a fraction of the depth (GarmentEdge); unset, round. */
  | { kind: 'neckline'; half: number; front: number; back: number; shapeFront?: EdgeProfile; shapeBack?: EdgeProfile }
  /** Keep above z; lower at the centre back by `train`, tapering off to the sides; lower again by `profile` round the body. */
  | { kind: 'hem'; z: number; train: number; on: Part[]; profile?: EdgeProfile }
  /** Keep below z (higher by `profile` round the body). */
  | { kind: 'waist'; z: number; on: Part[]; profile?: EdgeProfile }
  /** Keep within `s` of a limb's root (a sleeve's end), or beyond it; further by `profile` round the limb. */
  | { kind: 'limbEnd'; limb: LimbName; s: number; on: Part[]; profile?: EdgeProfile }
  | { kind: 'limbStart'; limb: LimbName; s: number; on: Part[]; profile?: EdgeProfile }
  /** Round where a limb leaves the body, as deep as asked past its section. */
  | { kind: 'armhole'; limb: LimbName; extra: number }
  /** Away on the normal's side of a plane, within its mask. */
  | ({ kind: 'plane'; name?: string } & GarmentPlane);

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
  /** Along a plane, within its mask; `open`: cut and left open. */
  | ({ kind: 'plane' } & GarmentPlaneSeam)
  /** A dart: a slit from its apex along a line on the garment (garmentDarts). */
  | ({ kind: 'dart' } & DartLine)
  /** A curve drawn on the garment (GarmentCurve), sewn or left open; drawn cuts are cut with the openings. */
  | { kind: 'curve'; line: GarmentCurve };

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
/** The least a garment worn as `layer` stands off the body: what it rests at. */
export const restOff = (layer: number) => standOff(0, layer);

/** The plan for a draft on a form, worn as `layer` (0 next to the body). */
export function garmentPlan(draft: GarmentDraft, form: BodyFormMeasurements, layer = 0): GarmentPlan {
  const d = garmentSettings(draft) as Required<GarmentDraft>;
  const L = bodyLandmarks(form), s = form.height / 1.75, limbs = formLimbs(form);
  const off = standOff(d.ease, layer);
  const covers: PartCover[] = [], cuts: GarmentCut[] = [], seams: GarmentSeam[] = [];

  // ---- Round a span of one limb: a sock, a hat, a leg warmer, a band.
  if (d.over) {
    const limb = limbs[d.over];
    const from = d.from ?? 0, to = d.to ?? 1;
    covers.push({ part: d.over, off, names: 'gore' });
    cuts.push({ kind: 'limbStart', limb: d.over, s: from * limb.length, on: [d.over], profile: edgeOf(draft, 'top')?.profile });
    if (!d.cap) cuts.push({ kind: 'limbEnd', limb: d.over, s: to * limb.length, on: [d.over], profile: edgeOf(draft, 'end')?.profile });
    seams.push({ kind: 'roundLimb', limb: d.over, n: Math.max(2, Math.round(d.gores ?? 2)) });
    if (d.opening) seams.push({ kind: 'frontOpening', on: [d.over] });
    const joint = limb.path.jointAt + 0.006 * s;
    if (limb.path.bend > RING_BEND && from * limb.length < joint && (d.cap || to * limb.length > joint)) seams.push({ kind: 'limbRing', name: 'joint', limb: d.over, s: joint });
    addDraftPlanes(draft, cuts, seams);
    for (const line of draftDarts(draft, form)) seams.push({ kind: 'dart', ...line });
    addDrawnLines(draft, seams);
    return { covers, cuts, seams };
  }

  // ---- On the body: from the neck (a bodice), or from a band (at the waist
  // or at a height): down to a hem.
  const fromWaist = d.top !== 'neck';
  const waistTop = (typeof d.top === 'number' ? d.top : L.waistZ) - (d.legs ? 0.02 * s : 0);
  const topZ = fromWaist ? waistTop : L.hpsZ;
  const topOff = standOff(d.waistEase ?? 0.02, layer);
  const hem = d.legs
    ? Math.max(0.06 * form.height, waistTop - d.length)
    : fromWaist
      ? Math.max(0.06 * form.height, waistTop - Math.max(0.03, d.length))
      : L.waistZ - Math.max(0.02, d.length);
  const sleeved = !fromWaist && d.sleeve > 0.03;
  // A batwing: sleeve and bodice cut in one, very full under the arm.
  const batwing = sleeved && d.armhole > 0.05;
  // Not following the legs and reaching past the seat: hangs from the hips.
  const hangsFromHips = !d.legs && hem < L.crotchZ + 0.05;
  const hipR = form.hip / (2 * Math.PI);
  // Flared from the hips down to a hem below them (above them, nothing to flare).
  const flare = !d.legs && d.flare !== 1 && hem < L.hipZ - 0.02 * s ? { z0: L.hipZ, z1: hem, add: hipR * (d.flare - 1) } : undefined;
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
    const sleeveOff = standOff(Math.max(0.03, d.ease * 0.5), layer);
    for (const arm of ['armL', 'armR'] as const) {
      const limb = limbs[arm];
      const sleeveLen = Math.min(limb.path.length, Math.max(0.05, d.sleeve));
      const wrist = limb.section(sleeveLen);
      const cuffOff = d.cuff > 0 ? Math.max(0.004, d.cuff / (2 * Math.PI) - (wrist.w + wrist.h) / 2) : sleeveOff * 0.85;
      covers.push({ part: arm, off: sleeveOff, taper: { len: sleeveLen, end: cuffOff }, names: batwing ? 'frontBack' : 'sleeve' });
      cuts.push({ kind: 'limbEnd', limb: arm, s: sleeveLen, on: [arm], profile: edgeOf(draft, 'cuff')?.profile });
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
  if (fromWaist) cuts.push({ kind: 'waist', z: waistTop, on: bodyParts, profile: edgeOf(draft, 'top')?.profile });
  else {
    const nf = edgeOf(draft, 'neckline', 'front'), nb = edgeOf(draft, 'neckline', 'back');
    const neck = {
      kind: 'neckline' as const, half: L.neckRadius + topOff + 0.01 * s + Math.max(0, nf?.width ?? nb?.width ?? 0), front: Math.max(0.03, d.neckline) * s, back: 0.025 * s,
      ...(nf ? { shapeFront: nf.profile } : {}), ...(nb ? { shapeBack: nb.profile } : {}),
    };
    cuts.push(neck);
    // Lapels: the fronts cut along their roll lines, to be turned back there (garmentCollars).
    if (d.lapels && d.opening) cuts.push(...lapelCuts(d.lapels, L, neck));
    if (!sleeved) for (const arm of ['armL', 'armR'] as const) cuts.push({ kind: 'armhole', limb: arm, extra: 0.01 * s + d.armhole * s });
  }
  cuts.push({ kind: 'hem', z: hem, train: d.legs ? 0 : d.train, on: [...bodyParts, 'webL', 'webR'], profile: edgeOf(draft, 'hem')?.profile });


  // ---- Seams: front from back, everywhere but on a set-in sleeve.
  seams.push(...armholes);
  if (d.legs) seams.push({ kind: 'centre' });
  seams.push({ kind: 'frontBack', on: sleeved && !batwing ? bodyParts : [...bodyParts, 'armL', 'armR', 'webL', 'webR'] });
  if (d.opening) seams.push({ kind: 'frontOpening', on: bodyParts });
  seams.push(...underarms);
  // Gores: a skirt cut in `gores` panels round, by vertical planes through the
  // hip's centre, the side seams already two of them; on a dress, from a
  // seam at the waist (a gore ending in the middle of a panel cannot lie flat).
  if (d.gores && d.gores > 2) {
    if (topZ > L.waistZ + 0.02 * s) seams.push({ kind: 'plane', name: 'waistSeam', point: [0, 0, L.waistZ], normal: [0, 0, 1], on: bodyParts as GarmentPlane['on'] });
    const c = [0, bodyFormSection(form, L.hipZ).centreY, 0];
    for (let k = 0; k < d.gores; k++) {
      const ang = (2 * Math.PI * k) / d.gores, dir = [Math.sin(ang), -Math.cos(ang), 0];
      if (Math.abs(dir[0]) > 0.98) continue; // on a side seam
      // The plane holds `dir` and z; seams the half on dir's side, the front or the back.
      seams.push({ kind: 'plane', name: `gore${k + 1}`, point: c, normal: [dir[1], -dir[0], 0], front: dir[1] < 0, x: dir[0] >= 0 ? [-0.005, 1] : [-1, 0.005], z: [-1, L.waistZ], on: bodyParts as GarmentPlane['on'] });
    }
  }
  // Darts over a bust it covers (unless the draft's own seams shape it: `darts: false`), unless the fabric gives enough to go over it as it
  // is (a knit), and always when fitted under it (garmentDarts.bodiceDarts);
  // not where one of the draft's own darts already shapes.
  const own = draftDarts(draft, form);
  if (d.darts !== false && topZ > L.bustZ && L.bustProminence > 0.01 && (d.fitted || CLOTH_MATERIALS[d.material].give < BUST_STRETCH)) {
    const zBust = L.bustZ - 0.02 * s;
    const zUnder = limbs.armL.path.at(0)[2] - d.armhole * s - standOff(Math.max(0.03, d.ease * 0.5), layer) - 0.025 * s;
    // Sloped down to under a batwing's arm, it runs on onto the web, short of the shoulder.
    const slope = batwing ? Math.min(0, (zUnder - zBust) / (0.045 * s)) : 0;
    const fit = dartLines(bodiceDarts(form, d.fitted, slope, (p, front) => seamedNear(draft, p, front, 0.02 * s)), form);
    for (const line of fit) if (!dartNear(own, line.apex.point, 0.04 * s)) seams.push({ kind: 'dart', ...line });
  }
  // A set-in sleeve's cap goes round the dome of the shoulder: eased in as
  // far as the fabric eases (garmentFullness.capEase), a dart down the top of
  // the arm for what it cannot (leather, velvet, a crisp silk; a knit gives).
  // Measured on a leather jacket's upper sleeve: 6.2% to lie flat without,
  // 3.5% with; a woven dress's short sleeve with one, 2.8%.
  const mat = CLOTH_MATERIALS[d.material];
  if (d.darts !== false && sleeved && !batwing && mat.give < CAP_NEED && mat.easeIn < CAP_NEED) {
    for (const line of dartLines([{ name: 'cap', apex: { limb: 'armL', along: 0.12, face: [0, 0, 1] }, direction: [-1, 0, 1], mirror: true }], form)) {
      if (!dartNear(own, line.apex.point, 0.04 * s)) seams.push({ kind: 'dart', ...line });
    }
  }
  addDraftPlanes(draft, cuts, seams);
  // The draft's own darts last: one may run from any seam to its apex.
  for (const line of own) seams.push({ kind: 'dart', ...line });
  addDrawnLines(draft, seams);
  return { covers, cuts, seams };
}

/** The lines drawn on the garment that are sewn or left open, after everything else. */
function addDrawnLines(draft: GarmentDraft, seams: GarmentSeam[]) {
  for (const line of draftLines(draft.curves)) if (line.kind !== 'cut') seams.push({ kind: 'curve', line });
}

/** The draft's own darts, placed on the form. */
const draftDarts = (draft: GarmentDraft, form: BodyFormMeasurements) => (Array.isArray(draft.darts) ? dartLines(draft.darts, form) : []);

/** Whether one of the draft's own seams (or its mirror) passes within `r` of `p`, on that face. */
function seamedNear(draft: GarmentDraft, p: number[], front: boolean, r: number): boolean {
  return (draft.seams ?? []).flatMap((sm) => (sm.mirror ? [sm, mirrored(sm)] : [sm])).some((sm) => {
    if (sm.front !== undefined && sm.front !== front) return false;
    if (sm.z && (p[2] < sm.z[0] || p[2] > sm.z[1])) return false;
    const n = sm.normal, l = Math.hypot(n[0], n[1], n[2]) || 1;
    return Math.abs(((p[0] - sm.point[0]) * n[0] + (p[1] - sm.point[1]) * n[1] + (p[2] - sm.point[2]) * n[2]) / l) < r;
  });
}

/** A plane's mirror across the body's centre. */
function mirrored<T extends GarmentPlane>(pl: T): T {
  return { ...pl, point: [-pl.point[0], pl.point[1], pl.point[2]], normal: [-pl.normal[0], pl.normal[1], pl.normal[2]], ...(pl.x ? { x: [-pl.x[1], -pl.x[0]] as [number, number] } : {}) };
}

/** The draft's own cuts and seams, after the kind's, each with its mirror image if asked (a pair named L and R). */
function addDraftPlanes(draft: GarmentDraft, cuts: GarmentCut[], seams: GarmentSeam[]) {
  for (const c of draft.cuts ?? []) {
    cuts.push({ kind: 'plane', ...c });
    if (c.mirror) cuts.push({ kind: 'plane', ...mirrored(c) });
  }
  for (const sm of draft.seams ?? []) {
    const side = (pl: GarmentPlane) => (pl.point[0] > 0 ? 'L' : 'R');
    if (!sm.mirror) { seams.push({ kind: 'plane', ...sm }); continue; }
    seams.push({ kind: 'plane', ...sm, name: `${sm.name}${side(sm)}` });
    const m = mirrored(sm);
    seams.push({ kind: 'plane', ...m, name: `${sm.name}${side(m)}` });
  }
}
