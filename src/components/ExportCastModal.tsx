import React, { useState } from 'react';
import { X, AlertCircle, Flame, Download, CheckCircle2 } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import {
  CAST_METALS,
  DEFAULT_CAST_OPTIONS,
  type CastOptions,
} from '../utils/castPatternExporter';
import { NumberInput } from '@physbox-io/ui';
import { inputClass, sectionClass, sectionTitleClass, Field, Segmented } from './CarveFields';
import { useSettled } from './carveTooling';
import { useExportJob } from '../utils/exportWorkerClient';
import { PatternView } from './PatternView';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
}

/** Hands the browser a binary file to save. */
function downloadBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const round = (n: number) => Math.round(n);
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Green-sand casting: turn the model into a pattern to print, and walk the
 * operator through packing, pouring and shaking out.
 *
 * The pattern is the positive you ram sand around, not a cavity. This dialog
 * makes it, sizes the gating, checks it will draw, and lays out the foundry
 * steps with the part's own numbers filled in.
 */
export const ExportCastModal: React.FC<Props> = ({ isOpen, onClose, scene }) => {
  const [options, setOptions] = useState<CastOptions>(DEFAULT_CAST_OPTIONS);
  const set = <K extends keyof CastOptions>(key: K, value: CastOptions[K] | undefined) => {
    if (value === undefined) return;
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const settled = useSettled(options, 250);
  const { result, busy, failure } = useExportJob(
    isOpen,
    (client) => client.run('cast', scene, settled),
    [scene, settled]
  );

  if (!isOpen) return null;

  const summary = result?.success ? result.summary : null;
  const baseName = (scene.name || 'pattern').replace(/[^\w.-]+/g, '_');

  const handleDownload = () => {
    if (!result?.success) return;
    downloadBytes(result.patternStl, `${baseName}_pattern.stl`);
  };

  const metalLabel = summary?.metalLabel ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded-lg">
              <Flame className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Cast in Metal (Green Sand)
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Print a pattern, ram it in sand, and pour metal into the hollow it leaves
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 space-y-5">

          {/* Metal & pattern */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Metal &amp; Pattern</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Metal"
                hint="What you will pour. It sets the shrink allowance the pattern is grown by, the weight estimate, and the pour temperature. Aluminium is the easy one to melt at home."
              >
                <select
                  value={options.metalId}
                  onChange={(e) => set('metalId', e.target.value)}
                  className={inputClass}
                >
                  {CAST_METALS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </Field>
              <Field
                className="lg:col-span-2"
                label="Gating"
                hint="Print the sprue, runner, gate and riser as one piece with the pattern, so ramming the sand forms the pour channels. Turn it off only if you cut your own gating into the sand by hand."
              >
                <Segmented
                  value={options.addGating ? 'on' : 'off'}
                  onChange={(v) => set('addGating', v === 'on')}
                  options={[['on', 'Print In'], ['off', 'By Hand']] as const}
                />
              </Field>
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
              <Field
                className="lg:col-span-2"
                label="Recommended Draft (°)"
                hint="The taper to put on vertical walls, in your model, so the pattern pulls from the sand. This is advice for the report, not applied to the geometry — add it in the modeller, or leave it if the part already draws."
              >
                <NumberInput
                  step={1} min={0} max={10}
                  value={options.recommendedDraftDeg}
                  onChange={(v) => set('recommendedDraftDeg', v ?? 2)}
                  className={inputClass}
                />
              </Field>
            </div>

            {summary && (
              <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2 space-y-1">
                <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                  Pattern {round1(summary.patternSizeMm.x)} × {round1(summary.patternSizeMm.y)} × {round1(summary.patternSizeMm.z)} mm
                  ({summary.shrinkPercent}% over the {round1(summary.partSizeMm.x)} × {round1(summary.partSizeMm.y)} × {round1(summary.partSizeMm.z)} mm part) ·
                  {' '}{metalLabel} cast ≈ {round(summary.castWeightG)} g ·
                  {' '}pour ≈ {round(summary.pourWeightG)} g
                </p>
                <p className={`text-[10px] leading-snug ${summary.undrawablePercent > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  {summary.undrawablePercent > 1
                    ? `${round(summary.undrawablePercent)}% of the part overhangs the pull and will not draw cleanly — add draft or use lost-foam.`
                    : 'The pattern draws cleanly from the sand: nothing overhangs the upward pull.'}
                </p>
                {busy && <p className="text-[10px] italic text-slate-400">recalculating…</p>}
              </div>
            )}
          </div>

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
            <h3 className={sectionTitleClass}>The Green-Sand Flow</h3>
            <ol className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed list-none">
              {[
                summary
                  ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm). It is grown ${summary.shrinkPercent}% so the casting shrinks to the ${round1(summary.partSizeMm.x)} × ${round1(summary.partSizeMm.y)} × ${round1(summary.partSizeMm.z)} mm part. Print it solid, and sand or seal the layer lines for a cleaner mould.`
                  : 'Print the pattern once the model is ready.',
                'Set the pattern flat-back-down in the drag (the lower half of the flask), parting face on the board. Dust it with parting powder so the sand releases.',
                'Ram green sand over it, firm and even, strike off level, then roll the drag over.',
                'Dust the parting face, set the cope (upper half) on top, and ram it full.'
                  + (options.addGating ? ' The printed sprue and riser form their own openings.' : ' Set a sprue pin and a riser pin, then ram around them.'),
                'Lift the cope off, gently draw the pattern straight up out of the drag, and cut a short gate from the runner into the cavity if you rammed one by hand. Poke a few fine vents.',
                'Close the cope back onto the drag. Weight it or clamp it, so the metal head does not lift the cope.',
                summary
                  ? `Melt and pour about ${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at roughly ${summary.pourC}°C — cast plus gating, with a margin. Pour steadily and keep the sprue full.`
                  : 'Melt the metal and pour it steadily, keeping the sprue full.',
                'Let it freeze and cool, then shake out. Cut off the sprue, runner and riser (remelt them), and finish the part.',
              ].map((step, i) => (
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
              Molten metal is dangerous. Dry sand and dry tools only — trapped moisture flashes to steam and throws metal. Face shield, gloves, and clear the area of anyone who does not need to be there.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {summary && summary.undrawablePercent <= 1 && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                <span>Pattern draws cleanly. Print it, then follow the steps above.</span>
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
            <button
              onClick={handleDownload}
              disabled={!result?.success}
              className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download Pattern (STL)</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
