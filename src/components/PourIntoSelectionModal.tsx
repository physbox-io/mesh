import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Droplet, AlertTriangle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useSettled } from '../hooks/useSettled';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useStore } from '../store/useStore';
import { AddSimulationButton } from './MachineJobControls';
import { MoldWorkerClient, addPourToScene, pourPlugNote, pourSideLabel, pourUndercutWarning } from '../utils/moldWorkerClient';
import { POUR_DIRECTIONS, type PourDirection } from '../utils/pourCast';
import { pourSelection } from '../utils/pourTarget';
import type { MoldCastSimulationResult } from '../utils/moldCastSimulation';
import type { SceneNode } from '../types/scene';

const SIDE_NAMES: Record<PourDirection, string> = {
  '+z': 'Top', '-z': 'Underneath', '+x': '+X side', '-x': '-X side', '+y': '+Y side', '-y': '-Y side',
};

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none';

interface PourIntoSelectionModalProps {
  onClose: () => void;
  /** The selected bodies, read once when the dialog opens. */
  ids: string[];
  /** Nothing selected holds a pour, or the user asked for a mold instead. */
  onMakeMold: () => void;
  /** A printed pour box round the selection, for a silicone mold of it. */
  onPourBox: () => void;
}

/**
 * The Mold button with bodies selected that already make a mold — a master
 * and its pour sleeve, or a silicone mold simulated from them — pours into
 * them instead of molding them again. Selected bodies that hold nothing go
 * straight on to the mold designer.
 */
export const PourIntoSelectionModal: React.FC<PourIntoSelectionModalProps> = ({ onClose, ids, onMakeMold, onPourBox }) => {
  useEscapeToClose(true, onClose);
  // Only the bodies touching the one clicked: the rest hold nothing with it.
  const [{ moldNode, apart }] = useState<{ moldNode: SceneNode | null; apart: SceneNode[] }>(() => {
    const picked = pourSelection(useStore.getState().sceneGraph.nodes, ids);
    return { moldNode: picked?.node ?? null, apart: picked?.apart ?? [] };
  });
  const [cast, setCast] = useState<MoldCastSimulationResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(true);
  const [direction, setDirection] = useState<PourDirection | 'auto'>('auto');
  /** Fill depth in mm; null fills to the rim. */
  const [fill, setFill] = useState<number | null>(null);
  // Memoised: a fresh literal each render restarted the settle timer on every
  // render, so each pour's own busy flag set off the next — the dialog re-poured
  // about once a second and Simulate Cast blinked disabled with it.
  const pourOptions = useMemo(() => ({ direction, fill }), [direction, fill]);
  const settled = useSettled(pourOptions, 300);
  const firstPour = useRef(true);
  // One worker for the dialog's life, not one per change of side or depth.
  const clientRef = useRef<MoldWorkerClient | null>(null);
  useEffect(() => {
    const client = new MoldWorkerClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
    };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!moldNode) {
      onMakeMold();
      return;
    }
    if (!client) return;
    let live = true;
    setBusy(true);
    client
      .castNode(moldNode, { pour: { direction: settled.direction, ...(settled.fill ? { fillMm: settled.fill } : {}) } })
      .then((res) => {
        if (!live) return;
        const first = firstPour.current;
        firstPour.current = false;
        if (res.success) {
          setCast(res);
          setFailure(null);
        } else if (first) {
          // Selected bodies that hold nothing from any side are a part to mold.
          onMakeMold();
        } else {
          setCast(null);
          setFailure(res.error ?? 'Nothing poured.');
        }
      })
      .catch((e: Error) => {
        if (live) setFailure(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
    // onMakeMold is the parent's setter wrapper, not an input to the pour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moldNode, settled]);

  const handleAdd = async () => {
    if (!moldNode || !cast) return;
    setAdding(true);
    try {
      await addPourToScene(moldNode, cast, 'beside');
      onClose();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const pour = cast?.pour;
  const undercut = pour ? pourUndercutWarning(pour) : null;
  const plug = pour ? pourPlugNote(pour) : null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md flex flex-col overflow-hidden text-slate-800 dark:text-slate-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white shadow-md">
              <Droplet className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-base">Pour into the selection</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={moldNode?.name}>
                {moldNode?.name}
              </p>
            </div>
          </div>
          <button aria-label="Close" title="Close"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-3 text-sm">
          {apart.length > 0 && (
            <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Left out {apart.map((n) => n.name).join(', ')}: {apart.length === 1 ? 'it does' : 'they do'} not touch {moldNode?.name}, so {apart.length === 1 ? 'it holds' : 'they hold'} nothing with it.
              </span>
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-slate-600 dark:text-slate-300">Pour from</span>
              <select
                value={direction}
                onChange={(e) => setDirection(e.target.value as PourDirection | 'auto')}
                className={inputClass}
              >
                <option value="auto">Best side</option>
                {POUR_DIRECTIONS.map((d) => (
                  <option key={d} value={d}>{SIDE_NAMES[d]}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-semibold text-slate-600 dark:text-slate-300">
                Fill depth (mm){' '}
                {fill !== null && (
                  <button type="button" onClick={() => setFill(null)} className="font-normal underline cursor-pointer">
                    to rim
                  </button>
                )}
              </span>
              <NumberInput
                min={0.5}
                max={pour?.depthMm}
                step={1}
                value={fill ?? pour?.depthMm ?? 0}
                onChange={(v) => {
                  if (v !== undefined) setFill(pour && v >= pour.depthMm ? null : v);
                }}
                className={inputClass}
              />
            </label>
          </div>
          {failure ? (
            <p className="text-red-600 dark:text-red-400">{failure}</p>
          ) : !cast ? (
            <p className="text-slate-500 dark:text-slate-400">Pouring…</p>
          ) : (
            <>
              <p className={`text-slate-600 dark:text-slate-300 ${busy ? 'opacity-50' : ''}`}>
                Poured {pour ? pourSideLabel(pour.direction) : ''}
                {pour && pour.filledMm < pour.depthMm ? `, ${pour.filledMm} of ${pour.depthMm} mm deep` : ', to the rim'}.
              </p>
              <dl className={`grid grid-cols-2 gap-y-1 text-xs ${busy ? 'opacity-50' : ''}`}>
                <dt className="text-slate-500 dark:text-slate-400">Volume</dt>
                <dd className="font-mono">{Math.round(cast.castVolumeMm3).toLocaleString()} mm³</dd>
                <dt className="text-slate-500 dark:text-slate-400">Size</dt>
                <dd className="font-mono">{cast.sizeMm.width} × {cast.sizeMm.depth} × {cast.sizeMm.height} mm</dd>
              </dl>
              {plug && <p className="text-xs text-slate-600 dark:text-slate-300">{plug}</p>}
              {undercut && (
                <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{undercut}</span>
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800">
          <div className="flex flex-col items-start gap-1">
            <button
              type="button"
              onClick={onMakeMold}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
            >
              Make a mold instead
            </button>
            <button
              type="button"
              onClick={onPourBox}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer"
            >
              Silicone pour box
            </button>
          </div>
          <AddSimulationButton
            disabled={!cast || adding || busy}
            onSimulate={() => void handleAdd()}
            progress={adding ? 0.5 : null}
            label="Simulate Cast"
            besideOnly
          />
        </div>
      </div>
    </div>
  );
};
