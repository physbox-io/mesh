// ---------------------------------------------------------------------------
// Inverse Structural Acoustics ("Tune to Concert Pitch")
// ---------------------------------------------------------------------------
//
// Solves for the geometric modification that brings a bar, chime tube, or block
// to a target musical pitch:
// - Bars: carves an underside luthier arch (`luthier_arch`, `csg: 'difference'`)
//   via 1D Legendre Rayleigh-Ritz bisection (`solveVariableBeamModes`), tuning
//   the fundamental f1 while raising the 2nd flexural mode toward the 4:1
//   double-octave marimba harmonic.
// - Tubes / Rods: rescales length L ∝ 1/√f and locates the 0.2242·L free-free
//   nodal suspension point (with optional Ø2.2 mm cord hole).
// - Scale Builder: spawns a 5-note pentatonic or 8-note major set side-by-side.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode } from '../types/scene';
import { geomHydroTriangles } from './hydrostatics';
import {
  estimateBodyModes,
  inferAcousticMaterial,
  solveVariableBeamModes,
  type BodyModalProfile,
} from './modalAudio';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export const CONCERT_NOTES: { note: string; hz: number }[] = [];
for (let oct = 3; oct <= 6; oct++) {
  for (let semitone = 0; semitone < 12; semitone++) {
    const midi = (oct + 1) * 12 + semitone;
    const hz = +(440 * Math.pow(2, (midi - 69) / 12)).toFixed(2);
    CONCERT_NOTES.push({ note: `${NOTE_NAMES[semitone]}${oct}`, hz });
  }
}
CONCERT_NOTES.push({ note: 'C7', hz: 2093.0 });

export function noteToHz(note: string): number | null {
  const m = /^\s*([A-Ga-g])(#|b)?(\d)\s*$/.exec(note);
  if (!m) return null;
  const baseMap: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semi = baseMap[m[1].toUpperCase()];
  if (semi === undefined) return null;
  if (m[2] === '#') semi += 1;
  if (m[2] === 'b') semi -= 1;
  const oct = Number(m[3]);
  const midi = (oct + 1) * 12 + semi;
  return +(440 * Math.pow(2, (midi - 69) / 12)).toFixed(3);
}

export function hzToNoteInfo(hz: number): { note: string; cents: number; nearestHz: number } {
  const clamped = Math.max(16, hz);
  const midiFloat = 69 + 12 * Math.log2(clamped / 440);
  const midiNearest = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midiNearest) * 100);
  const semi = ((midiNearest % 12) + 12) % 12;
  const oct = Math.floor(midiNearest / 12) - 1;
  const nearestHz = +(440 * Math.pow(2, (midiNearest - 69) / 12)).toFixed(2);
  return {
    note: `${NOTE_NAMES[semi]}${oct}`,
    cents,
    nearestHz,
  };
}

export interface TunePitchOptions {
  drillNodalHole?: boolean;
}

export interface TunePitchResult {
  node: SceneNode;
  before: BodyModalProfile;
  after: BodyModalProfile;
  method: 'arch' | 'length_and_arch' | 'tube_length' | 'scale';
  archCutDepthMm?: number;
  nodalOffsetMm?: number;
  summary: string;
}

function cleanAcousticCuts(node: SceneNode): SceneNode {
  const hadAcousticCut = (node.geoms ?? []).some(
    (g) => g.name === 'luthier_arch' || g.name === 'nodal_hole',
  );
  const geoms = (node.geoms ?? []).filter(
    (g) => g.name !== 'luthier_arch' && g.name !== 'nodal_hole' && !(hadAcousticCut && g.csgDerived),
  );
  const stillCsg = geoms.some((g) => g.csg === 'difference' || g.csg === 'intersection');
  return {
    ...node,
    geoms: geoms.map((g) => ({ ...g, size: [...g.size] })),
    csgEnabled: stillCsg ? node.csgEnabled : undefined,
  };
}

function measureBoxAxes(geom: SceneGeom): {
  thickAxis: 0 | 1 | 2;
  widthAxis: 0 | 1 | 2;
  lenAxis: 0 | 1 | 2;
  fullDims: [number, number, number];
} {
  const full: [number, number, number] = [
    2 * (geom.size[0] ?? 0.02),
    2 * (geom.size[1] ?? geom.size[0] ?? 0.02),
    2 * (geom.size[2] ?? geom.size[0] ?? 0.02),
  ];
  const order: (0 | 1 | 2)[] = [0, 1, 2];
  order.sort((a, b) => full[a] - full[b]);
  return {
    thickAxis: order[0],
    widthAxis: order[1],
    lenAxis: order[2],
    fullDims: full,
  };
}

export function tuneBodyToPitch(
  inputNode: SceneNode,
  targetHzRaw: number,
  opts: TunePitchOptions = {},
): TunePitchResult {
  const targetHz = Math.max(25, Math.min(8000, targetHzRaw));
  const before = estimateBodyModes(inputNode);
  const working = cleanAcousticCuts(inputNode);
  const solidGeoms = (working.geoms ?? []).filter(
    (g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual',
  );
  const primary = solidGeoms[0];

  // Case 1: Cylindrical rod / chime tube / capsule
  if (
    working.isTube ||
    primary?.type === 'cylinder' ||
    primary?.type === 'capsule'
  ) {
    const baseProfile = estimateBodyModes({ ...working, tunedPitchHz: undefined });
    // Flexural tube mode f1 ∝ 1 / L^2 => L_new = L_old * sqrt(f_old / targetHz)
    const lengthScale = Math.sqrt(baseProfile.fundamentalHz / targetHz);
    let newLengthM = 0.1;

    working.geoms = working.geoms.map((g) => {
      if (g.type === 'cylinder' || g.type === 'capsule') {
        if (g.fromto && g.fromto.length >= 6) {
          const mx = 0.5 * (g.fromto[0] + g.fromto[3]);
          const my = 0.5 * (g.fromto[1] + g.fromto[4]);
          const mz = 0.5 * (g.fromto[2] + g.fromto[5]);
          const dx = (g.fromto[3] - g.fromto[0]) * 0.5 * lengthScale;
          const dy = (g.fromto[4] - g.fromto[1]) * 0.5 * lengthScale;
          const dz = (g.fromto[5] - g.fromto[2]) * 0.5 * lengthScale;
          if (g.csg !== 'difference') newLengthM = 2 * Math.hypot(dx, dy, dz);
          return {
            ...g,
            fromto: [mx - dx, my - dy, mz - dz, mx + dx, my + dy, mz + dz].map((v) => +v.toFixed(6)),
          };
        }
        const extra = g.csg === 'difference' ? 0.002 : 0;
        const baseHalfL = g.size[1] ?? 0.05;
        const nextHalfL = +(baseHalfL * lengthScale + extra).toFixed(6);
        if (g.csg !== 'difference') {
          newLengthM = 2 * nextHalfL + (g.type === 'capsule' ? 2 * (g.size[0] ?? 0) : 0);
        }
        return {
          ...g,
          size: [g.size[0], nextHalfL, ...g.size.slice(2)],
        };
      }
      return g;
    });
    if (typeof working.height === 'number') {
      working.height = +(working.height * lengthScale).toFixed(6);
    }

    const nodalOffsetM = 0.2242 * newLengthM;
    if (opts.drillNodalHole && primary) {
      const outerR = working.outerRadius ?? primary.size[0] ?? 0.008;
      const holeZ = +(0.5 * newLengthM - nodalOffsetM).toFixed(6);
      const holeRadius = Math.min(0.0014, outerR * 0.22);
      working.geoms.push({
        name: 'nodal_hole',
        type: 'cylinder',
        size: [+holeRadius.toFixed(5), +(outerR * 1.35).toFixed(5)],
        pos: [0, 0, holeZ],
        // Rotate cylinder local +Z onto +X (90 deg around Y: [cos 45°, 0, sin 45°, 0])
        quat: [0.707107, 0, 0.707107, 0],
        csg: 'difference',
        rgba: [0.2, 0.25, 0.3, 0.6],
      });
      working.csgEnabled = true;
    }

    working.tunedPitchHz = +targetHz.toFixed(2);
    const after = estimateBodyModes(working);
    const noteInfo = hzToNoteInfo(after.fundamentalHz);
    return {
      node: working,
      before,
      after,
      method: 'tube_length',
      nodalOffsetMm: +(nodalOffsetM * 1000).toFixed(1),
      summary: `Tuned chime to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz); nodal cord point ${+(nodalOffsetM * 1000).toFixed(1)} mm from top`,
    };
  }

  // Case 2: Rectangular bar / box body -> underside semi-elliptical luthier arch!
  if (primary?.type === 'box' && solidGeoms.length === 1) {
    const mat = inferAcousticMaterial(working);
    const E = mat.modulusGPa * 1e9;
    const rho = Math.max(50, mat.density);
    const { thickAxis, widthAxis, lenAxis, fullDims } = measureBoxAxes(primary);
    const hMin = fullDims[thickAxis];
    const widthM = fullDims[widthAxis];
    let lenM = fullDims[lenAxis];

    let method: TunePitchResult['method'] = 'arch';
    const minSpineM = Math.max(0.0016, hMin * 0.18);
    const maxSafeCut = Math.max(0, hMin - minSpineM);

    const evalForLenAndCut = (L: number, cut: number) => {
      const halfSpan = L * 0.34;
      return solveVariableBeamModes(L, E, rho, (x) => {
        const u = x / halfSpan;
        if (Math.abs(u) >= 1) return hMin;
        return Math.max(hMin * 0.08, hMin - cut * Math.sqrt(1 - u * u));
      })[0];
    };

    const fUnnotched = evalForLenAndCut(lenM, 0);
    const fDeepest = evalForLenAndCut(lenM, maxSafeCut);

    // If targetHz lies outside the pure-arch tuning window of the current blank,
    // first resize the bar's length so a harmonic marimba arch (cut = 0.62 * maxSafeCut) lands near targetHz!
    if (targetHz > fUnnotched * 0.992 || targetHz < fDeepest * 1.02 || lenM < widthM * 2.2) {
      method = 'length_and_arch';
      const nominalCut = maxSafeCut * 0.62;
      const fAtCurLen = evalForLenAndCut(Math.max(lenM, widthM * 2.4), nominalCut);
      const baseLen = Math.max(lenM, widthM * 2.4);
      lenM = Math.max(widthM * 2.2, baseLen * Math.sqrt(fAtCurLen / targetHz));
      const nextSize = [...primary.size];
      nextSize[lenAxis] = +(lenM * 0.5).toFixed(6);
      working.geoms[0] = { ...primary, size: nextSize };
    }

    // Solve 28-step bisection for exact `cutDepth` so f1 == targetHz
    let loCut = 0;
    let hiCut = maxSafeCut;
    for (let iter = 0; iter < 28; iter++) {
      const mid = 0.5 * (loCut + hiCut);
      const fMid = evalForLenAndCut(lenM, mid);
      // Deeper cut thins the spine and LOWERS f1
      if (fMid > targetHz) {
        loCut = mid;
      } else {
        hiCut = mid;
      }
    }
    const cutDepth = +(0.5 * (loCut + hiCut)).toFixed(6);

    if (cutDepth > 0.00025) {
      const archSize: [number, number, number] = [0.01, 0.01, 0.01];
      archSize[lenAxis] = +(lenM * 0.34).toFixed(6);
      archSize[widthAxis] = +(widthM * 2.5).toFixed(6);
      archSize[thickAxis] = cutDepth;

      const archPos: [number, number, number] = [
        primary.pos?.[0] ?? 0,
        primary.pos?.[1] ?? 0,
        primary.pos?.[2] ?? 0,
      ];
      archPos[thickAxis] = +((primary.pos?.[thickAxis] ?? 0) - hMin * 0.5).toFixed(6);

      working.geoms.push({
        name: 'luthier_arch',
        type: 'ellipsoid',
        size: archSize,
        pos: archPos,
        csg: 'difference',
        rgba: [0.85, 0.52, 0.22, 0.45],
      });
      working.csgEnabled = true;
      if (!working.collision) working.collision = 'hull';
    }

    working.tunedPitchHz = +targetHz.toFixed(2);
    const after = estimateBodyModes(working);
    const noteInfo = hzToNoteInfo(after.fundamentalHz);
    return {
      node: working,
      before,
      after,
      method,
      archCutDepthMm: +(cutDepth * 1000).toFixed(2),
      nodalOffsetMm: +(0.2242 * lenM * 1000).toFixed(1),
      summary: `Tuned bar to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz, f₂/f₁ = ${after.overtoneRatio.toFixed(2)}) via ${(cutDepth * 1000).toFixed(2)} mm underside arch`,
    };
  }

  // Case 3: General primitive / mesh block -> uniform acoustic dimension scale (f ∝ 1 / L)
  const baseProfile = estimateBodyModes({ ...working, tunedPitchHz: undefined });
  const scaleFactor = Math.max(0.15, Math.min(6.0, baseProfile.fundamentalHz / targetHz));
  working.geoms = working.geoms.map((g) => {
    const next: SceneGeom = {
      ...g,
      size: g.size.map((s) => +(s * scaleFactor).toFixed(6)),
      ...(g.pos ? { pos: g.pos.map((p) => +(p * scaleFactor).toFixed(6)) } : {}),
    };
    if (g.vertices) next.vertices = g.vertices.map((v) => +(v * scaleFactor).toFixed(6));
    if (g.renderVertices) next.renderVertices = g.renderVertices.map((v) => +(v * scaleFactor).toFixed(6));
    return next;
  });
  working.tunedPitchHz = +targetHz.toFixed(2);
  const after = estimateBodyModes(working);
  const noteInfo = hzToNoteInfo(after.fundamentalHz);
  return {
    node: working,
    before,
    after,
    method: 'scale',
    summary: `Scaled body ×${scaleFactor.toFixed(3)} to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz)`,
  };
}

/**
 * Generates a side-by-side tuned musical scale (5-note pentatonic or 8-note
 * major octave) cloned from `baseNode`.
 */
export function buildTunedScaleNodes(
  baseNode: SceneNode,
  rootNote = 'C4',
  scaleKind: 'pentatonic' | 'major' = 'pentatonic',
): SceneNode[] {
  const rootHz = noteToHz(rootNote) ?? 261.63;
  const intervals = scaleKind === 'pentatonic'
    ? [0, 2, 4, 7, 9]
    : [0, 2, 4, 5, 7, 9, 11, 12];

  // Measure lateral spacing along X/Y so bars sit cleanly side-by-side
  const tris: number[] = [];
  for (const g of baseNode.geoms ?? []) {
    if (!g.csgDerived && g.csg !== 'difference') geomHydroTriangles(g, tris);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
  }
  const spanX = Number.isFinite(minX) ? maxX - minX : 0.04;
  const spanY = Number.isFinite(minY) ? maxY - minY : 0.04;
  // Step along whichever horizontal axis is narrower (bar width rather than bar length!)
  const stepAlongX = spanX <= spanY;
  const pitchStepM = Math.max(0.018, (stepAlongX ? spanX : spanY) * 1.38);

  const basePos = [baseNode.pos[0] ?? 0, baseNode.pos[1] ?? 0, baseNode.pos[2] ?? 0];
  return intervals.map((semi, idx) => {
    const hz = rootHz * Math.pow(2, semi / 12);
    const { note } = hzToNoteInfo(hz);
    const cleanNote = note.replace('#', 's').toLowerCase();
    const cloned: SceneNode = JSON.parse(JSON.stringify(baseNode));
    cloned.id = `${baseNode.id}_${cleanNote}_${idx + 1}`;
    cloned.name = `${baseNode.name || 'Bar'} (${note})`;
    cloned.pos = [
      +(basePos[0] + (stepAlongX ? (idx + 1) * pitchStepM : 0)).toFixed(5),
      +(basePos[1] + (!stepAlongX ? (idx + 1) * pitchStepM : 0)).toFixed(5),
      basePos[2],
    ];
    return tuneBodyToPitch(cloned, hz).node;
  });
}
