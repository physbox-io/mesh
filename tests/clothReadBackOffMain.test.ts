// An MCP read of a garment the physics worker has not published yet
// (physics_get_object, physics_export_cut) never models it on the main
// thread in the app: a garment is seconds of clothModel, and polling one
// while a preset loaded froze the tab. Headless (no Worker) it still does.

import { describe, it, expect, vi, afterEach } from 'vitest';

const calls = { n: 0 };
vi.mock('../src/utils/cloth/clothModel', async (orig) => {
  const m = await orig<typeof import('../src/utils/cloth/clothModel')>();
  return { ...m, clothModel: (...a: Parameters<typeof m.clothModel>) => { calls.n++; return m.clothModel(...a); } };
});

import { clothNodeSummary, exportClothPatternUnfold } from '../src/utils/cloth/clothSummary';
import { sheetNode } from '../src/utils/cloth/clothSheet';
import type { SceneNode } from '../src/types/scene';

const table = { id: 'table', name: 'table', pos: [0, 0, 0.4], geoms: [{ name: 'table_g', type: 'box', size: [0.3, 0.2, 0.4] }], joints: [], children: [] } as unknown as SceneNode;
const sheet = { ...sheetNode([table], table), name: 'cover', id: 'cover' } as SceneNode;

describe('cloth read-back before the worker has the cloth', () => {
  afterEach(() => { vi.unstubAllGlobals(); calls.n = 0; });

  it('in the app: answered from the spec, nothing modelled here', () => {
    vi.stubGlobal('Worker', class {});
    const s = clothNodeSummary(sheet, { scene: [table, sheet] })!;
    expect(calls.n).toBe(0);
    expect(s.vertCount).toBe(0);
    const cut = exportClothPatternUnfold([sheet], [table, sheet], undefined);
    expect(calls.n).toBe(0);
    expect(cut.ok).toBe(false);
    expect(cut.warnings.join(' ')).toMatch(/still being modelled/);
  });

  it('headless: modelled here, as before', () => {
    const s = clothNodeSummary(sheet, { scene: [table, sheet] })!;
    expect(calls.n).toBe(1);
    expect(s.vertCount).toBeGreaterThan(0);
  });
});
