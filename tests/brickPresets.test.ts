import { describe, it, expect } from 'vitest';
import { layBricks } from '../src/utils/brickwork';
import { CASTLE_OPTIONS, castleShape, decodeBricks, encodeBricks, SMOKER_OPTIONS, smokerShape } from '../src/presets/brickPresetShapes';
import { CASTLE_BRICKS, SMOKER_BRICKS } from '../src/presets/brickPresetData';
import { smokerPreset, toyCastlePreset } from '../src/presets/brickPresets';

describe('brickwork presets', () => {
  // The bricks are laid ahead of time; laid again here, they must come out the
  // same, or the data is stale: run `npx vite-node scripts/gen_brick_presets.ts`.
  it('ships the bricks its shapes lay today', () => {
    expect(encodeBricks(layBricks(smokerShape(), SMOKER_OPTIONS).bricks)).toEqual([...SMOKER_BRICKS]);
    expect(encodeBricks(layBricks(castleShape(), CASTLE_OPTIONS).bricks)).toEqual([...CASTLE_BRICKS]);
  });

  it('lays the smoker in UK brick with a lintel over each opening', () => {
    const r = layBricks(smokerShape(), SMOKER_OPTIONS);
    // Firebox mouth and door: the concrete lintels' gaps, 150 mm bearing each end.
    expect(r.lintels).toEqual([{ lengthMm: 1050, count: 1 }, { lengthMm: 1200, count: 1 }]);
    expect(r.warnings).toEqual([]);
    // As its note card says.
    expect([r.bricks.length, r.toBuy]).toEqual([415, 397]);
    expect(smokerPreset.nodes.find((n) => n.id === 'smoker_door')!.joints[0].type).toBe('hinge');
  });

  it('builds the castle in toy bricks, counted by size', () => {
    const r = layBricks(castleShape(), CASTLE_OPTIONS);
    expect(r.parts!.reduce((n, p) => n + p.count, 0)).toBe(decodeBricks(CASTLE_BRICKS).length);
    expect(Math.round(r.builtHeightMm)).toBe(240);
    // As its note card says.
    expect(r.parts).toEqual([{ size: '2x8', count: 676 }, { size: '2x6', count: 31 }, { size: '2x4', count: 19 }, { size: '2x2', count: 129 }]);
    expect(toyCastlePreset.nodes.some((n) => n.id === 'castle_drawbridge')).toBe(true);
  });
});
