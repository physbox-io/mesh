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
    expect(r.warnings.join(' ')).toMatch(/bigger than most home foundries/);
    const burn = generateCastPattern(scene, { method: 'lost-pla', metalId: 'aluminium' });
    expect(burn.warnings.join(' ')).toMatch(/kg of investment/);
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
    expect(atBase.warnings.join(' ')).toMatch(/overhangs the upward pull/);
    expect(burnt.summary.undrawablePercent).toBeCloseTo(atBase.summary.undrawablePercent, 6);
    expect(burnt.warnings.join(' ')).not.toMatch(/overhangs the upward pull/);
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
    expect(r.warnings.some((w) => /Prepare for Casting drafted the walls/.test(w))).toBe(true);
  });

  it('says nothing when the height asked is the prepared one', () => {
    const r = generateCastPattern(prepped, { metalId: 'aluminium', partingFromBaseMm: auto.summary.partingFromBaseMm });
    expect(r.warnings.some((w) => /Prepare for Casting drafted the walls/.test(w))).toBe(false);
  });
});
