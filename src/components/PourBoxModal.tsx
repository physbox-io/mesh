import React, { useEffect, useState } from 'react';
import { X, Cylinder, AlertTriangle, Download } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useSettled } from '../hooks/useSettled';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useStore } from '../store/useStore';
import { planPourBox } from '../utils/pourBoxScene';
import { addPourBoxToScene, pourBoxStl } from '../utils/pourBoxActions';
import { downloadBlob } from '../utils/downloadBlob';
import { stlFileName } from '../utils/meshStlExport';
import { findNodeById } from '../utils/sceneTree';
import {
  DEFAULT_POUR_BOX_OPTIONS,
  SILICONES,
  type PourBox,
  type PourBoxOptions,
  type PourBoxShape,
  type SiliconeId,
} from '../utils/siliconeMold';

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none';

const labelClass = 'font-semibold text-slate-600 dark:text-slate-300';

interface PourBoxModalProps {
  onClose: () => void;
  /** The master: the selected bodies, read once when the dialog opens. */
  ids: string[];
  /** Back to the rigid mold designer. */
  onMakeMold: () => void;
}

type NumberKey = 'coverMm' | 'wallMm' | 'clearanceMm' | 'baseMm' | 'grooveMm' | 'freeboardMm' | 'pinDiaMm';

const NUMBER_FIELDS: { key: NumberKey; label: string; title: string; min: number; step: number }[] = [
  { key: 'coverMm', label: 'Silicone cover (mm)', title: 'Silicone round the sides and over the top', min: 2, step: 1 },
  { key: 'wallMm', label: 'Sleeve wall (mm)', title: 'Printed wall of the sleeve', min: 0.8, step: 0.2 },
  { key: 'baseMm', label: 'Base (mm)', title: 'Base plate thickness', min: 2, step: 1 },
  { key: 'grooveMm', label: 'Groove (mm)', title: 'How deep the sleeve sits in the base', min: 0.5, step: 0.5 },
  { key: 'clearanceMm', label: 'Fit clearance (mm)', title: 'Gap each side of the sleeve in its groove', min: 0, step: 0.05 },
  { key: 'freeboardMm', label: 'Above fill (mm)', title: 'Sleeve height past the fill line', min: 0, step: 1 },
];

/**
 * A printed pour box for casting a silicone mold of the selected master: base
 * with a groove, a sleeve that drops into it, and an optional wick pin.
 */
export const PourBoxModal: React.FC<PourBoxModalProps> = ({ onClose, ids, onMakeMold }) => {
  useEscapeToClose(true, onClose);
  const [name] = useState(() => findNodeById(useStore.getState().sceneGraph.nodes, ids[0])?.name ?? 'master');
  const [options, setOptions] = useState<PourBoxOptions>({ ...DEFAULT_POUR_BOX_OPTIONS });
  const settled = useSettled(options, 250);
  const [box, setBox] = useState<PourBox | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const set = <K extends keyof PourBoxOptions>(key: K, value: PourBoxOptions[K] | undefined) => {
    if (value !== undefined) setOptions((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    let live = true;
    planPourBox(useStore.getState().sceneGraph, ids, settled)
      .then((b) => { if (live) { setBox(b); setFailure(null); } })
      .catch((e: Error) => { if (live) { setBox(null); setFailure(e.message); } });
    return () => { live = false; };
  }, [ids, settled]);

  const busy = settled !== options;

  const handleAdd = async () => {
    if (!box) return;
    setAdding(true);
    try {
      await addPourBoxToScene(ids, settled, box);
      onClose();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleDownload = () => {
    if (!box) return;
    for (const [piece, mesh] of [['base', box.base], ['sleeve', box.sleeve]] as const) {
      const bytes = pourBoxStl(mesh, piece);
      downloadBlob(new Blob([bytes.slice().buffer], { type: 'model/stl' }), stlFileName(`${name}_pour_${piece}`));
    }
  };

  const r = box?.report;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-md flex flex-col overflow-hidden text-slate-800 dark:text-slate-100 max-h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-md">
              <Cylinder className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-base">Silicone pour box</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate" title={name}>{name}</p>
            </div>
          </div>
          <button aria-label="Close" title="Close" onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-3 text-sm overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            {NUMBER_FIELDS.map((f) => (
              <label key={f.key} className="space-y-1 text-xs" title={f.title}>
                <span className={labelClass}>{f.label}</span>
                <NumberInput min={f.min} step={f.step} value={options[f.key]} onChange={(v) => set(f.key, v)} className={inputClass} />
              </label>
            ))}
            <label className="space-y-1 text-xs" title="Fit follows the master's outline and uses the least silicone">
              <span className={labelClass}>Sleeve shape</span>
              <select value={options.shape} onChange={(e) => set('shape', e.target.value as PourBoxShape)} className={inputClass}>
                <option value="fit">Fit to master</option>
                <option value="round">Round</option>
                <option value="box">Box</option>
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className={labelClass}>Silicone</span>
              <select value={options.silicone} onChange={(e) => set('silicone', e.target.value as SiliconeId)} className={inputClass}>
                {(Object.keys(SILICONES) as SiliconeId[]).map((id) => (
                  <option key={id} value={id}>{SILICONES[id].name}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs col-span-2 sm:col-span-1" title="A pin from the top of the master through the silicone: a wick hole for a candle, a pour hole for resin">
              <input type="checkbox" checked={options.pin} onChange={(e) => set('pin', e.target.checked)} className="accent-purple-600" />
              <span className={labelClass}>Wick / pour pin</span>
            </label>
            {options.pin && (
              <label className="space-y-1 text-xs">
                <span className={labelClass}>Pin diameter (mm)</span>
                <NumberInput min={0.5} step={0.5} value={options.pinDiaMm} onChange={(v) => set('pinDiaMm', v)} className={inputClass} />
              </label>
            )}
          </div>

          {failure ? (
            <p className="text-red-600 dark:text-red-400">{failure}</p>
          ) : !r ? (
            <p className="text-slate-500 dark:text-slate-400">Planning…</p>
          ) : (
            <>
              <dl className={`grid grid-cols-2 gap-y-1 text-xs ${busy ? 'opacity-50' : ''}`}>
                <dt className="text-slate-500 dark:text-slate-400">Fill to</dt>
                <dd className="font-mono">{r.fillHeightMm} mm above the base</dd>
                <dt className="text-slate-500 dark:text-slate-400">Silicone</dt>
                <dd className="font-mono">{r.siliconeG} g ({r.partAG} A + {r.partBG} B)</dd>
                <dt className="text-slate-500 dark:text-slate-400">Volume</dt>
                <dd className="font-mono">{r.siliconeMm3.toLocaleString()} mm³</dd>
                <dt className="text-slate-500 dark:text-slate-400">Sleeve</dt>
                <dd className="font-mono">{r.sleeveFootprintMm[0]} × {r.sleeveFootprintMm[1]} × {r.sleeveHeightMm} mm</dd>
                <dt className="text-slate-500 dark:text-slate-400">Base</dt>
                <dd className="font-mono">{r.baseFootprintMm[0]} × {r.baseFootprintMm[1]} mm</dd>
              </dl>
              <p className="text-xs text-slate-500 dark:text-slate-400">Mix about 10% extra for what stays in the cup.</p>
              {r.warnings.map((w) => (
                <p key={w} className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{w}</span>
                </p>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-800">
          <button type="button" onClick={onMakeMold}
            className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 underline cursor-pointer">
            Rigid mold instead
          </button>
          <div className="flex gap-2">
            <button type="button" disabled={!box || busy} onClick={handleDownload} title="Base and sleeve STLs"
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
              <Download className="w-4 h-4" /> STLs
            </button>
            <button type="button" disabled={!box || busy || adding} onClick={() => void handleAdd()}
              className="px-3 py-2 text-xs font-semibold rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 cursor-pointer">
              {adding ? 'Adding…' : 'Add to Scene'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
