import { useMemo, useState } from 'react';
import { Music, Volume2, AlertTriangle } from 'lucide-react';
import type { SceneGraph, SceneNode, StringMaterialId } from '../../types/scene';
import { useStore } from '../../store/useStore';
import { RangeInput } from '../RangeInput';
import { estimateBodyModes, playModalImpact, playModalTap, unlockAudioContext } from '../../utils/modalAudio';
import {
  buildTunedScaleNodes,
  CONCERT_NOTES,
  hzToNoteInfo,
  noteToHz,
  tuneBodyToPitch,
} from '../../utils/acousticTuning';
import {
  analyzeSoundboxResonance,
  evaluateTautString,
  STRING_MATERIALS,
  tuneStringToPitch,
} from '../../utils/stringAcoustics';
import { extractBoreWaveguide } from '../../utils/windAcoustics';
import { silenceWindVoices, updateLiveWindVoices } from '../../utils/modalAudio';

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

function isSlenderWireCandidate(node: SceneNode): boolean {
  if (node.acousticString) return true;
  const g = (node.geoms ?? []).find((x) => !x.csgDerived && x.csg !== 'difference');
  if (!g || (g.type !== 'capsule' && g.type !== 'cylinder')) return false;
  const r = g.size[0] ?? 0.01;
  const len = g.fromto && g.fromto.length >= 6
    ? Math.hypot(g.fromto[3] - g.fromto[0], g.fromto[4] - g.fromto[1], g.fromto[5] - g.fromto[2])
    : 2 * (g.size[1] ?? 0.05);
  return r > 0 && len / (2 * r) >= 14;
}

/**
 * Inverse Luthier & Structural Pitch Tuner ("Tune to Concert Pitch"):
 * - Bars / chimes / blocks: Euler–Bernoulli / Rayleigh–Ritz underside arch or length tuning.
 * - Slender wires / taut strings (`acousticString`): Mersenne tension + gauge + coupled
 *   Helmholtz/soundboard resonance from the host soundbox!
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

  const stringEval = useMemo(
    () => (node.acousticString ? evaluateTautString(node, sceneGraph.nodes) : null),
    [node, sceneGraph.nodes],
  );

  const windBore = useMemo(
    () => (node.windInstrument ? extractBoreWaveguide(node) : null),
    [node],
  );

  const soundboxInfo = useMemo(() => {
    if (!isEligible || node.acousticString) return null;
    const info = analyzeSoundboxResonance(node);
    return info.hasHollowCavity ? info : null;
  }, [isEligible, node]);

  const profile = useMemo(() => {
    if (!isEligible) return null;
    if (stringEval) return stringEval.profile;
    return estimateBodyModes(node);
  }, [isEligible, node, stringEval]);

  const currentNote = useMemo(
    () => (profile ? hzToNoteInfo(profile.fundamentalHz) : null),
    [profile],
  );

  const [targetNote, setTargetNote] = useState<string>('A4');
  const [drillNodalHole, setDrillNodalHole] = useState<boolean>(false);
  const [summary, setSummary] = useState<string | null>(null);

  if (!isEligible || !profile || !currentNote) return null;

  const canToggleTautWire = isSlenderWireCandidate(node);

  const handleAudition = () => {
    unlockAudioContext();
    if (windBore && node.windInstrument) {
      updateLiveWindVoices([
        {
          id: node.id,
          exciter: node.windInstrument.exciter,
          breathKPa: Math.max(3.5, node.windInstrument.breathKPa || 3.8),
          embouchureHz: node.windInstrument.embouchureHz,
          cellCount: windBore.cellCount,
          exactCells: windBore.exactCells,
          junctionK: windBore.junctionK,
          bellCutoffHz: windBore.bellCutoffHz,
          shunts: windBore.toneholes
            .filter((t) => t.openAmount > 0.05)
            .map((t) => ({ cell: t.cellIndex, coeff: t.shuntCoeff * t.openAmount })),
        },
      ]);
      setTimeout(() => silenceWindVoices(), 850);
      return;
    }
    if (stringEval) {
      playModalImpact(stringEval.profile, 0.35, true);
    } else {
      playModalTap(node);
    }
  };

  const handleToggleStringMode = (enable: boolean) => {
    const state = useStore.getState();
    let updated: SceneNode;
    if (enable) {
      const seeded: SceneNode = {
        ...node,
        acousticString: {
          material: 'bronze',
          diameterMm: 0.65,
          tensionN: 50,
          pluckPos: 0.2,
        },
      };
      updated = tuneStringToPitch(seeded, noteToHz(targetNote) ?? 261.63);
    } else {
      updated = { ...node };
      delete updated.acousticString;
    }
    state.updateScene({
      ...state.sceneGraph,
      nodes: replaceNodeInTree(state.sceneGraph.nodes, node.id, updated),
    });
  };

  const handleTune = () => {
    const hz = noteToHz(targetNote) ?? 440;
    const state = useStore.getState();
    if (node.acousticString) {
      const updated = tuneStringToPitch(node, hz);
      const nextNodes = replaceNodeInTree(state.sceneGraph.nodes, node.id, updated);
      state.updateScene({ ...state.sceneGraph, nodes: nextNodes });
      const afterEval = evaluateTautString(updated, nextNodes);
      if (afterEval) {
        setSummary(
          `Tuned string to ${targetNote} (${afterEval.fundamentalHz.toFixed(1)} Hz) at ${updated.acousticString?.tensionN} N (${updated.acousticString?.diameterMm} mm)`,
        );
        playModalImpact(afterEval.profile, 0.35, true);
      }
      return;
    }

    const res = tuneBodyToPitch(node, hz, { drillNodalHole });
    const nextGraph: SceneGraph = {
      ...state.sceneGraph,
      nodes: replaceNodeInTree(state.sceneGraph.nodes, node.id, res.node),
    };
    state.updateScene(nextGraph);
    setSummary(res.summary);
    playModalTap(res.node);
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

  const centsLabel =
    currentNote.cents === 0
      ? 'in tune'
      : `${currentNote.cents > 0 ? '+' : ''}${currentNote.cents}¢`;

  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-1.5">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <Music className="w-3.5 h-3.5 text-violet-500" />
          {node.windInstrument ? 'Wind Bore & Reed' : node.acousticString ? 'Taut String Pitch' : 'Concert Pitch'}
        </h3>
        <button
          type="button"
          onClick={handleAudition}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 border border-violet-200 dark:border-violet-800 text-[10px] font-semibold text-violet-700 dark:text-violet-300 cursor-pointer transition-colors"
          title={node.windInstrument ? 'Blow a test note through this 3D bore waveguide' : node.acousticString ? 'Pluck this taut string' : 'Strike this body with a virtual mallet'}
        >
          <Volume2 className="w-3 h-3" /> {node.windInstrument ? 'Blow' : node.acousticString ? 'Pluck' : 'Tap'}
        </button>
      </div>

      {canToggleTautWire && (
        <label className="flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer">
          <span>Tensioned string (Mersenne law)</span>
          <input
            type="checkbox"
            checked={!!node.acousticString}
            onChange={(e) => handleToggleStringMode(e.target.checked)}
          />
        </label>
      )}

      <div className="flex items-baseline justify-between text-xs bg-slate-50 dark:bg-slate-800/60 rounded px-2 py-1.5">
        <div>
          <span className="font-bold text-slate-800 dark:text-slate-100">{currentNote.note}</span>{' '}
          <span className="text-[10px] text-slate-500 dark:text-slate-400">({centsLabel})</span>
        </div>
        <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
          {profile.fundamentalHz.toFixed(1)} Hz · f₂/f₁ {profile.overtoneRatio.toFixed(2)}
        </div>
      </div>

      {windBore && node.windInstrument && (
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
          <label className="flex flex-col gap-0.5 text-slate-600 dark:text-slate-300">
            <span className="flex justify-between">
              <span>Embouchure / Lip Tension</span>
              <span className="font-mono">{node.windInstrument.embouchureHz.toFixed(0)} Hz</span>
            </span>
            <RangeInput
              min="120"
              max="1100"
              step="5"
              value={node.windInstrument.embouchureHz}
              onChange={(v) =>
                updateNode(node.id, {
                  windInstrument: { ...node.windInstrument!, embouchureHz: v },
                })
              }
              className="w-full accent-sky-500 cursor-pointer"
            />
          </label>
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

      {stringEval && node.acousticString && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Wire</span>
              <select
                value={node.acousticString.material}
                onChange={(e) =>
                  updateNode(node.id, {
                    acousticString: { ...node.acousticString!, material: e.target.value as StringMaterialId },
                  })
                }
                className="w-full px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                {Object.values(STRING_MATERIALS).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
                Gauge ({node.acousticString.diameterMm.toFixed(2)} mm)
              </span>
              <RangeInput
                min="0.20"
                max="1.60"
                step="0.02"
                value={node.acousticString.diameterMm}
                onChange={(v) =>
                  updateNode(node.id, {
                    acousticString: { ...node.acousticString!, diameterMm: v },
                  })
                }
                className="w-full accent-violet-500 cursor-pointer mt-1.5"
              />
            </label>
          </div>

          <div className="flex flex-col gap-0.5">
            <label className="text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
              <span>Tension T</span>
              <span className="font-mono text-slate-700 dark:text-slate-200">
                {node.acousticString.tensionN.toFixed(1)} N ({Math.round(stringEval.stressRatio * 100)}% σ_ult)
              </span>
            </label>
            <RangeInput
              min="8"
              max="160"
              step="0.5"
              value={node.acousticString.tensionN}
              onChange={(v) => {
                const kPerp = +(4 * v / stringEval.lengthM).toFixed(1);
                const nextJoints = (node.joints ?? []).map((j, idx) =>
                  idx === 0 && j.type === 'slide' ? { ...j, stiffness: kPerp } : j,
                );
                updateNode(node.id, {
                  joints: nextJoints,
                  acousticString: { ...node.acousticString!, tensionN: v },
                });
              }}
              className="w-full accent-violet-500 cursor-pointer"
            />
          </div>

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
          title={node.acousticString ? 'Solve Mersenne tension & gauge to hit target note' : 'Carve underside arch or tune length to hit target note'}
        >
          Tune
        </button>
        {!node.acousticString && (
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

      {!node.acousticString && profile.regime === 'tube' && (
        <label className="flex items-center gap-1.5 text-[10px] text-slate-600 dark:text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={drillNodalHole}
            onChange={(e) => setDrillNodalHole(e.target.checked)}
          />
          Drill Ø2.2 mm cord hole at 0.224·L nodal point
        </label>
      )}

      {summary && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
          {summary}
        </div>
      )}
    </div>
  );
}
