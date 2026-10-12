import { describe, it, expect } from 'vitest';
import { stlToMesh } from '../src/utils/stlMesh';
import { exportBinarySTL, generateMoldMeshes } from '../src/utils/moldExporter';
import { generateCastPattern } from '../src/utils/castPatternExporter';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import type { SceneGraph } from '../src/types/scene';

// Add to Scene for the outputs that are geometry already: the STL welded back
// into a mesh, which has to come out closed and outward for the single-sided
// renderer to draw it whole.

const integrityOf = (bytes: Uint8Array) => {
  const mesh = stlToMesh(bytes);
  return analyzeMesh(Array.from(mesh.positions), Array.from(mesh.faces))!;
};

describe('stlToMesh', () => {
  it('welds a box\'s corners into eight vertices', () => {
    const c = (x: number, y: number, z: number) => [x, y, z] as [number, number, number];
    const v = [c(0, 0, 0), c(1, 0, 0), c(1, 1, 0), c(0, 1, 0), c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1)];
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const tris = quads.flatMap(([a, b, cc, d]) => [
      { a: v[a], b: v[b], c: v[cc] }, { a: v[a], b: v[cc], c: v[d] },
    ]);
    const mesh = stlToMesh(exportBinarySTL(tris as never));
    expect(mesh.positions.length).toBe(24);
    const integrity = analyzeMesh(Array.from(mesh.positions), Array.from(mesh.faces))!;
    expect(integrity.closed).toBe(true);
    expect(integrity.volume).toBeCloseTo(1, 6);
  });

  it('brings a casting pattern in closed and the right way out', () => {
    const plain = generateCastPattern(latticeBracketPreset as SceneGraph, { metalId: 'aluminium', addGating: false });
    expect(plain.success).toBe(true);
    const integrity = integrityOf(plain.patternStl);
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    expect(integrity.volume).toBeGreaterThan(0);
    // The gating is printed as solids laid over the pattern, which the slicer
    // unions; welded, their shared corners make the whole non-manifold, but
    // every shell still faces out.
    const gated = generateCastPattern(latticeBracketPreset as SceneGraph, { metalId: 'aluminium', addGating: true });
    expect(integrityOf(gated.patternStl).volume).toBeGreaterThan(integrity.volume);
  });

  it('brings mold halves in the right way out', () => {
    const dome: SceneGraph = {
      nodes: [{
        id: 'd', name: 'dome', type: 'body', pos: [0, 0, 0],
        geoms: [{ name: 'g', type: 'sphere', size: [0.02] } as never], joints: [], children: [],
      }],
    };
    const res = generateMoldMeshes(dome);
    expect(res.success).toBe(true);
    const integrity = integrityOf(res.binarySTL);
    expect(integrity.consistentlyWound).toBe(true);
    expect(integrity.volume).toBeGreaterThan(0);
  });
});
