import { describe, it, expect } from 'vitest';
import { PRESETS } from '../src/presets/presetScenes';
import { PRESET_SHELF, exampleEntries, matchesQuery, copyName, formatSceneDate } from '../src/utils/sceneCatalog';

describe('scene catalog', () => {
  it('puts every built-in preset on a shelf', () => {
    const missing = Object.keys(PRESETS).filter((id) => !(id in PRESET_SHELF));
    expect(missing).toEqual([]);
  });

  it('names no preset that does not exist', () => {
    const stale = Object.keys(PRESET_SHELF).filter((id) => !(id in PRESETS));
    expect(stale).toEqual([]);
  });

  it('lists every preset once, Blank first', () => {
    const ids = exampleEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(Object.keys(PRESETS).length);
    expect(ids[0]).toBe('empty');
  });

  it('matches every word in any order, ignoring case and accents', () => {
    expect(matchesQuery('gate mesh', 'Golden Gate (Mesh)')).toBe(true);
    expect(matchesQuery('MESH gate', 'Golden Gate (Mesh)')).toBe(true);
    expect(matchesQuery('gate rope', 'Golden Gate (Mesh)')).toBe(false);
    expect(matchesQuery('cafe', 'Café sign')).toBe(true);
    expect(matchesQuery('  ', 'anything')).toBe(true);
    expect(matchesQuery('bridges', 'Rope Bridge', 'Bridges')).toBe(true);
  });

  it('finds a free name for a copy', () => {
    expect(copyName('Bracket', ['Bracket'])).toBe('Bracket copy');
    expect(copyName('Bracket', ['Bracket', 'Bracket copy'])).toBe('Bracket copy 2');
    expect(copyName('Bracket copy', ['Bracket copy', 'Bracket copy 2'])).toBe('Bracket copy 3');
  });
});

describe('formatSceneDate', () => {
  const now = new Date(2026, 9, 22, 15, 30).getTime();
  it('shows a time for today, Yesterday, then a date', () => {
    expect(formatSceneDate(new Date(2026, 9, 22, 9, 5).getTime(), now)).toMatch(/09|9/);
    expect(formatSceneDate(new Date(2026, 9, 21, 23, 0).getTime(), now)).toBe('Yesterday');
    expect(formatSceneDate(new Date(2026, 2, 3).getTime(), now)).not.toMatch(/2026/);
    expect(formatSceneDate(new Date(2025, 2, 3).getTime(), now)).toMatch(/2025/);
  });
});
