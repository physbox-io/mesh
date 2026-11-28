// Small controls the garment cards share: a labelled slider in display units,
// a section heading, and the select and label styles.

import { RangeInput } from '../../RangeInput';
import { SliderValue } from '../../SliderValue';

export const labelCls = 'text-xs text-slate-500 dark:text-slate-400 font-medium';
export const selectCls = 'w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 cursor-pointer';
export const cardCls = 'flex flex-col gap-2.5 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg';
export const smallButtonCls = 'text-[11px] font-semibold px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer';
export const removeCls = 'text-slate-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer px-1';

export const hex = (rgba: number[]) => `#${rgba.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
export const rgbaOf = (h: string, a: number) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(a);

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
