import React, { useState } from 'react';

/**
 * The number at the right-hand end of a slider's label, made typeable.
 *
 * A slider is good for finding a value and bad for stating one: you cannot land
 * on 0.125 by dragging, and the figure beside the label used to be a plain
 * `<span>` that only told you where the handle had ended up. This renders in
 * that same slot, at the label's own size, and takes typing.
 *
 * Sized to disappear into the label rather than sit in a box of its own. The
 * earlier fully-bordered field was the width of the label it sat beside, which
 * read as a separate control rather than as the slider's readout.
 *
 * Text is held locally while the box has focus, so a value on its way to being
 * typed — "0", "0.", "0.0" before "0.05" — survives the trip. Nothing leaves
 * here until it parses and is in range, and blur settles the box back to
 * whatever value is actually in force.
 */
export const SliderValue: React.FC<{
  value: number;
  onChange: (v: number) => void;
  /** Digits shown when the box is not being edited. */
  decimals?: number;
  /** Rendered after the number, e.g. "m" or "°". */
  unit?: string;
  min?: number;
  max?: number;
  className?: string;
}> = ({ value, onChange, decimals = 3, unit, min, max, className = '' }) => {
  const shown = Number.isFinite(value) ? value.toFixed(decimals) : '';
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(value);

  // Track the value while the box is idle, so dragging the slider moves the
  // number, but never overwrite what someone is part-way through typing.
  if (!editing && value !== seen) {
    setSeen(value);
    setText(shown);
  }

  return (
    <span className="flex shrink items-center gap-0.5 font-mono tabular-nums min-w-0">
      <input
        type="text"
        inputMode="decimal"
        value={editing ? text : shown}
        onFocus={(e) => {
          setEditing(true);
          setText(shown);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseFloat(e.target.value);
          if (!Number.isFinite(n)) return;
          if (min !== undefined && n < min) return;
          if (max !== undefined && n > max) return;
          onChange(n);
        }}
        onBlur={() => {
          setEditing(false);
          setSeen(value);
          setText(shown);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(shown);
            e.currentTarget.blur();
          }
        }}
        /*
         * Borderless until you touch it. `field-sizing` shrinks the box to its
         * content where it is supported; the width is the fallback everywhere
         * else, and is set in `ch` so it tracks the font rather than a guess at
         * it.
         *
         * `slider-value` is not decoration: the inspector styles every text
         * input inside it as a bordered, padded field, and that selector beats a
         * utility class. A readout dressed as a field is both wrong to read and
         * wide enough to push the row off the side of the panel, so it opts out
         * by name — see `aside.glass-panel input[type="text"]` in index.css.
         */
        className={`slider-value w-[5ch] max-w-[7ch] [field-sizing:content] bg-transparent p-0 border-0 text-right outline-none border-b border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-blue-500 focus:text-blue-600 dark:focus:text-blue-400 cursor-text ${className}`}
      />
      {unit && <span className="text-slate-400">{unit}</span>}
    </span>
  );
};
