import { describe, it, expect } from 'vitest';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS } from '../src/utils/moldExporter';
import { stlToMesh } from '../src/utils/stlMesh';
import { simulatedBody } from '../src/utils/simulatedPart';
import { simulateCastFromMoldNode } from '../src/utils/moldCastSimulation';
import type { SceneGraph, SceneNode } from '../src/types/scene';

// A 30 mm square tube, 20 mm tall: its open mold has a core standing in the
// middle of the cavity, which is what a flat repair cap spoilt. Z-up metres.
function squareTube(): { v: number[]; f: number[] } {
  const v: number[] = [];
  const f: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    const i = v.length / 3;
    v.push(...a, ...b, ...c, ...d);
    f.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const o = 0.015, n = 0.011, z0 = 0, z1 = 0.02;
  // Outer walls facing out, inner walls facing the bore, rings top and bottom.
  const sides: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (const [dx, dy] of sides) {
    const corner = (r: number, s: number) => [dx * r - dy * r * s, dy * r + dx * r * s];
    const [ax, ay] = corner(o, -1), [bx, by] = corner(o, 1);
    quad([ax, ay, z0], [bx, by, z0], [bx, by, z1], [ax, ay, z1]);
    const [cx, cy] = corner(n, -1), [ex, ey] = corner(n, 1);
    quad([cx, cy, z0], [cx, cy, z1], [ex, ey, z1], [ex, ey, z0]);
    quad([ax, ay, z1], [bx, by, z1], [ex, ey, z1], [cx, cy, z1]);
    quad([ax, ay, z0], [cx, cy, z0], [ex, ey, z0], [bx, by, z0]);
  }
  return { v, f };
}

function moldNode(dropTriangles = 0): SceneNode {
  const t = squareTube();
  const scene = {
    nodes: [{ id: 'tube', name: 'tube', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{ name: 'tube_mesh', type: 'mesh', size: [1], renderVertices: t.v, renderFaces: t.f, faces: t.f }] }],
  } as unknown as SceneGraph;
  const res = generateMoldMeshes(scene, { ...DEFAULT_MOLD_OPTIONS, moldType: 'open' });
  expect(res.success).toBe(true);
  const mesh = stlToMesh(res.binarySTL);
  // Knock triangles out of the middle of the list: a hole in the mold's surface.
  const mid = Math.floor(mesh.faces.length / 6) * 3;
  const faces = new Uint32Array([...mesh.faces.slice(0, mid), ...mesh.faces.slice(mid + dropTriangles * 3)]);
  return simulatedBody(
    { positions: mesh.positions, faces, cellMm: 0, toleranceMm: 0 },
    { workOriginMm: [0, 0, 0], modelOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [0, 0, 0], modelMaxMm: [0, 0, 0] },
    { id: 'mold', name: 'Simulated: Mold', kind: 'mold', placement: 'beside' },
  );
}

describe('casting from a mold that is not a closed solid', () => {
  it('casts the tube from the mold as made', async () => {
    const cast = await simulateCastFromMoldNode(moldNode(), { pour: { direction: 'auto' } });
    expect(cast.success).toBe(true);
    expect(cast.sizeMm.height).toBeCloseTo(20, 0);
  });

  it('refuses rather than repairing the mold into another shape', async () => {
    for (const pour of [{ direction: 'auto' as const }, undefined]) {
      const cast = await simulateCastFromMoldNode(moldNode(4), pour ? { pour } : {});
      expect(cast.success).toBe(false);
      expect(cast.error).toMatch(/^Simulated: Mold is not a closed solid: \d+ of its edges are open/);
      expect(cast.mesh.faces.length).toBe(0);
    }
  });
});
