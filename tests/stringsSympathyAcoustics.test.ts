import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { bowedCelloPreset } from '../src/presets/bowedCello';
import { soundboxLyrePreset } from '../src/presets/soundboxLyre';
import { hzToNoteInfo, noteToHz } from '../src/utils/acousticTuning';
import {
  buildMountedStringsForBody,
  computePluckPitchDroop,
  ensureTautStringJointAndContact,
  evaluateTautString,
  measureStringLengthM,
  resolveStringBetaFromPoint,
  solveBowedStringVoice,
  solveSympatheticStringCoupling,
  STRING_MATERIALS,
  tuneStringToPitch,
} from '../src/utils/stringAcoustics';
import {
  applyAudioDampingEvents,
  chokeBodyVoice,
  evaluateModeAmplitudeAt,
  getModalVoicePoolStats,
  MAX_ACTIVE_CONVOLVERS,
  MAX_ACTIVE_IMPACTS,
  MAX_ACTIVE_OSCILLATORS,
  sanitizeAndResampleIrSamples,
  silenceModalVoices,
  sweepExpiredVoiceGroups,
  triggerOrMutateModalVoice,
  triggerSympatheticStringPluck,
  updateSympatheticBowedVoices,
  updateVoiceSpatialPan,
  updateVoiceTremolo,
} from '../src/utils/voiceSympathyPool';

// ---------------------------------------------------------------------------
// Deterministic Mock WebAudio Harness for Pool / Envelope / Choking Assertions
// ---------------------------------------------------------------------------

interface RecordedParamOp {
  op: 'setValue' | 'linearRamp' | 'expRamp' | 'setTarget' | 'cancel';
  value?: number;
  time: number;
  tau?: number;
}

class MockAudioParam {
  value: number;
  ops: RecordedParamOp[] = [];

  constructor(initial = 0) {
    this.value = initial;
  }
  setValueAtTime(v: number, t: number) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) {
      throw new TypeError(`Non-finite AudioParam setValueAtTime(${v}, ${t})`);
    }
    this.value = v;
    this.ops.push({ op: 'setValue', value: v, time: t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    if (!Number.isFinite(v) || !Number.isFinite(t)) {
      throw new TypeError(`Non-finite AudioParam linearRamp(${v}, ${t})`);
    }
    this.value = v;
    this.ops.push({ op: 'linearRamp', value: v, time: t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    if (!(v > 0) || !Number.isFinite(v) || !Number.isFinite(t)) {
      throw new RangeError(`Invalid exponentialRamp target ${v} at ${t}`);
    }
    const prev = [...this.ops].reverse().find((o) => o.value !== undefined);
    if (prev && !(prev.value! > 0)) {
      throw new RangeError(`exponentialRamp preceded by non-positive value ${prev.value}`);
    }
    this.value = v;
    this.ops.push({ op: 'expRamp', value: v, time: t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    if (!Number.isFinite(v) || !Number.isFinite(t) || !(tau > 0)) {
      throw new RangeError(`Invalid setTargetAtTime(${v}, ${t}, ${tau})`);
    }
    this.value = v;
    this.ops.push({ op: 'setTarget', value: v, time: t, tau });
    return this;
  }
  cancelScheduledValues(t: number) {
    this.ops.push({ op: 'cancel', time: t });
    return this;
  }
}

class MockAudioNode {
  connections = new Set<unknown>();
  disconnectCalls = 0;

  connect(dest: unknown) {
    this.connections.add(dest);
    return dest;
  }
  disconnect(dest?: unknown) {
    this.disconnectCalls++;
    if (dest !== undefined) this.connections.delete(dest);
    else this.connections.clear();
  }
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam(1);
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam(350);
  Q = new MockAudioParam(1);
  gain = new MockAudioParam(0);
}

class MockStereoPannerNode extends MockAudioNode {
  pan = new MockAudioParam(0);
}

class MockConvolverNode extends MockAudioNode {
  normalize = true;
  buffer: unknown = null;
}

class MockOscillatorNode extends MockAudioNode {
  type = 'sine';
  frequency = new MockAudioParam(440);
  detune = new MockAudioParam(0);
  startedAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;

  start(t = 0) {
    this.startedAt = t;
  }
  stop() {
    this.stopped = true;
    this.onended?.();
  }
}

class MockBufferSourceNode extends MockAudioNode {
  buffer: unknown = null;
  loop = false;
  startedAt: number | null = null;
  stopAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;

  start(t = 0) {
    this.startedAt = t;
  }
  stop(t?: number) {
    this.stopAt = t ?? 0;
    this.stopped = true;
    this.onended?.();
  }
}

function createMockAudioContext(sampleRate = 48000, initialState: AudioContextState = 'running') {
  let currentTime = 1.0;
  let oscCreated = 0;
  let convCreated = 0;
  let bufCreated = 0;
  const oscillators: MockOscillatorNode[] = [];
  const convolvers: MockConvolverNode[] = [];
  const bufferSources: MockBufferSourceNode[] = [];
  const destination = new MockAudioNode();

  const ctx = {
    sampleRate,
    state: initialState,
    get currentTime() {
      return currentTime;
    },
    set currentTime(t: number) {
      currentTime = t;
    },
    destination,
    createGain: () => new MockGainNode(),
    createBiquadFilter: () => new MockBiquadFilterNode(),
    createStereoPanner: () => new MockStereoPannerNode(),
    createConvolver: () => {
      convCreated++;
      const c = new MockConvolverNode();
      convolvers.push(c);
      return c;
    },
    createOscillator: () => {
      oscCreated++;
      const o = new MockOscillatorNode();
      oscillators.push(o);
      return o;
    },
    createBufferSource: () => {
      const s = new MockBufferSourceNode();
      bufferSources.push(s);
      return s;
    },
    createBuffer: (_channels: number, length: number, sr: number) => {
      bufCreated++;
      const ch = new Float32Array(length);
      return {
        length,
        sampleRate: sr,
        numberOfChannels: 1,
        duration: length / sr,
        getChannelData: () => ch,
      };
    },
  };

  return {
    ctx: ctx as unknown as AudioContext & { currentTime: number; state: AudioContextState },
    bus: destination as unknown as AudioNode,
    get stats() {
      return { oscCreated, convCreated, bufCreated };
    },
    oscillators,
    convolvers,
    bufferSources,
  };
}

// ---------------------------------------------------------------------------
// Slice 3 Tests
// ---------------------------------------------------------------------------

describe('Slice 3 — String Acoustics, Bridge Coupling, Pitch Droop & Voice Sympathy Pool', () => {
  it('computes exact Fletcher (1964) stiff-string dispersion B = π³ E r⁴ / (4 T L²), consistent f1, and nodal-safe overtoneRatio', () => {
    const L = 0.30;
    const dMm = 1.20;
    const r = dMm / 2000;
    const T = 65;
    const E = STRING_MATERIALS.steel.modulusGPa * 1e9;
    const rho = STRING_MATERIALS.steel.densityKgM3;

    const wire: SceneNode = {
      id: 'stiff_wire',
      name: 'Stiff Steel Wire',
      pos: [0, 0, 0.05],
      geoms: [{ name: 'w', type: 'capsule', fromto: [0, -L / 2, 0, 0, L / 2, 0], size: [r] }],
      joints: [{ name: 'w_pluck', type: 'slide', axis: [1, 0, 0] }],
      acousticString: {
        material: 'steel',
        diameterMm: dMm,
        tensionN: T,
        pluckPos: 0.5, // Exact center pluck: suppresses n = 2 partial!
      },
      children: [],
    };

    const ev = evaluateTautString(wire)!;
    const expectedB = (Math.pow(Math.PI, 3) * E * Math.pow(r, 4)) / (4 * T * L * L);
    expect(ev.inharmonicityB / expectedB).toBeCloseTo(1.0, 2);

    const mu = rho * Math.PI * r * r;
    const f0Mersenne = Math.sqrt(T / mu) / (2 * L);
    const expectedF1 = f0Mersenne * Math.sqrt(1 + expectedB);
    expect(ev.fundamentalHz).toBeCloseTo(expectedF1, 1);
    expect(ev.rawStringModes[0].freqHz).toBeCloseTo(ev.fundamentalHz, 2);

    // Center pluck (`pluckPos = 0.5`) skips n = 2 in `modes`, yet `overtoneRatio` stays ~2.00 (never 3.00!)
    expect(ev.profile.modes[1].freqHz).toBeGreaterThan(ev.fundamentalHz * 2.9);
    const expectedRatio = 2 * Math.sqrt((1 + 4 * expectedB) / (1 + expectedB));
    expect(ev.profile.overtoneRatio).toBeCloseTo(expectedRatio, 3);

    // Every emitted mode gain is strictly positive (>= 0.0008, never quantized to 0)
    for (const m of ev.profile.modes) expect(m.gain).toBeGreaterThanOrEqual(0.0008);
    for (const m of ev.rawStringModes) expect(m.gain).toBeGreaterThanOrEqual(0.0008);
  });

  it('emits un-colored rawStringModes without soundbox Helmholtz/plate injection and tunes shortened bridged strings accurately', () => {
    const celloBody = bowedCelloPreset.nodes[0];
    const a3String = celloBody.children.find((c) => c.id === 'cello_soundbox_string_4')!;

    // Slide the maple bridge +150 mm forward toward the nut (shortening vibrating scale to ~76.5%)
    const movedBridgeCello: SceneNode = {
      ...celloBody,
      children: celloBody.children.map((c) =>
        c.id === 'cello_bridge' ? { ...c, pos: [c.pos[0], c.pos[1] + 0.15, c.pos[2]] } : c,
      ),
    };

    const targetHz = noteToHz('C4')!;
    const tunedStr = tuneStringToPitch(a3String, targetHz, [movedBridgeCello]);
    const updatedScene: SceneNode = {
      ...movedBridgeCello,
      children: movedBridgeCello.children.map((c) => (c.id === a3String.id ? tunedStr : c)),
    };

    const afterEval = evaluateTautString(tunedStr, [updatedScene])!;
    expect(afterEval.soundbox).not.toBeNull();
    expect(Math.abs(hzToNoteInfo(afterEval.fundamentalHz).cents)).toBeLessThan(3);

    // `modes` includes the 2 soundbox knock modes (`helmholtzHz` & `topPlateHz`), while `rawStringModes` contains ONLY pure string partials!
    expect(afterEval.profile.modes.length).toBe(afterEval.rawStringModes.length + 2);

    // `ensureTautStringJointAndContact` turns a user `free`-joint disabled-contact Z-capsule into a pluckable slide string
    const userCapsule: SceneNode = {
      id: 'user_wire',
      name: 'User Wire',
      pos: [0, 0, 0.2],
      joints: [{ name: 'free_jnt', type: 'free' }],
      geoms: [{ name: 'cyl', type: 'capsule', size: [0.001, 0.16], contype: 0, conaffinity: 0 }],
      acousticString: { material: 'bronze', diameterMm: 0.6, tensionN: 45 },
      children: [],
    };
    const fixedWire = ensureTautStringJointAndContact(userCapsule);
    expect(fixedWire.joints.length).toBe(1);
    expect(fixedWire.joints[0].type).toBe('slide');
    // Wire runs along local Z -> transverse pluck axis is perpendicular to Z (`axis[2] === 0`)
    expect(Math.abs(fixedWire.joints[0].axis?.[2] ?? 1)).toBeLessThan(1e-4);
    expect(fixedWire.geoms[0].contype).toBeUndefined();
  });

  it('resolves 3D bridge coupling under body/bridge rotation, local-Z capsules, Y-facing bridges, reversed fromto, fingerboard action, and 3.5x scaling', () => {
    // 1. Local-Z primitive capsule (no `fromto`) rotated onto Y via `euler: [90, 0, 0]` on a 3D rotated soundbox (`euler: [25, -35, 50]`)
    const soundboxBase = soundboxLyrePreset.nodes[0];
    const zCapsuleStr: SceneNode = {
      id: 'z_cap_str',
      name: 'Z Capsule String',
      pos: [0, 0, 0.040],
      geoms: [{ name: 'w', type: 'capsule', size: [0.0011, 0.1312], euler: [90, 0, 0] }],
      joints: [{ name: 'p', type: 'slide', axis: [1, 0, 0] }],
      acousticString: {
        material: 'bronze',
        diameterMm: 0.65,
        tensionN: 48,
        resonatorNodeId: soundboxBase.id,
      },
      children: [],
    };
    expect(measureStringLengthM(zCapsuleStr)).toBeCloseTo(0.2624, 4);

    // Place `zCapsuleStr` as a top-level sibling while rotating BOTH `soundboxBase` and `zCapsuleStr` identically in world space!
    const rotEuler: [number, number, number] = [30, -25, 45];
    const rotatedBox: SceneNode = {
      ...soundboxBase,
      pos: [0.2, -0.15, 0.35],
      euler: rotEuler,
    };
    // Put string as child of rotated bridge or rotated box
    const boxWithZCap: SceneNode = {
      ...rotatedBox,
      children: [...rotatedBox.children.filter((c) => !c.acousticString), zCapsuleStr],
    };
    const rotEval = evaluateTautString(zCapsuleStr, [boxWithZCap])!;
    expect(rotEval.bridgeCoupling).toBeGreaterThan(0.95);
    expect(rotEval.soundbox).not.toBeNull();

    // 2. Vertical soundbox where bridge & nut bear along +Y onto a vertical Z-running harp string!
    const verticalHarpBox: SceneNode = {
      id: 'harp_box',
      name: 'Vertical Harp Soundbox',
      pos: [0, 0, 0.25],
      deformMaterial: 'softwood',
      csgEnabled: true,
      joints: [],
      geoms: [
        { name: 'outer', type: 'box', size: [0.07, 0.032, 0.18] },
        { name: 'cav', type: 'box', size: [0.062, 0.027, 0.17], csg: 'difference' },
        { name: 'hole', type: 'cylinder', size: [0.022, 0.01], pos: [0, -0.030, 0], euler: [90, 0, 0], csg: 'difference' },
      ],
      children: [
        {
          id: 'y_bridge_lo',
          name: 'Y Bridge Saddle',
          pos: [0, 0.035, -0.14],
          joints: [],
          geoms: [{ name: 'b1', type: 'box', size: [0.04, 0.004, 0.004], contype: 0, conaffinity: 0 }],
          children: [],
        },
        {
          id: 'y_nut_hi',
          name: 'Y Nut Saddle',
          pos: [0, 0.035, 0.14],
          joints: [],
          geoms: [{ name: 'b2', type: 'box', size: [0.04, 0.004, 0.004], contype: 0, conaffinity: 0 }],
          children: [],
        },
      ],
    };
    const verticalStr: SceneNode = {
      id: 'harp_z_str',
      name: 'Vertical Harp String',
      pos: [0, 0.039, 0],
      geoms: [{ name: 'w', type: 'capsule', size: [0.001, 0.14] }], // Runs along local Z [-0.14, +0.14]!
      joints: [{ name: 'p', type: 'slide', axis: [1, 0, 0] }],
      acousticString: { material: 'nylon', diameterMm: 0.7, tensionN: 45, resonatorNodeId: 'harp_box' },
      children: [],
    };
    verticalHarpBox.children.push(verticalStr);
    const harpEval = evaluateTautString(verticalStr, [verticalHarpBox])!;
    expect(harpEval.bridgeCoupling).toBeGreaterThan(0.95);
    expect(harpEval.soundbox?.hasHollowCavity).toBe(true);

    // 3. Reversed `fromto` (nut -> bridge) on `bowedCelloPreset` still drives at `cello_bridge` (y ≈ -0.068), NOT the nut (y = +0.572)!
    const cello = bowedCelloPreset.nodes[0];
    const origStr = cello.children.find((c) => c.id === 'cello_soundbox_string_3')!;
    const ft = origStr.geoms[0].fromto!;
    const revStr: SceneNode = {
      ...origStr,
      geoms: [{ ...origStr.geoms[0], fromto: [ft[3], ft[4], ft[5], ft[0], ft[1], ft[2]] }],
    };
    const revScene: SceneNode = {
      ...cello,
      children: cello.children.map((c) => (c.id === origStr.id ? revStr : c)),
    };
    const revEval = evaluateTautString(revStr, [revScene])!;
    expect(revEval.bridgeCoupling).toBeGreaterThan(0.95);
    expect(revEval.bridgeDrivePoint[1]).toBeLessThan(0.05); // Driven at bridge y = -0.068, NOT nut y = +0.572!

    // 4. Low-action fingerboard (2.2 mm clearance over s ∈ [0.55, 0.98], nut touching at s = 1.0) does NOT false-stop open string!
    const lowActionNeck = cello.children.find((c) => c.id === 'cello_neck_assembly')!;
    const d3CrownZ = origStr.pos[2] - (origStr.geoms[0].size[0] ?? 0.001);
    const lowActionCello: SceneNode = {
      ...cello,
      children: cello.children.map((c) =>
        c.id === lowActionNeck.id
          ? {
              ...c,
              geoms: c.geoms.map((g) =>
                g.name === 'ebony_fingerboard'
                  ? { ...g, pos: [0, 0.327, d3CrownZ - 0.0045 - 0.0022] } // 2.2 mm action clearance!
                  : g,
              ),
            }
          : c,
      ),
    };
    const lowActionEval = evaluateTautString(origStr, [lowActionCello])!;
    expect(lowActionEval.lengthM).toBeCloseTo(0.64, 2); // Full 640 mm open scale preserved!

    // 5. Scaling a `buildMountedStringsForBody` box up by 3.5x preserves `bridgeCoupling === 1.0`
    const baseBox: SceneNode = {
      id: 'custom_box',
      name: 'Custom Box',
      pos: [0, 0, 0.05],
      deformMaterial: 'softwood',
      geoms: [{ name: 'b', type: 'box', size: [0.08, 0.16, 0.03] }],
      joints: [],
      children: [],
    };
    baseBox.children = buildMountedStringsForBody(baseBox);
    const S = 3.5;
    const scaledBox: SceneNode = {
      ...baseBox,
      geoms: [{ name: 'b', type: 'box', size: [0.08 * S, 0.16 * S, 0.03 * S] }],
      children: baseBox.children.map((ch) => ({
        ...ch,
        pos: [ch.pos[0] * S, ch.pos[1] * S, ch.pos[2] * S],
        geoms: ch.geoms.map((g) => ({
          ...g,
          size: [g.size[0] * S],
          fromto: g.fromto?.map((v) => v * S),
        })),
      })),
    };
    const scaledStrEval = evaluateTautString(scaledBox.children[0], [scaledBox])!;
    expect(scaledStrEval.bridgeCoupling).toBe(1);
  });

  it('folds bowBeta > 0.5, chokes at β -> 0, preserves n = 1 in sul ponticello Helmholtz lock, scales β with stoppedLengthFraction, and detects wolf resonance', () => {
    const cello = bowedCelloPreset.nodes[0];
    const a3 = cello.children.find((c) => c.id === 'cello_soundbox_string_4')!;

    // 1. Stopped-span β scaling: bowing 64 mm from bridge (`y = -0.32 + 0.064 = -0.256`, open β = 0.10) doubles to β = 0.20 when stopped at octave (`0.5`)!
    const betaOpen = resolveStringBetaFromPoint(a3, [0, -0.256, 0], 1.0, bowedCelloPreset.nodes);
    const betaOctave = resolveStringBetaFromPoint(a3, [0, -0.256, 0], 0.5, bowedCelloPreset.nodes);
    expect(betaOpen).toBeCloseTo(0.10, 2);
    expect(betaOctave).toBeCloseTo(0.20, 2);

    // 2. Symmetry folding: `bowBeta = 0.89` matches `bowBeta = 0.11`, whereas `bowBeta = 0.001` (on bridge saddle) chokes to silent!
    const vNear0 = solveBowedStringVoice({
      node: a3,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.24,
      bowForceN: 0.70,
      bowBeta: 0.11,
    });
    const vNear1 = solveBowedStringVoice({
      node: a3,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.24,
      bowForceN: 0.70,
      bowBeta: 0.89,
    });
    const vOnBridge = solveBowedStringVoice({
      node: a3,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.24,
      bowForceN: 0.70,
      bowBeta: 0.001,
    });
    expect(vNear1.amplitude).toBeCloseTo(vNear0.amplitude, 4);
    expect(vNear1.stringHarmonicWeights).toEqual(vNear0.stringHarmonicWeights);
    expect(vOnBridge.active).toBe(false);
    expect(vOnBridge.amplitude).toBe(0);

    // 3. Interior-only `bowComb`: at sul ponticello (`beta = 0.04`) with firm Helmholtz force (`2.0 N > fMin`),
    //    fundamental `stringHarmonicWeights[0]` is full `1.0` (not notched by `m = 0`), while sub-fMin force drops fundamental!
    const firmPonticello = solveBowedStringVoice({
      node: a3,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.20,
      bowForceN: 2.0,
      bowBeta: 0.04,
    });
    const glassyPonticello = solveBowedStringVoice({
      node: a3,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.20,
      bowForceN: 0.05,
      bowBeta: 0.04,
    });
    expect(firmPonticello.regime).toBe('helmholtz');
    expect(firmPonticello.stringHarmonicWeights[0]).toBeGreaterThan(0.95);
    expect(glassyPonticello.regime).toBe('flautando');
    expect(glassyPonticello.stringHarmonicWeights[0]).toBeLessThan(firmPonticello.stringHarmonicWeights[0] * 0.75);

    // 4. Schelleng `fMin` rises & triggers wolf-note beating when thick C2/G2 string stops right on `soundbox.topPlateHz`!
    const c2 = cello.children.find((c) => c.id === 'cello_soundbox_string_1')!;
    const c2Eval = evaluateTautString(c2, bowedCelloPreset.nodes)!;
    const topHz = c2Eval.soundbox!.topPlateHz;
    const stopOnWolf = Math.max(0.26, Math.min(0.95, c2Eval.fundamentalHz / topHz));
    const stopOffWolf = Math.max(0.26, Math.min(0.95, (c2Eval.fundamentalHz / topHz) * 1.32));

    const onWolf = solveBowedStringVoice({
      node: c2,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.22,
      bowForceN: 0.55,
      bowBeta: 0.12,
      stoppedLengthFraction: stopOnWolf,
    });
    const offWolf = solveBowedStringVoice({
      node: c2,
      sceneNodes: bowedCelloPreset.nodes,
      bowVelocityMps: 0.22,
      bowForceN: 0.55,
      bowBeta: 0.12,
      stoppedLengthFraction: stopOffWolf,
    });
    expect(onWolf.fMin).toBeGreaterThan(offWolf.fMin * 1.15);
    expect(onWolf.wolfBeatDepth ?? 0).toBeGreaterThan(0.05);
    expect(onWolf.wolfBeatHz ?? 0).toBeGreaterThan(3.0);
  });

  it('implements Starter #4b Kirchhoff-Carrier nonlinear pluck pitch droop Δf ∝ (A/L)² with 2x decay rate', () => {
    const lyre = soundboxLyrePreset.nodes[0];
    const c4 = lyre.children.find((c) => c.acousticString)!;
    const L = measureStringLengthM(c4);

    // Small/moderate plucks follow exact quadratic scaling Δf/f0 ∝ (A/L)² ∝ J²!
    const soft = computePluckPitchDroop(c4, L, 0.04, 0.18, 1.84);
    const double = computePluckPitchDroop(c4, L, 0.08, 0.18, 1.84);
    const hard = computePluckPitchDroop(c4, L, 0.90, 0.18, 1.84);

    expect(double.displacementM / soft.displacementM).toBeCloseTo(2.0, 2);
    expect(double.pitchDroopFrac / soft.pitchDroopFrac).toBeCloseTo(4.0, 1);
    expect(hard.pitchDroopCents).toBeGreaterThan(35);
    expect(soft.pitchDroopCents).toBeLessThan(2);

    // Decay time constant τ_droop is half of the amplitude 1/e decay constant τ_amp = decaySec / ln(10000)!
    const expectedTauAmp = 1.84 / Math.log(10000);
    expect(hard.pitchDroopTauSec).toBeCloseTo(0.5 * expectedTauAmp, 3);

    // Lowering string tension increases pitch droop steeply; `nonlinearPitchDroop: false` disables it cleanly
    const slackC4: SceneNode = {
      ...c4,
      acousticString: { ...c4.acousticString!, tensionN: c4.acousticString!.tensionN * 0.45 },
    };
    const disabledC4: SceneNode = {
      ...c4,
      acousticString: { ...c4.acousticString!, nonlinearPitchDroop: false },
    };
    expect(computePluckPitchDroop(slackC4, L, 0.25).pitchDroopCents).toBeGreaterThan(
      computePluckPitchDroop(c4, L, 0.25).pitchDroopCents * 2.5,
    );
    expect(computePluckPitchDroop(disabledC4, L, 0.90).pitchDroopFrac).toBe(0);

    // `evaluateTautString` populates `pitchDroopFrac` on partials when `impactCtx.impulseNs` is provided
    const hardEval = evaluateTautString(c4, soundboxLyrePreset.nodes, { impulseNs: 0.85 })!;
    expect(hardEval.pitchDroop.pitchDroopCents).toBeGreaterThan(30);
    expect(hardEval.rawStringModes[0].pitchDroopFrac ?? 0).toBeGreaterThan(0.015);
  });

  it('implements Starter #3 Weinreich-Gough bridge-admittance sympathetic string coupling on bowedCello and soundboxLyre', () => {
    const cello = bowedCelloPreset.nodes[0];
    const celloStrings = cello.children.filter((c) => !!c.acousticString);
    const [, g2, d3, a3] = celloStrings;

    // Playing A3 (220 Hz): 2nd harmonic (440 Hz) strongly excites D3's 3rd partial (440.49 Hz) & G2's 9th partial (882 Hz)!
    const sympFromA3 = solveSympatheticStringCoupling(a3, bowedCelloPreset.nodes);
    expect(sympFromA3.length).toBeGreaterThanOrEqual(2);
    const d3Target = sympFromA3.find((t) => t.targetNodeId === d3.id)!;
    expect(d3Target).toBeDefined();
    const d3ThirdPartial = d3Target.modes.find((m) => Math.abs(m.freqHz - 440.5) < 4)!;
    expect(d3ThirdPartial).toBeDefined();
    expect(d3ThirdPartial.gain).toBeGreaterThan(0.01);

    // Playing G2 (98 Hz): 2nd harmonic (196 Hz) strongly excites C2's 3rd partial (196.23 Hz) & 3rd harmonic (294 Hz) excites D3's 2nd partial!
    const sympFromG2 = solveSympatheticStringCoupling(g2, bowedCelloPreset.nodes);
    expect(sympFromG2.some((t) => t.targetNodeId === 'cello_soundbox_string_1')).toBe(true);
    expect(sympFromG2.some((t) => t.targetNodeId === d3.id)).toBe(true);

    // Unbridged floating string drives ZERO sympathetic targets
    const bridgelessCello: SceneNode = {
      ...cello,
      children: cello.children.filter((c) => c.id !== 'cello_bridge'),
    };
    expect(solveSympatheticStringCoupling(a3, [bridgelessCello])).toEqual([]);

    // On `soundboxLyrePreset`: C4 (3rd partial 784.9 Hz) sympathetically excites G4 (2nd partial 784.0 Hz) much more than E4/D4!
    const lyre = soundboxLyrePreset.nodes[0];
    const lyreStrings = lyre.children.filter((c) => !!c.acousticString);
    const c4Lyre = lyreStrings[0]; // C4
    const d4Lyre = lyreStrings[1]; // D4
    const g4Lyre = lyreStrings[3]; // G4
    const lyreSymp = solveSympatheticStringCoupling(c4Lyre, soundboxLyrePreset.nodes);
    const g4Hit = lyreSymp.find((t) => t.targetNodeId === g4Lyre.id);
    const d4Hit = lyreSymp.find((t) => t.targetNodeId === d4Lyre.id);
    expect(g4Hit).toBeDefined();
    expect(g4Hit!.couplingGain).toBeGreaterThan((d4Hit?.couplingGain ?? 0) * 1.5);
  });

  it('bounds zero-mode clacks & convolvers, sanitizes/scales resampled IRs, mutates re-strikes in quadrature, chokes grabs/nodal touches, and silences cleanly', () => {
    // 1. IR NaN/Inf sanitizer + sample-rate convolution gain invariance (96 kHz taps = 0.5x 48 kHz taps!)
    const dirtyIr = new Float32Array(256);
    dirtyIr[0] = Number.NaN;
    dirtyIr[1] = Number.POSITIVE_INFINITY;
    for (let i = 2; i < 256; i++) dirtyIr[i] = Math.exp(-i / 40);

    const clean48 = sanitizeAndResampleIrSamples(dirtyIr, 48000, 48000)!;
    const clean96 = sanitizeAndResampleIrSamples(dirtyIr, 96000, 48000)!;
    expect(clean48).not.toBeNull();
    expect(clean96).not.toBeNull();
    for (const v of clean48) expect(Number.isFinite(v)).toBe(true);
    for (const v of clean96) expect(Number.isFinite(v)).toBe(true);
    expect(clean48[0]).toBe(0);
    expect(clean48[1]).toBe(0);
    // Sum of taps at 96 kHz (2x sample count, 0.5x tap amplitude) preserves the continuous-time DC integral!
    const sum48 = clean48.reduce((s, v) => s + v, 0);
    const sum96 = clean96.reduce((s, v) => s + v, 0);
    expect(sum96 / sum48).toBeCloseTo(1.0, 1);
    expect(Math.max(...clean96)).toBeLessThan(Math.max(...clean48) * 0.55);
    expect(sanitizeAndResampleIrSamples(new Float32Array([Number.NaN, 0]), 48000)).toBeNull();

    // 2. Zero-mode (`voices: []`) rigid clack storm with `bodyIr`: caps groups <= 24, convolvers <= 16, & caches IR buffer!
    const harness = createMockAudioContext(48000);
    const validIr = new Float32Array(512);
    for (let i = 0; i < 512; i++) validIr[i] = 0.35 * Math.exp(-i / 80) * Math.sin(i * 0.25);

    for (let i = 0; i < 60; i++) {
      triggerOrMutateModalVoice({
        ctx: harness.ctx,
        outputBus: harness.bus,
        nodeId: `ball_${i}`,
        level: 0.25,
        tauC: 0.0006,
        brightness: 0.8,
        voices: [], // Ultrasonic rigid ball (`modes.length === 0`) — previously bypassed MAX_ACTIVE_VOICES!
        bodyIr: validIr,
        bodyIrSig: 'shared_ball_ir_v1',
      });
    }
    const stormStats = getModalVoicePoolStats(harness.ctx);
    expect(stormStats.activeGroups).toBeLessThanOrEqual(MAX_ACTIVE_IMPACTS);
    expect(stormStats.activeConvolvers).toBeLessThanOrEqual(MAX_ACTIVE_CONVOLVERS);
    expect(stormStats.activeOscillators).toBeLessThanOrEqual(MAX_ACTIVE_OSCILLATORS);
    // Resampled IR AudioBuffer was built and cached ONCE across all 60 impacts!
    expect(stormStats.cachedIrBuffers).toBe(1);

    // `silenceModalVoices(ctx, 0)` immediately stops and disconnects everything
    silenceModalVoices(harness.ctx, 0);
    expect(getModalVoicePoolStats(harness.ctx).activeGroups).toBe(0);

    // 3. Re-pluck mutability, pitch-droop scheduling, Wave 2B hooks (snare, crash, tremolo, pan), & suspended-ctx safety
    const h2 = createMockAudioContext(48000, 'suspended');
    const lyre = soundboxLyrePreset.nodes[0];
    const str1 = lyre.children.find((c) => c.acousticString)!;
    const strEval = evaluateTautString(str1, soundboxLyrePreset.nodes, { impulseNs: 0.65 })!;

    const gFirst = triggerOrMutateModalVoice({
      ctx: h2.ctx,
      outputBus: h2.bus,
      nodeId: str1.id,
      level: 0.32,
      tauC: 0.0008,
      brightness: 0.7,
      isPluck: true,
      voices: strEval.modes,
      rawIrVoices: strEval.rawStringModes,
      bodyIr: validIr,
      bodyIrSig: 'lyre_ir',
      pluckBeta: 0.2,
      pan: -0.45,
      distanceGain: 0.9,
      snare: { gain: 0.4, decaySec: 0.14 },
      crashShimmer: { gain: 0.3, bloomSec: 0.06, decaySec: 0.5 },
      tremolo: { rateHz: 6.0, depth: 0.5, formantHz: 262 },
    })!;
    expect(gFirst).not.toBeNull();
    // Fed pure `rawStringModes` (not `modes` with 2 extra box modes) into the IR-backed string group!
    expect(gFirst.modes.length).toBe(strEval.rawStringModes.length);
    // Nonlinear pitch droop scheduled upward start frequency + `setTargetAtTime` glide back to base `freqHz`
    expect(gFirst.modes[0].osc.frequency.ops.some((o) => o.op === 'setTarget')).toBe(true);

    const oscCountAfterFirst = h2.stats.oscCreated;
    const convCountAfterFirst = h2.stats.convCreated;

    // While `ctx.currentTime` stays frozen on suspended context, sweep NEVER prematurely disconnects `master`!
    sweepExpiredVoiceGroups(h2.ctx);
    expect(getModalVoicePoolStats(h2.ctx).activeGroups).toBe(1);

    // Advance `ctx.currentTime` by 80 ms and re-pluck the SAME `str1.id`: reuses exact same oscillators & convolver!
    h2.ctx.currentTime += 0.08;
    const ampBeforeRepluck = evaluateModeAmplitudeAt(gFirst.modes[0], h2.ctx.currentTime);
    expect(ampBeforeRepluck).toBeGreaterThan(0.01);

    const gSecond = triggerOrMutateModalVoice({
      ctx: h2.ctx,
      outputBus: h2.bus,
      nodeId: str1.id,
      level: 0.35,
      tauC: 0.0008,
      brightness: 0.7,
      isPluck: true,
      voices: strEval.modes,
      rawIrVoices: strEval.rawStringModes,
      bodyIr: validIr,
      bodyIrSig: 'lyre_ir',
      pluckBeta: 0.2,
    })!;
    expect(gSecond).toBe(gFirst);
    expect(h2.stats.oscCreated).toBe(oscCountAfterFirst); // ZERO new oscillators allocated!
    expect(h2.stats.convCreated).toBe(convCountAfterFirst); // ZERO new convolvers allocated!

    // Live spatial pan & tremolo updates mutate `StereoPannerNode` and `tremoloGain` cleanly
    updateVoiceSpatialPan(h2.ctx, str1.id, 0.65, 0.75);
    updateVoiceTremolo(h2.ctx, str1.id, { rateHz: 7.5, depth: 0.8 });
    expect((gFirst.panner as unknown as MockStereoPannerNode).pan.value).toBeCloseTo(0.65, 2);

    // 4. Nodal finger touch (`AUDIO_DAMPING` at midpoint [0, 0, 0] -> β = 0.5) damps n = 1 while preserving n = 2 flageolet!
    h2.ctx.currentTime += 0.02;
    const tau1Before = gFirst.modes[0].tauSec;
    const tau2Before = gFirst.modes[1].tauSec;
    applyAudioDampingEvents(
      h2.ctx,
      [
        {
          nodeId: str1.id,
          normalForce: 0.12, // Light harmonic finger touch
          dampingRate: 28.0,
          softness: 0.6,
          localPoint: [0, 0, 0], // Exact center node of n = 2!
        },
      ],
      soundboxLyrePreset.nodes,
    );
    expect(gFirst.modes[0].tauSec).toBeLessThan(tau1Before * 0.30); // Fundamental n = 1 strongly damped!
    expect(gFirst.modes[1].tauSec).toBeGreaterThan(tau2Before * 0.90); // Octave harmonic n = 2 rings on!

    // Full hand grab (`mode: 'grab'`) damps ALL remaining modes rapidly (< 55 ms tau)
    expect(chokeBodyVoice(h2.ctx, str1.id, { mode: 'grab' })).toBe(true);
    expect(gFirst.modes[1].tauSec).toBeLessThan(0.055);

    // 5. Sympathetic pluck & bowed string halo create independent sibling voice groups
    silenceModalVoices(h2.ctx, 0);
    h2.ctx.state = 'running';
    const sympTriggered = triggerSympatheticStringPluck(
      h2.ctx,
      h2.bus,
      str1,
      soundboxLyrePreset.nodes,
      0.55,
    );
    expect(sympTriggered).toBeGreaterThanOrEqual(1);
    expect(getModalVoicePoolStats(h2.ctx).activeGroups).toBe(sympTriggered);

    const cello = bowedCelloPreset.nodes[0];
    const celloA3 = cello.children.find((c) => c.id === 'cello_soundbox_string_4')!;
    updateSympatheticBowedVoices(
      h2.ctx,
      h2.bus,
      [{ node: celloA3, pitchHz: 220, amplitude: 0.30, stringHarmonicWeights: [1, 0.5, 0.33, 0.25] }],
      bowedCelloPreset.nodes,
    );
    expect(getModalVoicePoolStats(h2.ctx).groupKeys.some((k) => k.endsWith(':symp'))).toBe(true);

    // Advancing `ctx.currentTime` past expiry sweeps all groups to 0
    h2.ctx.currentTime += 10.0;
    sweepExpiredVoiceGroups(h2.ctx);
    expect(getModalVoicePoolStats(h2.ctx).activeGroups).toBe(0);
  });
});
