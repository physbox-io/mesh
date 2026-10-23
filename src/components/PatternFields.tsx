import React from 'react';
import { Shuffle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import type { PatternOptions, PatternSpec } from '../utils/surfacePatterns';
import { FontPicker } from './FontPicker';

/**
 * A surface pattern's own controls, drawn from its `fields` (see
 * PatternSpec): shared by the board generator and the pattern-on-a-face
 * dialog, so a pattern added to the registry shows up in both with nothing
 * written for it.
 */

export const inputClass =
  'w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-fuchsia-500';

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label, hint, children,
}) => (
  <label className="block space-y-1" title={hint}>
    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
    {children}
  </label>
);

export const PatternFields: React.FC<{
  spec: PatternSpec;
  options: PatternOptions;
  onChange: (key: string, value: number | string | undefined) => void;
}> = ({ spec, options, onChange: set }) => (
  <>
    {spec.fields.filter((f) => !f.when || f.when.is.includes(String(options[f.when.key] ?? ''))).map((f) => (
      <React.Fragment key={f.key}>
        {f.section && (
          <div className="pt-2 mt-1 border-t border-slate-200 dark:border-slate-800 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {f.section}
          </div>
        )}
        {fieldControl(spec, f, options, set)}
      </React.Fragment>
    ))}
  </>
);

function fieldControl(
  spec: PatternSpec,
  f: PatternSpec['fields'][number],
  options: PatternOptions,
  set: (key: string, value: number | string | undefined) => void
): React.ReactNode {
  if (f.kind === 'number') {
    return (
      <Field key={f.key} label={f.unit ? `${f.label} (${f.unit})` : f.label} hint={f.hint}>
        <NumberInput
          min={f.min}
          max={f.max}
          step={f.step}
          fallbackOnBlur={Number(spec.defaults[f.key])}
          value={Number(options[f.key])}
          onChange={(v) => set(f.key, v)}
          className={inputClass}
        />
      </Field>
    );
  }
  if (f.kind === 'text') {
    const value = String(options[f.key] ?? '');
    return (
      <Field key={f.key} label={f.label} hint={f.hint}>
        {f.multiline ? (
          <textarea
            value={value}
            rows={Math.min(6, Math.max(2, value.split('\n').length))}
            placeholder={f.placeholder}
            onChange={(e) => set(f.key, e.target.value)}
            className={`${inputClass} resize-y font-medium`}
          />
        ) : (
          <input
            value={value}
            placeholder={f.placeholder}
            onChange={(e) => set(f.key, e.target.value)}
            className={inputClass}
          />
        )}
      </Field>
    );
  }
  if (f.kind === 'font') {
    return (
      <Field key={f.key} label={f.label} hint={f.hint}>
        <FontPicker value={String(options[f.key] ?? '')} onChange={(family) => set(f.key, family)} />
      </Field>
    );
  }
  if (f.kind === 'image') {
    const picked = String(options[f.key] ?? '');
    const w = Number(options.imageW ?? 0), h = Number(options.imageH ?? 0);
    const status = picked ? 'New picture: Apply to read it' : w > 0 ? `Picture ${w} × ${h} px` : 'No picture yet';
    return (
      <Field key={f.key} label={f.label} hint={f.hint}>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            // A data URL: `prepare` decodes it and keeps only the grey grid.
            const reader = new FileReader();
            reader.onload = () => { if (typeof reader.result === 'string') set(f.key, reader.result); };
            reader.readAsDataURL(file);
          }}
          className="block w-full text-xs text-slate-600 dark:text-slate-300 file:mr-2 file:px-2 file:py-1 file:rounded-md file:border-0 file:text-xs file:bg-slate-100 dark:file:bg-slate-800 file:text-slate-700 dark:file:text-slate-200 cursor-pointer"
        />
        <span className="block text-[10px] text-slate-400 dark:text-slate-500">{status}</span>
      </Field>
    );
  }
  if (f.kind === 'choice') {
    return (
      <Field key={f.key} label={f.label} hint={f.hint}>
        <select
          value={String(options[f.key] ?? '')}
          onChange={(e) => set(f.key, e.target.value)}
          className={`${inputClass} cursor-pointer`}
        >
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <Field key={f.key} label={f.label} hint={f.hint}>
      <div className="flex items-center gap-1.5">
        <NumberInput
          min={1}
          max={999999}
          step={1}
          fallbackOnBlur={1}
          value={Number(options[f.key])}
          onChange={(v) => set(f.key, v)}
          className={inputClass}
        />
        <button
          type="button"
          onClick={() => set(f.key, Math.floor(Math.random() * 99999) + 1)}
          title="Try another one of the same kind"
          className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-fuchsia-500 hover:border-fuchsia-500 transition-colors cursor-pointer"
        >
          <Shuffle className="w-3.5 h-3.5" />
        </button>
      </div>
    </Field>
  );
}
