import { describe, it, expect } from 'vitest';
import { planSetups, neededDepth, type PartBox } from '../src/utils/setupPlanner';

/*
 * Which faces a part is machined from. Each fixture is built straight into
 * setup 1's frame: the block runs +X +Y from its near-left corner and down
 * from Z0, mm.
 */

/** Triangles of a prism along `axis` over a convex profile in the other two axes. */
function prism(axis: 0 | 1 | 2, from: number, to: number, profile: [number, number][]): number[] {
  const out: number[] = [];
  const at = (t: number, p: [number, number]) => {
    const v = [0, 0, 0];
    v[axis] = t;
    const [a, b] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    v[a] = p[0];
    v[b] = p[1];
    return v;
  };
  const n = profile.length;
  const tri = (a: number[], b: number[], c: number[]) => out.push(...a, ...b, ...c);
  // Wound outward for a counter-clockwise profile seen from +axis; the
  // ray caster reads either way, but keep it honest.
  for (let i = 1; i < n - 1; i++) {
    tri(at(from, profile[0]), at(from, profile[i + 1]), at(from, profile[i]));
    tri(at(to, profile[0]), at(to, profile[i]), at(to, profile[i + 1]));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(at(from, profile[i]), at(from, profile[j]), at(to, profile[j]));
    tri(at(from, profile[i]), at(to, profile[j]), at(to, profile[i]));
  }
  return out;
}

const box = (min: number[], max: number[]): number[] =>
  prism(2, min[2], max[2], [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]]);

const boundsOf = (t: number[]): PartBox => {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < t.length; i += 3) {
    b.minX = Math.min(b.minX, t[i]); b.maxX = Math.max(b.maxX, t[i]);
    b.minY = Math.min(b.minY, t[i + 1]); b.maxY = Math.max(b.maxY, t[i + 1]);
    b.minZ = Math.min(b.minZ, t[i + 2]); b.maxZ = Math.max(b.maxZ, t[i + 2]);
  }
  return b;
};

/** oak_tray: 135 x 138 x 19 with a 12 x 12 groove along X leaning back 15°, in 150 x 150 x 20. */
function tray(leanDeg: number) {
  const x0 = 7.5, x1 = 142.5, y0 = 6, top = -0.5, floor = top - 12, bottom = top - 19;
  const run = 12 * Math.tan((leanDeg * Math.PI) / 180);
  const near = y0 + 60, far = near + 12;
  const t = [
    ...prism(0, x0, x1, [[y0, bottom], [y0 + 138, bottom], [y0 + 138, floor], [y0, floor]]),
    ...prism(0, x0, x1, [[y0, floor], [near, floor], [near + run, top], [y0, top]]),
    ...prism(0, x0, x1, [[far, floor], [y0 + 138, floor], [y0 + 138, top], [far + run, top]]),
  ];
  return { tris: Float64Array.from(t), partBox: boundsOf(t), stock: { widthMm: 150, depthMm: 150, thicknessMm: 20 } };
}

describe('planning setups', () => {
  it('cuts a plain block with a top pocket in one setup', () => {
    const t = [
      ...box([10, 10, -20], [90, 90, -10]),
      ...box([10, 10, -10], [20, 90, 0]), ...box([80, 10, -10], [90, 90, 0]),
      ...box([20, 10, -10], [80, 20, 0]), ...box([20, 80, -10], [80, 90, 0]),
    ];
    const plan = planSetups({
      tris: Float64Array.from(t), partBox: boundsOf(t), stock: { widthMm: 100, depthMm: 100, thicknessMm: 20 },
      toolDiaMm: 6, reachMm: 48,
    });
    expect(plan.order).toEqual(['+z']);
    // Only the pocket's square corners, which no round cutter reaches from anywhere.
    expect(plan.unreachedMm3).toBeLessThan(400);
  });

  it('turns the leaning tray onto both ends, splitting the groove between them', () => {
    const t = tray(15);
    const plan = planSetups({ ...t, toolDiaMm: 6, reachMm: 80 });
    expect(new Set(plan.order)).toEqual(new Set(['+x', '-x', '+z']));
    expect(plan.freeing).toBe('+z');
    expect(plan.topOnlyUnreachedMm3).toBeGreaterThan(100);
    // All that is left is the groove's acute corner, which no face reaches
    // with a 6 mm cutter: a fillet along it, about 0.39 r² in section.
    expect(plan.unreachedMm3).toBe(plan.unreachableAnywhereMm3);
    expect(plan.unreachedMm3).toBeLessThan(0.4 * plan.topOnlyUnreachedMm3);
    // Each end goes in about half way, not the whole length.
    for (const f of ['+x', '-x']) {
      expect(plan.faces[f].depthMm).toBeGreaterThan(50);
      expect(plan.faces[f].depthMm).toBeLessThan(80);
    }
  });

  it('keeps the upright tray to the top alone', () => {
    const plan = planSetups({ ...tray(0), toolDiaMm: 6, reachMm: 80 });
    expect(plan.order).toEqual(['+z']);
  });

  it('will not turn the block onto an end its cutter cannot reach half way down', () => {
    // A 6 mm bit reaching 48 mm (8 D) cannot get to the middle of a 135 mm groove from either end.
    const plan = planSetups({ ...tray(15), toolDiaMm: 6, reachMm: 48 });
    expect(plan.unreachedMm3).toBeGreaterThan(0);
    for (const f of plan.order.filter((f) => f === '+x' || f === '-x')) {
      expect(plan.faces[f].depthMm).toBeLessThanOrEqual(48 + 1e-6);
    }
  });

  it('will not stand the block on end where it does not fit under the spindle', () => {
    const plan = planSetups({ ...tray(15), toolDiaMm: 6, reachMm: 80, clearanceMm: 120, stickoutMm: 30 });
    expect(plan.order).toEqual(['+z']);
    expect(plan.dropped.map((d) => d.face)).toEqual(expect.arrayContaining(['+x', '-x']));
    expect(plan.dropped.find((d) => d.face === '+x')!.reason).toMatch(/under the spindle/);
  });

  it('cuts an upright "o" and "T" from the top and the front', () => {
    // Letters 40 tall, 10 deep (front to back), standing on a 6 mm base, all in setup 1's frame.
    const base = box([5, 5, -46], [95, 25, -40]);
    const o = [
      ...box([10, 10, -40], [40, 20, -34]), ...box([10, 10, -6], [40, 20, 0]),
      ...box([10, 10, -34], [16, 20, -6]), ...box([34, 10, -34], [40, 20, -6]),
    ];
    const T = [...box([50, 10, -8], [90, 20, 0]), ...box([66, 10, -40], [74, 20, -8])];
    const t = [...base, ...o, ...T];
    const plan = planSetups({
      tris: Float64Array.from(t), partBox: boundsOf(t), stock: { widthMm: 100, depthMm: 30, thicknessMm: 47 },
      toolDiaMm: 3, reachMm: 24,
    });
    expect(new Set(plan.order)).toEqual(new Set(['-y', '+z']));
    expect(plan.unreachedMm3).toBeLessThan(0.05 * plan.topOnlyUnreachedMm3);
    // The sides go first; the top frees the part, last.
    expect(plan.order[plan.order.length - 1]).toBe('+z');
  });

  it('says how deep each end has to cut, and nothing where it has nothing to do', () => {
    const t = tray(15);
    const plan = planSetups({ ...t, toolDiaMm: 6, reachMm: 80 });
    const need = neededDepth(plan, '+x', t.stock, t.partBox, 3);
    // In the groove's leaning sliver, about half way in from the stock's end.
    expect(need(66 + 1.5, -6)).toBeGreaterThan(50);
    // Far from the groove, nothing.
    expect(need(20, -6)).toBe(0);
  });
});
