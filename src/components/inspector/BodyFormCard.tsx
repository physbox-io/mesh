import { useMemo } from 'react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { BodyFormMeasurements } from '../../types/cloth';
import { BODY_FORM_LIMITS, FIGURE_DEFAULTS } from '../../utils/cloth/bodyForm';
import { BodyFormSlider } from './BodyFormSlider';
import { FORM_SECTIONS, formMeasurementsShown, type FormField } from './bodyFormFields';

/**
 * A dress form's tape measurements and pose. Each change goes to the store as
 * a change to the body's `bodyForm`; the form, and any garment fitted to it,
 * is rebuilt from it in the background. A measurement left unset follows the
 * usual proportions; a set one is kept in order with the rest, so the value
 * shown can be where it had to go rather than what was typed.
 */
export function BodyFormCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const m = node.bodyForm;
  const shown = useMemo(() => (m ? formMeasurementsShown(m) : null), [m]);
  if (!m || !shown) return null;
  // null unsets an optional measurement (clampBodyForm).
  const set = (patch: Partial<Record<keyof BodyFormMeasurements, unknown>>, settle = false) => updateNode(node.id, { bodyForm: patch } as unknown as Partial<SceneNode>, false, settle);
  const female = m.figure === 'female';
  const optional = (f: FormField) => !(f in FIGURE_DEFAULTS.male);

  return (
    <div className="flex flex-col gap-2.5 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Measurements</label>
      <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px] font-semibold">
        {(['female', 'male'] as const).map((figure) => (
          <button key={figure} onClick={() => set({ figure })}
            title={`A typical ${figure} figure: changing it starts the measurements again from that figure's`}
            className={`flex-1 py-1.5 capitalize transition-colors cursor-pointer ${m.figure === figure ? 'bg-purple-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
            {figure}
          </button>
        ))}
      </div>
      {FORM_SECTIONS.map((section) => (
        <div key={section.title} className="flex flex-col gap-2">
          <label className="mt-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{section.title}</label>
          {section.fields
            .filter((f) => !f.figure || f.figure === m.figure)
            .map(({ field, label, tip }) => (
              <BodyFormSlider key={field}
                label={typeof label === 'string' ? label : label[female ? 1 : 0]} tip={tip}
                value={shown[field]} min={BODY_FORM_LIMITS[field][0]} max={BODY_FORM_LIMITS[field][1]} unit={section.unit}
                isSet={optional(field) ? m[field] !== undefined : undefined}
                onChange={(v) => set({ [field]: v }, true)} onReset={() => set({ [field]: null })} />
            ))}
          {section.title === 'Lengths' && (
            <div className="flex justify-between text-[11px] text-slate-500 dark:text-slate-400" title="Waist to floor down the side: the inseam and the rise together">
              <span>Outseam</span><span className="font-mono tabular-nums">{Math.round(shown.outseam * 1000)} mm</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
