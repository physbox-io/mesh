import { describe, it, expect } from 'vitest';
import { withUniqueNames, uniquifyNamesInPlace } from '../src/utils/uniqueNames';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const body = (id: string, name: string, geomName: string, children: SceneNode[] = []): SceneNode =>
  ({ id, name, type: 'body', pos: [0, 0, 0.1], joints: [], children, geoms: [{ name: geomName, type: 'box', size: [0.01, 0.01, 0.01], rgba: [1, 1, 1, 1] }] }) as unknown as SceneNode;

const names = (nodes: SceneNode[]): string[] =>
  nodes.flatMap((n) => [n.name, ...(n.geoms || []).map((g) => g.name), ...names(n.children || [])]);

describe('withUniqueNames', () => {
  it('returns the very same scene when nothing clashes', () => {
    const scene = { nodes: [body('a', 'a', 'a_g'), body('b', 'b', 'b_g')] } as SceneGraph;
    expect(withUniqueNames(scene)).toBe(scene);
  });

  it('keeps the first of a clashing name and numbers the later ones', () => {
    const scene = { nodes: [body('a', 'arm', 'part'), body('b', 'arm', 'part', [body('c', 'arm', 'part')])] } as SceneGraph;
    const out = withUniqueNames(scene);
    expect(names(out.nodes)).toEqual(['arm', 'part', 'arm_2', 'part_2', 'arm_3', 'part_3']);
  });

  it('skips a suffix that is already a name somewhere', () => {
    const scene = { nodes: [body('a', 'a', 'part'), body('b', 'b', 'part'), body('c', 'c', 'part_2')] } as SceneGraph;
    expect(names(withUniqueNames(scene).nodes)).toEqual(['a', 'part', 'b', 'part_3', 'c', 'part_2']);
  });

  it('writes nothing into the scene it was given, and shares what it did not rename', () => {
    const first = body('a', 'a', 'part');
    const scene = { nodes: [first, body('b', 'b', 'part')] } as SceneGraph;
    const before = JSON.stringify(scene);
    const out = withUniqueNames(scene);
    expect(JSON.stringify(scene)).toBe(before);
    expect(out.nodes[0]).toBe(first);
    expect(out.nodes[1]).not.toBe(scene.nodes[1]);
  });

  it('gives the same names as the in-place pass', () => {
    const make = () => [body('a', 'x', 'g'), body('b', 'x', 'g', [body('c', 'y', 'g')])];
    const inPlace = make();
    uniquifyNamesInPlace(inPlace);
    expect(names(inPlace)).toEqual(names(withUniqueNames({ nodes: make() } as SceneGraph).nodes));
  });
});

describe('compileToMJCF names', () => {
  it('names clashing geoms and bodies exactly as the store will keep them', () => {
    const nodes = [body('a', 'arm', 'part'), body('b', 'arm', 'part')];
    const xml = compileToMJCF({ nodes } as SceneGraph, -9.81, 1, 0, 0, 0, 0);
    const kept = withUniqueNames({ nodes } as SceneGraph);
    for (const n of kept.nodes) {
      expect(xml).toContain(`<body name="${n.name}"`);
      expect(xml).toContain(`<geom name="${n.geoms[0].name}"`);
    }
    // And twice over it is the same model, not two different random ones.
    expect(compileToMJCF({ nodes } as SceneGraph, -9.81, 1, 0, 0, 0, 0)).toBe(xml);
  });
});
