import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { simplifyGeomMesh, toRenderVertices } from '../src/utils/simplifyMesh';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS } from '../src/utils/moldExporter';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph } from '../src/types/scene';

/** A triangle soup (no index), the way an imported STL arrives. */
function soup(detail: number): number[] {
  return Array.from(new THREE.IcosahedronGeometry(1, detail).attributes.position.array);
}

function uniqueVertexCount(flat: number[]): number {
  const keys = new Set<string>();
  for (let i = 0; i < flat.length; i += 3) keys.add(`${flat[i].toFixed(5)},${flat[i + 1].toFixed(5)},${flat[i + 2].toFixed(5)}`);
  return keys.size;
}

describe('simplifyGeomMesh', () => {
  it('welds a triangle soup and removes about the requested share of vertices', async () => {
    const vertices = soup(3);
    const before = uniqueVertexCount(vertices);
    const out = await simplifyGeomMesh({ vertices }, 0.5);
    const after = out.vertices.length / 3;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(4);
    expect(Math.abs(after - Math.floor(before * 0.5))).toBeLessThanOrEqual(2);
  });

  it('returns faces that index into the vertices it returns', async () => {
    const out = await simplifyGeomMesh({ vertices: soup(2) }, 0.4);
    expect(out.faces.length % 3).toBe(0);
    const n = out.vertices.length / 3;
    for (const f of out.faces) {
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(n);
    }
  });

  it('accepts an indexed mesh', async () => {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const positions = Array.from(geo.attributes.position.array);
    const faces = Array.from({ length: positions.length / 3 }, (_, i) => i);
    const out = await simplifyGeomMesh({ vertices: positions, faces }, 0.5);
    expect(out.vertices.length / 3).toBeLessThan(uniqueVertexCount(positions));
  });

  it('gives a dynamic mesh renderVertices in the Z-up frame as (x, -z, y)', async () => {
    const out = await simplifyGeomMesh({ vertices: soup(2), dynamic: true }, 0.5);
    const rv = out.renderVertices!;
    expect(rv).toHaveLength(out.vertices.length);
    for (let i = 0; i < rv.length; i += 3) {
      const [x, y, z] = out.vertices.slice(i, i + 3);
      expect(rv[i]).toBeCloseTo(x, 5);
      expect(rv[i + 1]).toBeCloseTo(-z, 5);
      expect(rv[i + 2]).toBeCloseTo(y, 5);
    }
  });

  it('leaves renderVertices off a static mesh', async () => {
    expect((await simplifyGeomMesh({ vertices: soup(2) }, 0.5)).renderVertices).toBeUndefined();
  });

  it('refuses a mesh with fewer than three vertices', async () => {
    await expect(simplifyGeomMesh({ vertices: [0, 0, 0, 1, 0, 0] }, 0.5)).rejects.toThrow(/Not enough vertices/);
  });

  it('refuses when there is nothing left to remove', async () => {
    // A tetrahedron has 4 vertices, and the floor is 4.
    const tet = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0];
    await expect(simplifyGeomMesh({ vertices: tet }, 0.1)).rejects.toThrow(/Already at or below/);
  });


  it('keeps a closed mold closed at a tenth of its vertices', async () => {
    // A 20 mm round tube's open mold: three's SimplifyModifier opened this kind
    // of mesh at 10%, and a cast poured into it came back with a floor.
    const n = 64, ro = 0.01, ri = 0.008, h = 0.02;
    const v: number[] = [];
    const f: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      v.push(ro * c, ro * s, 0, ro * c, ro * s, h, ri * c, ri * s, 0, ri * c, ri * s, h);
    }
    for (let i = 0; i < n; i++) {
      const A = i * 4, B = ((i + 1) % n) * 4;
      f.push(A, B, B + 1, A, B + 1, A + 1, A + 2, A + 3, B + 3, A + 2, B + 3, B + 2);
      f.push(A + 1, B + 1, B + 3, A + 1, B + 3, A + 3, A, A + 2, B + 2, A, B + 2, B);
    }
    const scene = {
      nodes: [{ id: 't', name: 't', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [{ name: 'g', type: 'mesh', size: [1], renderVertices: v, renderFaces: f, faces: f }] }],
    } as unknown as SceneGraph;
    const mold = stlToMesh(generateMoldMeshes(scene, { ...DEFAULT_MOLD_OPTIONS, moldType: 'open' }).binarySTL);
    const before = analyzeMesh(mold.positions, mold.faces)!;
    expect(before.closed).toBe(true);
    const out = await simplifyGeomMesh({ vertices: Array.from(mold.positions), faces: Array.from(mold.faces) }, 0.1);
    expect(out.vertices.length / 3).toBeLessThan((mold.positions.length / 3) * 0.12);
    const after = analyzeMesh(out.vertices, out.faces)!;
    expect(after.closed).toBe(true);
    expect(after.consistentlyWound).toBe(true);
    expect(after.volume).toBeCloseTo(before.volume, 0);
  });
});

describe('toRenderVertices', () => {
  it('maps Y-up (x, y, z) to Z-up (x, -z, y)', () => {
    expect(toRenderVertices([1, 2, 3, -0.1234567, 0, 5])).toEqual([1, -3, 2, -0.12346, -5, 0]);
  });
});
