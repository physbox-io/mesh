// Hollowing a body: what the I gesture actually installs.
import { describe, it, expect } from 'vitest';
import { insetNegatives, boreFactors } from '../src/utils/scaleNode';
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

  // A pocket: open on one face only, with a floor. What used to take a bore
  // and then a hand-shortened negative in the sidebar.
  const cube = (): SceneNode => ({
    id: 'cube', name: 'cube', type: 'body', pos: [0, 0, 0], children: [], joints: [],
    geoms: [{ name: 'cube_geom', type: 'box', size: [0.1, 0.1, 0.1] }],
  } as unknown as SceneNode);

  it('bores right through with the same overshoot at both ends', () => {
    expect(boreFactors(0.8, { axis: 0, open: 0 })).toEqual([1.05, 0.8, 0.8]);
  });

  it('pockets a cube from the face named, with a floor as thick as its walls', () => {
    const f = boreFactors(0.8, { axis: 0, open: 1 });
    const [hole] = insetNegatives(cube(), f, { axis: 0, side: 1 });
    const half = hole.size![0];
    const x = hole.pos![0];
    // Walls: 0.1 − 0.08 = 0.02. Floor on −X: the pocket's far end sits there.
    expect(hole.size![1]).toBeCloseTo(0.08, 9);
    expect(x - half).toBeCloseTo(-0.1 + 0.02, 9);
    // Open end: just past the +X face, by the overshoot.
    expect(x + half).toBeCloseTo(0.1 + 0.005, 9);
    // Nothing moved on the other axes.
    expect(hole.pos![1]).toBeCloseTo(0, 9);
    expect(hole.pos![2]).toBeCloseTo(0, 9);
  });

  it('opens on the − face when asked', () => {
    const f = boreFactors(0.8, { axis: 2, open: -1 });
    const [hole] = insetNegatives(cube(), f, { axis: 2, side: -1 });
    expect(hole.pos![2] - hole.size![2]).toBeCloseTo(-0.105, 9);
    expect(hole.pos![2] + hole.size![2]).toBeCloseTo(0.08, 9);
  });

  it('slides a mesh pocket in both of its vertex frames', () => {
    // A 0.2 cube as a dynamic mesh: renderVertices Z-up, vertices Y-up.
    const corners: number[] = [];
    for (const x of [-0.1, 0.1]) for (const y of [-0.1, 0.1]) for (const z of [-0.1, 0.1]) corners.push(x, y, z);
    const yUp: number[] = [];
    for (let i = 0; i < corners.length; i += 3) yUp.push(corners[i], corners[i + 2], -corners[i + 1]);
    const node = cube();
    node.geoms = [{ name: 'm', type: 'mesh', dynamic: true, renderVertices: corners, vertices: yUp, faces: [] }] as never;
    const f = boreFactors(0.8, { axis: 1, open: 1 });
    const [hole] = insetNegatives(node, f, { axis: 1, side: 1 });
    const ys = (hole.renderVertices as number[]).filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeCloseTo(0.105, 9);
    expect(Math.min(...ys)).toBeCloseTo(-0.08, 9);
    // Body Y is −Z in the Y-up copy.
    const zs = (hole.vertices as number[]).filter((_, i) => i % 3 === 2);
    expect(-Math.min(...zs)).toBeCloseTo(0.105, 9);
    expect(-Math.max(...zs)).toBeCloseTo(-0.08, 9);
  });
});
