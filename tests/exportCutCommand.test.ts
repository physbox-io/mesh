// EXPORT_CUT: the SVG the Etch button and the 2D dialogs make, over MCP, so
// an agent can hand a part to Etch without redoing Mesh's layout itself.

import { describe, it, expect, beforeEach } from 'vitest';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const box = (id: string, x: number, half: number[]): SceneNode => ({
  id, name: id, type: 'body', pos: [x, 0, half[2]], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: half }],
});

const scene: SceneGraph = { nodes: [box('lid', 0, [0.04, 0.03, 0.0015]), box('block', 0.2, [0.02, 0.02, 0.02])] };

function run(msg: Record<string, unknown>) {
  const store = { ...useStore.getState(), sceneGraph: scene };
  return cutCommands.EXPORT_CUT(msg, { store, toId: (v: unknown) => v } as never) as Promise<Record<string, unknown>>;
}

const svgOf = (res: Record<string, unknown>) => {
  const f = (res.files as { base64?: string }[])[0];
  return Buffer.from(f.base64!, 'base64').toString('utf8');
};

beforeEach(() => {
  useStore.getState().setStock({ widthMm: 300, depthMm: 200, thicknessMm: 3 });
});

describe('EXPORT_CUT', () => {
  it('lays out panels of master_id for the bench machine, with what Etch needs', async () => {
    const res = await run({ kind: 'panels', masterId: 'lid', machine: 'laser' });
    expect(res.error ?? null).toBeNull();
    expect((res.cut as { ids: string[] }).ids).toEqual(['lid']);
    expect(res.etch).toEqual({
      name: 'lid panels',
      thicknessMm: 3,
      machine: 'laser',
      material: useStore.getState().material,
    });
    expect(svgOf(res)).toMatch(/^<\?xml|<svg/);
  });

  it('slices a contour stack at the bench thickness', async () => {
    const res = await run({ kind: 'contour', masterId: 'block' });
    expect(res.ok).toBe(true);
    expect((res.summary as { layers: number }).layers).toBeGreaterThanOrEqual(10);
  });

  it('unfolds a net at its own thickness and bench sheet size, with ghost sheet frames', async () => {
    const res = await run({ kind: 'unfold', masterId: 'block', sheetMode: 'papercraft' });
    expect(res.ok).toBe(true);
    expect((res.etch as { thicknessMm: number }).thicknessMm).toBe(1.5);
    const svg = svgOf(res);
    expect(svg).toMatch(/^<svg width="300mm" height="200mm"/);
    expect(svg).toContain('Thickness=1.5mm');
    // Sheet caption belongs to the ghost sheet-bounds group, not an etched workpiece layer.
    const ghostGroup = svg.match(/<g id="layer-sheet-bounds"[\s\S]*?<\/g>/)?.[0] ?? '';
    expect(ghostGroup).toContain('Sheet 1');
  });

  it('packs multi-sheet cuts onto stacked edge-to-edge sheets and hands sheet specs to Etch', async () => {
    useStore.getState().setStock({ widthMm: 100, depthMm: 80, thicknessMm: 3 });
    const contour = await run({ kind: 'contour', masterId: 'block', machine: 'router' });
    expect(contour.ok).toBe(true);
    expect(contour.machine).toBe('cnc');
    const etchMeta = contour.etch as { sheets?: { widthMm: number; heightMm: number; thicknessMm: number }[] };
    expect(etchMeta.sheets?.length).toBeGreaterThanOrEqual(2);
    expect(etchMeta.sheets?.[0]).toEqual({ widthMm: 100, heightMm: 80, thicknessMm: 3 });

    const unfold = await run({ kind: 'unfold', sheetMode: 'papercraft' });
    expect(unfold.ok).toBe(true);
    const unfoldSvg = svgOf(unfold);
    const unfoldSheets = (unfold.summary as { sheets: number }).sheets;
    expect(unfoldSheets).toBeGreaterThanOrEqual(2);
    // Stacked with 0 mm gap so Etch's sheet splitter recognises the stack.
    expect(unfoldSvg).toContain('<rect x="0" y="0" width="100" height="80"');
    expect(unfoldSvg).toContain('<rect x="0" y="80" width="100" height="80"');
  });

  it('refuses a kind or machine it does not know, and a body that is not there', async () => {
    expect((await run({ kind: 'gcode' })).ok).toBe(false);
    expect((await run({ machine: 'plasma' })).ok).toBe(false);
    expect((await run({ masterId: 'nope' })).error).toMatch(/No body called nope/);
  });
});
