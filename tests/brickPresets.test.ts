import { describe, it, expect } from 'vitest';
import { brickworkInScene } from '../src/utils/brickwork';
import { layBrickworkSourceOffThread } from '../src/utils/brickworkClient';
import { needsBrickworkBuild } from '../src/hooks/useCsgCompile';
import { smokerPreset, toyCastlePreset } from '../src/presets/brickPresets';

const body = (scene: typeof smokerPreset, id: string) => scene.nodes.find((n) => n.id === id)!;

describe('brickwork presets', () => {
  it('start as models, for Build → Brick to lay, with their brick settings on the scene', () => {
    expect(body(smokerPreset, 'smoker_walls').geoms.length).toBeGreaterThan(5);
    expect(body(toyCastlePreset, 'castle').geoms.length).toBeGreaterThan(5);
    expect(smokerPreset.nodes.some((n) => n.brickwork)).toBe(false);
    expect(smokerPreset.brickwork).toEqual({ standardId: 'uk', bond: 'stretcher' });
    expect(toyCastlePreset.brickwork).toEqual({ standardId: 'toy' });
  });

  it('lays the smoker walls in whole bricks but for half bricks at the openings', () => {
    const { nodes, result: r } = brickworkInScene(smokerPreset, 'smoker_walls', { standardId: 'uk', bond: 'stretcher', placement: 'replace' });
    // As its note card says.
    expect(r.bricks.length).toBe(261);
    expect(r.cuts).toEqual([{ lengthMm: 105, count: 12 }]);
    // The model's own lintels, in the slots left for them.
    expect(r.lintels).toEqual([{ lengthMm: 685, count: 1 }, { lengthMm: 910, count: 1 }]);
    // The walls, and the chimney standing on its slab: nothing to warn of.
    expect(r.bond).toMatchObject({ pieces: 2, sideBySide: 0, straightJoints: 0 });
    expect(r.warnings).toEqual([]);
    // In place of the walls; the door, slab and steel stay.
    expect(nodes.some((n) => n.id === 'smoker_walls')).toBe(false);
    expect(nodes.find((n) => n.id === 'smoker_door')!.joints[0].type).toBe('hinge');
  });

  it('never lays a moving part, even with the whole scene', () => {
    const { nodes } = brickworkInScene(smokerPreset, null, { standardId: 'uk', placement: 'replace' });
    expect(nodes.some((n) => n.id === 'smoker_door')).toBe(true);
  });

  it('builds the castle in toy bricks, in one piece, the colour of the model', () => {
    const { nodes, result: r } = brickworkInScene(toyCastlePreset, 'castle', { standardId: 'toy', placement: 'replace' });
    // A grey castle builds grey, each brick a shade either side.
    const rgba = nodes.filter((n) => n.name.startsWith('Course')).flatMap((n) => n.geoms.map((g) => g.rgba!));
    expect(rgba.every((c) => Math.abs(c[0] - 0.62) < 0.05 && Math.abs(c[0] - c[1]) < 0.01)).toBe(true);
    expect(Math.round(r.builtHeightMm)).toBe(240);
    // As its note card says.
    expect(r.bricks.length).toBe(538);
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0 });
  });

  it('builds the castle from what the builder has, short of nothing', () => {
    // Four 2×10s, six 2×12s, and 2-wide bricks up to 2×8: no 1×1s at all.
    const toyInventory = { '2x2': null, '2x3': null, '2x4': null, '2x6': null, '2x8': null, '2x10': 4, '2x12': 6 };
    const { result: r } = brickworkInScene(toyCastlePreset, 'castle', { standardId: 'toy', hollowStuds: 2, toyInventory });
    expect(r.short).toEqual([]);
    const count = (size: string) => r.parts!.find((p) => p.size === size)?.count ?? 0;
    expect(count('2x10')).toBeLessThanOrEqual(4);
    expect(count('2x12')).toBeLessThanOrEqual(6);
    expect(count('1x1')).toBe(0);
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0 });
  });

  it('saves the few long bricks there are for the gateway they must span', () => {
    // Only four 2×10s: spent low down, the 8-stud gateway is left with nothing
    // that grips either side of it.
    const toyInventory = { '2x2': null, '2x4': null, '2x8': null, '2x10': 4 };
    const { result: r } = brickworkInScene(toyCastlePreset, 'castle', { standardId: 'toy', hollowStuds: 2, toyInventory });
    expect(r.short).toEqual([]);
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0 });
    expect(r.warnings).toEqual([]);
  });

  it('lays a brickwork body from its source on load, named for it', async () => {
    const source = { shape: body(toyCastlePreset, 'castle').geoms, standardId: 'toy' };
    const laid = { id: 'castle_bricks', name: 'Castle', type: 'body' as const, pos: [0, 0, 0], joints: [], children: [], geoms: [], brickwork: source };
    expect(needsBrickworkBuild(laid)).toBe(true);
    // No Worker under Node: the client lays it inline, as the page's worker would.
    const geoms = await layBrickworkSourceOffThread(source, 'castle_bricks');
    expect(geoms.length).toBe(538);
    expect(geoms.every((g) => g.type === 'box' && g.name!.startsWith('castle_bricks_'))).toBe(true);
    expect(needsBrickworkBuild({ ...laid, geoms })).toBe(false);
  });
});
