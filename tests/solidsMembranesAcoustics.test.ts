import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { bowedCelloPreset } from '../src/presets/bowedCello';
import { marimbaCascadePreset } from '../src/presets/marimbaCascade';
import { soundboxLyrePreset } from '../src/presets/soundboxLyre';
import { windInstrumentsPreset } from '../src/presets/windInstruments';
import {
  buildTunedScaleNodes,
  hzToNoteInfo,
  noteToHz,
  tuneBodyToPitch,
  tuneMembraneToPitch,
  tuneResonatorTubeToPitch,
  tuneWindInstrumentToPitch,
} from '../src/utils/acousticTuning';
import { deformMaterial, geomVolume } from '../src/utils/deformMaterials';
import { generateTubeMeshData } from '../src/utils/geom';
import {
  besselJn,
  CIRCULAR_BESSEL_MODES,
  evaluateTensionedMembrane,
  solveMembraneImpact,
} from '../src/utils/membraneAcoustics';
import { estimateBodyModes } from '../src/utils/modalAudio';
import { solveVonKarmanPlateImpact } from '../src/utils/nonlinearPlateAcoustics';
import {
  extractTubeAirColumn,
  resolveExternalTubeResonator,
} from '../src/utils/resonatorAcoustics';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  castSceneRay,
  buildBodyRayScene,
  resampleIrToContextRate,
  simulate3DVibroAcousticIR,
} from '../src/utils/solidAcoustics3D';
import { extractBoreWaveguide, solvePlayableWindVoice } from '../src/utils/windAcoustics';
import { simulate } from './helpers/simulate';

describe('Slice 1 Bug Fixes — 3D Solids, Cavities, Vibro-Acoustic FIR, Tuning & Presets', () => {
  it('P0.1: marimbaCascadePreset bars and C5 chime clear mallet_rail with zero spawn interpenetration', async () => {
    const frame = marimbaCascadePreset.nodes.find((n) => n.id === 'marimba_frame')!;
    const malletRail = frame.geoms.find((g) => g.name === 'mallet_rail')!;
    const railBackFaceY = (malletRail.pos?.[1] ?? 0) + (malletRail.size[1] ?? 0);

    for (const note of ['c4', 'd4', 'e4', 'g4', 'a4']) {
      const bar = marimbaCascadePreset.nodes.find((n) => n.id === `marimba_bar_${note}`)!;
      const barBox = bar.geoms.find((g) => g.name === 'bar_body')!;
      // Bar front end (-barBox.size[1]) must sit strictly behind mallet_rail's back face (+Y side) with >= 10 mm clearance!
      expect(-barBox.size[1]).toBeGreaterThan(railBackFaceY + 0.010);
    }

    const chime = marimbaCascadePreset.nodes.find((n) => n.id === 'steel_chime_c5')!;
    const chimeCyl = chime.geoms.find((g) => g.name === 'chime_rod')!;
    expect(-chimeCyl.size[1]).toBeGreaterThan(railBackFaceY + 0.010);

    const sim = await simulate(marimbaCascadePreset);
    try {
      sim.step(5);
      // None of the 5 bars or chime is jammed into its +0.012 m upper joint stop by rail overlap!
      for (const jn of ['bar_c4_pad', 'bar_d4_pad', 'bar_e4_pad', 'bar_g4_pad', 'bar_a4_pad', 'chime_c5_cord']) {
        expect(Math.abs(sim.jointPos(jn))).toBeLessThan(0.0012);
      }
    } finally {
      sim.dispose();
    }
  });

  it('P1.1: converts Three.js Y-up vertices to MuJoCo Z-up when renderVertices is absent', () => {
    // Build a 240 (X) x 40 (Y_zup) x 14 (Z_zup) mm bar mesh in Z-up, and its Y-up counterpart (x, z_zup, -y_zup)
    const hx = 0.12, hy = 0.02, hz = 0.007;
    const zCorners: [number, number, number][] = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const renderVertices = zCorners.flatMap(([x, y, z]) => [x, y, z]);
    const yUpVertices = zCorners.flatMap(([x, y, z]) => [x, z, -y]);
    const faces = [
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      2, 3, 7, 2, 7, 6,
      1, 2, 6, 1, 6, 5,
      3, 0, 4, 3, 4, 7,
    ];

    const dynNode: SceneNode = {
      id: 'dyn_mesh_bar',
      name: 'Dynamic Mesh Bar',
      pos: [0, 0, 0],
      deformMaterial: 'hardwood',
      geoms: [{ name: 'm', type: 'mesh', size: [1], dynamic: true, vertices: yUpVertices, renderVertices, faces }],
      joints: [],
      children: [],
    };
    const staticYupOnlyNode: SceneNode = {
      id: 'static_mesh_bar',
      name: 'Static Y-up Mesh Bar',
      pos: [0, 0, 0],
      deformMaterial: 'hardwood',
      geoms: [{ name: 'm', type: 'mesh', size: [1], vertices: yUpVertices, faces }],
      joints: [],
      children: [],
    };

    const secDyn = analyze3DSolidCrossSections(dynNode);
    const secStatic = analyze3DSolidCrossSections(staticYupOnlyNode);
    expect(secStatic.axisOrderAsc).toEqual(secDyn.axisOrderAsc);
    expect(secStatic.dimsSortedAsc[0]).toBeCloseTo(secDyn.dimsSortedAsc[0], 4);
    expect(secStatic.dimsSortedAsc[1]).toBeCloseTo(secDyn.dimsSortedAsc[1], 4);
    expect(secStatic.dimsSortedAsc[2]).toBeCloseTo(secDyn.dimsSortedAsc[2], 4);
    expect(estimateBodyModes(staticYupOnlyNode).fundamentalHz).toBeCloseTo(
      estimateBodyModes(dynNode).fundamentalHz,
      1,
    );
  });

  it('P1.2: scopes CSG differences per SceneNode (preserving welded soundposts) and excludes external necks/bridges from soundbox spans', () => {
    const cello = bowedCelloPreset.nodes[0];
    const scene = buildBodyRayScene(cello, true)!;
    // Cast vertical ray right through spruce_soundpost at (x = 0.026, y = -0.082):
    // Before fix, cello_soundbox's `cavity_lower` difference erased `spruce_soundpost` leaving a hollow gap;
    // after fix, the welded child soundpost remains solid across [-0.053, +0.055]!
    const postRay = castSceneRay(scene, 0.026, -0.082, 0, 0, 0, 1);
    expect(postRay.length).toBe(1);
    expect(postRay[0][1] - postRay[0][0]).toBeGreaterThan(0.105);

    const cav = analyze3DCavityAndPorts(cello);
    // Corpus length is 0.740 m (must NOT be inflated to 0.976 m by `cello_neck_assembly`)!
    expect(cav.plateSpanBM).toBeCloseTo(0.74, 2);
    // Spruce belly thickness is ~3.4–4.5 mm (must NOT be polluted by 94 mm standing bridge or 9 mm fingerboard)!
    expect(cav.topPlateThicknessM).toBeGreaterThan(0.0028);
    expect(cav.topPlateThicknessM).toBeLessThan(0.0065);
  });

  it('P1.3: refinePortPatch measures accurate port area on through-all cuts (cutDepth: 0) piercing opposite walls', () => {
    const throughCutBox: SceneNode = {
      id: 'through_cut_soundbox',
      name: 'Through-Cut Box',
      pos: [0, 0, 0],
      deformMaterial: 'softwood',
      csgEnabled: true,
      geoms: [
        { name: 'outer', type: 'box', size: [0.09, 0.14, 0.035] },
        { name: 'void', type: 'box', size: [0.084, 0.134, 0.029], csg: 'difference' },
        // Through-all Ø28 mm cylinder (`r = 0.014 m`) piercing BOTH +Z and -Z plates (`ivs.length === 0` inside hole!)
        { name: 'thru_hole', type: 'cylinder', size: [0.014, 0.050], pos: [0, 0, 0], csg: 'difference' },
      ],
      joints: [],
      children: [],
    };
    const cav = analyze3DCavityAndPorts(throughCutBox);
    expect(cav.hasHollowCavity).toBe(true);
    expect(cav.ports.length).toBe(2);
    const expectedHoleArea = Math.PI * 0.014 * 0.014; // ~6.16e-4 m²
    expect(cav.ports[0].areaM2).toBeGreaterThan(expectedHoleArea * 0.80);
    expect(cav.ports[0].areaM2).toBeLessThan(expectedHoleArea * 1.20);
    expect(cav.totalConductanceM).toBeGreaterThan(0.01);
  });

  it('P1.4: classifies unconstricted open tubes as λ/4 or λ/2 standing-wave columns instead of 2x-sharp lumped Helmholtz necks', () => {
    // Stopped (λ/4) C4 marimba resonator tube: L_cav = 0.320 m, r_in = 0.020 m -> f_1 = 343 / (4 * (0.320 + 0.6133 * 0.020)) ≈ 258.1 Hz
    const stoppedTube: SceneNode = {
      id: 'stopped_c4_tube',
      name: 'Stopped Tube',
      pos: [0, 0, 0],
      deformMaterial: 'softMetal',
      csgEnabled: true,
      geoms: [
        { name: 'outer', type: 'cylinder', size: [0.023, 0.162] },
        // Cuts from z = -0.158 up through the +Z top face (+0.162) -> 0.320 m interior air column open at +Z, closed 4 mm cap at -Z!
        { name: 'bore', type: 'cylinder', size: [0.020, 0.165], pos: [0, 0, 0.007], csg: 'difference' },
      ],
      joints: [],
      children: [],
    };
    const openBothTube: SceneNode = {
      ...stoppedTube,
      id: 'open_both_tube',
      geoms: [
        { name: 'outer', type: 'cylinder', size: [0.023, 0.160] },
        { name: 'bore', type: 'cylinder', size: [0.020, 0.170], pos: [0, 0, 0], csg: 'difference' },
      ],
    };

    const cavStopped = analyze3DCavityAndPorts(stoppedTube);
    expect(cavStopped.cavityRegime).toBe('quarter_wave_tube');
    expect(cavStopped.airResonanceHz).not.toBeNull();
    expect(cavStopped.airResonanceHz!).toBeGreaterThan(240);
    expect(cavStopped.airResonanceHz!).toBeLessThan(280);

    const cavOpen = analyze3DCavityAndPorts(openBothTube);
    expect(cavOpen.cavityRegime).toBe('half_wave_tube');
    expect(cavOpen.airResonanceHz!).toBeGreaterThan(cavStopped.airResonanceHz! * 1.85);
  });

  it('P1.5: slices diagonal fromto rods and thin sub-mm tilted cymbals along their true principal axes', () => {
    const len = 0.22;
    const d45 = len / Math.SQRT2;
    const alignedRod: SceneNode = {
      id: 'rod_aligned',
      name: 'Aligned Rod',
      pos: [0, 0, 0],
      deformMaterial: 'steel',
      geoms: [{ name: 'r', type: 'cylinder', fromto: [0, 0, 0, 0, len, 0], size: [0.005] }],
      joints: [],
      children: [],
    };
    const diagRod: SceneNode = {
      id: 'rod_diag45',
      name: 'Diagonal 45° Rod',
      pos: [0, 0, 0],
      deformMaterial: 'steel',
      geoms: [{ name: 'r', type: 'cylinder', fromto: [0, 0, 0, d45, d45, 0], size: [0.005] }],
      joints: [],
      children: [],
    };

    const modesAligned = estimateBodyModes(alignedRod);
    const modesDiag = estimateBodyModes(diagRod);
    expect(modesDiag.regime).toBe('tube');
    expect(Math.abs(modesDiag.fundamentalHz - modesAligned.fundamentalHz) / modesAligned.fundamentalHz).toBeLessThan(0.015);

    // 0.6 mm thick tilted bronze cymbal retains sub-mm thickness (< 1.0 mm) and 'plate' regime
    const thinTiltedCymbal: SceneNode = {
      id: 'tilted_cymbal',
      name: 'Tilted Thin Cymbal',
      pos: [0, 0, 0],
      deformMaterial: 'softMetal',
      geoms: [{ name: 'disk', type: 'cylinder', size: [0.14, 0.0003], euler: [28, 15, 0] }],
      joints: [],
      children: [],
    };
    const cymSec = analyze3DSolidCrossSections(thinTiltedCymbal);
    expect(cymSec.dimsSortedAsc[0]).toBeCloseTo(0.0006, 4);
    expect(estimateBodyModes(thinTiltedCymbal).regime).toBe('plate');
  });

  it('P1.6: ensures zero-DC, smooth 24k/48k L2 norm parity, and sample-rate-invariant convolution gain in 3D Vibro-Acoustic FIR', () => {
    const lyre = soundboxLyrePreset.nodes[0]; // 64 mm deep -> h < 29 mm (simRate = 48000)
    const cello = bowedCelloPreset.nodes[0]; // 116 mm deep -> h >= 29 mm (simRate = 24000)
    const mat = { modulusGPa: 9.0, density: 450, qualityQ: 105 };

    const irLyre = simulate3DVibroAcousticIR(lyre, mat)!;
    const irCello = simulate3DVibroAcousticIR(cello, mat)!;
    expect(irLyre).not.toBeNull();
    expect(irCello).not.toBeNull();

    const statsOf = (arr: Float32Array) => {
      let sum = 0, sumSq = 0;
      for (let i = 0; i < arr.length; i++) {
        expect(Number.isFinite(arr[i])).toBe(true);
        sum += arr[i];
        sumSq += arr[i] * arr[i];
      }
      return { mean: sum / arr.length, l2: Math.sqrt(sumSq) };
    };

    const stLyre = statsOf(irLyre.ir);
    const stCello = statsOf(irCello.ir);
    // Exact zero DC offset (< 1e-5) and balanced L2 norm across 24 kHz vs 48 kHz FDTD rates!
    expect(Math.abs(stLyre.mean)).toBeLessThan(1e-5);
    expect(Math.abs(stCello.mean)).toBeLessThan(1e-5);
    expect(stLyre.l2).toBeGreaterThan(0.55);
    expect(stCello.l2).toBeGreaterThan(0.55);
    expect(Math.abs(Math.log2(stLyre.l2 / stCello.l2))).toBeLessThan(0.45);

    // Sample-rate-invariant transfer gain |H(220 Hz)| across 44.1 kHz, 48 kHz, and 96 kHz (+ NaN sanitization)
    const dftMagAt = (buf: Float32Array, sr: number, hz: number) => {
      let re = 0, im = 0;
      for (let n = 0; n < buf.length; n++) {
        const ang = (2 * Math.PI * hz * n) / sr;
        re += buf[n] * Math.cos(ang);
        im -= buf[n] * Math.sin(ang);
      }
      return Math.hypot(re, im);
    };
    const ir44 = resampleIrToContextRate(irLyre.ir, 44100, 48000);
    const ir48 = resampleIrToContextRate(irLyre.ir, 48000, 48000);
    const ir96 = resampleIrToContextRate(irLyre.ir, 96000, 48000);

    const g44 = dftMagAt(ir44, 44100, 220);
    const g48 = dftMagAt(ir48, 48000, 220);
    const g96 = dftMagAt(ir96, 96000, 220);
    expect(Math.abs(g96 - g48) / g48).toBeLessThan(0.03);
    expect(Math.abs(g44 - g48) / g48).toBeLessThan(0.03);

    const poisoned = new Float32Array([0.2, Number.NaN, Number.POSITIVE_INFINITY, -0.2]);
    const sanitized = resampleIrToContextRate(poisoned, 96000, 48000);
    for (let i = 0; i < sanitized.length; i++) {
      expect(Number.isFinite(sanitized[i])).toBe(true);
    }
  });

  it('P1.7: computes true geomVolume on fromto cylinders and capsules and supports rubber deformMaterial', () => {
    const r = 0.01, L = 0.25;
    const cylVol = geomVolume({ name: 'c', type: 'cylinder', fromto: [0, 0, 0, 0, L, 0], size: [r] });
    const capVol = geomVolume({ name: 'k', type: 'capsule', fromto: [0, 0, 0, 0, L, 0], size: [r] });
    expect(cylVol).toBeCloseTo(Math.PI * r * r * L, 6);
    expect(capVol).toBeCloseTo(Math.PI * r * r * L + (4 / 3) * Math.PI * r ** 3, 6);
    expect(deformMaterial('rubber')).toBeDefined();
    expect(deformMaterial('rubber')!.density).toBeGreaterThan(900);
  });

  it('P1.8 & P2.2 & P2.3: tunes isTube meshes, fromto nodal holes, wind bores, rotated scale sets, and invalidates local sculpt edits', () => {
    // 1. `isTube: true` mesh body tunes flexural chime pitch accurately (was 0 cents moved!)
    const md = generateTubeMeshData(0.012, 0.018, 0.18, 24);
    const tubeChime: SceneNode = {
      id: 'mesh_tube_chime',
      name: 'Tubular Chime',
      pos: [0, 0, 0.1],
      deformMaterial: 'steel',
      isTube: true,
      innerRadius: 0.012,
      outerRadius: 0.018,
      height: 0.18,
      geoms: [{ name: 'tube_mesh', type: 'mesh', size: [1], dynamic: true, ...md }],
      joints: [],
      children: [],
    };
    const targetA4 = noteToHz('A4')!;
    const tunedTube = tuneBodyToPitch(tubeChime, targetA4);
    expect(tunedTube.method).toBe('tube_length');
    expect(Math.abs(tunedTube.after.fundamentalHz - targetA4) / targetA4).toBeLessThan(0.015);

    // 2. Horizontal `fromto` cylinder rod places `nodal_hole` right on the X-axis rod!
    const horizRod: SceneNode = {
      id: 'horiz_chime',
      name: 'Horizontal Rod',
      pos: [0, 0, 0.05],
      deformMaterial: 'steel',
      geoms: [{ name: 'rod', type: 'cylinder', fromto: [-0.14, 0.03, 0, 0.14, 0.03, 0], size: [0.007] }],
      joints: [],
      children: [],
    };
    const tunedHoriz = tuneBodyToPitch(horizRod, noteToHz('D5')!, { drillNodalHole: true });
    const hole = tunedHoriz.node.geoms.find((g) => g.name === 'nodal_hole')!;
    expect(hole).toBeDefined();
    expect(hole.pos![1]).toBeCloseTo(0.03, 4);
    expect(Math.abs(hole.pos![2])).toBeLessThan(1e-4);
    expect(Math.abs(hole.pos![0])).toBeGreaterThan(0.02);

    // 3. `tuneWindInstrumentToPitch` scales wind bore L ∝ 1/f cleanly without drilling a nodal hole
    const clar = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
    const targetF3 = noteToHz('F3')!;
    const tunedClar = tuneWindInstrumentToPitch(clar, targetF3);
    expect(tunedClar.geoms.some((g) => g.name === 'nodal_hole')).toBe(false);
    const afterBore = extractBoreWaveguide(tunedClar)!;
    const afterWindVoice = solvePlayableWindVoice(afterBore, 3.2, tunedClar.windInstrument!.embouchureHz);
    expect(hzToNoteInfo(afterWindVoice.pitchHz).note).toBe('F3');
    expect(Math.abs(hzToNoteInfo(afterWindVoice.pitchHz).cents)).toBeLessThanOrEqual(12);

    // 4. `buildTunedScaleNodes` on a horizontal X-oriented rod (`euler: [0, 90, 0]`) steps along Y without overlap!
    const xRod: SceneNode = {
      id: 'x_rod',
      name: 'X Rod',
      pos: [0, 0, 0.04],
      euler: [0, 90, 0],
      deformMaterial: 'steel',
      geoms: [{ name: 'r', type: 'cylinder', size: [0.008, 0.12] }],
      joints: [{ name: 'slide_pad', type: 'slide', axis: [0, 0, 1] }],
      children: [],
    };
    const scaleSet = buildTunedScaleNodes(xRod, 'C5', 'pentatonic');
    expect(scaleSet.length).toBe(5);
    const jointNames = new Set(scaleSet.map((n) => n.joints[0].name));
    expect(jointNames.size).toBe(5);
    for (let i = 1; i < scaleSet.length; i++) {
      // Must step along Y (narrower axis in world XY since cylinder length lies along world X!), >= 22 mm apart
      expect(scaleSet[i].pos[1] - scaleSet[i - 1].pos[1]).toBeGreaterThan(0.022);
    }

    // 5. Local vertex sculpt stroke invalidates section cache even when `sculptVersion` is unchanged
    const baseSec = analyze3DSolidCrossSections(tubeChime);
    const tweakedRv = [...md.renderVertices];
    tweakedRv[13] += 0.025;
    const sculptedTube: SceneNode = {
      ...tubeChime,
      geoms: [{ ...tubeChime.geoms[0], renderVertices: tweakedRv }],
    };
    const nextSec = analyze3DSolidCrossSections(sculptedTube);
    expect(nextSec).not.toBe(baseSec);
  });
});

describe('Starters #1, #4a & #5 — 2D Membranes, Nonlinear Plates/Gongs & External Tube Resonators', () => {
  it('Starter #1: models circular Bessel modes, strike-spot excitation, timpani kettle harmonicity, pitch drop & snare rattle', () => {
    expect(besselJn(0, 0)).toBeCloseTo(1, 8);
    expect(besselJn(1, 0)).toBeCloseTo(0, 8);
    for (const bm of CIRCULAR_BESSEL_MODES) {
      expect(Math.abs(besselJn(bm.m, bm.jmn))).toBeLessThan(1e-6);
    }

    const openHead: SceneNode = {
      id: 'open_drumhead',
      name: 'Open Drumhead',
      pos: [0, 0, 0.2],
      acousticMembrane: {
        material: 'mylar',
        tensionNPerM: 1600,
        thicknessMm: 0.25,
        shape: 'circular',
      },
      geoms: [{ name: 'head', type: 'cylinder', size: [0.16, 0.0002] }],
      joints: [],
      children: [],
    };

    // 1. Quadrupling line tension nearly doubles wave speed & fundamental pitch (~2.0x)
    const e1 = evaluateTensionedMembrane(openHead)!;
    const e4 = evaluateTensionedMembrane({
      ...openHead,
      acousticMembrane: { ...openHead.acousticMembrane!, tensionNPerM: 6400 },
    })!;
    expect(e4.waveSpeedMps / e1.waveSpeedMps).toBeCloseTo(2.0, 2);
    expect(e4.fundamentalHz / e1.fundamentalHz).toBeCloseTo(2.0, 1);

    // 2. Center strike (r = 0) excites axisymmetric (0,1) thud while suppressing azimuthal (1,1) mode vs rim strike!
    const centerHit = solveMembraneImpact(openHead, [openHead], {
      impulseNs: 0.25,
      localPoint: [0, 0, 0],
    })!;
    const rimSpotHit = solveMembraneImpact(openHead, [openHead], {
      impulseNs: 0.25,
      localPoint: [0.10, 0, 0], // r / a = 0.625
    })!;
    expect(rimSpotHit.voices[1].gain / rimSpotHit.voices[0].gain).toBeGreaterThan(
      (centerHit.voices[1].gain / centerHit.voices[0].gain) * 4.0,
    );

    // 3. Enclosed timpani kettle bowl shifts azimuthal overtones toward harmonic 1 : 1.50 : 2.00!
    const kettleShell: SceneNode = {
      id: 'timpani_kettle',
      name: 'Copper Kettle Bowl',
      pos: [0, 0, 0.08],
      deformMaterial: 'softMetal',
      csgEnabled: true,
      geoms: [
        { name: 'bowl_outer', type: 'cylinder', size: [0.165, 0.12] },
        { name: 'bowl_inner', type: 'cylinder', size: [0.158, 0.12], pos: [0, 0, 0.008], csg: 'difference' },
      ],
      joints: [],
      children: [],
    };
    const timpaniHead: SceneNode = {
      ...openHead,
      id: 'timpani_head',
      acousticMembrane: {
        ...openHead.acousticMembrane!,
        shellNodeId: 'timpani_kettle',
        kettleCoupling: 1.0,
      },
    };
    const timpEval = evaluateTensionedMembrane(timpaniHead, [kettleShell, timpaniHead])!;
    expect(timpEval.hasShellCavity).toBe(true);
    expect(timpEval.isClosedKettle).toBe(true);
    // Azimuthal ratios (1,1) : (2,1) : (3,1) cluster right near 1.00 : 1.50 : 1.99!
    expect(timpEval.modeRatios[0]).toBeCloseTo(1.0, 2);
    expect(timpEval.modeRatios[1]).toBeGreaterThan(1.42);
    expect(timpEval.modeRatios[1]).toBeLessThan(1.56);
    expect(timpEval.modeRatios[2]).toBeGreaterThan(1.88);
    expect(timpEval.modeRatios[2]).toBeLessThan(2.08);

    // 4. Hard strike induces stronger upward tension-modulation pitch drop than light tap, and snareBuzz activates rattle!
    const snareHead: SceneNode = {
      ...openHead,
      acousticMembrane: { ...openHead.acousticMembrane!, snareBuzz: 0.75 },
    };
    const softTap = solveMembraneImpact(snareHead, [snareHead], { impulseNs: 0.04 })!;
    const hardWhack = solveMembraneImpact(snareHead, [snareHead], { impulseNs: 1.40 })!;
    expect(hardWhack.pitchGlide.semitones).toBeGreaterThan(softTap.pitchGlide.semitones * 3.0);
    expect(hardWhack.snareRattle).not.toBeNull();
    expect(hardWhack.snareRattle!.gain).toBeGreaterThan(softTap.snareRattle!.gain * 2.0);

    // 5. Rectangular membrane & `tuneMembraneToPitch`
    const rectDrum: SceneNode = {
      id: 'frame_drum_rect',
      name: 'Rectangular Frame Drum',
      pos: [0, 0, 0.1],
      acousticMembrane: {
        material: 'calfskin',
        tensionNPerM: 900,
        thicknessMm: 0.35,
        shape: 'rectangular',
      },
      geoms: [{ name: 'skin', type: 'box', size: [0.14, 0.10, 0.00025] }],
      joints: [],
      children: [],
    };
    const tunedMem = tuneMembraneToPitch(timpaniHead, noteToHz('C3')!, [kettleShell, timpaniHead]);
    const tunedMemEval = evaluateTensionedMembrane(tunedMem, [kettleShell, tunedMem])!;
    expect(hzToNoteInfo(tunedMemEval.fundamentalHz).note).toBe('C3');
    expect(Math.abs(hzToNoteInfo(tunedMemEval.fundamentalHz).cents)).toBeLessThanOrEqual(5);
    expect(evaluateTensionedMembrane(rectDrum)!.shape).toBe('rectangular');
  });

  it('Starter #4a: models von Kármán nonlinear plate/gong crash bloom, 50–250 ms pitch glide & arch softening', () => {
    const crashCymbal: SceneNode = {
      id: 'bronze_cymbal',
      name: 'Thin Bronze Crash Cymbal',
      pos: [0, 0, 0.3],
      deformMaterial: 'softMetal',
      nonlinearPlate: { enabled: true, crashSensitivity: 1.0, shimmerMix: 0.7 },
      geoms: [{ name: 'cymbal_disk', type: 'cylinder', size: [0.20, 0.00045] }],
      joints: [],
      children: [],
    };
    const profile = estimateBodyModes(crashCymbal);

    // Light tap stays purely linear (below von Kármán deflection threshold eta <= 0.22)
    expect(solveVonKarmanPlateImpact(profile, crashCymbal, 0.008)).toBeNull();

    // High-energy crash triggers upward modal cascade over 50–250 ms & positive tension-stiffening pitch glide
    const crash = solveVonKarmanPlateImpact(profile, crashCymbal, 1.85)!;
    expect(crash).not.toBeNull();
    expect(crash.active).toBe(true);
    expect(crash.pitchGlideCents).toBeGreaterThan(15);
    expect(crash.glideTauSec).toBeGreaterThanOrEqual(0.050);
    expect(crash.glideTauSec).toBeLessThanOrEqual(0.250);
    expect(crash.lowModeDecayScale).toBeLessThan(0.85);
    expect(crash.cascadeVoices.length).toBeGreaterThanOrEqual(6);
    expect(crash.cascadeVoices[crash.cascadeVoices.length - 1].bloomAttackSec).toBeGreaterThan(
      crash.cascadeVoices[0].bloomAttackSec * 1.4,
    );
    expect(crash.shimmerPeakGain).toBeGreaterThan(0.05);

    // Domed Chinese opera gong (`archRatio: 1.2`) exhibits initial negative arch-flattening pitch dip on moderate strike!
    const operaGong: SceneNode = {
      ...crashCymbal,
      id: 'opera_gong',
      nonlinearPlate: { enabled: true, crashSensitivity: 1.0, archRatio: 1.2 },
    };
    const gongDip = solveVonKarmanPlateImpact(profile, operaGong, 0.42)!;
    expect(gongDip).not.toBeNull();
    expect(gongDip.pitchGlideCents).toBeLessThan(-10);
  });

  it('Starter #5: models cross-body λ/4 & λ/2 external tube resonators, Q/gain tradeoff, and rotating vane tremolo', () => {
    const c4Hz = noteToHz('C4')!;
    const rawBar = marimbaCascadePreset.nodes.find((n) => n.id === 'marimba_bar_c4')!;
    const barAtOrigin: SceneNode = { ...rawBar, pos: [0, 0, 0.25] };
    const barProfile = estimateBodyModes(barAtOrigin);

    // Build a closed-bottom hollow resonator tube positioned beneath the bar's center antinode (0, 0)
    const rawTubeMesh = generateTubeMeshData(0.020, 0.023, 0.20, 24);
    const untunedTube: SceneNode = {
      id: 'c4_resonator_tube',
      name: 'C4 Aluminium Resonator Tube',
      pos: [0, 0, 0.08],
      deformMaterial: 'softMetal',
      isTube: true,
      innerRadius: 0.020,
      outerRadius: 0.023,
      height: 0.20,
      resonatorTube: {
        endCondition: 'open_closed',
        vaneJointName: 'vibe_fan_hinge',
        vaneMaxOcclusion: 0.88,
      },
      geoms: [
        { name: 'tube_wall', type: 'mesh', size: [1], dynamic: true, ...rawTubeMesh },
        { name: 'bottom_plug', type: 'cylinder', size: [0.023, 0.003], pos: [0, 0, -0.10] },
      ],
      joints: [],
      children: [
        {
          id: 'tremolo_vane',
          name: 'Rotating Vane Disk',
          pos: [0, 0, 0.095],
          geoms: [{ name: 'vane_disk', type: 'cylinder', size: [0.018, 0.001] }],
          joints: [{ name: 'vibe_fan_hinge', type: 'hinge', axis: [1, 0, 0] }],
          children: [],
        },
      ],
    };

    const tunedTube = tuneResonatorTubeToPitch(untunedTube, c4Hz, 'open_closed');
    // Position tuned tube so its open top mouth (+height/2) sits 18 mm below the bar!
    const tubeHalfH = (tunedTube.height ?? 0.32) * 0.5;
    tunedTube.pos = [0, 0, +(0.25 - 0.0085 - 0.018 - tubeHalfH).toFixed(4)];

    const col = extractTubeAirColumn(tunedTube)!;
    expect(col).not.toBeNull();
    expect(col.endCondition).toBe('open_closed');
    expect(Math.abs(col.fundamentalHz - c4Hz) / c4Hz).toBeLessThan(0.015);

    // 1. Open vane (90° = pi/2, stopped): strong fundamental gain boost (> 1.8x) AND shorter decay (< 0.80x)
    const openCoupled = resolveExternalTubeResonator(
      barAtOrigin,
      barProfile,
      barProfile.modes,
      [barAtOrigin, tunedTube],
      { jointPositions: { vibe_fan_hinge: Math.PI / 2 }, jointVelocities: { vibe_fan_hinge: 0 } },
    )!;
    expect(openCoupled).not.toBeNull();
    expect(openCoupled.lorentzianDetuning).toBeGreaterThan(0.92);
    expect(openCoupled.fundamentalGainMultiplier).toBeGreaterThan(1.85);
    expect(openCoupled.fundamentalDecayMultiplier).toBeLessThan(0.80);
    expect(openCoupled.tremolo.active).toBe(false);

    // 2. Closed vane (0°, stopped): occludes mouth -> drops gain boost and restores longer bar ring!
    const closedCoupled = resolveExternalTubeResonator(
      barAtOrigin,
      barProfile,
      barProfile.modes,
      [barAtOrigin, tunedTube],
      { jointPositions: { vibe_fan_hinge: 0 }, jointVelocities: { vibe_fan_hinge: 0 } },
    )!;
    expect(closedCoupled.fundamentalGainMultiplier).toBeLessThan(1.25);
    expect(closedCoupled.fundamentalDecayMultiplier).toBeGreaterThan(openCoupled.fundamentalDecayMultiplier * 1.25);

    // 3. Motor-driven spinning vane (Omega = 3 * pi rad/s = 1.5 Hz shaft) -> tremoloHz = 3.0 Hz (2x shaft)!
    const spinningCoupled = resolveExternalTubeResonator(
      barAtOrigin,
      barProfile,
      barProfile.modes,
      [barAtOrigin, tunedTube],
      { jointPositions: { vibe_fan_hinge: 0.4 }, jointVelocities: { vibe_fan_hinge: 3 * Math.PI } },
    )!;
    expect(spinningCoupled.tremolo.active).toBe(true);
    expect(spinningCoupled.tremolo.tremoloHz).toBeCloseTo(3.0, 2);
    expect(spinningCoupled.tremolo.amDepth).toBeGreaterThan(0.45);
    expect(spinningCoupled.tremolo.formantGainSwingDb).toBeGreaterThan(2.5);

    // 4. Off-resonance tube (tuned to F#4 tritone away) loses Lorentzian resonance boost
    const detunedTube = tuneResonatorTubeToPitch(tunedTube, noteToHz('F#4')!, 'open_closed');
    detunedTube.pos = [0, 0, +(0.25 - 0.0085 - 0.018 - (detunedTube.height ?? 0.22) * 0.5).toFixed(4)];
    const detunedCoupled = resolveExternalTubeResonator(
      barAtOrigin,
      barProfile,
      barProfile.modes,
      [barAtOrigin, detunedTube],
      { jointPositions: { vibe_fan_hinge: Math.PI / 2 }, jointVelocities: { vibe_fan_hinge: 0 } },
    )!;
    expect(detunedCoupled.lorentzianDetuning).toBeLessThan(0.05);
    expect(openCoupled.fundamentalGainMultiplier).toBeGreaterThan(detunedCoupled.fundamentalGainMultiplier * 1.7);
  });
});
