import React, { useEffect, useState } from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useSettled } from '../../hooks/useSettled';
import { useStore } from '../../store/useStore';
import { planPourBox } from '../../utils/pourBoxScene';
import { addPourBoxToScene, pourBoxStl } from '../../utils/pourBoxActions';
import { downloadBlob } from '../../utils/downloadBlob';
import { stlFileName } from '../../utils/meshStlExport';
import { DEFAULT_POUR_BOX_OPTIONS, HOLE_DIA_MM, holePinMesh, type HolePurpose, type PourBox, type PourBoxMesh, type PourBoxOptions, type PourBoxShape } from '../../utils/siliconeMold';
import { SILICONES, castMaterialWarnings, type CastMaterialId, type SiliconeId } from '../../utils/castMaterials';
import { AdvancedBlock, CastTopFields, MaterialNotes } from './CastTopFields';
import { PanelBody, PanelFooter } from './CastDialogFrame';
import { ChainResult } from './ChainRun';
import { useChainRun } from './useChainRun';
import { AddSimulationButton } from '../MachineJobControls';
import { addSiliconeChain } from '../../utils/castChainActions';

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none';

const labelClass = 'font-semibold text-slate-600 dark:text-slate-300';

type NumberKey = 'coverMm' | 'wallMm' | 'clearanceMm' | 'baseMm' | 'grooveMm' | 'freeboardMm';

const NUMBER_FIELDS: { key: NumberKey; label: string; title: string; min: number; step: number }[] = [
  { key: 'coverMm', label: 'Silicone cover (mm)', title: 'Silicone round the sides and over the top', min: 2, step: 1 },
  { key: 'wallMm', label: 'Sleeve wall (mm)', title: 'Printed wall of the sleeve', min: 0.8, step: 0.2 },
  { key: 'baseMm', label: 'Base (mm)', title: 'Base plate thickness', min: 2, step: 1 },
  { key: 'grooveMm', label: 'Groove (mm)', title: 'How deep the sleeve sits in the base', min: 0.5, step: 0.5 },
  { key: 'clearanceMm', label: 'Fit clearance (mm)', title: 'Gap each side of the sleeve in its groove', min: 0, step: 0.05 },
  { key: 'freeboardMm', label: 'Above fill (mm)', title: 'Sleeve height past the fill line', min: 0, step: 1 },
];

interface SiliconeBoxPanelProps {
  onClose: () => void;
  /** The master: the bodies to mold. */
  ids: string[];
  /** Its name, for the files. */
  name: string;
  /** What the silicone mold will be cast in. */
  material: CastMaterialId;
  onMaterial: (id: CastMaterialId) => void;
  /** Draft the master carries from Prepare for Casting, degrees; 0 for none. */
  bakedDraftDeg: number;
  /** The tab on show: a hidden one plans nothing. */
  active: boolean;
}

/**
 * A printed pour box for casting a silicone mold of a master: base with a
 * groove, a sleeve that drops into it, and an optional hole through the
 * silicone for a wick, a pour or a fixing.
 */
export const SiliconeBoxPanel: React.FC<SiliconeBoxPanelProps> = ({ onClose, ids, name, material, onMaterial, bakedDraftDeg, active }) => {
  const [options, setOptions] = useState<PourBoxOptions>({ ...DEFAULT_POUR_BOX_OPTIONS });
  const settled = useSettled(options, 250);
  const [box, setBox] = useState<PourBox | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const set = <K extends keyof PourBoxOptions>(key: K, value: PourBoxOptions[K] | undefined) => {
    if (value !== undefined) setOptions((prev) => ({ ...prev, [key]: value }));
  };

  useEffect(() => {
    if (!active) return;
    let live = true;
    planPourBox(useStore.getState().sceneGraph, ids, settled)
      .then((b) => { if (live) { setBox(b); setFailure(null); } })
      .catch((e: Error) => { if (live) { setBox(null); setFailure(e.message); } });
    return () => { live = false; };
  }, [ids, settled, active]);

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
    const pieces: [string, PourBoxMesh][] = [['base', box.base], ['sleeve', box.sleeve]];
    if (box.hole) pieces.push([`${box.hole.purpose}_pin`, holePinMesh(box.hole)]);
    for (const [piece, mesh] of pieces) {
      const bytes = pourBoxStl(mesh, piece);
      downloadBlob(new Blob([bytes.slice().buffer], { type: 'model/stl' }), stlFileName(`${name}_pour_${piece}`));
    }
  };

  // Silicone round the master, the mold turned over and vented, the material
  // poured in: the finished piece and the mold it came out of, in one click.
  const chain = useChainRun([settled, material, ids]);
  const simulate = () => chain.run(async (client) => {
    const r = await client.siliconeChain(useStore.getState().sceneGraph, ids, settled, material);
    if (!r.ok) return { error: r.error };
    await addSiliconeChain(r);
    return {
      piece: r.piece,
      extra: [r.vents.length ? `${r.vents.length} vent${r.vents.length === 1 ? '' : 's'} cut in the silicone mold` : 'No vents needed', ...r.warnings],
    };
  });

  const r = box?.report;
  // Where the hole came out last, to start a picked point from.
  const holeTop: [number, number] | null = r?.holeTopMm ? [r.holeTopMm[0], r.holeTopMm[1]] : null;
  return (
    <>
      <PanelBody>
        <CastTopFields
          tab="silicone"
          material={material}
          onMaterial={onMaterial}
          draftDeg={bakedDraftDeg}
          onDraft={() => {}}
          draftLocked={bakedDraftDeg > 0}
          draftFixedReason="Silicone stretches off the casting, so its cavity takes no draft."
          draftHint=""
        />
        <MaterialNotes notes={castMaterialWarnings(material, 0, { pla: false })} />

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
        <ChainResult title="Simulated: silicone mold, turned over and poured" lines={chain.lines} />

        <AdvancedBlock>
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
              {SILICONES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs" title="A hole through the silicone above the master, made by a printed pin. A pour hole is poured through with the mold standing as it was made; a wick or fixing hole is plugged while the mold is poured through the master's foot.">
            <span className={labelClass}>Hole through the mold</span>
            <select
              value={options.hole ?? 'none'}
              onChange={(e) => {
                const hole = e.target.value === 'none' ? null : (e.target.value as HolePurpose);
                // Each purpose starts at its own size; none keeps no point either.
                setOptions((prev) => ({ ...prev, hole, holeDiaMm: null, ...(hole ? {} : { holeAtMm: null }) }));
              }}
              className={inputClass}
            >
              <option value="none">None</option>
              <option value="wick">For a wick</option>
              <option value="pour">To pour through</option>
              <option value="fixing">For a fixing</option>
            </select>
          </label>
          {options.hole && (
            <>
              <label className="space-y-1 text-xs">
                <span className={labelClass}>Hole Ø (mm)</span>
                <NumberInput min={0.5} step={0.5} allowEmpty placeholder={String(HOLE_DIA_MM[options.hole])} value={options.holeDiaMm} onChange={(v) => setOptions((prev) => ({ ...prev, holeDiaMm: v ?? null }))} className={inputClass} />
              </label>
              <label className="space-y-1 text-xs col-span-2" title="Where on the master the hole starts: its highest point, or a point in plan (mm, as the scene's X and Y).">
                <span className={labelClass}>Hole at</span>
                <div className="flex items-center gap-2">
                  <select
                    value={options.holeAtMm ? 'point' : 'top'}
                    onChange={(e) => set('holeAtMm', e.target.value === 'top' ? null : holeTop ?? [0, 0])}
                    className={inputClass}
                  >
                    <option value="top">Highest point</option>
                    <option value="point">A point (X, Y)</option>
                  </select>
                  {options.holeAtMm && (
                    <>
                      <NumberInput step={1} value={options.holeAtMm[0]} onChange={(v) => v !== undefined && set('holeAtMm', [v, options.holeAtMm![1]])} className={inputClass} />
                      <NumberInput step={1} value={options.holeAtMm[1]} onChange={(v) => v !== undefined && set('holeAtMm', [options.holeAtMm![0], v])} className={inputClass} />
                    </>
                  )}
                </div>
              </label>
            </>
          )}
        </div>
        </AdvancedBlock>
      </PanelBody>

      <PanelFooter>
        <span />
        <div className="flex gap-2">
          <button type="button" disabled={!box || busy} onClick={handleDownload} title="Base, sleeve and any pin, as STLs"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
            <Download className="w-4 h-4" /> STLs
          </button>
          <button type="button" disabled={!box || busy || adding} onClick={() => void handleAdd()} title="The base and sleeve, round the master"
            className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
            {adding ? 'Adding…' : 'Add Pour Box'}
          </button>
          <AddSimulationButton
            disabled={!box || busy || chain.busy}
            onSimulate={() => void simulate()}
            progress={chain.busy ? 0.5 : null}
            error={chain.error}
            label="Simulate Cast"
            besideOnly
          />
        </div>
      </PanelFooter>
    </>
  );
};
