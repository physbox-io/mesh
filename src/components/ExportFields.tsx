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

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
 * Drawn into a portal at the document root, positioned against the anchor's
 * rectangle. It used to be an absolutely positioned child of the field, which
 * reads better in the markup and is wrong the moment the field is inside
 * anything that scrolls: an export modal's settings column is `overflow-y-auto`,
 * and an overflow other than `visible` clips positioned descendants no matter
 * what their z-index says. The bubble was being cut off at the column's edge.
 *
 * Being out of flow also settles the older complaint the `align` prop was added
 * for -- an absolutely positioned child still counts towards its scroll
 * container's width, so a wide bubble on a right-hand field used to drag a
 * horizontal scrollbar under the whole modal. A portalled bubble cannot. `align`
 * and `placement` are now the preferred side only: whichever way it is asked to
 * open, it flips if the viewport has no room and is clamped to stay on screen.
 */
export type HintPlacement = 'below' | 'above';

const BUBBLE_GAP = 6;
const VIEWPORT_MARGIN = 8;

const hintBubbleClass =
  'pointer-events-none fixed z-[100] w-max max-w-[min(14rem,70vw)] rounded-lg ' +
  'bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 ' +
  'shadow-xl ring-1 ring-slate-700';

/**
 * The bubble itself, shown only while its anchor is hovered or focused.
 *
 * Two passes: the first renders it where it will end up horizontally but
 * invisible, so it can be measured, and the second places it properly.
 * Measuring is what lets it flip and clamp, since a bubble whose text wraps to a
 * different number of lines than last time cannot be placed from a remembered
 * height. The measuring pass hides with `visibility` and sits on the anchor
 * rather than parking off-screen at a negative offset: parked off-screen, the
 * jump to the real position is a position change the browser can be persuaded to
 * animate, and the bubble flew in from the top of the window.
 */
function HintBubble({
  anchor, hint, placement, align,
}: {
  anchor: HTMLElement | null;
  hint: string;
  placement: HintPlacement;
  align: 'start' | 'end';
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const fitsBelow = a.bottom + BUBBLE_GAP + b.height <= vh - VIEWPORT_MARGIN;
    const fitsAbove = a.top - BUBBLE_GAP - b.height >= VIEWPORT_MARGIN;
    const above = placement === 'above' ? fitsAbove || !fitsBelow : !fitsBelow && fitsAbove;

    const left = align === 'end' ? a.right - b.width : a.left;
    setPos({
      left: Math.max(VIEWPORT_MARGIN, Math.min(left, vw - VIEWPORT_MARGIN - b.width)),
      top: above ? a.top - BUBBLE_GAP - b.height : a.bottom + BUBBLE_GAP,
    });
  }, [anchor, hint, placement, align]);

  const start = anchor?.getBoundingClientRect();
  return createPortal(
    <span
      ref={ref}
      role="tooltip"
      className={hintBubbleClass}
      style={
        pos
          ? { left: pos.left, top: pos.top }
          : { left: start?.left ?? 0, top: start?.bottom ?? 0, visibility: 'hidden' }
      }
    >
      {hint}
    </span>,
    document.body
  );
}

/**
 * Anything at all, made the anchor of a hint bubble: hover or focus it and the
 * bubble opens against this element's rectangle.
 *
 * A component rather than the hook it started as, because the older export
 * modals each carry their own copy of `Field` with its own styling and want the
 * fixed positioning without being restyled on the way past. Passing no `hint`
 * renders the children and nothing else, which saves those copies a second
 * branch for the fields that have none to give.
 */
export function HintAnchor({
  hint, align = 'start', placement = 'below', className, children,
}: {
  hint?: string;
  align?: 'start' | 'end';
  placement?: HintPlacement;
  className?: string;
  children: React.ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  // A fixed bubble does not travel with its anchor, so a wheel over the column
  // it is hanging off would leave it stranded mid-modal. Close it instead:
  // capture catches the scroll whichever container it happens in.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <span
      ref={setAnchor}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      className={className}
    >
      {children}
      {hint && open && <HintBubble anchor={anchor} hint={hint} placement={placement} align={align} />}
    </span>
  );
}

export function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-emerald-500 cursor-help"
      tabIndex={0}
      aria-label="What is this?"
    />
  );
}

/**
 * Anything at all, with the app's own hint bubble hung off it.
 *
 * `Field` is the common case — a labelled control in an export grid — but the
 * same bubble belongs on a chip in the status bar, and a `title` attribute
 * there was a different thing wearing the same icon: a different delay, a
 * different typeface, and no styling of ours at all.
 */
export function Hint({
  hint, align = 'start', placement = 'below', className, children,
}: {
  hint: string;
  align?: 'start' | 'end';
  placement?: HintPlacement;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <HintAnchor
      hint={hint}
      align={align}
      placement={placement}
      className={`relative flex items-center gap-1 ${className ?? ''}`}
    >
      {children}
      <HintIcon />
    </HintAnchor>
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
      <HintAnchor hint={hint} align={hintAlign} className="relative flex items-center space-x-1 mb-1.5">
        <label className={labelClass}>{label}</label>
        <HintIcon />
      </HintAnchor>
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
