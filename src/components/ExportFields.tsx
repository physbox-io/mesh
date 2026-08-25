// ---------------------------------------------------------------------------
// The small controls every export modal is built out of
// ---------------------------------------------------------------------------
//
// `Field`, `Advanced` and `Segmented` were written once and then copied into
// each export modal as it was added, so there are now several identical copies
// of each drifting slowly apart. This is the shared home for them.
//
// The three existing modals have not been migrated onto it — that is a
// mechanical change across three large files and it does not belong in the same
// breath as a new feature. New modals use this; the others should follow.

import React, { useState } from 'react';
import { ChevronRight, Info } from 'lucide-react';

export const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4';

export const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

export const labelClass =
  'text-[11px] font-semibold text-slate-600 dark:text-slate-300 truncate';

export const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-40';

/**
 * Hover/focus bubble that explains one control, so the labels can stay short.
 *
 * Positioned against the field's label row rather than the icon, so it starts
 * at the cell's own left edge and a narrow screen cannot push it out of view.
 * Fields in the last column pass `hintAlign="end"` to open leftward: an
 * absolutely positioned child still counts towards its scroll container's
 * width, and a bubble hanging off the right drags a horizontal scrollbar under
 * the whole modal.
 */
const hintBubbleClass =
  'pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-[min(14rem,70vw)] rounded-lg ' +
  'bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 ' +
  'shadow-xl ring-1 ring-slate-700 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-emerald-500 cursor-help"
      tabIndex={0}
      aria-label="What is this?"
    />
  );
}

export function Field({
  label, hint, hintAlign = 'start', className, children,
}: {
  label: string;
  hint: string;
  hintAlign?: 'start' | 'end';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col min-w-0 ${className ?? ''}`}>
      <div className="group relative flex items-center space-x-1 mb-1.5">
        <label className={labelClass}>{label}</label>
        <HintIcon />
        <span role="tooltip" className={`${hintBubbleClass} ${hintAlign === 'end' ? 'right-0' : 'left-0'}`}>
          {hint}
        </span>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/**
 * Collapsed tail of a section, holding the controls whose defaults are already
 * right for most jobs. The point is that a first-time user can read a section
 * top to bottom without meeting a tip-flat diameter or GRBL's `$30`.
 */
export function Advanced({ label = 'Advanced', children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center space-x-1 text-[11px] font-bold uppercase tracking-wider text-slate-400
                   dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">{children}</div>
      )}
    </div>
  );
}

/**
 * A two- or three-way switch that fits the column it is put in.
 *
 * `min-w-0` and `truncate` rather than `whitespace-nowrap`: a flex child will
 * not shrink below its content's width unless it is told it may, so a label a
 * few characters too long for its grid cell would push the control out past the
 * field beside it. It ellipsizes instead, and the `title` keeps the full text
 * reachable — a backstop, not a plan. Keep the labels short enough that it
 * never appears.
 */
export function Segmented<T extends string>({
  value, options, onChange,
}: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={label}
          className={`flex-1 min-w-0 py-1.5 px-2 rounded-md text-[11px] font-bold transition-all cursor-pointer truncate ${
            value === v
              ? 'bg-white dark:bg-slate-900 text-emerald-600 dark:text-emerald-400 shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
