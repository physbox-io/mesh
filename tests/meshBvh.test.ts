import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildFlatBvh, installMeshBvh } from '../src/utils/meshBvh';

describe('meshBvh', () => {
  it('matches brute-force Three.js raycasting on a high-triangle indexed mesh', () => {
    const geom = new THREE.SphereGeometry(1, 32, 32);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(0.2, -0.1, 0.3);
    mesh.rotation.set(0.4, -0.3, 0.2);
    mesh.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0.2, -0.1, 5),
      new THREE.Vector3(0.05, -0.02, -1).normalize(),
    );

    const baselineHits: THREE.Intersection[] = [];
    mesh.raycast(raycaster, baselineHits);
    expect(baselineHits.length).toBeGreaterThan(0);

    const bvh = buildFlatBvh(
      geom.attributes.position.array as ArrayLike<number>,
      geom.index!.array as ArrayLike<number>,
    );
    expect(bvh.nodeCount).toBeGreaterThan(1);

    installMeshBvh();
    const bvhHits: THREE.Intersection[] = [];
    mesh.raycast(raycaster, bvhHits);

    baselineHits.sort((a, b) => a.distance - b.distance);
    bvhHits.sort((a, b) => a.distance - b.distance);

    expect(bvhHits.length).toBe(baselineHits.length);
    for (let i = 0; i < baselineHits.length; i++) {
      expect(bvhHits[i].faceIndex).toBe(baselineHits[i].faceIndex);
      expect(bvhHits[i].distance).toBeCloseTo(baselineHits[i].distance, 6);
      expect(bvhHits[i].point.distanceTo(baselineHits[i].point)).toBeLessThan(1e-6);
    }
  });
});

