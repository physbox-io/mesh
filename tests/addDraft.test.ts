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

  it('preserves custom density when drafting a CSG body', () => {
    const verts = [
      -0.01, -0.01, -0.01, 0.01, -0.01, -0.01, 0.01, 0.01, -0.01, -0.01, 0.01, -0.01,
      -0.01, -0.01, 0.01, 0.01, -0.01, 0.01, 0.01, 0.01, 0.01, -0.01, 0.01, 0.01,
    ];
    const faces = [
      0, 2, 1, 0, 3, 2, // bottom
      4, 5, 6, 4, 6, 7, // top
      0, 1, 5, 0, 5, 4, // -y
      2, 3, 7, 2, 7, 6, // +y
      0, 4, 7, 0, 7, 3, // -x
      1, 2, 6, 1, 6, 5, // +x
    ];
    const scene = {
      nodes: [{
        id: 'bronze', name: 'bronze', type: 'body', pos: [0, 0, 0.01], joints: [], children: [], csgEnabled: true,
        geoms: [
          { name: 'src', type: 'box', size: [0.01, 0.01, 0.01], density: 8800, rgba: [0.8, 0.5, 0.2, 1] },
          { name: 'cut', type: 'cylinder', size: [0.003, 0.012], csg: 'difference' },
          { name: 'bronze_csg', type: 'mesh', size: [1], role: 'visual', mass: 0, csgDerived: 'visual', renderVertices: verts, vertices: [], faces },
        ],
      }],
    } as unknown as SceneGraph;
    const r = addDraftToBodies(scene, ['bronze'], 2, 'add');
    expect(r.drafted.map((d) => d.id)).toEqual(['bronze']);
    expect(scene.nodes[0].geoms).toHaveLength(1);
    expect(scene.nodes[0].geoms[0].mass).toBeUndefined();
    expect(scene.nodes[0].geoms[0].density).toBe(8800);
  });
});
