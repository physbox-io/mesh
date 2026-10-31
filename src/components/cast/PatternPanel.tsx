// ---------------------------------------------------------------------------
// Sand and Lost PLA: the printed pattern for a metal casting
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Download, CheckCircle2 } from 'lucide-react';
import type { SceneGraph } from '../../types/scene';
import type { CastMaterialId } from '../../utils/castMaterials';
import { DEFAULT_TAB_DRAFT } from '../../utils/moldTabs';
import { AdvancedBlock, CastTopFields } from './CastTopFields';
import { DEFAULT_CAST_OPTIONS, rememberCastOptions, type CastMethod, type CastOptions } from '../../utils/castPatternExporter';
import { NumberInput } from '@physbox-io/ui';
import { inputClass, sectionClass, sectionTitleClass, Field, Segmented } from '../CarveFields';
import { useSettled } from '../carveTooling';
import { useExportJob } from '../../utils/exportWorkerClient';
import { PatternView } from '../PatternView';
import { useStore } from '../../store/useStore';
import { AddSimulationButton } from '../MachineJobControls';
import { sceneStockTransform, useAddSimulation } from '../../hooks/useAddSimulation';
import { stlToMesh } from '../../utils/stlMesh';
import { PanelBody, PanelFooter } from './CastDialogFrame';
import { ChainResult } from './ChainRun';
import { useChainRun } from './useChainRun';
import { addMetalChain } from '../../utils/castChainActions';
import { CastPrepSection } from './CastPrepSection';
import { patternSteps, round, round1 } from './patternSteps';

/** Hands the browser a binary file to save. */
function downloadBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Casting: turn the model into a pattern to print, and walk the operator
 * through making a mould from it and pouring metal into it.
 *
 * The pattern is a positive, not a cavity, on both routes — but which positive
 * depends on the route, and so does everything downstream of it. Sand
 * rams around a pattern that is pulled back out, so it must draw and the rig
 * is a sprue standing beside it. Lost PLA buries the pattern in plaster and
 * burns it away, so undercuts cost nothing, the rig has to be fused on, and
 * the flask and the investment to mix for it become real numbers the operator
 * needs before they start. One dialog, because the model, the metal, the
 * shrink and the pour weight are the same question either way; the steps below
 * and the fields above swap wholesale with the method.
 */

export const PatternPanel: React.FC<{
  /** What is being cast: the selection, or the whole scene. */
  scene: SceneGraph;
  onClose: () => void;
  method: CastMethod;
  /** The metal, which is the tab's. */
  material: CastMaterialId;
  onMaterial: (id: CastMaterialId) => void;
  /** Draft the model carries from Prepare for Casting, degrees; 0 for none. */
  bakedDraftDeg: number;
  /** The tab on show: a hidden one builds nothing. */
  active: boolean;
  /** Open Advanced from the start (the Cast prep badge, to switch prep off). */
  advancedOpen?: boolean;
}> = ({ onClose, scene, method, material, onMaterial, bakedDraftDeg, active, advancedOpen }) => {
  const [chosen, setOptions] = useState<CastOptions>(() => ({ ...DEFAULT_CAST_OPTIONS, draftDeg: DEFAULT_TAB_DRAFT[method] }));
  const options = useMemo(() => ({ ...chosen, method, metalId: material }), [chosen, method, material]);
  const set = <K extends keyof CastOptions>(key: K, value: CastOptions[K] | undefined) => {
    if (value === undefined) return;
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const settled = useSettled(options, 250);
  // What an agent's chain for this method plans with, as the Rigid tab's are.
  useEffect(() => {
    if (active) rememberCastOptions(settled);
  }, [active, settled]);
  // Prep rewrites the scene several times on its way through; build the
  // preview once, from where it lands.
  const prepBusy = useStore((s) => s.castPrepBusy);
  const addToScene = useAddSimulation();
  const { result, busy, failure } = useExportJob(
    active,
    (client) => (prepBusy ? null : client.run('cast', scene, settled)),
    [scene, settled, prepBusy]
  );

  const summary = result?.success ? result.summary : null;
  const baseName = (scene.name || 'pattern').replace(/[^\w.-]+/g, '_');

  const handleDownload = () => {
    if (!result?.success) return;
    downloadBytes(result.patternStl, `${baseName}_${options.method === 'lost-pla' ? 'burnout' : 'sand'}_pattern.stl`);
  };

  /** The pattern as printed, gating and all, beside the part it was made from. */
  const handleAddToScene = () => {
    if (!result?.success) return;
    void addToScene.add({
      mesh: stlToMesh(result.patternStl),
      transform: sceneStockTransform(),
      kind: 'cast',
      label: options.method === 'lost-pla' ? 'Burnout pattern' : 'Sand pattern',
      placement: 'beside',
    });
  };

  // The pattern in its flask, filled round, taken away and the metal poured:
  // the finished casting beside the master, cut off its gating.
  const chain = useChainRun([settled, scene]);
  const simulate = () => chain.run(async (client) => {
    const r = await client.metalChain(scene, settled);
    if (!r.ok) return { error: r.error };
    await addMetalChain(r, method);
    const [w, d, h] = r.flask.sizeMm;
    return {
      piece: r.piece,
      extra: [
        r.flask.shape === 'box' ? `Flask about ${w} × ${d} × ${h} mm, ${(r.fillG / 1000).toFixed(1)} kg of sand` : `Flask about ⌀${w} × ${h} mm, ${r.fillG} g of investment`,
        ...(r.filledShare !== null && r.filledShare >= 0.97 ? ['The metal reaches every part of the cavity from the sprue'] : []),
        ...r.warnings.slice(0, 3),
      ],
    };
  });

  const metalLabel = summary?.metalLabel ?? '';
  const lostPla = options.method === 'lost-pla';

  return (
    <>
      <PanelBody className="p-4 sm:p-6 space-y-5">
        {/* Metal & pattern */}
        <div className={sectionClass}>
          <h3 className={sectionTitleClass}>Metal &amp; Pattern</h3>
          <CastTopFields
            tab={method}
            material={material}
            onMaterial={onMaterial}
            draftDeg={bakedDraftDeg > 0 ? bakedDraftDeg : options.draftDeg}
            onDraft={(v) => set('draftDeg', v)}
            draftLocked={bakedDraftDeg > 0}
            draftHint={lostPla
              ? 'Taper on the printed pattern. A burnt-out pattern never draws, so it needs none. The model is left as it is.'
              : 'Taper on the printed pattern, so it pulls out of the sand. 1 to 3° is usual. The model is left as it is.'}
          />
          {summary && (
            <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2 space-y-1">
              <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                Pattern {round1(summary.patternSizeMm.x)} × {round1(summary.patternSizeMm.y)} × {round1(summary.patternSizeMm.z)} mm
                ({summary.shrinkPercent}% over the {round1(summary.partSizeMm.x)} × {round1(summary.partSizeMm.y)} × {round1(summary.partSizeMm.z)} mm part) ·
                {' '}{metalLabel} cast ≈ {round(summary.castWeightG)} g ·
                {' '}pour ≈ {round(summary.pourWeightG)} g
              </p>
              {lostPla && summary.flaskDiaMm > 0 && (
                <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                  Flask ⌀{round(summary.flaskDiaMm)} × {round(summary.flaskHeightMm)} mm ·
                  {' '}investment ≈ {round(summary.investmentPowderG)} g powder + {round(summary.investmentWaterG)} g water ·
                  {' '}pattern ≈ {round(summary.patternPlasticG)} g of PLA
                </p>
              )}
              <p className={`text-[10px] leading-snug ${!lostPla && summary.undrawablePercent > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                {lostPla
                  ? summary.undrawablePercent > 1
                    ? `${round(summary.undrawablePercent)}% of this part would not draw from sand at any parting plane — burning the pattern out is exactly what buys you that.`
                    : 'This part would draw from sand too, so sand casting is open to you if you would rather keep the pattern.'
                  : summary.undrawablePercent > 1
                    ? summary.draftDeg > 0
                      ? `${round(summary.undrawablePercent)}% of the part overhangs the pull even with draft — an undercut. Change the shape, or switch to Lost PLA.`
                      : `${round(summary.undrawablePercent)}% of the part overhangs the pull and will not draw cleanly — add Draft, or switch to Lost PLA.`
                    : 'The pattern draws cleanly from the sand: nothing overhangs the upward pull.'}
              </p>
              {busy && <p className="text-[10px] italic text-slate-400">recalculating…</p>}
            </div>
          )}
        </div>

        <ChainResult title="Simulated: poured and shaken out" lines={chain.lines} />

        <AdvancedBlock defaultOpen={advancedOpen}>
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>{lostPla ? 'Sprue, Vents & Shrink' : 'Gating & Shrink'}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label={lostPla ? 'Sprue & Vents' : 'Gating'}
                hint={
                  lostPla
                    ? 'Fuse the sprue, pouring cup and vents onto the pattern, so they burn out with it and leave their channels behind. Turn it off only if you are spruing the pattern yourself with wax or printed rod.'
                    : 'Print the sprue, runner, gate and riser as one piece with the pattern, so ramming the sand forms the pour channels. Turn it off only if you cut your own gating into the sand by hand.'
                }
              >
                <Segmented
                  value={options.addGating ? 'on' : 'off'}
                  onChange={(v) => set('addGating', v === 'on')}
                  options={lostPla ? ([['on', 'Print On'], ['off', 'By Hand']] as const) : ([['on', 'Print In'], ['off', 'By Hand']] as const)}
                />
              </Field>
              {!lostPla && (
                <Field
                  className="lg:col-span-2"
                  label="Riser"
                  hint="A reservoir of metal that stays molten longer than the part and feeds its shrinkage as it freezes, so the casting does not pull a sink. Leave it off only for the thinnest, flattest parts."
                >
                  <Segmented
                    value={options.addRiser ? 'on' : 'off'}
                    onChange={(v) => set('addRiser', v === 'on')}
                    options={[['on', 'Feed It'], ['off', 'None']] as const}
                  />
                </Field>
              )}
              <Field
                label="Sprue Ø (mm)"
                hint="Diameter of the pour column. 0 sizes it from the cast weight."
              >
                <NumberInput
                  step={1} min={0} max={40}
                  allowEmpty
                  placeholder={summary ? String(round(summary.sprueDiaMm)) : 'auto'}
                  value={options.sprueDiaMm || null}
                  onChange={(v) => set('sprueDiaMm', v ?? 0)}
                  className={inputClass}
                />
              </Field>
              {!lostPla && (
                <>
                  <Field
                    label="Riser Ø (mm)"
                    hint="Diameter of the feeder. 0 sizes it from the part's bulk."
                  >
                    <NumberInput
                      step={1} min={0} max={60}
                      allowEmpty
                      placeholder={summary?.riserDiaMm ? String(round(summary.riserDiaMm)) : 'auto'}
                      value={options.riserDiaMm || null}
                      onChange={(v) => set('riserDiaMm', v ?? 0)}
                      className={inputClass}
                    />
                  </Field>
                </>
              )}
              <Field
                label="Shrink (%)"
                hint="How much the pattern is grown so the casting shrinks to size. Empty uses the metal's own figure."
              >
                <NumberInput
                  step={0.1} min={0} max={5}
                  allowEmpty
                  placeholder={summary ? String(summary.shrinkPercent) : 'auto'}
                  value={options.shrinkPercent ?? null}
                  onChange={(v) => setOptions((prev) => ({ ...prev, shrinkPercent: v ?? undefined }))}
                  className={inputClass}
                />
              </Field>
          </div>
          </div>
          <CastPrepSection method={options.method} partingFromBaseMm={options.partingFromBaseMm} />
        </AdvancedBlock>

        {/* The pattern as it will print, part plus gating. Shown even while
            the first one is building, so the box doesn't pop in. Hidden only
            when the job failed, where the error card stands in its place. */}
        {!failure && !(result && !result.success) && (
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Pattern Preview</h3>
            <PatternView stl={result?.success ? result.patternStl : null} />
          </div>
        )}

        {((result && !result.success) || failure) && (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/40 flex items-start space-x-2 text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span className="leading-relaxed">{failure ?? (result && !result.success ? result.error : '')}</span>
          </div>
        )}

        {result?.success && result.warnings.length > 0 && (
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-1.5">
            {result.warnings.map((w, i) => (
              <div key={i} className="flex items-start space-x-2 text-xs text-amber-800 dark:text-amber-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span className="leading-relaxed">{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* Walkthrough */}
        <div className={sectionClass}>
          <h3 className={sectionTitleClass}>{lostPla ? 'The Lost-PLA Flow' : 'The Sand Flow'}</h3>
          <ol className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed list-none">
            {patternSteps(summary, options.addGating, lostPla).map((step, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-orange-500/15 text-orange-700 dark:text-orange-400 text-[10px] font-bold flex items-center justify-center mt-px">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="flex items-start gap-2 text-[11px] leading-snug text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-800 pt-2.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            {lostPla
              ? 'Molten metal is dangerous, and this route adds two of its own. Burnout fumes are not something to breathe — kiln outdoors or properly extracted. And a flask that is not fully burnt out still holds water and plastic: that flashes to steam and throws metal straight back up the cup. Face shield, gloves, and clear the area of anyone who does not need to be there.'
              : 'Molten metal is dangerous. Dry sand and dry tools only — trapped moisture flashes to steam and throws metal. Face shield, gloves, and clear the area of anyone who does not need to be there.'}
          </p>
        </div>
      </PanelBody>

      <PanelFooter>
        <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          {summary && (lostPla || summary.undrawablePercent <= 1) && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              <span>
                {lostPla
                  ? 'One pattern, one casting. Print it, then follow the steps above.'
                  : 'Pattern draws cleanly. Print it, then follow the steps above.'}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            Close
          </button>
          <AddSimulationButton
            disabled={!result?.success || busy}
            onSimulate={handleAddToScene}
            progress={addToScene.progress}
            error={addToScene.error}
            label="Add Pattern"
            besideOnly
          />
          <AddSimulationButton
            disabled={!result?.success || busy || chain.busy}
            onSimulate={() => void simulate()}
            progress={chain.busy ? 0.5 : null}
            error={chain.error}
            label="Simulate Cast"
            besideOnly
          />
          <button
            onClick={handleDownload}
            disabled={!result?.success}
            className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>Download Pattern (STL)</span>
          </button>
        </div>
      </PanelFooter>
    </>
  );
};
