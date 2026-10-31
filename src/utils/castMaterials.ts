// ---------------------------------------------------------------------------
// What a casting is poured in: one list, data only
// ---------------------------------------------------------------------------
//
// The rigid mold, the silicone pour box and the metal pattern each used to
// keep their own list, and the liner check branched on material names. Every
// fact a dialog or a check needs is a field here instead, so a new material
// is one entry and no code.
//
// Figures are the usual hobby ones, rounded: a brand's data sheet beats them,
// and the dialogs say "about".

/** Every material a mold or pattern in Mesh can be poured in. */
export type CastMaterialId =
  | 'epoxy'
  | 'polyurethane'
  | 'platinum'
  | 'tin'
  | 'wax'
  | 'chocolate'
  | 'water'
  | 'plaster'
  | 'concrete'
  | 'jesmonite'
  | 'aluminium'
  | 'brass'
  | 'bronze'
  | 'silver';

/** How it is mixed, by weight: two parts A:B, or a powder into water. */
export type CastMix =
  | { kind: 'ab'; a: number; b: number }
  | { kind: 'powder'; powder: number; water: number };

/**
 * A note that applies when its conditions hold. `{ml}` in the text is
 * replaced by the pour's volume.
 */
export interface CastMaterialWarning {
  text: string;
  /** Only when the pour is bigger than this, ml. */
  aboveMl?: number;
  /** Only in a printed PLA mold. */
  inPla?: boolean;
}

export interface CastMaterial {
  id: CastMaterialId;
  label: string;
  /** Of the cured or frozen piece, g/cm³. */
  densityGcm3: number;
  /** Linear contraction a pattern is grown by, %. Given where it is designed for (metals). */
  shrinkPercent?: number;
  /** Rough pouring temperature, °C. Left out for what pours at room temperature. */
  pourC?: number;
  mix?: CastMix;
  /** It cures in water, so it dissolves a PVA liner. */
  waterBased: boolean;
  /** Poured into a sand or investment mold, from a printed pattern. */
  metal: boolean;
  /** It can make a silicone mold itself, and it sticks to one. */
  silicone: boolean;
  /**
   * What the piece looks like when it is simulated, rgba 0..1: a clear resin
   * or ice is drawn see-through. Drawing only; alpha takes nothing from the physics.
   */
  rgba: [number, number, number, number];
  warnings: CastMaterialWarning[];
}

/** PLA starts to soften about here, °C: the hottest pour a printed mold takes. */
export const PLA_SOFTEN_C = 60;

export const CAST_MATERIALS: CastMaterial[] = [
  {
    id: 'epoxy', label: 'Epoxy resin', densityGcm3: 1.15, waterBased: false, metal: false, silicone: false, rgba: [0.93, 0.94, 0.88, 0.6],
    warnings: [{
      aboveMl: 200,
      inPla: true,
      text: "A {ml} ml epoxy pour can heat past PLA's ~60 °C softening point as it cures; pour it in layers or use a slow-curing casting epoxy.",
    }],
  },
  { id: 'polyurethane', label: 'Polyurethane resin', densityGcm3: 1.05, waterBased: false, metal: false, silicone: false, rgba: [0.93, 0.9, 0.82, 1], warnings: [] },
  {
    id: 'platinum', label: 'Platinum-cure silicone', densityGcm3: 1.08, mix: { kind: 'ab', a: 1, b: 1 },
    waterBased: false, metal: false, silicone: true, rgba: [0.9, 0.94, 0.92, 0.6], warnings: [],
  },
  {
    id: 'tin', label: 'Tin-cure silicone', densityGcm3: 1.15, mix: { kind: 'ab', a: 10, b: 1 },
    waterBased: false, metal: false, silicone: true, rgba: [0.95, 0.76, 0.78, 1], warnings: [],
  },
  { id: 'wax', label: 'Wax', densityGcm3: 0.9, pourC: 70, waterBased: false, metal: false, silicone: false, rgba: [0.98, 0.94, 0.82, 0.9], warnings: [] },
  {
    id: 'chocolate', label: 'Chocolate', densityGcm3: 1.3, pourC: 31, waterBased: false, metal: false, silicone: false, rgba: [0.36, 0.2, 0.1, 1],
    warnings: [{ text: 'Food goes in a food-grade silicone mold, or a print in a food-safe filament: layer lines hold bacteria.' }],
  },
  {
    id: 'water', label: 'Water (ice)', densityGcm3: 0.92, waterBased: true, metal: false, silicone: false, rgba: [0.86, 0.93, 0.98, 0.6],
    warnings: [{ text: 'Water grows about 9% as it freezes: fill a little below the rim.' }],
  },
  { id: 'plaster', label: 'Plaster', densityGcm3: 1.2, mix: { kind: 'powder', powder: 100, water: 70 }, waterBased: true, metal: false, silicone: false, rgba: [0.97, 0.97, 0.95, 1], warnings: [] },
  { id: 'concrete', label: 'Concrete', densityGcm3: 2.4, waterBased: true, metal: false, silicone: false, rgba: [0.62, 0.62, 0.6, 1], warnings: [] },
  { id: 'jesmonite', label: 'Jesmonite', densityGcm3: 1.9, mix: { kind: 'powder', powder: 2.5, water: 1 }, waterBased: true, metal: false, silicone: false, rgba: [0.92, 0.9, 0.86, 1], warnings: [] },
  { id: 'aluminium', label: 'Aluminium', densityGcm3: 2.7, shrinkPercent: 1.3, pourC: 720, waterBased: false, metal: true, silicone: false, rgba: [0.78, 0.8, 0.83, 1], warnings: [] },
  { id: 'brass', label: 'Brass', densityGcm3: 8.5, shrinkPercent: 1.5, pourC: 1000, waterBased: false, metal: true, silicone: false, rgba: [0.8, 0.66, 0.3, 1], warnings: [] },
  { id: 'bronze', label: 'Bronze', densityGcm3: 8.8, shrinkPercent: 1.5, pourC: 1150, waterBased: false, metal: true, silicone: false, rgba: [0.72, 0.48, 0.25, 1], warnings: [] },
  { id: 'silver', label: 'Silver', densityGcm3: 10.5, shrinkPercent: 1.6, pourC: 1000, waterBased: false, metal: true, silicone: false, rgba: [0.86, 0.87, 0.89, 1], warnings: [] },
];

/** Names an older version accepted, and what they mean now. */
const ALIASES: Record<string, CastMaterialId> = { silicone: 'platinum' };

const BY_ID = new Map(CAST_MATERIALS.map((m) => [m.id, m]));

/** The id a name stands for, aliases included, or null. */
export function resolveCastMaterial(value: unknown): CastMaterialId | null {
  if (typeof value !== 'string') return null;
  const id = ALIASES[value] ?? value;
  return BY_ID.has(id as CastMaterialId) ? (id as CastMaterialId) : null;
}

export function isCastMaterialId(value: unknown): value is CastMaterialId {
  return typeof value === 'string' && BY_ID.has(value as CastMaterialId);
}

export function castMaterial(id: CastMaterialId): CastMaterial {
  return BY_ID.get(id)!;
}

/** A metal, whose shrink and pour temperature are always given. */
export type CastMetal = CastMaterial & { shrinkPercent: number; pourC: number };

export const CAST_METALS: CastMetal[] = CAST_MATERIALS.filter((m): m is CastMetal => m.metal);

/** The metal with this id, or the first one. */
export function castMetal(id: string): CastMetal {
  return CAST_METALS.find((m) => m.id === id) ?? CAST_METALS[0];
}

/** The silicones a mold can be poured in. */
export type SiliconeId = Extract<CastMaterialId, 'platinum' | 'tin'>;

export const SILICONES: CastMaterial[] = CAST_MATERIALS.filter((m) => m.silicone);

export function isSiliconeId(value: unknown): value is SiliconeId {
  return isCastMaterialId(value) && castMaterial(value).silicone;
}

/** What a piece of this volume weighs, grams. */
export function castWeightG(id: CastMaterialId, volumeMm3: number): number {
  return (volumeMm3 / 1000) * castMaterial(id).densityGcm3;
}

/** The weighed-out parts of a mix for this many grams of it, or null when it is not mixed. */
export function mixGrams(id: CastMaterialId, grams: number): { a: number; b: number; aLabel: string; bLabel: string } | null {
  const mix = castMaterial(id).mix;
  if (!mix) return null;
  const [a, b] = mix.kind === 'ab' ? [mix.a, mix.b] : [mix.powder, mix.water];
  return {
    a: (grams * a) / (a + b),
    b: (grams * b) / (a + b),
    aLabel: mix.kind === 'ab' ? 'A' : 'powder',
    bLabel: mix.kind === 'ab' ? 'B' : 'water',
  };
}

/** The notes that apply to this pour, in this kind of mold. */
export function castMaterialWarnings(id: CastMaterialId, volumeMl: number, mold: { pla: boolean }): string[] {
  const m = castMaterial(id);
  const out: string[] = [];
  if (mold.pla && m.pourC !== undefined && m.pourC > PLA_SOFTEN_C) {
    out.push(`${m.label} poured hotter than about ${PLA_SOFTEN_C} °C softens a PLA mold; pour it as cool as it will run.`);
  }
  for (const w of m.warnings) {
    if (w.inPla && !mold.pla) continue;
    if (w.aboveMl !== undefined && !(volumeMl > w.aboveMl)) continue;
    out.push(w.text.replace('{ml}', String(Math.round(volumeMl))));
  }
  return out;
}
