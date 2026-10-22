import { describe, expect, it } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import { addFace, createLattice, toSceneGeom, vertexAt, boxLattice } from '../src/utils/latticeMesh';
import type { SceneGraph } from '../src/types/scene';

/** One free lattice body carrying the cage's mesh. */
const sceneOf = (lattice: ReturnType<typeof createLattice>): SceneGraph => {
  const g = toSceneGeom(lattice, 0);
  return {
    nodes: [{
      id: 'a', name: 'a', type: 'body', pos: [0, 0, 0], children: [],
      joints: [{ name: 'a_free', type: 'free' }],
      geoms: [{ name: 'a_mesh', type: 'mesh', size: [1], mass: 1, latticeGeom: true, vertices: g.vertices, faces: g.faces, renderVertices: g.renderVertices }],
    }],
  } as unknown as SceneGraph;
};

describe('meshes MuJoCo cannot hull', () => {
  it('an empty lattice compiles as a speck, with no mesh asset', () => {
    const xml = compileToMJCF(sceneOf(createLattice(0.0001)));
    expect(xml).not.toContain('<mesh ');
    expect(xml).toMatch(/name="a_mesh" type="sphere" size="0.001"[^>]*contype="0" conaffinity="0"/);
  });

  it('a single flat face compiles as a thin box lying in its plane', () => {
    const l = createLattice(0.0001);
    // A 40 x 20 mm rectangle on the XY plane, offset from the origin.
    addFace(l, [vertexAt(l, 0, 0, 0), vertexAt(l, 400, 0, 0), vertexAt(l, 400, 200, 0), vertexAt(l, 0, 200, 0)]);
    const xml = compileToMJCF(sceneOf(l));
    expect(xml).not.toContain('<mesh ');
    const box = xml.match(/name="a_mesh" type="box" size="([^"]+)" pos="([^"]+)"/);
    expect(box).not.toBeNull();
    const size = box![1].split(' ').map(Number).sort((a, b) => a - b);
    expect(size[0]).toBeCloseTo(0.0005, 6);
    expect(size[1]).toBeCloseTo(0.01, 6);
    expect(size[2]).toBeCloseTo(0.02, 6);
    // The mesh is recentred on its own middle, so the box sits at the origin.
    for (const c of box![2].split(' ').map(Number)) expect(Math.abs(c)).toBeLessThan(1e-9);
  });

  it('a mesh with volume is left alone', () => {
    const xml = compileToMJCF(sceneOf(boxLattice(0.0001, 200)));
    expect(xml).toContain('<mesh name="a_mesh"');
  });
});
