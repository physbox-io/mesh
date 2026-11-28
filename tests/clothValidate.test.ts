// A garment of a kind that is not one (`garment: 'shorts'`) froze the tab and
// reloaded it empty: nothing checked it, the builder modelled it to nothing.
// An unknown fabric read its numbers off undefined. Both, and every other closed
// list in a cloth spec, are now refused where a body comes in, naming the field
// and the valid values; and the builder refuses them too, in words.

import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import * as THREE from 'three';
import { clothSpecProblems, GARMENT_KINDS, CLOTH_MATERIAL_NAMES } from '../src/utils/cloth/clothValidate';
import { checkIncomingBody } from '../src/utils/incomingBodyCheck';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { clothModel } from '../src/utils/cloth/clothModel';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { buildClothWorld, clothBuildFailures } from '../src/utils/cloth/clothWorld';
import { compileToMJCF } from '../src/utils/mjcf';
import { mujocoReady } from './clothSimHarness';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { GarmentDraft } from '../src/types/cloth';

describe('cloth spec validation', () => {
  it('refuses an unknown garment kind, listing the kinds', () => {
    const p = clothSpecProblems({ garment: { garment: 'shorts', fitTo: 'form' }, layer: 1 });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/cloth\.garment\.garment is "shorts"/);
    for (const k of GARMENT_KINDS) expect(p[0]).toContain(k);
  });

  it('refuses an unknown fabric, anywhere one is named', () => {
    const p = clothSpecProblems({
      material: 'cotton',
      garment: { garment: 'dress', material: 'silk', collar: { material: 'linen' }, attached: [{ name: 'r', outline: [[0, 0], [1, 0], [1, 1]], along: 'hem', material: 'wool' }], belt: { material: 'hemp' } },
      pieces: [{ name: 'a', edges: [], material: 'satin' }],
    });
    for (const f of ['cloth.material', 'cloth.garment.material', 'cloth.garment.collar.material', 'cloth.garment.attached[0].material', 'cloth.garment.belt.material', 'cloth.pieces[0].material']) {
      expect(p.some((s) => s.startsWith(`${f} is`))).toBe(true);
    }
    expect(p[0]).toContain(CLOTH_MATERIAL_NAMES.join(', '));
  });

  it('refuses every other closed list and bad numbers', () => {
    const p = clothSpecProblems({
      layout: 'flat',
      garment: {
        garment: 'jacket', top: 'chest', over: 'tail', sleeve: 'long',
        trims: [{ kind: 'rivet', along: 'hem' }, { along: 'hem' }, { kind: 'button', lap: 'up' }],
        rods: [{ along: 'side', kind: 'wood' }],
        fullness: [{ along: 'waist', kind: 'smock', facing: 'up', side: 'left' }],
        edges: [{ along: 'sleeve', profile: { points: [] } }],
        curves: [{ name: 'c', kind: 'zigzag', points: [] }],
        lapels: { width: 'wide' },
      },
    });
    for (const f of ['cloth.layout', 'cloth.garment.top', 'cloth.garment.over', 'cloth.garment.sleeve', 'cloth.garment.trims[0].kind', 'cloth.garment.trims[1].kind', 'cloth.garment.trims[2].lap',
      'cloth.garment.rods[0].kind', 'cloth.garment.fullness[0].kind', 'cloth.garment.fullness[0].facing', 'cloth.garment.fullness[0].side',
      'cloth.garment.edges[0].along', 'cloth.garment.curves[0].kind', 'cloth.garment.lapels.width']) {
      expect(p.some((s) => s.startsWith(f)), f).toBe(true);
    }
  });

  it('takes a null as an unset field', () => {
    expect(clothSpecProblems({ material: null, garment: { garment: 'dress', material: null, collar: null, trims: null } })).toEqual([]);
  });

  it('passes the cloth of every preset', () => {
    const bad: string[] = [];
    const walk = (nodes: SceneNode[], preset: string) => {
      for (const n of nodes) {
        if (n.cloth) for (const s of clothSpecProblems(n.cloth)) bad.push(`${preset}/${n.name}: ${s}`);
        walk(n.children ?? [], preset);
      }
    };
    for (const [k, p] of Object.entries(PRESETS)) walk(p.scene.nodes as SceneNode[], k);
    expect(bad).toEqual([]);
  });
});

describe('where a body comes in', () => {
  it('physics_add_object refuses an unknown kind with the valid list, and builds nothing', () => {
    expect(() => fillBodyDefaults({ id: 'shorts', cloth: { garment: { garment: 'shorts', fitTo: 'form' }, layer: 1 }, geoms: [] } as never))
      .toThrow(/Body 'shorts': cloth\.garment\.garment is "shorts", which is not one of: tshirt, dress/);
  });

  it('an update is checked the same way', () => {
    const node = { id: 'd', name: 'd', cloth: { garment: { garment: 'dress', material: 'silk' } } } as unknown as SceneNode;
    expect(() => checkIncomingBody(node, false)).toThrow(/cloth\.garment\.material is "silk", which is not one of: jersey/);
  });
});

describe('the builder, given what got past', () => {
  const form = bodyFormNode('form', 'form', { figure: 'female' });

  it('throws in words rather than modelling an unknown kind to nothing', () => {
    expect(() => garmentShell({ garment: 'shorts' } as unknown as GarmentDraft, form.bodyForm!, 0)).toThrow(/garment is "shorts"/);
  });

  it('throws in words for an unknown fabric', () => {
    expect(() => garmentShell({ garment: 'dress', material: 'silk' } as unknown as GarmentDraft, form.bodyForm!, 0)).toThrow(/material is "silk"/);
    const node = { id: 'd', name: 'd', cloth: { garment: { garment: 'dress', fitTo: 'form', material: 'silk' } } } as unknown as SceneNode;
    expect(() => clothModel(node, new THREE.Matrix4(), [form, node])).toThrow(/Body 'd': .*"silk"/);
  });
});

describe('the scene\'s cloth, one of them bad', () => {
  it('leaves the bad one out with a warning and builds the rest', async () => {
    const mj = await mujocoReady();
    const form = bodyFormNode('form', 'form');
    const shirt = garmentNode('tshirt', 'tshirt', { garment: 'tshirt' }, form);
    const bad = { id: 'shorts', name: 'shorts', cloth: { garment: { garment: 'shorts', fitTo: 'form' }, layer: 1 } } as unknown as SceneNode;
    const build = (nodes: SceneNode[]) => {
      const graph = { nodes } as SceneGraph;
      const model = mj.MjModel.from_xml_string(compileToMJCF(graph));
      const data = new mj.MjData(model);
      mj.mj_forward(model, data);
      return buildClothWorld(mj, model, data, graph, null, false);
    };
    const world = build([form, shirt, bad])!;
    expect(world.models.map((m) => m.name)).toEqual(['tshirt']);
    expect(world.keys).toHaveLength(1);
    expect(world.warnings.some((w) => /^shorts: not built: .*"shorts"/.test(w))).toBe(true);
    // Alone, none is built, and the failure is still there to report.
    expect(build([form, bad])).toBeNull();
    expect(clothBuildFailures()[0]).toMatch(/^shorts: not built/);
  }, 180_000);
});
