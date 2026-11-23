import { describe, it, expect } from 'vitest';
import { trappedAirInSoup, planBurnoutVents } from '../src/utils/trappedAir';
import { castColumnSpans } from '../src/utils/columnSolid';

/** Outward-wound axis-aligned box as a flat triangle soup, mm. */
function boxSoup(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, invert = false): number[] {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) {
    if (invert) out.push(...p[a], ...p[c], ...p[b], ...p[a], ...p[d], ...p[c]);
    else out.push(...p[a], ...p[b], ...p[c], ...p[a], ...p[c], ...p[d]);
  }
  return out;
}

/** Outward-wound trapezoidal prism whose roof slopes linearly from zLeft at x0 to zRight at x1. */
function slopedBoxSoup(x0: number, x1: number, y0: number, y1: number, zBot: number, zLeft: number, zRight: number): number[] {
  const p = [
    [x0, y0, zBot], [x1, y0, zBot], [x1, y1, zBot], [x0, y1, zBot],
    [x0, y0, zLeft], [x1, y0, zRight], [x1, y1, zRight], [x0, y1, zLeft],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...p[a], ...p[b], ...p[c], ...p[a], ...p[c], ...p[d]);
  return out;
}

describe('castColumnSpans consistent mesh orientation', () => {
  it('does not invert a column when a stray upward-facing sliver triangle sits at the bottom', () => {
    // Closed outward-wound box [0,20]x[0,20]x[5,15], plus a tiny stray upward-facing
    // lip triangle at z = 0 under column (10, 10). Previously hitDir[order[0]] < 0
    // flipped that entire column inside-out!
    const main = boxSoup(0, 0, 5, 20, 20, 15);
    // Upward-facing CCW triangle at z = 0 covering (10, 10): normal = +Z -> hitDir = -1.
    const strayLip = [9, 9, 0, 11, 9, 0, 10, 11, 0];
    const tris = Float64Array.from([...main, ...strayLip]);
    const sp = castColumnSpans(tris, { minX: 10, minY: 10, stepX: 1, stepY: 1, cols: 1, rows: 1 });
    const spans = Array.from(sp.z.slice(sp.offset[0], sp.offset[1]));
    expect(spans).toHaveLength(2);
    expect(spans[0]).toBeCloseTo(5, 5);
    expect(spans[1]).toBeCloseTo(15, 5);
  });

  it('still reads a genuinely inside-out closed mesh consistently across all columns', () => {
    const inverted = Float64Array.from(boxSoup(0, 0, 2, 10, 10, 12, true));
    const sp = castColumnSpans(inverted, { minX: 2, minY: 2, stepX: 2, stepY: 2, cols: 4, rows: 4 });
    for (let k = 0; k < 16; k++) {
      const spans = Array.from(sp.z.slice(sp.offset[k], sp.offset[k + 1]));
      expect(spans).toHaveLength(2);
      expect(spans[0]).toBeCloseTo(2, 5);
      expect(spans[1]).toBeCloseTo(12, 5);
    }
  });
});

describe('trappedAirInSoup', () => {
  it('catches a sloped dead-end pocket roof below level using global spillLevels', () => {
    // Main sprue tower at x = [-20, -10], z = [0, 30] (reaches level = 30),
    // connected via a V-sloped trough (descending from z = 12 to z = 5 at x = -5,
    // then climbing to z = 10 at x = 0 — no flat ceiling on the bridge) to a
    // gently sloped blind roof x = [0, 30] rising from z = 10 to z = 18 (below level = 30).
    const soup = Float64Array.from([
      ...boxSoup(-20, -5, 0, -10, 5, 30),
      ...slopedBoxSoup(-10, -5, -5, 5, 0, 12, 5),
      ...slopedBoxSoup(-5, 0, -5, 5, 0, 5, 10),
      ...slopedBoxSoup(0, 30, -5, 5, 0, 10, 18),
    ]);
    const pts = trappedAirInSoup(soup, 30);
    expect(pts).toHaveLength(1);
    expect(pts[0].x).toBeGreaterThan(28);
    expect(pts[0].z).toBeCloseTo(18, 0);
  });

  it('does not let an upper-canopy pour opening falsely vent a separate pocket underneath it', () => {
    // Upper canopy at x = [-10, 10], y = [-10, 10], z = [28, 35] with a pour hole at (0, 0).
    // Side pillar at x = [10, 16], z = [0, 35] connects the canopy down to a base bridge
    // at z = [0, 5], which feeds a SEPARATE trapped pocket directly under (0, 0) at z = [0, 15]
    // (separated from the upper canopy by solid mold from z = 15 to z = 28!).
    const soup = Float64Array.from([
      ...boxSoup(-10, -10, 28, 10, 10, 35), // upper canopy
      ...boxSoup(10, -10, 0, 16, 10, 35),   // connecting side column
      ...boxSoup(-10, -10, 0, 10, 10, 5),   // bottom floor
      ...boxSoup(-6, -6, 5, 6, 6, 15),      // lower trapped pocket directly under (0, 0)!
    ]);
    // Pour opening is on top at (0, 0), r = 5 mm; level = 45 (silicone pour-box style).
    const pts = trappedAirInSoup(soup, 45, undefined, [{ x: 0, y: 0, r: 5 }]);
    expect(pts.length).toBeGreaterThanOrEqual(1);
    const lower = pts.find((p) => p.z > 13 && p.z < 17);
    expect(lower).toBeDefined();
    expect(Math.hypot(lower!.x, lower!.y)).toBeLessThan(7);
  });

  it('finds both nested pockets separated by an internal saddle', () => {
    // Sprue tower at x = [-30, -24], z = [0, 30] -> V-saddle down to z = 4 ->
    // pocket A at x = [-12, -4], z = [0, 20] -> internal V-saddle down to z = 10 ->
    // pocket B at x = [4, 12], z = [0, 17].
    const soup = Float64Array.from([
      ...boxSoup(-30, -4, 0, -24, 4, 30),
      ...slopedBoxSoup(-24, -18, -4, 4, 0, 14, 4),
      ...slopedBoxSoup(-18, -12, -4, 4, 0, 4, 14),
      ...boxSoup(-12, -4, 0, -4, 4, 20),
      ...slopedBoxSoup(-4, 0, -4, 4, 0, 16, 10),
      ...slopedBoxSoup(0, 4, -4, 4, 0, 10, 16),
      ...boxSoup(4, -4, 0, 12, 4, 17),
    ]);
    const pts = trappedAirInSoup(soup, 30);
    expect(pts).toHaveLength(2);
    expect(pts[0].z).toBeCloseTo(20, 0);
    expect(pts[1].z).toBeCloseTo(17, 0);
  });

  it('does not vent a trapped pocket when a stray bottom sliver triangle sits under it', () => {
    // Sprue at x = [-20, -14], z = [5, 30], V-saddle down to z = 8, pocket at x = [4, 16], z = [5, 20].
    // Add an upward-facing stray sliver at z = 0 directly under the pocket at (10, 0).
    const soup = Float64Array.from([
      ...boxSoup(-20, -4, 5, -14, 4, 30),
      ...slopedBoxSoup(-14, -5, -4, 4, 5, 16, 8),
      ...slopedBoxSoup(-5, 4, -4, 4, 5, 8, 16),
      ...boxSoup(4, -4, 5, 16, 4, 20),
      9, -1, 0, 11, -1, 0, 10, 1, 0, // stray upward-facing sliver below the pocket
    ]);
    const pts = trappedAirInSoup(soup, 30);
    expect(pts).toHaveLength(1);
    expect(pts[0].x).toBeGreaterThan(4);
    expect(pts[0].z).toBeCloseTo(20, 0);
  });
});

describe('planBurnoutVents', () => {
  it('populates leftOver and leftOverAt accurately when the tries cap is exhausted', () => {
    // Build a cavity with 3 tall sloped blind pockets whose heads are always 'blocked':
    // because each roof slopes across ~45 mm of height while headMm ≈ 0.25 mm, peeling
    // layer by layer exhausts the tries cap (`4 * maxVents + 64` = 68 when maxVents = 1)
    // while multiple pockets still remain unvented.
    const parts: number[] = [
      ...boxSoup(-40, -5, 0, -34, 5, 60),               // sprue reaching level = 60
      ...boxSoup(-34, -5, 0, 40, 5, 4),                 // bottom runner
      ...slopedBoxSoup(-20, -4, -4, 4, 4, 6, 52),       // tall sloped pocket 1
      ...slopedBoxSoup(0, 16, -4, 4, 4, 6, 50),         // tall sloped pocket 2
      ...slopedBoxSoup(20, 36, -4, 4, 4, 6, 48),        // tall sloped pocket 3
    ];
    const plan = planBurnoutVents(Float64Array.from(parts), 60, {
      minDepthMm: 0.5,
      minAirMm3: 1,
      maxVents: 1,
      farEndMm: 0,
      // Always 'blocked' so plan.vents stays 0 (< maxVents) and loop exhausts tries cap!
      fits: () => 'blocked',
    });
    expect(plan.vents).toHaveLength(0);
    expect(plan.leftOver).toBeGreaterThanOrEqual(2);
    expect(plan.leftOverAt).toHaveLength(plan.leftOver);
    for (const pt of plan.leftOverAt) {
      expect(Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z)).toBe(true);
    }
  });
});
