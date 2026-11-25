import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  evaluateTensionedMembrane,
  tuneMembraneToPitch,
} from '../src/utils/membraneAcoustics';
import { extractBoreWaveguide } from '../src/utils/windAcoustics';
import {
  extractTubeAirColumn,
  tuneResonatorTubeToPitch,
} from '../src/utils/resonatorAcoustics';
import { analyze3DCavityAndPorts } from '../src/utils/solidAcoustics3D';
import { tuneBodyToPitch, tuneWindInstrumentToPitch } from '../src/utils/acousticTuning';

describe('Acoustics physics & tuning audit fixes', () => {
  it('uses j_mn^2 (not j_mn^4) in circular membrane bending stiffness dispersion', () => {
    const kevlarHead: SceneNode = {
      id: 'kevlar_snare_head',
      name: 'Kevlar Snare Head',
      type: 'body',
      pos: [0, 0, 0],
      acousticMembrane: {
        material: 'kevlar',
        shape: 'circular',
        tensionNPerM: 4500,
        thicknessMm: 0.45,
        kettleCoupling: 0,
      },
      geoms: [{ name: 'head', type: 'cylinder', size: [0.16, 0.001] }],
    };

    const res = evaluateTensionedMembrane(kevlarHead)!;
    expect(res).toBeTruthy();
    // With j_mn^2, mode (2,2) (index 6, j_22 = 8.417) stays near ideal ~3.5x f_01 (not >7x from j_mn^4 blowup).
    const maxRatio = Math.max(...res.modeRatios);
    expect(maxRatio).toBeGreaterThan(2.0);
    expect(maxRatio).toBeLessThan(5.0);
  });

  it('stores tonehole and transverse CSG breach radiusMm as radius (mm), not diameter', () => {
    const keyedTube: SceneNode = {
      id: 'keyed_reed_pipe',
      name: 'Keyed Reed Pipe',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.0075,
      windInstrument: {
        exciter: 'reed',
        boreLengthM: 0.52,
        toneholeJoints: [{ jointName: 'key_1', axialFraction: 0.6, diameterMm: 8.0 }],
      },
      geoms: [{ name: 'pipe', type: 'cylinder', size: [0.011, 0.26] }],
    };
    const keyedBore = extractBoreWaveguide(keyedTube, { key_1: 0.25 })!;
    expect(keyedBore.toneholes).toHaveLength(1);
    expect(keyedBore.toneholes[0].radiusMm).toBeCloseTo(4.0, 1);

    const csgTube: SceneNode = {
      id: 'csg_breach_pipe',
      name: 'CSG Breach Pipe',
      type: 'body',
      pos: [0, 0, 0],
      windInstrument: { exciter: 'reed' },
      geoms: [
        { name: 'outer', type: 'cylinder', size: [0.014, 0.14], pos: [0, 0, 0] },
        { name: 'bore', type: 'cylinder', csg: 'difference', size: [0.0085, 0.142], pos: [0, 0, 0] },
        {
          name: 'side_hole',
          type: 'cylinder',
          csg: 'difference',
          quat: [Math.SQRT1_2, 0, Math.SQRT1_2, 0],
          size: [0.0045, 0.02],
          pos: [0, 0, 0.04],
        },
      ],
    };
    const csgBore = extractBoreWaveguide(csgTube)!;
    const geomHoles = csgBore.toneholes.filter((t) => t.fromGeometry);
    expect(geomHoles).toHaveLength(1);
    expect(geomHoles[0].radiusMm).toBeCloseTo(4.5, 1);
  });

  it('converts MuJoCo Euler degrees to radians in resonator tube world poses', () => {
    const tubeLen = 0.20;
    const rotatedTube: SceneNode = {
      id: 'horiz_tube',
      name: 'Horizontal Tube',
      type: 'body',
      pos: [0, 0, 0],
      euler: [0, 90, 0], // +90 deg around Y rotates local +Z to world +X
      isTube: true,
      innerRadius: 0.02,
      outerRadius: 0.023,
      height: tubeLen,
      resonatorTube: {
        endCondition: 'open_closed',
      },
      geoms: [
        { name: 'tube_outer', type: 'cylinder', size: [0.023, tubeLen * 0.5] },
        { name: 'tube_bore', type: 'cylinder', csg: 'difference', size: [0.02, tubeLen * 0.5 + 0.002] },
      ],
    };

    const col = extractTubeAirColumn(rotatedTube);
    expect(col).toBeTruthy();
    // +90 deg about Y maps local +Z to world +X: axisDirWorld ≈ [1, 0, 0], mouthCenterWorld ≈ [0.10, 0, 0]
    expect(col!.axisDirWorld[0]).toBeCloseTo(1, 4);
    expect(col!.axisDirWorld[1]).toBeCloseTo(0, 4);
    expect(col!.axisDirWorld[2]).toBeCloseTo(0, 4);
    expect(col!.mouthCenterWorld[0]).toBeCloseTo(tubeLen * 0.5, 3);
    expect(col!.mouthCenterWorld[2]).toBeCloseTo(0, 3);
  });

  it('keeps the lower coupled branch on vented shells when fMode < fH', () => {
    // Small vented shell with high Helmholtz frequency (well above the membrane's ~85 Hz fundamental)
    const ventedShell: SceneNode = {
      id: 'vented_shell',
      name: 'Vented Shell',
      type: 'body',
      pos: [0, 0, -0.09],
      geoms: [
        { name: 'shell_outer', type: 'cylinder', size: [0.16, 0.08], pos: [0, 0, 0] },
        { name: 'shell_inner', type: 'cylinder', csg: 'difference', size: [0.15, 0.072], pos: [0, 0, 0.008] },
        // Large vent hole so fH is high (~250+ Hz)
        { name: 'vent', type: 'cylinder', csg: 'difference', size: [0.06, 0.03], pos: [0, 0, -0.075] },
      ],
    };
    const makeHead = (kettleCoupling: number): SceneNode => ({
      id: 'low_tom_head',
      name: 'Low Tom Head',
      type: 'body',
      pos: [0, 0, 0],
      acousticMembrane: {
        material: 'mylar',
        shape: 'circular',
        tensionNPerM: 420,
        thicknessMm: 0.25,
        shellNodeId: 'vented_shell',
        kettleCoupling,
      },
      geoms: [{ name: 'head', type: 'cylinder', size: [0.16, 0.001] }],
    });

    const uncoupled = evaluateTensionedMembrane(makeHead(0), [ventedShell, makeHead(0)])!;
    const coupled = evaluateTensionedMembrane(makeHead(0.8), [ventedShell, makeHead(0.8)])!;
    expect(coupled.isClosedKettle).toBe(false);
    expect(Number.isFinite(coupled.fundamentalHz)).toBe(true);
    // When fMode < fH, coupled lower branch must stay below the uncoupled fMode (not jump above fH!)
    if (coupled.shellHelmholtzHz !== null && coupled.shellHelmholtzHz > uncoupled.fundamentalHz) {
      expect(coupled.fundamentalHz).toBeLessThanOrEqual(uncoupled.fundamentalHz + 0.05);
      expect(coupled.fundamentalHz).toBeGreaterThan(uncoupled.fundamentalHz * 0.75);
    }
  });

  it('refines ±Y wall ports on non-cubic cavities with unswapped stepU/stepV', () => {
    // Non-cubic box: long along X (0.36 m), medium along Y (0.14 m), short along Z (0.10 m)
    const wall = 0.008;
    const portR = 0.022;
    const yPortBox: SceneNode = {
      id: 'y_port_box',
      name: 'Y-Port Cavity',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        { name: 'outer', type: 'box', size: [0.18, 0.07, 0.05] },
        { name: 'cavity', type: 'box', csg: 'difference', size: [0.18 - wall, 0.07 - wall, 0.05 - wall] },
        {
          name: 'y_port',
          type: 'cylinder',
          csg: 'difference',
          euler: [90, 0, 0],
          size: [portR, 0.02],
          pos: [0, 0.07, 0],
        },
      ],
    };

    const cav = analyze3DCavityAndPorts(yPortBox);
    expect(cav).toBeTruthy();
    expect(cav.ports.length).toBeGreaterThanOrEqual(1);
    const totalPortAreaM2 = cav.ports.reduce((sum, p) => sum + p.areaM2, 0);
    const expectedArea = Math.PI * portR * portR;
    expect(totalPortAreaM2).toBeGreaterThan(expectedArea * 0.7);
    expect(totalPortAreaM2).toBeLessThan(expectedArea * 1.35);
  });

  it('applies yield safety clamp to thin membranes (<= 0.10 mm) in tuneMembraneToPitch', () => {
    const thinHead: SceneNode = {
      id: 'thin_mylar_head',
      name: 'Thin Mylar Head',
      type: 'body',
      pos: [0, 0, 0],
      acousticMembrane: {
        material: 'mylar',
        shape: 'circular',
        tensionNPerM: 1200,
        thicknessMm: 0.09,
        kettleCoupling: 0,
      },
      geoms: [{ name: 'head', type: 'cylinder', size: [0.18, 0.0005] }],
    };

    // Request an impossibly high pitch for a 36 cm 0.09 mm Mylar film so tension hits yield
    const tuned = tuneMembraneToPitch(thinHead, 2200);
    const after = evaluateTensionedMembrane(tuned)!;
    expect(after.stressRatio).toBeLessThanOrEqual(0.90);
  });

  it('guards NaN targetHzRaw across all acoustic tuners', () => {
    const memNode: SceneNode = {
      id: 'nan_mem',
      name: 'NaN Membrane',
      type: 'body',
      pos: [0, 0, 0],
      acousticMembrane: { material: 'mylar', tensionNPerM: 1500, thicknessMm: 0.25 },
      geoms: [{ name: 'head', type: 'cylinder', size: [0.15, 0.001] }],
    };
    const tunedMem = tuneMembraneToPitch(memNode, Number.NaN);
    expect(Number.isFinite(tunedMem.tunedPitchHz)).toBe(true);
    expect(Number.isFinite(tunedMem.acousticMembrane!.tensionNPerM)).toBe(true);

    const tubeNode: SceneNode = {
      id: 'nan_tube',
      name: 'NaN Tube',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.02,
      outerRadius: 0.023,
      height: 0.2,
      resonatorTube: { endCondition: 'open_closed' },
      geoms: [{ name: 'tube', type: 'cylinder', size: [0.023, 0.1] }],
    };
    const tunedTube = tuneResonatorTubeToPitch(tubeNode, Number.NaN);
    expect(Number.isFinite(tunedTube.tunedPitchHz)).toBe(true);
    expect(Number.isFinite(tunedTube.height)).toBe(true);

    const windNode: SceneNode = {
      id: 'nan_wind',
      name: 'NaN Wind',
      type: 'body',
      pos: [0, 0, 0],
      isTube: true,
      innerRadius: 0.008,
      windInstrument: { exciter: 'flap_valve', embouchureHz: 120 },
      geoms: [{ name: 'pipe', type: 'cylinder', size: [0.011, 0.1] }],
    };
    const tunedWind = tuneWindInstrumentToPitch(windNode, Number.NaN);
    expect(Number.isFinite(tunedWind.tunedPitchHz)).toBe(true);
    expect(Number.isFinite(tunedWind.windInstrument!.embouchureHz)).toBe(true);

    const barNode: SceneNode = {
      id: 'nan_bar',
      name: 'NaN Bar',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [{ name: 'bar', type: 'box', size: [0.12, 0.02, 0.008] }],
    };
    const tunedBar = tuneBodyToPitch(barNode, Number.NaN);
    expect(Number.isFinite(tunedBar.node.tunedPitchHz)).toBe(true);
    expect(Number.isFinite(tunedBar.after.fundamentalHz)).toBe(true);
  });
});
