// The Mold dialog's journeys, one test per row of the jobs table in
// plans/cast-flow.md: for a given scene and remembered tab, the defaults the
// dialog opens with need no more decisions than the plan's "after" column.

import { describe, it, expect } from 'vitest';
import { tabDefaults, tabMaterials, materialFitsTab, DEFAULT_TAB_DRAFT } from '../src/utils/moldTabs';
import { moldSubject, mcpMoldSubject } from '../src/utils/moldSubject';
import { generateCastPattern } from '../src/utils/castPatternExporter';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const box = (id: string, pos: number[], size = 0.01, children: SceneNode[] = []): SceneNode => ({
  id,
  name: id,
  pos,
  geoms: [{ name: `${id}_g`, type: 'box', size: [size, size, size] }],
  children,
} as SceneNode);

describe('which tab, which material, which draft', () => {
  it('ice tray or chocolate, nothing remembered: Rigid, epoxy until a material is picked, no draft', () => {
    expect(tabDefaults({})).toEqual({ tab: 'rigid', material: 'epoxy', draftDeg: 0, draftLocked: false });
    expect(materialFitsTab('rigid', 'chocolate')).toBe(true);
    expect(materialFitsTab('rigid', 'water')).toBe(true);
  });

  it('concrete planter: Rigid takes concrete, so the one optional pick is there', () => {
    expect(tabMaterials('rigid').map((m) => m.id)).toContain('concrete');
    expect(tabDefaults({ rememberedMaterials: { rigid: 'concrete' } }).material).toBe('concrete');
  });

  it('resin copy of an undercut sculpture: Silicone casts resin, never silicone into silicone', () => {
    const silicone = tabDefaults({ tab: 'silicone' });
    expect(silicone).toMatchObject({ tab: 'silicone', material: 'epoxy', draftDeg: 0 });
    expect(tabMaterials('silicone').some((m) => m.silicone || m.metal)).toBe(false);
  });

  it('sand-cast aluminium cog: the first time one tab click, then remembered', () => {
    expect(tabDefaults({ tab: 'sand' })).toEqual({ tab: 'sand', material: 'aluminium', draftDeg: 2, draftLocked: false });
    expect(tabDefaults({ rememberedTab: 'sand' }).tab).toBe('sand');
  });

  it('lost-PLA bronze figure: tab and metal both remembered after the first time', () => {
    const again = tabDefaults({ rememberedTab: 'lost-pla', rememberedMaterials: { 'lost-pla': 'bronze' } });
    expect(again).toEqual({ tab: 'lost-pla', material: 'bronze', draftDeg: 0, draftLocked: false });
  });

  it('never carries a material onto a tab that cannot take it', () => {
    expect(tabDefaults({ tab: 'sand', rememberedMaterials: { sand: 'epoxy' } }).material).toBe('aluminium');
    expect(tabDefaults({ tab: 'silicone', rememberedMaterials: { silicone: 'platinum' } }).material).toBe('epoxy');
    expect(tabMaterials('sand').every((m) => m.metal)).toBe(true);
    expect(tabMaterials('rigid').some((m) => m.metal)).toBe(false);
  });

  it('shows draft the model already has, locked, so it is never applied twice', () => {
    for (const tab of ['rigid', 'silicone', 'sand', 'lost-pla'] as const) {
      expect(tabDefaults({ tab, bakedDraftDeg: 3 })).toMatchObject({ draftDeg: 3, draftLocked: true });
    }
    expect(DEFAULT_TAB_DRAFT).toEqual({ rigid: 0, silicone: 0, sand: 2, 'lost-pla': 0 });
  });
});

describe('what is molded', () => {
  const scene: SceneGraph = {
    nodes: [
      box('stand', [0, 0, 0.05], 0.01, [box('arm', [0.02, 0, 0.01])]),
      box('dragon', [0.3, 0, 0.01]),
      { ...box('old_cast', [0.6, 0, 0.01]), simulation: { kind: 'cast' } } as SceneNode,
    ],
  };

  it('is the whole scene, less simulations, when nothing is selected', () => {
    const s = moldSubject(scene, []);
    expect(s.ids).toEqual(['stand', 'dragon']);
    expect(s.label).toBe('whole scene (2 parts)');
  });

  it('is only the selected part, children and all', () => {
    const s = moldSubject(scene, ['stand']);
    expect(s.scene.nodes.map((n) => n.id)).toEqual(['stand']);
    expect(s.scene.nodes[0].children?.[0].id).toBe('arm');
    expect(s.label).toBe('stand');
  });

  it('lifts a selected child to where it stands in the world', () => {
    const s = moldSubject(scene, ['arm']);
    expect(s.scene.nodes).toHaveLength(1);
    const p = s.scene.nodes[0].pos!;
    expect(p[0]).toBeCloseTo(0.02, 9);
    expect(p[2]).toBeCloseTo(0.06, 9);
  });

  it('takes a child once when its parent is selected too', () => {
    expect(moldSubject(scene, ['stand', 'arm']).ids).toEqual(['stand']);
  });

  it('casts a pattern of the selected part only', () => {
    const all = generateCastPattern(moldSubject(scene, []).scene, { metalId: 'aluminium' });
    const one = generateCastPattern(moldSubject(scene, ['dragon']).scene, { metalId: 'aluminium' });
    expect(one.success, one.error).toBe(true);
    expect(one.summary.partSizeMm.x).toBeCloseTo(20, 1);
    expect(all.summary.partSizeMm.x).toBeGreaterThan(300);
  });

  it('over MCP: master_id, else everything, never the selection', () => {
    const find = (id: string) => [scene.nodes[0], scene.nodes[0].children![0], scene.nodes[1], scene.nodes[2]].find((n) => n.id === id) ?? null;
    expect(mcpMoldSubject(scene, 'dragon', find)).toMatchObject({ ids: ['dragon'] });
    expect(mcpMoldSubject(scene, undefined, find)).toMatchObject({ ids: ['stand', 'dragon'] });
    expect(mcpMoldSubject(scene, 'ghost', find)).toEqual({ error: 'No body called ghost.' });
    expect(mcpMoldSubject(scene, 'old_cast', find)).toMatchObject({ error: expect.stringMatching(/pass master_id/) });
  });

  it('leaves a pour box out, selected or not', () => {
    const withBox = { nodes: [...scene.nodes, { ...box('box_sleeve', [0.3, 0, 0.01]), pourBox: { pourDepthMm: 20 } } as SceneNode] };
    expect(moldSubject(withBox, []).ids).toEqual(['stand', 'dragon']);
    expect(moldSubject(withBox, ['dragon', 'box_sleeve']).ids).toEqual(['dragon']);
  });

  it('treats a selected simulation as nothing selected', () => {
    expect(moldSubject(scene, ['old_cast']).ids).toEqual(['stand', 'dragon']);
    expect(moldSubject(scene, ['old_cast', 'dragon']).ids).toEqual(['dragon']);
  });
});

describe('draft on the pattern alone', () => {
  const scene: SceneGraph = { nodes: [box('block', [0, 0, 0.02], 0.02)] };

  it('grows a sand pattern by its draft, and leaves the model as it is', () => {
    const plain = generateCastPattern(scene, { metalId: 'aluminium', draftDeg: 0 });
    const drafted = generateCastPattern(scene, { metalId: 'aluminium', draftDeg: 3, addGating: false });
    expect(drafted.success, drafted.error).toBe(true);
    expect(drafted.summary.draftDeg).toBe(3);
    // A 40 mm cube parted at its base: the walls lean out toward the base by 40·tan3°.
    expect(drafted.summary.partVolumeMm3).toBeGreaterThan(plain.summary.partVolumeMm3 * 1.05);
    expect(scene.nodes[0].geoms![0].size).toEqual([0.02, 0.02, 0.02]);
  });

  it('adds none when the model already carries draft', () => {
    const prepped = { ...scene, castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, method: 'sand', originals: {}, skipped: [] } } as unknown as SceneGraph;
    const r = generateCastPattern(prepped, { metalId: 'aluminium', draftDeg: 5, addGating: false });
    const plain = generateCastPattern(scene, { metalId: 'aluminium', draftDeg: 0, addGating: false });
    expect(r.summary.draftDeg).toBe(2);
    expect(r.summary.partVolumeMm3).toBeCloseTo(plain.summary.partVolumeMm3, 0);
  });

  it('takes a shrink override', () => {
    const r = generateCastPattern(scene, { metalId: 'aluminium', shrinkPercent: 2 });
    expect(r.summary.shrinkPercent).toBe(2);
    expect(r.summary.patternSizeMm.z).toBeCloseTo(40 * 1.02, 2);
  });
});

describe('selection after Add', () => {
  it('leaves the selection to the caller when asked, through the rebuild', async () => {
    const { useStore } = await import('../src/store/useStore');
    const s = useStore.getState();
    s.updateScene({ nodes: [box('part', [0, 0, 0.01]), box('other', [0.1, 0, 0.01])] });
    s.selectMany(['part', 'other'], false);
    s.addHardwareComponentNode(box('halves', [0.3, 0, 0.01]), { select: false });
    useStore.getState().selectMany([], false);
    await new Promise((r) => setTimeout(r, 300));
    expect(useStore.getState().selectedNodeId).toBeNull();
    expect(useStore.getState().extraSelectedIds).toEqual([]);
  });

  it('makes an added body the whole selection by default', async () => {
    const { useStore } = await import('../src/store/useStore');
    const s = useStore.getState();
    s.updateScene({ nodes: [box('part', [0, 0, 0.01]), box('other', [0.1, 0, 0.01])] });
    s.selectMany(['part', 'other'], false);
    s.addHardwareComponentNode(box('cast', [0.3, 0, 0.01]));
    expect(useStore.getState().extraSelectedIds).toEqual([]);
  });
});
