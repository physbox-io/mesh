import { describe, expect, it, afterEach } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { soundboxLyrePreset } from '../src/presets/soundboxLyre';
import { bowedCelloPreset } from '../src/presets/bowedCello';
import { windInstrumentsPreset } from '../src/presets/windInstruments';
import {
  applyAcousticRole,
  availableRoles,
  bowPositionLabel,
  canToggleAcousticBow,
  canToggleWindBore,
  centredBowForce,
  clearAcousticRole,
  defaultBowPreview,
  holdAcousticAudition,
  releaseAcousticAudition,
  roleOf,
  safeStringSpec,
  safeWindSpec,
  stringReadout,
  toBowedPayload,
  toggleNonlinearPlate,
  toggleResonatorTube,
  tuneNodeForRole,
  windBoreOf,
  windPitchReadout,
} from '../src/utils/acousticAuthoring';
import { solveBowedStringVoice } from '../src/utils/stringAcoustics';
import { hzToNoteInfo, noteToHz } from '../src/utils/acousticTuning';

const userCapsule = (over: Partial<SceneNode> = {}): SceneNode => ({
  id: 'wire',
  name: 'Wire',
  pos: [0, 0, 0.1],
  geoms: [{ name: 'wire_geom', type: 'capsule', fromto: [0, -0.3, 0, 0, 0.3, 0], size: [0.002] }],
  joints: [{ name: 'wire_free', type: 'free' }],
  children: [],
  ...over,
});

const userPipe = (over: Partial<SceneNode> = {}): SceneNode => ({
  id: 'pipe',
  name: 'Pipe',
  pos: [0, 0, 0.1],
  isTube: true,
  deformMaterial: 'hardwood',
  csgEnabled: true,
  geoms: [
    { name: 'outer', type: 'cylinder', size: [0.02, 0.2], euler: [0, 90, 0] },
    { name: 'bore', type: 'cylinder', size: [0.015, 0.21], euler: [0, 90, 0], csg: 'difference' },
  ],
  joints: [],
  children: [],
  ...over,
});

const userSpout = (): SceneNode => ({
  id: 'spout',
  name: 'Spout',
  pos: [0, 0, 0.1],
  isTube: true,
  deformMaterial: 'plastic',
  csgEnabled: true,
  geoms: [
    { name: 'neck', type: 'cylinder', size: [0.025, 0.055] },
    { name: 'bore', type: 'cylinder', size: [0.017, 0.068], csg: 'difference' },
  ],
  joints: [],
  children: [],
});

const userStick = (): SceneNode => ({
  id: 'bow',
  name: 'Bow',
  pos: [0, 0, 0.2],
  geoms: [{ name: 'stick', type: 'box', size: [0.3, 0.006, 0.004] }],
  joints: [{ name: 'bow_stroke', type: 'slide', axis: [1, 0, 0] }],
  children: [],
});

afterEach(() => releaseAcousticAudition());

describe('acoustic authoring: roles', () => {
  it('offers a slender wire the string role and a wire only the roles its geometry allows', () => {
    const wire = userCapsule();
    expect(roleOf(wire)).toBe('solid');
    const roles = availableRoles(wire);
    expect(roles).toContain('solid');
    expect(roles).toContain('string');
    expect(roles).not.toContain('membrane');
  });

  it('switching a free user capsule to a taut string gives it a limited transverse pluck slide, not a free joint', () => {
    const wire = userCapsule();
    const next = applyAcousticRole(wire, 'string', { sceneNodes: [wire], targetHz: noteToHz('A3') ?? 220 });
    expect(next.acousticString).toBeDefined();
    expect(next.joints.some((j) => j.type === 'free')).toBe(false);
    const slide = next.joints.find((j) => j.type === 'slide');
    expect(slide).toBeDefined();
    expect(slide!.limited).toBe(true);
    // The wire axis is Y, so the pluck axis must be square to it.
    const axis = slide!.axis ?? [0, 0, 0];
    expect(Math.abs(axis[1])).toBeLessThan(1e-6);
    const ev = stringReadout(next, [next]);
    expect(ev).not.toBeNull();
    expect(Math.abs(hzToNoteInfo(ev!.fundamentalHz).cents)).toBeLessThan(40);
  });

  it('switching a string off drops its pitch stamp and the pluck joint the string role made', () => {
    const wire = userCapsule();
    const on = applyAcousticRole(wire, 'string', { sceneNodes: [wire] });
    expect(on.tunedPitchHz).toBeDefined();
    const off = clearAcousticRole(on);
    expect(off.acousticString).toBeUndefined();
    expect(off.tunedPitchHz).toBeUndefined();
    expect(off.joints.some((j) => /_pluck$/.test(j.name))).toBe(false);
  });

  it('seeds a reed on a hollow pipe and a flap-valve on a short soft spout', () => {
    const pipe = userPipe();
    expect(canToggleWindBore(pipe)).toBe(true);
    expect(availableRoles(pipe)).toContain('wind');
    const reed = applyAcousticRole(pipe, 'wind');
    expect(reed.windInstrument?.exciter).toBe('reed');
    expect(reed.windInstrument?.breathKPa).toBe(0);

    const flap = applyAcousticRole(userSpout(), 'wind');
    expect(flap.windInstrument?.exciter).toBe('flap_valve');
    expect(flap.windInstrument!.embouchureHz).toBeGreaterThanOrEqual(24);
    expect(flap.windInstrument!.embouchureHz).toBeLessThanOrEqual(320);
  });

  it('a solid block is not offered a wind bore or a bow', () => {
    const block: SceneNode = {
      id: 'block', name: 'Block', pos: [0, 0, 0.05],
      geoms: [{ name: 'b', type: 'box', size: [0.05, 0.05, 0.05] }], joints: [], children: [],
    };
    expect(canToggleWindBore(block)).toBe(false);
    expect(canToggleAcousticBow(block)).toBe(false);
  });

  it('stamps damped horsehair contact on the first solid geom of a new bow, leaving other settings', () => {
    const stick = userStick();
    expect(canToggleAcousticBow(stick)).toBe(true);
    const bow = applyAcousticRole(stick, 'bow');
    expect(bow.acousticBow).toMatchObject({ rosinFriction: 0.38, hairWidthMm: 9, rosinGrip: 1 });
    const g = bow.geoms[0];
    expect(g.condim).toBe(3);
    expect(g.friction?.[0]).toBeCloseTo(0.38, 5);
    expect(g.solref).toEqual([0.005, 1.25]);

    // A geom that already says how it touches keeps its own contact softness.
    const own: SceneNode = { ...stick, geoms: [{ ...stick.geoms[0], solref: [0.02, 1], condim: 1 }] };
    const stamped = applyAcousticRole(own, 'bow');
    expect(stamped.geoms[0].solref).toEqual([0.02, 1]);
    expect(stamped.geoms[0].condim).toBe(1);
  });

  it('toggles a tube resonator and a crash plate on and off', () => {
    const pipe = userPipe();
    const on = toggleResonatorTube(pipe, true);
    expect(on.resonatorTube?.endCondition).toBeDefined();
    expect(toggleResonatorTube(on, false).resonatorTube).toBeUndefined();

    const plate: SceneNode = {
      id: 'plate', name: 'Plate', pos: [0, 0, 0.1], deformMaterial: 'softMetal',
      geoms: [{ name: 'p', type: 'cylinder', size: [0.2, 0.0008] }], joints: [], children: [],
    };
    const crash = toggleNonlinearPlate(plate, true);
    expect(crash.nonlinearPlate?.enabled).toBe(true);
    const off = toggleNonlinearPlate(crash, false);
    expect(off.nonlinearPlate === undefined || off.nonlinearPlate.enabled === false).toBe(true);
  });
});

describe('acoustic authoring: tolerant specs and wind pitch', () => {
  it('fills a half-written wind spec so the card can print it', () => {
    const spec = safeWindSpec({ exciter: 'reed' } as never);
    expect(Number.isFinite(spec.embouchureHz)).toBe(true);
    expect(Number.isFinite(spec.breathKPa)).toBe(true);
    const flap = safeWindSpec({ exciter: 'flap_valve' } as never);
    expect(flap.embouchureHz).toBe(55);
  });

  it('falls back to bronze for an unknown wire material and a finite gauge and tension', () => {
    const spec = safeStringSpec({ material: 'unobtainium', diameterMm: Number.NaN } as never);
    expect(spec.material).toBe('bronze');
    expect(spec.diameterMm).toBeGreaterThan(0);
    expect(spec.tensionN).toBeGreaterThan(0);
  });

  it('reads a clarinet pitch from its bore, in the chalumeau register, not from the wall tap', () => {
    const clarinet = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
    const bore = windBoreOf(clarinet)!;
    expect(bore).not.toBeNull();
    const w = windPitchReadout(clarinet.windInstrument!, bore);
    expect(w.pitchHz).toBeGreaterThan(120);
    expect(w.pitchHz).toBeLessThan(330);
  });

  it('tunes a flap-valve through its frequency, and a bore by length, never by the pipe wall', () => {
    const spout = applyAcousticRole(userSpout(), 'wind');
    const tunedFlap = tuneNodeForRole(spout, 90).node;
    expect(tunedFlap.windInstrument?.embouchureHz).toBeCloseTo(90, 0);
    // No cord hole is drilled into a bore.
    expect(tunedFlap.geoms.some((g) => g.name === 'nodal_hole')).toBe(false);

    const clarinet = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
    const tuned = tuneNodeForRole(clarinet, 247, { drillNodalHole: true }).node;
    expect(tuned.geoms.some((g) => g.name === 'nodal_hole')).toBe(false);
    expect(tuned.windInstrument).toBeDefined();
  });
});

describe('acoustic authoring: Bow audition (Starter #6b)', () => {
  const cello = bowedCelloPreset.nodes[0];
  const lyre = soundboxLyrePreset.nodes[0];

  it('starts a Bow audition in the middle of the Schelleng wedge, in Helmholtz lock', () => {
    const str = cello.children.find((c) => c.acousticString)!;
    const d = defaultBowPreview(str, bowedCelloPreset.nodes);
    expect(d.beta).toBeGreaterThanOrEqual(0.04);
    expect(d.beta).toBeLessThanOrEqual(0.3);
    expect(d.forceN).toBeGreaterThanOrEqual(0.02);
    const voice = solveBowedStringVoice({
      node: str, sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: d.velocityMps, bowForceN: d.forceN, bowBeta: d.beta,
    });
    expect(voice.regime).toBe('helmholtz');
    expect(voice.fMin).toBeLessThan(d.forceN + 1e-6);
    expect(voice.fMax).toBeGreaterThan(d.forceN - 1e-6);
  });

  it('re-centres the force when the bow moves toward the bridge', () => {
    const str = lyre.children.find((c) => c.acousticString)!;
    const far = centredBowForce(str, soundboxLyrePreset.nodes, 0.2, 0.22);
    const near = centredBowForce(str, soundboxLyrePreset.nodes, 0.06, 0.22);
    // Schelleng: both limits grow as the bow nears the bridge.
    expect(near).toBeGreaterThan(far);
  });

  it('labels bow positions and streams a finite worklet payload', () => {
    expect(bowPositionLabel(0.05)).toBe('sul ponticello');
    expect(bowPositionLabel(0.12)).toBe('ordinario');
    expect(bowPositionLabel(0.25)).toBe('sul tasto');
    const str = cello.children.find((c) => c.acousticString)!;
    const voice = solveBowedStringVoice({
      node: str, sceneNodes: bowedCelloPreset.nodes, bowVelocityMps: 0.22, bowForceN: 0.7, bowBeta: 0.11,
    });
    const payload = toBowedPayload(str.id, voice);
    expect(payload.id).toBe(str.id);
    expect(payload.active).toBe(voice.active);
    expect(Number.isFinite(payload.pitchHz)).toBe(true);
    expect(payload.harmonicWeights.every(Number.isFinite)).toBe(true);
  });

  it('holds and releases the audition so the live engine leaves it alone', () => {
    const g = globalThis as { __physboxAcousticAuditionUntilMs?: number };
    holdAcousticAudition(1000);
    expect(g.__physboxAcousticAuditionUntilMs!).toBeGreaterThan(performance.now());
    releaseAcousticAudition();
    expect(g.__physboxAcousticAuditionUntilMs).toBe(0);
  });
});
