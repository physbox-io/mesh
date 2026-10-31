import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { inputClass, sectionClass, sectionTitleClass, Field, Segmented } from '../CarveFields';
import { useStore } from '../../store/useStore';
import { runCastPrep, type CastPrepOptions, type CastPrepReport } from '../../utils/castPrepRunner';
import type { CastMethod } from '../../utils/castPatternExporter';

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
export function CastPrepSection({ method, partingFromBaseMm }: {
  method: CastMethod;
  partingFromBaseMm: number | 'auto';
}) {
  const prep = useStore((s) => s.sceneGraph.castPrep);
  const busy = useStore((s) => s.castPrepBusy);
  const clearCastPrep = useStore((s) => s.clearCastPrep);
  const bakeCastPrep = useStore((s) => s.bakeCastPrep);

  const [draftDeg, setDraftDeg] = useState(prep?.draftDeg ?? 2);
  const [draftMode, setDraftMode] = useState<'add' | 'remove'>(prep?.draftMode ?? 'add');
  const [edges, setEdges] = useState(prep ? prep.edges !== null : true);
  const [edgeSizeMm, setEdgeSizeMm] = useState<number | null>(null);
  const [report, setReport] = useState<CastPrepReport | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const sand = method === 'sand';
  const opts: CastPrepOptions = {
    method, draftDeg, draftMode, edges, edgeSizeMm: edgeSizeMm ?? 'auto', partingFromBaseMm,
  };
  const key = JSON.stringify(opts);
  const [appliedKey, setAppliedKey] = useState<string | null>(() => (prep ? key : null));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!prep) setAppliedKey(null);
    else if (appliedKey === null) setAppliedKey(key);
  }, [prep, appliedKey, key]);

  const run = async (o: CastPrepOptions) => {
    const k = JSON.stringify(o);
    setAppliedKey(k);
    setNote(null);
    const r = await runCastPrep(o);
    setReport(r);
  };

  const switchOn = () => void run(opts);
  const applyChanges = () => void run(opts);
  const switchOff = () => {
    setAppliedKey(null);
    setReport(null);
    const { kept } = clearCastPrep();
    setNote(kept.length > 0
      ? `Original shapes restored except ${kept.map((k) => k.name).join(', ')}.`
      : 'Original shapes restored.');
  };
  const bakeIn = () => {
    setAppliedKey(null);
    setReport(null);
    bakeCastPrep();
    setNote('Baked into model.');
  };

  const on = !!prep;
  const disabled = !!busy;
  const dirty = on && appliedKey !== null && key !== appliedKey;

  return (
    <div className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={sectionTitleClass}>Prepare for Casting</h3>
        <div className="flex items-center gap-2">
          {on && !busy && (
            <>
              <button
                type="button"
                onClick={applyChanges}
                disabled={!dirty}
                title="Re-run Prepare for Casting with the updated settings"
                className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={bakeIn}
                title="Keep the prepared shapes as the model and forget the originals"
                className="px-2.5 py-1 text-[11px] font-semibold rounded-md text-orange-700 dark:text-orange-300 hover:bg-orange-500/10 transition-colors"
              >
                Bake Into Model
              </button>
            </>
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
              label="Draft in Model (°)"
              hint="Put into the model itself, on every part in the scene, so the viewport and the plain STL carry it. For draft on the printed pattern only, use Draft at the top instead."
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
        Applies to all parts in the scene. Turn off to edit original geometry.
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
          {report.edges
            ? `Applies ${report.draftDeg}° draft from the parting plane and ${report.edges.filletMm} mm edge fillets.`
            : `${report.treated} part${report.treated === 1 ? '' : 's'} prepared${report.draftDeg > 0 ? ` · ${report.draftDeg}° draft` : ''}.`}
        </p>
      )}
      {!busy && on && (prep?.skipped.length ?? 0) > 0 && (
        <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
          Skipped non-manifold parts: {prep!.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}
        </p>
      )}
      {!busy && on && !sand && prep!.draftDeg > 0 && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Sand draft is still active; toggle prep off and on to clear it.
        </p>
      )}
      {!busy && !on && note && (
        <p className="text-[11px] leading-snug text-slate-600 dark:text-slate-300">{note}</p>
      )}
    </div>
  );
}
