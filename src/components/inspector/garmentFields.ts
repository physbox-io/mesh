import type { ClothMaterialName, FormLimbName, GarmentDraft, GarmentKind } from '../../types/cloth';
import type { GarmentSettings } from '../../utils/cloth/garments';

/**
 * The Garment card's controls: each a draft field (the same one MCP sets,
 * with the same default, the kind's in GARMENT_DEFAULTS), its range and when
 * it applies. Lengths are stored in metres and shown in mm.
 */
export type DraftUnit = 'mm' | '%' | '×' | '';

export interface DraftSliderField {
  key: keyof GarmentDraft & keyof GarmentSettings;
  label: string;
  tip: string;
  min: number;
  max: number;
  step: number;
  unit: DraftUnit;
  /** Whether it applies to a draft with these settings. */
  shows: (s: GarmentSettings & GarmentDraft) => boolean;
}

const tube = (s: GarmentSettings & GarmentDraft) => !!s.over;
const fromNeck = (s: GarmentSettings & GarmentDraft) => !s.over && s.top === 'neck';
const fromBand = (s: GarmentSettings & GarmentDraft) => !s.over && s.top !== 'neck';
const body = (s: GarmentSettings & GarmentDraft) => !s.over;

export const DRAFT_SLIDERS: DraftSliderField[] = [
  { key: 'length', label: 'Length', tip: 'Hem below the waist (trousers: waistband to hem). Past the floor, it lies on it.', min: 0.05, max: 1.6, step: 0.005, unit: 'mm', shows: body },
  { key: 'ease', label: 'Ease', tip: 'Room over the body: extra circumference at chest, waist and hip. Below zero, a stretch fit.', min: -0.12, max: 0.4, step: 0.005, unit: 'mm', shows: () => true },
  { key: 'waistEase', label: 'Waist ease', tip: 'Room round the waistband itself: snug, so it holds up.', min: 0, max: 0.1, step: 0.002, unit: 'mm', shows: fromBand },
  { key: 'flare', label: 'Flare', tip: 'Hem round over hip round (trousers: hem over thigh). 1 hangs straight.', min: 0.5, max: 4, step: 0.05, unit: '×', shows: body },
  { key: 'train', label: 'Train', tip: 'Extra length at the centre back, tapering off to the sides.', min: 0, max: 1.5, step: 0.01, unit: 'mm', shows: body },
  { key: 'neckline', label: 'Neckline', tip: 'How far the front neckline drops below the neck point.', min: 0, max: 0.3, step: 0.005, unit: 'mm', shows: fromNeck },
  { key: 'sleeve', label: 'Sleeve', tip: 'From the shoulder point; 0 for sleeveless.', min: 0, max: 0.75, step: 0.005, unit: 'mm', shows: fromNeck },
  { key: 'cuff', label: 'Cuff', tip: 'Round the sleeve at its end; 0 for as wide as the sleeve.', min: 0, max: 0.4, step: 0.005, unit: 'mm', shows: (s) => fromNeck(s) && s.sleeve > 0 },
  { key: 'armhole', label: 'Armhole drop', tip: 'Armhole cut this much deeper than a set-in sleeve: deep, a batwing.', min: 0, max: 0.3, step: 0.005, unit: 'mm', shows: (s) => fromNeck(s) && s.sleeve > 0 },
  { key: 'from', label: 'From', tip: 'Where along the limb it starts: 0 at the root, 100% at its end (toe, fingertips, crown).', min: 0, max: 1, step: 0.01, unit: '%', shows: tube },
  { key: 'to', label: 'To', tip: 'Where along the limb it ends.', min: 0, max: 1, step: 0.01, unit: '%', shows: tube },
  { key: 'gores', label: 'Panels', tip: 'Panels round it, cut along it: a dome wants more (a hat six), a sock two.', min: 1, max: 12, step: 1, unit: '', shows: tube },
];

export const DRAFT_SWITCHES: { key: 'opening' | 'fitted' | 'legs' | 'cap'; label: string; tip: string; shows: (s: GarmentSettings & GarmentDraft) => boolean }[] = [
  { key: 'opening', label: 'Open front', tip: 'Open down the centre front, its edges unsewn (a jacket); buttons or a zip close it.', shows: fromNeck },
  { key: 'fitted', label: 'Fitted', tip: 'Shaped to the body under the bust with darts; off, it hangs straight from its widest above.', shows: body },
  { key: 'legs', label: 'Legs', tip: 'Follows each leg down (trousers) instead of hanging past them (a skirt).', shows: fromBand },
  { key: 'cap', label: 'Closed end', tip: 'Closed over the far end (a sock toe, a hat crown).', shows: tube },
];

export const GARMENT_KINDS: { id: GarmentKind; label: string }[] = [
  { id: 'tshirt', label: 'T-shirt' }, { id: 'dress', label: 'Dress' }, { id: 'skirt', label: 'Skirt' }, { id: 'gown', label: 'Gown' },
  { id: 'jacket', label: 'Jacket' }, { id: 'trousers', label: 'Trousers' }, { id: 'tube', label: 'Tube (sleeve, leg warmer)' },
  { id: 'sock', label: 'Sock' }, { id: 'hat', label: 'Hat' },
];

export const FABRICS: { id: ClothMaterialName; label: string }[] = [
  { id: 'jersey', label: 'Jersey' }, { id: 'rib', label: 'Rib knit' }, { id: 'spandex', label: 'Spandex' }, { id: 'woven', label: 'Woven' },
  { id: 'denim', label: 'Denim' }, { id: 'canvas', label: 'Canvas' }, { id: 'leather', label: 'Leather' }, { id: 'taffeta', label: 'Taffeta' },
  { id: 'velvet', label: 'Velvet' }, { id: 'shadeCloth', label: 'Shade cloth' },
];

export const LIMBS: { id: FormLimbName; label: string }[] = [
  { id: 'armL', label: 'Left arm' }, { id: 'armR', label: 'Right arm' }, { id: 'legL', label: 'Left leg' }, { id: 'legR', label: 'Right leg' }, { id: 'head', label: 'Head' },
];
