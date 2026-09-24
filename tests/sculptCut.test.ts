import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import {
  applyBrush, beginStroke, cloneSculptMesh, endStroke, icosphere, isWatertight,
  DEFAULT_BRUSH, type SculptMesh,
} from '../src/utils/sculptMesh';
import { undoSculptStroke } from '../src/utils/sculptCommands';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import * as THREE from 'three';
import { loadManifold, buildPrism, cutSculpt, cutSculptWith, polygonPrismMap } from '../src/utils/sculptCut';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

function volume(mesh: SculptMesh): number {
  let v = 0;
  const p = mesh.positions;
  for (let f = 0; f < mesh.faceCount; f++) {
    const a = mesh.faces[f * 3] * 3, b = mesh.faces[f * 3 + 1] * 3, c = mesh.faces[f * 3 + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

function integrity(mesh: SculptMesh) {
  return analyzeMesh(Array.from(mesh.positions.subarray(0, mesh.vertexCount * 3)), Array.from(mesh.faces.subarray(0, mesh.faceCount * 3)))!;
}

/** A square loop of half-width h at (cx, cy), cut straight down Z. */
function squareCut(mesh: SculptMesh, h: number, cx = 0, cy = 0, opts = {}) {
  const polygon = [[cx - h, cy - h, 0], [cx + h, cy - h, 0], [cx + h, cy + h, 0], [cx - h, cy + h, 0]];
  const { loop, map } = polygonPrismMap(mesh, polygon, [0, 0, 1])!;
  const prism = buildPrism(wasm, loop, map)!;
  try { return cutSculpt(wasm, mesh, prism, opts); } finally { prism.delete(); }
}

describe('sculpt scissors', () => {
  it('punches a closed hole through a sphere', () => {
    const sphere = icosphere(0.1, 3);
    const before = volume(sphere);
    const cut = squareCut(sphere, 0.03);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(isWatertight(cut.mesh)).toBe(true);
    const after = volume(cut.mesh);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before * 0.95);
    const info = integrity(cut.mesh);
    expect(info.boundaryEdges).toBe(0);
    expect(info.nonManifoldEdges).toBe(0);
    // A hole makes it a torus: V - E + F = 0.
    const m = cut.mesh;
    expect(m.vertexCount - (m.faceCount * 3) / 2 + m.faceCount).toBe(0);
    expect(cut.pieces).toBe(1);
  });

  it('cuts a piece off the edge', () => {
    const sphere = icosphere(0.1, 3);
    // x from 0.05 outwards, and wider than the sphere in y.
    const cut = squareCut(sphere, 0.1, 0.15, 0);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(isWatertight(cut.mesh)).toBe(true);
    let maxX = -Infinity;
    for (let i = 0; i < cut.mesh.vertexCount; i++) maxX = Math.max(maxX, cut.mesh.positions[i * 3]);
    expect(maxX).toBeLessThan(0.0501);
  });

  it('keeps only the inside', () => {
    const sphere = icosphere(0.1, 3);
    const cut = squareCut(sphere, 0.03, 0, 0, { mode: 'keep' });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(isWatertight(cut.mesh)).toBe(true);
    for (let i = 0; i < cut.mesh.vertexCount; i++) {
      expect(Math.abs(cut.mesh.positions[i * 3])).toBeLessThan(0.0301);
      expect(Math.abs(cut.mesh.positions[i * 3 + 1])).toBeLessThan(0.0301);
    }
  });

  it('copes with a lasso that crosses itself', () => {
    const sphere = icosphere(0.1, 3);
    const polygon = [[-0.04, -0.04, 0], [0.04, 0.04, 0], [0.04, -0.04, 0], [-0.04, 0.04, 0]];
    const { loop, map } = polygonPrismMap(sphere, polygon, [0, 0, 1])!;
    const prism = buildPrism(wasm, loop, map)!;
    const cut = cutSculpt(wasm, sphere, prism);
    prism.delete();
    expect(cut.ok).toBe(true);
    if (cut.ok) expect(isWatertight(cut.mesh)).toBe(true);
  });

  it('turns a mirrored sweep the right way out', () => {
    const sphere = icosphere(0.1, 3);
    const polygon = [[-0.03, -0.03, 0], [0.03, -0.03, 0], [0.03, 0.03, 0], [-0.03, 0.03, 0]];
    const { loop, map } = polygonPrismMap(sphere, polygon, [0, 0, 1])!;
    const prism = buildPrism(wasm, loop, (x, y, t) => map(-x, y, t))!;
    expect(prism.volume()).toBeGreaterThan(0);
    const cut = cutSculpt(wasm, sphere, prism);
    prism.delete();
    expect(cut.ok && volume(cut.mesh) < volume(sphere) * 0.95).toBe(true);
  });

  it('refuses to cut away everything', () => {
    const sphere = icosphere(0.1, 2);
    const cut = squareCut(sphere, 0.5);
    expect(cut.ok).toBe(false);
  });

  it('leaves an open hole when asked', () => {
    const sphere = icosphere(0.1, 3);
    const cut = squareCut(sphere, 0.03, 0, 0, { cap: false });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(isWatertight(cut.mesh)).toBe(false);
    const info = integrity(cut.mesh);
    expect(info.nonManifoldEdges).toBe(0);
    expect(info.boundaryEdges).toBeGreaterThan(0);
    // Had the prism's walls been kept, the surface would still be closed.
    expect(info.degenerateTriangles).toBe(0);
  });

  it('cuts a second open hole into an open surface, and a closed one after that', () => {
    const sphere = icosphere(0.1, 3);
    const first = squareCut(sphere, 0.02, -0.04, 0, { cap: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = squareCut(first.mesh, 0.02, 0.04, 0, { cap: false });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const openInfo = integrity(second.mesh);
    expect(openInfo.nonManifoldEdges).toBe(0);
    expect(openInfo.boundaryEdges).toBeGreaterThan(integrity(first.mesh).boundaryEdges);

    const third = squareCut(second.mesh, 0.02, 0, 0.05);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    // The old rims stay open; the new cut is closed.
    expect(integrity(third.mesh).boundaryEdges).toBe(openInfo.boundaryEdges);
  });

  it.each([
    ['perspective', new THREE.PerspectiveCamera(40, 1, 0.01, 100)],
    ['orthographic', new THREE.OrthographicCamera(-0.2, 0.2, 0.2, -0.2, 0.01, 100)],
  ] as const)('cuts through along the view of a %s camera', (_name, camera) => {
    const sphere = icosphere(0.1, 3);
    // Looking down -X at the sphere from 0.5 m away, with the body turned
    // 90° about Z so its local frame is not the world's.
    camera.position.set(0.5, 0, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const body = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const viewToLocal = body.clone().invert().multiply(camera.matrixWorld);
    // A small square in the middle of the screen.
    const s = 0.05;
    const loop: [number, number][] = [[-s, -s], [s, -s], [s, s], [-s, s]];
    const cut = cutSculptWith(wasm, sphere, {
      kind: 'view', loop,
      projectionInverse: Array.from(camera.projectionMatrixInverse.elements),
      viewToLocal: Array.from(viewToLocal.elements),
    });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(isWatertight(cut.mesh)).toBe(true);
    // World -X is the view direction; in the body's frame that is local +Y
    // (the body is turned +90° about Z), so the hole runs along local Y: the
    // points at local (0, ±0.1, 0) are gone.
    const poles = [0, 0, 0];
    for (let i = 0; i < cut.mesh.vertexCount; i++) {
      const [x, y, z] = [cut.mesh.positions[i * 3], cut.mesh.positions[i * 3 + 1], cut.mesh.positions[i * 3 + 2]];
      if (Math.hypot(x, z) < 0.005) poles[1]++;
      if (Math.hypot(y, z) < 0.005) poles[0]++;
    }
    expect(poles[1]).toBe(0);
    expect(poles[0]).toBeGreaterThan(0);
    expect(cut.mesh.vertexCount - (cut.mesh.faceCount * 3) / 2 + cut.mesh.faceCount).toBe(0);
  });

  it('undoes like a stroke', () => {
    const sphere = icosphere(0.1, 3);
    const before = cloneSculptMesh(sphere);
    const cut = squareCut(sphere, 0.03);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // What the bridge and the viewport both keep: the whole mesh as it was.
    const mesh = cut.mesh;
    undoSculptStroke(mesh, { indices: null, positions: null, mesh: before });
    expect(mesh.vertexCount).toBe(before.vertexCount);
    expect(mesh.faceCount).toBe(before.faceCount);
  });

  it('can be brushed afterwards, open rim included', () => {
    for (const cap of [true, false]) {
      const cut = squareCut(icosphere(0.1, 3), 0.03, 0, 0, { cap });
      expect(cut.ok).toBe(true);
      if (!cut.ok) return;
      const mesh = cut.mesh;
      const settings = { ...DEFAULT_BRUSH, type: 'draw' as const, radius: 0.03 };
      const session = beginStroke(mesh, settings);
      // Right over the edge of the hole, on top of the sphere.
      for (let i = 0; i < 8; i++) {
        applyBrush(session, settings, { x: 0.03, y: -0.02 + i * 0.005, z: 0.09, nx: 0, ny: 0, nz: 1 });
      }
      endStroke(session);
      const info = integrity(mesh);
      expect(info.nonManifoldEdges).toBe(0);
      if (cap) expect(isWatertight(mesh)).toBe(true);
      else expect(info.boundaryEdges).toBeGreaterThan(0);
    }
  });
});

describe('pieces', () => {
  it('splits a cut that goes clean across into separate meshes', async () => {
    const { splitComponents, countComponents } = await import('../src/utils/sculptMesh');
    const sphere = icosphere(0.1, 3);
    // A band right across the middle, wider than the sphere along y.
    const polygon = [[-0.01, -0.2, 0], [0.01, -0.2, 0], [0.01, 0.2, 0], [-0.01, 0.2, 0]];
    const { loop, map } = polygonPrismMap(sphere, polygon, [0, 0, 1])!;
    const prism = buildPrism(wasm, loop, map)!;
    const cut = cutSculpt(wasm, sphere, prism);
    prism.delete();
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.pieces).toBe(2);
    expect(countComponents(cut.mesh)).toBe(2);
    const pieces = splitComponents(cut.mesh);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) {
      expect(isWatertight(piece)).toBe(true);
      expect(volume(piece)).toBeGreaterThan(0);
      expect(piece.faceCount + (pieces[0] === piece ? pieces[1] : pieces[0]).faceCount).toBe(cut.mesh.faceCount);
    }
    // One on each side of the band.
    const sides = pieces.map((p) => Math.sign(p.positions[0]));
    expect(new Set(sides).size).toBe(2);
  });

  it('leaves a mesh in one piece as it is', async () => {
    const { splitComponents, countComponents } = await import('../src/utils/sculptMesh');
    const sphere = icosphere(0.1, 2);
    expect(countComponents(sphere)).toBe(1);
    expect(splitComponents(sphere)[0]).toBe(sphere);
  });
});
