import { describe, expect, it } from 'vitest';
import { wallThicknessAt } from '../src/utils/wallThickness';
import { shatterFloor, shatterLimit, shatterVerdict, WALL_SCALE_MAX, WALL_SCALE_MIN } from '../src/utils/breakThresholds';

/** An axis-aligned box of half-size h, outward-wound unless `inward`. */
function box(h: number, inward = false, base = 0): { verts: number[]; faces: number[] } {
  const verts: number[] = [];
  for (let i = 0; i < 8; i++) verts.push(i & 1 ? h : -h, i & 2 ? h : -h, i & 4 ? h : -h);
  // Outward-wound quads (counter-clockwise seen from outside).
  const quads = [
    [0, 2, 3, 1], [4, 5, 7, 6], // -z, +z
    [0, 1, 5, 4], [2, 6, 7, 3], // -y, +y
    [0, 4, 6, 2], [1, 3, 7, 5], // -x, +x
  ];
  const faces: number[] = [];
  for (const [a, b, c, d] of quads) {
    const tri = [[a, b, c], [a, c, d]];
    for (const t of tri) {
      const [p, q, r] = inward ? [t[0], t[2], t[1]] : t;
      faces.push(p + base, q + base, r + base);
    }
  }
  return { verts, faces };
}

/** A closed hollow box: 100 mm outside, `wall` thick. */
function hollowBox(wall: number) {
  const outer = box(0.05);
  const inner = box(0.05 - wall, true, 8);
  return { verts: [...outer.verts, ...inner.verts], faces: [...outer.faces, ...inner.faces] };
}

describe('wallThicknessAt', () => {
  it('measures a solid body straight across', () => {
    const { verts, faces } = box(0.05);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.05])).toBeCloseTo(0.1, 6);
  });

  it('measures only the wall of a hollow body', () => {
    const { verts, faces } = hollowBox(0.004);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.05])).toBeCloseTo(0.004, 6);
    // Struck from inside the cavity, it is still the same wall.
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.046])).toBeCloseTo(0.004, 6);
  });

  it('does not care which side of the surface the contact point sits on', () => {
    const { verts, faces } = hollowBox(0.004);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.0505])).toBeCloseTo(0.004, 6);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.0497])).toBeCloseTo(0.004, 6);
  });

  it('copes with an inside-out mesh', () => {
    const { verts, faces } = box(0.05, true);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.05])).toBeCloseTo(0.1, 6);
  });

  it('gives up on a mesh with no inside', () => {
    expect(wallThicknessAt([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [0.1, 0.1, 0])).toBeNull();
    expect(wallThicknessAt([], [], [0, 0, 0])).toBeNull();
  });
});

describe('shatterLimit', () => {
  const cfg = { shatterImpulseNs: 2, shatterThicknessRef: 0.006 };

  it('scales with the wall where the blow landed', () => {
    expect(shatterLimit(cfg, 0.006)).toBeCloseTo(2);
    expect(shatterLimit(cfg, 0.003)).toBeCloseTo(1);
    expect(shatterLimit(cfg, 0.012)).toBeCloseTo(4);
  });

  it('is capped both ways', () => {
    expect(shatterLimit(cfg, 0.0001)).toBeCloseTo(2 * WALL_SCALE_MIN);
    expect(shatterLimit(cfg, 1)).toBeCloseTo(2 * WALL_SCALE_MAX);
  });

  it('ignores thickness when there is no rating or no measurement', () => {
    expect(shatterLimit({ shatterImpulseNs: 2 }, 0.001)).toBe(2);
    expect(shatterLimit(cfg, null)).toBe(2);
  });

  it('a wine glass breaks on the bowl from a blow its foot shrugs off', () => {
    expect(shatterVerdict(1.2, cfg, 0.002)).toBe(true);
    expect(shatterVerdict(1.2, cfg, 0.02)).toBe(false);
  });

  it('the worker watches for the weakest wall there could be', () => {
    expect(shatterFloor(cfg)).toBeCloseTo(2 * WALL_SCALE_MIN);
    expect(shatterFloor({ shatterImpulseNs: 2 })).toBe(2);
  });
});
