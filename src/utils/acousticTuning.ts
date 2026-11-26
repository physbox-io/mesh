// ---------------------------------------------------------------------------
// Inverse Structural Acoustics ("Tune to Concert Pitch")
// ---------------------------------------------------------------------------
//
// Solves for the geometric or tension modification that brings a bar, chime
// tube, block, tensioned membrane, external resonator tube, or wind bore to a
// target musical pitch:
// - Bars: carves an underside luthier arch (`luthier_arch`, `csg: 'difference'`)
//   against the 3D Timoshenko Rayleigh-Ritz solver (`estimateBodyModes`), tuning
//   the fundamental f1 while raising the 2nd flexural mode toward the 4:1
//   double-octave marimba harmonic.
// - Tubes / Rods / Capsules: rescales flexural length L ∝ 1/√f (regenerating
//   `isTube` meshes and accounting for capsule hemisphere endcaps) and locates
//   the 0.2242·L free-free nodal suspension point in the rod's true 3D frame.
// - Membranes (`acousticMembrane`): solves isotropic tension T_s (N/m) with
//   enclosed kettle / vented shell air coupling (`tuneMembraneToPitch`).
// - External Tube Resonators (`resonatorTube`): tunes λ/4 or λ/2 air column
//   length with Levine-Schwinger end correction (`tuneResonatorTubeToPitch`).
// - Wind Instruments (`windInstrument`): tunes 3D TMM bore length L ∝ 1/f or
//   autonomous flap-valve frequency (`tuneWindInstrumentToPitch`).
// - Scale Builder: spawns a 5-note pentatonic or 8-note major set side-by-side
//   in world-aligned non-overlapping spacing.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { fromtoFrame, geomMatrixOf } from './csg';
import { generateTubeMeshData } from './geom';
import { geomHydroTriangles } from './hydrostatics';
import { evaluateTensionedMembrane, tuneMembraneToPitch } from './membraneAcoustics';
import {
  estimateBodyModes,
  type BodyModalProfile,
} from './modalAudio';
import { extractTubeAirColumn, tuneResonatorTubeToPitch } from './resonatorAcoustics';
import { extractBoreWaveguide, solvePlayableWindVoice } from './windAcoustics';

export { tuneMembraneToPitch, tuneResonatorTubeToPitch };

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
  sceneNodes?: SceneNode[];
  jointPositions?: Record<string, number>;
}

export interface TunePitchResult {
  node: SceneNode;
  before: BodyModalProfile;
  after: BodyModalProfile;
  method:
    | 'arch'
    | 'length_and_arch'
    | 'tube_length'
    | 'scale'
    | 'membrane_tension'
    | 'resonator_bore'
    | 'wind_bore';
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

function scaleGeomUniformly(g: SceneGeom, scaleFactor: number): SceneGeom {
  const next: SceneGeom = {
    ...g,
    size: g.size.map((s) => +(s * scaleFactor).toFixed(6)),
    ...(g.pos ? { pos: g.pos.map((p) => +(p * scaleFactor).toFixed(6)) } : {}),
    ...(g.fromto ? { fromto: g.fromto.map((v) => +(v * scaleFactor).toFixed(6)) } : {}),
    ...(g.cutAt ? { cutAt: g.cutAt.map((v) => +(v * scaleFactor).toFixed(6)) } : {}),
    ...(typeof g.cutDepth === 'number' ? { cutDepth: +(g.cutDepth * scaleFactor).toFixed(6) } : {}),
    ...(typeof g.mass === 'number' ? { mass: +(g.mass * Math.pow(scaleFactor, 3)).toFixed(6) } : {}),
  };
  if (g.vertices) next.vertices = g.vertices.map((v) => +(v * scaleFactor).toFixed(6));
  if (g.renderVertices) next.renderVertices = g.renderVertices.map((v) => +(v * scaleFactor).toFixed(6));
  if (g.colliderVertices) next.colliderVertices = g.colliderVertices.map((v) => +(v * scaleFactor).toFixed(6));
  if (g.baseVertices) next.baseVertices = g.baseVertices.map((v) => +(v * scaleFactor).toFixed(6));
  if (g.baseRenderVertices) next.baseRenderVertices = g.baseRenderVertices.map((v) => +(v * scaleFactor).toFixed(6));
  return next;
}

function scaleNodeUniformly(node: SceneNode, scaleFactor: number, isRoot = true): SceneNode {
  const scaled: SceneNode = {
    ...node,
    ...(isRoot ? {} : { pos: (node.pos ?? [0, 0, 0]).map((p) => +(p * scaleFactor).toFixed(6)) }),
    ...(typeof node.width === 'number' ? { width: +(node.width * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.depth === 'number' ? { depth: +(node.depth * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.height === 'number' ? { height: +(node.height * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.radius === 'number' ? { radius: +(node.radius * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.innerRadius === 'number' ? { innerRadius: +(node.innerRadius * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.outerRadius === 'number' ? { outerRadius: +(node.outerRadius * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.majorRadius === 'number' ? { majorRadius: +(node.majorRadius * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.tubeRadius === 'number' ? { tubeRadius: +(node.tubeRadius * scaleFactor).toFixed(6) } : {}),
    ...(typeof node.mass === 'number' ? { mass: +(node.mass * Math.pow(scaleFactor, 3)).toFixed(6) } : {}),
    geoms: (node.geoms ?? []).map((g) => scaleGeomUniformly(g, scaleFactor)),
    children: (node.children ?? []).map((ch) =>
      (ch.joints?.length ?? 0) > 0 || ch.simulation || ch.acousticString
        ? ch
        : scaleNodeUniformly(ch, scaleFactor, false),
    ),
  };
  return scaled;
}

function scaleGeomAlongSingleAxis(g: SceneGeom, axis: 0 | 1 | 2, lenScale: number): SceneGeom {
  const next: SceneGeom = {
    ...g,
    size: [...g.size],
    ...(g.pos
      ? { pos: g.pos.map((v, i) => (i === axis ? +(v * lenScale).toFixed(6) : v)) }
      : {}),
  };
  if (g.fromto && g.fromto.length >= 6) {
    const ft = [...g.fromto];
    ft[axis] = +(ft[axis] * lenScale).toFixed(6);
    ft[axis + 3] = +(ft[axis + 3] * lenScale).toFixed(6);
    next.fromto = ft;
  } else if (g.type === 'box' || g.type === 'ellipsoid') {
    if (next.size.length > axis) {
      next.size[axis] = +(next.size[axis] * lenScale).toFixed(6);
    }
  } else if (g.type === 'cylinder' || g.type === 'capsule') {
    // Check whether cylinder's local +Z aligns with `axis`
    const m = geomMatrixOf(g).elements;
    const zAlign = Math.abs(m[8 + axis]);
    if (zAlign > 0.7 && next.size.length >= 2) {
      next.size[1] = +(next.size[1] * lenScale).toFixed(6);
    }
  } else if (g.type === 'mesh') {
    const scaleAxisVec = (src: number[], targetAxis: 0 | 1 | 2): number[] => {
      const out = new Array<number>(src.length);
      for (let i = 0; i + 2 < src.length; i += 3) {
        out[i] = targetAxis === 0 ? +(src[i] * lenScale).toFixed(6) : src[i];
        out[i + 1] = targetAxis === 1 ? +(src[i + 1] * lenScale).toFixed(6) : src[i + 1];
        out[i + 2] = targetAxis === 2 ? +(src[i + 2] * lenScale).toFixed(6) : src[i + 2];
      }
      return out;
    };
    // Three.js Y-up (`vertices`, `baseVertices`) corresponds to Z-up via (x_y, y_y, z_y) = (x_z, z_z, -y_z):
    // Z-up X -> Y-up 0, Z-up Y -> Y-up 2, Z-up Z -> Y-up 1!
    const yupAxis: 0 | 1 | 2 = axis === 0 ? 0 : axis === 1 ? 2 : 1;
    if (g.renderVertices) next.renderVertices = scaleAxisVec(g.renderVertices, axis);
    if (g.colliderVertices) next.colliderVertices = scaleAxisVec(g.colliderVertices, axis);
    if (g.baseRenderVertices) next.baseRenderVertices = scaleAxisVec(g.baseRenderVertices, axis);
    if (g.vertices) next.vertices = scaleAxisVec(g.vertices, yupAxis);
    if (g.baseVertices) next.baseVertices = scaleAxisVec(g.baseVertices, yupAxis);
  }
  return next;
}

/**
 * Tunes a `windInstrument` body (`reed`, `brass_lip`, `flute_jet`, or `flap_valve`)
 * to `targetHzRaw` by scaling its 3D acoustic bore length L ∝ 1 / f (never solid-wall
 * flexural 1/√f, and never drilling a bore-breaching nodal hole!).
 */
export function tuneWindInstrumentToPitch(
  node: SceneNode,
  targetHzRaw: number,
  jointPositions?: Record<string, number>,
): SceneNode {
  const spec = node.windInstrument;
  if (!spec) return node;
  const safeTargetHz = Number.isFinite(targetHzRaw) ? targetHzRaw : 261.63;
  const targetHz = Math.max(24, Math.min(3500, safeTargetHz));

  // Autonomous compliant flap-valve (`flap_valve`):
  // oscillation pitch is governed directly by the valve's mechanical natural frequency `embouchureHz`!
  if (spec.exciter === 'flap_valve') {
    return {
      ...node,
      tunedPitchHz: +targetHz.toFixed(2),
      windInstrument: {
        ...spec,
        embouchureHz: +targetHz.toFixed(2),
      },
    };
  }

  const curBore = extractBoreWaveguide(node, jointPositions);
  if (!curBore) {
    return {
      ...node,
      tunedPitchHz: +targetHz.toFixed(2),
      windInstrument: { ...spec, embouchureHz: +targetHz.toFixed(2) },
    };
  }

  const testBreath = Math.max(3.2, spec.breathKPa || 3.5);
  const curVoice = solvePlayableWindVoice(curBore, testBreath, spec.embouchureHz || targetHz);
  const curHz = Math.max(20, curVoice.active ? curVoice.pitchHz : (curBore.resonantModesHz[0] ?? 261.63));

  // Detect bore axis in body-local Z-up space from node's solid AABB
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const tris: number[] = [];
  for (const g of node.geoms ?? []) {
    if (!g.csgDerived && g.csg !== 'difference') geomHydroTriangles(g, tris);
  }
  for (let i = 0; i + 2 < tris.length; i += 3) {
    if (tris[i] < x0) x0 = tris[i]; if (tris[i] > x1) x1 = tris[i];
    if (tris[i + 1] < y0) y0 = tris[i + 1]; if (tris[i + 1] > y1) y1 = tris[i + 1];
    if (tris[i + 2] < z0) z0 = tris[i + 2]; if (tris[i + 2] > z1) z1 = tris[i + 2];
  }
  const spans: [number, number, number] = [
    Number.isFinite(x0) ? x1 - x0 : 0.04,
    Number.isFinite(y0) ? y1 - y0 : 0.04,
    Number.isFinite(z0) ? z1 - z0 : 0.20,
  ];
  const boreAxis: 0 | 1 | 2 =
    spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[0] && spans[1] >= spans[2] ? 1 : 2;

  const applyBoreScale = (src: SceneNode, lenScale: number, nextEmbHz: number): SceneNode => {
    const clampedScale = Math.max(0.18, Math.min(5.5, lenScale));
    const nextSpec = {
      ...src.windInstrument!,
      embouchureHz: +nextEmbHz.toFixed(2),
      ...(typeof src.windInstrument!.boreLengthM === 'number'
        ? { boreLengthM: +(src.windInstrument!.boreLengthM * clampedScale).toFixed(6) }
        : {}),
    };
    const nextNode: SceneNode = {
      ...src,
      ...(src.isTube && typeof src.height === 'number' ? { height: +(src.height * clampedScale).toFixed(6) } : {}),
      windInstrument: nextSpec,
      geoms:
        src.isTube && typeof src.innerRadius === 'number' && typeof src.outerRadius === 'number' && typeof src.height === 'number'
          ? (() => {
              const nh = +(src.height * clampedScale).toFixed(6);
              const md = generateTubeMeshData(src.innerRadius, src.outerRadius, nh, 24);
              return (src.geoms ?? []).map((g, i) =>
                i === 0 && g.type === 'mesh'
                  ? { ...g, vertices: md.vertices, renderVertices: md.renderVertices, faces: md.faces }
                  : scaleGeomAlongSingleAxis(g, boreAxis, clampedScale),
              );
            })()
          : (src.geoms ?? []).map((g) => scaleGeomAlongSingleAxis(g, boreAxis, clampedScale)),
      children: (src.children ?? []).map((ch) => ({
        ...ch,
        pos: (ch.pos ?? [0, 0, 0]).map((v, i) => (i === boreAxis ? +(v * clampedScale).toFixed(6) : v)),
      })),
    };
    return nextNode;
  };

  // Scale embouchureHz in tandem with targetHz so brass/reed slotting locks onto the intended partial!
  const embRatio = (spec.embouchureHz || curHz) / curHz;
  const nextEmbHz = Math.max(35, Math.min(2000, targetHz * embRatio));

  const clampScale = (s: number) => Math.max(0.18, Math.min(5.5, s));
  let bestNode = applyBoreScale(node, curHz / targetHz, nextEmbHz);
  let bestHz = targetHz;
  let bestErrOct = Infinity;

  const evalCandidate = (rawScale: number): { scale: number; node: SceneNode; hz: number } => {
    const cs = clampScale(rawScale);
    const cand = applyBoreScale(node, cs, nextEmbHz);
    const bore = extractBoreWaveguide(cand, jointPositions);
    if (!bore) return { scale: cs, node: cand, hz: targetHz };
    const solved = solvePlayableWindVoice(bore, testBreath, nextEmbHz);
    const hz = Math.max(20, solved.active ? solved.pitchHz : (bore.resonantModesHz[0] ?? targetHz));
    const errOct = Math.abs(Math.log2(hz / targetHz));
    if (errOct < bestErrOct) {
      bestErrOct = errOct;
      bestNode = cand;
      bestHz = hz;
    }
    return { scale: cs, node: cand, hz };
  };

  // Iterative TMM refinement across nonlinear Norris-Sheng radiation impedance Z_rad & end corrections (<= ~0.2 cents)
  const tolRel = 0.0001;
  let p0 = evalCandidate(curHz / targetHz);
  if (Math.abs(p0.hz - targetHz) / targetHz > tolRel) {
    let p1 = evalCandidate(p0.scale * (p0.hz / targetHz));

    // If p0 and p1 remain on the same side of targetHz, expand once to bracket the root
    if (
      Math.abs(p1.hz - targetHz) / targetHz > tolRel &&
      (p0.hz - targetHz) * (p1.hz - targetHz) > 0
    ) {
      const nextS = clampScale(p1.scale * Math.pow(p1.hz / targetHz, 1.35));
      if (Math.abs(nextS - p1.scale) >= 1e-5) {
        p0 = p1;
        p1 = evalCandidate(nextS);
      }
    }

    if (Math.abs(bestHz - targetHz) / targetHz > tolRel) {
      if ((p0.hz - targetHz) * (p1.hz - targetHz) < 0) {
        let lo = p0.hz > p1.hz ? p0 : p1;
        let hi = p0.hz > p1.hz ? p1 : p0;
        for (let iter = 0; iter < 6; iter++) {
          if (Math.abs(bestHz - targetHz) / targetHz <= tolRel) break;
          if (Math.abs(hi.scale - lo.scale) <= 1e-5) break;
          const denom = lo.hz - hi.hz;
          let secantS =
            denom > 1e-6
              ? lo.scale + ((lo.hz - targetHz) / denom) * (hi.scale - lo.scale)
              : 0.5 * (lo.scale + hi.scale);
          const span = hi.scale - lo.scale;
          const minS = lo.scale + 0.15 * span;
          const maxS = hi.scale - 0.15 * span;
          if (secantS < minS || secantS > maxS || iter === 1) {
            secantS = iter === 1 ? 0.5 * (lo.scale + hi.scale) : Math.max(minS, Math.min(maxS, secantS));
          }
          const mid = evalCandidate(secantS);
          if (mid.hz > targetHz) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
      } else {
        for (let iter = 0; iter < 4; iter++) {
          if (Math.abs(bestHz - targetHz) / targetHz <= tolRel) break;
          const df = p1.hz - p0.hz;
          let nextS =
            Math.abs(df) > 0.05 && Math.abs(p1.scale - p0.scale) > 1e-5
              ? p1.scale + ((targetHz - p1.hz) / df) * (p1.scale - p0.scale)
              : p1.scale * (p1.hz / targetHz);
          nextS = Math.max(p1.scale * 0.75, Math.min(p1.scale * 1.33, nextS));
          const pNext = evalCandidate(nextS);
          p0 = p1;
          p1 = pNext;
        }
      }
    }
  }

  bestNode.tunedPitchHz = +bestHz.toFixed(2);
  return bestNode;
}

export function tuneBodyToPitch(
  inputNode: SceneNode,
  targetHzRaw: number,
  opts: TunePitchOptions = {},
): TunePitchResult {
  const safeTargetHz = Number.isFinite(targetHzRaw) ? targetHzRaw : 261.63;
  const targetHz = Math.max(25, Math.min(8000, safeTargetHz));

  // Specialized Path A: Tensioned 2D Membrane (`acousticMembrane`)
  if (inputNode.acousticMembrane) {
    const beforeEval = evaluateTensionedMembrane(inputNode, opts.sceneNodes);
    const before = beforeEval ? beforeEval.profile : estimateBodyModes(inputNode);
    const tunedNode = tuneMembraneToPitch(inputNode, targetHz, opts.sceneNodes);
    const afterEval = evaluateTensionedMembrane(tunedNode, opts.sceneNodes);
    const after = afterEval ? afterEval.profile : estimateBodyModes(tunedNode);
    const noteInfo = hzToNoteInfo(after.fundamentalHz);
    return {
      node: tunedNode,
      before,
      after,
      method: 'membrane_tension',
      summary: `Tuned ${tunedNode.acousticMembrane?.material ?? 'membrane'} head to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz) at ${tunedNode.acousticMembrane?.tensionNPerM.toFixed(0)} N/m`,
    };
  }

  // Specialized Path B: External Standing-Wave Resonator Tube (`resonatorTube`)
  if (inputNode.resonatorTube) {
    const beforeCol = extractTubeAirColumn(inputNode);
    const beforeBase = estimateBodyModes(inputNode);
    const before: BodyModalProfile = beforeCol
      ? { ...beforeBase, fundamentalHz: beforeCol.fundamentalHz }
      : beforeBase;
    const tunedNode = tuneResonatorTubeToPitch(inputNode, targetHz);
    const afterCol = extractTubeAirColumn(tunedNode);
    const afterBase = estimateBodyModes(tunedNode);
    const after: BodyModalProfile = afterCol
      ? { ...afterBase, fundamentalHz: afterCol.fundamentalHz }
      : afterBase;
    const noteInfo = hzToNoteInfo(after.fundamentalHz);
    return {
      node: tunedNode,
      before,
      after,
      method: 'resonator_bore',
      summary: `Tuned ${afterCol?.endCondition === 'open_open' ? 'λ/2 open' : 'λ/4 stopped'} resonator tube to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz, L = ${((afterCol?.boreLengthM ?? 0.15) * 1000).toFixed(1)} mm)`,
    };
  }

  // Specialized Path C: Wind Bore Instrument (`windInstrument`)
  if (inputNode.windInstrument) {
    const beforeBore = extractBoreWaveguide(inputNode, opts.jointPositions);
    const beforeSolved = beforeBore
      ? solvePlayableWindVoice(beforeBore, Math.max(3.2, inputNode.windInstrument.breathKPa || 3.5), inputNode.windInstrument.embouchureHz)
      : null;
    const beforeBase = estimateBodyModes(inputNode);
    const before: BodyModalProfile = beforeSolved
      ? { ...beforeBase, fundamentalHz: +beforeSolved.pitchHz.toFixed(2) }
      : beforeBase;
    const tunedNode = tuneWindInstrumentToPitch(inputNode, targetHz, opts.jointPositions);
    const afterBore = extractBoreWaveguide(tunedNode, opts.jointPositions);
    const afterSolved = afterBore && tunedNode.windInstrument
      ? solvePlayableWindVoice(afterBore, Math.max(3.2, tunedNode.windInstrument.breathKPa || 3.5), tunedNode.windInstrument.embouchureHz)
      : null;
    const afterBase = estimateBodyModes(tunedNode);
    const after: BodyModalProfile = afterSolved
      ? { ...afterBase, fundamentalHz: +afterSolved.pitchHz.toFixed(2) }
      : afterBase;
    const noteInfo = hzToNoteInfo(after.fundamentalHz);
    return {
      node: tunedNode,
      before,
      after,
      method: 'wind_bore',
      summary: `Tuned wind bore to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz)`,
    };
  }

  const before = estimateBodyModes(inputNode);
  const working = cleanAcousticCuts(inputNode);
  const solidGeoms = (working.geoms ?? []).filter(
    (g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual',
  );
  const primary = solidGeoms[0];

  // Case 1: Cylindrical rod / chime tube / capsule (`isTube` mesh OR `cylinder`/`capsule` primitive)
  if (
    working.isTube ||
    primary?.type === 'cylinder' ||
    primary?.type === 'capsule'
  ) {
    const baseProfile = estimateBodyModes({ ...working, tunedPitchHz: undefined });
    // Flexural tube/rod mode f1 ∝ 1 / L^2 => L_new = L_old * sqrt(f_old / targetHz)
    const lengthScale = Math.sqrt(baseProfile.fundamentalHz / targetHz);

    // Measure current outer diameter so if high `targetHz` would shrink L / D below the 1.85 slender-beam threshold,
    // we also thin diameter proportionally to stay inside the true free-free chime beam regime!
    const curOuterR =
      working.outerRadius ??
      (primary?.type === 'cylinder' || primary?.type === 'capsule' ? (primary.size[0] ?? 0.008) : 0.015);
    let curLenEst = working.height ?? 0.16;
    if (primary && (primary.type === 'cylinder' || primary.type === 'capsule')) {
      if (primary.fromto && primary.fromto.length >= 6) {
        const trunk = Math.hypot(
          primary.fromto[3] - primary.fromto[0],
          primary.fromto[4] - primary.fromto[1],
          primary.fromto[5] - primary.fromto[2],
        );
        curLenEst = trunk + (primary.type === 'capsule' ? 2 * (primary.size[0] ?? 0) : 0);
      } else {
        curLenEst = 2 * (primary.size[1] ?? 0.05) + (primary.type === 'capsule' ? 2 * (primary.size[0] ?? 0) : 0);
      }
    }

    // If pure L ∝ 1/√f would make L < 2.1 * D (stubby cylinder dropping out of beam regime!),
    // co-scale radius & length uniformly (`f ∝ 1 / s` when L/D is held constant above 2.1!)
    const projectedSlenderness = (curLenEst * lengthScale) / Math.max(1e-4, 2 * curOuterR);
    let radialScale = 1.0;
    let axialScale = lengthScale;
    if (projectedSlenderness < 2.15) {
      const targetAspect = Math.max(2.25, curLenEst / Math.max(1e-4, 2 * curOuterR));
      // With L_new / D_new = targetAspect and f ∝ D / L^2:
      // f_new / f_old = (rScale / aScale^2) = targetHz / f_old, with L_old * aScale = targetAspect * 2 * curOuterR * rScale
      // => rScale / aScale = (curLenEst / (2 * curOuterR * targetAspect))
      const ratioROverA = curLenEst / Math.max(1e-4, 2 * curOuterR * targetAspect);
      axialScale = (baseProfile.fundamentalHz / targetHz) * ratioROverA;
      radialScale = axialScale * ratioROverA;
    }

    const applyTubeScale = (target: SceneNode, aScale: number, rScale: number): number => {
      let measuredLenM = 0.1;
      if (typeof target.innerRadius === 'number' && rScale !== 1.0) {
        target.innerRadius = +(target.innerRadius * rScale).toFixed(6);
      }
      if (typeof target.outerRadius === 'number' && rScale !== 1.0) {
        target.outerRadius = +(target.outerRadius * rScale).toFixed(6);
      }
      if (typeof target.height === 'number') {
        target.height = +(target.height * aScale).toFixed(6);
        measuredLenM = target.height;
      }

      target.geoms = (target.geoms ?? []).map((g, idx) => {
        if (g.name === 'nodal_hole') return g;
        if (target.isTube && g.type === 'mesh') {
          const rIn = target.innerRadius ?? 0.015;
          const rOut = Math.max(rIn + 0.001, target.outerRadius ?? 0.025);
          const hTube = target.height ?? 0.12;
          measuredLenM = hTube;
          if (!target.sculptEdited && idx === 0) {
            const md = generateTubeMeshData(rIn, rOut, hTube, 24);
            return {
              ...g,
              vertices: md.vertices,
              renderVertices: md.renderVertices,
              faces: md.faces,
              ...(typeof g.mass === 'number' ? { mass: +(g.mass * aScale * rScale * rScale).toFixed(6) } : {}),
            };
          }
          // Sculpted tube mesh: stretch vertices directly along Z (and radially in XY when rScale !== 1)
          const rv = g.renderVertices
            ? g.renderVertices.map((v, k) => +((k % 3 === 2 ? v * aScale : v * rScale)).toFixed(6))
            : undefined;
          const yv = g.vertices
            ? g.vertices.map((v, k) => +((k % 3 === 1 ? v * aScale : v * rScale)).toFixed(6))
            : undefined;
          return {
            ...g,
            ...(rv ? { renderVertices: rv } : {}),
            ...(yv ? { vertices: yv } : {}),
            ...(typeof g.mass === 'number' ? { mass: +(g.mass * aScale * rScale * rScale).toFixed(6) } : {}),
          };
        }

        if (g.type === 'cylinder' || g.type === 'capsule') {
          const nextR = +((g.size[0] ?? 0.008) * rScale).toFixed(6);
          if (g.fromto && g.fromto.length >= 6) {
            const mx = 0.5 * (g.fromto[0] + g.fromto[3]);
            const my = 0.5 * (g.fromto[1] + g.fromto[4]);
            const mz = 0.5 * (g.fromto[2] + g.fromto[5]);
            const vx = g.fromto[3] - g.fromto[0];
            const vy = g.fromto[4] - g.fromto[1];
            const vz = g.fromto[5] - g.fromto[2];
            const oldTrunk = Math.hypot(vx, vy, vz);
            const oldTotal = oldTrunk + (g.type === 'capsule' ? 2 * (g.size[0] ?? 0) : 0);
            const nextTotal = Math.max(4 * nextR, oldTotal * aScale);
            const nextTrunk = g.type === 'capsule' ? Math.max(1e-4, nextTotal - 2 * nextR) : nextTotal;
            const trunkRatio = oldTrunk > 1e-6 ? nextTrunk / oldTrunk : aScale;
            const dx = vx * 0.5 * trunkRatio;
            const dy = vy * 0.5 * trunkRatio;
            const dz = vz * 0.5 * trunkRatio;
            if (g.csg !== 'difference') measuredLenM = nextTotal;
            return {
              ...g,
              size: [nextR, ...g.size.slice(1)],
              fromto: [mx - dx, my - dy, mz - dz, mx + dx, my + dy, mz + dz].map((v) => +v.toFixed(6)),
              ...(typeof g.mass === 'number' ? { mass: +(g.mass * aScale * rScale * rScale).toFixed(6) } : {}),
            };
          }
          const extra = g.csg === 'difference' ? 0.002 : 0;
          const oldR = g.size[0] ?? 0.008;
          const baseHalfL = g.size[1] ?? 0.05;
          const oldTotal = 2 * baseHalfL + (g.type === 'capsule' ? 2 * oldR : 0);
          const nextTotal = Math.max(4 * nextR, oldTotal * aScale);
          const nextHalfL = +(
            (g.type === 'capsule' ? 0.5 * Math.max(2e-4, nextTotal - 2 * nextR) : 0.5 * nextTotal) + extra
          ).toFixed(6);
          if (g.csg !== 'difference') {
            measuredLenM = 2 * nextHalfL + (g.type === 'capsule' ? 2 * nextR : 0);
          }
          return {
            ...g,
            size: [nextR, nextHalfL, ...g.size.slice(2)],
            ...(typeof g.mass === 'number' ? { mass: +(g.mass * aScale * rScale * rScale).toFixed(6) } : {}),
          };
        }
        return g;
      });
      return measuredLenM;
    };

    let newLengthM = applyTubeScale(working, axialScale, radialScale);

    const placeNodalHole = (target: SceneNode, lenM: number) => {
      target.geoms = target.geoms.filter((g) => g.name !== 'nodal_hole');
      const curPrimary = (target.geoms ?? []).find(
        (g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual',
      );
      if (!opts.drillNodalHole || !curPrimary) return;

      const outerR = target.outerRadius ?? curPrimary.size[0] ?? 0.008;
      const nodalOff = 0.2242 * lenM;
      const holeAxialCoord = 0.5 * lenM - nodalOff;
      const holeRadius = Math.min(0.0014, outerR * 0.22);

      // Transform local [0, 0, holeAxialCoord] and transverse +X cylinder axis into `curPrimary`'s true 3D pose!
      const rodPose =
        (curPrimary.type === 'cylinder' || curPrimary.type === 'capsule') &&
        curPrimary.fromto &&
        curPrimary.fromto.length >= 6
          ? fromtoFrame(curPrimary.fromto).matrix
          : geomMatrixOf(curPrimary);

      const holePosVec = new THREE.Vector3(0, 0, holeAxialCoord).applyMatrix4(rodPose);
      const rodQuat = new THREE.Quaternion().setFromRotationMatrix(rodPose);
      // Local cylinder +Z rotated +90° around Y points along rod-local +X (perpendicular to rod +Z axis)
      const local90Y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI * 0.5);
      const holeThreeQuat = rodQuat.multiply(local90Y).normalize();

      target.geoms.push({
        name: 'nodal_hole',
        type: 'cylinder',
        size: [+holeRadius.toFixed(5), +(outerR * 1.35).toFixed(5)],
        pos: [+holePosVec.x.toFixed(6), +holePosVec.y.toFixed(6), +holePosVec.z.toFixed(6)],
        // MuJoCo quaternion convention is [w, x, y, z]
        quat: [
          +holeThreeQuat.w.toFixed(6),
          +holeThreeQuat.x.toFixed(6),
          +holeThreeQuat.y.toFixed(6),
          +holeThreeQuat.z.toFixed(6),
        ],
        csg: 'difference',
        rgba: [0.2, 0.25, 0.3, 0.6],
      });
      target.csgEnabled = true;
    };

    placeNodalHole(working, newLengthM);

    // Up to 2 Timoshenko & nodal-hole fine-trim passes so pure 3D geometry lands within <0.25% of targetHz!
    for (let trimIter = 0; trimIter < 2; trimIter++) {
      working.sculptVersion = (working.sculptVersion ?? 0) + 1;
      const curHz = estimateBodyModes(working).fundamentalHz;
      if (Math.abs(curHz - targetHz) / targetHz <= 0.002) break;
      const trimScale = Math.sqrt(curHz / targetHz);
      newLengthM = applyTubeScale(working, trimScale, 1.0);
      if (opts.drillNodalHole) placeNodalHole(working, newLengthM);
    }

    const finalNodalOffsetM = 0.2242 * newLengthM;
    working.tunedPitchHz = +targetHz.toFixed(2);
    const after = estimateBodyModes(working);
    const noteInfo = hzToNoteInfo(after.fundamentalHz);
    return {
      node: working,
      before,
      after,
      method: 'tube_length',
      nodalOffsetMm: +(finalNodalOffsetM * 1000).toFixed(1),
      summary: `Tuned chime to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz); nodal cord point ${+(finalNodalOffsetM * 1000).toFixed(1)} mm from top`,
    };
  }

  // Case 2: Rectangular bar / box body -> underside semi-elliptical luthier arch!
  if (primary?.type === 'box' && solidGeoms.length === 1) {
    const { thickAxis, widthAxis, lenAxis, fullDims } = measureBoxAxes(primary);
    const hMin = fullDims[thickAxis];
    const widthM = fullDims[widthAxis];
    let lenM = fullDims[lenAxis];
    const visualExtras = (working.geoms ?? []).filter((g) => g !== primary && g.role === 'visual');

    let method: TunePitchResult['method'] = 'arch';
    const minSpineM = Math.max(0.0016, hMin * 0.18);
    const maxSafeCut = Math.max(0, hMin - minSpineM);

    const primaryPose = geomMatrixOf(primary);
    const primaryRot = primaryPose.clone();
    primaryRot.setPosition(0, 0, 0);

    const buildArchCandidate = (L: number, cut: number): SceneNode => {
      const nextPrimary: SceneGeom = {
        ...primary,
        size: primary.size.map((s, idx) => (idx === lenAxis ? +(L * 0.5).toFixed(6) : s)),
      };
      if (cut <= 0.00025) {
        return { ...working, geoms: [nextPrimary, ...visualExtras], csgEnabled: undefined };
      }
      const archSize: [number, number, number] = [0.01, 0.01, 0.01];
      archSize[lenAxis] = +(L * 0.34).toFixed(6);
      archSize[widthAxis] = +(widthM * 2.5).toFixed(6);
      archSize[thickAxis] = +cut.toFixed(6);

      const localOffset = new THREE.Vector3(0, 0, 0);
      localOffset.setComponent(thickAxis, -hMin * 0.5);
      localOffset.applyMatrix4(primaryRot);
      const archPos: [number, number, number] = [
        +((primary.pos?.[0] ?? 0) + localOffset.x).toFixed(6),
        +((primary.pos?.[1] ?? 0) + localOffset.y).toFixed(6),
        +((primary.pos?.[2] ?? 0) + localOffset.z).toFixed(6),
      ];
      return {
        ...working,
        csgEnabled: true,
        geoms: [
          nextPrimary,
          {
            name: 'luthier_arch',
            type: 'ellipsoid',
            size: archSize,
            pos: archPos,
            ...(primary.quat ? { quat: [...primary.quat] } : {}),
            ...(!primary.quat && primary.euler ? { euler: [...primary.euler] } : {}),
            csg: 'difference',
            rgba: [0.85, 0.52, 0.22, 0.45],
          },
          ...visualExtras,
        ],
      };
    };

    const eval3DBarHz = (L: number, cut: number) => {
      // Vary sculptVersion per probe so section cache distinguishes bisection steps on identical id
      const cand = buildArchCandidate(L, cut);
      cand.sculptVersion = Math.round(L * 1e6) * 1000 + Math.round(cut * 1e6);
      return estimateBodyModes(cand).fundamentalHz;
    };

    const fUnnotched = eval3DBarHz(lenM, 0);
    const fDeepest = eval3DBarHz(lenM, maxSafeCut);

    // If targetHz lies outside the pure-arch tuning window of the current blank,
    // first resize the bar's length so a harmonic marimba arch (cut = 0.62 * maxSafeCut) lands near targetHz!
    if (targetHz > fUnnotched * 0.992 || targetHz < fDeepest * 1.02 || lenM < widthM * 2.2) {
      method = 'length_and_arch';
      const nominalCut = maxSafeCut * 0.62;
      const baseLen = Math.max(lenM, widthM * 2.4);
      const fAtCurLen = eval3DBarHz(baseLen, nominalCut);
      lenM = Math.max(widthM * 2.2, baseLen * Math.sqrt(fAtCurLen / targetHz));
      // One more length pass if Timoshenko shear shifts stubby bars slightly
      const fCheckLo = eval3DBarHz(lenM, maxSafeCut);
      const fCheckHi = eval3DBarHz(lenM, 0);
      if (targetHz > fCheckHi * 0.995 || targetHz < fCheckLo * 1.01) {
        const fMidNom = eval3DBarHz(lenM, nominalCut);
        lenM = Math.max(widthM * 2.2, lenM * Math.sqrt(fMidNom / targetHz));
      }
    }

    // Solve 18-step bisection directly against the 3D cross-section Timoshenko solver (`estimateBodyModes`)!
    let loCut = 0;
    let hiCut = maxSafeCut;
    for (let iter = 0; iter < 18; iter++) {
      const mid = 0.5 * (loCut + hiCut);
      const fMid = eval3DBarHz(lenM, mid);
      // Deeper cut thins the spine and LOWERS f1
      if (fMid > targetHz) {
        loCut = mid;
      } else {
        hiCut = mid;
      }
    }
    const cutDepth = +(0.5 * (loCut + hiCut)).toFixed(6);
    const built = buildArchCandidate(lenM, cutDepth);
    working.geoms = built.geoms;
    working.csgEnabled = built.csgEnabled;
    if (working.csgEnabled && !working.collision) working.collision = 'hull';

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

  // Case 3: General primitive / multi-geom / mesh block -> uniform 3D acoustic dimension scale (f ∝ 1 / L)
  const baseProfile = estimateBodyModes({ ...working, tunedPitchHz: undefined });
  let totalScale = Math.max(0.15, Math.min(6.0, baseProfile.fundamentalHz / targetHz));
  let scaledNode = scaleNodeUniformly(working, totalScale, true);
  scaledNode.sculptVersion = (working.sculptVersion ?? 0) + 1;
  const midProfile = estimateBodyModes(scaledNode);
  if (Math.abs(midProfile.fundamentalHz - targetHz) / targetHz > 0.008 && totalScale > 0.16 && totalScale < 5.9) {
    const trim = Math.max(0.5, Math.min(2.0, midProfile.fundamentalHz / targetHz));
    totalScale = Math.max(0.15, Math.min(6.0, totalScale * trim));
    scaledNode = scaleNodeUniformly(working, totalScale, true);
    scaledNode.sculptVersion = (working.sculptVersion ?? 0) + 2;
  }
  scaledNode.tunedPitchHz = +targetHz.toFixed(2);
  const after = estimateBodyModes(scaledNode);
  const noteInfo = hzToNoteInfo(after.fundamentalHz);
  return {
    node: scaledNode,
    before,
    after,
    method: 'scale',
    summary: `Scaled body ×${totalScale.toFixed(3)} to ${noteInfo.note} (${after.fundamentalHz.toFixed(1)} Hz)`,
  };
}

function measureWorldHorizontalSpans(node: SceneNode): [number, number] {
  const tris: number[] = [];
  for (const g of node.geoms ?? []) {
    if (!g.csgDerived && g.csg !== 'difference') geomHydroTriangles(g, tris);
  }
  if (tris.length < 9) return [0.04, 0.04];

  const rotMat = geomMatrixOf({
    name: '',
    type: 'box',
    size: [1, 1, 1],
    pos: [0, 0, 0],
    quat: node.quat,
    euler: node.euler,
  });
  const e = rotMat.elements;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    const lx = tris[i], ly = tris[i + 1], lz = tris[i + 2];
    const wx = e[0] * lx + e[4] * ly + e[8] * lz;
    const wy = e[1] * lx + e[5] * ly + e[9] * lz;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wy < minY) minY = wy;
    if (wy > maxY) maxY = wy;
  }
  return [
    Number.isFinite(minX) ? Math.max(0.012, maxX - minX) : 0.04,
    Number.isFinite(minY) ? Math.max(0.012, maxY - minY) : 0.04,
  ];
}

/**
 * Generates a side-by-side tuned musical scale (5-note pentatonic or 8-note
 * major octave) cloned from `baseNode` with world-rotated non-overlapping spacing.
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

  const [baseSpanX, baseSpanY] = measureWorldHorizontalSpans(baseNode);
  // Step along whichever world horizontal axis is narrower (bar width rather than bar length!)
  const stepAlongX = baseSpanX <= baseSpanY;
  const baseHalfExtent = 0.5 * (stepAlongX ? baseSpanX : baseSpanY);

  const basePos = [baseNode.pos[0] ?? 0, baseNode.pos[1] ?? 0, baseNode.pos[2] ?? 0];
  let cursor = baseHalfExtent;

  return intervals.map((semi, idx) => {
    const hz = rootHz * Math.pow(2, semi / 12);
    const { note } = hzToNoteInfo(hz);
    const cleanNote = note.replace('#', 's').toLowerCase();
    const cloned: SceneNode = JSON.parse(JSON.stringify(baseNode));
    cloned.id = `${baseNode.id}_${cleanNote}_${idx + 1}`;
    cloned.name = `${baseNode.name || 'Bar'} (${note})`;
    if (Array.isArray(cloned.joints)) {
      cloned.joints = cloned.joints.map((j) => ({
        ...j,
        name: `${j.name || 'joint'}_${cleanNote}_${idx + 1}`,
      }));
    }

    const tunedClone = tuneBodyToPitch(cloned, hz).node;
    const [cloneSpanX, cloneSpanY] = measureWorldHorizontalSpans(tunedClone);
    const cloneWidth = stepAlongX ? cloneSpanX : cloneSpanY;
    const gap = Math.max(0.010, cloneWidth * 0.36);
    const centerOffset = cursor + gap + 0.5 * cloneWidth;
    cursor = centerOffset + 0.5 * cloneWidth;

    tunedClone.pos = [
      +(basePos[0] + (stepAlongX ? centerOffset : 0)).toFixed(5),
      +(basePos[1] + (!stepAlongX ? centerOffset : 0)).toFixed(5),
      basePos[2],
    ];
    return tunedClone;
  });
}
