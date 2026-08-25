import { describe, it, expect } from 'vitest';
import {
  clearanceField,
  clearingRings,
  feedForEngagement,
  stepdownForEngagement,
  type ClearingRegion,
} from '../src/utils/adaptiveClearing';

/** A rectangular pocket of allowed tool-centre positions inside a larger grid. */
function region(cols: number, rows: number, x0: number, y0: number, w: number, h: number, mmPerCell = 1): ClearingRegion {
  const mask = new Uint8Array(cols * rows);
  for (let r = y0; r < y0 + h; r++) {
    for (let c = x0; c < x0 + w; c++) mask[r * cols + c] = 1;
  }
  return { mask, cols, rows, mmPerCell, originMm: { x: 0, y: 0 } };
}

describe('adaptiveClearing', () => {
  describe('clearanceField', () => {
    it('measures from the region boundary', () => {
      const reg = region(40, 40, 10, 10, 20, 20);
      const field = clearanceField(reg);
      expect(field[10 * 40 + 10]).toBeCloseTo(0.5, 6);  // hard against the edge
      expect(field[9 * 40 + 10]).toBe(0);               // outside
      expect(field[19 * 40 + 19]).toBeCloseTo(9.5, 6);  // middle
    });

    it('scales with the cell size', () => {
      const field = clearanceField(region(40, 40, 10, 10, 20, 20, 0.25));
      expect(field[19 * 40 + 19]).toBeCloseTo(9.5 * 0.25, 6);
    });
  });

  describe('clearingRings', () => {
    const reg = region(80, 80, 20, 20, 40, 40); // 40mm square at 1mm/cell

    it('walks inward from the boundary', () => {
      const rings = clearingRings(reg, 2, 6);
      expect(rings.length).toBeGreaterThan(5);
      for (let i = 1; i < rings.length; i++) {
        expect(rings[i].insetMm).toBeGreaterThan(rings[i - 1].insetMm);
      }
    });

    it('starts at the boundary rather than a stepover in from it', () => {
      // The first ring has to hug the edge, or a stepover's worth of material
      // is left standing all the way round the pocket.
      const rings = clearingRings(reg, 2, 6);
      expect(rings[0].insetMm).toBeLessThan(0.5);
    });

    it('rings get smaller as they go in', () => {
      const rings = clearingRings(reg, 2, 6);
      const width = (r: (typeof rings)[number]) => {
        const xs = r.loops.flat().map((p) => p.x);
        return Math.max(...xs) - Math.min(...xs);
      };
      expect(width(rings[rings.length - 1])).toBeLessThan(width(rings[0]));
    });

    it('calls the first ring a slot and everything after it the stepover', () => {
      const rings = clearingRings(reg, 1.5, 6);
      expect(rings[0].engagement).toBe(1);
      for (let i = 1; i < rings.length; i++) {
        expect(rings[i].engagement).toBeCloseTo(1.5 / 6, 6);
      }
    });

    it('converts to stock millimetres', () => {
      const shifted = { ...reg, originMm: { x: 100, y: 50 } };
      const rings = clearingRings(shifted, 2, 6);
      const xs = rings.flatMap((r) => r.loops.flat().map((p) => p.x));
      expect(Math.min(...xs)).toBeGreaterThan(118);
      expect(Math.max(...xs)).toBeLessThan(162);
    });

    it('handles a region with an island in it', () => {
      // A pocket with a boss standing in the middle — the tool has to go round
      // both, and the ring count must not collapse because of the hole.
      const withIsland = region(80, 80, 15, 15, 50, 50);
      for (let r = 35; r < 45; r++) for (let c = 35; c < 45; c++) withIsland.mask[r * 80 + c] = 0;

      const rings = clearingRings(withIsland, 2, 6);
      expect(rings[0].loops.length).toBe(2); // outside and round the island
    });

    it('returns nothing for an empty region', () => {
      expect(clearingRings(region(40, 40, 0, 0, 0, 0), 2, 6)).toHaveLength(0);
    });

    it('never runs past its ring cap', () => {
      expect(clearingRings(region(400, 400, 5, 5, 390, 390), 0.2, 6, 12).length).toBeLessThanOrEqual(12);
    });
  });

  describe('feedForEngagement', () => {
    it('slows the slotting first ring down', () => {
      // A full-width slot at the feed derived for a 45% bite would take far too
      // big a chip, so it comes down.
      expect(feedForEngagement(1200, 1)).toBeLessThan(1200);
    });

    it('speeds a light bite up, because the chips are getting too thin', () => {
      expect(feedForEngagement(1200, 0.15)).toBeGreaterThan(1200);
    });

    it('leaves the reference engagement alone', () => {
      expect(feedForEngagement(1200, 0.45)).toBe(1200);
    });

    it('clamps rather than running away at a hair-thin engagement', () => {
      expect(feedForEngagement(1200, 0.001)).toBeLessThanOrEqual(1200 * 1.6 + 1);
      expect(feedForEngagement(1200, 1)).toBeGreaterThanOrEqual(1200 / 1.6 - 1);
    });
  });

  describe('stepdownForEngagement', () => {
    it('lets a light radial bite go deeper', () => {
      const shallow = stepdownForEngagement(6, 0.45, 2);
      const deep = stepdownForEngagement(6, 0.15, 2);
      expect(deep).toBeGreaterThan(shallow);
    });

    it('leaves the baseline alone at the baseline engagement', () => {
      expect(stepdownForEngagement(6, 0.45, 2)).toBeCloseTo(2, 6);
    });

    it('never asks for more depth than the tool can plausibly hold', () => {
      expect(stepdownForEngagement(6, 0.01, 5)).toBeLessThanOrEqual(12);
    });

    it('never returns less than the baseline', () => {
      expect(stepdownForEngagement(6, 1, 2)).toBeGreaterThanOrEqual(2);
    });
  });
});
