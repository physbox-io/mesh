import { describe, it, expect } from 'vitest';
import { creasedGeometry } from '../src/utils/creasedNormals';

const normalAt = (g: ReturnType<typeof creasedGeometry>, v: number) =>
  [g.normals[3 * v], g.normals[3 * v + 1], g.normals[3 * v + 2]];

/** Outward-wound unit cube, 8 welded corners. */
function cube() {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const faces = [
    0, 2, 1, 0, 3, 2, // z=0
    4, 5, 6, 4, 6, 7, // z=1
    0, 1, 5, 0, 5, 4, // y=0
    3, 7, 6, 3, 6, 2, // y=1
    0, 4, 7, 0, 7, 3, // x=0
    1, 2, 6, 1, 6, 5, // x=1
  ];
  return { positions, faces };
}

function faceNormal(p: number[], a: number, b: number, c: number) {
  const u = [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1], p[3 * b + 2] - p[3 * a + 2]];
  const v = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return n.map((x) => x / l);
}

describe('creasedGeometry', () => {
  it('gives a cube three normals per corner, each its face normal', () => {
    const { positions, faces } = cube();
    const g = creasedGeometry(positions, faces);
    expect(g.positions.length / 3).toBe(24);
    expect(g.index.length).toBe(faces.length);
    for (let f = 0; f < faces.length; f += 3) {
      const n = faceNormal(positions, faces[f], faces[f + 1], faces[f + 2]);
      for (let k = 0; k < 3; k++) {
        const out = g.index[f + k];
        normalAt(g, out).forEach((x, i) => expect(x).toBeCloseTo(n[i], 9));
        // Same point as the source corner, so triangle order and shape are kept.
        for (let i = 0; i < 3; i++) expect(g.positions[3 * out + i]).toBeCloseTo(positions[3 * faces[f + k] + i], 6);
      }
    }
  });

  it('keeps a flat face flat when slivers fan from a corner next to a wall', () => {
    // A 1×1 floor at z=0 fanned from (0,0) to points along its far edges, with a
    // wall standing up along x=0 sharing the corner. computeVertexNormals would
    // lean the floor's normals toward the wall across the whole fan.
    const positions: number[] = [0, 0, 0];
    const rim: number[] = [];
    const N = 12;
    for (let i = 0; i <= N; i++) { positions.push(1, i / N, 0); rim.push(positions.length / 3 - 1); }
    for (let i = N - 1; i >= 0; i--) { positions.push(i / N, 1, 0); rim.push(positions.length / 3 - 1); }
    const faces: number[] = [];
    for (let i = 0; i + 1 < rim.length; i++) faces.push(0, rim[i], rim[i + 1]);
    // Wall on x=0 from y=0..1 up to z=1, sharing vertex 0 and the (0,1,0) rim point.
    const top0 = positions.length / 3; positions.push(0, 0, 1);
    const top1 = positions.length / 3; positions.push(0, 1, 1);
    const corner01 = rim[rim.length - 1];
    faces.push(0, top1, top0, 0, corner01, top1);
    const g = creasedGeometry(positions, faces);
    const floorTris = rim.length - 1;
    for (let c = 0; c < floorTris * 3; c++) {
      const n = normalAt(g, g.index[c]);
      expect(n[0]).toBeCloseTo(0, 9);
      expect(n[1]).toBeCloseTo(0, 9);
      expect(n[2]).toBeCloseTo(1, 9);
    }
  });

  it('keeps a cylinder wall smooth and its normals radial', () => {
    const S = 64;
    const positions: number[] = [];
    for (let i = 0; i < S; i++) {
      const a = (2 * Math.PI * i) / S;
      positions.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1);
    }
    const faces: number[] = [];
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      faces.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1);
    }
    const g = creasedGeometry(positions, faces);
    expect(g.positions.length / 3).toBe(2 * S);
    for (let v = 0; v < g.positions.length / 3; v++) {
      const n = normalAt(g, v);
      expect(n[0]).toBeCloseTo(g.positions[3 * v], 5);
      expect(n[1]).toBeCloseTo(g.positions[3 * v + 1], 5);
      expect(n[2]).toBeCloseTo(0, 9);
    }
  });

  it('survives a zero-area triangle', () => {
    const { positions, faces } = cube();
    const g = creasedGeometry(positions, [...faces, 0, 1, 1]);
    expect(g.index.length).toBe(faces.length + 3);
    for (const x of g.normals) expect(Number.isFinite(x)).toBe(true);
  });
});
