import { useMemo, useState } from 'react';
import { Music, Volume2 } from 'lucide-react';
import type { SceneGraph, SceneNode } from '../../types/scene';
import { useStore } from '../../store/useStore';
import { estimateBodyModes, playModalTap } from '../../utils/modalAudio';
import {
  buildTunedScaleNodes,
  CONCERT_NOTES,
  hzToNoteInfo,
  noteToHz,
  tuneBodyToPitch,
} from '../../utils/acousticTuning';

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

/**
 * Inverse Luthier & Structural Pitch Tuner ("Tune to Concert Pitch"):
 * Estimates structural modal frequencies from geometry + material, auditions a
 * physical modal tap, and carves an underside marimba arch or tunes tube length
 * (+ 0.2242·L nodal cord point) to hit a target concert note.
 */
export function AcousticTuningCard({ node }: { node: SceneNode }) {
  const isEligible = useMemo(() => {
    if (node.hardwarePart || node.simulation) return false;
    return (node.geoms ?? []).some(
      (g) => g.type !== 'plane' && !g.csgDerived && g.csg !== 'difference',
    );
  }, [node]);

  const profile = useMemo(() => (isEligible ? estimateBodyModes(node) : null), [isEligible, node]);
  const currentNote = useMemo(
    () => (profile ? hzToNoteInfo(profile.fundamentalHz) : null),
    [profile],
  );

  const [targetNote, setTargetNote] = useState<string>('A4');
  const [drillNodalHole, setDrillNodalHole] = useState<boolean>(false);
  const [summary, setSummary] = useState<string | null>(null);

  if (!isEligible || !profile || !currentNote) return null;

  const handleTap = () => {
    playModalTap(node);
  };

  const handleTune = () => {
    const hz = noteToHz(targetNote) ?? 440;
    const res = tuneBodyToPitch(node, hz, { drillNodalHole });
    const state = useStore.getState();
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
          <Music className="w-3.5 h-3.5 text-violet-500" /> Concert Pitch
        </h3>
        <button
          type="button"
          onClick={handleTap}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/50 dark:hover:bg-violet-900/60 border border-violet-200 dark:border-violet-800 text-[10px] font-semibold text-violet-700 dark:text-violet-300 cursor-pointer transition-colors"
          title="Strike this body with a virtual mallet to audition its structural modes"
        >
          <Volume2 className="w-3 h-3" /> Tap
        </button>
      </div>

      <div className="flex items-baseline justify-between text-xs bg-slate-50 dark:bg-slate-800/60 rounded px-2 py-1.5">
        <div>
          <span className="font-bold text-slate-800 dark:text-slate-100">{currentNote.note}</span>{' '}
          <span className="text-[10px] text-slate-500 dark:text-slate-400">({centsLabel})</span>
        </div>
        <div className="font-mono text-[11px] text-slate-600 dark:text-slate-300">
          {profile.fundamentalHz.toFixed(1)} Hz · f₂/f₁ {profile.overtoneRatio.toFixed(2)}
        </div>
      </div>

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
          title="Carve an underside marimba arch or tune length to hit the target concert note"
        >
          Tune
        </button>
        <button
          type="button"
          onClick={handleSpawnScale}
          className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:border-violet-300 bg-slate-50 dark:bg-slate-800 text-[10px] font-semibold text-slate-700 dark:text-slate-200 cursor-pointer transition-colors shrink-0"
          title="Clone a 5-note pentatonic marimba/chime set starting from the selected note"
        >
          5-Note Set
        </button>
      </div>

      {profile.regime === 'tube' && (
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
