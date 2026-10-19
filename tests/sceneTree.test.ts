import { describe, it, expect } from 'vitest';
import { patchGeom, findNodeById, getNodeWorldPos } from '../src/utils/sceneTree';
import type { SceneNode } from '../src/types/scene';

const body = (id: string, children: SceneNode[] = []) =>
  ({ id, name: id, pos: [0, 0, 0], geoms: [{ name: 'part_mesh', type: 'mesh', vertices: [0, 0, 0], faces: [] }], children }) as unknown as SceneNode;

describe('patchGeom', () => {
  it('writes to the named body when another body has a geom of the same name', () => {
    // Two bodies whose meshes share a name, the second nested: a lookup by
    // name alone finds the first and edits the wrong body.
    const nodes = [body('a'), body('b', [body('c')])];
    expect(patchGeom(nodes, 'c', 'part_mesh', { vertices: [1, 2, 3] })).toBe(true);
    expect(findNodeById(nodes, 'c')!.geoms[0].vertices).toEqual([1, 2, 3]);
    expect(findNodeById(nodes, 'a')!.geoms[0].vertices).toEqual([0, 0, 0]);
    expect(findNodeById(nodes, 'b')!.geoms[0].vertices).toEqual([0, 0, 0]);
  });

  it('keeps the fields it was not given', () => {
    const nodes = [body('a')];
    patchGeom(nodes, 'a', 'part_mesh', { faces: [0, 0, 0] });
    expect(nodes[0].geoms[0]).toMatchObject({ name: 'part_mesh', type: 'mesh', vertices: [0, 0, 0], faces: [0, 0, 0] });
  });

  it('reports a missing body or geom rather than writing anywhere else', () => {
    const nodes = [body('a')];
    expect(patchGeom(nodes, 'nope', 'part_mesh', { faces: [] })).toBe(false);
    expect(patchGeom(nodes, 'a', 'nope', { faces: [] })).toBe(false);
  });
});

describe('getNodeWorldPos', () => {
  it('rotates child local offsets by parent euler and quat rotations', () => {
    const child: SceneNode = {
      id: 'child', name: 'child', type: 'body', pos: [1, 0, 0], geoms: [], children: [],
    };
    const parent: SceneNode = {
      id: 'parent', name: 'parent', type: 'body', pos: [2, 3, 4], euler: [0, 0, 90],
      geoms: [{ name: 'g', type: 'box', size: [0.1, 0.1, 0.1] }],
      children: [child],
    };
    const pos = getNodeWorldPos([parent], 'child')!;
    expect(pos[0]).toBeCloseTo(2, 6);
    expect(pos[1]).toBeCloseTo(4, 6);
    expect(pos[2]).toBeCloseTo(4, 6);
  });

  it('does not apply parent euler a second time when parent mesh vertices are already baked', () => {
    const child: SceneNode = {
      id: 'child', name: 'child', type: 'body', pos: [1, 0, 0], geoms: [], children: [],
    };
    const bakedParent = {
      id: 'parent', name: 'parent', type: 'body', pos: [2, 3, 4], euler: [0, 0, 90],
      geoms: [{ name: 'm', type: 'mesh', size: [1], vertices: [0, 0, 0], faces: [0, 0, 0], baseVertices: [0, 0, 0] }],
      children: [child],
    } as unknown as SceneNode;
    const pos = getNodeWorldPos([bakedParent], 'child')!;
    expect(pos[0]).toBeCloseTo(3, 6);
    expect(pos[1]).toBeCloseTo(3, 6);
    expect(pos[2]).toBeCloseTo(4, 6);
  });
});

