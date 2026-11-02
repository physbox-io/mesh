// Every export works on the selection (or the whole scene), the stock is the
// bench's alone, and the bottom bar's Etch button sends a layout cut for the
// machine the bar names.

import { describe, it, expect } from 'vitest';
import { etchLayoutOptions, etchUrlForScene } from '../src/utils/etchSceneHandoff';
import { moldSubject, mcpMoldSubject } from '../src/utils/moldSubject';
import { reliefOptionsFor } from '../src/hooks/mcp/exportOptions';
import { useStore } from '../src/store/useStore';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const box = (id: string, x: number, half = [0.04, 0.03, 0.01]): SceneNode => ({
  id, name: id, type: 'body', pos: [x, 0, half[2]], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: half }],
});

const scene: SceneGraph = {
  nodes: [box('lid', 0), box('base', 0.2), { ...box('sim', 0.4), simulation: { kind: 'relief', createdAt: '', cellMm: 1, toleranceMm: 0, placement: 'beside' } }],
};

describe('what an export works on', () => {
  it('is the selection, else every body but simulations', () => {
    expect(moldSubject(scene, ['base']).scene.nodes.map((n) => n.id)).toEqual(['base']);
    expect(moldSubject(scene, []).scene.nodes.map((n) => n.id)).toEqual(['lid', 'base']);
    // A simulation left selected (Add Simulation selects it) counts as nothing selected.
    expect(moldSubject(scene, ['sim']).label).toBe('whole scene (2 parts)');
  });

  it('is master_id over MCP, with errors in the export\'s own words', () => {
    const find = (id: string) => scene.nodes.find((n) => n.id === id) ?? null;
    const picked = mcpMoldSubject(scene, 'lid', find, 'carve');
    expect('scene' in picked && picked.scene.nodes.map((n) => n.id)).toEqual(['lid']);
    const wrong = mcpMoldSubject(scene, 'sim', find, 'carve');
    expect('error' in wrong && wrong.error).toMatch(/part to carve/);
  });
});

describe('relief stock over MCP', () => {
  it('is the bench board, and a stock size is refused with where to set it', () => {
    useStore.getState().setStock({ widthMm: 210, depthMm: 160, thicknessMm: 19 });
    const { options } = reliefOptionsFor({});
    expect([options.stockWidthMm, options.stockDepthMm, options.stockThicknessMm]).toEqual([210, 160, 19]);
    expect(() => reliefOptionsFor({ stockWidthMm: 300 })).toThrow(/physics_set_environment/);
    // An older server's harmless 0 still goes through.
    expect(() => reliefOptionsFor({ stockThicknessMm: 0 })).not.toThrow();
  });
});

describe('the Etch button', () => {
  const stock = { widthMm: 300, depthMm: 200, thicknessMm: 6 };

  it('cuts for the machine on the bench, out of the bench stock', () => {
    const laser = etchLayoutOptions({ machine: 'laser', stock });
    const router = etchLayoutOptions({ machine: 'cnc', stock });
    expect(laser.kerf).toBeGreaterThan(0);
    expect(laser.cornerRelief).toBe('none');
    expect(router.kerf).toBe(0);
    expect(router.cornerRelief).toBe('dogbone');
    for (const o of [laser, router]) {
      expect(o.materialThickness).toBeCloseTo(0.006);
      expect(o.sheetWidth).toBeCloseTo(0.3);
      expect(o.sheetHeight).toBeCloseTo(0.2);
    }
  });

  it('builds a link that opens the layout in Etch at the stock thickness', async () => {
    const url = await etchUrlForScene({ scene: moldSubject(scene, ['lid']).scene, name: 'lid', machine: 'cnc', stock, baseUrl: 'https://etch.physbox.io/' });
    expect(url).toMatch(/^https?:\/\/.+#/);
    const params = new URLSearchParams(url.split('#')[1]);
    expect(params.get('thickness')).toBe('6');
    expect(params.get('name')).toBe('lid');
    expect(params.get('data')?.length).toBeGreaterThan(100);
  });
});
