// Hollowing a body: what the I gesture actually installs.
import { describe, it, expect } from 'vitest';
import { insetNegatives } from '../src/utils/scaleNode';
import { csgProgram } from '../src/utils/csg';
import type { SceneNode } from '../src/types/scene';

const cylinder = (): SceneNode => ({
  id: 'pipe', name: 'pipe', type: 'body', pos: [0, 0, 0], children: [], joints: [],
  geoms: [{ name: 'pipe_geom', type: 'cylinder', size: [0.1, 0.3], mass: 2 }],
} as unknown as SceneNode);

describe('inset negatives', () => {
  it('bores through rather than sealing a cavity', () => {
    // The default gesture: in on X and Y, past the ends on Z. A copy shrunk on
    // all three axes is a hollow nobody can see from outside — which is what
    // this replaced.
    const [hole] = insetNegatives(cylinder(), [0.8, 0.8, 1.05]);
    expect(hole.csg).toBe('difference');
    expect(hole.size![0]).toBeCloseTo(0.08, 6);   // radius came in
    expect(hole.size![1]).toBeCloseTo(0.315, 6);  // length went past the ends
  });

  it('asks a cylinder in its own terms', () => {
    // [radius, half-length]: the lateral factors are the radius and Z is the
    // length. Averaging them is what made "longer" come out as "fatter".
    const [hole] = insetNegatives(cylinder(), [0.5, 0.5, 1]);
    expect(hole.size).toEqual([0.05, 0.3]);
  });

  it('weighs nothing and is named for what it is', () => {
    const [hole] = insetNegatives(cylinder(), [0.8, 0.8, 1.05]);
    expect((hole as { mass?: number }).mass).toBeUndefined();
    expect(hole.name).toBe('pipe_geom_inset');
  });

  it('refuses a copy that would not cut anything', () => {
    expect(insetNegatives(cylinder(), [1, 1, 1])).toEqual([]);
    expect(insetNegatives(cylinder(), [1, 1, 1.05])).toEqual([]);
    expect(insetNegatives(cylinder(), [0, 0.5, 0.5])).toEqual([]);
  });

  it('never copies a hole, or the mesh a boolean already produced', () => {
    const node = cylinder();
    node.geoms = [
      ...node.geoms,
      { name: 'old_hole', type: 'cylinder', size: [0.05, 0.4], csg: 'difference' },
      { name: 'derived', type: 'mesh', size: [1], csgDerived: 'visual' },
    ] as never;
    const copies = insetNegatives(node, [0.8, 0.8, 1.05]);
    expect(copies.map((g) => g.name)).toEqual(['pipe_geom_inset']);
  });

  it('produces a boolean program that actually differences', () => {
    const node = cylinder();
    node.geoms = [...node.geoms, ...insetNegatives(node, [0.8, 0.8, 1.05])] as never;
    node.csgEnabled = true;
    const program = csgProgram(node)!;
    expect(program).toContain('difference()');
  });
});
