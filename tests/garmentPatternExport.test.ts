import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';
import { DEFAULT_PATTERN_OPTIONS } from '../src/utils/cloth/patternExport';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const dress = garmentNode('dress', 'dress', { garment: 'dress' }, form);

async function exportCut(msg: Record<string, unknown>, nodes: SceneNode[]) {
  const prev = useStore.getState().sceneGraph;
  useStore.setState({ sceneGraph: { ...prev, nodes } });
  try {
    return (await cutCommands.EXPORT_CUT(msg as never, { store: useStore.getState() } as never)) as Record<string, unknown>;
  } finally {
    useStore.setState({ sceneGraph: prev });
  }
}

describe('a garment on a built form unfolds as its sewing pattern', () => {
  it('the form is built, as a scene holds it', () => {
    expect(form.geoms.length).toBeGreaterThan(10);
  });

  for (const msg of [
    { kind: 'unfold' },
    { kind: 'unfold', masterId: 'dress' },
    { kind: 'unfold', sheetMode: 'soft_goods' },
  ]) {
    it(`${JSON.stringify(msg)}: the dress's pieces, at the editor's seam allowance`, async () => {
      const t0 = Date.now();
      const r = await exportCut(msg, [form, dress]);
      expect(r.ok).toBe(true);
      const s = r.summary as Record<string, unknown>;
      expect(s.mode).toBe('soft_goods');
      expect(s.pieceNames).toEqual(expect.arrayContaining(['front', 'back']));
      expect(s.seamAllowanceMm).toBe(DEFAULT_PATTERN_OPTIONS.seamAllowanceMm);
      // The mannequin was never unfolded (that took over ten minutes) nor named as left out.
      expect(Date.now() - t0).toBeLessThan(60_000);
      expect((r.warnings as string[]).join(' ')).not.toMatch(/form/);
    }, 120_000);
  }

  it('a rigid body beside the garment is left out, and said so', async () => {
    const box = { id: 'box', name: 'box', pos: [1, 0, 0], geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }], joints: [], children: [] } as unknown as SceneNode;
    const r = await exportCut({ kind: 'unfold' }, [form, dress, box]);
    expect(r.ok).toBe(true);
    expect((r.summary as Record<string, unknown>).mode).toBe('soft_goods');
    expect((r.warnings as string[]).some((w) => w.includes('box') && w.includes('left out'))).toBe(true);
  }, 120_000);

  it('an explicit papercraft mode still unfolds the rigid bodies', async () => {
    const box = { id: 'box', name: 'box', pos: [1, 0, 0], geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }], joints: [], children: [] } as unknown as SceneNode;
    const r = await exportCut({ kind: 'unfold', sheetMode: 'papercraft', masterId: 'box' }, [form, dress, box]);
    expect(r.ok).toBe(true);
    expect((r.summary as Record<string, unknown>).mode).toBe('papercraft');
  }, 120_000);
});
