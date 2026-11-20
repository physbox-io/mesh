import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import type { AudioDampingEvent, AudioImpactEvent } from '../src/workers/physicsWorkerProtocol';
import { marimbaCascadePreset } from '../src/presets/marimbaCascade';
import { noteToHz } from '../src/utils/acousticTuning';
import {
  computeContactDampingRate,
  computeImpactSolSoftScale,
  shouldEmitPairImpact,
} from '../src/utils/contactFrictionAcoustics';
import {
  estimateBodyModes,
  extractModalProfile,
  isMembraneCandidate,
  playModalImpact,
  resolveTwoBodyImpact,
  silenceModalVoices,
} from '../src/utils/modalAudio';
import {
  applyAudioDampingEvents,
  evaluateModeAmplitudeAt,
  getModalVoicePoolStats,
  triggerOrMutateModalVoice,
} from '../src/utils/voiceSympathyPool';
import { worldToBodyFrame } from '../src/workers/bodyKinematics';
import { simulate } from './helpers/simulate';

// ---------------------------------------------------------------------------
// Deterministic WebAudio Mock Context for Modal Voice & Choking Verification
// ---------------------------------------------------------------------------

interface RecordedOp {
  op: string;
  value?: number;
  time: number;
  tau?: number;
}

class MockParam {
  value: number;
  ops: RecordedOp[] = [];
  constructor(init = 0) {
    this.value = init;
  }
  setValueAtTime(v: number, t: number) {
    this.value = v;
    this.ops.push({ op: 'setValue', value: v, time: t });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.ops.push({ op: 'linearRamp', value: v, time: t });
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.value = v;
    this.ops.push({ op: 'expRamp', value: v, time: t });
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
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
  connect(dest: unknown) {
    this.connections.add(dest);
    return dest;
  }
  disconnect(dest?: unknown) {
    if (dest !== undefined) this.connections.delete(dest);
    else this.connections.clear();
  }
}

function createMarimbaTestAudioContext(sampleRate = 48000) {
  let currentTime = 0;
  const convolvers: MockAudioNode[] = [];
  const oscillators: (MockAudioNode & { type: string; frequency: MockParam })[] = [];
  const destination = new MockAudioNode();

  const ctx = {
    sampleRate,
    state: 'running' as AudioContextState,
    get currentTime() {
      return currentTime;
    },
    set currentTime(t: number) {
      currentTime = t;
    },
    destination,
    createGain: () => Object.assign(new MockAudioNode(), { gain: new MockParam(1) }),
    createBiquadFilter: () =>
      Object.assign(new MockAudioNode(), {
        type: 'lowpass',
        frequency: new MockParam(800),
        Q: new MockParam(1),
        gain: new MockParam(0),
      }),
    createStereoPanner: () => Object.assign(new MockAudioNode(), { pan: new MockParam(0) }),
    createConvolver: () => {
      const c = Object.assign(new MockAudioNode(), { normalize: false, buffer: null as unknown });
      convolvers.push(c);
      return c;
    },
    createOscillator: () => {
      const o = Object.assign(new MockAudioNode(), {
        type: 'sine',
        frequency: new MockParam(440),
        detune: new MockParam(0),
        start: () => {},
        stop: () => {},
        setPeriodicWave: () => {},
      });
      oscillators.push(o);
      return o;
    },
    createWaveShaper: () => Object.assign(new MockAudioNode(), { curve: null, oversample: 'none' }),
    createDynamicsCompressor: () =>
      Object.assign(new MockAudioNode(), {
        threshold: new MockParam(-3),
        knee: new MockParam(6),
        ratio: new MockParam(10),
        attack: new MockParam(0.002),
        release: new MockParam(0.12),
      }),
    createBuffer: (_ch: number, len: number, sr: number) => ({
      sampleRate: sr,
      length: len,
      numberOfChannels: 1,
      duration: len / sr,
      getChannelData: () => new Float32Array(len),
    }),
    createBufferSource: () =>
      Object.assign(new MockAudioNode(), {
        buffer: null as unknown,
        loop: false,
        onended: null as (() => void) | null,
        start: () => {},
        stop: () => {},
      }),
    createPeriodicWave: () => ({}),
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
  };

  return {
    ctx: ctx as unknown as AudioContext & { currentTime: number },
    bus: destination as unknown as AudioNode,
    convolvers,
    oscillators,
  };
}

describe('Marimba Tonal Pitch vs Atonal Drum-Thud Regression Suite', () => {
  it('classifies marimba_bar_c4..a4 as beam (never membrane/clack), tuned within <= 10 cents of C4..A4 with ~4.0x arch overtone, and guards membrane routing strictly on Boolean(node.acousticMembrane)', () => {
    const expectedNotes = [
      { id: 'marimba_bar_c4', note: 'C4', hz: 261.63 },
      { id: 'marimba_bar_d4', note: 'D4', hz: 293.66 },
      { id: 'marimba_bar_e4', note: 'E4', hz: 329.63 },
      { id: 'marimba_bar_g4', note: 'G4', hz: 392.00 },
      { id: 'marimba_bar_a4', note: 'A4', hz: 440.00 },
    ] as const;

    for (const item of expectedNotes) {
      const bar = marimbaCascadePreset.nodes.find((n) => n.id === item.id)!;
      expect(bar).toBeDefined();
      expect(bar.acousticMembrane).toBeUndefined();

      const extracted = extractModalProfile(bar, true, marimbaCascadePreset.nodes);
      expect(extracted.regime).toBe('beam');
      expect(extracted.regime).not.toBe('membrane');
      expect(extracted.regime).not.toBe('clack');
      expect(extracted.structuralRegime).toBe('arched_bar');

      const targetHz = noteToHz(item.note) ?? item.hz;
      const cents = Math.abs(1200 * Math.log2(extracted.fundamentalHz / targetHz));
      expect(cents, `${item.id} tuning error (${extracted.fundamentalHz} Hz vs ${targetHz} Hz)`).toBeLessThanOrEqual(10);

      // Concert luthier arch tunes the 2nd flexural mode near the ~4.0x double-octave harmonic
      expect(extracted.overtoneRatio, `${item.id} arch overtone ratio`).toBeGreaterThan(3.75);
      expect(extracted.overtoneRatio, `${item.id} arch overtone ratio`).toBeLessThan(4.50);

      // Solid cavity-free rosewood bars MUST NOT allocate a 3D FDTD cavity bodyIr!
      expect(extracted.hasAcousticCavity).toBe(false);
      expect(extracted.bodyIr).toBeNull();
    }

    // Even a thin flat wooden plank whose aspect ratio matches `isMembraneCandidate(plank) === true`
    // MUST NOT route into 2D Bessel/rectangular drum synthesis unless `Boolean(node.acousticMembrane)` is set!
    const thinWoodPlank: SceneNode = {
      id: 'thin_wood_plank',
      name: 'Thin Rosewood Plank',
      pos: [0, 0, 0.05],
      deformMaterial: 'hardwood',
      geoms: [{ name: 'plank', type: 'box', size: [0.08, 0.06, 0.003] }],
      joints: [],
      children: [],
    };
    expect(isMembraneCandidate(thinWoodPlank)).toBe(true);
    const plankProfile = extractModalProfile(thinWoodPlank, true);
    expect(plankProfile.regime).not.toBe('membrane');
    const plankHit = resolveTwoBodyImpact(plankProfile, thinWoodPlank, { impulseNs: 0.35 });
    expect(plankHit.snare).toBeUndefined();
    expect(plankHit.voices.every((v) => v.pitchDroopFrac === undefined)).toBe(true);
  });

  it('ensures modal sine voice gains dominate transient mallet click (> +20 dB), bypass solid-block ConvolverNode, have zero drum pitch-drop, and bloom cleanly in 2–4 ms', () => {
    const harness = createMarimbaTestAudioContext(48000);
    const prevWin = (globalThis as Record<string, unknown>).window;
    try {
      (globalThis as Record<string, unknown>).window = {
        AudioContext: function () {
          return harness.ctx;
        },
        __physboxSharedAudioCtx: harness.ctx,
      };
      harness.ctx.currentTime = 1.0;

      for (const [idx, note] of (['C4', 'D4', 'E4', 'G4', 'A4'] as const).entries()) {
        const bar = marimbaCascadePreset.nodes.find((n) => n.id === `marimba_bar_${note.toLowerCase()}`)!;
        const mallet = marimbaCascadePreset.nodes.find((n) => n.id === `mallet_${idx + 1}`)!;
        const profile = extractModalProfile(bar, true, marimbaCascadePreset.nodes);
        const twoBody = resolveTwoBodyImpact(profile, bar, {
          impulseNs: 0.22,
          strikerNode: mallet,
          selfGeomName: 'bar_body',
          strikerGeomName: `mallet_head_${idx}`,
          localPoint: [0, -0.015, 0.0085],
          sceneNodes: marimbaCascadePreset.nodes,
        });

        expect(twoBody.bodyIr).toBeNull();
        expect(twoBody.voices.length).toBeGreaterThanOrEqual(2);
        // Zero spurious drum pitch-drop on wooden marimba bars!
        for (const v of twoBody.voices) {
          expect(v.pitchDroopFrac).toBeUndefined();
          expect(v.pitchGlideCents).toBeUndefined();
        }

        const group = playModalImpact(profile, 0.22, false, {
          ...twoBody,
          nodeId: bar.id,
        })!;
        expect(group).not.toBeNull();
        // NEVER routed into a solid-block FDTD ConvolverNode!
        expect(group.irConv).toBeNull();
        expect(group.irWetGain).toBeNull();

        // Pitched modal oscillators carry > +20 dB (> 10x amplitude) over the transient mallet click!
        const fundamentalPeak = group.modes[0].peakGain;
        const totalModalPeak = group.modes.reduce((s, m) => s + m.peakGain, 0);
        const tonalToClickDb = 20 * Math.log10(totalModalPeak / Math.max(1e-6, group.pulsePeakGain));
        expect(fundamentalPeak).toBeGreaterThan(group.pulsePeakGain * 10);
        expect(tonalToClickDb, `${bar.id} tonal-to-click ratio (dB)`).toBeGreaterThan(20);

        // Clean warm yarn mallet attack bloom (~2–4 ms) and zero pitch droop
        const attackSec = group.modes[0].attackEndTime - group.modes[0].anchorTime;
        expect(attackSec).toBeGreaterThanOrEqual(0.002);
        expect(attackSec).toBeLessThanOrEqual(0.0042);
        expect(group.modes[0].droopFrac).toBe(0);
      }

      // Zero ConvolverNodes allocated beyond the single shared Studio Chamber reverb bus!
      expect(getModalVoicePoolStats(harness.ctx).activeConvolvers).toBe(0);
    } finally {
      silenceModalVoices(harness.ctx, 0);
      if (prevWin === undefined) delete (globalThis as Record<string, unknown>).window;
      else (globalThis as Record<string, unknown>).window = prevWin;
    }
  });

  it('steps marimbaCascadePreset for 2.0 s in real MuJoCo, preserves natural rosewood ring across resting/rail contacts, honors Euler-Bernoulli nodes, and chokes > 85% within 0.15 s on post-strike felt damper contact', async () => {
    const harness = createMarimbaTestAudioContext(48000);
    const sim = await simulate(marimbaCascadePreset);

    try {
      const nodes = marimbaCascadePreset.nodes;
      const nodeById = new Map<string, SceneNode>();
      const nodeIdByBody = new Map<number, string>([[0, 'world']]);
      const geomNameById = new Map<number, string>();
      const dedicatedResonatorBodies = new Set<number>();

      const walk = (list: SceneNode[]) => {
        for (const n of list) {
          nodeById.set(n.id, n);
          const bid = sim.bodyId(n.id) >= 0 ? sim.bodyId(n.id) : sim.bodyId(n.name);
          if (bid > 0) {
            nodeIdByBody.set(bid, n.id);
            if (typeof n.tunedPitchHz === 'number' || n.acousticString || n.acousticMembrane || n.nonlinearPlate) {
              dedicatedResonatorBodies.add(bid);
            }
          }
          if (n.children?.length) walk(n.children);
        }
      };
      walk(nodes);

      for (let g = 0; g < sim.model.ngeom; g++) {
        geomNameById.set(g, `geom_${g}`);
      }
      for (const n of nodeById.values()) {
        for (const g of n.geoms ?? []) {
          const gid = sim.model.ngeom > 0 ? (() => {
            for (let k = 0; k < sim.model.ngeom; k++) {
              if (sim.model.geom_bodyid[k] === (sim.bodyId(n.id) >= 0 ? sim.bodyId(n.id) : sim.bodyId(n.name))) {
                return k;
              }
            }
            return -1;
          })() : -1;
          if (gid >= 0 && g.name) geomNameById.set(gid, g.name);
        }
      }

      const softnessOfNode = (n: SceneNode | undefined): number => {
        const map: Record<string, number> = {
          rubber: 0.92,
          plastic: 0.58,
          softwood: 0.20,
          hardwood: 0.16,
          softMetal: 0.08,
          steel: 0.05,
        };
        return n?.deformMaterial ? (map[n.deformMaterial] ?? 0.20) : 0.14;
      };

      const nv = sim.model.nv;
      const dt = sim.model.opt.timestep;
      const prevC = new Float64Array(nv);
      const lastEmitSim = new Map<string, { atSimTime: number; impulseNs: number }>();
      const pairStartSim = new Map<string, number>();
      const lastStrikeSim = new Map<string, number>();
      let lastDampCheckSim = -1;

      const strikeRecords: { nodeId: string; hitTime: number; peakAmp: number; expectedTauSec: number }[] = [];
      const emittedImpactNodeIds: string[] = [];

      // Step full 2.0 seconds (1000 steps @ 2 ms) of Grieg's "Morning Mood" in real MuJoCo WASM!
      const totalSteps = Math.round(2.0 / dt);
      for (let step = 0; step < totalSteps; step++) {
        sim.step(1);
        const simTime = sim.time();
        harness.ctx.currentTime = simTime;

        const qfrcC = sim.data.qfrc_constraint;
        const bodyJumpSq = new Map<number, number>();
        for (let d = 0; d < nv; d++) {
          const cur = qfrcC[d];
          const prev = prevC[d];
          prevC[d] = cur;
          if (step === 0) continue;
          const isLoading = Math.abs(cur) > Math.abs(prev) + 0.25 || cur * prev < -0.25;
          if (!isLoading) continue;
          const df = cur - prev;
          if (Math.abs(df) < 0.25) continue;
          const bid = sim.model.dof_bodyid[d];
          if (bid > 0) bodyJumpSq.set(bid, (bodyJumpSq.get(bid) ?? 0) + df * df);
        }

        const impactEvents: AudioImpactEvent[] = [];
        if (bodyJumpSq.size > 0) {
          const cVec = sim.data.contact;
          try {
            const ncon = cVec.size();
            for (let c = 0; c < ncon; c++) {
              const ct = cVec.get(c);
              try {
                const b1 = sim.model.geom_bodyid[ct.geom1];
                const b2 = sim.model.geom_bodyid[ct.geom2];
                const jump = Math.max(bodyJumpSq.get(b1) ?? 0, bodyJumpSq.get(b2) ?? 0);
                if (jump <= 0) continue;
                const rawImp = Math.sqrt(jump) * dt;
                const st = Math.max(sim.model.geom_solref[ct.geom1 * 2] || 0.004, sim.model.geom_solref[ct.geom2 * 2] || 0.004);
                const sd = Math.max(sim.model.geom_solref[ct.geom1 * 2 + 1] || 0.5, sim.model.geom_solref[ct.geom2 * 2 + 1] || 0.5);
                const imp = rawImp * computeImpactSolSoftScale(st, sd, dt, false);
                if (imp < 0.0015) continue;

                const cKey = `${Math.min(b1, b2)}:${Math.max(b1, b2)}`;
                if (!pairStartSim.has(cKey)) pairStartSim.set(cKey, simTime);

                const wp: [number, number, number] = [ct.pos[0], ct.pos[1], ct.pos[2]];
                for (const [selfB, otherB, selfG, otherG] of [
                  [b1, b2, ct.geom1, ct.geom2],
                  [b2, b1, ct.geom2, ct.geom1],
                ] as const) {
                  if (selfB <= 0) continue;
                  if (otherB > 0 && dedicatedResonatorBodies.has(otherB) && !dedicatedResonatorBodies.has(selfB)) continue;
                  const selfId = nodeIdByBody.get(selfB);
                  const otherId = otherB > 0 ? (nodeIdByBody.get(otherB) ?? 'world') : 'world';
                  if (!selfId) continue;
                  const pKey = `${selfId}:${otherId}`;
                  if (!shouldEmitPairImpact(lastEmitSim.get(pKey), simTime, imp, st)) continue;
                  lastEmitSim.set(pKey, { atSimTime: simTime, impulseNs: imp });
                  lastStrikeSim.set(selfId, simTime);
                  const ox = sim.data.xpos[selfB * 3];
                  const oy = sim.data.xpos[selfB * 3 + 1];
                  const oz = sim.data.xpos[selfB * 3 + 2];
                  const localPoint = worldToBodyFrame(sim.data.xmat, selfB, [wp[0] - ox, wp[1] - oy, wp[2] - oz]);
                  impactEvents.push({
                    nodeId: selfId,
                    otherNodeId: otherId,
                    impulseNs: imp,
                    selfGeomName: geomNameById.get(selfG),
                    otherGeomName: geomNameById.get(otherG),
                    localPoint,
                  });
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            cVec.delete();
          }
        }

        // Feed emitted AUDIO_IMPACTS into voiceSympathyPool!
        for (const ev of impactEvents) {
          emittedImpactNodeIds.push(ev.nodeId);
          const targetNode = nodeById.get(ev.nodeId)!;
          const strikerNode = ev.otherNodeId ? (nodeById.get(ev.otherNodeId) ?? null) : null;
          const profile = estimateBodyModes(targetNode, true, nodes);
          const twoBody = resolveTwoBodyImpact(profile, targetNode, {
            impulseNs: ev.impulseNs,
            strikerNode,
            selfGeomName: ev.selfGeomName,
            strikerGeomName: ev.otherGeomName,
            localPoint: ev.localPoint,
            sceneNodes: nodes,
          });
          const radScale = twoBody.radiationScale;
          const level = Math.min(0.56, 0.30 * Math.log10(1 + Math.max(0.0005, ev.impulseNs) * 95) * radScale);
          const group = triggerOrMutateModalVoice({
            ctx: harness.ctx,
            outputBus: harness.bus,
            nodeId: targetNode.id,
            level,
            tauC: twoBody.tauC,
            brightness: twoBody.effectiveBrightness,
            voices: twoBody.voices,
            bodyIr: twoBody.bodyIr,
            bodyIrSig: twoBody.bodyIrSig,
            bodyIrGain: twoBody.bodyIrGain,
            materialQ: profile.material.qualityQ,
            modeVectors: profile.modeVectors,
            lenAxis: profile.lenAxis,
            lenBounds: profile.lenBounds,
            strikeXi: twoBody.strikeXi,
            strikerMassKg: twoBody.strikerMassKg,
            bodyMassKg: twoBody.bodyMassKg,
            simTime,
          });
          if (group && targetNode.id.startsWith('marimba_bar_')) {
            strikeRecords.push({
              nodeId: targetNode.id,
              hitTime: simTime,
              peakAmp: group.modes[0].peakGain,
              expectedTauSec: group.modes[0].tauSec,
            });
          }
        }

        // Every 14 ms, run continuous contact scan AND ALSO inject continuous resting-rail AUDIO_DAMPING
        // events (simulating bars sitting continuously on frame rails from t = 0) into voiceSympathyPool!
        if (simTime - lastDampCheckSim >= 0.014) {
          lastDampCheckSim = simTime;
          const cVec = sim.data.contact;
          const seenPairs = new Set<string>();
          const dampingEvents: AudioDampingEvent[] = [];
          try {
            const ncon = cVec.size();
            for (let c = 0; c < ncon; c++) {
              const ct = cVec.get(c);
              try {
                const b1 = sim.model.geom_bodyid[ct.geom1];
                const b2 = sim.model.geom_bodyid[ct.geom2];
                if (b1 === b2 || (b1 <= 0 && b2 <= 0)) continue;
                const cKey = `${Math.min(b1, b2)}:${Math.max(b1, b2)}`;
                seenPairs.add(cKey);
                if (!pairStartSim.has(cKey)) pairStartSim.set(cKey, simTime);
                const cStart = pairStartSim.get(cKey)!;
                const durSec = simTime - cStart;
                if (durSec >= 0.035 && b1 > 0 && b2 > 0) {
                  const n1 = nodeById.get(nodeIdByBody.get(b1) ?? '');
                  const n2 = nodeById.get(nodeIdByBody.get(b2) ?? '');
                  const s1 = softnessOfNode(n1);
                  const s2 = softnessOfNode(n2);
                  const primaryB = s1 <= s2 ? b1 : b2;
                  const partnerB = s1 <= s2 ? b2 : b1;
                  const damperSoft = Math.max(s1, s2);
                  const primaryId = nodeIdByBody.get(primaryB);
                  const lastT = primaryId ? lastStrikeSim.get(primaryId) : undefined;
                  const isPostStrike = lastT !== undefined ? cStart > lastT + 0.060 : cStart > 0.060;
                  if (primaryId && damperSoft >= 0.45 && isPostStrike) {
                    const mTarget = Math.max(0.02, sim.model.body_mass[primaryB] || 0.15);
                    const rate = computeContactDampingRate(1.0, damperSoft, mTarget);
                    if (rate >= 0.6) {
                      dampingEvents.push({
                        nodeId: primaryId,
                        dampingNodeId: nodeIdByBody.get(partnerB),
                        normalForce: 1.0,
                        dampingRate: rate,
                        softness: damperSoft,
                        contactDurationSec: durSec,
                      });
                    }
                  }
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            cVec.delete();
          }
          for (const k of Array.from(pairStartSim.keys())) {
            if (!seenPairs.has(k)) pairStartSim.delete(k);
          }

          // Also feed continuous t=0 resting-mount / nodal-rail contacts on ALL 5 marimba bars every 14 ms
          // to prove `applyAudioDampingEvents` NEVER false-chokes resting bars even if rail events arrive!
          for (const barNote of ['c4', 'd4', 'e4', 'g4', 'a4']) {
            dampingEvents.push({
              nodeId: `marimba_bar_${barNote}`,
              dampingNodeId: 'marimba_frame',
              normalForce: 1.4,
              dampingRate: 18.0,
              softness: 0.65,
              contactDurationSec: simTime, // Touching continuously since t = 0!
              localPoint: [0, -0.052, -0.0085],
            });
          }

          applyAudioDampingEvents(harness.ctx, dampingEvents, nodes, simTime);
        }
      }

      // 1. Multiple marimba bars were struck cleanly, with ZERO untuned `mallet_*` stick self-thuds
      //    and ZERO unscheduled `steel_chime_c5` sag hits during the first 2.0 s!
      expect(strikeRecords.length).toBeGreaterThanOrEqual(4);
      expect(emittedImpactNodeIds.some((id) => id.startsWith('mallet_'))).toBe(false);
      expect(emittedImpactNodeIds.includes('steel_chime_c5')).toBe(false);

      // 2. Verify a struck marimba bar (`marimba_bar_c4`, struck at ~0.905 s and ringing alone through 2.0 s)
      //    is NOT choked at `t_hit + 0.25 s` despite 14 ms resting-rail AUDIO_DAMPING frames!
      const c4Strike = strikeRecords.find((r) => r.nodeId === 'marimba_bar_c4')!;
      expect(c4Strike).toBeDefined();

      // Re-run isolated lifecycle check on `marimba_bar_c4` to verify exact `t_hit + 0.25s` rosewood decay,
      // Euler-Bernoulli nodal selectivity (`ξ_bar = 0.2242`), and `t_hit + 0.45s` post-strike felt damper choke!
      silenceModalVoices(harness.ctx, 0);
      const c4Node = nodeById.get('marimba_bar_c4')!;
      const mallet1 = nodeById.get('mallet_1')!;
      const c4Profile = extractModalProfile(c4Node, true, nodes);
      const c4TwoBody = resolveTwoBodyImpact(c4Profile, c4Node, {
        impulseNs: 0.28,
        strikerNode: mallet1,
        selfGeomName: 'bar_body',
        strikerGeomName: 'mallet_head_0',
        localPoint: [0, -0.015, 0.0085],
        sceneNodes: nodes,
      });

      const tHit = 2.50;
      harness.ctx.currentTime = tHit;
      const c4Group = triggerOrMutateModalVoice({
        ctx: harness.ctx,
        outputBus: harness.bus,
        nodeId: c4Node.id,
        level: 0.26,
        tauC: c4TwoBody.tauC,
        brightness: c4TwoBody.effectiveBrightness,
        voices: c4TwoBody.voices,
        bodyIr: c4TwoBody.bodyIr,
        bodyIrSig: c4TwoBody.bodyIrSig,
        materialQ: c4Profile.material.qualityQ,
        modeVectors: c4Profile.modeVectors,
        lenAxis: c4Profile.lenAxis,
        lenBounds: c4Profile.lenBounds,
        strikeXi: c4TwoBody.strikeXi,
        simTime: tHit,
      })!;
      expect(c4Group).not.toBeNull();
      const naturalTau1 = c4Group.modes[0].tauSec;
      const peakAmp = c4Group.modes[0].peakGain;
      expect(naturalTau1).toBeGreaterThan(0.12);

      // Feed resting rail contacts (already touching since t = 0 -> contactDurationSec = t - 0) every 14 ms up to t_hit + 0.25s
      for (let dtStep = 0.014; dtStep <= 0.25; dtStep += 0.014) {
        const tCur = tHit + dtStep;
        harness.ctx.currentTime = tCur;
        applyAudioDampingEvents(
          harness.ctx,
          [
            {
              nodeId: c4Node.id,
              dampingNodeId: 'marimba_frame',
              normalForce: 1.6,
              dampingRate: 24.0,
              softness: 0.75,
              contactDurationSec: tCur, // Started at t = 0 <= tHit + 0.06s!
              localPoint: [0, 0, -0.0085], // Even at center antinode, pre-existing support NEVER chokes!
            },
          ],
          nodes,
          tCur,
        );
      }

      const tCheck250ms = tHit + 0.25;
      const ampAt250ms = evaluateModeAmplitudeAt(c4Group.modes[0], tCheck250ms);
      const expectedNaturalAmp =
        peakAmp * Math.exp(-(tCheck250ms - c4Group.modes[0].attackEndTime) / naturalTau1);
      expect(c4Group.modes[0].tauSec).toBeCloseTo(naturalTau1, 5);
      expect(ampAt250ms).toBeCloseTo(expectedNaturalAmp, 4);
      expect(ampAt250ms).toBeGreaterThan(peakAmp * 0.15); // Healthy natural rosewood sustain at +250 ms!

      // Post-strike touch right at the Euler-Bernoulli fundamental node (0.2242 * L from end -> y = +0.2758 * L)
      // ALSO preserves the fundamental mode!
      const [sLo, sHi] = c4Profile.lenBounds!;
      const barLen = sHi - sLo;
      const nodalY = 0.5 * (sLo + sHi) + (0.5 - 0.2242) * barLen;
      const tNodalTouch = tHit + 0.32;
      harness.ctx.currentTime = tNodalTouch + 0.04;
      applyAudioDampingEvents(
        harness.ctx,
        [
          {
            nodeId: c4Node.id,
            dampingNodeId: 'nodal_pin',
            normalForce: 0.8,
            dampingRate: 18.0,
            softness: 0.65,
            contactDurationSec: 0.04, // Started at tHit + 0.32 > tHit + 0.06, at nodal point!
            localPoint: [0, nodalY, -0.0085],
          },
        ],
        nodes,
        tNodalTouch + 0.04,
      );
      expect(c4Group.modes[0].tauSec).toBeGreaterThan(naturalTau1 * 0.85);

      // Genuine post-strike felt damper contact arriving at `t_contact = t_hit + 0.45 s` near bar antinode
      // MUST choke the ringing rosewood bar by > 85% within 0.15 s!
      const tContact = tHit + 0.45;
      const tEmitDamper = tContact + 0.036; // 36 ms sustained damper contact (`contactStartedAt = tContact > tHit + 0.06s`)
      harness.ctx.currentTime = tEmitDamper;
      const ampBeforeChoke = evaluateModeAmplitudeAt(c4Group.modes[0], tEmitDamper);
      expect(ampBeforeChoke).toBeGreaterThan(peakAmp * 0.04);

      applyAudioDampingEvents(
        harness.ctx,
        [
          {
            nodeId: c4Node.id,
            dampingNodeId: 'felt_damper_bar',
            normalForce: 2.8,
            dampingRate: computeContactDampingRate(2.8, 0.92, c4Profile.massKg ?? 0.14),
            softness: 0.92,
            contactDurationSec: 0.036,
            localPoint: [0, 0.01, 0.0085], // Antinode contact!
          },
        ],
        nodes,
        tEmitDamper,
      );

      const ampAfter150ms = evaluateModeAmplitudeAt(c4Group.modes[0], tEmitDamper + 0.15);
      expect(ampAfter150ms).toBeLessThan(ampBeforeChoke * 0.15); // > 85% choked within 0.15 s!
    } finally {
      silenceModalVoices(harness.ctx, 0);
      sim.dispose();
    }
  });
});
