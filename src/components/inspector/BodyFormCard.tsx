import { useMemo, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { BodyFormMeasurements } from '../../types/cloth';
import { BODY_FORM_LIMITS, FIGURE_DEFAULTS, SKIN_TONE_CSS_GRADIENT, skinToneLabel, skinToneRgba } from '../../utils/cloth/bodyForm';
import { applySkinTone } from '../../utils/cloth/bodyFormEdit';
import { BodyFormSlider } from './BodyFormSlider';
import { FORM_SECTIONS, formMeasurementsShown, type FormField } from './bodyFormFields';

const cssRgb = ([r, g, b]: [number, number, number, number]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

/**
 * A dress form's tape measurements, pose and complexion. Measurement changes go
 * to the store as changes to `bodyForm` and rebuild the form and fitted garments
 * in the background; `skinTone` updates all form geoms' `rgba` in O(1) in-place
 * without re-meshing or re-settling cloth.
 */
export function BodyFormCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const draggingToneRef = useRef(false);
  const m = node.bodyForm;
  const shown = useMemo(() => (m ? formMeasurementsShown(m) : null), [m]);
  if (!m || !shown) return null;
  // null unsets an optional measurement (clampBodyForm).
  const set = (patch: Partial<Record<keyof BodyFormMeasurements, unknown>>, settle = false) => updateNode(node.id, { bodyForm: patch } as unknown as Partial<SceneNode>, false, settle);
  const setSkinTone = (tone: number | null, recordUndo: boolean) => {
    if (recordUndo) useStore.getState().recordInteraction('node');
    updateNode(
      node.id,
      {
        bodyForm: { skinTone: tone },
        ...(node.geoms?.length ? { geoms: applySkinTone(node.geoms, tone) } : {}),
      } as unknown as Partial<SceneNode>,
      true,
    );
  };
  const female = m.figure === 'female';
  const optional = (f: FormField) => !(f in FIGURE_DEFAULTS.male);
  const swatchRgba = skinToneRgba(m.skinTone);
  const toneName = skinToneLabel(m.skinTone);

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
      <div className="flex flex-col gap-1.5 pt-0.5" title="Perceptual human complexion spectrum spanning deep espresso, reddish mahogany, warm umber, golden bronze, terracotta, olive, honey, peach and rosy porcelain (unset: neutral studio plaster)">
        <div className="flex items-center justify-between gap-1.5">
          <label className="text-xs text-slate-500 dark:text-slate-400 font-medium">Skin tone</label>
          <span className="flex items-center gap-1.5 min-w-0">
            <span
              aria-hidden
              className="w-3.5 h-3.5 rounded-full border border-slate-300 dark:border-slate-600 shrink-0 shadow-xs"
              style={{ backgroundColor: cssRgb(swatchRgba) }}
            />
            <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{toneName}</span>
            {m.skinTone !== undefined && (
              <button
                type="button"
                onClick={() => setSkinTone(null, true)}
                title="Reset to neutral studio plaster"
                className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </span>
        </div>
        <input
          type="range"
          aria-label="Skin tone"
          min={0}
          max={1}
          step={0.005}
          value={m.skinTone ?? 0.75}
          onPointerDown={() => {
            if (!draggingToneRef.current) {
              draggingToneRef.current = true;
              useStore.getState().recordInteraction('node');
            }
          }}
          onPointerUp={() => { draggingToneRef.current = false; }}
          onPointerCancel={() => { draggingToneRef.current = false; }}
          onBlur={() => { draggingToneRef.current = false; }}
          onChange={(e) => setSkinTone(parseFloat(e.target.value), !draggingToneRef.current)}
          style={{ background: SKIN_TONE_CSS_GRADIENT }}
          className="w-full h-2.5 rounded-full appearance-none cursor-pointer border border-slate-300/80 dark:border-slate-700 accent-white shadow-inner"
        />
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
