import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateCastPattern, castMetal, DEFAULT_CAST_OPTIONS } from '../src/utils/castPatternExporter';
import { runExportJob } from '../src/utils/exportJobs';
import type { SceneGraph } from '../src/types/scene';

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

// ---------------------------------------------------------------------------
// Jewellery scale — where the sand-foundry rules of thumb used to fall apart
// ---------------------------------------------------------------------------
//
// A comfort-fit silver band: 21 mm across, 5 mm tall, a couple of millimetres
// of metal, and mirror-symmetric about its own mid-height because the inside is
// domed the same way top and bottom. That symmetry is the point of the parting
// tests — pulled upward from the base, the whole lower half of the dome is
// re-entrant; parted at mid-height, nothing is.
function comfortFitRing(): SceneGraph {
  const OUTER = 10.5, BASE_BORE = 9.45, DOME = 0.6, H = 5;
  const SEG = 72, LEVELS = 24;
  const verts: number[] = [];
  const faces: number[] = [];
  const bore = (z: number) => BASE_BORE - DOME * Math.sin((Math.PI * z) / H);
  const push = (r: number, t: number, z: number) => {
    // Scene units are metres; the exporter scales by 1000.
    verts.push((r * Math.cos(t)) / 1000, (r * Math.sin(t)) / 1000, z / 1000);
    return verts.length / 3 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number) => {
    faces.push(a, b, c, a, c, d);
  };
  const outerIdx: number[][] = [];
  const innerIdx: number[][] = [];
  for (let l = 0; l < LEVELS; l++) {
    const z = (H * l) / (LEVELS - 1);
    const o: number[] = [], i: number[] = [];
    for (let s = 0; s < SEG; s++) {
      const t = (2 * Math.PI * s) / SEG;
      o.push(push(OUTER, t, z));
      i.push(push(bore(z), t, z));
    }
    outerIdx.push(o);
    innerIdx.push(i);
  }
  for (let l = 0; l + 1 < LEVELS; l++) {
    for (let s = 0; s < SEG; s++) {
      const n = (s + 1) % SEG;
      quad(outerIdx[l][s], outerIdx[l][n], outerIdx[l + 1][n], outerIdx[l + 1][s]);
      quad(innerIdx[l][n], innerIdx[l][s], innerIdx[l + 1][s], innerIdx[l + 1][n]);
    }
  }
  for (let s = 0; s < SEG; s++) {
    const n = (s + 1) % SEG;
    quad(innerIdx[0][s], innerIdx[0][n], outerIdx[0][n], outerIdx[0][s]); // bottom annulus
    quad(outerIdx[LEVELS - 1][s], outerIdx[LEVELS - 1][n], innerIdx[LEVELS - 1][n], innerIdx[LEVELS - 1][s]);
  }
  return {
    nodes: [
      {
        name: 'ring',
        geoms: [{ name: 'band', type: 'mesh', size: [0.01], renderVertices: verts, faces }],
      },
    ],
  } as unknown as SceneGraph;
}

describe('casting a small part', () => {
  const ring = comfortFitRing();
  const r = generateCastPattern(ring, { metalId: 'silver' });

  it('is the ring we think it is', () => {
    expect(r.success, r.error).toBe(true);
    expect(r.summary.partSizeMm.x).toBeCloseTo(21, 0);
    expect(r.summary.partSizeMm.z).toBeCloseTo(5, 1);
    expect(r.summary.castWeightG).toBeGreaterThan(3);
    expect(r.summary.castWeightG).toBeLessThan(7);
  });

  it('sizes the sprue to the band, not to a sand-foundry floor', () => {
    // The old rule floored the sprue at 8 mm — wider than the 5 mm band is
    // tall, and 50 mm² of channel feeding a ~9 mm² section. A few millimetres
    // is the jeweller's answer, and it must still be thick enough to pour.
    expect(r.summary.sprueDiaMm).toBeGreaterThanOrEqual(2.5);
    expect(r.summary.sprueDiaMm).toBeLessThan(r.summary.partSizeMm.z);
  });

  it('leaves the riser off a part too thin to need one', () => {
    // A band of this modulus freezes in a second or so and feeds back through
    // its own gate; the old rule stuck a 10 mm riser on it regardless.
    expect(r.summary.riserDiaMm).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/no riser/i);
  });

  it('parts at mid-height rather than at the base', () => {
    const atBase = generateCastPattern(ring, { metalId: 'silver', partingFromBaseMm: 0 });
    expect(atBase.summary.undrawablePercent).toBeGreaterThan(1);
    expect(r.summary.partingFromBaseMm).toBeCloseTo(r.summary.partSizeMm.z / 2, 1);
    expect(r.summary.undrawablePercent).toBeLessThan(0.01);
    expect(r.summary.undrawablePercent).toBeLessThan(atBase.summary.undrawablePercent);
    expect(r.warnings.join(' ')).not.toMatch(/overhangs the upward pull/);
  });

  it('honours an explicit parting height unchanged', () => {
    const explicit = generateCastPattern(ring, { metalId: 'silver', partingFromBaseMm: 0 });
    expect(explicit.summary.partingFromBaseMm).toBe(0);
    const high = generateCastPattern(ring, { metalId: 'silver', partingFromBaseMm: 2.5 });
    expect(high.summary.partingFromBaseMm).toBe(2.5);
  });
});

describe('what to melt', () => {
  const ring = comfortFitRing();

  it('counts the metal in the gating it actually printed', () => {
    const silver = castMetal('silver');
    const r = generateCastPattern(ring, { metalId: 'silver' });
    expect(r.summary.gatingVolumeMm3).toBeGreaterThan(0);
    const grow = 1 + silver.shrinkPercent / 100;
    const mould = ((r.summary.partVolumeMm3 * grow ** 3 + r.summary.gatingVolumeMm3) / 1000) * silver.densityGcm3;
    expect(r.summary.pourWeightG).toBeCloseTo(mould + Math.max(1, mould * 0.1), 6);
    // And the gating is a real share of it, not an afterthought on a part this
    // small: the sprue alone outweighs the band.
    expect(r.summary.gatingVolumeMm3).toBeGreaterThan(r.summary.partVolumeMm3 * 0.3);
  });

  it('is not a fixed multiple of the casting', () => {
    const small = generateCastPattern(ring, { metalId: 'aluminium' });
    const big = generateCastPattern(latticeBracketPreset, { metalId: 'aluminium' });
    const ratio = (x: typeof small) => x.summary.pourWeightG / x.summary.castWeightG;
    // The old code returned exactly 1.6 for both. Gating is near-fixed overhead,
    // so it dominates a light part and barely shows on a heavy one.
    expect(ratio(small)).toBeGreaterThan(ratio(big) * 1.5);
  });

  it('drops to the casting plus a handling allowance with no gating', () => {
    const alu = castMetal('aluminium');
    const bare = generateCastPattern(ring, { metalId: 'aluminium', addGating: false });
    expect(bare.summary.gatingVolumeMm3).toBe(0);
    const cast = ((bare.summary.partVolumeMm3 * (1 + alu.shrinkPercent / 100) ** 3) / 1000) * alu.densityGcm3;
    expect(bare.summary.pourWeightG).toBeGreaterThan(cast);
    expect(bare.summary.pourWeightG).toBeLessThan(cast + Math.max(1.01, cast * 0.11));
  });
});

describe('casting a large part', () => {
  it('still scales the rig up', () => {
    const small = generateCastPattern(comfortFitRing(), { metalId: 'aluminium' });
    const big = generateCastPattern(latticeBracketPreset, { metalId: 'aluminium' });
    expect(big.summary.sprueDiaMm).toBeGreaterThan(small.summary.sprueDiaMm);
    expect(big.summary.gatingVolumeMm3).toBeGreaterThan(small.summary.gatingVolumeMm3);
    // A 50 x 60 mm bracket has bulk worth feeding, so it keeps its riser.
    expect(big.summary.riserDiaMm).toBeGreaterThan(0);
    expect(big.summary.riserDiaMm).toBeLessThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Several bodies with a lot of air between them
// ---------------------------------------------------------------------------
//
// The shape of the app's pendulum preset, which is what broke the draw check: a
// flat stand, a thin arm well above it, and a bob higher still, with hundreds of
// millimetres of nothing in between. Nobody sand-casts this in one piece — the
// point is that the number it reports has to stay a share of the part.
function scatteredBodies(): SceneGraph {
  return {
    nodes: [
      { name: 'stand', pos: [0, 0, 0.005], geoms: [{ name: 'g', type: 'box', size: [0.06, 0.06, 0.005] }] },
      { name: 'arm', pos: [0.1, 0, 0.3], geoms: [{ name: 'g', type: 'capsule', size: [0.004, 0.06] }] },
      { name: 'bob', pos: [0.2, 0.05, 0.55], geoms: [{ name: 'g', type: 'sphere', size: [0.02] }] },
    ],
  } as unknown as SceneGraph;
}

describe('a scene of separate bodies', () => {
  const scene = scatteredBodies();

  it('keeps the undrawable share inside 0..100', () => {
    // It used to report 714%, having charged each column the height of the air
    // beneath it rather than the metal within it.
    const r = generateCastPattern(scene, { metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.undrawablePercent).toBeGreaterThanOrEqual(0);
    expect(r.summary.undrawablePercent).toBeLessThanOrEqual(100);
    for (let p = 0; p <= 600; p += 25) {
      const at = generateCastPattern(scene, { metalId: 'aluminium', partingFromBaseMm: p });
      expect(at.summary.undrawablePercent).toBeGreaterThanOrEqual(0);
      expect(at.summary.undrawablePercent).toBeLessThanOrEqual(100);
    }
  });

  it('still says loudly that it will not draw', () => {
    // Bodies floating in mid-air are genuinely re-entrant, whatever the plane.
    const r = generateCastPattern(scene, { metalId: 'aluminium' });
    expect(r.summary.undrawablePercent).toBeGreaterThan(1);
    expect(r.warnings.join(' ')).toMatch(/will not draw cleanly/);
  });

  it("picks a parting plane no worse than the base", () => {
    const auto = generateCastPattern(scene, { metalId: 'aluminium' });
    const base = generateCastPattern(scene, { metalId: 'aluminium', partingFromBaseMm: 0 });
    expect(auto.summary.undrawablePercent).toBeLessThanOrEqual(base.summary.undrawablePercent + 1e-9);
    expect(auto.summary.partingFromBaseMm).toBeGreaterThanOrEqual(0);
    expect(auto.summary.partingFromBaseMm).toBeLessThanOrEqual(auto.summary.partSizeMm.z);
  });
});
