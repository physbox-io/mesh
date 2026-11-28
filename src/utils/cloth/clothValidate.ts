/**
 * What a cloth spec names that is not one of the things it can be: a garment
 * kind, a fabric, a trim, a rod, a pleat, an edge, a curve, a limb. Every one
 * of these used to go straight to the builder, which read the kind's defaults
 * or the fabric's numbers off `undefined`: a garment of an unknown kind froze
 * the tab and lost the scene. Checked where a spec comes in (MCP, a loaded
 * scene: utils/incomingBodyCheck) and again by the builder (clothModel), so a
 * spec that got past one still fails in words, not in a hang.
 *
 * Only closed lists and numbers are checked here; names of lines, panels and
 * pieces depend on the garment as modelled, and are warned about after the
 * build (clothNames.ts).
 */

import type {
  ClothMaterialName, ClothSpec, FormLimbName, GarmentCurve, GarmentEdge, GarmentFullness, GarmentKind, GarmentRod, GarmentTrim,
} from '../../types/cloth';
import { CLOTH_MATERIALS } from './clothMesh';
import { GARMENT_DEFAULTS } from './garments';

/** The keys of a record that must name every member of a union, no more: the compiler keeps these lists in step with the types. */
const all = <T extends string>(r: Record<T, true>) => Object.keys(r) as T[];

export const GARMENT_KINDS = Object.keys(GARMENT_DEFAULTS) as GarmentKind[];
export const CLOTH_MATERIAL_NAMES = Object.keys(CLOTH_MATERIALS) as ClothMaterialName[];
export const TRIM_KINDS = all<GarmentTrim['kind']>({ stud: true, button: true, buttonhole: true, bead: true, zipper: true, buckle: true, stitch: true });
export const ROD_KINDS = all<NonNullable<GarmentRod['kind']>>({ spiralSteel: true, flatSteel: true, plastic: true, hoopSteel: true });
export const FULLNESS_KINDS = all<NonNullable<GarmentFullness['kind']>>({ ease: true, gather: true, knife: true, box: true, inverted: true });
export const EDGE_ALONG = all<GarmentEdge['along']>({ neckline: true, hem: true, top: true, cuff: true, end: true });
export const CURVE_KINDS = all<GarmentCurve['kind']>({ seam: true, open: true, cut: true, line: true });
export const FORM_LIMBS = all<FormLimbName>({ armL: true, armR: true, legL: true, legR: true, head: true });

type Problems = string[];

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `value` (at `where`) is one of `allowed`, or unset. */
function oneOf(out: Problems, where: string, value: unknown, allowed: readonly string[]): void {
  if (value == null) return;
  if (typeof value === 'string' && allowed.includes(value)) return;
  out.push(`${where} is ${JSON.stringify(value)}, which is not one of: ${allowed.join(', ')}.`);
}

function finite(out: Problems, where: string, value: unknown): void {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${where} is ${JSON.stringify(value)}, not a finite number (metres).`);
}

/** A list field: unset, or an array of plain objects, each checked by `each`. */
function list(out: Problems, where: string, value: unknown, each: (item: Record<string, unknown>, at: string) => void): void {
  if (value == null) return;
  if (!Array.isArray(value)) { out.push(`${where} must be a list.`); return; }
  value.forEach((item, i) => {
    if (!isObj(item)) out.push(`${where}[${i}] must be an object.`);
    else each(item, `${where}[${i}]`);
  });
}

const material = (out: Problems, where: string, v: unknown) => oneOf(out, `${where}.material`, v, CLOTH_MATERIAL_NAMES);

const DRAFT_NUMBERS = ['ease', 'waistEase', 'length', 'flare', 'train', 'sleeve', 'sleeveL', 'sleeveR', 'cuff', 'armhole', 'neckline', 'from', 'to', 'gores'] as const;

function checkDraft(out: Problems, g: Record<string, unknown>, at: string): void {
  if (g.garment == null) out.push(`${at}.garment is missing: give the kind, one of: ${GARMENT_KINDS.join(', ')}.`);
  else oneOf(out, `${at}.garment`, g.garment, GARMENT_KINDS);
  material(out, at, g.material);
  for (const k of DRAFT_NUMBERS) finite(out, `${at}.${k}`, g[k]);
  if (g.top != null && g.top !== 'neck' && g.top !== 'waist' && !(typeof g.top === 'number' && Number.isFinite(g.top))) {
    out.push(`${at}.top is ${JSON.stringify(g.top)}: use 'neck', 'waist' or a height above the floor in metres.`);
  }
  oneOf(out, `${at}.over`, g.over, FORM_LIMBS);
  list(out, `${at}.trims`, g.trims, (t, w) => { oneOf(out, `${w}.kind`, t.kind, TRIM_KINDS); if (t.kind == null) out.push(`${w}.kind is missing (one of: ${TRIM_KINDS.join(', ')}).`); oneOf(out, `${w}.lap`, t.lap, ['left', 'right']); finite(out, `${w}.spacing`, t.spacing); finite(out, `${w}.size`, t.size); });
  list(out, `${at}.rods`, g.rods, (r, w) => oneOf(out, `${w}.kind`, r.kind, ROD_KINDS));
  list(out, `${at}.fullness`, g.fullness, (f, w) => {
    oneOf(out, `${w}.kind`, f.kind, FULLNESS_KINDS);
    oneOf(out, `${w}.facing`, f.facing, ['left', 'right']);
    oneOf(out, `${w}.side`, f.side, ['below', 'above']);
    finite(out, `${w}.ratio`, f.ratio);
  });
  list(out, `${at}.edges`, g.edges, (e, w) => { oneOf(out, `${w}.along`, e.along, EDGE_ALONG); oneOf(out, `${w}.side`, e.side, ['front', 'back']); });
  list(out, `${at}.curves`, g.curves, (c, w) => oneOf(out, `${w}.kind`, c.kind, CURVE_KINDS));
  list(out, `${at}.attached`, g.attached, (a, w) => material(out, w, a.material));
  list(out, `${at}.pieceFabrics`, g.pieceFabrics, (f, w) => { material(out, w, f.material); if (typeof f.piece !== 'string' || !f.piece) out.push(`${w}.piece must name a piece (a panel, or a piece sewn on).`); });
  list(out, `${at}.pockets`, g.pockets, () => {});
  list(out, `${at}.elastics`, g.elastics, () => {});
  list(out, `${at}.sculpt`, g.sculpt, () => {});
  list(out, `${at}.cuts`, g.cuts, () => {});
  list(out, `${at}.seams`, g.seams, () => {});
  if (g.darts != null && typeof g.darts !== 'boolean') list(out, `${at}.darts`, g.darts, () => {});
  if (g.collar != null) {
    if (!isObj(g.collar)) out.push(`${at}.collar must be an object.`);
    else { material(out, `${at}.collar`, g.collar.material); for (const k of ['stand', 'standFront', 'fall', 'point', 'round']) finite(out, `${at}.collar.${k}`, g.collar[k]); }
  }
  if (g.lapels != null) {
    if (!isObj(g.lapels)) out.push(`${at}.lapels must be an object.`);
    else for (const k of ['break', 'width', 'peak', 'rollAt', 'notch']) finite(out, `${at}.lapels.${k}`, g.lapels[k]);
  }
  if (isObj(g.belt)) material(out, `${at}.belt`, g.belt.material);
}

/** Everything wrong with `cloth` that no build could get past, each in words with what would do instead; empty when there is nothing. A null is an unset field, as everywhere in a body. */
export function clothSpecProblems(cloth: unknown, at = 'cloth'): string[] {
  const out: Problems = [];
  if (!isObj(cloth)) return [`${at} must be an object.`];
  material(out, at, cloth.material);
  oneOf(out, `${at}.layout`, cloth.layout, ['worn', 'pieces']);
  finite(out, `${at}.layer`, cloth.layer);
  finite(out, `${at}.spacing`, cloth.spacing);
  if (typeof cloth.spacing === 'number' && cloth.spacing <= 0) out.push(`${at}.spacing must be more than 0 (metres).`);
  finite(out, `${at}.sewTime`, cloth.sewTime);
  list(out, `${at}.pieces`, cloth.pieces, (p, w) => {
    material(out, w, p.material);
    list(out, `${w}.trims`, p.trims, (t, tw) => oneOf(out, `${tw}.kind`, t.kind, TRIM_KINDS));
  });
  list(out, `${at}.fasten`, cloth.fasten, (f, w) => { if (isObj(f.trim)) oneOf(out, `${w}.trim.kind`, f.trim.kind, TRIM_KINDS); });
  for (const k of ['garment', 'draft'] as const) {
    const g = cloth[k];
    if (g == null) continue;
    if (!isObj(g)) out.push(`${at}.${k} must be an object.`);
    else checkDraft(out, g, `${at}.${k}`);
  }
  return out;
}

/** Throws one error naming every problem with `cloth` (of body `body`), or does nothing. */
export function assertClothSpec(cloth: ClothSpec | unknown, body: string): void {
  const problems = clothSpecProblems(cloth);
  if (problems.length) throw new Error(`Body '${body}': ${problems.join(' ')}`);
}
