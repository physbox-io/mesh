// The cloth slab's normals are written from the middle surface's (top n,
// bottom -n) instead of Three's computeVertexNormals over the whole slab, and
// its bounding sphere is left for whoever asks (a raycast computes it).

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { syncClothSlabGeometry } from '../src/components/scene/ClothLayer';
import type { FlexInfo } from '../src/workers/physicsWorkerProtocol';

/** A cols x rows sheet wrapped part way round a cylinder, as a slab the way ClothPiece builds it. */
function curvedSheet(cols: number, rows: number) {
  const N = cols * rows, elems: number[] = [];
  for (let r = 0; r + 1 < rows; r++) for (let c = 0; c + 1 < cols; c++) {
    const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
    elems.push(a, b, e, a, e, d);
  }
  const flex = { name: 'p__sheet', vertadr: 0, vertnum: N, elems, rgba: [1, 1, 1, 1], material: 'cotton' } as unknown as FlexInfo;
  const src = new Float64Array(3 * N);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, a = 0.15 * c;
    src[3 * i] = 0.1 * Math.sin(a); src[3 * i + 1] = 0.02 * r; src[3 * i + 2] = 0.1 * Math.cos(a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * N), 3));
  const seen = new Map<number, number>();
  for (let t = 0; t < elems.length; t += 3) for (let k = 0; k < 3; k++) {
    const p = elems[t + k], q = elems[t + ((k + 1) % 3)], key = p < q ? p * N + q : q * N + p;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const index = [...elems];
  for (let t = 0; t < elems.length; t += 3) index.push(elems[t] + N, elems[t + 2] + N, elems[t + 1] + N);
  for (let t = 0; t < elems.length; t += 3) for (let k = 0; k < 3; k++) {
    const p = elems[t + k], q = elems[t + ((k + 1) % 3)];
    if ((seen.get(p < q ? p * N + q : q * N + p) ?? 0) === 1) index.push(p, q + N, q, p, p + N, q + N);
  }
  g.setIndex(index);
  return { flex, src, g, N, interior: (i: number) => { const r = Math.floor(i / cols), c = i % cols; return r > 0 && r < rows - 1 && c > 0 && c < cols - 1; } };
}

describe('cloth slab normals', () => {
  it('match what computeVertexNormals gave, without it', () => {
    const { flex, src, g, N, interior } = curvedSheet(12, 8);
    const scratch = { p: new Float32Array(3 * N), n: new Float32Array(3 * N) };
    expect(syncClothSlabGeometry(g, flex, src, [], scratch, 0.0004)).toBe(true);
    const mine = Float32Array.from((g.attributes.normal as THREE.BufferAttribute).array as Float32Array);
    const ref = g.clone();
    ref.deleteAttribute('normal');
    ref.computeVertexNormals();
    const theirs = (ref.attributes.normal as THREE.BufferAttribute).array as Float32Array;
    for (let v = 0; v < 2 * N; v++) {
      const dot = mine[3 * v] * theirs[3 * v] + mine[3 * v + 1] * theirs[3 * v + 1] + mine[3 * v + 2] * theirs[3 * v + 2];
      // Interior: the same; on the edge, Three also weighed in the walls (a thickness tall).
      expect(dot, `vertex ${v}`).toBeGreaterThan(interior(v % N) ? 0.99999 : 0.99);
    }
  });

  it('leaves the bounds to be computed on demand, and a raycast still hits', () => {
    const { flex, src, g, N } = curvedSheet(6, 4);
    const scratch = { p: new Float32Array(3 * N), n: new Float32Array(3 * N) };
    g.computeBoundingSphere();
    syncClothSlabGeometry(g, flex, src, [], scratch, 0.0004);
    expect(g.boundingSphere).toBeNull();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const hits = new THREE.Raycaster(new THREE.Vector3(0.05, 0.03, 1), new THREE.Vector3(0, 0, -1)).intersectObject(mesh);
    expect(hits.length).toBeGreaterThan(0);
    expect(g.boundingSphere).not.toBeNull();
  });
});
