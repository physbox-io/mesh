import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateCastPattern, DEFAULT_CAST_OPTIONS } from '../src/utils/castPatternExporter';
import { castMetal } from '../src/utils/castMaterials';
import { runExportJob } from '../src/utils/exportJobs';
import type { SceneGraph } from '../src/types/scene';

/** Reads the triangle count out of a binary STL header. */
function stlTriCount(stl: Uint8Array): number {
  return new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
}

describe('sand cast pattern', () => {
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
    expect(r.warnings.join(' ')).toMatch(/riser omitted/i);
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
    expect(r.warnings.join(' ')).toMatch(/overhangs the pull direction/);
  });

  it("picks a parting plane no worse than the base", () => {
    const auto = generateCastPattern(scene, { metalId: 'aluminium' });
    const base = generateCastPattern(scene, { metalId: 'aluminium', partingFromBaseMm: 0 });
    expect(auto.summary.undrawablePercent).toBeLessThanOrEqual(base.summary.undrawablePercent + 1e-9);
    expect(auto.summary.partingFromBaseMm).toBeGreaterThanOrEqual(0);
    expect(auto.summary.partingFromBaseMm).toBeLessThanOrEqual(auto.summary.partSizeMm.z);
  });
});

// ---------------------------------------------------------------------------
// A tall, mostly-empty scene
// ---------------------------------------------------------------------------
//
// The pendulum again, and the other thing it broke. The riser used to be as
// tall as the part's bounding box, so a 620 mm scene of thin rods got a 30 mm
// column 630 mm tall standing beside it: 445 cm³ of aluminium feeding a 550 cm³
// casting, and two full-height rods in the pattern preview that looked, fairly,
// like a bug. A feeder is sized by modulus and proportioned to itself.
function tallSkeletalScene(): SceneGraph {
  return {
    nodes: [
      { name: 'base', pos: [0, 0, 0.01], geoms: [{ name: 'g', type: 'box', size: [0.06, 0.06, 0.01] }] },
      { name: 'post', pos: [0, 0, 0.29], geoms: [{ name: 'g', type: 'cylinder', size: [0.01, 0.28] }] },
      { name: 'arm', pos: [0.11, 0, 0.58], geoms: [{ name: 'g', type: 'capsule', size: [0.005, 0.11] }] },
      { name: 'bob', pos: [0.22, 0, 0.58], geoms: [{ name: 'g', type: 'sphere', size: [0.022] }] },
    ],
  } as unknown as SceneGraph;
}

describe('the rig on a tall scene', () => {
  const scene = tallSkeletalScene();
  const r = generateCastPattern(scene, { metalId: 'aluminium' });

  it('proportions the riser to itself, not to the height of the part', () => {
    expect(r.summary.riserDiaMm).toBeGreaterThan(0);
    // 1.5 diameters tall, so its volume is π/4·D²·1.5D — nothing to do with the
    // 620 mm the part happens to stand.
    const riserVol = (Math.PI * r.summary.riserDiaMm ** 2 * (1.5 * r.summary.riserDiaMm)) / 4;
    expect(r.summary.gatingVolumeMm3).toBeGreaterThan(riserVol);
    expect(riserVol).toBeLessThan(r.summary.partVolumeMm3 * 0.25);
  });

  it('keeps the gating below the casting it feeds', () => {
    expect(r.summary.gatingVolumeMm3).toBeLessThan(r.summary.partVolumeMm3);
    expect(r.warnings.join(' ')).not.toMatch(/gating holds more metal/);
  });

  it('gates into metal, not into the corner of the bounding box', () => {
    // "A sprue to nothing": the runner used to start at half the pattern width,
    // which on this scene is 150 mm out over empty air, with the sprue beyond
    // it. The gate has to land where the parting plane actually cuts metal, and
    // the only thing this plane cuts is the base plate. Pattern coordinates are
    // centred on the bounding box and the box is stretched to +X by the arm, so
    // that plate spans about -151 to -31.
    expect(r.summary.gateAtMm.x).toBeGreaterThan(-155);
    expect(r.summary.gateAtMm.x).toBeLessThan(-28);
    expect(Math.abs(r.summary.gateAtMm.y)).toBeLessThan(65);
    // And the rig is then light enough not to outweigh what it feeds.
    expect(r.summary.gatingVolumeMm3).toBeLessThan(r.summary.partVolumeMm3 * 0.5);
  });

  it('feeds from the heavy end and gates from the far one', () => {
    // The riser belongs by the section that freezes last — the bob out at +X —
    // and the gate at the other end of the metal the plane cuts, so the metal
    // runs the length of the casting towards the feeder. The gate is therefore
    // at the plate's far corner from the bob, not its near one.
    expect(r.summary.riserDiaMm).toBeGreaterThan(0);
    expect(r.summary.gateAtMm.x).toBeLessThan(-90);
  });

  it('fuses the burnout sprue on somewhere that exists', () => {
    const burn = generateCastPattern(scene, { method: 'lost-pla', metalId: 'aluminium' });
    expect(Math.abs(burn.summary.gateAtMm.x)).toBeLessThan(burn.summary.patternSizeMm.x / 2);
    expect(Math.abs(burn.summary.gateAtMm.y)).toBeLessThan(burn.summary.patternSizeMm.y / 2);
  });

  it('says the rig is too big for a home foundry', () => {
    expect(r.warnings.join(' ')).toMatch(/Rig envelope is/);
    const burn = generateCastPattern(scene, { method: 'lost-pla', metalId: 'aluminium' });
    expect(burn.warnings.join(' ')).toMatch(/kg investment/);
  });

  it('still gives a squat part a real feeder', () => {
    // The bracket keeps a real feeder: the fix is about the height rule, not
    // about taking the riser away.
    const big = generateCastPattern(latticeBracketPreset, { metalId: 'aluminium' });
    expect(big.summary.riserDiaMm).toBeGreaterThan(5);
    expect(big.summary.riserDiaMm).toBeLessThanOrEqual(40);
    expect(big.warnings.join(' ')).not.toMatch(/gating holds more metal/);
  });
});

describe('lost-PLA cast pattern', () => {
  const ring = comfortFitRing();
  const sand = generateCastPattern(latticeBracketPreset, { method: 'sand', metalId: 'aluminium' });
  const burn = generateCastPattern(latticeBracketPreset, { method: 'lost-pla', metalId: 'aluminium' });

  it('prints a pattern, with a rig fused on when asked', () => {
    expect(burn.success, burn.error).toBe(true);
    expect(burn.patternStl.byteLength).toBe(84 + stlTriCount(burn.patternStl) * 50);
    const bare = generateCastPattern(latticeBracketPreset, { method: 'lost-pla', addGating: false });
    expect(stlTriCount(burn.patternStl)).toBeGreaterThan(stlTriCount(bare.patternStl));
    expect(burn.summary.gatingVolumeMm3).toBeGreaterThan(0);
    expect(bare.summary.gatingVolumeMm3).toBe(0);
  });

  it('shrinks and weighs the casting exactly as the sand route does', () => {
    expect(burn.summary.patternSizeMm.x).toBeCloseTo(sand.summary.patternSizeMm.x, 6);
    expect(burn.summary.castWeightG).toBeCloseTo(sand.summary.castWeightG, 6);
    expect(burn.summary.method).toBe('lost-pla');
    expect(burn.summary.methodLabel).toMatch(/lost pla/i);
  });

  it('never complains that the pattern will not draw', () => {
    // The whole point of burning it out: the same geometry that fails the sand
    // draw check is fine here, and the figure is reported without the warning.
    const atBase = generateCastPattern(ring, { method: 'sand', metalId: 'silver', partingFromBaseMm: 0 });
    const burnt = generateCastPattern(ring, { method: 'lost-pla', metalId: 'silver', partingFromBaseMm: 0 });
    expect(atBase.warnings.join(' ')).toMatch(/overhangs the pull direction/);
    expect(burnt.summary.undrawablePercent).toBeCloseTo(atBase.summary.undrawablePercent, 6);
    expect(burnt.warnings.join(' ')).not.toMatch(/overhangs the pull direction/);
    expect(burnt.summary.partingFromBaseMm).toBe(0);
  });

  it('feeds through the cup instead of a riser, and says nothing about risers', () => {
    const r = generateCastPattern(ring, { method: 'lost-pla', metalId: 'silver', addRiser: true });
    expect(r.summary.riserDiaMm).toBe(0);
    expect(r.warnings.join(' ')).not.toMatch(/riser/i);
  });

  it('sizes a flask around the rig and the investment to fill it', () => {
    const s = burn.summary;
    // Investment all round the pattern, and taller than the pattern is: the
    // sprue and cup stand above it and the flask has to swallow them.
    expect(s.flaskDiaMm).toBeGreaterThan(Math.hypot(s.patternSizeMm.x, s.patternSizeMm.y));
    expect(s.flaskHeightMm).toBeGreaterThan(s.patternSizeMm.z);
    const flaskVolCm3 = (Math.PI * s.flaskDiaMm ** 2 * s.flaskHeightMm) / 4 / 1000;
    expect(s.investmentPowderG).toBeGreaterThan(0);
    expect(s.investmentPowderG).toBeLessThan(flaskVolCm3 * 1.75);
    // The standard 100:40 mix, and a pattern that costs a sane amount of PLA.
    expect(s.investmentWaterG).toBeCloseTo(s.investmentPowderG * 0.4, 6);
    expect(s.patternPlasticG).toBeGreaterThan(0);
    expect(s.patternPlasticG).toBeLessThan((s.partVolumeMm3 / 1000) * 1.24);
  });

  it('leaves the flask numbers at zero on the sand route', () => {
    expect(sand.summary.flaskDiaMm).toBe(0);
    expect(sand.summary.investmentPowderG).toBe(0);
    expect(sand.summary.patternPlasticG).toBe(0);
  });

  it('fuses sprue+cup and vents as single continuous revolution shells without internal coplanar diaphragms', () => {
    const view = new DataView(burn.patternStl.buffer, burn.patternStl.byteOffset, burn.patternStl.byteLength);
    const count = view.getUint32(80, true);
    // Count horizontal cap triangles (normal.z === +1 or -1) keyed by Z height and XY centroid
    const capFacesByKey = new Map<string, number[]>();
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50;
      const nz = view.getFloat32(o + 8, true);
      if (Math.abs(nz) < 0.999) continue;
      const ax = view.getFloat32(o + 12, true), ay = view.getFloat32(o + 16, true), az = view.getFloat32(o + 20, true);
      const bx = view.getFloat32(o + 24, true), by = view.getFloat32(o + 28, true);
      const cx = view.getFloat32(o + 36, true), cy = view.getFloat32(o + 40, true);
      // Only check above the pattern top where sprue->cup transition lives
      if (az <= burn.summary.patternSizeMm.z + 1) continue;
      const key = `${Math.round(az * 100)}:${Math.round(((ax + bx + cx) / 3) * 10)}:${Math.round(((ay + by + cy) / 3) * 10)}`;
      const list = capFacesByKey.get(key) ?? [];
      list.push(Math.sign(nz));
      capFacesByKey.set(key, list);
    }
    for (const [, signs] of capFacesByKey) {
      const hasUp = signs.includes(1);
      const hasDown = signs.includes(-1);
      expect(hasUp && hasDown).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Feeding the section that freezes last
// ---------------------------------------------------------------------------
//
// A ball on the end of a bar. The bar holds more metal than the ball, so any
// rule that goes by bulk — or by which end of the bounding box is furthest out
// — feeds the bar. The ball is what freezes last and what pulls a sink, and
// modulus is what says so: r/3 for a sphere against roughly half the thickness
// for the bar.
function ballOnABar(): SceneGraph {
  return {
    nodes: [
      { name: 'bar', pos: [0, 0, 0.005], geoms: [{ name: 'g', type: 'box', size: [0.1, 0.005, 0.005] }] },
      { name: 'ball', pos: [0.115, 0, 0.005], geoms: [{ name: 'g', type: 'sphere', size: [0.015] }] },
    ],
  } as unknown as SceneGraph;
}

describe('where the feeder goes', () => {
  const scene = ballOnABar();

  it('puts the burnout sprue on the ball, not on the longer, heavier bar', () => {
    const burn = generateCastPattern(scene, { method: 'lost-pla', metalId: 'aluminium' });
    // The bar is 200 mm of 10 mm section — twice the volume of the 30 mm ball —
    // and it reaches no further, so only modulus tells them apart.
    const ballX = burn.summary.patternSizeMm.x / 2 - 15;
    expect(burn.summary.gateAtMm.x).toBeGreaterThan(ballX - 20);
    expect(Math.abs(burn.summary.gateAtMm.y)).toBeLessThan(8);
  });

  it('stands the sand riser by the ball and gates from the far end of the bar', () => {
    const r = generateCastPattern(scene, { method: 'sand', metalId: 'aluminium' });
    // Feeder at the heavy end, gate at the other, so the metal runs the length
    // of the casting and arrives at the feeder last and hottest.
    expect(r.summary.gateAtMm.x).toBeLessThan(-r.summary.patternSizeMm.x / 4);
  });
});

describe('the sand rig on the print bed', () => {
  /**
   * The pattern's separate pieces, each as its lowest Z and how many distinct
   * vertices it has. The rig's beams are boxes of eight, a few of them sharing
   * corners; its sprue and riser are cylinders of fifty, and the part is the
   * part.
   */
  function pieces(stl: Uint8Array): Array<{ minZ: number; verts: number }> {
    const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    const count = view.getUint32(80, true);
    const ids = new Map<string, number>();
    const z: number[] = [];
    const parent: number[] = [];
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let t = 0; t < count; t++) {
      const vs: number[] = [];
      for (let v = 0; v < 3; v++) {
        const o = 84 + t * 50 + 12 + v * 12;
        const p = [0, 4, 8].map((d) => view.getFloat32(o + d, true));
        const k = p.map((x) => Math.round(x * 1000)).join(',');
        let id = ids.get(k);
        if (id === undefined) {
          id = z.length;
          ids.set(k, id);
          z.push(p[2]);
          parent.push(id);
        }
        vs.push(id);
      }
      parent[find(vs[1])] = find(vs[0]);
      parent[find(vs[2])] = find(vs[0]);
    }
    const groups = new Map<number, { minZ: number; verts: number }>();
    for (let i = 0; i < z.length; i++) {
      const g = groups.get(find(i)) ?? { minZ: Infinity, verts: 0 };
      g.minZ = Math.min(g.minZ, z[i]);
      g.verts++;
      groups.set(find(i), g);
    }
    return [...groups.values()];
  }

  it('stands the sprue and the riser on the bed when the plane is above it', () => {
    const r = generateCastPattern(ballOnABar(), { method: 'sand', metalId: 'aluminium', partingFromBaseMm: 5 });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.riserDiaMm).toBeGreaterThan(0);
    const solids = pieces(r.patternStl).filter((p) => p.verts > 24);
    // The part, the sprue and the riser.
    expect(solids.length).toBeGreaterThanOrEqual(3);
    for (const p of solids) expect(p.minZ).toBeCloseTo(0, 3);
  });

  function signedVolumeMm3(stl: Uint8Array): number {
    const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    const count = view.getUint32(80, true);
    let vol6 = 0;
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12;
      const ax = view.getFloat32(o, true), ay = view.getFloat32(o + 4, true), az = view.getFloat32(o + 8, true);
      const bx = view.getFloat32(o + 12, true), by = view.getFloat32(o + 16, true), bz = view.getFloat32(o + 20, true);
      const cx = view.getFloat32(o + 24, true), cy = view.getFloat32(o + 28, true), cz = view.getFloat32(o + 32, true);
      vol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    return vol6 / 6;
  }

  it('winds runner and riser neck beams outward so gating adds positive signed volume and stops at the coin rim', () => {
    const coin: SceneGraph = {
      nodes: [{
        id: 'coin',
        name: 'coin',
        type: 'body',
        pos: [0, 0, 0.01],
        geoms: [{ type: 'cylinder', size: [0.05, 0.01] }],
      }],
    };
    const bare = generateCastPattern(coin, { method: 'sand', metalId: 'bronze', addGating: false });
    const gated = generateCastPattern(coin, { method: 'sand', metalId: 'bronze', addGating: true });
    expect(bare.success).toBe(true);
    expect(gated.success).toBe(true);
    const bareVol = signedVolumeMm3(bare.patternStl);
    const gatedVol = signedVolumeMm3(gated.patternStl);
    // Outward-wound gating must strictly increase the STL's signed volume by ~gatingVolumeMm3.
    expect(gatedVol - bareVol).toBeGreaterThan(gated.summary.gatingVolumeMm3 * 0.85);
    // Riser neck must stop near the outer rim (~50 mm radius), not run a slot to the coin center (0, 0).
    expect(gated.summary.gatingVolumeMm3).toBeLessThan(80000);
  });
});


describe('a parting height on a model drafted by Prepare for Casting', () => {
  const prepped = {
    ...latticeBracketPreset,
    castPrep: { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, method: 'sand', originals: {}, skipped: [] },
  } as unknown as SceneGraph;
  const auto = generateCastPattern(prepped, { metalId: 'aluminium' });

  it('parts where the draft was tapered from, and says so, rather than where it was asked', () => {
    expect(auto.success, auto.error).toBe(true);
    const asked = auto.summary.partingFromBaseMm + 20;
    const r = generateCastPattern(prepped, { metalId: 'aluminium', partingFromBaseMm: asked });
    expect(r.summary.partingFromBaseMm).toBeCloseTo(auto.summary.partingFromBaseMm, 6);
    expect(r.warnings.some((w) => /draft was prepared there/.test(w))).toBe(true);
  });

  it('says nothing when the height asked is the prepared one', () => {
    const r = generateCastPattern(prepped, { metalId: 'aluminium', partingFromBaseMm: auto.summary.partingFromBaseMm });
    expect(r.warnings.some((w) => /draft was prepared there/.test(w))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Burnout vents: one for every pocket that would trap air
// ---------------------------------------------------------------------------
//
// Investment does not breathe the way sand does, so any high point the metal
// rises into and cannot leave holds its air there. That is every local top of
// the cavity, not the two highest points of it.

const box = (name: string, x: number, y: number, z: number, hx: number, hy: number, hz: number) => ({
  name,
  pos: [x / 1000, y / 1000, z / 1000],
  geoms: [{ name: 'g', type: 'box', size: [hx / 1000, hy / 1000, hz / 1000] }],
});

/** A 120 x 40 x 10 mm plate with bosses topping out at 40, 30 and 22 mm, at x = -40, 0, 40. */
function bossPlate(): SceneGraph {
  return {
    nodes: [
      box('plate', 0, 0, 5, 60, 20, 5),
      box('tall', -40, 0, 25, 6, 6, 15),
      box('mid', 0, 0, 20, 6, 6, 10),
      box('low', 40, 0, 16, 6, 6, 6),
    ],
  } as unknown as SceneGraph;
}

/**
 * A post with a high arm and, under the arm, a low arm ending in a 4 mm bump:
 * the bump's top is a pocket the heightmap from above never sees, because the
 * high arm is over it.
 */
function bumpUnderLedge(): SceneGraph {
  return {
    nodes: [
      box('post', -30, 0, 25, 8, 8, 25),
      box('high', 0, 0, 45, 30, 8, 5),
      box('low', 0, 0, 5, 30, 8, 5),
      box('bump', 20, 0, 12, 4, 4, 2),
    ],
  } as unknown as SceneGraph;
}

/** Plan positions of the pattern's vents in part terms (shrink taken out). */
function ventsNear(r: ReturnType<typeof generateCastPattern>, x: number, y: number, within: number) {
  const grow = 1 + r.summary.shrinkPercent / 100;
  return r.summary.ventsMm.filter((v) => Math.hypot(v.x / grow - x, v.y / grow - y) < within);
}

describe('burnout vents', () => {
  it('vents every boss the sprue is not on, not just the two highest', () => {
    const r = generateCastPattern(bossPlate(), { method: 'lost-pla', metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    const grow = 1 + r.summary.shrinkPercent / 100;
    const sprueX = r.summary.gateAtMm.x / grow;
    for (const bx of [-40, 0, 40]) {
      if (Math.abs(sprueX - bx) < 8) continue;
      expect(ventsNear(r, bx, 0, 8).length, `boss at x=${bx}`).toBeGreaterThanOrEqual(1);
    }
    // Each vent leaves from the top of its boss, where the air collects.
    for (const v of r.summary.ventsMm) {
      const top = [[-40, 40], [0, 30], [40, 22]].find(([bx]) => Math.abs(v.x / grow - bx) < 8);
      if (top) expect(v.z / grow).toBeCloseTo(top[1], 0);
    }
  });

  it('finds a pocket under a ledge and vents it up through the ledge', () => {
    const r = generateCastPattern(bumpUnderLedge(), { method: 'lost-pla', metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    const grow = 1 + r.summary.shrinkPercent / 100;
    const under = ventsNear(r, 20, 0, 5).filter((v) => Math.abs(v.z / grow - 14) < 1);
    expect(under).toHaveLength(1);
    // The vent rod is metal only where the ledge is not, so the pour is not
    // charged twice for the 10 mm of arm it passes through.
    const without = generateCastPattern(bumpUnderLedge(), { method: 'lost-pla', metalId: 'aluminium', addGating: false });
    expect(r.summary.gatingVolumeMm3).toBeGreaterThan(0);
    expect(r.summary.pourWeightG).toBeGreaterThan(without.summary.pourWeightG);
  });

  it('puts no vent on a block the sprue already vents, and says nothing about it', () => {
    const block = { nodes: [box('block', 0, 0, 10, 15, 15, 10)] } as unknown as SceneGraph;
    const r = generateCastPattern(block, { method: 'lost-pla', metalId: 'bronze' });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.ventsMm.length).toBeLessThanOrEqual(1);
    expect(r.warnings.join(' ')).not.toMatch(/vent/i);
  });

  it('vents at most twelve pockets and says how many it left', () => {
    const nodes = [box('plate', 0, 0, 3, 100, 100, 3)];
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) nodes.push(box(`b${i}${j}`, -80 + 40 * i, -80 + 40 * j, 8, 4, 4, 2));
    const r = generateCastPattern({ nodes } as unknown as SceneGraph, { method: 'lost-pla', metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.ventsMm).toHaveLength(12);
    expect(r.warnings.join(' ')).toMatch(/trapped in \d+ places; the 12 deepest are vented/);
  });

  it('leaves the sand route and an ungated pattern without vents', () => {
    expect(generateCastPattern(bossPlate(), { method: 'sand' }).summary.ventsMm).toHaveLength(0);
    expect(generateCastPattern(bossPlate(), { method: 'lost-pla', addGating: false }).summary.ventsMm).toHaveLength(0);
  });
});

// The cases a review of the first version found it getting wrong. Scenes of
// separate primitives, as Mesh users build them: bodies sharing a floor,
// standing on one another, touching face to face.
describe('burnout vents on scenes of separate bodies', () => {
  const lost = (scene: SceneGraph) => generateCastPattern(scene, { method: 'lost-pla', metalId: 'aluminium' });
  const grown = (r: ReturnType<typeof generateCastPattern>) => 1 + r.summary.shrinkPercent / 100;
  const pockets = (r: ReturnType<typeof generateCastPattern>) => r.summary.ventsMm.filter((v) => v.reason === 'pocket');

  it('sees pins that share the floor with the block the sprue stands on', () => {
    // All from z = 0: a winding count over the raw scene used to drop the
    // pins' entries and read the sprue as a dead end.
    const r = lost({ nodes: [
      box('plate', 0, 0, 2.5, 60, 15, 2.5),
      box('block', -40, 0, 15, 15, 15, 15),
      box('pinA', 20, 0, 12, 1.5, 1.5, 12),
      box('pinB', 45, 0, 11, 1.5, 1.5, 11),
    ] } as unknown as SceneGraph);
    expect(r.success, r.error).toBe(true);
    expect(ventsNear(r, 20, 0, 3).length, 'pin A').toBe(1);
    expect(ventsNear(r, 45, 0, 3).length, 'pin B').toBe(1);
    expect(r.warnings.join(' ')).not.toMatch(/not joined/);
  });

  it('puts no pocket vent where one body stands on another', () => {
    const r = lost(bossPlate());
    const g = grown(r);
    for (const v of pockets(r)) {
      expect([-40, 0, 40].some((bx) => Math.abs(v.x / g - bx) < 8), `vent at ${v.x / g},${v.y / g}`).toBe(true);
    }
  });

  it('finds no phantom pockets on the diagonal of a square top', () => {
    const r = lost({ nodes: [box('block', 0, 0, 10, 50, 50, 10), box('pin', 30, 30, 30, 1.5, 1.5, 10)] } as unknown as SceneGraph);
    const g = grown(r);
    for (const v of pockets(r)) expect(Math.hypot(v.x / g - 30, v.y / g - 30), `vent at ${v.x / g},${v.y / g}`).toBeLessThan(3);
  });

  it('vents two blind pins side by side, each its own pocket', () => {
    const r = lost({ nodes: [
      box('plate', 0, 0, 2.5, 60, 15, 2.5),
      box('block', -40, 0, 15, 15, 15, 15),
      box('pinA', 30, 0, 12, 1.5, 1.5, 12),
      box('pinB', 38, 0, 11, 1.5, 1.5, 11),
    ] } as unknown as SceneGraph);
    expect(ventsNear(r, 30, 0, 3).length).toBe(1);
    expect(ventsNear(r, 38, 0, 3).length).toBe(1);
  });

  it('gives a boss studded with small bumps one vent, not one per bump', () => {
    const nodes = [box('plate', 0, 0, 2.5, 60, 15, 2.5), box('block', -40, 0, 15, 15, 15, 15), box('boss', 35, 0, 10, 6, 6, 10)];
    for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) nodes.push(box(`bump${dx}${dy}`, 35 + dx, dy, 20.25, 1, 1, 0.25));
    const r = lost({ nodes } as unknown as SceneGraph);
    expect(ventsNear(r, 35, 0, 7)).toHaveLength(1);
  });

  it('puts the vent in the middle of a flat ceiling, not on its corner', () => {
    const r = lost({ nodes: [
      box('plate', 0, 0, 2.5, 60, 15, 2.5),
      box('block', -40, 0, 15, 15, 15, 15),
      box('boss', 30, 0, 10, 10, 10, 10),
    ] } as unknown as SceneGraph);
    const [v] = ventsNear(r, 30, 0, 12);
    const g = grown(r);
    expect(v).toBeDefined();
    expect(Math.hypot(v.x / g - 30, v.y / g)).toBeLessThan(4);
  });

  it('never runs a vent into the cup or the sprue, leaning it out under the cup instead', () => {
    // A pin 7 mm from a block's middle, where the sprue lands: a straight rod
    // would break into the cup.
    const r = lost({ nodes: [box('block', 0, 0, 5, 12, 12, 5), box('pin', 7, 0, 15, 1.5, 1.5, 5)] } as unknown as SceneGraph);
    expect(r.success, r.error).toBe(true);
    const g = grown(r);
    expect(ventsNear(r, 7, 0, 3).length + (r.warnings.join(' ').match(/no vent fits clear of the sprue/) ? 1 : 0)).toBe(1);
    // At the rim — the top of the rig — every point is either the cup's own
    // or a vent's, standing clear outside the cup: read off the STL.
    const view = new DataView(r.patternStl.buffer, r.patternStl.byteOffset, r.patternStl.byteLength);
    const count = view.getUint32(80, true);
    const sx = r.summary.gateAtMm.x, sy = r.summary.gateAtMm.y;
    const pts: number[][] = [];
    let rim = -Infinity;
    for (let t = 0; t < count; t++) {
      for (let k = 0; k < 3; k++) {
        const o = 84 + t * 50 + 12 + k * 12;
        const p = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
        pts.push(p);
        rim = Math.max(rim, p[2]);
      }
    }
    const cupR = Math.max(1.5 * r.summary.sprueDiaMm, 9);
    const atRim = pts.filter((p) => Math.abs(p[2] - rim) < 1e-3).map((p) => Math.hypot(p[0] - sx, p[1] - sy));
    // Clear of the cup's lip by a splash's width.
    expect(atRim.every((d) => d <= cupR + 0.01 || d >= cupR + 3.9)).toBe(true);
    expect(atRim.some((d) => d >= cupR + 3.9), 'a vent reaches the rim').toBe(true);
    void g;
  });

  it('roots a vent in a thin ceiling, never above it', () => {
    // Laid out symmetric about x = 0, so pattern and scene share their centre.
    const r = lost({ nodes: [
      box('block', -32, 0, 15, 8, 12, 15),
      box('arm', 8, 0, 12, 32, 4, 2),
      box('cap', 36, 0, 20.25, 4, 4, 0.25),
      box('stem', 33, 0, 17, 1, 1, 3), // at the cap's edge: its middle is 0.5 mm of metal
    ] } as unknown as SceneGraph);
    const g = grown(r);
    const [v] = ventsNear(r, 36, 0, 4);
    expect(v).toBeDefined();
    // The STL has the rod's foot at or below the ceiling it leaves from.
    const view = new DataView(r.patternStl.buffer, r.patternStl.byteOffset, r.patternStl.byteLength);
    let lowest = Infinity;
    for (let t = 0; t < view.getUint32(80, true); t++) {
      for (let k = 0; k < 3; k++) {
        const o = 84 + t * 50 + 12 + k * 12;
        const x = view.getFloat32(o, true), y = view.getFloat32(o + 4, true), z = view.getFloat32(o + 8, true);
        if (Math.hypot(x - v.x, y - v.y) < 0.01) lowest = Math.min(lowest, z);
      }
    }
    expect(lowest).toBeLessThanOrEqual(v.z);
    expect(lowest).toBeGreaterThan(20 * g);
  });

  it('vents the far end of a long flat plate, where the metal drives the air', () => {
    const r = lost({ nodes: [box('plate', 0, 0, 2.5, 50, 50, 2.5), box('lump', -40, -40, 6, 8, 8, 6)] } as unknown as SceneGraph);
    const far = r.summary.ventsMm.filter((v) => v.reason === 'far-end');
    expect(far).toHaveLength(1);
    expect(far[0].x).toBeGreaterThan(20);
    expect(far[0].y).toBeGreaterThan(20);
  });

  it('says so when a body is not joined to the one the sprue feeds, and does not vent it', () => {
    const r = lost({ nodes: [box('a', -30, 0, 10, 10, 10, 10), box('b', 30, 0, 5, 5, 5, 5)] } as unknown as SceneGraph);
    expect(r.warnings.join(' ')).toMatch(/not joined to the rest/);
    expect(ventsNear(r, 30, 0, 6)).toHaveLength(0);
  });
});

// A second review's cases: thin shells and slopes the planner's grid broke
// apart, a blocked pocket hiding ventable air, far ends measured in a
// straight line, flats vented at the wrong end, rods wider than their feature.
describe('burnout vents on thin walls, far ends and fine features', () => {
  const lost = (scene: SceneGraph) => generateCastPattern(scene, { method: 'lost-pla', metalId: 'aluminium' });
  const grown = (r: ReturnType<typeof generateCastPattern>) => 1 + r.summary.shrinkPercent / 100;
  const turned = (name: string, x: number, y: number, z: number, hx: number, hy: number, hz: number, q: number[]) =>
    ({ ...box(name, x, y, z, hx, hy, hz), quat: q });
  const aboutZ = (deg: number) => [Math.cos((deg * Math.PI) / 360), 0, 0, Math.sin((deg * Math.PI) / 360)];
  const aboutY = (deg: number) => [Math.cos((deg * Math.PI) / 360), 0, Math.sin((deg * Math.PI) / 360), 0];
  /** Pattern vents in scene terms, for a scene whose bounding box is centred on (cx, cy). */
  const near = (r: ReturnType<typeof generateCastPattern>, x: number, y: number, within: number, cx = 0, cy = 0) =>
    ventsNear(r, x - cx, y - cy, within);

  it('keeps a 1.5 mm ring wall, 200 mm across, in one piece', () => {
    const nodes = [box('hub', 0, 0, 10, 12, 12, 10)];
    const segs = 48, R = 100;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * 360;
      const t = (a * Math.PI) / 180;
      nodes.push(turned(`w${i}`, R * Math.cos(t), R * Math.sin(t), 10, 0.75, (Math.PI * R) / segs + 0.6, 10, aboutZ(a)));
    }
    for (let i = 0; i < 4; i++) {
      const a = i * 90;
      const t = (a * Math.PI) / 180;
      nodes.push(turned(`s${i}`, 56 * Math.cos(t), 56 * Math.sin(t), 2, 45, 2, 2, aboutZ(a)));
    }
    const r = lost({ nodes } as unknown as SceneGraph);
    expect(r.success, r.error).toBe(true);
    expect(r.warnings.join(' ')).not.toMatch(/not joined/);
  });

  it('keeps a 1.5 mm bar running at 45° in one piece', () => {
    const r = lost({ nodes: [
      box('block', -80, -80, 10, 15, 15, 10),
      turned('bar', 0, 0, 3, 110, 0.75, 3, aboutZ(45)),
    ] } as unknown as SceneGraph);
    expect(r.warnings.join(' ')).not.toMatch(/not joined/);
  });

  it('keeps a thin plate on a steep slope joined, and vents the pocket at its top edge', () => {
    const r = lost({ nodes: [
      box('slab', 0, 0, 2.5, 150, 20, 2.5),
      box('block', -120, 0, 15, 15, 15, 15),
      turned('fin', 120, 0, 38.6, 40, 15, 0.75, aboutY(-60)),
    ] } as unknown as SceneGraph);
    expect(r.warnings.join(' ')).not.toMatch(/not joined/);
    const g = grown(r);
    expect(r.summary.ventsMm.some((v) => v.z / g > 65 && v.x / g > 125)).toBe(true);
  });

  it('still vents the rest of a pocket when its highest point sits too close to the sprue', () => {
    // Bounding box x -12..32, centred on 10.
    const r = lost({ nodes: [
      box('block', 0, 0, 5, 12, 12, 5),
      box('pin', 5.5, 0, 15, 1.5, 1.5, 5),
      box('arm', 18.75, 0, 11, 13.25, 1.5, 1),
      box('bump', 30, 0, 15.5, 1.5, 1.5, 3.5),
    ] } as unknown as SceneGraph);
    expect(near(r, 30, 0, 3, 10).length, 'the bump').toBe(1);
  });

  it('vents the far tip of a horseshoe sprued at the other tip, not its bend', () => {
    const r = lost({ nodes: [
      box('legA', 0, 40, 3, 50, 5, 3),
      box('legB', 0, -40, 3, 50, 5, 3),
      box('bend', 50, 0, 3, 5, 45, 3),
      box('lump', -45, 40, 10, 10, 5, 10),
    ] } as unknown as SceneGraph);
    expect(near(r, -45, -40, 15).length).toBeGreaterThanOrEqual(1);
  });

  it('vents both ends of a bar fed from its middle', () => {
    const r = lost({ nodes: [box('bar', 0, 0, 3, 100, 5, 3), box('lump', 0, 0, 10, 10, 10, 10)] } as unknown as SceneGraph);
    expect(near(r, -95, 0, 15).length, 'left end').toBeGreaterThanOrEqual(1);
    expect(near(r, 95, 0, 15).length, 'right end').toBeGreaterThanOrEqual(1);
  });

  it('vents a long rib at its far end from the sprue, where the driven air ends up', () => {
    const r = lost({ nodes: [
      box('plate', 0, 0, 2.5, 80, 15, 2.5),
      box('block', -60, 0, 15, 15, 15, 15),
      box('rib', 30, 0, 12.5, 40, 5, 7.5),
    ] } as unknown as SceneGraph);
    const g = grown(r);
    const onRib = r.summary.ventsMm.filter((v) => Math.abs(v.z / g - 20) < 0.5);
    expect(onRib.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...onRib.map((v) => v.x / g))).toBeGreaterThan(50);
  });

  it('gives a 1.5 mm pin a rod no wider than the pin, standing on it', () => {
    const r = lost({ nodes: [
      box('plate', 0, 0, 2.5, 60, 15, 2.5),
      box('block', -40, 0, 15, 15, 15, 15),
      box('pin', 40, 0, 12.5, 0.75, 0.75, 7.5),
    ] } as unknown as SceneGraph);
    const g = grown(r);
    const [v] = near(r, 40, 0, 1);
    expect(v, 'a vent on the pin').toBeDefined();
    // Every pattern vertex round the vent's axis, above the pin, lies within the pin's half-width.
    const view = new DataView(r.patternStl.buffer, r.patternStl.byteOffset, r.patternStl.byteLength);
    let widest = 0;
    for (let t = 0; t < view.getUint32(80, true); t++) {
      for (let k = 0; k < 3; k++) {
        const o = 84 + t * 50 + 12 + k * 12;
        const x = view.getFloat32(o, true), y = view.getFloat32(o + 4, true), z = view.getFloat32(o + 8, true);
        const d = Math.hypot(x - v.x, y - v.y);
        // Above the pin's own top face, whose corners stand further out than its half-width.
        if (z > v.z + 0.05 && d < 3) widest = Math.max(widest, d);
      }
    }
    expect(widest).toBeLessThanOrEqual(0.76 * g + 0.05);
  });
});

// A hollow hemisphere, rim down on the base, 3 mm wall: a bowl turned over.
function domeShell(R = 0.03, r = 0.027, n = 32, m = 12): SceneGraph {
  const v: number[] = [];
  const f: number[] = [];
  const ring = (rad: number) => {
    const base = v.length / 3;
    for (let j = 0; j <= m; j++) {
      for (let i = 0; i < n; i++) {
        const el = (j / m) * (Math.PI / 2), az = (i / n) * 2 * Math.PI;
        // Z-up, written Y-up as mesh vertices are.
        v.push(rad * Math.cos(el) * Math.cos(az), rad * Math.sin(el), -rad * Math.cos(el) * Math.sin(az));
      }
    }
    return base;
  };
  const o = ring(R), q = ring(r);
  const at = (b: number, j: number, i: number) => b + j * n + (i % n);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      f.push(at(o, j, i), at(o, j, i + 1), at(o, j + 1, i + 1), at(o, j, i), at(o, j + 1, i + 1), at(o, j + 1, i));
      f.push(at(q, j, i), at(q, j + 1, i + 1), at(q, j, i + 1), at(q, j, i), at(q, j + 1, i), at(q, j + 1, i + 1));
    }
  }
  for (let i = 0; i < n; i++) f.push(at(o, 0, i), at(q, 0, i + 1), at(o, 0, i + 1), at(o, 0, i), at(q, 0, i), at(q, 0, i + 1));
  return { nodes: [{ id: 'd', name: 'dome', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'mesh', vertices: v, faces: f }], joints: [], children: [] }] } as unknown as SceneGraph;
}

describe('sand draw check on round work', () => {
  it('reads a solid ball as solid: parted at its middle, nothing is undrawable', () => {
    // The columns are 32-bit floats; compared exactly they read as hollow, and 12% was undrawable.
    const ball = { nodes: [{ id: 'b', name: 'ball', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'sphere', size: [0.03], pos: [0, 0, 0.03] }], joints: [], children: [] }] } as unknown as SceneGraph;
    const r = generateCastPattern(ball, { method: 'sand', metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.undrawablePercent).toBeLessThan(0.5);
    expect(r.summary.partingFromBaseMm).toBeCloseTo(30, 0);
    expect(r.warnings.join(' ')).not.toMatch(/overhangs the pull/);
  });

  it('draws a bowl parted at its rim: the sand inside it is a core, not an undercut', () => {
    const r = generateCastPattern(domeShell(), { method: 'sand', metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.undrawablePercent).toBeLessThan(0.5);
    expect(r.summary.partingFromBaseMm).toBeCloseTo(0, 1);
  });

  it('still finds a mushroom\'s cap undrawable from its foot: that sand is open round the side', () => {
    const mushroom = {
      nodes: [{
        id: 'm', name: 'mushroom', type: 'body', pos: [0, 0, 0],
        geoms: [
          { name: 'stem', type: 'cylinder', size: [0.006, 0.015], pos: [0, 0, 0.015] },
          { name: 'cap', type: 'cylinder', size: [0.02, 0.004], pos: [0, 0, 0.034] },
        ],
        joints: [], children: [],
      }],
    } as unknown as SceneGraph;
    const r = generateCastPattern(mushroom, { method: 'sand', metalId: 'aluminium', partingFromBaseMm: 0 });
    expect(r.summary.undrawablePercent).toBeGreaterThan(50);
  });
});

describe('feeding a chunky casting', () => {
  const ball = { nodes: [{ id: 'b', name: 'ball', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'sphere', size: [0.03], pos: [0, 0, 0.03] }], joints: [], children: [] }] } as unknown as SceneGraph;

  it('gives a burnout ball a sprue wide enough to stay liquid until the ball has frozen', () => {
    // Sized for the pour alone it was ⌀5.7 mm on a 990 g bronze ball, and froze long before it.
    const r = generateCastPattern(ball, { method: 'lost-pla', metalId: 'bronze' });
    expect(r.success, r.error).toBe(true);
    // A Ø60 ball's modulus is 10 mm; a round sprue's is a quarter of its diameter.
    expect(r.summary.sprueDiaMm / 4).toBeGreaterThanOrEqual(10);
    expect(r.warnings.join(' ')).not.toMatch(/Gating mass/);
  });

  it('keeps a thin casting\'s burnout sprue thin', () => {
    const plate = { nodes: [{ id: 'p', name: 'plate', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'box', size: [0.03, 0.02, 0.0015], pos: [0, 0, 0.0015] }], joints: [], children: [] }] } as unknown as SceneGraph;
    expect(generateCastPattern(plate, { method: 'lost-pla', metalId: 'bronze' }).summary.sprueDiaMm).toBeLessThan(8);
  });

  it('stands the sand riser on the neck, with no dead column of metal under it to the bed', () => {
    const r = generateCastPattern(ball, { method: 'sand', metalId: 'aluminium' });
    expect(r.success, r.error).toBe(true);
    expect(r.summary.partingFromBaseMm).toBeCloseTo(30, 0);
    const riserR = r.summary.riserDiaMm / 2;
    // Riser above the plane, sprue and runner: well under the riser carried on down to the bed.
    const fullColumn = Math.PI * riserR * riserR * (riserR * 3 + r.summary.partingFromBaseMm);
    expect(r.summary.gatingVolumeMm3).toBeLessThan(fullColumn - 0.5 * Math.PI * riserR * riserR * r.summary.partingFromBaseMm);
    expect(r.warnings.join(' ')).not.toMatch(/Gating mass/);
  });
});
