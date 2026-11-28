import { describe, expect, it } from 'vitest';
import { clampBodyForm } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { fullSides } from '../src/utils/cloth/garmentFullness';
import { garmentNameWarnings } from '../src/utils/cloth/clothNames';
import type { GarmentDraft } from '../src/types/cloth';

describe('fullness finds its seam by the name rule its warning checks', () => {
  it('`tier` gathers seams tier1 and tier2, and says nothing', () => {
    const form = clampBodyForm({ figure: 'female' });
    const draft = { garment: 'skirt', length: 0.6, seams: [{ name: 'tier1', point: [0, 0, 0.75], normal: [0, 0, 1] }, { name: 'tier2', point: [0, 0, 0.55], normal: [0, 0, 1] }], fullness: [{ along: 'tier', kind: 'gather', ratio: 1.4, side: 'below' }] } as GarmentDraft;
    const shell = garmentShell(draft, form);
    const seams = [...new Set(shell.seams.filter((s) => !s.open).map((s) => s.name))];
    expect(seams).toEqual(expect.arrayContaining(['tier1', 'tier2']));
    const warnings = garmentNameWarnings(draft, {}, [...seams, ...shell.edges.map((e) => e.name)], seams, shell.panels.map((p) => p.name), []);
    expect(warnings.filter((w) => w.startsWith('fullness'))).toEqual([]);
    const sides = fullSides(shell, draft.fullness, 'woven').filter((s) => s.kind === 'gather');
    // The front and back below each tier seam.
    expect(sides.length).toBe(4);
  }, 240000);
});
