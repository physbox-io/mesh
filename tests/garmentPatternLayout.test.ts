import { describe, expect, it } from 'vitest';
import { layoutPattern, type PatternPiece } from '../src/utils/cloth/patternSvg';

/** The vertices of an SVG path, mm. */
const vertices = (d: string) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));

/** A thin triangle, its sharpest corner pointing sideways: its mitred allowance reaches far past a box padded by the allowance. */
const spike = (name: string, flip: boolean): PatternPiece => ({
  name,
  uv: flip ? [[0, 0], [0.3, 0.02], [0.3, -0.02]] : [[0.3, 0], [0, 0.02], [0, -0.02]],
  outline: [0, 1, 2],
  strain95: 0,
});

describe('pattern layout', () => {
  it('spaces pieces by their cutting lines, mitred corners and all', () => {
    const L = layoutPattern([spike('a', false), spike('b', true), spike('c', false)], { seamAllowanceMm: 25 });
    for (const p of L.pieces) {
      for (const q of vertices(p.path)) {
        expect(q.x).toBeGreaterThanOrEqual(p.x - 0.11);
        expect(q.x).toBeLessThanOrEqual(p.x + p.w + 0.11);
        expect(q.y).toBeGreaterThanOrEqual(p.y - 0.11);
        expect(q.y).toBeLessThanOrEqual(p.y + p.h + 0.11);
        expect(q.x).toBeLessThanOrEqual(L.width);
        expect(q.y).toBeLessThanOrEqual(L.height);
        expect(q.x).toBeGreaterThanOrEqual(0);
        expect(q.y).toBeGreaterThanOrEqual(0);
      }
    }
    for (let i = 0; i < L.pieces.length; i++) for (let j = i + 1; j < L.pieces.length; j++) {
      const a = L.pieces[i], b = L.pieces[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.name} / ${b.name}`).toBe(true);
    }
  });
});
