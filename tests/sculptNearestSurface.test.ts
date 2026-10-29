// Probe and brush find the nearest point ON the surface, not the nearest vertex.
//
// A face Scissors leaves is a fan of long triangles with no vertex inside it.
// physics_probe_sculpt on such a cap answered with a rim corner 38.6 mm away,
// and a grab there reported `missed`, though the docs promise the nearest point
// on the surface and say cut faces can be brushed. A cube of twelve triangles
// is the same situation at its simplest: six faces with nothing inside them.
// (Positions are Float32, hence six places.)

import { describe, it, expect } from 'vitest';
import { createSculptMesh, recomputeNormals } from '../src/utils/sculptMesh';
import { applySculptStroke, probeSurface, nearestSurfacePoint } from '../src/utils/sculptCommands';

/** An 80 mm cube centred on the origin, twelve outward-wound triangles. */
function cube() {
  const h = 0.04;
  const positions = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ];
  const faces = [
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // -y
    2, 3, 7, 2, 7, 6, // +y
    1, 2, 6, 1, 6, 5, // +x
    3, 0, 4, 3, 4, 7, // -x
  ];
  const mesh = createSculptMesh(positions, faces);
  recomputeNormals(mesh);
  return mesh;
}

describe('nearestSurfacePoint', () => {
  it('lands on a face with no vertex inside it', () => {
    const [hit] = probeSurface(cube(), [[0.005, -0.003, 0.04]]);
    expect(hit.distance).toBeCloseTo(0, 6);
    [0.005, -0.003, 0.04].forEach((v, i) => expect(hit.nearest![i]).toBeCloseTo(v, 6));
    // The face's own normal, not the corners' blend of three faces.
    expect(hit.normal![2]).toBeCloseTo(1, 6);
  });

  it('measures to the face from off it', () => {
    const found = nearestSurfacePoint(cube(), [0.01, 0.01, 0.07])!;
    expect(found.distance).toBeCloseTo(0.03, 6);
    expect(found.stamp.z).toBeCloseTo(0.04, 6);
  });

  it('still finds a corner when that is nearest', () => {
    const found = nearestSurfacePoint(cube(), [0.05, 0.05, 0.05])!;
    [found.stamp.x, found.stamp.y, found.stamp.z].forEach((v) => expect(v).toBeCloseTo(0.04, 6));
  });
});

describe('brushing a bare face', () => {
  it('a grab there catches surface instead of missing', () => {
    const mesh = cube();
    const result = applySculptStroke(mesh, {
      brush: 'grab', at: [[0, 0, 0.04]], radius: 0.015, strength: 1, delta: [0, 0, 0.01],
    });
    expect(result.missed).toEqual([]);
    expect(result.applied).toBe(1);
    expect(result.topologyChanged).toBe(true);
    let top = -Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) top = Math.max(top, mesh.positions[i * 3 + 2]);
    expect(top).toBeGreaterThan(0.045);
    expect(result.watertight).toBe(true);
  });

  it('a draw there moves the face', () => {
    const mesh = cube();
    const result = applySculptStroke(mesh, { brush: 'draw', at: [[0, 0, 0.04]], radius: 0.015, strength: 1 });
    expect(result.missed).toEqual([]);
    let top = -Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) top = Math.max(top, mesh.positions[i * 3 + 2]);
    expect(top).toBeGreaterThan(0.0401);
  });
});

describe('the cap a cut leaves', () => {
  it('is surface a probe lands on and a grab can pull', async () => {
    const { loadManifold, buildPrism, cutSculpt, polygonPrismMap } = await import('../src/utils/sculptCut');
    const { icosphere } = await import('../src/utils/sculptMesh');
    const wasm = await loadManifold();
    const sphere = icosphere(0.04, 3);
    // Everything above z = 10 mm, swept along Y: the top sliced off flat.
    const polygon = [[-0.1, 0, 0.01], [0.1, 0, 0.01], [0.1, 0, 0.1], [-0.1, 0, 0.1]];
    const { loop, map } = polygonPrismMap(sphere, polygon, [0, 1, 0])!;
    const prism = buildPrism(wasm, loop, map)!;
    const cut = cutSculpt(wasm, sphere, prism, {});
    prism.delete();
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    recomputeNormals(cut.mesh);
    const [hit] = probeSurface(cut.mesh, [[0, 0, 0.01]]);
    expect(hit.distance).toBeLessThan(1e-6);
    expect(hit.normal![2]).toBeGreaterThan(0.99);
    const result = applySculptStroke(cut.mesh, {
      brush: 'grab', at: [[0, 0, 0.01]], radius: 0.01, strength: 1, delta: [0, 0, 0.005],
    });
    expect(result.missed).toEqual([]);
    let top = -Infinity;
    for (let i = 0; i < cut.mesh.vertexCount; i++) top = Math.max(top, cut.mesh.positions[i * 3 + 2]);
    expect(top).toBeGreaterThan(0.013);
  });
});
