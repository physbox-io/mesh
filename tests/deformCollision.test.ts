// Making damage real to the solver, rather than only visible.
//
// The whole feature turns on one fact that is easy to get wrong: MuJoCo
// collides a mesh as its CONVEX HULL, and every kind of damage here — a crater,
// a worn edge, a hole — is a concavity. Committing the deformed vertices and
// leaving the collision mode alone produces a body that looks worn and collides
// exactly as it did when new, which is the appearance of the feature with none
// of it. So the surface has to be decomposed, and that is the cost.

import { describe, it, expect } from 'vitest';
import { applyShatterPieces, type DeformedGeometry } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import { collisionModeOf } from '../src/utils/csg';
import { boxMeshForDenting } from '../src/utils/dentMesh';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const plate = (): SceneNode => ({
  id: 'table', name: 'table', type: 'body', pos: [0, 0, 0.5],
  joints: [{ name: 'table_free', type: 'free' }],
  geoms: [{
    name: 'top', type: 'mesh', size: [1], dynamic: true,
    vertices: [0, 0, 0], renderVertices: [0, 0, 0], faces: [0, 0, 0],
    mass: 5, dentYieldNs: 4, deformCollision: true,
  }],
  children: [],
});

const scene = (): SceneGraph => ({ nodes: [plate()] });

const worn = (): DeformedGeometry => {
  const { vertices, faces } = boxMeshForDenting(0.3, 0.02, 0.2);
  return { vertices, renderVertices: vertices, faces };
};

describe('applyShatterPieces with deformed geometry', () => {
  it('leaves the document alone when nothing has been damaged', () => {
    const doc = scene();
    expect(applyShatterPieces(doc, {}, {})).toBe(doc);
  });

  it('swaps the worn surface in without touching what was authored', () => {
    const doc = scene();
    const out = applyShatterPieces(doc, {}, { 'table/top': worn() });

    expect(out).not.toBe(doc);
    expect(out.nodes[0].geoms[0].faces!.length).toBeGreaterThan(3);
    // The document still holds the table as it was made.
    expect(doc.nodes[0].geoms[0].faces).toEqual([0, 0, 0]);
  });

  it('decomposes the damaged body, or the hull fills every crater back in', () => {
    const out = applyShatterPieces(scene(), {}, { 'table/top': worn() });
    expect(out.nodes[0].collision).toBe('decompose');
    expect(collisionModeOf(out.nodes[0])).toBe('decompose');
    // ...and the authored body is untouched, so it is still whatever it was.
    expect(scene().nodes[0].collision).toBeUndefined();
  });

  it('leaves bodies nobody has damaged exactly as they were', () => {
    const doc: SceneGraph = { nodes: [plate(), { ...plate(), id: 'other', name: 'other' }] };
    const out = applyShatterPieces(doc, {}, { 'table/top': worn() });
    expect(out.nodes[1]).toBe(doc.nodes[1]);
    expect(out.nodes[1].collision).toBeUndefined();
  });

  it('reaches deep into the tree, so a worn shelf inside a cabinet still counts', () => {
    const inner = plate();
    const doc: SceneGraph = {
      nodes: [{
        id: 'cabinet', name: 'cabinet', type: 'body', pos: [0, 0, 0],
        geoms: [], joints: [], children: [inner],
      }],
    };
    const out = applyShatterPieces(doc, {}, { 'table/top': worn() });
    expect(out.nodes[0].children[0].collision).toBe('decompose');
    expect(out.nodes[0].children[0].geoms[0].faces!.length).toBeGreaterThan(3);
  });

  it('compiles to a model MuJoCo will take', () => {
    const out = applyShatterPieces(scene(), {}, { 'table/top': worn() });
    const xml = compileToMJCF(out, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toContain('<body name="table"');
    expect(xml).toContain('mesh');
  });
});
