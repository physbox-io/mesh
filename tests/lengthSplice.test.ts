import { describe, it, expect } from 'vitest';
import { splitLengthwise } from '../src/utils/panelSplitter';

/**
 * Splicing a length so it comes off short stock.
 *
 * Mitring a ring fixes the width; this fixes the length. A 300 mm side made of
 * two spliced pieces needs 150 mm offcuts, which is the difference between a
 * job you can do and one you cannot.
 */

/** A plain 300 x 20 length, the shape a mitred ring side reduces to. */
const strip = (len = 300, wide = 20) => [
  { x: 0, y: 0 }, { x: len, y: 0 }, { x: len, y: wide }, { x: 0, y: wide },
];

const area = (poly: { x: number; y: number }[]) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

const extent = (poly: { x: number; y: number }[]) => ({
  len: Math.max(...poly.map((p) => p.x)) - Math.min(...poly.map((p) => p.x)),
  wide: Math.max(...poly.map((p) => p.y)) - Math.min(...poly.map((p) => p.y)),
});

describe('splitting a length', () => {
  it('leaves a length that already fits alone', () => {
    expect(splitLengthwise(strip(300), 320)).toBeNull();
  });

  it('cuts a 300 mm length in two for 160 mm stock', () => {
    const pieces = splitLengthwise(strip(300), 160)!;
    expect(pieces).toHaveLength(2);
    for (const p of pieces) expect(extent(p).len).toBeLessThanOrEqual(160);
  });

  it('cuts into as many pieces as the stock needs', () => {
    expect(splitLengthwise(strip(300), 80)).toHaveLength(4);
    expect(splitLengthwise(strip(300), 110)).toHaveLength(3);
  });

  it('keeps the full width of the length on every piece', () => {
    for (const p of splitLengthwise(strip(300, 20), 160)!) {
      expect(extent(p).wide).toBeCloseTo(20, 1);
    }
  });

  it('loses only the kerf, so the spliced length is the length that was drawn', () => {
    const whole = area(strip(300, 20));
    const pieces = splitLengthwise(strip(300, 20), 160, { kerfMm: 0 })!;
    const total = pieces.reduce((sum, p) => sum + area(p), 0);
    // Fingers move material across the seam, they do not remove any.
    expect(total).toBeCloseTo(whole, 1);
  });

  it('takes a kerf out of the joint rather than leaving the halves oversized', () => {
    const nominal = splitLengthwise(strip(300, 20), 160, { kerfMm: 0 })!;
    const cut = splitLengthwise(strip(300, 20), 160, { kerfMm: 1 })!;
    const sum = (ps: { x: number; y: number }[][]) => ps.reduce((s, p) => s + area(p), 0);
    // Both halves pull back half a kerf from the shared line, so the pair loses
    // one kerf's worth of material along the seam.
    expect(sum(cut)).toBeLessThan(sum(nominal));
  });

  it('cuts a seam that interlocks rather than a straight butt', () => {
    const pieces = splitLengthwise(strip(300, 20), 160, { fingers: 5 })!;
    // A butt seam is 2 corners; a 5-finger seam is many more.
    expect(pieces[0].length).toBeGreaterThan(8);
  });

  it('gives the two halves complementary profiles', () => {
    // Where one half has material at the seam the other must not, or they
    // cannot be pushed together.
    const pieces = splitLengthwise(strip(300, 20), 160, { fingers: 5, kerfMm: 0 })!;
    const seamX = 150;
    const past = (poly: { x: number; y: number }[], beyond: boolean) =>
      poly.filter((p) => (beyond ? p.x > seamX + 0.01 : p.x < seamX - 0.01)).length;
    // The first piece pokes past the line, the second reaches back behind it.
    expect(past(pieces[0], true)).toBeGreaterThan(0);
    expect(past(pieces[1], false)).toBeGreaterThan(0);
  });

  it('refuses when the fingers would be narrower than the stock is thick', () => {
    // A 6 mm wide length cut with 5 fingers gives teeth about a millimetre
    // across, which have no strength at all.
    expect(splitLengthwise(strip(300, 6), 160, { fingers: 5 })).toBeNull();
  });
});

describe('the seam outline', () => {
  /** Cosine of the turn at each vertex; -1 means the edge doubles straight back. */
  const reversals = (poly: { x: number; y: number }[]) =>
    poly.filter((b, i, all) => {
      const a = all[(i + all.length - 1) % all.length];
      const c = all[(i + 1) % all.length];
      const ax = a.x - b.x, ay = a.y - b.y;
      const cx = c.x - b.x, cy = c.y - b.y;
      const la = Math.hypot(ax, ay), lc = Math.hypot(cx, cy);
      if (la < 1e-9 || lc < 1e-9) return true;
      return (ax * cx + ay * cy) / (la * lc) > 0.999;
    }).length;

  it('has no spike where the seam meets the edge of the length', () => {
    /*
     * The bug this catches: both ends of the straight cut line were kept
     * alongside the wave that replaced them, so the outline ran out to the bare
     * cut line and back at each end of the joint — a needle-thin spike at the
     * root of the first and last finger, which cuts as a stray tick.
     */
    for (const piece of splitLengthwise(strip(300, 20), 160, { fingers: 5 })!) {
      expect(reversals(piece)).toBe(0);
    }
  });

  it('keeps every vertex of a spliced piece inside its own bounding box', () => {
    for (const piece of splitLengthwise(strip(300, 20), 160)!) {
      const e = extent(piece);
      expect(e.wide).toBeCloseTo(20, 1);
      expect(e.len).toBeLessThanOrEqual(160);
    }
  });
});
