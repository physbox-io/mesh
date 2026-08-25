import { describe, it, expect } from 'vitest';
import {
  offsetLoop,
  offsetRegion,
  offsetRings,
  polygonArea,
  signedArea2,
} from '../src/utils/polygonOffset';
import type { Point2D } from '../src/utils/laserCutExporter';

/** Axis-aligned rectangle, counter-clockwise, with its lower-left at the origin. */
function rect(w: number, h: number, x = 0, y = 0): Point2D[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Bounding box of a loop, which is what most of these assertions really care about. */
function bounds(pts: Point2D[]) {
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Shortest distance from a point to a loop's boundary. */
function distToLoop(p: Point2D, loop: Point2D[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq <= 1e-18 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

describe('polygonOffset', () => {
  describe('outward offset', () => {
    it('grows a rectangle by the offset distance on every side', () => {
      const result = offsetLoop(rect(100, 50), 5);
      expect(result).toHaveLength(1);

      const b = bounds(result[0]);
      expect(b.minX).toBeCloseTo(-5, 3);
      expect(b.minY).toBeCloseTo(-5, 3);
      expect(b.maxX).toBeCloseTo(105, 3);
      expect(b.maxY).toBeCloseTo(55, 3);
    });

    it('rounds the outside corners, so no point is further than the offset from the original', () => {
      const src = rect(100, 50);
      const result = offsetLoop(src, 5)[0];

      // A round join is exactly the set of points at distance `delta` from the
      // corner, so nothing on the offset may exceed that distance anywhere.
      for (const p of result) {
        expect(distToLoop(p, src)).toBeLessThanOrEqual(5 + 1e-6);
      }
      // And the corner really is rounded rather than mitred: a mitred corner
      // would put a vertex at (-5, -5), which is 7.07 from the original.
      const corner = result.find((p) => p.x < -4.9 && p.y < -4.9);
      expect(corner).toBeUndefined();
    });

    it('mitres the corners when asked, keeping a rectangle rectangular', () => {
      const result = offsetLoop(rect(100, 50), 5, { joinStyle: 'miter' })[0];
      // Four corners and nothing else — no arc points.
      expect(result).toHaveLength(4);
      const corner = result.find((p) => Math.abs(p.x + 5) < 1e-6 && Math.abs(p.y + 5) < 1e-6);
      expect(corner).toBeDefined();
    });

    it('holds the arc tolerance it is given', () => {
      const coarse = offsetLoop(rect(100, 50), 5, { arcTolerance: 0.5 })[0];
      const fine = offsetLoop(rect(100, 50), 5, { arcTolerance: 0.005 })[0];
      // A tighter tolerance can only mean more points on the corner arcs.
      expect(fine.length).toBeGreaterThan(coarse.length);

      // Every chord midpoint must sit within tolerance of the true offset
      // distance, which is what the tolerance actually promises.
      const src = rect(100, 50);
      for (let i = 0; i < fine.length; i++) {
        const a = fine[i];
        const b = fine[(i + 1) % fine.length];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        expect(distToLoop(mid, src)).toBeGreaterThan(5 - 0.005 - 1e-6);
      }
    });
  });

  describe('inward offset', () => {
    it('shrinks a rectangle by the offset distance on every side', () => {
      const result = offsetLoop(rect(100, 50), -5);
      expect(result).toHaveLength(1);

      const b = bounds(result[0]);
      expect(b.minX).toBeCloseTo(5, 3);
      expect(b.minY).toBeCloseTo(5, 3);
      expect(b.maxX).toBeCloseTo(95, 3);
      expect(b.maxY).toBeCloseTo(45, 3);
    });

    it('returns nothing when the offset consumes the shape', () => {
      // A 4mm-wide slot cannot be cut with a 6mm bit: half the bit is 3mm, and
      // offsetting the slot in by 3mm from both sides leaves nothing at all.
      expect(offsetLoop(rect(4, 60), -3)).toHaveLength(0);
    });

    it('splits a dumbbell into two lobes when the waist is consumed', () => {
      // Two 30mm squares joined by a 4mm-wide neck. Offsetting in by 3mm eats
      // the neck and leaves the two ends as separate regions.
      const dumbbell: Point2D[] = [
        { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 13 },
        { x: 70, y: 13 }, { x: 70, y: 0 }, { x: 100, y: 0 },
        { x: 100, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 17 },
        { x: 30, y: 17 }, { x: 30, y: 30 }, { x: 0, y: 30 },
      ];
      const result = offsetLoop(dumbbell, -3);
      expect(result).toHaveLength(2);

      // One lobe on the left, one on the right, and neither spanning the waist.
      const xs = result.map((r) => bounds(r)).sort((a, b) => a.minX - b.minX);
      expect(xs[0].maxX).toBeLessThan(50);
      expect(xs[1].minX).toBeGreaterThan(50);
    });

    it('discards the inverted loop a spike throws off', () => {
      // A tall narrow spike on an otherwise square part. Offsetting inward
      // folds the spike through itself; the fold must not survive.
      const spiky: Point2D[] = [
        { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 },
        { x: 22, y: 20 }, { x: 20, y: 60 }, { x: 18, y: 20 },
        { x: 0, y: 20 },
      ];
      const result = offsetLoop(spiky, -3);

      for (const loop of result) {
        // Everything that survives winds the way the input did...
        expect(signedArea2(loop)).toBeGreaterThan(0);
        // ...and stands at least the offset distance clear of the original.
        for (const p of loop) {
          expect(distToLoop(p, spiky)).toBeGreaterThan(3 - 0.02);
        }
      }
      // The spike is 4mm wide at its base and tapers, so a 3mm inward offset
      // leaves only the body of the part.
      const total = result.reduce((s, l) => s + Math.abs(polygonArea(l)), 0);
      expect(total).toBeLessThan(40 * 20);
    });
  });

  describe('orientation', () => {
    it('grows a clockwise loop under a positive delta, just like a counter-clockwise one', () => {
      const cw = [...rect(100, 50)].reverse();
      expect(signedArea2(cw)).toBeLessThan(0);

      const result = offsetLoop(cw, 5);
      expect(result).toHaveLength(1);
      const b = bounds(result[0]);
      expect(b.minX).toBeCloseTo(-5, 3);
      expect(b.maxX).toBeCloseTo(105, 3);
    });

    it('returns loops wound the way they arrived', () => {
      const ccwResult = offsetLoop(rect(100, 50), 5)[0];
      const cwResult = offsetLoop([...rect(100, 50)].reverse(), 5)[0];
      expect(signedArea2(ccwResult)).toBeGreaterThan(0);
      expect(signedArea2(cwResult)).toBeLessThan(0);
    });
  });

  describe('degenerate input', () => {
    it('returns the loop untouched for a zero offset', () => {
      const src = rect(10, 10);
      expect(offsetLoop(src, 0)).toEqual([src]);
    });

    it('returns nothing for a loop with too few distinct points', () => {
      expect(offsetLoop([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1)).toHaveLength(0);
      expect(offsetLoop([], 1)).toHaveLength(0);
    });

    it('tolerates repeated points and a duplicated closing point', () => {
      const withDupes: Point2D[] = [
        { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 },
        { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 },
      ];
      const result = offsetLoop(withDupes, 2);
      expect(result).toHaveLength(1);
      const b = bounds(result[0]);
      expect(b.minX).toBeCloseTo(-2, 3);
      expect(b.maxX).toBeCloseTo(12, 3);
    });
  });

  describe('offsetRegion', () => {
    it('grows the outline and shrinks the holes', () => {
      const outer = rect(100, 100);
      const hole = rect(20, 20, 40, 40);
      const res = offsetRegion(outer, [hole], 3);

      expect(res.droppedHoles).toHaveLength(0);
      expect(bounds(res.outer[0]).minX).toBeCloseTo(-3, 3);
      // The hole's toolpath runs inside the hole, so the hole itself comes out
      // at nominal size.
      const hb = bounds(res.holes[0]);
      expect(hb.minX).toBeCloseTo(43, 3);
      expect(hb.maxX).toBeCloseTo(57, 3);
    });

    it('leaves a thin wall between a hole and the edge at its modelled thickness', () => {
      // A hole whose edge is 2mm from the part edge, cut with a 6mm bit. The
      // tool stays on its own side of both boundaries, so the wall survives at
      // exactly 2mm — thin, but not the toolpath's problem.
      const outer = rect(100, 100);
      const hole = rect(20, 20, 78, 40);
      const res = offsetRegion(outer, [hole], 3);

      expect(res.droppedHoles).toHaveLength(0);
      // Outline path 3mm outside x=100, hole path 3mm inside x=98.
      expect(bounds(res.outer[0]).maxX).toBeCloseTo(103, 3);
      expect(bounds(res.holes[0]).maxX).toBeCloseTo(95, 3);
    });

    it('reports a hole too small for the cutter to enter rather than dropping it silently', () => {
      const outer = rect(100, 100);
      const tiny = rect(4, 4, 48, 48);
      const big = rect(20, 20, 10, 10);
      const res = offsetRegion(outer, [big, tiny], 3);

      expect(res.holes).toHaveLength(1);
      expect(res.droppedHoles).toEqual([1]);
    });
  });

  describe('offsetRings', () => {
    it('walks a rectangle inward in steps until nothing is left', () => {
      // 100x50 stock, first pass 3mm in, then 4mm steps. The short axis runs
      // out first: 25mm of half-width, so rings at 3, 7, 11, 15, 19, 23.
      const rings = offsetRings(rect(100, 50), 3, 4);
      expect(rings.length).toBe(6);

      // Outermost first — an inner ring cut first would bury the tool when it
      // came back out to the wall.
      const widths = rings.map((r) => bounds(r).maxX - bounds(r).minX);
      for (let i = 1; i < widths.length; i++) {
        expect(widths[i]).toBeLessThan(widths[i - 1]);
      }
    });

    it('keeps shrinking each lobe after the region splits', () => {
      const dumbbell: Point2D[] = [
        { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 13 },
        { x: 70, y: 13 }, { x: 70, y: 0 }, { x: 100, y: 0 },
        { x: 100, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 17 },
        { x: 30, y: 17 }, { x: 30, y: 30 }, { x: 0, y: 30 },
      ];
      const rings = offsetRings(dumbbell, 1, 2);
      // The first ring is still one piece; later ones come in pairs once the
      // waist is gone.
      expect(rings.length).toBeGreaterThan(2);
      expect(rings.every((r) => r.length >= 3)).toBe(true);
    });

    it('terminates on a shape that never fully closes', () => {
      const rings = offsetRings(rect(1000, 1000), 0.5, 0.5, 50);
      expect(rings.length).toBeLessThanOrEqual(50);
    });
  });
});
