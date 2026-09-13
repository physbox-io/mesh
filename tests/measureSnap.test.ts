import { describe, it, expect } from 'vitest';
import {
  fitPlane, fitCircle, detectCircle, nearbyVertices, chooseSnap,
  measureDistance, measureAngle, formatMm, smallestEigenvector,
  type Vec3, type SnapCandidate,
} from '../src/utils/measureSnap';

/** `count` points on a circle of `radius` in the z = `z` plane, about (cx, cy). */
function ring(count: number, radius: number, cx = 0, cy = 0, z = 0, arc = Math.PI * 2): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const t = (arc * i) / count;
    out.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t), z]);
  }
  return out;
}

describe('plane fitting', () => {
  it('finds the normal of a plane the points lie in', () => {
    const plane = fitPlane([[0, 0, 3], [1, 0, 3], [0, 1, 3], [2, 2, 3]]);
    expect(plane).not.toBeNull();
    expect(Math.abs(plane!.normal[2])).toBeCloseTo(1, 6);
    expect(plane!.centroid[2]).toBeCloseTo(3, 9);
  });

  it('handles a ring, where two eigenvalues are equal', () => {
    // The degenerate case the analytic cubic gets wrong: a circle's in-plane
    // spread is the same in every direction, so only the normal is determined.
    const plane = fitPlane(ring(24, 0.005, 0, 0, -0.02));
    expect(Math.abs(plane!.normal[2])).toBeCloseTo(1, 6);
  });

  it('finds the smallest eigenvector of a diagonal matrix', () => {
    const v = smallestEigenvector([[5, 0, 0], [0, 0.1, 0], [0, 0, 9]]);
    expect(Math.abs(v[1])).toBeCloseTo(1, 9);
  });
});

describe('circle fitting', () => {
  it('recovers the centre and radius of a full rim', () => {
    const fit = fitCircle(ring(16, 0.0032, 0.01, -0.02, 0.005));
    expect(fit).not.toBeNull();
    expect(fit!.radius).toBeCloseTo(0.0032, 9);
    expect(fit!.centre[0]).toBeCloseTo(0.01, 9);
    expect(fit!.centre[1]).toBeCloseTo(-0.02, 9);
    expect(fit!.centre[2]).toBeCloseTo(0.005, 9);
    expect(fit!.error).toBeLessThan(1e-6);
    expect(fit!.coverage).toBeGreaterThan(330);
  });

  it('survives a rim with a little noise on it', () => {
    const noisy = ring(20, 0.004).map(([x, y, z], i): Vec3 => [
      x * (1 + ((i % 3) - 1) * 0.002), y * (1 + ((i % 5) - 2) * 0.001), z,
    ]);
    const fit = detectCircle(noisy);
    expect(fit).not.toBeNull();
    expect(fit!.radius).toBeCloseTo(0.004, 4);
  });

  it('reports how much of the circle the points cover', () => {
    const fit = fitCircle(ring(10, 0.004, 0, 0, 0, Math.PI / 2));
    // A quarter of the rim: 90 degrees of points, and the gap is the rest.
    expect(fit!.coverage).toBeLessThan(120);
    expect(fit!.coverage).toBeGreaterThan(60);
  });
});

describe('deciding something is a circle', () => {
  it('accepts a hole rim', () => {
    expect(detectCircle(ring(12, 0.0025))).not.toBeNull();
  });

  it('rejects a square pocket', () => {
    const square: Vec3[] = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]][i];
      // Two points along each side, so there are enough of them to be tested.
      square.push([x, y, 0], [x / 2 + 0.0025, y / 2 + 0.0025, 0]);
    }
    expect(detectCircle(square)).toBeNull();
  });

  it('rejects a short arc, which any three points lie on', () => {
    expect(detectCircle(ring(8, 0.004, 0, 0, 0, Math.PI / 6))).toBeNull();
  });

  it('rejects a sphere of points, which is round but not flat', () => {
    const ball: Vec3[] = [];
    for (let i = 0; i < 20; i++) {
      const t = (i / 20) * Math.PI * 2;
      ball.push([0.004 * Math.cos(t), 0.004 * Math.sin(t), 0.004 * Math.sin(t * 1.7)]);
    }
    expect(detectCircle(ball)).toBeNull();
  });
});

describe('gathering vertices near a point', () => {
  it('takes what is inside the radius and nothing else', () => {
    const positions = [0, 0, 0, 0.001, 0, 0, 0.5, 0, 0];
    const found = nearbyVertices(positions, [0, 0, 0], 0.01);
    expect(found.length).toBe(2);
  });

  it('counts a corner shared by several triangles once', () => {
    const positions = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.001, 0, 0];
    expect(nearbyVertices(positions, [0, 0, 0], 0.01).length).toBe(2);
  });

  it('stops at the limit rather than walking a whole imported mesh', () => {
    const positions: number[] = [];
    for (let i = 0; i < 500; i++) positions.push(i * 1e-6, 0, 0);
    expect(nearbyVertices(positions, [0, 0, 0], 1, 32).length).toBe(32);
  });
});

describe('choosing what a click meant', () => {
  const project = (p: Vec3) => ({ x: p[0], y: p[1] });

  it('prefers a hole centre to a vertex on its rim', () => {
    const candidates: SnapCandidate[] = [
      { point: [10, 0, 0], kind: 'vertex', label: 'corner' },
      { point: [14, 0, 0], kind: 'centre', label: 'hole', radius: 0.003 },
    ];
    expect(chooseSnap(candidates, project, { x: 8, y: 0 })!.kind).toBe('centre');
  });

  it('ignores anything outside the pixel window', () => {
    const candidates: SnapCandidate[] = [
      { point: [400, 0, 0], kind: 'centre', label: 'far hole' },
      { point: [2, 0, 0], kind: 'vertex', label: 'corner' },
    ];
    expect(chooseSnap(candidates, project, { x: 0, y: 0 })!.label).toBe('corner');
  });

  it('falls back to the surface point when nothing is near', () => {
    const candidates: SnapCandidate[] = [
      { point: [400, 0, 0], kind: 'vertex', label: 'corner' },
      { point: [400, 0, 0], kind: 'surface', label: 'on the face' },
    ];
    expect(chooseSnap(candidates, project, { x: 0, y: 0 })!.kind).toBe('surface');
  });

  it('takes the nearest of two candidates of the same kind', () => {
    const candidates: SnapCandidate[] = [
      { point: [5, 0, 0], kind: 'vertex', label: 'far' },
      { point: [1, 0, 0], kind: 'vertex', label: 'near' },
    ];
    expect(chooseSnap(candidates, project, { x: 0, y: 0 })!.label).toBe('near');
  });
});

describe('the measurements', () => {
  it('gives the distance and its per-axis parts', () => {
    const reading = measureDistance([0, 0, 0], [0.003, 0.004, 0]);
    expect(reading.distance).toBeCloseTo(0.005, 12);
    expect(reading.delta).toEqual([0.003, 0.004, 0]);
  });

  it('measures the angle at the middle point', () => {
    expect(measureAngle([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 9);
    expect(measureAngle([1, 0, 0], [0, 0, 0], [1, 1, 0])).toBeCloseTo(45, 9);
  });

  it('gives no angle when an arm has no length', () => {
    expect(measureAngle([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
  });

  it('does not return NaN for arms that are all but parallel', () => {
    const angle = measureAngle([1, 0, 0], [0, 0, 0], [1, 1e-17, 0]);
    expect(angle).not.toBeNull();
    expect(Number.isNaN(angle!)).toBe(false);
  });

  it('reads metres out in millimetres', () => {
    expect(formatMm(0.0254)).toBe('25.40 mm');
    expect(formatMm(0.001)).toBe('1.000 mm');
  });
});
