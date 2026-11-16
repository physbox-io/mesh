// ---------------------------------------------------------------------------
// 1D Kelly–Lochbaum Bore Waveguide & Coupled Reed / Brass Lip-Reed Acoustics
// ---------------------------------------------------------------------------
//
// Slices a 3D hollow bore (cylindrical clarinet pipe, stepped/conical saxophone,
// or flaring brass bugle horn) into M spatial waveguide cells of length
// Δx = c_air / f_s (≈ 7.27 mm at 48 kHz), computes exact area-junction reflection
// coefficients k_i = (A_i - A_{i+1}) / (A_i + A_{i+1}), detects boolean-cut
// toneholes along the axis, and drives the real-time Kelly–Lochbaum ladder on
// the AudioWorklet thread (~0.3% CPU, zero CFD!).
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode, WindExciterKind, WindInstrumentSpec } from '../types/scene';

const SPEED_OF_SOUND_WARM_AIR = 349; // m/s at ~28 °C breath temperature
const DEFAULT_SAMPLE_RATE = 48000;

export interface ToneholeStation {
  /** Cell index along the waveguide [1 .. M-2]. */
  cellIndex: number;
  /** Axial position from mouthpiece (0..1). */
  axialFraction: number;
  /** Hole radius in mm. */
  radiusMm: number;
  /** Negative shunt scattering coefficient in [-0.85, 0] when uncovered. */
  shuntCoeff: number;
  /** Optional MuJoCo joint name whose displacement lifts the key pad off this hole. */
  keyJointName?: string;
  /** Current open fraction [0 = sealed by pad, 1 = wide open]. */
  openAmount: number;
}

export interface BoreWaveguideModel {
  nodeId: string;
  exciter: WindExciterKind;
  /** Physical bore length (m) along its primary axis. */
  lengthM: number;
  /** Mouthpiece inner radius (m). */
  mouthRadiusM: number;
  /** Bell / open-end inner radius (m). */
  bellRadiusM: number;
  /** Number of integer Kelly–Lochbaum spatial delay cells at 48 kHz. */
  cellCount: number;
  /** Continuous exact waveguide length in cells (integer `cellCount` + fractional Thiran boundary). */
  exactCells: number;
  /** Junction reflection coefficients k_i = (A_i - A_{i+1}) / (A_i + A_{i+1}), length = cellCount - 1. */
  junctionK: number[];
  /** Bell open-end radiation cutoff frequency (Hz): f_rad = c / (2 * π * r_bell). */
  bellCutoffHz: number;
  /** Bore profile classification inferred directly from 3D geometry. */
  boreShape: 'cylindrical' | 'conical' | 'flared_horn';
  /** Toneholes detected from transverse `difference` cylinders or explicit spec. */
  toneholes: ToneholeStation[];
  /** Analytical lowest playable impedance-peak frequencies (Hz) for the current fingering. */
  resonantModesHz: number[];
}

interface AxialBoreSlice {
  boreAxis: 0 | 1 | 2;
  minCoord: number;
  maxCoord: number;
  lengthM: number;
  radiiAtStations: (nStations: number) => number[];
  transverseHoles: { axialFraction: number; radiusM: number; wallM: number }[];
}

function geomSpanOnAxis(g: SceneGeom, axis: 0 | 1 | 2): [number, number] {
  if (g.type === 'mesh') {
    const rv = g.renderVertices;
    const off = g.pos?.[axis] ?? 0;
    if (rv && rv.length >= 3) {
      let lo = Infinity, hi = -Infinity;
      for (let i = axis; i < rv.length; i += 3) {
        const v = rv[i] + off;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (Number.isFinite(lo)) return [lo, hi];
    }
  }
  const c = g.pos?.[axis] ?? 0;
  if (g.fromto && g.fromto.length >= 6) {
    const a = g.fromto[axis];
    const b = g.fromto[axis + 3];
    const r = g.size[0] ?? 0.005;
    return [Math.min(a, b) - r, Math.max(a, b) + r];
  }
  if (g.type === 'box') {
    const h = g.size[axis] ?? 0.02;
    return [c - h, c + h];
  }
  if (g.type === 'cylinder' || g.type === 'capsule') {
    // Default cylinder axis is local Z (2), unless rotated 90° onto X or Y
    const eul = g.euler ?? [0, 0, 0];
    let cylAxis: 0 | 1 | 2 = 2;
    if (Math.abs(Math.abs(eul[1] ?? 0) - 90) < 20) cylAxis = 0;
    else if (Math.abs(Math.abs(eul[0] ?? 0) - 90) < 20) cylAxis = 1;
    const ext = cylAxis === axis ? (g.size[1] ?? 0.05) : (g.size[0] ?? 0.01);
    return [c - ext, c + ext];
  }
  const r = g.size[0] ?? 0.02;
  return [c - r, c + r];
}

function inspectNodeBoreGeometry(node: SceneNode): AxialBoreSlice {
  const geoms = node.geoms ?? [];
  const positives = geoms.filter((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual');
  const negatives = geoms.filter((g) => g.csg === 'difference');

  // Determine longest body axis as the bore axis (mouthpiece at minCoord -> bell at maxCoord)
  const spans: [number, number][] = [0, 1, 2].map((ax) => {
    let lo = Infinity, hi = -Infinity;
    for (const g of positives) {
      const [g0, g1] = geomSpanOnAxis(g, ax as 0 | 1 | 2);
      if (g0 < lo) lo = g0;
      if (g1 > hi) hi = g1;
    }
    return Number.isFinite(lo) ? [lo, hi] : [-0.15, 0.15];
  });
  const lengths = spans.map(([lo, hi]) => hi - lo);
  let boreAxis: 0 | 1 | 2 = 2;
  if (lengths[0] >= lengths[1] && lengths[0] >= lengths[2]) boreAxis = 0;
  else if (lengths[1] >= lengths[0] && lengths[1] >= lengths[2]) boreAxis = 1;

  const [minCoord, maxCoord] = spans[boreAxis];
  const lengthM = Math.max(0.06, maxCoord - minCoord);

  // Separate coaxial bore cutters from transverse tonehole cutters!
  const coaxialBores: SceneGeom[] = [];
  const transverseHoles: { axialFraction: number; radiusM: number; wallM: number }[] = [];

  for (const neg of negatives) {
    if (neg.type !== 'cylinder' && neg.type !== 'capsule' && neg.type !== 'ellipsoid') continue;
    const [n0, n1] = geomSpanOnAxis(neg, boreAxis);
    const axialSpan = n1 - n0;
    const rNeg = neg.size[0] ?? 0.005;
    if (axialSpan > lengthM * 0.35) {
      coaxialBores.push(neg);
    } else if (rNeg >= 0.0015 && rNeg <= 0.025) {
      const center = 0.5 * (n0 + n1);
      const frac = Math.max(0.08, Math.min(0.94, (center - minCoord) / lengthM));
      transverseHoles.push({
        axialFraction: +frac.toFixed(4),
        radiusM: rNeg,
        wallM: 0.0035,
      });
    }
  }

  const radiiAtStations = (nStations: number): number[] => {
    if (node.isTube && typeof node.innerRadius === 'number' && node.innerRadius > 0) {
      return new Array<number>(nStations).fill(node.innerRadius);
    }

    const out: number[] = [];
    for (let k = 0; k < nStations; k++) {
      const u = nStations <= 1 ? 0 : k / (nStations - 1);
      const coord = minCoord + u * lengthM;

      // 1. If coaxial bore cutters cover `coord`, use max coaxial inner radius
      let rInner = 0;
      for (const cb of coaxialBores) {
        const [c0, c1] = geomSpanOnAxis(cb, boreAxis);
        if (coord >= c0 - 1e-4 && coord <= c1 + 1e-4) {
          rInner = Math.max(rInner, cb.size[0] ?? 0.007);
        }
      }

      // 2. Otherwise infer inner bore radius from positive outer profile (e.g. stepped/flared horn segments!)
      if (rInner <= 0) {
        let rOuterAtStation = 0;
        for (const p of positives) {
          const [p0, p1] = geomSpanOnAxis(p, boreAxis);
          if (coord >= p0 - 1e-3 && coord <= p1 + 1e-3) {
            let rCand: number;
            if (p.type === 'cylinder' || p.type === 'capsule' || p.type === 'sphere') {
              rCand = p.size[0] ?? 0.01;
            } else if (p.type === 'box') {
              const perpAxes = ([0, 1, 2] as const).filter((a) => a !== boreAxis);
              rCand = Math.sqrt(((p.size[perpAxes[0]] ?? 0.01) * (p.size[perpAxes[1]] ?? 0.01) * 4) / Math.PI);
            } else if (p.type === 'mesh' && p.renderVertices && p.renderVertices.length >= 9) {
              // Slice smooth revolved / sculpted / STL horn mesh in an axial window around `coord`!
              const rv = p.renderVertices;
              const perpAxes = ([0, 1, 2] as const).filter((a) => a !== boreAxis);
              const a1 = perpAxes[0], a2 = perpAxes[1];
              const offB = p.pos?.[boreAxis] ?? 0;
              const off1 = p.pos?.[a1] ?? 0;
              const off2 = p.pos?.[a2] ?? 0;
              const halfWin = Math.max(0.012, lengthM / Math.max(8, nStations) * 1.6);
              let minRadInSlice = Infinity;
              let maxRadInSlice = 0;
              for (let vi = 0; vi + 2 < rv.length; vi += 3) {
                const bx = rv[vi + boreAxis] + offB;
                if (Math.abs(bx - coord) <= halfWin) {
                  const u1 = rv[vi + a1] + off1;
                  const u2 = rv[vi + a2] + off2;
                  const rad = Math.hypot(u1, u2);
                  if (rad > 0.001 && rad < minRadInSlice) minRadInSlice = rad;
                  if (rad > maxRadInSlice) maxRadInSlice = rad;
                }
              }
              // Prefer inner wall radius if shell has both inner & outer walls, else 82% of outer radius
              if (Number.isFinite(minRadInSlice) && maxRadInSlice > minRadInSlice * 1.04) {
                rCand = minRadInSlice;
              } else {
                rCand = maxRadInSlice > 0 ? maxRadInSlice : 0.012;
              }
            } else {
              rCand = 0.012;
            }
            if (rCand > rOuterAtStation) rOuterAtStation = rCand;
          }
        }
        if (rOuterAtStation > 0) {
          // Typical brass/woodwind wall thickness: ~1.2–2.5 mm, leaving >= 72% inner airway
          rInner = Math.max(0.0035, rOuterAtStation - Math.min(0.0022, rOuterAtStation * 0.22));
        }
      }

      out.push(rInner > 0 ? rInner : 0.0075);
    }

    // Light 3-point smoothing across stepped CAD segments so conical/flared bells have smooth impedance taper
    if (positives.length >= 2 && out.length >= 5) {
      const smoothed = [...out];
      for (let i = 1; i + 1 < out.length; i++) {
        smoothed[i] = 0.25 * out[i - 1] + 0.5 * out[i] + 0.25 * out[i + 1];
      }
      return smoothed;
    }
    return out;
  };

  return { boreAxis, minCoord, maxCoord, lengthM, radiiAtStations, transverseHoles };
}

/**
 * Slices `node`'s 3D bore into a 1D Kelly–Lochbaum waveguide model and computes
 * its resonant standing-wave frequencies for the current open/closed toneholes.
 */
export function extractBoreWaveguide(
  node: SceneNode,
  jointPositions?: Record<string, number>,
  sampleRate = DEFAULT_SAMPLE_RATE,
): BoreWaveguideModel | null {
  const spec: WindInstrumentSpec | undefined = node.windInstrument;
  if (!spec) return null;

  const slice = inspectNodeBoreGeometry(node);
  const dxCell = SPEED_OF_SOUND_WARM_AIR / sampleRate; // ~7.27 mm per cell at 48 kHz

  // Sample preliminary end radius for radiation end-correction 0.61 * r_bell
  const roughRadii = slice.radiiAtStations(16);
  const mouthRadiusM = spec.mouthRadiusM ?? roughRadii[0] ?? 0.007;
  const bellRadiusM = spec.bellRadiusM ?? roughRadii[roughRadii.length - 1] ?? mouthRadiusM;

  // Compute extra tubing length switched in by depressed brass piston/rotary valves (2^(semitones/12) - 1)
  let valveLengthRatio = 1.0;
  if (spec.valveJoints?.length && jointPositions) {
    let totalSemitones = 0;
    for (const vj of spec.valveJoints) {
      const qVal = Math.abs(jointPositions[vj.jointName] ?? 0);
      const fullStroke = Math.max(0.003, vj.strokeM ?? 0.012);
      const engage = Math.max(0, Math.min(1, (qVal - 0.0015) / (fullStroke * 0.65)));
      totalSemitones += vj.semitones * engage;
    }
    valveLengthRatio = Math.pow(2, totalSemitones / 12);
  }

  const baseBoreLengthM = (spec.boreLengthM && spec.boreLengthM > 0.05 ? spec.boreLengthM : slice.lengthM) * valveLengthRatio;
  const acousticLengthM = baseBoreLengthM + 0.61 * bellRadiusM;

  const exactCells = Math.max(8, Math.min(178, acousticLengthM / dxCell));
  const cellCount = Math.max(8, Math.min(178, Math.floor(exactCells)));
  const flareExp = Math.max(0.5, Math.min(6, spec.flareExponent ?? 2.5));
  const radii: number[] = (spec.mouthRadiusM !== undefined && spec.bellRadiusM !== undefined)
    ? Array.from({ length: cellCount }, (_, k) => {
        const u = cellCount <= 1 ? 0 : k / (cellCount - 1);
        const leadTaper = mouthRadiusM + (bellRadiusM - mouthRadiusM) * 0.08 * u;
        return leadTaper + (bellRadiusM - leadTaper) * Math.pow(u, flareExp);
      })
    : slice.radiiAtStations(cellCount);

  const areas = radii.map((r) => Math.PI * r * r);
  const junctionK: number[] = [];
  for (let i = 0; i + 1 < cellCount; i++) {
    const a0 = areas[i];
    const a1 = areas[i + 1];
    const k = (a0 - a1) / Math.max(1e-12, a0 + a1);
    junctionK.push(+Math.max(-0.92, Math.min(0.92, k)).toFixed(5));
  }

  const neckRadiusM = radii[Math.floor((cellCount - 1) * 0.20)] ?? mouthRadiusM;
  const midRadiusM = radii[Math.floor((cellCount - 1) * 0.72)] ?? neckRadiusM;
  const bodyTaper = midRadiusM / Math.max(1e-4, neckRadiusM);
  const flareRatio = bellRadiusM / Math.max(1e-4, neckRadiusM);
  const boreShape: BoreWaveguideModel['boreShape'] =
    bodyTaper < 1.22
      ? 'cylindrical'
      : flareRatio >= 2.4
        ? 'flared_horn'
        : 'conical';

  // Build tonehole stations from explicit spec.toneholeJoints + any uncovered boolean transverse holes
  const toneholes: ToneholeStation[] = [];
  if (spec.toneholeJoints?.length) {
    for (const th of spec.toneholeJoints) {
      const frac = Math.max(0.1, Math.min(0.92, th.axialFraction));
      const cellIdx = Math.max(1, Math.min(cellCount - 2, Math.round(frac * (cellCount - 1))));
      const rBore = radii[cellIdx] ?? 0.0075;
      const rHole = Math.max(0.0015, (th.diameterMm || 7) / 2000);
      const tEff = 0.0035 + 1.5 * rHole;
      // Keefe low-frequency tonehole shunt: |Z_s / Z_0| = (k_ref * t_eff) * (r_bore / r_hole)^2 at f_ref ≈ 300 Hz
      const kRef = (2 * Math.PI * 300) / SPEED_OF_SOUND_WARM_AIR;
      const zRatio = (kRef * tEff * rBore * rBore) / (rHole * rHole);
      const shunt = -1 / (1 + 2 * zRatio);
      const qVal = jointPositions && th.jointName ? Math.abs(jointPositions[th.jointName] ?? 0) : 0;
      // Pad lifts off hole smoothly between |q| = 0.015 rad (~0.9°) and 0.08 rad (~4.5°)
      const openAmount = jointPositions
        ? Math.max(0, Math.min(1, (qVal - 0.015) / 0.065))
        : 0;
      toneholes.push({
        cellIndex: cellIdx,
        axialFraction: frac,
        radiusMm: +(rHole * 2000).toFixed(1),
        shuntCoeff: +Math.max(-0.85, Math.min(-0.08, shunt)).toFixed(4),
        keyJointName: th.jointName,
        openAmount: +openAmount.toFixed(3),
      });
    }
  } else {
    for (const h of slice.transverseHoles) {
      const cellIdx = Math.max(1, Math.min(cellCount - 2, Math.round(h.axialFraction * (cellCount - 1))));
      const rBore = radii[cellIdx] ?? 0.0075;
      const tEff = h.wallM + 1.5 * h.radiusM;
      const kRef = (2 * Math.PI * 300) / SPEED_OF_SOUND_WARM_AIR;
      const zRatio = (kRef * tEff * rBore * rBore) / (h.radiusM * h.radiusM);
      const shunt = -1 / (1 + 2 * zRatio);
      toneholes.push({
        cellIndex: cellIdx,
        axialFraction: h.axialFraction,
        radiusMm: +(h.radiusM * 2000).toFixed(1),
        shuntCoeff: +Math.max(-0.85, Math.min(-0.08, shunt)).toFixed(4),
        openAmount: 1,
      });
    }
  }
  toneholes.sort((a, b) => a.cellIndex - b.cellIndex);

  // Effective acoustic standing-wave length shortened by the first open tonehole!
  let effectiveLengthM = acousticLengthM;
  const firstOpen = toneholes.find((t) => t.openAmount > 0.35);
  if (firstOpen) {
    // Open hole lattice end-correction adds ~0.8 * r_bore * (1 / openAmount) beyond the hole centre
    const holePosM = firstOpen.axialFraction * baseBoreLengthM;
    const latticeEndM = 0.012 / Math.max(0.35, firstOpen.openAmount);
    effectiveLengthM = Math.min(acousticLengthM, holePosM + latticeEndM);
  }

  // Analytical impedance peaks (playable resonant harmonics of the bore!):
  // - Cylindrical closed-reed bore: quarter-wave odd harmonics f_1, 3*f_1, 5*f_1, 7*f_1 (f_1 = c / 4L)
  // - Conical reed / flared brass horn: half-wave complete harmonic series n * c / (2 * L_eff)
  // - Flute open-open air-jet bore: half-wave complete harmonic series n * c / (2 * L_eff)
  const resonantModesHz: number[] = [];
  if (spec.exciter === 'flute_jet' || boreShape !== 'cylindrical') {
    const fBase = SPEED_OF_SOUND_WARM_AIR / (2 * effectiveLengthM);
    for (let n = 1; n <= 6; n++) {
      // Flared brass bells pull the n=1 pedal tone slightly flat while aligning n=2..6 harmonically
      const pedalFactor = boreShape === 'flared_horn' && n === 1 ? 0.88 : 1.0;
      resonantModesHz.push(+(n * fBase * pedalFactor).toFixed(1));
    }
  } else {
    const f1 = SPEED_OF_SOUND_WARM_AIR / (4 * effectiveLengthM);
    resonantModesHz.push(
      +f1.toFixed(1),
      +(3 * f1).toFixed(1),
      +(5 * f1).toFixed(1),
      +(7 * f1).toFixed(1),
    );
  }

  const bellCutoffHz = +Math.min(
    12000,
    Math.max(450, SPEED_OF_SOUND_WARM_AIR / (2 * Math.PI * Math.max(0.004, bellRadiusM))),
  ).toFixed(1);

  return {
    nodeId: node.id,
    exciter: spec.exciter,
    lengthM: +baseBoreLengthM.toFixed(4),
    mouthRadiusM: +mouthRadiusM.toFixed(5),
    bellRadiusM: +bellRadiusM.toFixed(5),
    cellCount,
    exactCells: +exactCells.toFixed(4),
    junctionK,
    bellCutoffHz,
    boreShape,
    toneholes,
    resonantModesHz,
  };
}
