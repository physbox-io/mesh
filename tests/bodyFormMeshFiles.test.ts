// A dress form's meshes go into the physics worker's file cache on its first
// build: they are made from its measurements and replaced, never edited, so
// they need not prove themselves stable first (sent inline, a form was 4.5 MB
// of XML text for the worker to parse).

import { describe, it, expect } from 'vitest';
import { bodyFormNode } from '../src/utils/cloth/clothNodes';
import { compileToMJCF } from '../src/utils/mjcf';
import { MeshFileLedger } from '../src/utils/meshVfs';
import type { SceneGraph } from '../src/types/scene';

describe('dress form mesh files', () => {
  it('are files on the first build', () => {
    const graph = { nodes: [bodyFormNode('form', 'form')] } as SceneGraph;
    const ledger = new MeshFileLedger();
    ledger.begin();
    const xml = compileToMJCF(graph, -9.81, 0.5, 0, 0, 1.225, 0, { meshFiles: ledger });
    const { add } = ledger.take();
    expect(add.length).toBeGreaterThan(0);
    expect(xml).not.toMatch(/<mesh [^>]*vertex="/);
    expect(xml.length).toBeLessThan(200_000);
  });
});
