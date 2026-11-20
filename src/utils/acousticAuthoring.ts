// ---------------------------------------------------------------------------
// Inspector acoustic authoring (pure)
//
// What the Concert Pitch card does to a body when its "sound role" is changed,
// kept out of the component so it can be tested without React: which roles a
// body can take, how each is switched on and off (seeded specs, joints, the
// horsehair contact a bow needs), which solver the pitch readout and Tune
// button must ask, and the Schelleng starting point of a Bow audition.
// ---------------------------------------------------------------------------

import type {
  AcousticBowSpec,
  AcousticMembraneSpec,
  AcousticStringSpec,
  NonlinearPlateSpec,
  ResonatorTubeSpec,
  SceneGeom,
  SceneNode,
  WindExciterKind,
  WindInstrumentSpec,
} from '../types/scene';
import type { WorkletBowedVoicePayload } from './modalAudioWorklet';
import { analyze3DSolidCrossSections } from './solidAcoustics3D';
import { hzToNoteInfo, tuneBodyToPitch, tuneWindInstrumentToPitch } from './acousticTuning';
import {
  ensureTautStringJointAndContact,
  evaluateTautString,
  measureStringLengthM,
  solveBowedStringVoice,
  STRING_MATERIALS,
  tuneStringToPitch,
  type BowedStringVoice,
} from './stringAcoustics';
import { extractBoreWaveguide, solvePlayableWindVoice, type BoreWaveguideModel } from './windAcoustics';
import { evaluateTensionedMembrane, isMembraneCandidate, tuneMembraneToPitch } from './membraneAcoustics';
import { extractTubeAirColumn } from './resonatorAcoustics';
import { isNonlinearPlateCandidate } from './nonlinearPlateAcoustics';

/** What a body's sound comes from. Exactly one role is active at a time. */
export type AcousticRole = 'solid' | 'string' | 'wind' | 'bow' | 'membrane';

export const ACOUSTIC_ROLE_LABELS: Record<AcousticRole, string> = {
  solid: 'Struck solid (modes)',
  string: 'Taut string (Mersenne)',
  wind: 'Wind bore (reed / lip / jet / flap)',
  bow: 'Acoustic bow (rosined hair)',
  membrane: 'Tensioned membrane (drum head)',
};

export const WIND_EXCITER_LABELS: Record<WindExciterKind, string> = {
  reed: 'Single reed (clarinet / sax)',
  brass_lip: 'Brass lip-reed',
  flute_jet: 'Air jet (flute / ocarina)',
  flap_valve: 'Compliant flap-valve (bladder / spout)',
};

/** A solid geom a role could be built on: not a cutter, not generated, not decoration. */
function primarySolid(node: SceneNode): SceneGeom | undefined {
  return (node.geoms ?? []).find((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && g.type !== 'plane');
}

/** Tip to tip, metres, of a capsule/cylinder geom; 0 for anything else. */
function slenderLengthAndRadius(g: SceneGeom | undefined): { len: number; r: number } {
  if (!g || (g.type !== 'capsule' && g.type !== 'cylinder')) return { len: 0, r: 0 };
  const r = g.size?.[0] ?? 0.01;
  const len = g.fromto && g.fromto.length >= 6
    ? Math.hypot(g.fromto[3] - g.fromto[0], g.fromto[4] - g.fromto[1], g.fromto[5] - g.fromto[2])
    : 2 * (g.size?.[1] ?? 0.05);
  return { len, r };
}

/** The role a body plays now. */
export function roleOf(node: SceneNode): AcousticRole {
  if (node.acousticString) return 'string';
  if (node.windInstrument) return 'wind';
  if (node.acousticMembrane) return 'membrane';
  if (node.acousticBow) return 'bow';
  return 'solid';
}

/** Whether a long thin wire (capsule/cylinder ≥ 14 radii long) could be a taut string. */
export function isSlenderWireCandidate(node: SceneNode): boolean {
  if (node.acousticString) return true;
  const g = (node.geoms ?? []).find((x) => !x.csgDerived && x.csg !== 'difference');
  const { len, r } = slenderLengthAndRadius(g);
  return r > 0 && len / (2 * r) >= 14;
}

/** Whether a body has a bore a player could blow through: a tube, a hollow, or a long cylinder. */
export function canToggleWindBore(node: SceneNode): boolean {
  if (node.windInstrument) return true;
  if (node.acousticString || node.acousticMembrane || node.acousticBow || node.hardwarePart || node.simulation) return false;
  const g = primarySolid(node);
  if (!g) return false;
  const sec = analyze3DSolidCrossSections(node);
  const [, bMid, lMax] = sec.dimsSortedAsc;
  if (lMax < 0.035) return false;
  const hollow = !!node.isTube
    || (node.geoms ?? []).some((x) => x.csg === 'difference')
    || sec.hollowFraction > 0.25
    || g.type === 'mesh';
  return hollow && lMax / Math.max(1e-4, bMid) >= 1.25;
}

/** Whether a long thin solid (box / capsule / cylinder ≥ 5x as long as thick) could be a bow. */
export function canToggleAcousticBow(node: SceneNode): boolean {
  if (node.acousticBow) return true;
  if (node.acousticString || node.windInstrument || node.acousticMembrane || node.hardwarePart || node.simulation) return false;
  const g = primarySolid(node);
  if (!g) return false;
  if (g.type === 'capsule' || g.type === 'cylinder') {
    const { len, r } = slenderLengthAndRadius(g);
    return r > 0 && len / (2 * r) >= 5;
  }
  if (g.type === 'box') {
    const dims = [2 * (g.size[0] ?? 0), 2 * (g.size[1] ?? 0), 2 * (g.size[2] ?? 0)].sort((a, b) => a - b);
    return dims[0] > 0 && dims[2] / dims[0] >= 5;
  }
  return false;
}

/** Whether a thin sheet or a drum-head-like disc could be a tensioned membrane. */
export function canToggleMembrane(node: SceneNode): boolean {
  if (node.acousticMembrane) return true;
  if (node.acousticString || node.windInstrument || node.acousticBow) return false;
  try {
    return isMembraneCandidate(node);
  } catch {
    return false;
  }
}

/** Roles this body may be switched to, always including the one it has. */
export function availableRoles(node: SceneNode): AcousticRole[] {
  const out: AcousticRole[] = ['solid'];
  if (isSlenderWireCandidate(node)) out.push('string');
  if (canToggleWindBore(node)) out.push('wind');
  if (canToggleAcousticBow(node)) out.push('bow');
  if (canToggleMembrane(node)) out.push('membrane');
  const current = roleOf(node);
  if (!out.includes(current)) out.push(current);
  return out;
}

/** Whether a hollow tube could be a tuned external resonator (or already is). */
export function canToggleResonatorTube(node: SceneNode): boolean {
  if (node.resonatorTube) return true;
  if (node.acousticString || node.windInstrument || node.acousticMembrane || node.acousticBow) return false;
  try {
    return !!extractTubeAirColumn(node);
  } catch {
    return false;
  }
}

/** Whether a thin hard plate/cymbal/gong could crash (von Kármán) — or the user has said it does. */
export function canToggleNonlinearPlate(node: SceneNode): boolean {
  if (node.nonlinearPlate) return true;
  if (node.acousticString || node.windInstrument || node.acousticMembrane || node.acousticBow) return false;
  try {
    return isNonlinearPlateCandidate(node);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tolerant specs: what a card may read when a spec arrived half-written
// ---------------------------------------------------------------------------

const finiteOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A wind spec with every number the card prints guaranteed finite. */
export function safeWindSpec(spec: WindInstrumentSpec): WindInstrumentSpec {
  const flap = spec.exciter === 'flap_valve';
  return {
    ...spec,
    exciter: spec.exciter ?? 'reed',
    breathKPa: Math.max(0, finiteOr(spec.breathKPa, 0)),
    embouchureHz: Math.max(16, finiteOr(spec.embouchureHz, flap ? 55 : 260)),
  };
}

/** A string spec with a known material and finite gauge, tension and pluck point. */
export function safeStringSpec(spec: AcousticStringSpec): AcousticStringSpec {
  const material = spec.material && STRING_MATERIALS[spec.material] ? spec.material : 'bronze';
  return {
    ...spec,
    material,
    diameterMm: Math.max(0.05, finiteOr(spec.diameterMm, 0.65)),
    tensionN: Math.max(0.5, finiteOr(spec.tensionN, 50)),
    ...(spec.pluckPos !== undefined ? { pluckPos: Math.max(0.03, Math.min(0.5, finiteOr(spec.pluckPos, 0.2))) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Switching roles
// ---------------------------------------------------------------------------

/** Takes a node out of every sound role (and drops the pitch the old role had stamped). */
export function clearAcousticRole(node: SceneNode): SceneNode {
  const next: SceneNode = { ...node };
  const hadString = !!next.acousticString;
  delete next.acousticString;
  delete next.windInstrument;
  delete next.acousticMembrane;
  delete next.acousticBow;
  delete next.tunedPitchHz;
  // A pluck joint the string role synthesized is of no use to the next role.
  if (hadString) {
    next.joints = (next.joints ?? []).filter((j) => !(j.type === 'slide' && /_pluck$/.test(j.name)));
  }
  return next;
}

/** Gives a bow the damped horsehair contact it needs, leaving anything already set. */
export function stampHorsehairContact(node: SceneNode, spec: AcousticBowSpec): SceneNode {
  const target = primarySolid(node);
  if (!target) return node;
  const mu = Math.max(0.2, Math.min(0.65, finiteOr(spec.rosinFriction, 0.38)));
  return {
    ...node,
    geoms: (node.geoms ?? []).map((g) =>
      g === target
        ? {
            ...g,
            condim: g.condim ?? 3,
            friction: [mu, g.friction?.[1] ?? 0.004, g.friction?.[2] ?? 0.0004],
            solref: g.solref ?? [0.005, 1.25],
          }
        : g,
    ),
  };
}

/** Keeps the bow's contact friction in step with its authored `rosinFriction`. */
export function withBowSpec(node: SceneNode, spec: AcousticBowSpec): SceneNode {
  const target = primarySolid(node);
  const next: SceneNode = { ...node, acousticBow: spec };
  if (!target) return next;
  const mu = Math.max(0.2, Math.min(0.65, finiteOr(spec.rosinFriction, 0.38)));
  next.geoms = (node.geoms ?? []).map((g) =>
    g === target ? { ...g, friction: [mu, g.friction?.[1] ?? 0.004, g.friction?.[2] ?? 0.0004] } : g,
  );
  return next;
}

/** Whether a spout/bladder-like body should default to a flap-valve rather than a reed. */
function prefersFlapValve(node: SceneNode): boolean {
  const soft = node.deformMaterial === 'plastic' || node.deformMaterial === 'rubber';
  const sec = analyze3DSolidCrossSections(node);
  return soft && sec.dimsSortedAsc[2] < 0.16;
}

/**
 * Switches `node` into `role`. Returns a new node; the caller writes it into
 * the scene (updateScene / updateNode) so the model recompiles once.
 */
export function applyAcousticRole(
  node: SceneNode,
  role: AcousticRole,
  opts: { sceneNodes?: SceneNode[]; targetHz?: number } = {},
): SceneNode {
  const cleared = clearAcousticRole(node);
  const targetHz = opts.targetHz ?? 261.63;
  switch (role) {
    case 'solid':
      return cleared;
    case 'string': {
      const seeded: SceneNode = {
        ...cleared,
        acousticString: { material: 'bronze', diameterMm: 0.65, tensionN: 50, pluckPos: 0.2 },
      };
      return tuneStringToPitch(ensureTautStringJointAndContact(seeded), targetHz, opts.sceneNodes);
    }
    case 'wind': {
      const flap = prefersFlapValve(cleared);
      const spec: WindInstrumentSpec = flap
        ? { exciter: 'flap_valve', breathKPa: 0, embouchureHz: 55 }
        : { exciter: 'reed', breathKPa: 0, embouchureHz: 260 };
      return { ...cleared, windInstrument: spec };
    }
    case 'bow': {
      const spec: AcousticBowSpec = { rosinFriction: 0.38, hairWidthMm: 9, rosinGrip: 1, forceScale: 1 };
      return stampHorsehairContact({ ...cleared, acousticBow: spec }, spec);
    }
    case 'membrane': {
      // tuneMembraneToPitch seeds a mylar head when the node has no spec yet.
      return tuneMembraneToPitch(cleared, targetHz, opts.sceneNodes);
    }
  }
}

/** Switches a tube resonator on (seeded from the air column it finds) or off. */
export function toggleResonatorTube(node: SceneNode, on: boolean): SceneNode {
  const next: SceneNode = { ...node };
  if (!on) {
    delete next.resonatorTube;
    return next;
  }
  const col = extractTubeAirColumn(node);
  const spec: ResonatorTubeSpec = { endCondition: col?.endCondition ?? 'open_closed' };
  next.resonatorTube = { ...(node.resonatorTube ?? {}), ...spec };
  return next;
}

/** Switches the von Kármán crash on or off for a plate. */
export function toggleNonlinearPlate(node: SceneNode, on: boolean): SceneNode {
  const next: SceneNode = { ...node };
  if (on) {
    next.nonlinearPlate = { ...(node.nonlinearPlate ?? {}), enabled: true, crashSensitivity: node.nonlinearPlate?.crashSensitivity ?? 1 };
    return next;
  }
  // A plate that would crash on its own is told not to; anything else just loses the spec.
  if (isNonlinearPlateCandidate({ ...node, nonlinearPlate: undefined })) {
    next.nonlinearPlate = { ...(node.nonlinearPlate ?? {}), enabled: false } as NonlinearPlateSpec;
  } else {
    delete next.nonlinearPlate;
  }
  return next;
}

// ---------------------------------------------------------------------------
// The pitch the card reads out, and what Tune does, by role
// ---------------------------------------------------------------------------

export interface RolePitchReadout {
  fundamentalHz: number;
  overtoneRatio: number;
  note: ReturnType<typeof hzToNoteInfo>;
}

/** The pitch a wind body actually plays (bore + embouchure), not its solid wall's flexural tap. */
export function windPitchReadout(spec: WindInstrumentSpec, bore: BoreWaveguideModel): { pitchHz: number; overtoneRatio: number } {
  const safe = safeWindSpec(spec);
  const voice = solvePlayableWindVoice(bore, Math.max(3, safe.breathKPa || 3.2), safe.embouchureHz);
  const modes = bore.resonantModesHz;
  const ratio = modes.length > 1 && modes[0] > 0 ? modes[1] / modes[0] : 2;
  return { pitchHz: voice.pitchHz, overtoneRatio: ratio };
}

/** Tunes a body to `hz` with the solver its role asks for; the result is the node to write back. */
export function tuneNodeForRole(
  node: SceneNode,
  hz: number,
  opts: { sceneNodes?: SceneNode[]; drillNodalHole?: boolean } = {},
): { node: SceneNode; summary?: string } {
  if (node.acousticString) {
    return { node: tuneStringToPitch(node, hz, opts.sceneNodes) };
  }
  if (node.windInstrument) {
    return { node: tuneWindInstrumentToPitch(node, hz) };
  }
  const res = tuneBodyToPitch(node, hz, { drillNodalHole: opts.drillNodalHole, sceneNodes: opts.sceneNodes });
  return { node: res.node, summary: res.summary };
}

/** A membrane's evaluation, or null when its spec is unreadable. */
export function membraneReadout(node: SceneNode, sceneNodes?: SceneNode[]) {
  try {
    return node.acousticMembrane ? evaluateTensionedMembrane(node, sceneNodes) : null;
  } catch {
    return null;
  }
}

export type MembraneSpecPatch = Partial<AcousticMembraneSpec>;

// ---------------------------------------------------------------------------
// Bow audition (Starter #6b)
// ---------------------------------------------------------------------------

export interface BowPreviewSettings {
  /** x_bow / L from the nearest termination. */
  beta: number;
  /** Sliding speed of the hair across the string, m/s. */
  velocityMps: number;
  /** Normal force pressing the hair on, N. */
  forceN: number;
}

export const BOW_BETA_RANGE = { min: 0.04, max: 0.3, step: 0.005 } as const;
export const BOW_SPEED_RANGE = { min: 0.04, max: 0.6, step: 0.01 } as const;
export const BOW_FORCE_RANGE = { min: 0.02, max: 3.5, step: 0.02 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where a Bow audition starts: ordinario bow position, 0.22 m/s, and the force
 * at the middle (geometric mean) of the Schelleng wedge, so the first note
 * lands squarely in Helmholtz lock instead of scratching or skating.
 */
export function defaultBowPreview(node: SceneNode, sceneNodes?: SceneNode[]): BowPreviewSettings {
  const beta = clamp(finiteOr(node.acousticString?.pluckPos, 0.11), BOW_BETA_RANGE.min, BOW_BETA_RANGE.max);
  const velocityMps = 0.22;
  return { beta, velocityMps, forceN: centredBowForce(node, sceneNodes, beta, velocityMps) };
}

/** The force at the geometric centre of the Schelleng wedge for this beta and speed. */
export function centredBowForce(node: SceneNode, sceneNodes: SceneNode[] | undefined, beta: number, velocityMps: number): number {
  const probe = solveBowedStringVoice({ node, sceneNodes, bowVelocityMps: velocityMps, bowForceN: 1, bowBeta: beta });
  const lo = Math.max(1e-6, probe.fMin);
  const hi = Math.max(lo, probe.fMax);
  return +clamp(Math.sqrt(lo * hi), BOW_FORCE_RANGE.min, BOW_FORCE_RANGE.max).toFixed(2);
}

export type BowRegimeKind = BowedStringVoice['regime'];

export const BOW_REGIME_LABELS: Record<BowRegimeKind, string> = {
  silent: 'Below threshold',
  flautando: 'Flautando skate',
  helmholtz: 'Helmholtz lock',
  raucous: 'Raucous crunch',
};

/** sul ponticello / ordinario / sul tasto, by bow position. */
export function bowPositionLabel(beta: number): string {
  if (beta < 0.08) return 'sul ponticello';
  if (beta > 0.18) return 'sul tasto';
  return 'ordinario';
}

/** The worklet voice a Bow audition streams. */
export function toBowedPayload(id: string, voice: BowedStringVoice): WorkletBowedVoicePayload {
  return {
    id,
    active: voice.active,
    pitchHz: voice.pitchHz,
    amplitude: voice.amplitude,
    harmonicWeights: voice.harmonicWeights,
    stringHarmonicWeights: voice.stringHarmonicWeights,
    bodyIr: voice.bodyIr,
    bodyIrSig: voice.bodyIrSig,
    bodyFormantHz: voice.bodyFormantHz,
    bodyFormantGainDb: voice.bodyFormantGainDb,
    bodyFormantQ: voice.bodyFormantQ,
    secondaryFormantHz: voice.secondaryFormantHz,
    woodModeHz: voice.woodModeHz,
    dipoleCancelHz: voice.dipoleCancelHz,
    dipoleCancelDb: voice.dipoleCancelDb,
    bridgeHillHz: voice.bridgeHillHz,
    bridgeHillGainDb: voice.bridgeHillGainDb,
    lowpassHz: voice.lowpassHz,
    rosinNoiseGain: voice.rosinNoiseGain,
    rosinCenterHz: voice.rosinCenterHz,
  };
}

/** The string evaluation's readout, or null when the string is unreadable. */
export function stringReadout(node: SceneNode, sceneNodes: SceneNode[]) {
  try {
    return node.acousticString ? evaluateTautString(node, sceneNodes) : null;
  } catch {
    return null;
  }
}

/** The string's speaking length, metres, for stiffness updates when tension changes. */
export function stringLengthM(node: SceneNode): number {
  return Math.max(0.02, measureStringLengthM(node));
}

/** Wind bore, or null when it cannot be read. */
export function windBoreOf(node: SceneNode): BoreWaveguideModel | null {
  try {
    return node.windInstrument ? extractBoreWaveguide(node) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audition hold: tells the engine not to overwrite an Inspector audition
// ---------------------------------------------------------------------------

type AuditionGlobal = { __physboxAcousticAuditionUntilMs?: number };

/** Asks the live engine to leave the streamed audition voices alone for `ms` more milliseconds. */
export function holdAcousticAudition(ms: number): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  (globalThis as AuditionGlobal).__physboxAcousticAuditionUntilMs = now + Math.max(0, ms);
}

/** Releases the hold at once (an audition ended early). */
export function releaseAcousticAudition(): void {
  (globalThis as AuditionGlobal).__physboxAcousticAuditionUntilMs = 0;
}
