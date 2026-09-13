import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateCastPattern, castMetal, DEFAULT_CAST_OPTIONS } from '../src/utils/castPatternExporter';
import { runExportJob } from '../src/utils/exportJobs';

/** Reads the triangle count out of a binary STL header. */
function stlTriCount(stl: Uint8Array): number {
  return new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
}

describe('green-sand cast pattern', () => {
  const r = generateCastPattern(latticeBracketPreset, { metalId: 'aluminium' });

  it('produces a printable pattern STL', () => {
    expect(r.success, r.error).toBe(true);
    expect(r.patternStl.byteLength).toBe(84 + stlTriCount(r.patternStl) * 50);
    expect(stlTriCount(r.patternStl)).toBeGreaterThan(0);
  });

  it('is the part size, and the pattern is grown by the metal shrink', () => {
    const grow = 1 + castMetal('aluminium').shrinkPercent / 100;
    expect(r.summary.partSizeMm.x).toBeCloseTo(50, 2);
    expect(r.summary.partSizeMm.z).toBeCloseTo(60, 2);
    expect(r.summary.patternSizeMm.x).toBeCloseTo(50 * grow, 2);
    expect(r.summary.patternSizeMm.z).toBeCloseTo(60 * grow, 2);
  });

  it('estimates a cast weight from volume and density', () => {
    expect(r.summary.partVolumeMm3).toBeGreaterThan(0);
    expect(r.summary.castWeightG).toBeCloseTo((r.summary.partVolumeMm3 / 1000) * 2.7, 3);
    expect(r.summary.pourWeightG).toBeGreaterThan(r.summary.castWeightG);
  });

  it('adds gating triangles when asked, and fewer without', () => {
    const withG = generateCastPattern(latticeBracketPreset, { addGating: true });
    const without = generateCastPattern(latticeBracketPreset, { addGating: false });
    expect(stlTriCount(withG.patternStl)).toBeGreaterThan(stlTriCount(without.patternStl));
    expect(withG.summary.sprueDiaMm).toBeGreaterThan(0);
    expect(without.summary.sprueDiaMm).toBe(0);
  });

  it('weighs a denser metal heavier without changing the geometry check', () => {
    const alu = generateCastPattern(latticeBracketPreset, { metalId: 'aluminium' });
    const brass = generateCastPattern(latticeBracketPreset, { metalId: 'brass' });
    expect(brass.summary.castWeightG).toBeGreaterThan(alu.summary.castWeightG);
    expect(brass.summary.undrawablePercent).toBeCloseTo(alu.summary.undrawablePercent, 6);
  });

  it('runs through the shared export-job registry', () => {
    const viaRegistry = runExportJob('cast', latticeBracketPreset, DEFAULT_CAST_OPTIONS);
    expect(viaRegistry.success).toBe(true);
    expect(stlTriCount(viaRegistry.patternStl)).toBeGreaterThan(0);
  });

  it('fails cleanly on an empty scene', () => {
    const empty = generateCastPattern({ nodes: [] }, {});
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/no solid geometry/i);
  });
});
