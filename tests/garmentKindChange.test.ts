// Changing a garment's Kind threw the draft away: fabric, colour, drawn
// curves, sculpt, trims and collar all went, without a word. Now everything
// that still applies to the new kind is kept, and what has nothing to apply to
// is left out and said.

import { describe, expect, it } from 'vitest';
import { changeGarmentKind } from '../src/utils/cloth/garmentKindChange';
import type { GarmentDraft } from '../src/types/cloth';

const dress: GarmentDraft = {
  garment: 'dress', fitTo: 'form', material: 'velvet', rgba: [0.1, 0.5, 0.2, 1], length: 0.7, neckline: 0.2,
  collar: { stand: 0.02, fall: 0.05 }, trims: [{ kind: 'bead', along: 'neckline' }],
  curves: [{ name: 'yoke', kind: 'seam', points: [[0, -0.1, 1.2], [0.1, -0.1, 1.2]] }],
  sculpt: [{ at: [0, -0.15, 0.9], radius: 0.1, amount: 0.02 }],
  edges: [{ along: 'neckline', profile: { points: [[0, 1], [1, 0]] } }, { along: 'hem', profile: { points: [[0, 0], [0.5, 0.1], [1, 0]] } }],
  pockets: [{ panel: 'front' }], pattern: { svg: '<svg/>' } as GarmentDraft['pattern'],
};

describe('changing a garment\'s kind', () => {
  it('a dress made a gown keeps all of it', () => {
    const { draft, dropped } = changeGarmentKind(dress, 'gown');
    expect(dropped).toEqual([]);
    expect(draft).toEqual({ ...dress, garment: 'gown' });
  });

  it('a dress made a skirt keeps what a skirt has and says what it left out', () => {
    const { draft, dropped } = changeGarmentKind(dress, 'skirt');
    expect(draft.garment).toBe('skirt');
    for (const k of ['fitTo', 'material', 'rgba', 'length', 'trims', 'curves', 'sculpt', 'pockets', 'pattern'] as const) expect(draft[k]).toEqual(dress[k]);
    expect(draft.neckline).toBeUndefined();
    expect(draft.collar).toBeUndefined();
    expect(draft.edges).toEqual([dress.edges![1]]);
    expect(dropped).toEqual(['neckline (a skirt like this has none)', 'collar (a skirt like this has none)', "the neckline's shape (a skirt like this has none)"]);
  });

  it('what makes a kind is the new kind\'s, unless both kinds agree on it', () => {
    // A strapless dress made a gown stays strapless, and loses what a band top has no use for.
    const strapless = changeGarmentKind({ ...dress, top: 1.25 }, 'gown');
    expect(strapless.draft.top).toBe(1.25);
    expect(strapless.dropped).toContain('neckline (a gown like this has none)');
    // A dress whose top was set to its own 'neck' made a skirt starts at the skirt's waist, quietly.
    const skirt = changeGarmentKind({ ...dress, top: 'neck' }, 'skirt');
    expect(skirt.draft.top).toBeUndefined();
    expect(skirt.dropped.some((d) => d.startsWith('top'))).toBe(false);
    // A tube moved to the leg made a sock is a sock's span; its own panel count, the same on both, is kept.
    const sock = changeGarmentKind({ garment: 'tube', over: 'legR', from: 0.5, gores: 2, material: 'rib' }, 'sock');
    expect(sock.draft).toEqual({ garment: 'sock', gores: 2, material: 'rib' });
    expect(sock.dropped).toEqual([`over "legR" (a sock's own is "legL")`, 'from 0.5 (a sock\'s own is 0.62)']);
  });

  it('a garment made a tube keeps its fabric and leaves out the body\'s lengths', () => {
    const { draft, dropped } = changeGarmentKind(dress, 'tube');
    expect(draft.material).toBe('velvet');
    expect(draft.length).toBeUndefined();
    expect(dropped).toContain('length (a tube like this has none)');
    expect(dropped).toContain('pockets (a tube like this has none)');
  });
});
