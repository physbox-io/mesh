// ---------------------------------------------------------------------------
// What a dissolvable-liner mold is printed in: a rigid shell and a soluble
// liner, and what dissolves the liner
// ---------------------------------------------------------------------------
//
// The liner mold was PLA and PVA, full stop: the 3MF said so, the dissolve
// estimate said "warm water, 8 h", and a water-based cast was refused because
// it would dissolve the PVA. A printer loaded with ABS and HIPS dissolves its
// liner in d-limonene instead, which plaster and concrete do not touch, and
// PETG's shell takes a hotter pour than PLA's, and PVB goes in IPA. So the
// pair is chosen, and every figure follows from it.

export type LinerPairId = 'pla_pva' | 'pla_bvoh' | 'petg_pva' | 'abs_hips' | 'pla_pvb';

export interface LinerFilament {
  /** As a slicer names it: 'PLA', 'PVA'. */
  name: string;
  /** g/cm³, as the filament makers give it. */
  densityGcm3: number;
  /** Where a print starts to soften, °C: the hottest pour it takes. */
  softenC: number;
}

export interface LinerPair {
  id: LinerPairId;
  label: string;
  shell: LinerFilament;
  liner: LinerFilament;
  /** What dissolves the liner, as said in the steps: "warm (30–40 °C) water". */
  solvent: string;
  /** Whether that is water, so a water-based cast would dissolve the liner while it cures. */
  waterSoluble: boolean;
  /**
   * Solid liner dissolved, mm an hour, stirred. Rough: makers quote whole
   * prints ("a few hours", "overnight") rather than a rate, so the estimate
   * says it is one and promises nothing.
   */
  dissolveMmPerHour: number;
}

export const LINER_PAIRS: LinerPair[] = [
  {
    id: 'pla_pva', label: 'PLA + PVA',
    shell: { name: 'PLA', densityGcm3: 1.24, softenC: 60 },
    liner: { name: 'PVA', densityGcm3: 1.23, softenC: 60 },
    solvent: 'warm (30–40 °C) water', waterSoluble: true, dissolveMmPerHour: 1,
  },
  {
    // BVOH dissolves several times faster than PVA and takes less moisture
    // from the air while it waits on the spool.
    id: 'pla_bvoh', label: 'PLA + BVOH',
    shell: { name: 'PLA', densityGcm3: 1.24, softenC: 60 },
    liner: { name: 'BVOH', densityGcm3: 1.14, softenC: 60 },
    solvent: 'warm (30–40 °C) water', waterSoluble: true, dissolveMmPerHour: 3,
  },
  {
    // PETG's shell takes a pour around 75 °C; the PVA liner, a bead away from
    // the cast, is what limits it.
    id: 'petg_pva', label: 'PETG + PVA',
    shell: { name: 'PETG', densityGcm3: 1.27, softenC: 75 },
    liner: { name: 'PVA', densityGcm3: 1.23, softenC: 60 },
    solvent: 'warm (30–40 °C) water', waterSoluble: true, dissolveMmPerHour: 1,
  },
  {
    // HIPS dissolves in d-limonene and not in water, so plaster, concrete
    // and Jesmonite can go in; ABS stands up to the limonene.
    id: 'abs_hips', label: 'ABS + HIPS',
    shell: { name: 'ABS', densityGcm3: 1.04, softenC: 95 },
    liner: { name: 'HIPS', densityGcm3: 1.04, softenC: 95 },
    solvent: 'd-limonene', waterSoluble: false, dissolveMmPerHour: 0.5,
  },
  {
    // PVB (PolySmooth and the like) dissolves in isopropyl alcohol, which PLA
    // shrugs off and plaster or concrete do not mind either. Work it in a
    // ventilated place, away from flame.
    id: 'pla_pvb', label: 'PLA + PVB',
    shell: { name: 'PLA', densityGcm3: 1.24, softenC: 60 },
    liner: { name: 'PVB', densityGcm3: 1.08, softenC: 65 },
    solvent: 'isopropyl alcohol (IPA, 99%), ventilated and away from flame', waterSoluble: false, dissolveMmPerHour: 0.5,
  },
];

export const DEFAULT_LINER_PAIR: LinerPairId = 'pla_pva';

export function linerPair(id: LinerPairId | undefined): LinerPair {
  return LINER_PAIRS.find((p) => p.id === id) ?? LINER_PAIRS[0];
}

/** An agent's spelling ('ABS+HIPS', 'abs_hips', 'petg-pva') as an id, or null. */
export function resolveLinerPair(value: unknown): LinerPairId | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase().replace(/\s*[+/-]\s*|\s+/g, '_');
  return LINER_PAIRS.some((p) => p.id === id) ? (id as LinerPairId) : null;
}

/** The hottest pour the mold takes: the cast touches the liner, the shell is a bead behind. */
export function pairSoftenC(pair: LinerPair): number {
  return Math.min(pair.shell.softenC, pair.liner.softenC);
}
