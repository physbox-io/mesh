// An inward stroke cannot fold the surface through itself, and a surface that
// does fold is reported and no longer breaks the scene.
//
// Ten overlapping inverted inflate dabs round the top of an 80 mm ball drove
// the top down through the bottom. The mesh stayed closed and consistently
// wound, the stroke said ok and watertight, and MuJoCo refused the scene:
// "eigenvalue of mesh inertia must be positive".

import { describe, it, expect } from 'vitest';
import { buildSculptBaseSized } from '../src/utils/sculptBases';
import { applySculptStroke, sculptSummary } from '../src/utils/sculptCommands';
import { createSculptMesh, meshBounds, toSceneGeom } from '../src/utils/sculptMesh';
import { checkMeshInertia, symmetricEigenvalues } from '../src/utils/meshInertiaCheck';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph } from '../src/types/scene';

/** Ten dabs in a 6 mm ring round the top of the ball, as the report had them. */
const DABS = Array.from({ length: 10 }, (_, k) => {
  const a = (k / 10) * Math.PI * 2;
  return [0.006 * Math.cos(a), 0.006 * Math.sin(a), 0.035];
});

describe('an inward stroke', () => {
  it('does not fold the ball inside out however often it is repeated', () => {
    // Before the guard, the twelfth pass of this left the ball with a NEGATIVE
    // volume (-9.3e-6 m^3) and 1352 edge-through-face crossings; the scene
    // would not compile.
    const mesh = buildSculptBaseSized('sphere', 0.08);
    const bottom = meshBounds(mesh).min[2];
    let result = applySculptStroke(mesh, { brush: 'inflate', invert: true, radius: 0.025, strength: 0.8, at: DABS });
    for (let pass = 1; pass < 12; pass++) {
      result = applySculptStroke(mesh, { brush: 'inflate', invert: true, radius: 0.025, strength: 0.8, at: DABS });
    }
    expect(result.watertight).toBe(true);
    expect(result.warning).toBeUndefined();
    const check = checkMeshInertia(mesh.positions, mesh.faces, mesh.faceCount);
    expect(check.ok).toBe(true);
    // Still a ball with a pit in it, not a ball with its top folded away.
    expect(check.volume).toBeGreaterThan(0.6 * (4 / 3) * Math.PI * 0.04 ** 3);
    expect(meshBounds(mesh).min[2]).toBeGreaterThanOrEqual(bottom - 1e-6);
  });

  it('still digs', () => {
    const mesh = buildSculptBaseSized('sphere', 0.08);
    const before = checkMeshInertia(mesh.positions, mesh.faces, mesh.faceCount).volume;
    applySculptStroke(mesh, { brush: 'inflate', invert: true, radius: 0.025, strength: 0.8, at: DABS });
    const after = checkMeshInertia(mesh.positions, mesh.faces, mesh.faceCount).volume;
    expect(after).toBeLessThan(before * 0.95);
  });

  it('still dents with draw', () => {
    const mesh = buildSculptBaseSized('sphere', 0.08);
    const top = meshBounds(mesh).max[2];
    const result = applySculptStroke(mesh, { brush: 'draw', invert: true, radius: 0.02, strength: 1, at: [[0, 0, 0.04]] });
    expect(result.moved).toBeGreaterThan(0);
    expect(meshBounds(mesh).max[2]).toBeLessThan(top);
  });
});

describe('a surface folded through itself', () => {
  /** A 40 mm cube whose top has been pushed down through its bottom. */
  function folded() {
    const h = 0.02;
    const positions = [
      -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
      -h, -h, -3 * h, h, -h, -3 * h, h, h, -3 * h, -h, h, -3 * h,
    ];
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
    return createSculptMesh(positions, faces);
  }

  it('is reported by the sculpt summary', () => {
    const summary = sculptSummary(folded());
    expect(summary.watertight).toBe(true);
    expect(summary.warning).toMatch(/passes through itself/);
  });

  it('compiles, weighed by its hull rather than refused', () => {
    const { vertices, renderVertices, faces } = toSceneGeom(folded());
    const scene = {
      nodes: [{
        id: 'clay', name: 'clay', type: 'body', pos: [0, 0, 0.3], joints: [{ name: 'clay_free', type: 'free' }], children: [],
        geoms: [{ name: 'clay_mesh', type: 'mesh', size: [1], dynamic: true, vertices, renderVertices, faces }],
      }],
    } as unknown as SceneGraph;
    const xml = compileToMJCF(scene);
    expect(xml).toMatch(/<mesh name="clay_mesh"/);
    expect(xml).not.toMatch(/<mesh name="clay_mesh"[^>]*inertia="exact"/);
  });

  it('leaves a sound closed mesh exact', () => {
    const ball = buildSculptBaseSized('sphere', 0.08);
    const check = checkMeshInertia(ball.positions, ball.faces, ball.faceCount);
    expect(check.ok).toBe(true);
    // A solid ball: I = 2/5 m r^2 per unit density, m = 4/3 pi r^3.
    const r = 0.04;
    const expected = 0.4 * (4 / 3) * Math.PI * r ** 3 * r * r;
    expect(check.principal[0] / expected).toBeGreaterThan(0.95);
    expect(check.principal[2] / expected).toBeLessThan(1.02);
  });

  it('finds the eigenvalues of a symmetric matrix', () => {
    const [a, b, c] = symmetricEigenvalues(2, 2, 3, 1, 0, 0);
    expect(a).toBeCloseTo(1, 9);
    expect(b).toBeCloseTo(3, 6);
    expect(c).toBeCloseTo(3, 6);
  });

  it('is flagged in the scene summary for any mesh, not only a sculpt', async () => {
    const { meshIntegrity } = await import('../src/utils/sceneSummary');
    const { renderVertices, faces } = toSceneGeom(folded());
    const report = meshIntegrity({ name: 'm', type: 'mesh', size: [1], renderVertices, faces });
    expect(report.watertight).toBe(true);
    expect(report.weighedByHull).toBe(true);
    const ball = toSceneGeom(buildSculptBaseSized('sphere', 0.08));
    expect(meshIntegrity({ name: 'b', type: 'mesh', size: [1], ...ball }).weighedByHull).toBeUndefined();
  });
});

describe('a slender but sound mesh', () => {
  it('keeps its exact inertia: a 1 mm wire 1.5 m long', () => {
    const w = 0.0005, l = 0.75;
    const positions = [
      -w, -w, -l, w, -w, -l, w, w, -l, -w, w, -l,
      -w, -w, l, w, -w, l, w, w, l, -w, w, l,
    ];
    const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
    const check = checkMeshInertia(positions, faces);
    expect(check.principal[0] / check.principal[2]).toBeLessThan(2e-6);
    expect(check.ok).toBe(true);
  });
});
