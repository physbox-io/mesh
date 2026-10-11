import React from 'react';
import { Shuffle } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import type { PatternOptions, PatternSpec } from '../utils/surfacePatterns';

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
    {spec.fields.map((f) => {
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
    })}
  </>
);
