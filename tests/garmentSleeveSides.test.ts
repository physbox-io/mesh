// The Garment card hid the cuff, armhole and sleeve-end controls of a garment
// whose sleeve came only from sleeveL/sleeveR (a one-sleeve dress, sleeve 0),
// and had no control for either side: they were MCP-only.

import { describe, expect, it } from 'vitest';
import { DRAFT_SLIDERS, hasSleeves, sleevesApart } from '../src/components/inspector/garmentFields';
import { garmentSettings } from '../src/utils/cloth/garments';
import type { GarmentDraft } from '../src/types/cloth';

const shown = (d: GarmentDraft) => DRAFT_SLIDERS.filter((f) => f.shows(garmentSettings(d))).map((f) => f.key);

describe('per-side sleeves in the editor', () => {
  it('a one-sleeve dress shows both sides, the cuff and the armhole, and not the one Sleeve', () => {
    const keys = shown({ garment: 'dress', sleeveL: 0.35 });
    expect(keys).toEqual(expect.arrayContaining(['sleeveL', 'sleeveR', 'cuff', 'armhole']));
    expect(keys).not.toContain('sleeve');
    expect(hasSleeves(garmentSettings({ garment: 'dress', sleeveL: 0.35 }))).toBe(true);
  });

  it('a side left unset shows the Sleeve length it takes', () => {
    const s = garmentSettings({ garment: 'tshirt', sleeveL: 0.4 });
    const right = DRAFT_SLIDERS.find((f) => f.key === 'sleeveR')!;
    expect(s.sleeveR ?? right.unset!(s)).toBe(0.2);
  });

  it('a plain garment shows the one Sleeve, and a sleeveless one no cuff', () => {
    expect(shown({ garment: 'tshirt' })).toEqual(expect.arrayContaining(['sleeve', 'cuff']));
    expect(shown({ garment: 'tshirt' })).not.toContain('sleeveL');
    expect(sleevesApart(garmentSettings({ garment: 'tshirt' }))).toBe(false);
    expect(shown({ garment: 'dress' })).not.toContain('cuff');
    expect(shown({ garment: 'dress', sleeveL: 0, sleeveR: 0 })).not.toContain('cuff');
  });
});
