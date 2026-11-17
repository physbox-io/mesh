import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { csgSourcePaint } from '../src/utils/csgSourceColors';
import { subdivideMeshForPaint } from '../src/utils/vertexPaint';
import type { SceneGeom } from '../src/types/scene';

// A 40 x 40 x 10 mm slab, an 8 mm tan base under a 2 mm white coat, as the one
// mesh a boolean of the two makes; `inset` rounds nothing but moves the top
// face down into the coat, as a rounding's faces lie inside it.
const slab = (top = 0.005): { zup: number[]; faces: number[] } => {
  const g = new THREE.BoxGeometry(0.04, 0.04, 0.005 + top).toNonIndexed();
  g.translate(0, 0, (top - 0.005) / 2);
  const p = g.getAttribute('position').array as Float32Array;
  return { zup: Array.from(p), faces: Array.from({ length: p.length / 3 }, (_, i) => i) };
};
const tan = [0.82, 0.7, 0.55, 1];
const white = [1, 1, 1, 1];
const base = { name: 'base', type: 'box', size: [0.02, 0.02, 0.004], pos: [0, 0, -0.001], rgba: tan } as SceneGeom;
const coat = { name: 'coat', type: 'box', size: [0.02, 0.02, 0.001], pos: [0, 0, 0.004], rgba: white } as SceneGeom;

const split = (top: number) => {
  const { zup, faces } = slab(top);
  const layer = csgSourcePaint([base, coat], zup, faces, tan);
  expect(layer).toBeDefined();
  const sub = subdivideMeshForPaint(zup, faces, layer!.res);
  const painted = new Set(layer!.idx);
  let topBare = 0, bottomPainted = 0;
  for (let v = 0; v < sub.positions.length / 3; v++) {
    const z = sub.positions[v * 3 + 2];
    if (z > top - 1e-6 && !painted.has(v)) topBare++;
    if (z < 0.0029 && painted.has(v)) bottomPainted++;
  }
  return { topBare, bottomPainted, layer: layer! };
};

describe('csgSourcePaint', () => {
  it('paints the coat white and leaves the base bare', () => {
    const { topBare, bottomPainted, layer } = split(0.005);
    expect(topBare).toBe(0);
    expect(bottomPainted).toBe(0);
    for (let i = 0; i < layer.rgba.length; i += 4) expect(layer.rgba.slice(i, i + 4)).toEqual([255, 255, 255, 255]);
  });

  it('paints a face cut into the coat in the coat colour', () => {
    const { topBare, bottomPainted } = split(0.0045);
    expect(topBare).toBe(0);
    expect(bottomPainted).toBe(0);
  });

  it('adds nothing when every geom is one colour', () => {
    const { zup, faces } = slab();
    expect(csgSourcePaint([base, { ...coat, rgba: tan }], zup, faces, tan)).toBeUndefined();
  });
});
