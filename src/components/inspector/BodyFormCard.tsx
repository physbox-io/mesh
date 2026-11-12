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
  const set = (patch: Partial<Record<keyof BodyFormMeasurements, unknown>>) => updateNode(node.id, { bodyForm: patch } as unknown as Partial<SceneNode>);
  const female = m.figure === 'female';
  const optional = (f: FormField) => !(f in FIGURE_DEFAULTS.male);

  return (
    <div className="flex flex-col gap-2.5 p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Measurements</label>
      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-[11px] font-semibold">
        {(['female', 'male'] as const).map((figure) => (
          <button key={figure} onClick={() => set({ figure })}
            title={`A typical ${figure} figure: changing it starts the measurements again from that figure's`}
            className={`flex-1 py-1.5 capitalize transition-colors cursor-pointer ${m.figure === figure ? 'bg-purple-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`}>
            {figure}
          </button>
        ))}
      </div>
      {FORM_SECTIONS.map((section) => (
        <div key={section.title} className="flex flex-col gap-2">
          <label className="mt-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{section.title}</label>
          {section.fields
            .filter((f) => (!f.figure || f.figure === m.figure) && (!f.legs || m.legs))
            .map(({ field, label, tip }) => (
              <BodyFormSlider key={field}
                label={typeof label === 'string' ? label : label[female ? 1 : 0]} tip={tip}
                value={shown[field]} min={BODY_FORM_LIMITS[field][0]} max={BODY_FORM_LIMITS[field][1]} unit={section.unit}
                isSet={optional(field) ? m[field] !== undefined : undefined}
                onChange={(v) => set({ [field]: v })} onReset={() => set({ [field]: null })} />
            ))}
          {section.title === 'Lengths' && (
            <div className="flex justify-between text-[11px] text-slate-500" title="Waist to floor down the side: the inseam and the rise together">
              <span>Outseam</span><span className="font-mono tabular-nums">{Math.round(shown.outseam * 1000)} mm</span>
            </div>
          )}
        </div>
      ))}
      <label className="flex items-center gap-2 text-xs text-slate-500 font-medium cursor-pointer" title="Off: the form ends at the hips on a stand">
        <input type="checkbox" checked={m.legs} onChange={(e) => set({ legs: e.target.checked })} className="accent-purple-600" />
        Legs
      </label>
    </div>
  );
}
