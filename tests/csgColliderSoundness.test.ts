import { describe, it, expect } from 'vitest';
import {
  decomposeAroundAxis,
  usableColliderHulls,
  isDegenerateCollider,
  colliderSoundness,
  convexHullOf,
  meshVolumeAndCentroid,
  MIN_COLLIDER_THICKNESS,
} from '../src/utils/csg';

/**
 * An axis-aligned box as a closed triangle mesh, appended to `verts`/`faces`.
 * Winding is outward, so the signed volumes stay positive.
 */
function addBox(
  verts: number[], faces: number[],
  c: [number, number, number], h: [number, number, number],
) {
  const base = verts.length / 3;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    verts.push(c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]);
  }
  // Index bits: x = 4, y = 2, z = 1 (0 = -, 1 = +).
  const q = (a: number, b: number, d: number, e: number) => {
    faces.push(base + a, base + b, base + d, base + a, base + d, base + e);
  };
  q(0, 1, 3, 2); // -x
  q(4, 6, 7, 5); // +x
  q(0, 4, 5, 1); // -y
  q(2, 3, 7, 6); // +y
  q(0, 2, 6, 4); // -z
  q(1, 5, 7, 3); // +z
}

/**
 * The part from the crash report: a 160 x 140 x 3 mm stencil plate with ten
 * 10 x 100 mm through-slots milled in a row. Modelled as the material that
 * survives — two end rails plus the eleven ribs between the slots — which is
 * geometrically the same solid as plate-minus-slots.
 */
function slottedPlate() {
  const verts: number[] = [], faces: number[] = [];
  const W = 0.160, D = 0.140, T = 0.003;
  const hz = T / 2;
  const slotW = 0.010, slotL = 0.100, slots = 10;
  const ribW = (W - slots * slotW) / (slots + 1);
  const bandHy = slotL / 2;               // slotted band: |y| <= 0.05
  const railHy = (D / 2 - bandHy) / 2;    // solid rail above and below it

  addBox(verts, faces, [0, bandHy + railHy, 0], [W / 2, railHy, hz]);
  addBox(verts, faces, [0, -(bandHy + railHy), 0], [W / 2, railHy, hz]);
  let x = -W / 2;
  for (let i = 0; i <= slots; i++) {
    addBox(verts, faces, [x + ribW / 2, 0, 0], [ribW / 2, bandHy, hz]);
    x += ribW + slotW;
  }
  return { verts, faces };
}

describe('collider soundness', () => {
  it('rejects the slivers that abort MuJoCo and accepts ordinary solids', () => {
    // A 0.06 mm thick wafer — col15 from the crash report.
    const wafer = convexHullOf([
      [-0.063889, -0.00003, -0.015303], [-0.023889, -0.00003, -0.015303],
      [-0.023889, -0.00003, 0.015303], [-0.063889, -0.00003, 0.015303],
      [-0.063889, 0.00003, -0.015303], [-0.023889, 0.00003, -0.015303],
      [-0.023889, 0.00003, 0.015303], [-0.063889, 0.00003, 0.015303],
    ])!;
    expect(wafer).toBeTruthy();
    expect(colliderSoundness(wafer).reason).toBe('thickness');
    expect(isDegenerateCollider(wafer)).toBe(true);

    // Near-collinear points cannot make a hull at all.
    expect(convexHullOf([
      [-0.003571, -0.0015, 0.012143], [-0.003571, 0, 0.012143], [-0.003571, 0.0015, 0.012143],
    ])).toBeNull();

    // A 3 mm cube — the smallest thing this app is expected to collide with.
    const cube = convexHullOf([
      [0, 0, 0], [0.003, 0, 0], [0, 0.003, 0], [0.003, 0.003, 0],
      [0, 0, 0.003], [0.003, 0, 0.003], [0, 0.003, 0.003], [0.003, 0.003, 0.003],
    ])!;
    expect(isDegenerateCollider(cube)).toBe(false);
  });

  it('keeps every sector of a plate sliced about its own centre', () => {
    // Guards the thresholds from the other side: a well-behaved decomposition
    // of a 3 mm plate must not lose anything.
    const { verts, faces } = slottedPlate();
    const hulls = decomposeAroundAxis(verts, faces, [0, 0, 0], [0, 0, 1], 16);
    expect(hulls).toHaveLength(16);
    expect(usableColliderHulls(hulls)).toHaveLength(16);
  });

  it('drops the slivers a thin slotted plate throws off, and still collides', () => {
    // Slicing about an axis near a corner — what hole detection picks when the
    // negatives are a row of slots — makes the outermost wedges into wafers
    // tens of microns thick, which is exactly what aborted MuJoCo.
    const { verts, faces } = slottedPlate();
    const hulls = decomposeAroundAxis(verts, faces, [-0.0799, 0.0699, 0], [0, 0, 1], 32);
    const usable = usableColliderHulls(hulls);

    expect(hulls.some(isDegenerateCollider)).toBe(true);   // the bug reproduces
    expect(usable.length).toBeLessThan(hulls.length);      // and is filtered
    expect(usable.length).toBeGreaterThanOrEqual(3);       // body still collides

    for (const h of usable) {
      const s = colliderSoundness(h);
      expect(s.degenerate).toBe(false);
      expect(s.reason).toBeUndefined();
      expect(s.vertexCount).toBeGreaterThanOrEqual(4);
      expect(s.thickness).toBeGreaterThanOrEqual(MIN_COLLIDER_THICKNESS);
      // Every kept hull is a real solid: its own volume matches its mesh.
      expect(meshVolumeAndCentroid(h.verts, h.faces).volume).toBeCloseTo(h.volume, 12);
    }
  });

  it('re-normalises mass over the survivors so the body keeps its weight', () => {
    const { verts, faces } = slottedPlate();
    const usable = usableColliderHulls(
      decomposeAroundAxis(verts, faces, [-0.0799, 0.0699, 0], [0, 0, 1], 32),
    );
    const total = usable.reduce((s, h) => s + h.volume, 0);
    const mass = 0.35;
    // Mirrors evaluateNodeCsg: volume share over the SURVIVORS, remainder to
    // the last, so dropping a sliver cannot change what the body weighs.
    let left = +mass.toFixed(8);
    const masses = usable.map((h, i) => {
      const share = i === usable.length - 1 ? left : +(mass * (h.volume / total)).toFixed(8);
      left = +(left - share).toFixed(8);
      return share;
    });
    expect(masses.reduce((a, b) => a + b, 0)).toBeCloseTo(mass, 10);
    expect(masses.every(m => m > 0)).toBe(true);
  });
});
