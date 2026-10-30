import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ENVIRONMENT,
  environmentOf,
  takeEnvironment,
  withEnvironment,
} from '../src/store/sceneEnvironment';
import { decodeShareFragment, encodeShareFragment, withoutConvexPieces, type SharedScene } from '../src/utils/shareLink';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const moon = { ...DEFAULT_ENVIRONMENT, gravityZ: -1.62, windX: 2, floorBounce: 0.4 };

describe('scene environment', () => {
  it('is written onto the graph and taken back off on load', () => {
    const saved = withEnvironment({ nodes: [] } as SceneGraph, { ...moon, unrelated: 1 } as typeof moon);
    expect(saved.environment).toEqual(moon);
    const { graph, environment } = takeEnvironment(JSON.parse(JSON.stringify(saved)) as SceneGraph);
    expect(environment).toEqual(moon);
    expect('environment' in graph).toBe(false);
  });

  it('leaves a graph that never had one alone, so an edit keeps the current environment', () => {
    const graph = { nodes: [] } as SceneGraph;
    expect(takeEnvironment(graph)).toEqual({ graph, environment: null });
  });

  it('fills what an older or hand-written scene leaves out with the defaults, and ignores junk', () => {
    expect(environmentOf({ gravityZ: -3, windX: Number.NaN, density: 'x' as unknown as number }))
      .toEqual({ ...DEFAULT_ENVIRONMENT, gravityZ: -3 });
    expect(environmentOf(undefined)).toEqual(DEFAULT_ENVIRONMENT);
  });
});

/** A hollow body as decomposition leaves it: the mesh, and its convex pieces. */
function cup(pieces: number): SceneNode {
  const piece = (i: number) => ({
    name: `cup_col${i}`, type: 'mesh', size: [1, 1, 1], csgDerived: 'collider', colliderOf: 'shell',
    vertices: Array.from({ length: 300 }, (_, k) => Math.sin(i * 31 + k) * 0.02),
    faces: Array.from({ length: 300 }, (_, k) => k % 100),
  });
  return {
    id: 'cup', name: 'cup', pos: [0, 0, 0.05], collisionDecomposed: true, collisionHash: 'h',
    geoms: [
      { name: 'shell', type: 'mesh', size: [1, 1, 1], vertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], faces: [0, 1, 2] },
      ...Array.from({ length: pieces }, (_, i) => piece(i)),
    ],
    children: [],
  } as unknown as SceneNode;
}

describe('share link', () => {
  it('carries the fidelity, the reference pictures and the environment', async () => {
    const scene: SharedScene = {
      name: 'Pins',
      nodes: [{ name: 'a', geoms: [{ name: 'g', type: 'box', size: [0.01, 0.01, 0.01] }] } as unknown as SceneNode],
      simFidelity: 'print',
      referenceImages: [{ id: 'r1', name: 'photo', src: 'data:image/png;base64,AAAA' } as never],
      environment: moon,
    };
    const back = await decodeShareFragment(await encodeShareFragment(scene));
    expect(back?.simFidelity).toBe('print');
    expect(back?.referenceImages?.[0]).toMatchObject({ id: 'r1' });
    expect(back?.environment).toEqual(moon);
  });

  it('leaves the convex pieces out, which the other end works out again', async () => {
    const back = await decodeShareFragment(await encodeShareFragment({ name: 'Cup', nodes: [cup(12)] }));
    const geoms = back!.nodes[0].geoms!;
    expect(geoms.map((g) => g.name)).toEqual(['shell']);
    // Still marked decomposed, with no pieces: collidersAreStale says to decompose again.
    expect(back!.nodes[0].collisionDecomposed).toBe(true);
  });

  it("keeps a boolean body's pieces, which only its compile makes", () => {
    const node = { ...cup(2), csgEnabled: true } as SceneNode;
    expect(withoutConvexPieces([node])[0].geoms).toHaveLength(3);
  });
});
