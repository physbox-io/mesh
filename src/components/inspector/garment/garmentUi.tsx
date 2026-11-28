// Small controls the garment cards share: a labelled slider in display units,
// a checkbox and a section heading. Their styles are in garmentStyle.ts.

import { RangeInput } from '../../RangeInput';
import { SliderValue } from '../../SliderValue';



export function Heading({ children }: { children: string }) {
  return <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">{children}</label>;
}

/** A value stored in metres (or a fraction) shown as mm (or %): `scale` 1000 or 100. */
export function FieldSlider({ title, tip, value, min, max, step, unit = 'mm', scale = 1000, decimals = 0, onChange }: {
  title: string; tip: string; value: number; min: number; max: number; step: number; unit?: string; scale?: number; decimals?: number; onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1" title={tip}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">{title}</span>
        <SliderValue value={value} onChange={onChange} decimals={decimals} unit={unit || undefined} scale={scale} min={min} max={max} className="text-xs text-slate-500 dark:text-slate-400" />
      </div>
      <RangeInput min={min} max={max} step={step} value={value} onChange={onChange} className="w-full cursor-pointer accent-purple-600" />
    </div>
  );
}

export function Check({ label, tip, checked, onChange, disabled }: { label: string; tip: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 ${disabled ? 'opacity-50' : 'cursor-pointer'}`} title={tip}>
      <input type="checkbox" className="accent-purple-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
