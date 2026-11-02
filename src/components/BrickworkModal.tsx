import { useEffect, useMemo, useState } from 'react';
import { BrickWall, X } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import type { SceneNode } from '../types/scene';
import { useStore } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import {
  BRICK_BONDS, BRICK_STANDARDS, DEFAULT_BRICKWORK_OPTIONS,
  type BrickBond, type BrickPlacement, type BrickStandardId,
} from '../utils/brickwork';
import { layBricksOffThread, type BrickworkOutcome } from '../utils/brickworkClient';

/** The top-level piece a selection belongs to, as Pipes takes it. */
function pieceOf(nodes: SceneNode[], id: string | null): SceneNode | null {
  if (!id) return null;
  const holds = (n: SceneNode): boolean => n.id === id || (n.children ?? []).some(holds);
  return nodes.find((n) => !n.simulation && holds(n)) ?? null;
}

const field = 'w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-900 dark:text-white';

/**
 * Lay the selected piece (or the whole scene) in brick: the count to buy, the
 * cuts, the mortar and the lintels, worked out as the settings change, and the
 * bricks put in the scene when asked.
 */
export function BrickworkModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  useEscapeToClose(isOpen, onClose);
  const scene = useStore((s) => s.sceneGraph);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const piece = pieceOf(scene.nodes, selectedNodeId);

  const [standardId, setStandardId] = useState<BrickStandardId>(DEFAULT_BRICKWORK_OPTIONS.standardId);
  const [bond, setBond] = useState<BrickBond>(DEFAULT_BRICKWORK_OPTIONS.bond);
  const [jointMm, setJointMm] = useState<number>(BRICK_STANDARDS[DEFAULT_BRICKWORK_OPTIONS.standardId].jointMm);
  const [wastagePct, setWastagePct] = useState<number>(DEFAULT_BRICKWORK_OPTIONS.wastagePct);
  const [placement, setPlacement] = useState<BrickPlacement>('beside');
  const [outcome, setOutcome] = useState<BrickworkOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const options = useMemo(() => ({ standardId, bond, jointMm, wastagePct, placement }), [standardId, bond, jointMm, wastagePct, placement]);

  // Counted as the settings change, in the worker.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      layBricksOffThread(scene, piece?.id ?? null, options)
        .then((o) => { if (live) { setOutcome(o); setError(null); } })
        .catch((e: Error) => { if (live) { setOutcome(null); setError(e.message); } })
        .finally(() => { if (live) setBusy(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [isOpen, scene, piece?.id, options]);

  if (!isOpen) return null;

  const chooseStandard = (id: BrickStandardId) => {
    setStandardId(id);
    setJointMm(BRICK_STANDARDS[id].jointMm);
  };

  const layInScene = () => {
    if (!outcome) return;
    const state = useStore.getState();
    // Laid from the scene as it was counted; if it has moved on, it is being counted again.
    if (state.sceneGraph !== scene) { setMessage('The scene changed: counting again.'); return; }
    state.prepareForDiscreteChange();
    const next = { ...state.sceneGraph, nodes: outcome.nodes };
    state.updateScene(next);
    void state.recompile(next);
    setMessage(`Laid ${outcome.result.bricks.length.toLocaleString()} bricks in ${outcome.result.courses} courses.`);
    setTimeout(() => setMessage(null), 5000);
  };

  const r = outcome?.result;
  const std = BRICK_STANDARDS[standardId];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <BrickWall className="w-5 h-5 text-red-700 dark:text-red-400" />
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">Brickwork</h2>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">Laying: {piece ? piece.name : 'the whole scene'}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">The shape in brick, course by course: the bricks to buy, the cuts, the mortar and the lintels.</p>
            </div>
          </div>
          <button onClick={onClose} title="Close" className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 items-end">
            <label className="space-y-1 block col-span-2 md:col-span-1">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Brick</span>
              <select value={standardId} onChange={(e) => chooseStandard(e.target.value as BrickStandardId)} className={field}>
                {Object.values(BRICK_STANDARDS).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 block">
              <span className="text-[11px] text-slate-500 dark:text-slate-400" title="Stretcher: every brick along the wall, half lapped. English and Flemish lay headers across a wall a brick thick. Stack lines the joints up, for show.">Bond</span>
              <select value={bond} onChange={(e) => setBond(e.target.value as BrickBond)} className={field}>
                {BRICK_BONDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </label>
            <label className="space-y-1 block">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Joint (mm)</span>
              <NumberInput min={0.5} max={30} step={0.5} value={jointMm} fallbackOnBlur={std.jointMm}
                onChange={(v) => { if (v !== undefined && Number.isFinite(v) && v > 0) setJointMm(v); }} className={field} />
            </label>
            <label className="space-y-1 block">
              <span className="text-[11px] text-slate-500 dark:text-slate-400" title="Extra bricks against breakage and rejects">Spare (%)</span>
              <NumberInput min={0} max={50} step={1} value={wastagePct} fallbackOnBlur={DEFAULT_BRICKWORK_OPTIONS.wastagePct}
                onChange={(v) => { if (v !== undefined && Number.isFinite(v) && v >= 0) setWastagePct(v); }} className={field} />
            </label>
            <label className="space-y-1 block">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">Put the bricks</span>
              <select value={placement} onChange={(e) => setPlacement(e.target.value as BrickPlacement)} className={field}>
                <option value="beside">Beside the shape</option>
                <option value="replace">In place of the shape</option>
              </select>
            </label>
            <button
              onClick={layInScene}
              disabled={!outcome || busy}
              className="w-full py-1.5 px-3 rounded-lg bg-red-700 hover:bg-red-600 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors"
            >
              <BrickWall className={`w-4 h-4 ${busy ? 'animate-pulse' : ''}`} />
              {busy ? 'Counting…' : 'Lay in scene'}
            </button>
          </div>
          {message && <div className="text-xs text-emerald-600 dark:text-emerald-400">{message}</div>}
          {error && <div role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</div>}

          {r && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  ['Bricks to buy', r.toBuy.toLocaleString(), `${r.whole.toLocaleString()} whole, ${r.cutPieces} cut, ${wastagePct}% spare`],
                  ['Courses', String(r.courses), `${Math.round(r.builtHeightMm)} mm built, model ${Math.round(r.modelHeightMm)} mm`],
                  ['Mortar', `${Math.round(r.mortarLitres)} L`, `${r.mortarBags} × 25 kg bags of premix`],
                  ['Lintels', String(r.lintels.reduce((n, l) => n + l.count, 0)), r.lintels.length ? r.lintels.map((l) => `${l.count}× ${l.lengthMm} mm`).join(', ') : 'No openings to span'],
                ].map(([label, value, note]) => (
                  <div key={label} className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
                    <div className="text-lg font-semibold text-slate-900 dark:text-white">{value}</div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">{note}</div>
                  </div>
                ))}
              </div>
              {r.cuts.length > 0 && (
                <div className="bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Cuts</h3>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {r.cuts.map((c) => <span key={c.lengthMm}><span className="font-semibold">{c.count}×</span> {c.lengthMm} mm</span>)}
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1">Two cuts that fit in one brick are counted as one brick to buy.</p>
                </div>
              )}
              {r.warnings.map((w) => <p key={w} className="text-xs text-amber-700 dark:text-amber-400">{w}</p>)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
