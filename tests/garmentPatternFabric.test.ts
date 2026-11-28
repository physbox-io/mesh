import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import type { PatternPiece } from '../src/utils/cloth/patternSvg';
import { cutLayoutSvg, fabricLayouts, patternLayoutOptions } from '../src/utils/cloth/patternExport';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';

const form = bodyFormNode('form', 'form', { figure: 'female' });
const tee = garmentNode('tee', 'tee', { garment: 'tshirt' }, form);
const model = clothModel(tee, new THREE.Matrix4(), [form, tee]);
const pieces: PatternPiece[] = model.groups.filter((g) => g.flat).map((g) => ({ name: g.name.split('__')[1], ...g.flat!, garment: 'tee', fabric: g.material }));
const opts = patternLayoutOptions();

describe('laying a pattern on fabric', () => {
  it('lays every piece whole on the fabric width, along the grain, and says how much to buy', () => {
    const [wide] = fabricLayouts(pieces, opts, 1500);
    const [narrow] = fabricLayouts(pieces, opts, 1100);
    expect(wide.fabric).toBe('jersey');
    expect(wide.pieces.length).toBe(pieces.length);
    expect(wide.layout.pieces.every((p) => p.cut === 'Cut 1')).toBe(true);
    for (const l of [wide, narrow]) {
      for (const p of l.layout.pieces) expect(p.x + p.w).toBeLessThanOrEqual(l.widthMm + 0.01);
      expect(l.metres).toBeGreaterThanOrEqual(l.lengthMm / 1000);
      expect(l.metres).toBeLessThan(l.lengthMm / 1000 + 0.1001);
      expect(l.yards).toBeGreaterThanOrEqual(l.lengthMm / 914.4);
    }
    expect(narrow.lengthMm).toBeGreaterThan(wide.lengthMm);
    // About a t-shirt's worth: a metre or two.
    expect(wide.metres).toBeGreaterThan(0.5);
    expect(wide.metres).toBeLessThan(2.5);
  });

  it('a layout per fabric, or per colour; a piece wider than the fabric is said', () => {
    const two = pieces.map((p, i) => ({ ...p, colour: i % 2 ? '#ff0000' : '#0000ff' }));
    expect(fabricLayouts(two, opts, 1500).length).toBe(1);
    expect(fabricLayouts(two, opts, 1500, true).length).toBe(2);
    const tight = fabricLayouts(pieces, opts, 400);
    expect(tight[0].tooWide.length).toBeGreaterThan(0);
    const svg = cutLayoutSvg(two, fabricLayouts(two, opts, 1500, true), 'tee', opts);
    expect(svg.sheets.length).toBe(2);
    expect(svg.svg).toMatch(/150 cm wide, buy \d\.\d m/);
  });

  it('MCP lays it on the width asked, hands Etch the cut layout, and groups by colour', async () => {
    const prev = useStore.getState().sceneGraph;
    useStore.setState({ sceneGraph: { ...prev, nodes: [form, tee] as SceneNode[] } });
    try {
      const r = (await cutCommands.EXPORT_CUT({ kind: 'unfold', fabricWidthMm: 1100, groupByColor: true, includeFiles: true } as never, { store: useStore.getState() } as never)) as Record<string, unknown>;
      expect(r.ok).toBe(true);
      const s = r.summary as Record<string, unknown>;
      expect(s.fabricWidthMm).toBe(1100);
      const y = s.yardage as { widthMm: number; metres: number }[];
      expect(y.length).toBeGreaterThan(0);
      expect(y[0].widthMm).toBe(1100);
      const files = r.files as { name: string }[];
      expect(files[0].name).toMatch(/_cut_layout\.svg$/);
      expect((r.warnings as string[]).join(' ')).not.toMatch(/groupByColor/);
    } finally {
      useStore.setState({ sceneGraph: prev });
    }
  }, 120_000);
});
