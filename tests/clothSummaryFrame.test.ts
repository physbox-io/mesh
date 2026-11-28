import { describe, expect, it } from 'vitest';
import { clothNodeSummary } from '../src/utils/cloth/clothSummary';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';

describe('a garment summary built from the graph is in the frame it is worn in', () => {
  it('a garment left at the origin is boxed where its form stands', () => {
    const form = bodyFormNode('form', 'form', {}, [1, 0.5, 0]);
    const g = { ...garmentNode('g', 'dress', { garment: 'dress' }, form), pos: [0, 0, 0] };
    const s = clothNodeSummary(g, { scene: [form, g] })!;
    const box = s.bboxMm!;
    expect((box.min[0] + box.max[0]) / 2).toBeGreaterThan(900);
    expect((box.min[1] + box.max[1]) / 2).toBeGreaterThan(400);
  }, 240000);

  it('a cloth under a moved parent is boxed under it', () => {
    const sheetNode = { id: 's', name: 'sheet', pos: [0, 0, 0], geoms: [], joints: [], children: [], cloth: { spacing: 0.05, pieces: [{ name: 'p', edges: [
      { id: 'b', pts: [[-0.2, -0.2], [0.2, -0.2]] }, { id: 'r', pts: [[0.2, -0.2], [0.2, 0.2]] }, { id: 't', pts: [[0.2, 0.2], [-0.2, 0.2]] }, { id: 'l', pts: [[-0.2, 0.2], [-0.2, -0.2]] },
    ] }] } };
    const parent = { id: 'p', name: 'parent', pos: [2, 0, 0], euler: [0, 0, 0], geoms: [], joints: [], children: [sheetNode] };
    const s = clothNodeSummary(sheetNode as never, { scene: [parent as never] });
    expect((s!.bboxMm!.min[0] + s!.bboxMm!.max[0]) / 2).toBeGreaterThan(1500);
  }, 240000);
});
