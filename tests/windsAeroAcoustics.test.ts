import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import { windInstrumentsPreset } from '../src/presets/windInstruments';
import { hzToNoteInfo } from '../src/utils/acousticTuning';
import {
  evaluateGustWind,
  solveAeroAcousticVoice,
  solveClothSnapPulse,
} from '../src/utils/aeroAcoustics';
import { extractBoreWaveguide, solvePlayableWindVoice } from '../src/utils/windAcoustics';
import { KellyLochbaumSynthBank } from '../src/utils/windWaveguideSynth';
import { simulate } from './helpers/simulate';

/** Measures steady-state RMS, autocorrelation pitch (Hz), and periodicity after an attack warmup. */
function measureWaveguideStats(
  bank: KellyLochbaumSynthBank,
  sampleRate: number,
  warmupBlocks = 90,
  measureBlocks = 80,
): { rms: number; pitchHz: number; periodicity: number; hasNonFinite: boolean } {
  const blockL = new Float32Array(128);
  const blockR = new Float32Array(128);
  let hasNonFinite = false;

  for (let b = 0; b < warmupBlocks; b++) {
    bank.render(blockL, blockR);
    for (let i = 0; i < 128; i++) {
      if (!Number.isFinite(blockL[i])) hasNonFinite = true;
    }
  }

  const total = measureBlocks * 128;
  const buf = new Float32Array(total);
  let sumSq = 0;
  for (let b = 0; b < measureBlocks; b++) {
    bank.render(blockL, blockR);
    buf.set(blockL, b * 128);
    for (let i = 0; i < 128; i++) {
      const s = blockL[i];
      if (!Number.isFinite(s)) hasNonFinite = true;
      else sumSq += s * s;
    }
  }

  const rms = Math.sqrt(sumSq / total);
  const minLag = Math.max(4, Math.floor(sampleRate / 2800));
  const maxLag = Math.min(Math.floor(total * 0.45), Math.ceil(sampleRate / 24));
  let r0 = 0;
  for (let i = 0; i < total - maxLag; i++) r0 += buf[i] * buf[i];
  if (!(r0 > 1e-12)) {
    return { rms, pitchHz: 0, periodicity: 0, hasNonFinite };
  }

  const corr = new Float64Array(maxLag + 2);
  let bestR = -1;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let eLag = 0;
    const n = total - maxLag;
    for (let i = 0; i < n; i++) {
      const a = buf[i];
      const b = buf[i + lag];
      sum += a * b;
      eLag += b * b;
    }
    const norm = sum / Math.sqrt(Math.max(1e-18, r0 * eLag));
    corr[lag] = norm;
    if (norm > bestR) {
      bestR = norm;
      bestLag = lag;
    }
  }

  // Pick first strong harmonic-fundamental peak (>= 90% of global max) to avoid subharmonic lag doubling
  const thresh = bestR * 0.90;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= thresh && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      bestLag = lag;
      bestR = corr[lag];
      break;
    }
  }

  const y0 = corr[Math.max(minLag, bestLag - 1)];
  const y1 = corr[bestLag];
  const y2 = corr[Math.min(maxLag, bestLag + 1)];
  const denom = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  const exactLag = bestLag + delta;

  return {
    rms,
    pitchHz: sampleRate / exactLag,
    periodicity: bestR,
    hasNonFinite,
  };
}

/** Builds a watertight hollow cylindrical/conical shell mesh along `dir` (+1 or -1 on X) in Z-up + Y-up coords. */
function makeHollowHornMesh(opts: {
  lengthM: number;
  rMouthIn: number;
  rBellIn: number;
  wallM?: number;
  dir?: 1 | -1;
  nRings?: number;
  nSegs?: number;
}): { vertices: number[]; renderVertices: number[]; faces: number[] } {
  const { lengthM, rMouthIn, rBellIn, wallM = 0.002, dir = 1, nRings = 20, nSegs = 20 } = opts;
  const rv: number[] = [];
  const yup: number[] = [];
  const faces: number[] = [];

  for (let i = 0; i < nRings; i++) {
    const u = i / (nRings - 1);
    const x = dir * (-0.5 * lengthM + u * lengthM);
    const rIn = rMouthIn + (rBellIn - rMouthIn) * Math.pow(u, 1.35);
    const rOut = rIn + wallM;
    for (let s = 0; s < nSegs; s++) {
      const th = (2 * Math.PI * s) / nSegs;
      const cy = Math.cos(th);
      const sz = Math.sin(th);
      // Outer ring vertex (Z-up: x, y, z -> Y-up: x, z, -y)
      rv.push(x, rOut * cy, rOut * sz);
      yup.push(x, rOut * sz, -rOut * cy);
    }
    for (let s = 0; s < nSegs; s++) {
      const th = (2 * Math.PI * s) / nSegs;
      const cy = Math.cos(th);
      const sz = Math.sin(th);
      rv.push(x, rIn * cy, rIn * sz);
      yup.push(x, rIn * sz, -rIn * cy);
    }
  }

  const ringStride = 2 * nSegs;
  const flip = dir < 0;
  const addTri = (a: number, b: number, c: number) => {
    if (flip) faces.push(a, c, b);
    else faces.push(a, b, c);
  };

  for (let i = 0; i + 1 < nRings; i++) {
    const base0 = i * ringStride;
    const base1 = (i + 1) * ringStride;
    for (let s = 0; s < nSegs; s++) {
      const sn = (s + 1) % nSegs;
      // Outer wall (+radial outward normal)
      addTri(base0 + s, base1 + sn, base1 + s);
      addTri(base0 + s, base0 + sn, base1 + sn);
      // Inner wall (-radial normal pointing inward into airway cavity)
      addTri(base0 + nSegs + s, base1 + nSegs + s, base1 + nSegs + sn);
      addTri(base0 + nSegs + s, base1 + nSegs + sn, base0 + nSegs + sn);
    }
  }

  // Cap mouth rim (i = 0, -X normal) and bell rim (i = nRings - 1, +X normal)
  const lastBase = (nRings - 1) * ringStride;
  for (let s = 0; s < nSegs; s++) {
    const sn = (s + 1) % nSegs;
    addTri(s, nSegs + sn, sn);
    addTri(s, nSegs + s, nSegs + sn);
    addTri(lastBase + s, lastBase + sn, lastBase + nSegs + sn);
    addTri(lastBase + s, lastBase + nSegs + sn, lastBase + nSegs + s);
  }

  return { vertices: yup, renderVertices: rv, faces };
}

describe('Wind TMM Bore Solver, Waveguide/Valve Regimes & Aero-Acoustics (Slice 2)', () => {
  it('cancels spherical-wave 1/k_tilde singularities in conical TMM and resolves bass (<55 Hz) & piccolo (>2.2 kHz) modes', () => {
    // 1. Conical saxophone/oboe bore: exact complex `1 / k_tilde` prevents 1,300x imaginary loss blowup at f1!
    const conicalNode: SceneNode = {
      id: 'conical_shawm',
      name: 'Conical Bore Horn',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: {
        exciter: 'reed',
        boreLengthM: 0.62,
        mouthRadiusM: 0.0055,
        bellRadiusM: 0.036,
        flareExponent: 1.15,
      },
      geoms: [{ name: 'body', type: 'cylinder', size: [0.02, 0.31] }],
    };
    const conicalBore = extractBoreWaveguide(conicalNode)!;
    expect(conicalBore.boreShape).not.toBe('cylindrical');
    expect(conicalBore.resonantModesHz.length).toBeGreaterThanOrEqual(4);
    // Fundamental conical mode Q must be sharp and un-crushed (> 8x characteristic impedance)!
    expect(conicalBore.modeImpedancePeaks[0]).toBeGreaterThan(8);
    // Complete harmonic series on a cone: f2 / f1 ≈ 2.0 (unlike cylindrical stopped pipe f2 / f1 ≈ 3.0)
    const ratio21 = conicalBore.resonantModesHz[1] / conicalBore.resonantModesHz[0];
    expect(ratio21).toBeGreaterThan(1.75);
    expect(ratio21).toBeLessThan(2.30);

    // 2. Deep 2.0 m contrabass stopped pipe resolves f1 ≈ 43 Hz (< 55 Hz!) inside widened 28..4504 Hz TMM sweep
    const bassNode: SceneNode = {
      id: 'contrabass_reed',
      name: 'Contrabass Pipe',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.018,
      windInstrument: { exciter: 'reed', boreLengthM: 2.0 },
      geoms: [{ name: 'pipe', type: 'cylinder', size: [0.022, 1.0] }],
    };
    const bassBore = extractBoreWaveguide(bassNode)!;
    expect(bassBore.resonantModesHz[0]).toBeGreaterThan(36);
    expect(bassBore.resonantModesHz[0]).toBeLessThan(50);

    // 3. Short 6.2 cm open fipple whistle resolves f1 > 2200 Hz with open-embouchure end correction (0.85 * r_mouth)
    const whistleNode: SceneNode = {
      id: 'piccolo_whistle',
      name: 'Short Whistle',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.006,
      windInstrument: { exciter: 'flute_jet', boreLengthM: 0.062 },
      geoms: [{ name: 'pipe', type: 'cylinder', size: [0.008, 0.031] }],
    };
    const whistleBore = extractBoreWaveguide(whistleNode)!;
    expect(whistleBore.resonantModesHz[0]).toBeGreaterThan(2200);
    expect(whistleBore.resonantModesHz[0]).toBeLessThan(2900);
    // Verify embouchure end correction adds +0.85 * r_mouth to exactCells compared to closed-mouth reed
    const closedShort = extractBoreWaveguide({
      ...whistleNode,
      windInstrument: { exciter: 'reed', boreLengthM: 0.062 },
    })!;
    expect(whistleBore.exactCells).toBeGreaterThan(closedShort.exactCells + 0.5);
  });

  it('handles 3D quat/box CSG toneholes, intersection clips, Y-up static vertices, -X horn orientation, pos cache, and slide keys', () => {
    // 1. Short Z-axis tube with a `quat`-rotated transverse cylinder cutter + `box` window + `intersection` clip
    const baseTube: SceneNode = {
      id: 'quat_flute',
      name: 'CSG Bore Test',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'reed' },
      geoms: [
        { name: 'outer', type: 'cylinder', size: [0.014, 0.12], pos: [0, 0, 0] },
        { name: 'axial_bore', type: 'cylinder', csg: 'difference', size: [0.0085, 0.122], pos: [0, 0, 0] },
        // `csg: 'intersection'` bounding box is much larger (0.80 m) — must NOT inflate bore length!
        { name: 'chamfer_clip', type: 'box', csg: 'intersection', size: [0.04, 0.04, 0.40], pos: [0, 0, 0] },
        // Derived visual CSG preview mesh alongside authored primitives — `!csgDerived` must stay primary!
        {
          name: 'csg_preview',
          type: 'mesh',
          csgDerived: 'visual',
          vertices: [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5],
          faces: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
          size: [1, 1, 1],
        },
      ],
    };
    const intactBore = extractBoreWaveguide(baseTube)!;
    expect(intactBore.lengthM).toBeCloseTo(0.244, 2);
    expect(intactBore.mouthRadiusM).toBeCloseTo(0.0085, 3);
    expect(intactBore.breachFactor).toBe(0);

    // Add a 90° Y-rotated `quat` cylinder cutter (along X, perpendicular to Z bore!) + transverse `box` slot
    const holedTube: SceneNode = {
      ...baseTube,
      geoms: [
        ...baseTube.geoms,
        {
          name: 'quat_side_hole',
          type: 'cylinder',
          csg: 'difference',
          quat: [Math.SQRT1_2, 0, Math.SQRT1_2, 0], // 90 deg about Y -> cylinder axis along X!
          size: [0.0045, 0.020],
          pos: [0, 0, 0.045],
        },
        {
          name: 'box_window',
          type: 'box',
          csg: 'difference',
          size: [0.016, 0.005, 0.005],
          pos: [0, 0, 0.080],
        },
      ],
    };
    const holedBore = extractBoreWaveguide(holedTube)!;
    expect(holedBore.toneholes.filter((t) => t.fromGeometry).length).toBe(2);
    expect(holedBore.breachFactor).toBeGreaterThan(0.3);
    expect(holedBore.resonantModesHz[0]).toBeGreaterThan(intactBore.resonantModesHz[0] + 20);

    // 2. Baked CSG node with `rawPositives.length === 0` falls back cleanly to `csgDerived === 'visual'` mesh!
    const hornPlusX = makeHollowHornMesh({ lengthM: 0.34, rMouthIn: 0.006, rBellIn: 0.028, dir: 1 });
    const visualOnlyNode: SceneNode = {
      id: 'baked_csg_horn',
      name: 'Baked CSG Horn',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'brass_lip' },
      geoms: [
        {
          name: 'baked_visual',
          type: 'mesh',
          csgDerived: 'visual',
          size: [1, 1, 1],
          vertices: hornPlusX.vertices,
          renderVertices: hornPlusX.renderVertices,
          faces: hornPlusX.faces,
        },
      ],
    };
    const bakedBore = extractBoreWaveguide(visualOnlyNode)!;
    expect(bakedBore.lengthM).toBeGreaterThan(0.30);
    expect(bakedBore.lengthM).toBeLessThan(0.38);
    expect(bakedBore.boreShape).toBe('flared_horn');

    // 3. Static mesh with ONLY Three.js Y-up `vertices` (no `renderVertices`) + `size: [1, 1, 1]`
    const staticYupNode: SceneNode = {
      id: 'static_yup_horn',
      name: 'Static Y-up Horn',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'brass_lip' },
      geoms: [
        {
          name: 'yup_only_mesh',
          type: 'mesh',
          size: [1, 1, 1],
          vertices: hornPlusX.vertices,
          faces: hornPlusX.faces,
        },
      ],
    };
    const yupBore = extractBoreWaveguide(staticYupNode)!;
    expect(yupBore.lengthM).toBeCloseTo(bakedBore.lengthM, 2);
    expect(yupBore.resonantModesHz[0]).toBeCloseTo(bakedBore.resonantModesHz[0], 0);

    // 4. `-X`-oriented conical horn auto-reverses (`s: 0 -> 1`) to match `+X` horn modes & `flared_horn` shape!
    const hornMinusX = makeHollowHornMesh({ lengthM: 0.34, rMouthIn: 0.006, rBellIn: 0.028, dir: -1 });
    const minusXNode: SceneNode = {
      id: 'minus_x_horn',
      name: 'Minus-X Horn',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'brass_lip' },
      geoms: [
        {
          name: 'neg_x_mesh',
          type: 'mesh',
          size: [1, 1, 1],
          renderVertices: hornMinusX.renderVertices,
          faces: hornMinusX.faces,
        },
      ],
    };
    const minusXBore = extractBoreWaveguide(minusXNode)!;
    expect(minusXBore.boreShape).toBe('flared_horn');
    expect(minusXBore.mouthRadiusM).toBeLessThan(minusXBore.bellRadiusM * 0.35);
    expect(Math.abs(minusXBore.resonantModesHz[0] - bakedBore.resonantModesHz[0])).toBeLessThan(12);

    // 5. Shifting `g.pos` on a compound instrument sharing the exact same `(renderVertices, faces)` array updates hole fraction!
    const holeMeshGeom: SceneGeom = {
      name: 'shared_mesh',
      type: 'mesh',
      size: [1, 1, 1],
      renderVertices: hornPlusX.renderVertices,
      faces: hornPlusX.faces,
      pos: [-0.15, 0, 0],
    };
    const shiftedA = extractBoreWaveguide({
      id: 'shift_a',
      name: 'Shift A',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'reed' },
      geoms: [
        holeMeshGeom,
        { name: 'ext', type: 'cylinder', euler: [0, 90, 0], size: [0.008, 0.15], pos: [0.15, 0, 0] },
      ],
    })!;
    const shiftedB = extractBoreWaveguide({
      id: 'shift_b',
      name: 'Shift B',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'reed' },
      geoms: [
        { ...holeMeshGeom, pos: [0.35, 0, 0] },
        { name: 'ext', type: 'cylinder', euler: [0, 90, 0], size: [0.008, 0.15], pos: [0.15, 0, 0] },
      ],
    })!;
    expect(Math.abs(shiftedB.lengthM - shiftedA.lengthM)).toBeGreaterThan(0.05);

    // 6. 2-component closed mesh (intact hollow tube + separate closed ferrule ring, total genus = 2) has ZERO fake breach!
    const ferrule = makeHollowHornMesh({ lengthM: 0.008, rMouthIn: 0.031, rBellIn: 0.031, wallM: 0.002 });
    const vOff = hornPlusX.renderVertices.length / 3;
    const combinedRv = [...hornPlusX.renderVertices, ...ferrule.renderVertices];
    const combinedFaces = [...hornPlusX.faces, ...ferrule.faces.map((idx) => idx + vOff)];
    const twoCompBore = extractBoreWaveguide({
      id: 'two_comp_horn',
      name: 'Two Component Intact Horn',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'brass_lip' },
      geoms: [{ name: 'two_comp', type: 'mesh', size: [1, 1, 1], renderVertices: combinedRv, faces: combinedFaces }],
    })!;
    expect(twoCompBore.breachFactor).toBe(0);
    expect(twoCompBore.toneholes.filter((t) => t.fromGeometry).length).toBe(0);

    // 7. Linear `slide` tonehole pad joint (`q = 0.003 m`) opens cleanly (`openAmount > 0.8`)!
    const slideFlute: SceneNode = {
      id: 'slide_pad_clarinet',
      name: 'Slide Pad Clarinet',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.0075,
      windInstrument: {
        exciter: 'reed',
        boreLengthM: 0.56,
        toneholeJoints: [{ jointName: 'pad_slide_1', axialFraction: 0.65, diameterMm: 8.5 }],
      },
      geoms: [{ name: 'tube', type: 'cylinder', size: [0.012, 0.28] }],
      children: [
        {
          id: 'pad_child',
          name: 'Pad',
          type: 'body',
          pos: [0, 0, 0.05],
          joints: [{ name: 'pad_slide_1', type: 'slide', axis: [0, 0, 1], range: [0, 0.004], limited: true }],
          geoms: [{ name: 'cup', type: 'cylinder', size: [0.006, 0.001], contype: 0, conaffinity: 0 }],
        },
      ],
    };
    const slideOpenBore = extractBoreWaveguide(slideFlute, { pad_slide_1: 0.0032 })!;
    expect(slideOpenBore.toneholes[0].openAmount).toBeGreaterThan(0.8);
  });

  it('seals articulated Clarinet silver keys inside the 22 ms tongue break during live MuJoCo descending passages', async () => {
    const sim = await simulate(windInstrumentsPreset);
    try {
      const clarinetNode = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
      const expectedPhrase: { startSec: number; durSec: number; note: string }[] = [
        // Bar 1: B3 - B3 - C4 - D4
        { startSec: 0.0, durSec: 0.4, note: 'B3' },
        { startSec: 0.4, durSec: 0.4, note: 'B3' },
        { startSec: 0.8, durSec: 0.4, note: 'C4' },
        { startSec: 1.2, durSec: 0.4, note: 'D4' },
        // Bar 2 (descending pad-closing transition!): D4 -> C4 -> B3 -> A3
        { startSec: 1.6, durSec: 0.4, note: 'D4' },
        { startSec: 2.0, durSec: 0.4, note: 'C4' },
        { startSec: 2.4, durSec: 0.4, note: 'B3' },
        { startSec: 2.8, durSec: 0.4, note: 'A3' },
        // Bar 3: G3 - G3 - A3 - B3
        { startSec: 3.2, durSec: 0.4, note: 'G3' },
        { startSec: 3.6, durSec: 0.4, note: 'G3' },
        { startSec: 4.0, durSec: 0.4, note: 'A3' },
        { startSec: 4.4, durSec: 0.4, note: 'B3' },
        // Bar 4 dotted-quarter B3 -> eighth A3 -> half A3 (Phrase 1 half-cadence!)
        { startSec: 4.8, durSec: 0.6, note: 'B3' },
        { startSec: 5.4, durSec: 0.2, note: 'A3' },
        { startSec: 5.6, durSec: 0.8, note: 'A3' },
      ];

      for (const item of expectedPhrase) {
        // Sample just 65 ms into each note (43 ms after the 22 ms tongue break!) — previously took 141 ms to seal!
        const sampleTime = item.startSec + 0.065;
        const dtRun = sampleTime - sim.time();
        if (dtRun > 1e-6) {
          sim.run(dtRun);
        }
        const jointPositions: Record<string, number> = {
          clarinet_key_1: sim.jointPos('clarinet_key_1'),
          clarinet_key_2: sim.jointPos('clarinet_key_2'),
          clarinet_key_3: sim.jointPos('clarinet_key_3'),
          clarinet_key_4: sim.jointPos('clarinet_key_4'),
        };
        const liveBore = extractBoreWaveguide(clarinetNode, jointPositions)!;
        const liveVoice = solvePlayableWindVoice(liveBore, 2.5, 247);
        const info = hzToNoteInfo(liveVoice.pitchHz);
        expect(info.note).toBe(item.note);
        expect(Math.abs(info.cents)).toBeLessThanOrEqual(8);
      }
    } finally {
      sim.dispose();
    }
  });

  it('self-oscillates flute_jet at open-open lambda/2 pitch, sweeps 2nd-order Thiran smoothly, and scales across 44.1/48/96 kHz', () => {
    // 1. Open-open `flute_jet` vs closed-open `reed` on the exact same 64-cell cylindrical bore (~0.465 m):
    //    `flute_jet` must sustain periodic tone (`periodicity > 0.88`, `rms > 0.015`) ~1 octave above `reed`!
    const reedBank = new KellyLochbaumSynthBank(48000);
    reedBank.updateVoices([
      {
        id: 'cyl_reed',
        exciter: 'reed',
        breathKPa: 2.6,
        embouchureHz: 220,
        cellCount: 64,
        exactCells: 64.0,
        junctionK: new Array(63).fill(0),
        bellCutoffHz: 1800,
        shunts: [],
      },
    ]);
    const reedStats = measureWaveguideStats(reedBank, 48000);

    const fluteBank = new KellyLochbaumSynthBank(48000);
    fluteBank.updateVoices([
      {
        id: 'cyl_flute',
        exciter: 'flute_jet',
        breathKPa: 2.8,
        embouchureHz: 370,
        cellCount: 64,
        exactCells: 64.0,
        junctionK: new Array(63).fill(0),
        bellCutoffHz: 2200,
        shunts: [],
      },
    ]);
    const fluteStats = measureWaveguideStats(fluteBank, 48000);
    expect(fluteStats.hasNonFinite).toBe(false);
    expect(fluteStats.rms).toBeGreaterThan(0.015);
    expect(fluteStats.rms).toBeLessThan(0.85);
    expect(fluteStats.periodicity).toBeGreaterThan(0.88);
    // Open-open lambda/2 flute resonates at ~2x the closed-open lambda/4 reed frequency!
    const fluteReedRatio = fluteStats.pitchHz / reedStats.pitchHz;
    expect(fluteReedRatio).toBeGreaterThan(1.75);
    expect(fluteReedRatio).toBeLessThan(2.25);

    // 2. 2nd-order Thiran fractional delay sweep across integer cell boundary (40.0 -> 42.0 in 0.25-cell steps):
    //    Pitch decreases strictly monotonically with zero clamping dead-zones and zero NaN blowups!
    const sweepPitches: number[] = [];
    for (let cells = 40.0; cells <= 42.001; cells += 0.25) {
      const bank = new KellyLochbaumSynthBank(48000);
      bank.updateVoices([
        {
          id: 'thiran_sweep',
          exciter: 'reed',
          breathKPa: 2.6,
          embouchureHz: 350,
          cellCount: Math.floor(cells),
          exactCells: cells,
          junctionK: new Array(Math.floor(cells) - 1).fill(0),
          bellCutoffHz: 1900,
          shunts: [],
        },
      ]);
      const st = measureWaveguideStats(bank, 48000, 90, 65);
      expect(st.hasNonFinite).toBe(false);
      expect(st.periodicity).toBeGreaterThan(0.90);
      sweepPitches.push(st.pitchHz);
    }
    for (let i = 1; i < sweepPitches.length; i++) {
      expect(sweepPitches[i]).toBeLessThan(sweepPitches[i - 1] - 0.3);
    }

    // 3. Multi-sample-rate invariance (`44.1 kHz`, `48 kHz`, `96 kHz`) including valved Cornet (> 250 cells at 96 kHz!)
    const cornetNode = windInstrumentsPreset.nodes.find((n) => n.id === 'brass_bugle_horn')!;
    const valvedBore48 = extractBoreWaveguide(cornetNode, { cornet_valve_1: 0.012, cornet_valve_3: 0.012 }, 48000)!;
    const pitchesBySr: number[] = [];
    for (const sr of [44100, 48000, 96000]) {
      const bank = new KellyLochbaumSynthBank(sr);
      bank.updateVoices([
        {
          id: 'cornet_sr',
          exciter: 'brass_lip',
          breathKPa: 3.6,
          embouchureHz: 440,
          cellCount: valvedBore48.cellCount,
          exactCells: valvedBore48.exactCells,
          sampleRate: valvedBore48.sampleRate,
          junctionK: valvedBore48.junctionK,
          bellCutoffHz: valvedBore48.bellCutoffHz,
          shunts: [],
        },
      ]);
      const st = measureWaveguideStats(bank, sr, Math.round((90 * sr) / 48000), Math.round((80 * sr) / 48000));
      expect(st.hasNonFinite).toBe(false);
      expect(st.rms).toBeGreaterThan(0.012);
      expect(st.periodicity).toBeGreaterThan(0.90);
      pitchesBySr.push(st.pitchHz);
    }
    const cents44To48 = Math.abs(1200 * Math.log2(pitchesBySr[0] / pitchesBySr[1]));
    const cents96To48 = Math.abs(1200 * Math.log2(pitchesBySr[2] / pitchesBySr[1]));
    expect(cents44To48).toBeLessThan(25);
    expect(cents96To48).toBeLessThan(25);

    // 4. Active-first voice slot prioritization: 4 leading silent voices (`breathKPa: 0`) must NOT starve active voice #5!
    const prioBank = new KellyLochbaumSynthBank(48000);
    prioBank.updateVoices([
      { id: 'idle_1', exciter: 'reed', breathKPa: 0, embouchureHz: 260, cellCount: 50, junctionK: [], bellCutoffHz: 1500, shunts: [] },
      { id: 'idle_2', exciter: 'reed', breathKPa: 0, embouchureHz: 260, cellCount: 50, junctionK: [], bellCutoffHz: 1500, shunts: [] },
      { id: 'idle_3', exciter: 'reed', breathKPa: 0, embouchureHz: 260, cellCount: 50, junctionK: [], bellCutoffHz: 1500, shunts: [] },
      { id: 'idle_4', exciter: 'reed', breathKPa: 0, embouchureHz: 260, cellCount: 50, junctionK: [], bellCutoffHz: 1500, shunts: [] },
      { id: 'active_5', exciter: 'reed', breathKPa: 2.8, embouchureHz: 260, cellCount: 56, junctionK: new Array(55).fill(0), bellCutoffHz: 1800, shunts: [] },
    ]);
    const prioStats = measureWaveguideStats(prioBank, 48000);
    expect(prioStats.rms).toBeGreaterThan(0.012);
    expect(prioStats.periodicity).toBeGreaterThan(0.90);
  });

  it('supports Starter #6a flap_valve exciter in windAcoustics, windWaveguideSynth, and modalAudioProcessor.js with safe formant bounds', () => {
    // 1. `extractBoreWaveguide` + `solvePlayableWindVoice` with `exciter: 'flap_valve'`
    const flapSpout: SceneNode = {
      id: 'rubber_flap_spout',
      name: 'Rubber Flap Spout',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.009,
      windInstrument: { exciter: 'flap_valve', boreLengthM: 0.12 },
      geoms: [{ name: 'spout', type: 'cylinder', size: [0.012, 0.06] }],
    };
    const flapBore = extractBoreWaveguide(flapSpout)!;
    expect(flapBore.exciter).toBe('flap_valve');

    const lowFlap = solvePlayableWindVoice(flapBore, 3.2, 42);
    const highFlap = solvePlayableWindVoice(flapBore, 4.0, 175);
    expect(lowFlap.active).toBe(true);
    expect(lowFlap.pitchHz).toBeCloseTo(42, 1);
    expect(highFlap.pitchHz).toBeCloseTo(175, 1);
    expect(lowFlap.phaseCoherence).toBe(1);
    expect(lowFlap.harmonicWeights.length).toBeGreaterThanOrEqual(24);
    // Safe formant separation & DC-slam guard: squelchSweepHz <= min(formantHz, bellLowpassHz) - 110
    expect(lowFlap.bellLowpassHz).toBeGreaterThanOrEqual(lowFlap.formantHz * 1.25);
    expect(lowFlap.squelchSweepHz!).toBeGreaterThan(200);
    expect(lowFlap.squelchSweepHz!).toBeLessThanOrEqual(Math.min(lowFlap.formantHz, lowFlap.bellLowpassHz) - 109.9);

    // Smooth transition across `autonomousFlap = 0.20` on `brass_lip` (zero step discontinuity!)
    const midA = solvePlayableWindVoice({ ...flapBore, exciter: 'brass_lip', resonantModesHz: [600] }, 3.0, 349);
    const midB = solvePlayableWindVoice({ ...flapBore, exciter: 'brass_lip', resonantModesHz: [600] }, 3.0, 347);
    expect(Math.abs(midA.formantQ - midB.formantQ)).toBeLessThan(0.25);
    expect(Math.abs(midA.drive - midB.drive)).toBeLessThan(0.08);

    // 2. `KellyLochbaumSynthBank` autonomous `flap_valve` self-oscillates at sub-resonant `embouchureHz`!
    const flapBankLow = new KellyLochbaumSynthBank(48000);
    flapBankLow.updateVoices([
      {
        id: 'flap_low',
        exciter: 'flap_valve',
        breathKPa: 3.6,
        embouchureHz: 58,
        cellCount: flapBore.cellCount,
        exactCells: flapBore.exactCells,
        junctionK: flapBore.junctionK,
        bellCutoffHz: flapBore.bellCutoffHz,
        shunts: [],
      },
    ]);
    const flapLowStats = measureWaveguideStats(flapBankLow, 48000, 100, 120);
    expect(flapLowStats.hasNonFinite).toBe(false);
    expect(flapLowStats.rms).toBeGreaterThan(0.015);
    expect(flapLowStats.rms).toBeLessThan(0.85);

    const flapBankHigh = new KellyLochbaumSynthBank(48000);
    flapBankHigh.updateVoices([
      {
        id: 'flap_high',
        exciter: 'flap_valve',
        breathKPa: 4.0,
        embouchureHz: 155,
        cellCount: flapBore.cellCount,
        exactCells: flapBore.exactCells,
        junctionK: flapBore.junctionK,
        bellCutoffHz: flapBore.bellCutoffHz,
        shunts: [],
      },
    ]);
    const flapHighStats = measureWaveguideStats(flapBankHigh, 48000, 100, 120);
    expect(flapHighStats.rms).toBeGreaterThan(0.015);
    expect(flapHighStats.pitchHz).toBeGreaterThan(flapLowStats.pitchHz * 1.6);

    // 3. Verify `public/modalAudioProcessor.js` AudioWorklet script also renders both `flute_jet` and `flap_valve`!
    interface MockWorkletInstance {
      port: {
        onmessage: ((ev: { data: unknown }) => void) | null;
        postMessage: (msg: unknown) => void;
      };
      process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
    }
    type MockWorkletCtor = new () => MockWorkletInstance;

    const workletCode = fs.readFileSync(path.resolve(process.cwd(), 'public/modalAudioProcessor.js'), 'utf8');
    let RegisteredCtor: MockWorkletCtor | null = null;
    const fn = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      workletCode,
    );
    class MockWorkletProcessor {
      port = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        postMessage: () => {},
      };
    }
    fn(MockWorkletProcessor, (_name: string, ctor: MockWorkletCtor) => {
      RegisteredCtor = ctor;
    }, 48000);
    expect(RegisteredCtor).toBeTruthy();

    for (const exc of ['flute_jet', 'flap_valve'] as const) {
      const proc = new RegisteredCtor!();
      proc.port.onmessage!({
        data: {
          type: 'WIND_UPDATE',
          voices: [
            {
              id: `wk_${exc}`,
              exciter: exc,
              breathKPa: 3.4,
              embouchureHz: exc === 'flap_valve' ? 75 : 420,
              cellCount: 48,
              exactCells: 48.3,
              junctionK: new Array(47).fill(0),
              bellCutoffHz: 1900,
              shunts: [],
            },
          ],
        },
      });
      const outL = new Float32Array(128);
      const outR = new Float32Array(128);
      let energy = 0;
      for (let b = 0; b < 110; b++) {
        proc.process([], [[outL, outR]]);
        if (b >= 50) {
          for (let i = 0; i < 128; i++) {
            expect(Number.isFinite(outL[i])).toBe(true);
            energy += outL[i] * outL[i];
          }
        }
      }
      expect(Math.sqrt(energy / (60 * 128))).toBeGreaterThan(0.01);
    }
  });

  it('guards NaN/Inf across wind & aero solvers and eliminates aero regime cliffs while scaling Curle wing whoosh', () => {
    // 1. NaN / Infinity poisoning guards across wind solvers
    const nanWind = solvePlayableWindVoice(
      {
        exciter: 'brass_lip',
        bellCutoffHz: Number.NaN,
        muteFactor: Number.NaN,
        breachFactor: Number.POSITIVE_INFINITY,
        resonantModesHz: [Number.NaN, 440],
      },
      Number.NaN,
      Number.NaN,
    );
    expect(nanWind.active).toBe(false);
    expect(Number.isFinite(nanWind.pitchHz)).toBe(true);

    const activeNanEmb = solvePlayableWindVoice(
      {
        exciter: 'reed',
        bellCutoffHz: Number.NaN,
        muteFactor: Number.NaN,
        breachFactor: Number.NaN,
        resonantModesHz: [Number.NaN, 330],
      },
      2.5,
      Number.NaN,
    );
    expect(activeNanEmb.active).toBe(true);
    expect(Number.isFinite(activeNanEmb.pitchHz)).toBe(true);
    expect(activeNanEmb.harmonicWeights.every((w) => Number.isFinite(w))).toBe(true);

    const nanBank = new KellyLochbaumSynthBank(48000);
    nanBank.updateVoices([
      {
        id: 'nan_voice',
        exciter: 'reed',
        breathKPa: 2.5,
        embouchureHz: Number.NaN,
        cellCount: Number.NaN,
        exactCells: Number.POSITIVE_INFINITY,
        junctionK: [Number.NaN, 0.2, Number.NEGATIVE_INFINITY],
        bellCutoffHz: Number.NaN,
        shunts: [{ cell: Number.NaN, coeff: Number.NaN }],
      },
    ]);
    const nanBuf = new Float32Array(128);
    for (let b = 0; b < 20; b++) nanBank.render(nanBuf);
    expect(Array.from(nanBuf).every((v) => Number.isFinite(v))).toBe(true);

    // 2. `evaluateGustWind`, `solveAeroAcousticVoice`, and `solveClothSnapPulse` NaN guards
    expect(evaluateGustWind([1, 0, 0], Number.NaN, 0.5, 1.0, 0, 0, 1)).toEqual([0, 0, 0]);
    expect(evaluateGustWind([Number.NaN, 0, 0], 5.0, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN, 0, 0)).toEqual([0, 0, 0]);

    const nanAero = solveAeroAcousticVoice({
      hubOrBodyId: 'nan_aero',
      bladeCount: Number.NaN,
      omegaRadPerSec: Number.POSITIVE_INFINITY,
      tipSpeedMps: Number.NaN,
      relSpeedMps: Number.NaN,
      alphaDeg: Number.NaN,
      areaM2: Number.NaN,
      chordM: Number.NaN,
      thicknessM: Number.NaN,
      aeroForceN: Number.NaN,
      arealDensityKgM2: Number.NaN,
      bendRateRadPerSec: Number.NaN,
    });
    expect(nanAero.active).toBe(false);
    expect(Number.isFinite(nanAero.noiseGain)).toBe(true);

    const nanSnap = solveClothSnapPulse({
      nodeId: 'cloth',
      impulseNs: Number.NaN,
      arealDensityKgM2: Number.POSITIVE_INFINITY,
      relSpeedMps: Number.NaN,
    });
    expect(nanSnap.active).toBe(false);
    expect(nanSnap.gain).toBe(0);
    expect(Number.isFinite(nanSnap.centerHz)).toBe(true);

    // 3. Smooth `bpfHz` crossfade across 22.0 Hz (zero -19 dB step cliff!) & Nyquist cap (`bpfHz <= 16000`)
    const makeRotorAtOmega = (omegaRadPerSec: number) =>
      solveAeroAcousticVoice({
        hubOrBodyId: 'rotor_sweep',
        bladeCount: 2,
        omegaRadPerSec, // bpfHz = (omega / 2pi) * 2 = omega / pi
        tipSpeedMps: 28,
        relSpeedMps: 20,
        alphaDeg: 6,
        areaM2: 0.036,
        chordM: 0.045,
        thicknessM: 0.004,
        aeroForceN: 18,
        arealDensityKgM2: 0.8,
        bendRateRadPerSec: 0,
      });
    const below22 = makeRotorAtOmega(21.98 * Math.PI);
    const above22 = makeRotorAtOmega(22.02 * Math.PI);
    expect(Math.abs(above22.noiseGain - below22.noiseGain)).toBeLessThan(0.01);
    expect(Math.abs(above22.amDepth - below22.amDepth)).toBeLessThan(0.02);

    const below05 = makeRotorAtOmega(0.48 * Math.PI);
    const above05 = makeRotorAtOmega(0.52 * Math.PI);
    expect(Math.abs(above05.amDepth - below05.amDepth)).toBeLessThan(0.12);

    const ultraFast = makeRotorAtOmega(120000);
    expect(ultraFast.bpfHz).toBeLessThanOrEqual(16000);

    // 4. Wing Curle trailing-edge whoosh reaches audible `> 0.14` gain at 8 m/s and scales with `airDensityKgM3`
    const wingStd = solveAeroAcousticVoice({
      hubOrBodyId: 'glider_wing',
      bladeCount: 0,
      omegaRadPerSec: 0,
      tipSpeedMps: 0,
      relSpeedMps: 8,
      alphaDeg: 8,
      areaM2: 0.16,
      chordM: 0.18,
      thicknessM: 0.012,
      aeroForceN: 12,
      arealDensityKgM2: 1.2,
      bendRateRadPerSec: 0,
    });
    const wingThinAir = solveAeroAcousticVoice({
      hubOrBodyId: 'glider_wing_thin',
      bladeCount: 0,
      omegaRadPerSec: 0,
      tipSpeedMps: 0,
      relSpeedMps: 8,
      alphaDeg: 8,
      areaM2: 0.16,
      chordM: 0.18,
      thicknessM: 0.012,
      aeroForceN: 12,
      arealDensityKgM2: 1.2,
      bendRateRadPerSec: 0,
      airDensityKgM3: 0.35,
    });
    expect(wingStd.active).toBe(true);
    expect(wingStd.noiseGain).toBeGreaterThan(0.14);
    expect(wingStd.noiseGain).toBeGreaterThan(wingThinAir.noiseGain * 1.35);
  });
});
