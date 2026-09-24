import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { simplifyGeomMesh } from '../src/utils/simplifyMesh';

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
  it('welds a triangle soup and removes about the requested share of vertices', () => {
    const vertices = soup(3);
    const before = uniqueVertexCount(vertices);
    const out = simplifyGeomMesh({ vertices }, 0.5);
    const after = out.vertices.length / 3;
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(4);
    expect(Math.abs(after - Math.floor(before * 0.5))).toBeLessThanOrEqual(2);
  });

  it('returns faces that index into the vertices it returns', () => {
    const out = simplifyGeomMesh({ vertices: soup(2) }, 0.4);
    expect(out.faces.length % 3).toBe(0);
    const n = out.vertices.length / 3;
    for (const f of out.faces) {
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(n);
    }
  });

  it('accepts an indexed mesh', () => {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const positions = Array.from(geo.attributes.position.array);
    const faces = Array.from({ length: positions.length / 3 }, (_, i) => i);
    const out = simplifyGeomMesh({ vertices: positions, faces }, 0.5);
    expect(out.vertices.length / 3).toBeLessThan(uniqueVertexCount(positions));
  });

  it('gives a dynamic mesh renderVertices in the Z-up frame as (x, -z, y)', () => {
    const out = simplifyGeomMesh({ vertices: soup(2), dynamic: true }, 0.5);
    const rv = out.renderVertices!;
    expect(rv).toHaveLength(out.vertices.length);
    for (let i = 0; i < rv.length; i += 3) {
      const [x, y, z] = out.vertices.slice(i, i + 3);
      expect(rv[i]).toBeCloseTo(x, 5);
      expect(rv[i + 1]).toBeCloseTo(-z, 5);
      expect(rv[i + 2]).toBeCloseTo(y, 5);
    }
  });

  it('leaves renderVertices off a static mesh', () => {
    expect(simplifyGeomMesh({ vertices: soup(2) }, 0.5).renderVertices).toBeUndefined();
  });

  it('refuses a mesh with fewer than three vertices', () => {
    expect(() => simplifyGeomMesh({ vertices: [0, 0, 0, 1, 0, 0] }, 0.5)).toThrow(/Not enough vertices/);
  });

  it('refuses when there is nothing left to remove', () => {
    // A tetrahedron has 4 vertices, and the floor is 4.
    const tet = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0];
    expect(() => simplifyGeomMesh({ vertices: tet }, 0.1)).toThrow(/Already at or below/);
  });
});
