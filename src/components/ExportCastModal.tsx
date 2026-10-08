import React, { useEffect, useRef, useState } from 'react';
import { X, AlertCircle, Flame, Download, CheckCircle2, Loader2 } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import {
  CAST_METALS,
  CAST_METHODS,
  DEFAULT_CAST_OPTIONS,
  type CastMethod,
  type CastOptions,
} from '../utils/castPatternExporter';
import { NumberInput } from '@physbox-io/ui';
import { inputClass, sectionClass, sectionTitleClass, Field, Segmented } from './CarveFields';
import { useSettled } from './carveTooling';
import { useExportJob } from '../utils/exportWorkerClient';
import { PatternView } from './PatternView';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useStore } from '../store/useStore';
import { runCastPrep, type CastPrepOptions, type CastPrepReport } from '../utils/castPrepRunner';

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

/** The walkthrough's note on what Prepare for Casting put into the model. */
function prepLine(draftDeg: number, edges: { chamferMm: number; filletMm: number } | null): string {
  const parts: string[] = [];
  if (draftDeg > 0) parts.push(`the walls carry ${draftDeg}° of draft`);
  if (edges && (edges.chamferMm > 0 || edges.filletMm > 0)) {
    parts.push(`outside edges are chamfered up to ${edges.chamferMm} mm and inside corners filleted up to ${edges.filletMm} mm`);
  }
  const text = parts.join('; ');
  return `The model is prepared for casting: ${text}. It is in the model itself, so the plain STL export has it too.`;
}
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How hot to have the flask when the metal goes in, °C. Investment is poured
 * into a flask still well above room temperature so thin sections do not chill
 * off mid-fill, and the rule of thumb across the hobby range is roughly half
 * the pour temperature — cooler for aluminium, glowing for silver and bronze —
 * kept inside what plaster investment survives and rounded to something a kiln
 * dial can actually be set to.
 */
const flaskTempC = (pourC: number) => Math.round(Math.min(550, Math.max(200, pourC * 0.55)) / 25) * 25;

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

export const ExportCastModal: React.FC<Props> = ({ isOpen, onClose, scene }) => {
  useEscapeToClose(isOpen, onClose);
  const [options, setOptions] = useState<CastOptions>(DEFAULT_CAST_OPTIONS);
  const set = <K extends keyof CastOptions>(key: K, value: CastOptions[K] | undefined) => {
    if (value === undefined) return;
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const settled = useSettled(options, 250);
  // Prep rewrites the scene several times on its way through; build the
  // preview once, from where it lands.
  const prepBusy = useStore((s) => s.castPrepBusy);
  const { result, busy, failure } = useExportJob(
    isOpen,
    (client) => (prepBusy ? null : client.run('cast', scene, settled)),
    [scene, settled, prepBusy]
  );

  if (!isOpen) return null;

  const summary = result?.success ? result.summary : null;
  const baseName = (scene.name || 'pattern').replace(/[^\w.-]+/g, '_');

  const handleDownload = () => {
    if (!result?.success) return;
    downloadBytes(result.patternStl, `${baseName}_${options.method === 'lost-pla' ? 'burnout' : 'sand'}_pattern.stl`);
  };

  const metalLabel = summary?.metalLabel ?? '';
  const lostPla = options.method === 'lost-pla';

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
                Cast in Metal
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                {lostPla
                  ? 'Print a pattern, invest it in plaster, burn it out, and pour metal into the space it left'
                  : 'Print a pattern, ram it in sand, and pour metal into the hollow it leaves'}
              </p>
            </div>
          </div>
          <button aria-label="Close" title="Close"
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 space-y-5">

          {/* Method — everything below it changes with this, so it leads. */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Method</h3>
            <Segmented
              value={options.method}
              onChange={(v) => set('method', v as CastMethod)}
              options={CAST_METHODS.map((m) => [m.id, m.label] as const)}
            />
            <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
              {CAST_METHODS.find((m) => m.id === options.method)?.blurb}{' '}
              {lostPla
                ? 'The pattern is consumed, so undercuts and re-entrant detail cost nothing — but it is one pattern per casting, and the flask has to be fired.'
                : 'The pattern survives, so you can ram it again and again — but it has to pull out of the sand, which rules out undercuts.'}
            </p>
          </div>

          <CastPrepSection isOpen={isOpen} method={options.method} partingFromBaseMm={options.partingFromBaseMm} />

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
            </div>

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
                        : `${round(summary.undrawablePercent)}% of the part overhangs the pull and will not draw cleanly — turn on Prepare for Casting, or switch to Lost PLA.`
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
            <h3 className={sectionTitleClass}>{lostPla ? 'The Lost-PLA Flow' : 'The Sand Flow'}</h3>
            <ol className="space-y-2.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed list-none">
              {[
                ...(summary && (summary.draftDeg > 0 || summary.edgesMm) ? [prepLine(summary.draftDeg, summary.edgesMm)] : []),
                ...(lostPla ? [
                summary
                  ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm, ≈${round(summary.patternPlasticG)} g). It is grown ${summary.shrinkPercent}% so the casting shrinks to the ${round1(summary.partSizeMm.x)} × ${round1(summary.partSizeMm.y)} × ${round1(summary.partSizeMm.z)} mm part. Print it hollow — two or three walls, about 10% infill — so there is less plastic to burn and less of it to push outwards as it softens. Every layer line ends up in the casting, so fine layers and a sand or a filler-primer skim pay off here.`
                  : 'Print the pattern once the model is ready.',
                options.addGating
                  ? 'The sprue, cup and vents are printed on. Check the sprue is fused to the pattern rather than balanced on it, and drill a small drain hole from the hollow interior into the sprue so the melted PLA has a way out.'
                  : 'Sprue it yourself: a rod from the heaviest section up to a pouring cup, and a thin vent from each high point and blind pocket up to the top of the flask.',
                summary && summary.flaskDiaMm > 0
                  ? `Stand it in a flask about ⌀${round(summary.flaskDiaMm)} × ${round(summary.flaskHeightMm)} mm, cup upwards and level with the flask top, and seal the base with tape or clay. That leaves roughly 12 mm of investment all round, which is the least that reliably holds.`
                  : 'Stand it in a flask, cup upwards and level with the flask top, sealed at the base.',
                summary && summary.investmentPowderG > 0
                  ? `Mix about ${round(summary.investmentPowderG)} g of investment into ${round(summary.investmentWaterG)} g of water — powder into water, never the other way — for three minutes. Vacuum or vibrate the bubbles out, pour down the side of the flask rather than over the pattern, debubble again, and leave it to set for at least two hours.`
                  : 'Mix the investment, debubble it, pour it down the side of the flask and leave it to set.',
                'Burn out in a kiln, flask inverted over a tray so the PLA drains. Hold around 150°C to drive off the water, ramp to 300°C to soften and run the plastic out, then up to 730°C and hold until no smoke comes off and the sprue hole glows clean inside. Call it six to eight hours; rushing it cracks the flask.',
                summary
                  ? `Bring the flask down to about ${flaskTempC(summary.pourC)}°C and hold it there — hot enough that the metal does not chill off in the thin sections, cool enough that the casting is not a coarse grain.`
                  : 'Bring the flask down to pouring temperature and hold it there.',
                summary
                  ? `Melt and pour about ${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at roughly ${summary.pourC}°C — casting plus sprue and cup, with a margin. Pour in one go and keep the cup full; vacuum-assist or a centrifuge if the part has thin sections.`
                  : 'Melt the metal and pour it in one go, keeping the cup full.',
                'Let it freeze, then quench the flask in a bucket of water — the investment shatters off. Cut off the sprue and vents (remelt them), and finish the part.',
              ] : [
                summary
                  ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm). It is grown ${summary.shrinkPercent}% so the casting shrinks to the ${round1(summary.partSizeMm.x)} × ${round1(summary.partSizeMm.y)} × ${round1(summary.partSizeMm.z)} mm part. Print it solid, and sand or seal the layer lines for a cleaner mould.`
                  : 'Print the pattern once the model is ready.',
                'Set the pattern flat-back-down in the drag (the lower half of the flask), parting face on the board. Dust it with parting powder so the sand releases.',
                'Ram sand over it, firm and even, strike off level, then roll the drag over.',
                'Dust the parting face, set the cope (upper half) on top, and ram it full.'
                  + (options.addGating ? ' The printed sprue and riser form their own openings.' : ' Set a sprue pin and a riser pin, then ram around them.'),
                'Lift the cope off, gently draw the pattern straight up out of the drag, and cut a short gate from the runner into the cavity if you rammed one by hand. Poke a few fine vents.',
                'Close the cope back onto the drag. Weight it or clamp it, so the metal head does not lift the cope.',
                summary
                  ? `Melt and pour about ${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at roughly ${summary.pourC}°C — cast plus gating, with a margin. Pour steadily and keep the sprue full.`
                  : 'Melt the metal and pour it steadily, keeping the sprue full.',
                'Let it freeze and cool, then shake out. Cut off the sprue, runner and riser (remelt them), and finish the part.',
              ]),
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
              {lostPla
                ? 'Molten metal is dangerous, and this route adds two of its own. Burnout fumes are not something to breathe — kiln outdoors or properly extracted. And a flask that is not fully burnt out still holds water and plastic: that flashes to steam and throws metal straight back up the cup. Face shield, gloves, and clear the area of anyone who does not need to be there.'
                : 'Molten metal is dangerous. Dry sand and dry tools only — trapped moisture flashes to steam and throws metal. Face shield, gloves, and clear the area of anyone who does not need to be there.'}
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
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

/**
 * "Prepare for casting": puts the draft and edge breaks a pattern wants onto
 * every part in the scene, in the model itself, and takes them off again.
 * See utils/castPrep.ts for what it does and castPrepRunner.ts for how.
 *
 * The switch reads the scene, not local state, so it shows what the model
 * actually carries — after an undo, or a reload of a prepped scene, too.
 * Changing a setting while it is on re-runs it from the originals once the
 * setting stops moving.
 */
function CastPrepSection({ isOpen, method, partingFromBaseMm }: {
  isOpen: boolean;
  method: CastMethod;
  partingFromBaseMm: number | 'auto';
}) {
  const prep = useStore((s) => s.sceneGraph.castPrep);
  const busy = useStore((s) => s.castPrepBusy);
  const clearCastPrep = useStore((s) => s.clearCastPrep);
  const bakeCastPrep = useStore((s) => s.bakeCastPrep);

  const [draftDeg, setDraftDeg] = useState(prep?.draftDeg || 2);
  const [draftMode, setDraftMode] = useState<'add' | 'remove'>(prep?.draftMode ?? 'add');
  const [edges, setEdges] = useState(prep ? prep.edges !== null : true);
  const [edgeSizeMm, setEdgeSizeMm] = useState<number | null>(null);
  const [report, setReport] = useState<CastPrepReport | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const sand = method === 'sand';
  const opts: CastPrepOptions = {
    method, draftDeg, draftMode, edges, edgeSizeMm: edgeSizeMm ?? 'auto', partingFromBaseMm,
  };
  // A string, so the settle timer restarts on a real change and not on every render.
  const key = JSON.stringify(opts);
  const settledKey = useSettled(key, 400);
  const applied = useRef<string | null>(null);

  const run = async (o: CastPrepOptions) => {
    applied.current = JSON.stringify(o);
    setNote(null);
    const r = await runCastPrep(o);
    setReport(r);
  };

  // Re-run from the originals when a setting changes while prep is on.
  useEffect(() => {
    if (!isOpen || !prep || busy) return;
    // Opened onto a scene prepped earlier: take it as it is.
    if (applied.current === null) { applied.current = settledKey; return; }
    if (settledKey === applied.current) return;
    void run(JSON.parse(settledKey) as CastPrepOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, settledKey, !!prep, busy]);

  const switchOn = () => void run(opts);
  const switchOff = () => {
    applied.current = null;
    setReport(null);
    const { kept } = clearCastPrep();
    setNote(kept.length > 0
      ? `Back to the original shapes — except ${kept.map((k) => k.name).join(', ')}, changed since prep, which ${kept.length === 1 ? 'was' : 'were'} left as ${kept.length === 1 ? 'it is' : 'they are'}.`
      : 'Back to the original shapes.');
  };
  const bakeIn = () => {
    applied.current = null;
    setReport(null);
    bakeCastPrep();
    setNote('Kept as the model. The originals are gone, so edit the prepared shapes from here — or undo.');
  };

  const on = !!prep;
  const disabled = !!busy;

  return (
    <div className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={sectionTitleClass}>Prepare for Casting</h3>
        <div className="flex items-center gap-2">
          {on && !busy && (
            <button
              type="button"
              onClick={bakeIn}
              title="Keep the prepared shapes as the model and forget the originals"
              className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-orange-700 dark:text-orange-300 hover:bg-orange-500/10 transition-colors"
            >
              Bake Into Model
            </button>
          )}
          <div className="w-32">
            <Segmented
              value={on ? 'on' : 'off'}
              onChange={(v) => (v === 'on' ? (on ? undefined : switchOn()) : (on ? switchOff() : undefined))}
              options={[['off', 'Off'], ['on', 'On']] as const}
              disabled={disabled}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {sand && (
          <>
            <Field
              label="Draft (°)"
              hint="How far every wall leans away from the parting plane, so the pattern pulls cleanly out of the sand. 1–3° is usual; 0 for none."
            >
              <NumberInput
                step={0.5} min={0} max={10}
                value={draftDeg}
                onChange={(v) => setDraftDeg(v ?? 0)}
                disabled={disabled}
                className={inputClass}
              />
            </Field>
            <Field
              label="Draft Direction"
              hint="Add Material grows the walls toward the parting line, so no face is ever undersize. Remove Material shrinks them away from it, so the parting outline keeps its size."
            >
              <Segmented
                value={draftMode}
                onChange={setDraftMode}
                options={[['add', 'Add'], ['remove', 'Remove']] as const}
                disabled={disabled || draftDeg === 0}
              />
            </Field>
          </>
        )}
        <Field
          label="Edges"
          hint={sand
            ? 'Chamfer the outside edges, which would otherwise leave a crumbly knife-edge of sand, and fillet the inside corners, where a sharp one makes a hot spot the casting cracks at. The parting face stays sharp.'
            : 'Chamfer the outside edges and fillet the inside corners, where a sharp one makes a hot spot the casting cracks at.'}
        >
          <Segmented
            value={edges ? 'on' : 'off'}
            onChange={(v) => setEdges(v === 'on')}
            options={[['on', 'Break'], ['off', 'Leave']] as const}
            disabled={disabled}
          />
        </Field>
        <Field
          label="Edge Size (mm)"
          hint="The outside chamfer; inside fillets are half again as big. Empty sizes it to each part. An edge too short for it gets as much as fits."
        >
          <NumberInput
            step={0.5} min={0.3} max={20}
            allowEmpty
            placeholder="auto"
            value={edgeSizeMm}
            onChange={(v) => setEdgeSizeMm(v ?? null)}
            disabled={disabled || !edges}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
        {sand
          ? 'Applies to every part, in the model itself, so the viewport and the plain STL export see it too. Draft is baked into the shapes, so editing is locked while it is on — switch it off to get the originals back.'
          : 'Applies to every part, as ordinary roundings you can still edit. A burnt-out pattern never draws, so it needs no draft.'}
      </p>

      {busy && (
        <p className="flex items-center gap-1.5 text-[11px] text-orange-700 dark:text-orange-300">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> {busy}
        </p>
      )}
      {!busy && report && !report.ok && (
        <p className="text-[11px] text-red-600 dark:text-red-400">{report.error}</p>
      )}
      {!busy && on && report?.ok && (
        <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-300">
          {report.treated} part{report.treated === 1 ? '' : 's'} prepared
          {report.draftDeg > 0 ? ` · ${report.draftDeg}° draft` : ''}
          {report.edges ? ` · edges up to ${report.edges.chamferMm} mm chamfer, ${report.edges.filletMm} mm fillet` : ''}
          {report.sharpEdges > 0 ? ` · ${report.sharpEdges} edge${report.sharpEdges === 1 ? '' : 's'} too short to break, left sharp` : ''}.
        </p>
      )}
      {!busy && on && (prep?.skipped.length ?? 0) > 0 && (
        <ul className="text-[11px] leading-snug text-amber-700 dark:text-amber-400 list-disc pl-4">
          {prep!.skipped.map((s, i) => <li key={i}><span className="font-semibold">{s.name}</span>: {s.reason}</li>)}
        </ul>
      )}
      {!busy && on && !sand && prep!.draftDeg > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Draft from the sand setup is still baked in. A burnt-out pattern does not need it; switch prep off and on to drop it.
        </p>
      )}
      {!busy && !on && note && (
        <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-300">{note}</p>
      )}
    </div>
  );
}
