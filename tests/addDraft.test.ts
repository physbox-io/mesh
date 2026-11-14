// Add Draft: the part tapered to pull straight up as it stands.
import { describe, it, expect } from 'vitest';
import { addDraftToBodies } from '../src/utils/castPrep';
import type { SceneGraph } from '../src/types/scene';

const boxScene = (): SceneGraph => ({
  nodes: [{
    id: 'b', name: 'block', type: 'body', pos: [0, 0, 0.02], joints: [], children: [],
    geoms: [{ name: 'g', type: 'box', size: [0.02, 0.02, 0.02], rgba: [1, 1, 1, 1] }],
  }],
} as unknown as SceneGraph);

/** Half-width in X of a body's mesh at its lowest and highest vertices, mm. */
function halfWidths(scene: SceneGraph) {
  const v = scene.nodes[0].geoms[0].renderVertices!;
  let zLo = Infinity, zHi = -Infinity;
  for (let i = 2; i < v.length; i += 3) { zLo = Math.min(zLo, v[i]); zHi = Math.max(zHi, v[i]); }
  let lo = 0, hi = 0;
  for (let i = 0; i < v.length; i += 3) {
    if (Math.abs(v[i + 2] - zLo) < 1e-9) lo = Math.max(lo, v[i]);
    if (Math.abs(v[i + 2] - zHi) < 1e-9) hi = Math.max(hi, v[i]);
  }
  return { base: lo * 1000, top: hi * 1000 };
}

describe('Add Draft', () => {
  it('keeping the top, grows the walls toward the base by the draft', () => {
    const scene = boxScene();
    const r = addDraftToBodies(scene, ['b'], 5, 'add');
    expect(r.drafted.map((d) => d.id)).toEqual(['b']);
    expect(r.partingZ).toBeCloseTo(0, 6);
    expect(scene.nodes[0].geoms[0].type).toBe('mesh');
    const w = halfWidths(scene);
    expect(w.top).toBeCloseTo(20, 3);
    expect(w.base).toBeCloseTo(20 + 40 * Math.tan((5 * Math.PI) / 180), 2);
  });

  it('keeping the base, narrows the walls toward the top', () => {
    const scene = boxScene();
    addDraftToBodies(scene, ['b'], 3, 'remove');
    const w = halfWidths(scene);
    expect(w.base).toBeCloseTo(20, 3);
    expect(w.top).toBeCloseTo(20 - 40 * Math.tan((3 * Math.PI) / 180), 2);
  });

  it('leaves bodies it was not given alone', () => {
    const scene = boxScene();
    const r = addDraftToBodies(scene, ['other'], 3, 'add');
    expect(r.drafted).toEqual([]);
    expect(scene.nodes[0].geoms[0].type).toBe('box');
  });
});
