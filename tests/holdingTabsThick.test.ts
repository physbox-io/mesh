import { describe, it, expect } from 'vitest';
import { addHoldingTabs, type Heightmap } from '../src/utils/reliefCarveExporter';

/*
 * A holding tab has to join material at least as thick as the tab itself.
 *
 * A piece's edge that tapers down to the spoilboard still counts as part of
 * the piece where it is a tenth of a millimetre thick, and the tabs were
 * centred on the slot between the pieces' outermost cells - so a tapered
 * piece was held on by the foil at its rim, which tears as soon as the
 * cutter pushes on it.
 */

/** '#' is board, 'f' a foil 0.1 mm thick, '.' cut through; 1 mm cells, stock bottom at -10. */
const map = (rows: string[]): Heightmap => {
  const cols = rows[0].length;
  const z = new Float32Array(cols * rows.length);
  rows.forEach((row, r) => [...row].forEach((ch, c) => {
    z[r * cols + c] = ch === '#' ? 0 : ch === 'f' ? -9.9 : -10;
  }));
  return { minX: 0, minY: 0, maxX: cols - 1, maxY: rows.length - 1, cols, rows: rows.length, stepX: 1, stepY: 1, z };
};

/** Whether material at least `minZ` high joins cell `from` to cell `to`. */
function joined(s: Heightmap, minZ: number, from: number, to: number): boolean {
  const seen = new Uint8Array(s.z.length);
  const stack = [from];
  seen[from] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    if (i === to) return true;
    const c = i % s.cols;
    for (const n of [c > 0 ? i - 1 : -1, c < s.cols - 1 ? i + 1 : -1, i - s.cols, i + s.cols]) {
      if (n < 0 || n >= s.z.length || seen[n] || s.z[n] < minZ - 1e-6) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return false;
}

describe('addHoldingTabs on a tapered piece', () => {
  it('ties the piece by its body, not by the foil at its rim', () => {
    // A strip cut free across the board, its edges tapering to foil.
    const rows: string[] = [];
    for (let r = 0; r < 40; r++) {
      if (r < 10 || r >= 30) rows.push('#'.repeat(60));
      else if (r < 14 || r >= 26) rows.push('.'.repeat(60));
      else if (r < 18 || r >= 22) rows.push('f'.repeat(60));
      else rows.push('#'.repeat(60));
    }
    const surface = map(rows);
    const tab = { heightMm: 2, widthMm: 4, spacingMm: 30 };
    const { tabs } = addHoldingTabs(surface, -10, 1, tab);
    expect(tabs).toBeGreaterThanOrEqual(2);
    // From the board above the strip to the strip's own full-height middle,
    // through nothing thinner than a tab.
    expect(joined(surface, -10 + tab.heightMm, 0, 20 * 60 + 30)).toBe(true);
  });
});
