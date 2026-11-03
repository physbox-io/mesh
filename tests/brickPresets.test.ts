import { describe, it, expect } from 'vitest';
import { brickworkSourceGeoms } from '../src/utils/brickwork';
import { layBrickworkSourceOffThread } from '../src/utils/brickworkClient';
import { needsBrickworkBuild } from '../src/hooks/useCsgCompile';
import { smokerPreset, toyCastlePreset } from '../src/presets/brickPresets';

const body = (scene: typeof smokerPreset, id: string) => scene.nodes.find((n) => n.id === id)!;

describe('brickwork presets', () => {
  it('arrive as a shape to lay, and are laid on load', () => {
    for (const [scene, id] of [[smokerPreset, 'smoker_brickwork'], [toyCastlePreset, 'castle_brickwork']] as const) {
      const b = body(scene, id);
      expect(b.geoms).toEqual([]);
      expect(needsBrickworkBuild(b)).toBe(true);
      // Once laid it is left alone.
      expect(needsBrickworkBuild({ ...b, geoms: brickworkSourceGeoms(b.brickwork!).geoms })).toBe(false);
    }
  });

  it('lays the smoker in UK brick with a lintel over each opening', () => {
    const { result: r } = brickworkSourceGeoms(body(smokerPreset, 'smoker_brickwork').brickwork!);
    // Firebox mouth and door: the concrete lintels' gaps, 150 mm bearing each end.
    expect(r.lintels).toEqual([{ lengthMm: 1050, count: 1 }, { lengthMm: 1200, count: 1 }]);
    expect(r.warnings).toEqual([]);
    // As its note card says.
    expect([r.bricks.length, r.toBuy]).toEqual([415, 397]);
    expect(body(smokerPreset, 'smoker_door').joints[0].type).toBe('hinge');
  });

  it('builds the castle in toy bricks, counted by size', () => {
    const { result: r } = brickworkSourceGeoms(body(toyCastlePreset, 'castle_brickwork').brickwork!);
    expect(Math.round(r.builtHeightMm)).toBe(240);
    // As its note card says.
    expect(r.parts).toEqual([{ size: '2x8', count: 676 }, { size: '2x6', count: 31 }, { size: '2x4', count: 19 }, { size: '2x2', count: 129 }]);
    expect(body(toyCastlePreset, 'castle_drawbridge').joints[0].type).toBe('hinge');
  });

  it('lays a source through the client, its bricks named for their body', async () => {
    // No Worker under Node: the client lays it inline, as the page's worker would.
    const geoms = await layBrickworkSourceOffThread(body(toyCastlePreset, 'castle_brickwork').brickwork!, 'castle_brickwork');
    expect(geoms.length).toBe(855);
    expect(geoms.every((g) => g.type === 'box' && g.name!.startsWith('castle_brickwork_'))).toBe(true);
    expect(new Set(geoms.map((g) => g.name)).size).toBe(geoms.length);
  });
});
