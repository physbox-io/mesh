// Everything Mesh hands Etch says what it is for. Etch used to make every
// colour a cut layer, so fold lines, reference outlines and sheet bounds
// would have been cut through and the PCB faceplate's middle dropped out.
// Etch now reads data-operation; these hold the senders to writing it.

import { describe, it, expect } from 'vitest';
import { exportPcbFaceplateSvg, PCB_PRESETS } from '../src/utils/pcbEnclosureSync';
import { exportSheetUnfold } from '../src/utils/sheetUnfoldExporter';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { birdhousePreset } from '../src/presets/presetScenes';
import type { SceneGraph } from '../src/types/scene';

const groups = (svg: string) => svg.match(/<g\b[^>]*>/g) ?? [];
const op = (tag: string) => tag.match(/data-operation="([a-z]+)"/)?.[1];
const groupOp = (svg: string, id: string) => op(groups(svg).find((g) => g.includes(`id="${id}"`)) ?? '');

describe('SVG sent to Etch declares its operations', () => {
  it('PCB faceplate: the board outline is a guide, not a cut', () => {
    const { svg } = exportPcbFaceplateSvg(PCB_PRESETS.eurorack_3u_10hp, 'top', {
      marginMm: 2, includeLabels: true, includeDialTicks: true, includeBoardOutline: true,
    });
    for (const g of groups(svg)) expect(op(g), g).toBeDefined();
    expect(groupOp(svg, 'layer-cut')).toBe('cut');
    expect(groupOp(svg, 'layer-engrave')).toBe('etch');
    expect(svg).toMatch(/data-operation="ghost" data-feature="board-outline"/);
  });

  it('unfold: folds are etched, sheet bounds are guides, outlines and holes are cut', () => {
    const scene = {
      nodes: [{ id: 'b', name: 'Box', pos: [0, 0, 0.05], geoms: [{ type: 'box', size: [0.025, 0.02, 0.015] }], joints: [], children: [] }],
    } as unknown as SceneGraph;
    const { svg } = exportSheetUnfold(scene, { mode: 'papercraft', includeSheetOutline: true });
    for (const g of groups(svg)) expect(op(g), g).toBeDefined();
    expect(groupOp(svg, 'layer-cut')).toBe('cut');
    expect(groupOp(svg, 'layer-mountain-folds') ?? groupOp(svg, 'layer-valley-folds')).toBe('etch');
    expect(groupOp(svg, 'layer-sheet-bounds')).toBe('ghost');
  });

  it('laser cut: cuts, engraving, and the sheet rectangles', () => {
    const r = exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, jointMode: 'finger' });
    expect(r.success).toBe(true);
    for (const g of groups(r.svg!)) expect(op(g), g).toBeDefined();
    expect(groupOp(r.svg!, 'cut-paths')).toBe('cut');
    for (const rect of r.svg!.match(/<rect\b[^>]*stroke-dasharray[^>]*>/g) ?? []) expect(op(rect)).toBe('ghost');
  });
});
