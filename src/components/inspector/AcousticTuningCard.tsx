import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Music, Volume2, AlertTriangle } from 'lucide-react';
import type {
  AcousticBowSpec,
  AcousticMembraneSpec,
  MembraneMaterialId,
  NonlinearPlateSpec,
  ResonatorTubeSpec,
  SceneGraph,
  SceneNode,
  StringMaterialId,
  WindExciterKind,
} from '../../types/scene';
import { useStore } from '../../store/useStore';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';
import {
  estimateBodyModes,
  inferAcousticMaterial,
  playModalImpact,
  playModalTap,
  silenceBowedVoices,
  silenceWindVoices,
  unlockAudioContext,
  updateLiveBowedVoices,
  updateLiveWindVoices,
} from '../../utils/modalAudio';
import { simulate3DVibroAcousticIR } from '../../utils/solidAcoustics3D';
import { buildTunedScaleNodes, CONCERT_NOTES, hzToNoteInfo, noteToHz, tuneBodyToPitch } from '../../utils/acousticTuning';
import { analyzeSoundboxResonance, solveBowedStringVoice, STRING_MATERIALS } from '../../utils/stringAcoustics';
import { MEMBRANE_MATERIALS, solveMembraneImpact } from '../../utils/membraneAcoustics';
import { extractTubeAirColumn } from '../../utils/resonatorAcoustics';
import { solveVonKarmanPlateImpact } from '../../utils/nonlinearPlateAcoustics';
import {
  ACOUSTIC_ROLE_LABELS,
  applyAcousticRole,
  availableRoles,
  BOW_BETA_RANGE,
  BOW_FORCE_RANGE,
  BOW_REGIME_LABELS,
  BOW_SPEED_RANGE,
  bowPositionLabel,
  canToggleNonlinearPlate,
  canToggleResonatorTube,
  centredBowForce,
  defaultBowPreview,
  holdAcousticAudition,
  membraneReadout,
  releaseAcousticAudition,
  roleOf,
  safeStringSpec,
  safeWindSpec,
  stringLengthM,
  stringReadout,
  toBowedPayload,
  toggleNonlinearPlate,
  toggleResonatorTube,
  tuneNodeForRole,
  windBoreOf,
  windPitchReadout,
  WIND_EXCITER_LABELS,
  withBowSpec,
  type AcousticRole,
  type BowPreviewSettings,
} from '../../utils/acousticAuthoring';

function replaceNodeInTree(nodes: SceneNode[], targetId: string, next: SceneNode): SceneNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return next;
    if (n.children?.length) {
      const updatedChildren = replaceNodeInTree(n.children, targetId, next);
      if (updatedChildren !== n.children) return { ...n, children: updatedChildren };
    }
    return n;
  });
}

/** Every body in the scene but `exceptId`, for a "which body is the shell / bar" picker. */
function listBodies(nodes: SceneNode[], exceptId: string, out: { id: string; name: string }[] = []) {
  for (const n of nodes) {
    if (n.id !== exceptId && !n.isPulleyRope) out.push({ id: n.id, name: n.name || n.id });
    listBodies(n.children ?? [], exceptId, out);
  }
  return out;
}

/** Every hinge joint in the scene, for the tremolo-vane picker. */
function listHingeJoints(nodes: SceneNode[], out: { body: string; joint: string }[] = []) {
  for (const n of nodes) {
    for (const j of n.joints ?? []) if (j.type === 'hinge' && j.name) out.push({ body: n.name || n.id, joint: j.name });
    listHingeJoints(n.children ?? [], out);
  }
  return out;
}

function safeMembraneSpec(spec: AcousticMembraneSpec): AcousticMembraneSpec {
  const material: MembraneMaterialId =
    spec.material && spec.material in MEMBRANE_MATERIALS ? spec.material : 'coated_film';
  const tensionNPerM = Number.isFinite(spec.tensionNPerM) ? spec.tensionNPerM : 1800;
  const thicknessMm = Number.isFinite(spec.thicknessMm) ? spec.thicknessMm : 0.25;
  return {
    ...spec,
    material,
    tensionNPerM,
    thicknessMm,
  };
}

const selectClass =
  'w-full px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 cursor-pointer';
const labelClass = 'text-[9px] font-semibold uppercase tracking-wider text-slate-400';

/** A labelled slider row with its current value on the right. */
function Slider({
  label, value, shown, min, max, step, accent = 'accent-violet-500', onChange, title,
}: {
  label: string; value: number; shown?: string; min: number; max: number; step: number;
  accent?: string; onChange: (v: number) => void; title?: string;
}) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className="flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-slate-700 dark:text-slate-200">{shown ?? value}</span>
      </span>
      <RangeInput min={min} max={max} step={step} value={value} onChange={onChange} className={`w-full cursor-pointer ${accent}`} />
    </label>
  );
}

const auditionButtonClass =
  'flex items-center gap-1 px-2 py-0.5 rounded bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 border border-violet-200 dark:border-violet-800 text-[10px] font-semibold text-violet-700 dark:text-violet-300 cursor-pointer transition-colors select-none';

/**
 * Inverse Luthier & Structural Pitch Tuner ("Tune to Concert Pitch") and the
 * body's sound role:
 * - Struck solids (bars, chimes, blocks, plates): Euler–Bernoulli / Rayleigh–Ritz
 *   underside arch or length tuning, plus optional tube-resonator and
 *   nonlinear-crash switches.
 * - Taut strings (`acousticString`): Mersenne tension + gauge + coupled
 *   Helmholtz/soundboard resonance, with Pluck / Strike / Bow auditions.
 * - Wind bores (`windInstrument`: reed, brass lip, air jet, flap-valve): pitch
 *   read from the playable bore, not from the pipe wall's flexural tap.
 * - Acoustic bows (`acousticBow`) and tensioned membranes (`acousticMembrane`).
 */
export function AcousticTuningCard({ node }: { node: SceneNode }) {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const updateNode = useStore((s) => s.updateNode);

  const isEligible = useMemo(() => {
    if (node.hardwarePart || node.simulation) return false;
    return (node.geoms ?? []).some(
      (g) => g.type !== 'plane' && !g.csgDerived && g.csg !== 'difference',
    );
  }, [node]);

  const role = roleOf(node);
  const stringSpec = node.acousticString ? safeStringSpec(node.acousticString) : null;
  const windSpec = node.windInstrument ? safeWindSpec(node.windInstrument) : null;
  const membraneSpec = node.acousticMembrane ? safeMembraneSpec(node.acousticMembrane) : null;

  const stringEval = useMemo(
    () => (node.acousticString ? stringReadout(node, sceneGraph.nodes) : null),
    [node, sceneGraph.nodes],
  );

  const windBore = useMemo(() => windBoreOf(node), [node]);

  const membraneEval = useMemo(
    () => (node.acousticMembrane ? membraneReadout(node, sceneGraph.nodes) : null),
    [node, sceneGraph.nodes],
  );

  const tubeColumn = useMemo(() => {
    if (!node.resonatorTube) return null;
    try {
      return extractTubeAirColumn(node);
    } catch {
      return null;
    }
  }, [node]);

  const soundboxInfo = useMemo(() => {
    if (!isEligible || node.acousticString) return null;
    const info = analyzeSoundboxResonance(node);
    return info.hasHollowCavity ? info : null;
  }, [isEligible, node]);

  const roles = useMemo(() => (isEligible ? availableRoles(node) : []), [isEligible, node]);
  const plateAllowed = useMemo(() => (isEligible ? canToggleNonlinearPlate(node) : false), [isEligible, node]);
  const tubeAllowed = useMemo(() => (isEligible ? canToggleResonatorTube(node) : false), [isEligible, node]);

  /** The pitch this role actually plays: a wind body's from its bore, a drum head's from its tension. */
  const readout = useMemo(() => {
    if (!isEligible) return null;
    if (stringEval) {
      return { fundamentalHz: stringEval.profile.fundamentalHz, overtoneRatio: stringEval.profile.overtoneRatio, regime: stringEval.profile.regime };
    }
    if (node.windInstrument && windBore) {
      const w = windPitchReadout(node.windInstrument, windBore);
      return { fundamentalHz: w.pitchHz, overtoneRatio: w.overtoneRatio, regime: 'tube' as const };
    }
    if (membraneEval) {
      return { fundamentalHz: membraneEval.profile.fundamentalHz, overtoneRatio: membraneEval.overtoneRatio, regime: 'plate' as const };
    }
    if (tubeColumn && node.resonatorTube) {
      const fallbackRatio = tubeColumn.endCondition === 'open_open' ? 2 : 3;
      const ratio =
        tubeColumn.overtonesHz[1] && tubeColumn.fundamentalHz > 0
          ? tubeColumn.overtonesHz[1] / tubeColumn.fundamentalHz
          : fallbackRatio;
      return { fundamentalHz: tubeColumn.fundamentalHz, overtoneRatio: ratio, regime: 'tube' as const };
    }
    const p = estimateBodyModes(node);
    return { fundamentalHz: p.fundamentalHz, overtoneRatio: p.overtoneRatio, regime: p.regime };
  }, [isEligible, node, stringEval, windBore, membraneEval, tubeColumn]);

  const currentNote = useMemo(() => (readout ? hzToNoteInfo(readout.fundamentalHz) : null), [readout]);

  // ---- Bow audition preview (Starter #6b) --------------------------------
  const bowDefaults = useMemo(
    () => (node.acousticString ? defaultBowPreview(node, sceneGraph.nodes) : null),
    [node, sceneGraph.nodes],
  );
  const [bowState, setBowState] = useState<{ id: string; settings: BowPreviewSettings } | null>(null);
  const bow: BowPreviewSettings | null = bowState && bowState.id === node.id ? bowState.settings : bowDefaults;
  const bowPreview = useMemo(
    () =>
      node.acousticString && bow
        ? solveBowedStringVoice({
            node,
            sceneNodes: sceneGraph.nodes,
            bowVelocityMps: bow.velocityMps,
            bowForceN: bow.forceN,
            bowBeta: bow.beta,
          })
        : null,
    [node, sceneGraph.nodes, bow],
  );
  const [bowActiveId, setBowActiveId] = useState<string | null>(null);
  const bowActive = bowActiveId === node.id;
  const bowStartedAtRef = useRef(0);
  const bowStopTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const windTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bowActiveRef = useRef(false);
  const windActiveRef = useRef(false);

  const [targetNote, setTargetNote] = useState<string>('A4');
  const [drillNodalHole, setDrillNodalHole] = useState<boolean>(false);
  const [summaryState, setSummaryState] = useState<{ id: string; text: string } | null>(null);
  const summary = summaryState && summaryState.id === node.id ? summaryState.text : null;
  const setSummary = useCallback(
    (text: string | null) => {
      setSummaryState(text === null ? null : { id: node.id, text });
    },
    [node.id],
  );

  const setBow = useCallback(
    (patch: Partial<BowPreviewSettings>) => {
      if (!bow) return;
      setBowState({ id: node.id, settings: { ...bow, ...patch } });
    },
    [bow, node.id],
  );

  const endBow = useCallback(() => {
    if (!bowActiveRef.current) return;
    if (bowStopTimerRef.current) clearTimeout(bowStopTimerRef.current);
    // A tap on the button still gets a note you can hear.
    const wait = Math.max(0, 450 - (performance.now() - bowStartedAtRef.current));
    bowStopTimerRef.current = setTimeout(() => {
      bowActiveRef.current = false;
      setBowActiveId(null);
      silenceBowedVoices();
      releaseAcousticAudition();
    }, wait);
  }, []);

  const startBow = useCallback(() => {
    unlockAudioContext();
    if (bowStopTimerRef.current) clearTimeout(bowStopTimerRef.current);
    bowStartedAtRef.current = performance.now();
    bowActiveRef.current = true;
    holdAcousticAudition(1500);
    setBowActiveId(node.id);
  }, [node.id]);

  // While a Bow audition is held, every slider move re-solves and restreams the voice.
  useEffect(() => {
    if (!bowActive || !bowPreview) return;
    updateLiveBowedVoices([toBowedPayload(node.id, bowPreview)]);
    holdAcousticAudition(1500);
    const keepAlive = setInterval(() => holdAcousticAudition(1500), 500);
    return () => clearInterval(keepAlive);
  }, [bowActive, bowPreview, node.id]);

  // Leaving the card (or selecting another body) ends every audition it started.
  useEffect(() => {
    return () => {
      if (bowStopTimerRef.current) clearTimeout(bowStopTimerRef.current);
      if (windTimerRef.current) clearTimeout(windTimerRef.current);
      if (bowActiveRef.current) {
        bowActiveRef.current = false;
        setBowActiveId(null);
        silenceBowedVoices();
      }
      if (windActiveRef.current) {
        windActiveRef.current = false;
        silenceWindVoices();
      }
      setSummaryState(null);
      releaseAcousticAudition();
    };
  }, [node.id]);

  if (!isEligible || !readout || !currentNote) return null;

  // ---- Auditions ------------------------------------------------------------
  const handleBlow = () => {
    if (!windBore || !windSpec) return;
    unlockAudioContext();
    const windIr = simulate3DVibroAcousticIR(node, inferAcousticMaterial(node));
    updateLiveWindVoices([
      {
        id: node.id,
        exciter: windSpec.exciter,
        breathKPa: Math.max(3.5, windSpec.breathKPa || 3.8),
        embouchureHz: windSpec.embouchureHz,
        bodyIr: windIr?.ir ?? null,
        bodyIrSig: windIr?.signature ?? '',
        boreShape: windBore.boreShape,
        resonantModesHz: windBore.resonantModesHz,
        modeImpedancePeaks: windBore.modeImpedancePeaks,
        impedanceGrid: windBore.impedanceGrid,
        muteFactor: windBore.muteFactor,
        breachFactor: windBore.breachFactor,
        mouthRadiusM: windBore.mouthRadiusM,
        bellRadiusM: windBore.bellRadiusM,
        cellCount: windBore.cellCount,
        exactCells: windBore.exactCells,
        junctionK: windBore.junctionK,
        bellCutoffHz: windBore.bellCutoffHz,
        shunts: windBore.toneholes
          .filter((t) => t.openAmount > 0.05)
          .map((t) => ({ cell: t.cellIndex, coeff: t.shuntCoeff * t.openAmount })),
      },
    ]);
    windActiveRef.current = true;
    holdAcousticAudition(1200);
    if (windTimerRef.current) clearTimeout(windTimerRef.current);
    windTimerRef.current = setTimeout(() => {
      windActiveRef.current = false;
      silenceWindVoices();
      releaseAcousticAudition();
    }, 850);
  };

  const playMembraneAudition = (
    res: NonNullable<ReturnType<typeof solveMembraneImpact>>,
    impulseNs: number,
  ) => {
    const glideFrac = res.pitchGlide.initialRatio > 0.0004 ? res.pitchGlide.initialRatio : undefined;
    const glideTau = glideFrac ? res.pitchGlide.glideTauSec : undefined;
    const voices = res.voices.map((v) => ({
      ...v,
      ...(glideFrac !== undefined ? { pitchDroopFrac: glideFrac, pitchDroopTauSec: glideTau } : {}),
    }));
    playModalImpact(res.evaluation.profile, impulseNs, false, {
      tauC: res.tauC,
      effectiveBrightness: res.effectiveBrightness,
      radiationScale: res.radiationScale,
      voices,
      bodyIr: res.bodyIr,
      ...(res.snareRattle
        ? {
            snare: {
              gain: res.snareRattle.gain,
              decaySec: res.snareRattle.decaySec,
              centerHz: res.snareRattle.bandpassHz,
            },
          }
        : {}),
    });
  };

  const handleMembraneStrike = (impulseNs: number) => {
    unlockAudioContext();
    const res = solveMembraneImpact(node, sceneGraph.nodes, { impulseNs });
    if (!res) return;
    playMembraneAudition(res, impulseNs);
  };

  const handleRingTube = () => {
    if (!tubeColumn) return;
    unlockAudioContext();
    const f0 = tubeColumn.fundamentalHz;
    const fallbackRatio = tubeColumn.endCondition === 'open_open' ? 2 : 3;
    const partials = (tubeColumn.overtonesHz.length > 0 ? tubeColumn.overtonesHz : [f0]).slice(0, 6);
    playModalImpact(
      {
        fundamentalHz: f0,
        overtoneRatio: partials[1] && f0 > 0 ? partials[1] / f0 : fallbackRatio,
        regime: 'tube',
        material: { label: 'Air column', density: 1.2, modulusGPa: 0.0001, qualityQ: tubeColumn.qualityQ, brightness: 0.4 },
        contactDurationSec: 0.0007,
        modes: partials.map((freqHz, k) => ({ freqHz, gain: +(0.8 / Math.pow(k + 1, 1.2)).toFixed(3), decaySec: +(1.4 / (1 + 0.4 * k)).toFixed(3) })),
      },
      0.3,
      true,
    );
  };

  const handleCrash = () => {
    unlockAudioContext();
    const prof = estimateBodyModes(node, true);
    const impulseNs = 2.2;
    const env = solveVonKarmanPlateImpact(prof, node, impulseNs, prof.contactDurationSec);
    type ImpactOverride = NonNullable<Parameters<typeof playModalImpact>[3]>;
    let voices: ImpactOverride['voices'] = prof.modes.map((v) => ({ ...v }));
    let crashShimmer: ImpactOverride['crashShimmer'];
    if (env?.active) {
      voices = voices.map((v) => ({
        ...v,
        decaySec: +Math.max(0.020, v.decaySec * env.lowModeDecayScale).toFixed(4),
        ...(Math.abs(env.pitchGlideRatio) > 0.0005
          ? {
              pitchDroopFrac: env.pitchGlideRatio,
              pitchDroopTauSec: env.glideTauSec,
            }
          : {}),
      }));
      for (const cv of env.cascadeVoices) {
        voices.push({
          freqHz: cv.freqHz,
          gain: cv.peakGain,
          decaySec: cv.decaySec,
          bloomDelaySec: +(cv.bloomAttackSec * 0.25).toFixed(4),
          bloomAttackSec: +(cv.bloomAttackSec * 0.75).toFixed(4),
          ...(Math.abs(env.pitchGlideCents) > 1
            ? {
                pitchGlideCents: +(env.pitchGlideCents * 0.65).toFixed(2),
                pitchDroopTauSec: env.glideTauSec,
              }
            : {}),
        });
      }
      if (env.shimmerPeakGain > 0.005) {
        crashShimmer = {
          gain: env.shimmerPeakGain,
          bloomSec: env.shimmerBloomSec,
          decaySec: env.shimmerDecaySec,
          highpassHz: Math.max(1800, Math.round(env.shimmerBandHz * 0.65)),
        };
      }
    }
    playModalImpact(prof, impulseNs, false, {
      tauC: prof.contactDurationSec,
      effectiveBrightness: prof.material.brightness,
      radiationScale: 1.15,
      voices,
      bodyIr: prof.bodyIr,
      ...(crashShimmer ? { crashShimmer } : {}),
    });
  };

  const handleAudition = () => {
    unlockAudioContext();
    if (windBore && node.windInstrument) {
      handleBlow();
      return;
    }
    if (node.acousticMembrane) {
      handleMembraneStrike(0.35);
      return;
    }
    if (stringEval) {
      playModalImpact(stringEval.profile, 0.35, true);
      return;
    }
    if (node.resonatorTube && tubeColumn) {
      handleRingTube();
      return;
    }
    playModalTap(node);
  };

  // ---- Edits ----------------------------------------------------------------
  const writeNode = (next: SceneNode) => {
    const state = useStore.getState();
    state.updateScene({
      ...state.sceneGraph,
      nodes: replaceNodeInTree(state.sceneGraph.nodes, node.id, next),
    });
  };

  const handleRoleChange = (next: AcousticRole) => {
    if (next === role) return;
    setSummary(null);
    const state = useStore.getState();
    writeNode(applyAcousticRole(node, next, { sceneNodes: state.sceneGraph.nodes, targetHz: noteToHz(targetNote) ?? 261.63 }));
  };

  const handleTune = () => {
    const hz = noteToHz(targetNote) ?? 440;
    const state = useStore.getState();
    const res = tuneNodeForRole(node, hz, { sceneNodes: state.sceneGraph.nodes, drillNodalHole });
    const nextNodes = replaceNodeInTree(state.sceneGraph.nodes, node.id, res.node);
    const nextGraph: SceneGraph = { ...state.sceneGraph, nodes: nextNodes };
    state.updateScene(nextGraph);

    if (res.node.acousticString) {
      const afterEval = stringReadout(res.node, nextNodes);
      if (afterEval) {
        setSummary(
          `Tuned string to ${targetNote} (${afterEval.fundamentalHz.toFixed(1)} Hz) at ${res.node.acousticString.tensionN} N (${res.node.acousticString.diameterMm} mm)`,
        );
        playModalImpact(afterEval.profile, 0.35, true);
      }
      return;
    }
    if (res.node.windInstrument) {
      const bore = windBoreOf(res.node);
      const w = bore ? windPitchReadout(res.node.windInstrument, bore) : null;
      setSummary(
        w
          ? `Tuned ${WIND_EXCITER_LABELS[res.node.windInstrument.exciter] ?? 'bore'} to ${targetNote} (${w.pitchHz.toFixed(1)} Hz); press Blow to hear it`
          : `Tuned bore toward ${targetNote}`,
      );
      return;
    }
    setSummary(res.summary ?? `Tuned toward ${targetNote}`);
    if (res.node.acousticMembrane) {
      const res2 = solveMembraneImpact(res.node, nextNodes, { impulseNs: 0.35 });
      if (res2) {
        playMembraneAudition(res2, 0.35);
      }
      return;
    }
    if (!res.node.resonatorTube) playModalTap(res.node);
  };

  const handleSpawnScale = () => {
    const clones = buildTunedScaleNodes(node, targetNote, 'pentatonic').slice(1);
    if (clones.length === 0) return;
    const rootTuned = tuneBodyToPitch(node, noteToHz(targetNote) ?? 440, { drillNodalHole }).node;
    const state = useStore.getState();
    const updatedRoots = replaceNodeInTree(state.sceneGraph.nodes, node.id, rootTuned);
    const nextGraph: SceneGraph = {
      ...state.sceneGraph,
      nodes: [...updatedRoots, ...clones],
    };
    state.updateScene(nextGraph);
    setSummary(`Built 5-note pentatonic set from ${targetNote}`);
    playModalTap(rootTuned);
  };

  const patchString = (patch: Partial<NonNullable<SceneNode['acousticString']>>) => {
    if (!stringSpec) return;
    updateNode(node.id, { acousticString: { ...stringSpec, ...patch } });
  };

  const patchWind = (patch: Partial<NonNullable<SceneNode['windInstrument']>>) => {
    if (!windSpec) return;
    updateNode(node.id, { windInstrument: { ...(node.windInstrument ?? windSpec), ...windSpec, ...patch } });
  };

  const patchMembrane = (patch: Partial<AcousticMembraneSpec>) => {
    if (!membraneSpec) return;
    updateNode(node.id, { acousticMembrane: { ...membraneSpec, ...patch } });
  };

  const patchTube = (patch: Partial<ResonatorTubeSpec>) => {
    updateNode(node.id, { resonatorTube: { ...(node.resonatorTube ?? {}), ...patch } });
  };

  const patchPlate = (patch: Partial<NonlinearPlateSpec>) => {
    updateNode(node.id, { nonlinearPlate: { ...(node.nonlinearPlate ?? { enabled: true }), ...patch } });
  };

  const patchBow = (patch: Partial<AcousticBowSpec>) => {
    const spec: AcousticBowSpec = { ...(node.acousticBow ?? {}), ...patch };
    const next = withBowSpec(node, spec);
    updateNode(node.id, { acousticBow: next.acousticBow, geoms: next.geoms });
  };

  const centsLabel =
    currentNote.cents === 0
      ? 'in tune'
      : `${currentNote.cents > 0 ? '+' : ''}${currentNote.cents}¢`;

  const headerTitle =
    role === 'wind' ? 'Wind Bore & Reed'
    : role === 'string' ? 'Taut String Pitch'
    : role === 'membrane' ? 'Drum Head Pitch'
    : role === 'bow' ? 'Acoustic Bow'
    : node.resonatorTube ? 'Tube Resonator'
    : 'Concert Pitch';

  const headerButton =
    role === 'wind' ? { label: 'Blow', title: 'Blow a test note through this 3D bore waveguide' }
    : role === 'membrane' ? { label: 'Strike', title: 'Strike this drum head with a virtual stick' }
    : role === 'solid' && node.resonatorTube ? { label: 'Ring', title: 'Excite the standing-wave air column of this tube' }
    : role === 'solid' ? { label: 'Tap', title: 'Strike this body with a virtual mallet' }
    : null;

  const wedge = bowPreview && bowPreview.fMax > 0 ? `${bowPreview.fMin.toFixed(2)}–${bowPreview.fMax.toFixed(2)} N` : '—';
  const regimeClass =
    bowPreview?.regime === 'helmholtz' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
    : bowPreview?.regime === 'flautando' ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200'
    : bowPreview?.regime === 'raucous' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
    : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';

  const bodyChoices = listBodies(sceneGraph.nodes, node.id).slice(0, 80);
  const hingeChoices = listHingeJoints(sceneGraph.nodes).slice(0, 80);
  const membraneMat = membraneSpec ? MEMBRANE_MATERIALS[membraneSpec.material] ?? MEMBRANE_MATERIALS.mylar : null;

  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-1.5">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <Music className="w-3.5 h-3.5 text-violet-500" />
          {headerTitle}
          <DocsInfoButton tab="sound" />
        </h3>
        {headerButton && (
          <button type="button" onClick={handleAudition} className={auditionButtonClass} title={headerButton.title}>
            <Volume2 className="w-3 h-3" /> {headerButton.label}
          </button>
        )}
      </div>

      {roles.length > 1 && (
        <label className="flex flex-col gap-0.5">
          <span className={labelClass}>Sound role</span>
          <select
            value={role}
            onChange={(e) => handleRoleChange(e.target.value as AcousticRole)}
            className={selectClass}
            aria-label="Sound role"
          >
            {roles.map((r) => (
              <option key={r} value={r}>{ACOUSTIC_ROLE_LABELS[r]}</option>
            ))}
          </select>
        </label>
      )}

      <div className="flex items-baseline justify-between text-xs bg-slate-50 dark:bg-slate-800/60 rounded px-2 py-1.5">
        <div>
          <span className="font-bold text-slate-800 dark:text-slate-100">{currentNote.note}</span>{' '}
          <span className="text-[10px] text-slate-500 dark:text-slate-400">({centsLabel})</span>
        </div>
        <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
          {readout.fundamentalHz.toFixed(1)} Hz · f₂/f₁ {readout.overtoneRatio.toFixed(2)}
        </div>
      </div>

      {role === 'wind' && windBore && windSpec && (
        <div className="flex flex-col gap-1.5 text-[10px] bg-sky-50/70 dark:bg-sky-950/30 border border-sky-200/70 dark:border-sky-800/50 rounded px-2 py-1.5 text-sky-900 dark:text-sky-200">
          <div className="flex justify-between">
            <span>
              Bore <b>{windBore.boreShape.replace('_', ' ')}</b> ({(windBore.lengthM * 1000).toFixed(0)} mm · {windBore.cellCount} cells)
            </span>
            <span>Bell {windBore.bellCutoffHz.toFixed(0)} Hz</span>
          </div>
          <div>
            Impedance modes: <b>{windBore.resonantModesHz.slice(0, 4).map((f) => `${hzToNoteInfo(f).note} (${f.toFixed(0)})`).join(' · ')}</b>
          </div>
          {((windBore.muteFactor ?? 0) > 0.04 || windBore.toneholes.some((t) => t.fromGeometry)) && (
            <div className="flex flex-wrap gap-1.5 text-[10px] font-medium text-amber-800 dark:text-amber-300">
              {windBore.toneholes.some((t) => t.fromGeometry) && (
                <span className="px-1.5 py-0.5 rounded bg-amber-100/80 dark:bg-amber-900/40">
                  {windBore.toneholes.filter((t) => t.fromGeometry).length} open wall vent(s)
                </span>
              )}
              {(windBore.muteFactor ?? 0) > 0.04 && (
                <span className="px-1.5 py-0.5 rounded bg-amber-100/80 dark:bg-amber-900/40">
                  Bell muted {Math.round((windBore.muteFactor ?? 0) * 100)}%
                </span>
              )}
            </div>
          )}
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>Exciter</span>
            <select
              value={windSpec.exciter}
              onChange={(e) => {
                const exciter = e.target.value as WindExciterKind;
                const flap = exciter === 'flap_valve';
                const emb = Math.max(flap ? 24 : 120, Math.min(flap ? 320 : 1100, windSpec.embouchureHz));
                patchWind({ exciter, embouchureHz: emb });
              }}
              className={selectClass}
              aria-label="Wind exciter"
            >
              {(Object.keys(WIND_EXCITER_LABELS) as WindExciterKind[]).map((k) => (
                <option key={k} value={k}>{WIND_EXCITER_LABELS[k]}</option>
              ))}
            </select>
          </label>
          <Slider
            label="Blowing pressure"
            value={windSpec.breathKPa}
            shown={windSpec.breathKPa <= 0 ? 'silent (scripted / wind)' : `${windSpec.breathKPa.toFixed(1)} kPa`}
            min={0}
            max={7}
            step={0.1}
            accent="accent-sky-500"
            title="0 kPa is silent until a script, bellows or ambient wind drives it; above 0 it sounds continuously on Play."
            onChange={(v) => patchWind({ breathKPa: v })}
          />
          <Slider
            label={windSpec.exciter === 'flap_valve' ? 'Flap frequency' : 'Embouchure / lip tension'}
            value={windSpec.embouchureHz}
            shown={`${windSpec.embouchureHz.toFixed(0)} Hz`}
            min={windSpec.exciter === 'flap_valve' ? 24 : 120}
            max={windSpec.exciter === 'flap_valve' ? 320 : 1100}
            step={windSpec.exciter === 'flap_valve' ? 1 : 5}
            accent="accent-sky-500"
            onChange={(v) => patchWind({ embouchureHz: v })}
          />
        </div>
      )}

      {role === 'bow' && node.acousticBow && (
        <div className="flex flex-col gap-1.5 text-[10px] bg-amber-50/60 dark:bg-amber-950/20 border border-amber-200/70 dark:border-amber-800/50 rounded px-2 py-1.5">
          <div className="text-slate-600 dark:text-slate-300 leading-snug">
            Drawn across a taut string by a joint or script, this body excites Helmholtz stick-slip. Its first solid geom is given damped horsehair contact.
          </div>
          <Slider
            label="Rosin friction μ"
            value={node.acousticBow.rosinFriction ?? 0.38}
            shown={(node.acousticBow.rosinFriction ?? 0.38).toFixed(2)}
            min={0.2}
            max={0.65}
            step={0.01}
            accent="accent-amber-500"
            onChange={(v) => patchBow({ rosinFriction: v })}
          />
          <Slider
            label="Hair width"
            value={node.acousticBow.hairWidthMm ?? 9}
            shown={`${(node.acousticBow.hairWidthMm ?? 9).toFixed(0)} mm`}
            min={3}
            max={18}
            step={1}
            accent="accent-amber-500"
            onChange={(v) => patchBow({ hairWidthMm: v })}
          />
          <Slider
            label="Rosin grip"
            value={node.acousticBow.rosinGrip ?? 1}
            shown={(node.acousticBow.rosinGrip ?? 1).toFixed(2)}
            min={0.2}
            max={2}
            step={0.05}
            accent="accent-amber-500"
            onChange={(v) => patchBow({ rosinGrip: v })}
          />
          <Slider
            label="Force scale"
            value={node.acousticBow.forceScale ?? 1}
            shown={`×${(node.acousticBow.forceScale ?? 1).toFixed(2)}`}
            min={0.25}
            max={3}
            step={0.05}
            accent="accent-amber-500"
            onChange={(v) => patchBow({ forceScale: v })}
          />
        </div>
      )}

      {role === 'membrane' && membraneSpec && membraneMat && (
        <div className="flex flex-col gap-1.5 text-[10px] bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200/70 dark:border-rose-800/50 rounded px-2 py-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className={labelClass}>Head</span>
              <select
                value={membraneSpec.material}
                onChange={(e) => patchMembrane({ material: e.target.value as MembraneMaterialId })}
                className={selectClass}
                aria-label="Head material"
              >
                {Object.values(MEMBRANE_MATERIALS).map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className={labelClass}>Shape</span>
              <select
                value={membraneSpec.shape ?? ''}
                onChange={(e) => patchMembrane({ shape: (e.target.value || undefined) as AcousticMembraneSpec['shape'] })}
                className={selectClass}
                aria-label="Head shape"
              >
                <option value="">Auto from geometry</option>
                <option value="circular">Circular</option>
                <option value="rectangular">Rectangular</option>
              </select>
            </label>
          </div>
          <Slider
            label="Tension"
            value={Math.max(15, Math.min(75000, membraneSpec.tensionNPerM))}
            shown={`${membraneSpec.tensionNPerM.toFixed(0)} N/m${membraneEval ? ` (${Math.round(membraneEval.stressRatio * 100)}% yield)` : ''}`}
            min={15}
            max={75000}
            step={10}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ tensionNPerM: v })}
          />
          <Slider
            label="Thickness"
            value={Math.max(0.05, Math.min(2.0, membraneSpec.thicknessMm))}
            shown={`${membraneSpec.thicknessMm.toFixed(2)} mm`}
            min={0.05}
            max={2.0}
            step={0.01}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ thicknessMm: v })}
          />
          <label className="flex flex-col gap-0.5">
            <span className={labelClass}>Kettle / shell body</span>
            <select
              value={membraneSpec.shellNodeId ?? ''}
              onChange={(e) => patchMembrane({ shellNodeId: e.target.value || undefined })}
              className={selectClass}
              aria-label="Shell body"
            >
              <option value="">Auto-detect</option>
              {bodyChoices.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </label>
          <Slider
            label="Kettle air coupling"
            value={membraneSpec.kettleCoupling ?? 0.6}
            shown={(membraneSpec.kettleCoupling ?? 0.6).toFixed(2)}
            min={0}
            max={1}
            step={0.01}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ kettleCoupling: v })}
          />
          <Slider
            label="Snare buzz"
            value={membraneSpec.snareBuzz ?? 0}
            shown={(membraneSpec.snareBuzz ?? 0).toFixed(2)}
            min={0}
            max={1}
            step={0.01}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ snareBuzz: v })}
          />
          <Slider
            label="Hard-strike pitch drop"
            value={membraneSpec.pitchGlideSemitones ?? membraneEval?.pitchGlide.semitones ?? 0}
            shown={`${(membraneSpec.pitchGlideSemitones ?? membraneEval?.pitchGlide.semitones ?? 0).toFixed(2)} st`}
            min={0}
            max={4}
            step={0.05}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ pitchGlideSemitones: v })}
          />
          <Slider
            label="Glide decay"
            value={membraneSpec.pitchGlideDecayMs ?? 90}
            shown={`${(membraneSpec.pitchGlideDecayMs ?? 90).toFixed(0)} ms`}
            min={20}
            max={250}
            step={5}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ pitchGlideDecayMs: v })}
          />
          <Slider
            label="Nonlinear glide"
            value={membraneSpec.nonlinearGlide ?? 1}
            shown={`×${(membraneSpec.nonlinearGlide ?? 1).toFixed(2)}`}
            min={0}
            max={2}
            step={0.05}
            accent="accent-rose-500"
            onChange={(v) => patchMembrane({ nonlinearGlide: v })}
          />
          {membraneEval && (
            <div className="text-slate-500 dark:text-slate-400 leading-snug">
              {membraneEval.shape} head ·{' '}
              {membraneEval.hasShellCavity
                ? `${membraneEval.isClosedKettle ? 'closed kettle' : 'vented shell'} ${membraneEval.shellVolumeLitres.toFixed(1)} L`
                : 'no shell cavity'}{' '}
              · modes 1 : {membraneEval.modeRatios.slice(1, 4).map((r) => r.toFixed(2)).join(' : ')}
            </div>
          )}
          {membraneEval?.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
          <div className="flex gap-1.5">
            <button type="button" className={auditionButtonClass} onClick={() => handleMembraneStrike(0.35)}>
              <Volume2 className="w-3 h-3" /> Tap
            </button>
            <button type="button" className={auditionButtonClass} onClick={() => handleMembraneStrike(1.4)} title="A hard strike: hear the tension-modulation pitch drop">
              <Volume2 className="w-3 h-3" /> Hard
            </button>
          </div>
        </div>
      )}

      {soundboxInfo && (
        <div className="text-[10px] bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/50 rounded px-2 py-1 text-amber-800 dark:text-amber-200 leading-snug">
          Soundbox cavity <b>{soundboxInfo.cavityVolumeLitres} L</b>
          {soundboxInfo.helmholtzHz !== null
            ? <> · Helmholtz air <b>{soundboxInfo.helmholtzHz} Hz</b> · Top plate <b>{soundboxInfo.topPlateHz} Hz</b></>
            : <> (sealed — cut a cylinder soundhole for Helmholtz air resonance)</>}
        </div>
      )}

      {stringEval && stringSpec && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className={labelClass}>Wire</span>
              <select
                value={stringSpec.material}
                onChange={(e) => patchString({ material: e.target.value as StringMaterialId })}
                className={selectClass}
              >
                {Object.values(STRING_MATERIALS).map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className={labelClass}>Gauge ({stringSpec.diameterMm.toFixed(2)} mm)</span>
              <RangeInput
                min="0.14"
                max="2.45"
                step="0.02"
                value={Math.max(0.14, Math.min(2.45, stringSpec.diameterMm))}
                onChange={(v) => patchString({ diameterMm: v })}
                className="w-full accent-violet-500 cursor-pointer mt-1.5"
              />
            </label>
          </div>

          <div className="flex flex-col gap-0.5">
            <label className="text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
              <span>Tension T</span>
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {stringSpec.tensionN.toFixed(1)} N ({Math.round(stringEval.stressRatio * 100)}% σ_ult)
              </span>
            </label>
            <RangeInput
              min="2"
              max="280"
              step="0.5"
              value={Math.max(2, Math.min(280, stringSpec.tensionN))}
              onChange={(v) => {
                const kPerp = +(4 * v / stringLengthM(node)).toFixed(1);
                const nextJoints = (node.joints ?? []).map((j, idx) =>
                  idx === 0 && j.type === 'slide' ? { ...j, stiffness: kPerp } : j,
                );
                updateNode(node.id, {
                  joints: nextJoints,
                  acousticString: { ...stringSpec, tensionN: v },
                });
              }}
              className="w-full accent-violet-500 cursor-pointer"
            />
          </div>

          <Slider
            label="Pluck position x/L"
            value={stringSpec.pluckPos ?? 0.2}
            shown={`${(stringSpec.pluckPos ?? 0.2).toFixed(2)} ${(stringSpec.pluckPos ?? 0.2) < 0.12 ? '(bright)' : (stringSpec.pluckPos ?? 0.2) > 0.35 ? '(warm)' : ''}`}
            min={0.05}
            max={0.5}
            step={0.01}
            onChange={(v) => patchString({ pluckPos: v })}
          />

          <label className="flex items-center justify-between text-[10px] text-slate-600 dark:text-slate-300 cursor-pointer">
            <span title="Kirchhoff–Carrier tension modulation: a hard pluck starts sharp and settles flat">Nonlinear pitch droop on hard plucks</span>
            <input
              type="checkbox"
              checked={stringSpec.nonlinearPitchDroop !== false && stringSpec.nonlinearPitchDroop !== 0}
              onChange={(e) => patchString({ nonlinearPitchDroop: e.target.checked })}
            />
          </label>

          {stringEval.soundbox && (
            <div className="text-[10px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded px-2 py-1">
              Coupled to <b>{stringEval.soundbox.hostName}</b>
              {stringEval.soundbox.helmholtzHz !== null
                ? ` · Helmholtz ${stringEval.soundbox.helmholtzHz} Hz · Plate ${stringEval.soundbox.topPlateHz} Hz`
                : ` · Plate ${stringEval.soundbox.topPlateHz} Hz`}
            </div>
          )}

          {stringEval.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/60 rounded px-2 py-1 leading-snug"
            >
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}

          <div className="flex flex-col gap-1.5 border-t border-slate-100 dark:border-slate-800 pt-1.5">
            <div className="flex items-center gap-1.5">
              <span className={labelClass}>Audition</span>
              <button
                type="button"
                className={auditionButtonClass}
                onClick={() => { unlockAudioContext(); playModalImpact(stringEval.profile, 0.35, true); }}
                title="Pluck: plectrum release with the pluck-position comb and the soundbox response"
              >
                <Volume2 className="w-3 h-3" /> Pluck
              </button>
              <button
                type="button"
                className={auditionButtonClass}
                onClick={() => { unlockAudioContext(); playModalImpact(stringEval.profile, 0.35, false); }}
                title="Strike: a hammer blow on the wire"
              >
                <Volume2 className="w-3 h-3" /> Strike
              </button>
              <button
                type="button"
                className={`${auditionButtonClass} ${bowActive ? 'ring-1 ring-violet-400 bg-violet-100 dark:bg-violet-900/60' : ''}`}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); startBow(); }}
                onPointerUp={endBow}
                onPointerCancel={endBow}
                onLostPointerCapture={endBow}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                    e.preventDefault();
                    startBow();
                    if (bowStopTimerRef.current) clearTimeout(bowStopTimerRef.current);
                    bowStopTimerRef.current = setTimeout(endBow, 1100);
                  }
                }}
                title="Bow: hold for a sustained Helmholtz stick-slip note; move the sliders while it sounds"
                aria-pressed={bowActive}
              >
                <Volume2 className="w-3 h-3" /> Bow
              </button>
            </div>

            {bow && bowPreview && (
              <div className="flex flex-col gap-1 bg-slate-50 dark:bg-slate-800/50 rounded px-2 py-1.5">
                <div className="flex items-center justify-between gap-1.5 text-[10px]">
                  <span className={`px-1.5 py-0.5 rounded font-semibold ${regimeClass}`}>
                    {BOW_REGIME_LABELS[bowPreview.regime]}
                  </span>
                  <span className="font-mono text-slate-500 dark:text-slate-400" title="Schelleng bow-force window for this position and speed">
                    F {wedge}
                  </span>
                </div>
                <Slider
                  label={`Bow position β (${bowPositionLabel(bow.beta)})`}
                  value={bow.beta}
                  shown={bow.beta.toFixed(3)}
                  min={BOW_BETA_RANGE.min}
                  max={BOW_BETA_RANGE.max}
                  step={BOW_BETA_RANGE.step}
                  onChange={(v) => setBow({ beta: v })}
                />
                <Slider
                  label="Bow speed"
                  value={bow.velocityMps}
                  shown={`${bow.velocityMps.toFixed(2)} m/s`}
                  min={BOW_SPEED_RANGE.min}
                  max={BOW_SPEED_RANGE.max}
                  step={BOW_SPEED_RANGE.step}
                  onChange={(v) => setBow({ velocityMps: v })}
                />
                <Slider
                  label="Bow force"
                  value={bow.forceN}
                  shown={`${bow.forceN.toFixed(2)} N`}
                  min={BOW_FORCE_RANGE.min}
                  max={BOW_FORCE_RANGE.max}
                  step={BOW_FORCE_RANGE.step}
                  onChange={(v) => setBow({ forceN: v })}
                />
                <button
                  type="button"
                  className="self-start text-[10px] text-violet-600 dark:text-violet-300 hover:underline cursor-pointer"
                  onClick={() => setBow({ forceN: centredBowForce(node, sceneGraph.nodes, bow.beta, bow.velocityMps) })}
                >
                  Centre force in the wedge
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <div className="flex items-center gap-1.5">
        <select
          value={targetNote}
          onChange={(e) => setTargetNote(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 cursor-pointer"
          aria-label="Target concert note"
        >
          {CONCERT_NOTES.map((n) => (
            <option key={n.note} value={n.note}>
              {n.note} ({n.hz} Hz)
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleTune}
          className="px-2.5 py-1 rounded bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold cursor-pointer transition-colors shrink-0"
          title={
            role === 'string' ? 'Solve Mersenne tension & gauge to hit target note'
            : role === 'wind' ? 'Scale the bore (or set the flap frequency) so the played pitch hits the target note'
            : role === 'membrane' ? 'Solve head tension to hit target note'
            : node.resonatorTube ? 'Resize the air column to resonate at the target note'
            : 'Carve underside arch or tune length to hit target note'
          }
        >
          Tune
        </button>
        {role === 'solid' && !node.resonatorTube && (
          <button
            type="button"
            onClick={handleSpawnScale}
            className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-violet-300 bg-slate-50 dark:bg-slate-800 text-[10px] font-semibold text-slate-700 dark:text-slate-200 cursor-pointer transition-colors shrink-0"
            title="Clone a 5-note pentatonic marimba/chime set starting from the selected note"
          >
            5-Note Set
          </button>
        )}
      </div>

      {role === 'solid' && !node.resonatorTube && readout.regime === 'tube' && (
        <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={drillNodalHole}
            onChange={(e) => setDrillNodalHole(e.target.checked)}
          />
          Drill Ø2.2 mm cord hole at 0.224·L nodal point
        </label>
      )}

      {tubeAllowed && role === 'solid' && (
        <div className="flex flex-col gap-1.5 border-t border-slate-100 dark:border-slate-800 pt-1.5">
          <label className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
            <span title="This hollow tube is a tuned air column that a bar suspended over its mouth rings into">Tube resonator (λ/4 or λ/2 air column)</span>
            <input
              type="checkbox"
              checked={!!node.resonatorTube}
              onChange={(e) => writeNode(toggleResonatorTube(node, e.target.checked))}
            />
          </label>
          {node.resonatorTube && (
            <div className="flex flex-col gap-1.5 text-[10px] bg-teal-50/60 dark:bg-teal-950/20 border border-teal-200/70 dark:border-teal-800/50 rounded px-2 py-1.5">
              {tubeColumn && (
                <div className="text-slate-600 dark:text-slate-300">
                  {tubeColumn.endCondition === 'open_closed' ? 'Closed-bottom λ/4' : 'Open-open λ/2'} · bore {(tubeColumn.boreLengthM * 1000).toFixed(0)} mm ·
                  f₁ {tubeColumn.fundamentalHz.toFixed(1)} Hz ({hzToNoteInfo(tubeColumn.fundamentalHz).note})
                </div>
              )}
              <label className="flex flex-col gap-0.5">
                <span className={labelClass}>End condition</span>
                <select
                  value={node.resonatorTube.endCondition ?? ''}
                  onChange={(e) => patchTube({ endCondition: (e.target.value || undefined) as ResonatorTubeSpec['endCondition'] })}
                  className={selectClass}
                  aria-label="Resonator end condition"
                >
                  <option value="">Auto-detect</option>
                  <option value="open_closed">Open–closed (λ/4)</option>
                  <option value="open_open">Open–open (λ/2)</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className={labelClass}>Coupled bar</span>
                <select
                  value={node.resonatorTube.coupledBarNodeId ?? ''}
                  onChange={(e) => patchTube({ coupledBarNodeId: e.target.value || undefined })}
                  className={selectClass}
                  aria-label="Coupled bar"
                >
                  <option value="">Auto (bar above the mouth)</option>
                  {bodyChoices.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className={labelClass}>Tremolo fan hinge</span>
                <select
                  value={node.resonatorTube.vaneJointName ?? ''}
                  onChange={(e) => patchTube({ vaneJointName: e.target.value || undefined })}
                  className={selectClass}
                  aria-label="Tremolo vane joint"
                >
                  <option value="">None</option>
                  {hingeChoices.map((h) => (
                    <option key={`${h.body}:${h.joint}`} value={h.joint}>{h.joint} ({h.body})</option>
                  ))}
                </select>
              </label>
              {node.resonatorTube.vaneJointName && (
                <Slider
                  label="Vane max occlusion"
                  value={node.resonatorTube.vaneMaxOcclusion ?? 0.88}
                  shown={(node.resonatorTube.vaneMaxOcclusion ?? 0.88).toFixed(2)}
                  min={0}
                  max={1}
                  step={0.01}
                  accent="accent-teal-500"
                  onChange={(v) => patchTube({ vaneMaxOcclusion: v })}
                />
              )}
              <button type="button" className={`${auditionButtonClass} self-start`} onClick={handleRingTube}>
                <Volume2 className="w-3 h-3" /> Ring
              </button>
            </div>
          )}
        </div>
      )}

      {plateAllowed && role === 'solid' && (
        <div className="flex flex-col gap-1.5 border-t border-slate-100 dark:border-slate-800 pt-1.5">
          <label className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
            <span title="Hard strikes bloom upward into a crash and glide in pitch (von Kármán geometric nonlinearity)">Nonlinear crash plate (von Kármán)</span>
            <input
              type="checkbox"
              checked={!!node.nonlinearPlate && node.nonlinearPlate.enabled !== false}
              onChange={(e) => writeNode(toggleNonlinearPlate(node, e.target.checked))}
            />
          </label>
          {node.nonlinearPlate && node.nonlinearPlate.enabled !== false && (
            <div className="flex flex-col gap-1.5 text-[10px] bg-orange-50/60 dark:bg-orange-950/20 border border-orange-200/70 dark:border-orange-800/50 rounded px-2 py-1.5">
              <Slider
                label="Crash sensitivity"
                value={node.nonlinearPlate.crashSensitivity ?? 1}
                shown={`×${(node.nonlinearPlate.crashSensitivity ?? 1).toFixed(2)}`}
                min={0}
                max={3}
                step={0.05}
                accent="accent-orange-500"
                onChange={(v) => patchPlate({ crashSensitivity: v })}
              />
              <Slider
                label="Bloom delay"
                value={node.nonlinearPlate.bloomDelayMs ?? 120}
                shown={`${(node.nonlinearPlate.bloomDelayMs ?? 120).toFixed(0)} ms`}
                min={40}
                max={300}
                step={5}
                accent="accent-orange-500"
                onChange={(v) => patchPlate({ bloomDelayMs: v })}
              />
              <Slider
                label="Pitch glide"
                value={node.nonlinearPlate.pitchGlideCents ?? 0}
                shown={`${(node.nonlinearPlate.pitchGlideCents ?? 0).toFixed(0)}¢`}
                min={-400}
                max={400}
                step={10}
                accent="accent-orange-500"
                onChange={(v) => patchPlate({ pitchGlideCents: v })}
              />
              <Slider
                label="Shimmer wash"
                value={node.nonlinearPlate.shimmerMix ?? 0.4}
                shown={(node.nonlinearPlate.shimmerMix ?? 0.4).toFixed(2)}
                min={0}
                max={1}
                step={0.01}
                accent="accent-orange-500"
                onChange={(v) => patchPlate({ shimmerMix: v })}
              />
              <Slider
                label="Dome rise (gong)"
                value={node.nonlinearPlate.archRatio ?? 0}
                shown={(node.nonlinearPlate.archRatio ?? 0).toFixed(2)}
                min={0}
                max={1}
                step={0.01}
                accent="accent-orange-500"
                onChange={(v) => patchPlate({ archRatio: v })}
              />
              <button type="button" className={`${auditionButtonClass} self-start`} onClick={handleCrash} title="A hard strike that crosses the von Kármán threshold">
                <Volume2 className="w-3 h-3" /> Crash
              </button>
            </div>
          )}
        </div>
      )}

      {summary && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
          {summary}
        </div>
      )}
    </div>
  );
}
