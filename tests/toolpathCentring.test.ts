import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import type { SceneGraph } from '../src/types/scene';

/**
 * A toolpath line is not a line. It is a slot as wide as the cutter, centred on
 * the line, and every position in a program has to be read that way: a pass
 * whose centreline sits a radius inside the stock cuts exactly to the edge, and
 * one that sits any closer hangs the cutter off the board.
 *
 * These are the invariants that follow, checked on the exporters rather than on
 * the geometry helpers, because the helpers were never where it went wrong —
 * the clearing rings were correct as contours and only became unsafe once they
 * were emitted as tool positions.
 */

function dome(): SceneGraph {
  return {
    nodes: [
      {
        id: 'd',
        name: 'dome',
        type: 'body',
        pos: [0, 0, 0],
        geoms: [{ type: 'sphere', size: [0.05], pos: [0, 0, 0] } as any],
      } as any,
    ],
  } as any;
}

/** Stock sizes and stepovers chosen so the pass pitch does not divide evenly. */
const CASES = [
  { w: 200, d: 200, pct: 15, tool: 6.35 },
  { w: 173, d: 97, pct: 23, tool: 6.35 },
  { w: 150, d: 150, pct: 50, tool: 6.35 },
  { w: 240, d: 111, pct: 37, tool: 3.175 },
] as const;

describe('toolpath centring', () => {
  it.each(CASES)(
    'keeps the whole cutter on the stock — $w x $d, $pct% stepover, $tool mm rougher',
    ({ w, d, pct, tool }) => {
      const res = generateReliefCarveGcode(dome(), {
        ...DEFAULT_RELIEF_OPTIONS,
        stockWidthMm: w,
        stockDepthMm: d,
        finishingStepoverPercent: pct,
        roughingToolDiaMm: tool,
      });
      expect(res.success).toBe(true);

      const radiusFor = (type: string) =>
        (type === 'roughing' ? tool : DEFAULT_RELIEF_OPTIONS.finishingToolDiaMm) / 2;

      for (const seg of res.segments) {
        const radius = radiusFor(seg.type);
        for (const p of seg.points) {
          // The cutter's edge, not its centre, is what has to stay on the board.
          expect(p.x - radius).toBeGreaterThanOrEqual(-1e-6);
          expect(p.y - radius).toBeGreaterThanOrEqual(-1e-6);
          expect(w - p.x - radius).toBeGreaterThanOrEqual(-1e-6);
          expect(d - p.y - radius).toBeGreaterThanOrEqual(-1e-6);
        }
      }
    }
  );

  it.each(CASES)(
    'lays the finishing raster symmetrically about the stock — $w x $d, $pct% stepover',
    ({ w, d, pct, tool }) => {
      const res = generateReliefCarveGcode(dome(), {
        ...DEFAULT_RELIEF_OPTIONS,
        stockWidthMm: w,
        stockDepthMm: d,
        finishingStepoverPercent: pct,
        roughingToolDiaMm: tool,
      });
      expect(res.success).toBe(true);

      const pts = res.segments.filter((s) => s.type === 'finishing').flatMap((s) => s.points);
      expect(pts.length).toBeGreaterThan(0);

      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);

      /*
       * Within one pass pitch, not to the micron.
       *
       * The pass *grid* is exactly symmetric — `axisSamples` shares the
       * leftover of a pitch that does not divide evenly between both margins
       * rather than dumping it all on the far one, which is the property being
       * checked. What is measured here is the extent of the passes that found
       * material to cut, and the outermost pass either side sits on a knife
       * edge: at the very rim of a relief the surface is already at the stock's
       * top face, so whether that pass has anything to cut is decided by the
       * last bit of a float. One pitch is the bound that distinguishes "the
       * layout is centred" from "the leftover all went one way", which is the
       * failure this exists to catch.
       */
      const pitch = DEFAULT_RELIEF_OPTIONS.finishingToolDiaMm * (pct / 100);
      expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - w / 2)).toBeLessThanOrEqual(pitch);
      expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - d / 2)).toBeLessThanOrEqual(pitch);
    }
  );

  it('puts the finishing pass exactly one radius inside the stock it fills', () => {
    const res = generateReliefCarveGcode(dome(), {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 200,
      stockDepthMm: 200,
    });
    expect(res.success).toBe(true);

    const pts = res.segments.filter((s) => s.type === 'finishing').flatMap((s) => s.points);
    const radius = DEFAULT_RELIEF_OPTIONS.finishingToolDiaMm / 2;
    // Cuts right to the edge, and no further: the cutter's edge lands on it.
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(radius, 3);
    expect(Math.max(...pts.map((p) => p.x))).toBeCloseTo(200 - radius, 3);
  });
});
