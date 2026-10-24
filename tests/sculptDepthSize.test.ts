import { describe, expect, it } from 'vitest';
import { icosphere, isWatertight, recomputeNormals, type SculptMesh } from '../src/utils/sculptMesh';
import { applySculptStroke, defaultRadiusFor } from '../src/utils/sculptCommands';
import {
  BASE_SIZE, SCULPT_BASES, buildSculptBase, buildSculptBaseSized, longestSide, resizeSculptMesh,
} from '../src/utils/sculptBases';

const R = 0.035; // pumpkin-sized clay

/** How far inside the original sphere the deepest vertex is, in mm. */
function deepestMm(mesh: SculptMesh): number {
  let deepest = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const r = Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]);
    deepest = Math.max(deepest, R - r);
  }
  return deepest * 1000;
}

/** Depth, in mm, of the deepest vertex within `ring` (m) of the +Z pole, measured across the surface. */
function depthNearPole(mesh: SculptMesh, from: number, to: number): number {
  let deepest = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    const off = Math.hypot(x, y);
    if (z <= 0 || off < from || off > to) continue;
    deepest = Math.max(deepest, R - Math.hypot(x, y, z));
  }
  return deepest * 1000;
}

/** A carving stroke: a dozen dabs on the +Z pole. */
const carve = (mesh: SculptMesh, extra: Record<string, number> = {}, dabs = 12) =>
  applySculptStroke(mesh, {
    brush: 'draw', invert: true, radius: 0.003, strength: 1,
    at: Array.from({ length: dabs }, () => [0, 0, R]), ...extra,
  });

describe('depth-limited draw', () => {
  it('carves to the depth asked for in one stroke, and no further', () => {
    const mesh = icosphere(R, 4);
    carve(mesh, { depthMm: 2.5 });
    // The pumpkin's grin took two passes at about 1-1.7 mm each.
    expect(deepestMm(mesh)).toBeGreaterThan(2.4);
    expect(deepestMm(mesh)).toBeLessThan(2.55);
    expect(isWatertight(mesh)).toBe(true);
  });

  it('a second stroke goes on from the new floor, each stroke its own depth', () => {
    const mesh = icosphere(R, 4);
    carve(mesh, { depthMm: 1 });
    carve(mesh, { depthMm: 1 });
    expect(deepestMm(mesh)).toBeGreaterThan(1.9);
    expect(deepestMm(mesh)).toBeLessThan(2.1);
  });

  it('raises to a height the same way', () => {
    const mesh = icosphere(R, 4);
    applySculptStroke(mesh, { brush: 'draw', radius: 0.003, strength: 1, at: Array.from({ length: 12 }, () => [0, 0, R]), depthMm: 1.5 });
    let highest = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      highest = Math.max(highest, Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]) - R);
    }
    expect(highest * 1000).toBeGreaterThan(1.4);
    expect(highest * 1000).toBeLessThan(1.55);
  });

  it('without a limit the same stroke keeps going', () => {
    const limited = icosphere(R, 4);
    const free = icosphere(R, 4);
    carve(limited, { depthMm: 0.5 });
    carve(free);
    expect(deepestMm(free)).toBeGreaterThan(deepestMm(limited) + 0.3);
  });
});

describe('a printer-sized brush', () => {
  it('a 0.2 mm brush carves a 0.3 mm pupil into coarse clay, closed and quick', () => {
    const mesh = icosphere(R, 3); // ~6 mm edges, as new clay comes
    const t = performance.now();
    carve(mesh, { radius: 0.0002, depthMm: 0.3, hardness: 0.7 });
    expect(performance.now() - t).toBeLessThan(500);
    expect(deepestMm(mesh)).toBeGreaterThan(0.28);
    expect(deepestMm(mesh)).toBeLessThan(0.32);
    expect(isWatertight(mesh)).toBe(true);
  });
});

describe('hardness', () => {
  it('a hard brush cuts to full depth further out, so the socket has a floor and a crisp wall', () => {
    const soft = icosphere(R, 4);
    const hard = icosphere(R, 4);
    // Three dabs: enough for the centre to reach the floor, not for the soft
    // brush's thin rim (a stroke kept going flattens that too).
    carve(soft, { depthMm: 2 }, 3);
    carve(hard, { depthMm: 2, hardness: 0.8 }, 3);
    // Two thirds of the way to the rim: the soft brush has barely started
    // there, the hard one is at or near the floor.
    const ringSoft = depthNearPole(soft, 0.0019, 0.0021);
    const ringHard = depthNearPole(hard, 0.0019, 0.0021);
    expect(ringHard).toBeGreaterThan(1.8);
    expect(ringHard - ringSoft).toBeGreaterThan(0.25);
  });
});

describe('clay size', () => {
  it('every base comes out at the size asked for, longest side', () => {
    for (const base of SCULPT_BASES) {
      expect(longestSide(buildSculptBaseSized(base.id, 0.07))).toBeCloseTo(0.07, 6);
    }
  });

  it('the unsized base is unchanged, so old declarative strokes still land', () => {
    expect(longestSide(buildSculptBase('sphere'))).toBeCloseTo(BASE_SIZE, 2);
  });

  it('resizes a sculpted mesh about its origin and keeps it closed', () => {
    const mesh = icosphere(0.12, 3);
    recomputeNormals(mesh);
    applySculptStroke(mesh, { brush: 'draw', radius: 0.03, strength: 1, at: [[0, 0, 0.12]] });
    const before = mesh.positions.slice(0, mesh.vertexCount * 3);
    const k = 0.05 / longestSide(mesh);
    resizeSculptMesh(mesh, 0.05);
    expect(longestSide(mesh)).toBeCloseTo(0.05, 6);
    for (let i = 0; i < before.length; i += 97) expect(mesh.positions[i]).toBeCloseTo(before[i] * k, 7);
    expect(isWatertight(mesh)).toBe(true);
  });

  it('the default brush is a sixth of the clay', () => {
    expect(defaultRadiusFor(icosphere(0.05, 2))).toBeCloseTo(0.1 / 6, 3);
  });
});
