import { describe, expect, it } from 'vitest';
import { ClothCcd } from '../src/utils/cloth/clothCcd';
import { findCrossings, untangleMesh } from '../src/utils/cloth/clothUntangle';

const ident = (n: number) => Int32Array.from({ length: n }, (_, i) => i);

/** A flat square sheet, `k` x `k` cells, `size` across, at height z, offset by (ox, oy); its points from `base`. */
function sheet(k: number, size: number, z: number, base: number, ox = 0, oy = 0) {
  const pts: number[] = [], tris: number[] = [];
  for (let j = 0; j <= k; j++) for (let i = 0; i <= k; i++) pts.push(ox + (i / k - 0.5) * size, oy + (j / k - 0.5) * size, z);
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
    const a = base + j * (k + 1) + i, b = a + 1, c = a + k + 1, d = c + 1;
    tris.push(a, b, d, a, d, c);
  }
  return { pts, tris };
}

/**
 * The lone point `p` as cloth: on a little triangle of its own, 5 m off to -x,
 * moving as it does (only points on a triangle are cloth to clothCcd).
 */
function onCloth(x0: Float64Array, x1: Float64Array, tris: number[], p: number) {
  const n = x0.length / 3, a = Float64Array.from([...x0, 0, 0, 0, 0, 0, 0]), b = Float64Array.from([...x1, 0, 0, 0, 0, 0, 0]);
  for (const [q, off] of [[n, [-5, 0, 0]], [n + 1, [-5, 0.01, 0]]] as const) for (let c = 0; c < 3; c++) { a[3 * q + c] = x0[3 * p + c] + off[c]; b[3 * q + c] = x1[3 * p + c] + off[c]; }
  return { x0: a, x1: b, tris: Int32Array.from([...tris, p, n, n + 1]), n: n + 2 };
}

describe('continuous collision between cloth', () => {
  it('a point driven through a triangle in one step stays on its side', () => {
    const { x0, x1, tris, n } = onCloth(Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, 0.1), Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, -0.3), [0, 1, 2], 3);
    const ccd = new ClothCcd(n, tris, ident(n));
    const st = ccd.resolve(x0, x1, new Float64Array(n).fill(1));
    expect(st.met).toBeGreaterThan(0);
    // The point above the triangle's plane under it (barycentric 0.6, 0.2, 0.2), as it started.
    const zTri = 0.6 * x1[2] + 0.2 * x1[5] + 0.2 * x1[8];
    expect(x1[11]).toBeGreaterThan(zTri);
  });

  it('held cloth is not moved: the free side takes all of it', () => {
    const { x0, x1, tris, n } = onCloth(Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, 0.1), Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, -0.3), [0, 1, 2], 3);
    const ccd = new ClothCcd(n, tris, ident(n));
    ccd.resolve(x0, x1, Float64Array.of(0, 0, 0, 1, 1, 1));
    expect([x1[2], x1[5], x1[8]]).toEqual([0, 0, 0]);
    expect(x1[11]).toBeGreaterThan(0);
  });

  it('an edge driven across another edge is stopped', () => {
    // Two triangles whose edges cross as the second sweeps down through the first's edge, no point inside a triangle.
    const x0 = Float64Array.of(-1, 0, 0, 1, 0, 0, 0, -5, 0, /**/ 0, -1, 0.1, 0, 1, 0.1, 5, 0, 0.1);
    const x1 = Float64Array.from(x0);
    for (const i of [3, 4, 5]) x1[3 * i + 2] = -0.1;
    const ccd = new ClothCcd(6, Int32Array.of(0, 1, 2, 3, 4, 5), ident(6));
    ccd.resolve(x0, x1, Float64Array.of(1, 1, 1, 1, 1, 1));
    const mesh = untangleMesh(6, Int32Array.of(0, 1, 2, 3, 4, 5), []);
    expect(findCrossings(x1, mesh)).toEqual([]);
    expect(x1[3 * 3 + 2] + x1[3 * 4 + 2]).toBeGreaterThan(x1[2] + x1[5]);
  });

  it('a sheet thrown through another in one step does not end through it', () => {
    const A = sheet(10, 1, 0, 0), B = sheet(10, 0.8, 0.05, A.pts.length / 3, 0.03, 0.02);
    const n = (A.pts.length + B.pts.length) / 3, tris = Int32Array.from([...A.tris, ...B.tris]);
    const x0 = Float64Array.from([...A.pts, ...B.pts]), x1 = Float64Array.from(x0);
    // B down 20 cm and buckled, A up a little in the middle.
    for (let i = A.pts.length / 3; i < n; i++) x1[3 * i + 2] -= 0.2 + 0.05 * Math.sin(7 * x0[3 * i]);
    for (let i = 0; i < A.pts.length / 3; i++) x1[3 * i + 2] += 0.03 * Math.exp(-10 * (x0[3 * i] ** 2 + x0[3 * i + 1] ** 2));
    const mesh = untangleMesh(n, tris, []);
    const ccd = new ClothCcd(n, tris, ident(n));
    const w = new Float64Array(n).fill(1);
    ccd.resolve(x0, x1, w);
    expect(findCrossings(x1, mesh)).toEqual([]);
    // Every point of B still above A where it is over A (A's height there: from its nearest point, A being fine).
    const nA = A.pts.length / 3;
    for (let i = nA; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < nA; j++) { const d = (x1[3 * j] - x1[3 * i]) ** 2 + (x1[3 * j + 1] - x1[3 * i + 1]) ** 2; if (d < bd) { bd = d; best = j; } }
      expect(x1[3 * i + 2]).toBeGreaterThan(x1[3 * best + 2] - 0.01);
    }
  });

  it('a pair already crossed when the step began is left free', () => {
    const { x0, x1, tris, n } = onCloth(Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, -0.005), Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, 0.3), [0, 1, 2], 3);
    const ccd = new ClothCcd(n, tris, ident(n));
    // Its edge to its own triangle's corner through the triangle.
    ccd.setTangled([{ a: 3, b: 4, t: 0 }]);
    ccd.resolve(x0, x1, new Float64Array(n).fill(1));
    expect(x1[11]).toBeCloseTo(0.3);
  });

  it('a point that does not move is met by a triangle swung through it beside a corner that does not', () => {
    // A long triangle, its corner 0 still, its far corners swinging down past a still point near corner 0.
    const { x0, x1, tris, n } = onCloth(Float64Array.of(0, 0, 0, 0.05, -0.01, 0.01, 0.05, 0.01, 0.01, /* the point */ 0.004, 0, 0.0001), Float64Array.of(0, 0, 0, 0.05, -0.01, -0.01, 0.05, 0.01, -0.01, 0.004, 0, 0.0001), [0, 1, 2], 3);
    const ccd = new ClothCcd(n, tris, ident(n));
    expect(ccd.resolve(x0, x1, new Float64Array(n).fill(1)).met).toBeGreaterThan(0);
  });

  it('sewn points (one root) may meet', () => {
    const { x0, x1, tris, n } = onCloth(Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, 0.1), Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0.2, 0.2, -0.3), [0, 1, 2], 3);
    const ccd = new ClothCcd(n, tris, Int32Array.of(0, 1, 2, 0, 4, 5));
    expect(ccd.resolve(x0, x1, new Float64Array(n).fill(1)).met).toBe(0);
  });
});
