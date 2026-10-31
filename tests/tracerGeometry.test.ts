import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { StaticGeometryGenerator } from 'three-gpu-pathtracer/src/core/utils/StaticGeometryGenerator.js';
import { withRgbaColors } from '../src/utils/tracerGeometry';

// Render mode drew painted bodies black: the tracer merges every body into one
// geometry, filling in RGBA white for those with no colours, and its merge
// mishandles a body whose colours are RGB.

const painted = () => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const n = g.getAttribute('position').count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) rgb.set([0.9, 0.5, 0.1], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  return g;
};

/**
 * How many vertices of the merged geometry carry the paint. The tracer sorts
 * bodies by uuid, which is random, before it merges them, so the painted body
 * lands first in some runs and second in others; each call takes twenty.
 */
function paintedCounts(make: () => THREE.BufferGeometry): number[] {
  const counts: number[] = [];
  for (let run = 0; run < 20; run++) {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(make(), new THREE.MeshStandardMaterial({ vertexColors: true })));
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial()));
    scene.updateMatrixWorld(true);
    const generator = new StaticGeometryGenerator(scene);
    generator.attributes = ['position', 'normal', 'color', 'tangent', 'uv', 'uv2'];
    const color = generator.generate().geometry.getAttribute('color');
    let n = 0;
    for (let i = 0; i < color.count; i++) {
      if (Math.abs(color.getX(i) - 0.9) < 1e-5 && Math.abs(color.getY(i) - 0.5) < 1e-5 && Math.abs(color.getZ(i) - 0.1) < 1e-5) n++;
    }
    counts.push(n);
  }
  return counts;
}

const BOX_VERTICES = 24;

describe('withRgbaColors', () => {
  it('reproduces the tracer losing RGB paint', () => {
    expect(paintedCounts(painted).some(n => n !== BOX_VERTICES)).toBe(true);
  });

  it('keeps painted colours through the tracer merge, in either order', () => {
    expect(paintedCounts(() => withRgbaColors(painted()))).toEqual(Array(20).fill(BOX_VERTICES));
  });

  it('refills when the paint changes and leaves unpainted geometry alone', () => {
    const g = painted();
    const first = withRgbaColors(g);
    const color = g.getAttribute('color') as THREE.BufferAttribute;
    color.setXYZ(0, 0.2, 0.3, 0.4);
    color.needsUpdate = true;
    const second = withRgbaColors(g);
    expect(second).toBe(first);
    expect(second.getAttribute('color').getX(0)).toBeCloseTo(0.2, 5);
    expect(second.getAttribute('color').getW(0)).toBe(1);
    const plain = new THREE.BoxGeometry(1, 1, 1);
    expect(withRgbaColors(plain)).toBe(plain);
  });
});
