import { describe, it, expect } from 'vitest';
import { exportBaseName } from '../src/utils/exportBaseName';
import { PRESETS } from '../src/presets/presetScenes';
import type { NoteCard } from '../src/utils/noteCards';

const card = (markdown: string): NoteCard => ({ id: 'c', markdown, minimized: false, x: 0, y: 0 });

describe('exportBaseName', () => {
  it('takes the first note card heading, made filename-safe', () => {
    expect(exportBaseName([card('# **Gear** Box v2!\n\nbody')], 'gears')).toBe('gear_box_v2');
  });

  it('skips the new-card placeholder heading and cards with no heading', () => {
    expect(exportBaseName([card('# Note\n\nWrite your notes here.'), card('no heading'), card('# Bracket')], undefined)).toBe('bracket');
  });

  it('falls back to the user preset name', () => {
    expect(exportBaseName([card('# Note')], 'user: My Part ')).toBe('my_part');
  });

  it('falls back to the built-in preset display name', () => {
    const name = (PRESETS as Record<string, { name: string }>).gears.name;
    expect(exportBaseName([], 'gears')).toBe(name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, ''));
  });

  it('uses an unknown preset id as is, and physics_scene with nothing at all', () => {
    expect(exportBaseName([], 'not_a_preset')).toBe('not_a_preset');
    expect(exportBaseName([], undefined)).toBe('physics_scene');
    expect(exportBaseName([card('# ***')], '')).toBe('physics_scene');
  });
});
