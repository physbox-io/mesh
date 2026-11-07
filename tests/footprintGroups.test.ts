import { describe, expect, it } from 'vitest';
import { footprintGroups } from '../src/utils/footprintGroups';

// Boxes from the gear-sculpture mold (sim_nfza71li), Z-up, mm.
const cavityShell = { min: [-62.26, -29.88, 0], max: [-3, 29.88, 25.98] };
const cavityLiner = { min: [-53.47, -21.02, 7.34], max: [-11.85, 21.0, 25.98] };
const lidShell = { min: [3, -29.88, 0], max: [62.26, 29.88, 9.5] };
const lidLiner = { min: [12.2, -21.06, 1.8], max: [53.46, 21.06, 5.5] };
const zUp = { axes: [0, 1] as const, minOverlap: 0.01 };

describe('footprintGroups', () => {
  it('keeps a liner with its shell and the two mold halves apart', () => {
    expect(footprintGroups([cavityShell, cavityLiner, lidShell, lidLiner], zUp)).toEqual([0, 0, 2, 2]);
  });

  it('measures each half of the mold, not the pair', () => {
    // The 125 mm the export prompt offered was both halves side by side.
    const boxes = [cavityShell, cavityLiner, lidShell, lidLiner];
    const groups = footprintGroups(boxes, zUp);
    const longest = Math.max(...[...new Set(groups)].map((g) => {
      const members = boxes.filter((_, i) => groups[i] === g);
      return Math.max(...[0, 1, 2].map((k) =>
        Math.max(...members.map((b) => b.max[k])) - Math.min(...members.map((b) => b.min[k]))));
    }));
    expect(longest).toBeCloseTo(59.76, 1);
  });

  it('keeps apart boxes that only touch, and stacked boxes together', () => {
    const a = { min: [0, 0, 0], max: [10, 10, 10] };
    const touching = { min: [10, 0, 0], max: [20, 10, 10] };
    const above = { min: [2, 2, 20], max: [8, 8, 30] };
    expect(footprintGroups([a, touching, above], zUp)).toEqual([0, 1, 0]);
  });

  it('reads the bed off the axes it is given', () => {
    // Y-up: these overlap in X and Z but sit far apart in height.
    const low = { min: [0, 0, 0], max: [10, 1, 10] };
    const high = { min: [0, 50, 0], max: [10, 51, 10] };
    expect(footprintGroups([low, high], { axes: [0, 2], minOverlap: 1e-5 })).toEqual([0, 0]);
    expect(footprintGroups([low, high], { axes: [0, 1], minOverlap: 1e-5 })).toEqual([0, 1]);
  });

  it('joins what it is told to, and through a third box', () => {
    const a = { min: [0, 0, 0], max: [1, 1, 1] };
    const b = { min: [5, 0, 0], max: [6, 1, 1] };
    const c = { min: [9, 0, 0], max: [10, 1, 1] };
    const bridge = { min: [0.5, 0, 0], max: [5.5, 1, 1] };
    expect(footprintGroups([a, b, c], { ...zUp, joined: [[0, 2]] })).toEqual([0, 1, 0]);
    expect(footprintGroups([a, b, bridge], zUp)).toEqual([0, 0, 0]);
  });
});
