import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useSettled } from '../../hooks/useSettled';
import { useStore } from '../../store/useStore';
import { planSlipMold, simulateSlipCastOffThread } from '../../utils/slipMoldClient';
import { addSlipCastToScene, addSlipMoldToScene, slipCaseStls, slipCastInput } from '../../utils/slipMoldActions';
import { DEFAULT_SLIP_WALL_MM, type SlipCastResult } from '../../utils/slipCastSimulation';
import { SlipMoldPreview, type SlipPreviewMode } from './SlipMoldPreview';
import { AddSimulationButton } from '../MachineJobControls';
import { downloadBlob } from '../../utils/downloadBlob';
import { stlFileName } from '../../utils/meshStlExport';
import { DEFAULT_SLIP_MOLD_OPTIONS, MAX_SLIP_SIDES, type SlipMold, type SlipMoldOptions } from '../../utils/slipCastMold';
import { castMaterial, type CastMaterialId } from '../../utils/castMaterials';
import { inputClass, Field } from '../CarveFields';
import { AdvancedBlock, CastTopFields } from './CastTopFields';
import { PanelBody, PanelFooter } from './CastDialogFrame';

type NumberKey = 'plasterMm' | 'spareHeightMm' | 'spareDiaMm' | 'caseWallMm' | 'freeboardMm' | 'natchDiaMm' | 'baseTaperDeg';

const NUMBER_FIELDS: { key: NumberKey; label: string; hint: string; min: number; step: number }[] = [
  { key: 'plasterMm', label: 'Plaster (mm)', hint: 'Plaster round the cavity at its thinnest. Thicker drinks more slip before it is wet through.', min: 10, step: 5 },
  { key: 'spareHeightMm', label: 'Spare height (mm)', hint: 'The reservoir above the part that keeps the slip level up while the wall builds.', min: 5, step: 5 },
  { key: 'spareDiaMm', label: 'Spare mouth (mm)', hint: 'The narrowest the spare opens to. A part narrower at the top gets a funnel.', min: 5, step: 5 },
  { key: 'natchDiaMm', label: 'Natch Ø (mm)', hint: 'The cone keys that line the side pieces up.', min: 6, step: 1 },
  { key: 'baseTaperDeg', label: 'Base taper (°)', hint: 'How much the base plug widens downward, so it seats itself in the sides.', min: 3, step: 1 },
  { key: 'caseWallMm', label: 'Case wall (mm)', hint: 'The printed case walls.', min: 0.8, step: 0.2 },
  { key: 'freeboardMm', label: 'Case rim (mm)', hint: 'Case wall standing past the plaster, so a brim-full pour does not spill.', min: 0, step: 1 },
];

interface SlipCastPanelProps {
  onClose: () => void;
  /** The part: the bodies to mold. */
  ids: string[];
  /** Its name, for the files. */
  name: string;
  material: CastMaterialId;
  onMaterial: (id: CastMaterialId) => void;
  bakedDraftDeg: number;
  /** The tab on show: a hidden one plans nothing. */
  active: boolean;
}

/**
 * A plaster mold for slip casting in n pieces round the part, and a printed
 * case for each piece to cast it in plaster.
 */
export const SlipCastPanel: React.FC<SlipCastPanelProps> = ({ onClose, ids, name, material, onMaterial, bakedDraftDeg, active }) => {
  const [options, setOptions] = useState<SlipMoldOptions>({ ...DEFAULT_SLIP_MOLD_OPTIONS });
  // Draft Prepare for Casting put in the part is not added again.
  const asked = useMemo(() => ({ ...options, slip: material, ...(bakedDraftDeg > 0 ? { draftDeg: 0 } : {}) }), [options, material, bakedDraftDeg]);
  const settled = useSettled(asked, 400);
  // The last plan, and the settings it was for: the last mold stays on show
  // while the next is planned.
  const [planned, setPlanned] = useState<{ key: string; mold: SlipMold | null; failure: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [view, setView] = useState<SlipPreviewMode>('cases');
  const [wallMm, setWallMm] = useState(DEFAULT_SLIP_WALL_MM);
  const [cast, setCast] = useState<{ result: SlipCastResult; of: SlipMold; wallMm: number } | null>(null);
  const [casting, setCasting] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const set = <K extends keyof SlipMoldOptions>(key: K, value: SlipMoldOptions[K] | undefined) => {
    if (value !== undefined) setOptions((prev) => ({ ...prev, [key]: value }));
  };
  const key = JSON.stringify(settled);

  useEffect(() => {
    if (!active) return;
    let live = true;
    planSlipMold(useStore.getState().sceneGraph, ids, JSON.parse(key) as SlipMoldOptions)
      .then((m) => { if (live) setPlanned({ key, mold: m, failure: null }); })
      .catch((e: Error) => { if (live) setPlanned({ key, mold: null, failure: e.message }); });
    return () => { live = false; };
  }, [ids, key, active]);

  const planning = planned?.key !== key;
  const mold = planned?.mold ?? null;
  const failure = planning ? null : planned?.failure ?? null;
  const busy = planning;
  const stale = asked !== settled || planning;
  // A casting of an older mold, or another wall, is not this one's.
  const castNow = cast && cast.of === mold && cast.wallMm === wallMm ? cast.result : null;

  const simulate = async () => {
    if (!mold) return;
    setCasting(true);
    setCastError(null);
    try {
      const result = await simulateSlipCastOffThread(slipCastInput(mold), wallMm);
      setCast({ result, of: mold, wallMm });
      setView('cast');
      await addSlipCastToScene(result, mold);
    } catch (e) {
      setCastError((e as Error).message);
    } finally {
      setCasting(false);
    }
  };

  const handleAdd = async () => {
    if (!mold) return;
    setAdding(true);
    try {
      await addSlipMoldToScene(ids, settled, mold);
      onClose();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleDownload = () => {
    if (!mold) return;
    for (const { file, bytes } of slipCaseStls(name, mold)) {
      downloadBlob(new Blob([bytes.slice().buffer], { type: 'model/stl' }), stlFileName(file));
    }
  };

  const r = mold?.report;
  const slip = castMaterial(material);
  return (
    <>
      <PanelBody>
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Print a case for each piece, fill each with plaster and let it set. Strap the plaster pieces together and pour the slip in at the top.
        </p>
        <CastTopFields
          tab="slip"
          material={material}
          onMaterial={onMaterial}
          draftDeg={bakedDraftDeg > 0 ? bakedDraftDeg : options.draftDeg}
          onDraft={(d) => set('draftDeg', d)}
          draftLocked={bakedDraftDeg > 0}
          draftHint="Each piece's walls lean in away from its parting lines, so it draws off along its own pull. The parting lines keep their size. 0 takes the part as modelled."
        />
        <div className="grid grid-cols-2 gap-3 min-w-0">
          <Field label="Side pieces" hint="Pieces round the part, split through the spare. Auto picks the fewest that pull off without catching.">
            <select
              value={options.sides}
              onChange={(e) => set('sides', e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
              className={inputClass}
            >
              <option value="auto">Auto{r && options.sides === 'auto' ? ` (${r.sides})` : ''}</option>
              {Array.from({ length: MAX_SLIP_SIDES - 1 }, (_, i) => i + 2).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </Field>
          <Field label="Base piece" hint="A tapered plug under the part, so a foot or a recess under it comes out clean. Auto adds one when the part stands on a foot.">
            <select
              value={options.base === 'auto' ? 'auto' : options.base ? 'yes' : 'no'}
              onChange={(e) => set('base', e.target.value === 'auto' ? 'auto' : e.target.value === 'yes')}
              className={inputClass}
            >
              <option value="auto">Auto{r && options.base === 'auto' ? ` (${r.base ? 'yes' : 'no'})` : ''}</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </Field>
        </div>

        <div role="tablist" className="flex gap-1 text-[11px] font-semibold">
          {([['cases', '1 · Print these'], ['mold', '2 · Fill with plaster'], ['cast', '3 · Strap and pour slip']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`px-2.5 py-1 rounded-md cursor-pointer ${view === id ? 'bg-purple-600 text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
              {label}
            </button>
          ))}
        </div>
        <SlipMoldPreview mold={mold} cast={castNow} mode={view} busy={stale} />
        {view === 'cast' && castNow && (
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Fired: {castNow.sizeMm[0]} × {castNow.sizeMm[1]} × {castNow.sizeMm[2]} mm, {castNow.weightG} g. {castNow.notes.join('. ')}.
          </p>
        )}

        {failure || addError ? (
          <p className="text-red-600 dark:text-red-400">{failure ?? addError}</p>
        ) : !r || !mold ? (
          <p className="text-slate-500 dark:text-slate-400">Planning…</p>
        ) : (
          <>
            <dl className={`grid grid-cols-2 gap-y-1 text-xs ${stale ? 'opacity-50' : ''}`}>
              <dt className="text-slate-500 dark:text-slate-400">Pieces</dt>
              <dd className="font-mono">{r.sides} sides{r.base ? ' + base' : ''}</dd>
              <dt className="text-slate-500 dark:text-slate-400">Plaster block</dt>
              <dd className="font-mono">{r.blockMm[0]} × {r.blockMm[1]} × {r.blockMm[2]} mm</dd>
              <dt className="text-slate-500 dark:text-slate-400">Plaster</dt>
              <dd className="font-mono">{r.plasterPowderG} g powder + {r.plasterWaterG} g water</dd>
              <dt className="text-slate-500 dark:text-slate-400">Slip to fill</dt>
              <dd className="font-mono">~{r.slipMl} ml</dd>
              <dt className="text-slate-500 dark:text-slate-400">Shrink</dt>
              <dd className="font-mono">{r.shrinkPercent}% (part grown ×{r.scale})</dd>
            </dl>
            <ul className={`text-xs space-y-0.5 ${stale ? 'opacity-50' : ''}`}>
              {mold.pieces.map((p) => (
                <li key={p.name} className="flex justify-between gap-2">
                  <span className="capitalize">{p.name} case</span>
                  <span className="font-mono text-slate-500 dark:text-slate-400">{p.caseSizeMm[0]} × {p.caseSizeMm[1]} × {p.caseSizeMm[2]} mm</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-500 dark:text-slate-400">Print each case open side up and fill it to the brim with pottery plaster.</p>
            {r.warnings.map((w) => (
              <p key={w} className="flex gap-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{w}</span>
              </p>
            ))}
          </>
        )}

        <AdvancedBlock>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cast wall (mm)" hint="How thick the clay builds before the slip is poured out: about 3-5 mm in 15-25 minutes. Simulate Cast uses it.">
              <NumberInput min={1} max={15} step={0.5} value={wallMm} onChange={(v) => v !== undefined && setWallMm(v)} className={inputClass} />
            </Field>
            <Field label="Shrink (%)" hint={`Wet to fired, linear. The mold is grown by it, so the fired piece comes out as modelled. ${slip.label}: about ${slip.shrinkPercent ?? 0}%.`}>
              <NumberInput min={0} max={30} step={0.5} allowEmpty placeholder={String(slip.shrinkPercent ?? 0)} value={options.shrinkPercent} onChange={(v) => setOptions((prev) => ({ ...prev, shrinkPercent: v ?? null }))} className={inputClass} />
            </Field>
            <Field label="Fill the inside" hint="Treat the inside of a vessel as slip, so no plaster core is left in it.">
              <select value={options.fillInside ? 'yes' : 'no'} onChange={(e) => set('fillInside', e.target.value === 'yes')} className={inputClass}>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Field>
            {NUMBER_FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <NumberInput min={f.min} step={f.step} value={options[f.key]} onChange={(v) => set(f.key, v)} className={inputClass} />
              </Field>
            ))}
          </div>
        </AdvancedBlock>
      </PanelBody>

      <PanelFooter>
        <span />
        <div className="flex gap-2">
          <button type="button" disabled={!mold || stale} onClick={handleDownload} title="One STL per case, stood open side up"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
            <Download className="w-4 h-4" /> Case STLs
          </button>
          <button type="button" disabled={!mold || stale || adding || busy} onClick={() => void handleAdd()} title="The plaster mold round the part, and its cases beside it"
            className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 cursor-pointer">
            {adding ? 'Adding…' : 'Add to Scene'}
          </button>
          <AddSimulationButton
            disabled={!mold || stale || casting}
            onSimulate={() => void simulate()}
            progress={casting ? 0.5 : null}
            error={castError}
            label="Simulate Cast"
            besideOnly
          />
        </div>
      </PanelFooter>
    </>
  );
};
