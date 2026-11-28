import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import { layoutRects, type PatternPiece } from '../src/utils/cloth/patternSvg';
import { patternLayoutOptions, printPattern } from '../src/utils/cloth/patternExport';
import { tilePages, tileSvgForHomePrint } from '../src/utils/tiledPaperPrint';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const tee = garmentNode('tee', 'tee', { garment: 'tshirt' }, form);
const model = clothModel(tee, new THREE.Matrix4(), [form, tee]);
const pieces: PatternPiece[] = model.groups.filter((g) => g.flat).map((g) => ({ name: g.name.split('__')[1], ...g.flat!, garment: 'tee', fabric: g.material }));

async function exportCut(msg: Record<string, unknown>, nodes: SceneNode[]) {
  const prev = useStore.getState().sceneGraph;
  useStore.setState({ sceneGraph: { ...prev, nodes } });
  try {
    return (await cutCommands.EXPORT_CUT({ includeFiles: true, ...msg } as never, { store: useStore.getState() } as never)) as Record<string, unknown>;
  } finally {
    useStore.setState({ sceneGraph: prev });
  }
}

describe('printing a sewing pattern at home', () => {
  it('a t-shirt packs onto a handful of A4 pages, not a row of 52', () => {
    // Every piece whole: about its area in pages.
    const whole = printPattern(pieces, 'tee', { seamAllowanceMm: 10 }, 'a4');
    expect(whole.layout.pieces.length).toBe(pieces.length);
    expect(whole.pages).toBeLessThanOrEqual(30);
    // As a pattern is printed: pairs once, halves on the fold, with its title block.
    const pr = printPattern(pieces, 'tee', { ...patternLayoutOptions(), titleBlock: ['tee'] }, 'a4');
    expect(pr.pages).toBeLessThanOrEqual(18);
    // Every page printed holds part of a piece.
    const grid = tilePages(pr.layout.width, pr.layout.height, 'a4', layoutRects(pr.layout));
    expect(grid.count).toBe(pr.pages);
    expect(pr.pageSvgs.length).toBe(pr.pages);
  });

  it('pages a drawing leaves blank are not printed', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800mm" height="800mm" viewBox="0 0 800 800"><rect x="0" y="0" width="100" height="100"/></svg>';
    const all = tileSvgForHomePrint(svg, { paper: 'a4' });
    const some = tileSvgForHomePrint(svg, { paper: 'a4', occupied: [{ x: 0, y: 0, w: 100, h: 100 }] });
    expect(all.pages.length).toBeGreaterThan(9);
    expect(some.pages.length).toBe(1);
    expect(some.pages[0].svg).toContain('50 × 50 mm');
    expect(some.html).toContain('blank left out');
  });

  it('MCP honours the sheet options for a garment, and hands Etch the fabric, not hardwood', async () => {
    const r = await exportCut({ kind: 'unfold', sheetPreset: 'a4', splitSheets: true, scaleFactor: 2, tabWidthMm: 5 }, [form, tee]);
    expect(r.ok).toBe(true);
    const s = r.summary as Record<string, unknown>;
    expect(s.paper).toBe('a4');
    expect(s.printPages).toBeGreaterThan(0);
    expect(s.printPages).toBeLessThanOrEqual(18);
    const files = r.files as { name: string; base64?: string }[];
    expect(files.some((f) => f.name.endsWith('_a4_tiled.html'))).toBe(true);
    expect(files.filter((f) => /_a4_page_\d+\.svg$/.test(f.name)).length).toBe(s.printPages);
    const etch = r.etch as Record<string, unknown>;
    expect(etch.material).toBeUndefined();
    expect(etch.thicknessMm).toBeCloseTo(0.8, 2); // jersey
    const warnings = (r.warnings as string[]).join(' ');
    expect(warnings).toMatch(/scaleFactor/);
    expect(warnings).toMatch(/tabWidthMm/);
  }, 120_000);

  it('MCP one_part_per_sheet gives a file per piece', async () => {
    const r = await exportCut({ kind: 'unfold', onePartPerSheet: true }, [form, tee]);
    expect(r.ok).toBe(true);
    const names = (r.summary as Record<string, unknown>).pieceNames as string[];
    // The cut layout, then a file per piece.
    const files = r.files as { name: string }[];
    expect(files[0].name).toMatch(/_cut_layout\.svg$/);
    expect(files.length).toBe(names.length + 1);
  }, 120_000);
});
