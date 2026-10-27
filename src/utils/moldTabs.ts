// ---------------------------------------------------------------------------
// The Mold dialog's four tabs, and what each one starts on
// ---------------------------------------------------------------------------
//
// The method is the tab: Rigid and Silicone make a mold to pour into, Sand and
// Lost PLA a pattern for metal. Each tab offers only the materials it can take,
// so a wrong pick is not possible and needs no refusal. The defaults live here,
// pure, so a test can check that a job needs no more decisions than it should.

import { CAST_MATERIALS, castMaterial, type CastMaterial, type CastMaterialId } from './castMaterials';

export type MoldTab = 'rigid' | 'silicone' | 'sand' | 'lost-pla';

export const MOLD_TABS: { id: MoldTab; label: string }[] = [
  { id: 'rigid', label: 'Rigid' },
  { id: 'silicone', label: 'Silicone' },
  { id: 'sand', label: 'Sand' },
  { id: 'lost-pla', label: 'Lost PLA' },
];

export function isMoldTab(value: unknown): value is MoldTab {
  return MOLD_TABS.some((t) => t.id === value);
}

/**
 * What each tab can be cast in: metal goes in a pattern's sand or investment,
 * everything else in a mold, and silicone sticks to a silicone mold.
 */
const TAB_TAKES: Record<MoldTab, { metal: boolean; silicone: boolean }> = {
  rigid: { metal: false, silicone: true },
  silicone: { metal: false, silicone: false },
  sand: { metal: true, silicone: false },
  'lost-pla': { metal: true, silicone: false },
};

/** Metal patterns, rather than a mold poured into. */
export const isPatternTab = (tab: MoldTab) => TAB_TAKES[tab].metal;

/** What each tab casts in until someone picks otherwise. */
export const DEFAULT_TAB_MATERIAL: Record<MoldTab, CastMaterialId> = {
  rigid: 'epoxy',
  silicone: 'epoxy',
  sand: 'aluminium',
  'lost-pla': 'aluminium',
};

/**
 * Draft each tab starts with, degrees. Sand needs it to draw the pattern; a
 * rigid mold trades detail for it, so it starts at none; silicone stretches
 * off and a lost-PLA pattern burns out, so neither needs any.
 */
export const DEFAULT_TAB_DRAFT: Record<MoldTab, number> = {
  rigid: 0,
  silicone: 0,
  sand: 2,
  'lost-pla': 0,
};

/** The materials a tab offers. */
export function tabMaterials(tab: MoldTab): CastMaterial[] {
  const takes = TAB_TAKES[tab];
  return CAST_MATERIALS.filter((m) => m.metal === takes.metal && (takes.silicone || !m.silicone));
}

export function materialFitsTab(tab: MoldTab, id: CastMaterialId): boolean {
  return tabMaterials(tab).some((m) => m.id === id);
}

export interface TabDefaults {
  tab: MoldTab;
  material: CastMaterialId;
  draftDeg: number;
  /** The model carries draft from Prepare for Casting: shown, and not added again. */
  draftLocked: boolean;
}

/**
 * Where the dialog opens, and what the tab shows before anyone touches it: the
 * tab last used on this scene (else Rigid, never switched for the user), its
 * remembered material if the tab can take it, and its draft.
 */
export function tabDefaults(input: {
  rememberedTab?: MoldTab;
  /** Opening on this tab instead, as a tab click does. */
  tab?: MoldTab;
  rememberedMaterials?: Partial<Record<MoldTab, CastMaterialId>>;
  /** Draft Prepare for Casting put in the model, degrees; 0 for none. */
  bakedDraftDeg?: number;
}): TabDefaults {
  const tab = input.tab ?? input.rememberedTab ?? 'rigid';
  const remembered = input.rememberedMaterials?.[tab];
  const material = remembered && materialFitsTab(tab, remembered) ? remembered : DEFAULT_TAB_MATERIAL[tab];
  const baked = input.bakedDraftDeg ?? 0;
  return {
    tab,
    material,
    draftDeg: baked > 0 ? baked : DEFAULT_TAB_DRAFT[tab],
    draftLocked: baked > 0,
  };
}

/** A material's label, for a line of text. */
export const materialLabel = (id: CastMaterialId) => castMaterial(id).label;
