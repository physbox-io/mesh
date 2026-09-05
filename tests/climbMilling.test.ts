import { describe, it, expect } from 'vitest';
import {
  offsetNestedLoops,
  offsetRegion,
  offsetRings,
  orientForClimb,
  signedArea2,
} from '../src/utils/polygonOffset';
import { clearingRings } from '../src/utils/adaptiveClearing';
import { concentricPasses } from '../src/utils/finishingPaths';
import type { Point2D } from '../src/utils/laserCutExporter';

/**
 * Climb milling: the tooth enters the cut at full chip thickness and leaves at
 * nothing, so the heat it makes goes out with the chip rather than into the
 * tool. A right-hand cutter turns clockwise seen from above, and for that
 * rotation the tooth enters thick when the material lies to the right of the
 * travel — clockwise around a part, anti-clockwise around a hole.
 *
 * Nothing here mirrors an axis on the way to G-code, so the winding these
 * assertions read is the winding the machine sees.
 */

/** `signedArea2` is positive counter-clockwise, so this reads as the rule does. */
const clockwise = (pts: Point2D[]) => signedArea2(pts) < 0;

function rect(w: number, h: number, x = 0, y = 0): Point2D[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

describe('orientForClimb', () => {
  it('winds a loop clockwise when the material is inside it', () => {
    for (const start of [rect(10, 10), [...rect(10, 10)].reverse()]) {
      expect(clockwise(orientForClimb(start, 'inside'))).toBe(true);
    }
  });

  it('winds a loop anti-clockwise when the material is outside it', () => {
    for (const start of [rect(10, 10), [...rect(10, 10)].reverse()]) {
      expect(clockwise(orientForClimb(start, 'outside'))).toBe(false);
    }
  });

  it('keeps the start point where it was, so a planned entry still fits', () => {
    const flipped = orientForClimb(rect(10, 10), 'inside');
    expect(flipped[0]).toEqual({ x: 0, y: 0 });
  });

  it('keeps a closed loop closed and an open one open', () => {
    const open = rect(10, 10);
    expect(orientForClimb(open, 'inside')).toHaveLength(4);
    const closed = [...open, { ...open[0] }];
    const out = orientForClimb(closed, 'inside');
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(out[out.length - 1]);
  });
});

describe('cutter-offset paths climb-mill', () => {
  it('goes clockwise round a panel and anti-clockwise round its cutouts', () => {
    const res = offsetRegion(rect(100, 60), [rect(20, 20, 40, 20)], 3);
    for (const o of res.outer) expect(clockwise(o)).toBe(true);
    for (const h of res.holes) expect(clockwise(h)).toBe(false);
  });

  it('reads the same rule off nesting when the loops arrive as one set', () => {
    // A slice: an outer boundary with a hole in it, and an island in the hole.
    const loops = [rect(100, 100), rect(60, 60, 20, 20), rect(20, 20, 40, 40)];
    const { paths } = offsetNestedLoops(loops, 2);
    expect(paths.length).toBe(3);
    // Sorted by enclosed area: outer, hole, island. Depth 0 and 2 are material,
    // depth 1 is the void.
    const byArea = [...paths].sort((a, b) => Math.abs(signedArea2(b)) - Math.abs(signedArea2(a)));
    expect(clockwise(byArea[0])).toBe(true);
    expect(clockwise(byArea[1])).toBe(false);
    expect(clockwise(byArea[2])).toBe(true);
  });

  it('cuts inward-stepping rings clockwise, because the stock is within them', () => {
    const rings = offsetRings(rect(100, 60), 0, 4);
    expect(rings.length).toBeGreaterThan(3);
    for (const r of rings) expect(clockwise(r)).toBe(true);
  });

  it('carries that through to a concentric finishing pass', () => {
    const passes = concentricPasses({
      bounds: { minX: 0, minY: 0, maxX: 60, maxY: 40 },
      stepover: 3,
      resolution: 1,
    });
    expect(passes.length).toBeGreaterThan(2);
    for (const p of passes) expect(clockwise(p)).toBe(true);
  });
});

describe('adaptive clearing rings climb-mill', () => {
  /** A square region of allowed centres, on a 1 mm grid. */
  function region(cols: number, rows: number, inset: number) {
    const mask = new Uint8Array(cols * rows);
    for (let y = inset; y < rows - inset; y++) {
      for (let x = inset; x < cols - inset; x++) mask[y * cols + x] = 1;
    }
    return { mask, cols, rows, mmPerCell: 1, originMm: { x: 0, y: 0 } };
  }

  it('cuts every ring clockwise, because each one steps inward into stock', () => {
    const rings = clearingRings(region(60, 60, 5), 2, 6);
    expect(rings.length).toBeGreaterThan(3);
    for (const ring of rings) {
      for (const loop of ring.loops) {
        expect(loop.length).toBeGreaterThan(3);
        expect(clockwise(loop)).toBe(true);
      }
    }
  });

  it('still reports the first ring as the slot it is', () => {
    const rings = clearingRings(region(60, 60, 5), 2, 6);
    expect(rings[0].engagement).toBe(1);
    expect(rings[1].engagement).toBeCloseTo(2 / 6, 6);
  });
});
