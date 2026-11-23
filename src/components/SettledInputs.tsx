import React, { useCallback, useState } from 'react';
import { NumberInput } from '@physbox-io/ui';
import { useCommitted } from '../hooks/useSettled';

/**
 * Text and number fields that report the value, not the typing.
 *
 * Every one of these drives something that costs real work — a rename writes
 * the whole scene graph and an undo entry, a cut dimension re-evaluates a
 * boolean and decomposes the result into convex colliders, a couple ratio
 * clones the graph and recompiles. Reporting per keystroke meant "12" was
 * applied as 1 first, and the app did all of that twice for one number.
 *
 * So the value is held here and sent once the typing stops, or at once on blur
 * and on Enter — the two moments a value is finished ahead of the timer. The
 * box itself still shows every character, because a field that lags the
 * keyboard is worse than the problem being fixed.
 *
 * `RangeInput` is the slider of the same family, and the hook behind all of
 * them is `hooks/useSettled.ts`.
 */

/** How long a field may sit untouched before its value is taken as final. */
const SETTLE_MS = 250;

export interface SettledTextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (v: string) => void;
  /** Applied to each keystroke before it is held, e.g. stripping punctuation. */
  clean?: (raw: string) => string;
  /** Optional predicate; invalid drafts are not committed and revert on blur/Enter. */
  validate?: (v: string) => boolean;
}

export const SettledTextInput: React.FC<SettledTextInputProps> = ({
  value, onChange, clean, validate, onBlur, onKeyDown, ...rest
}) => {
  const commit = useCallback((v: string) => {
    if (validate && !validate(v)) return;
    onChange(v);
  }, [onChange, validate]);
  const [draft, setDraft, flush, cancel] = useCommitted(value, commit, SETTLE_MS);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    if (validate && !validate(draft)) cancel();
    else flush();
    onBlur?.(e);
  }, [cancel, draft, flush, onBlur, validate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (validate && !validate(draft)) cancel();
      else flush();
    } else if (e.key === 'Escape') {
      cancel();
    }
    onKeyDown?.(e);
  }, [cancel, draft, flush, onKeyDown, validate]);

  return (
    <input
      {...rest}
      type="text"
      value={draft}
      onChange={(e) => setDraft(clean ? clean(e.target.value) : e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
};

export interface SettledNumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number;
  onChange: (v: number) => void;
}

function parseBound(bound: number | string | undefined): number | undefined {
  if (bound === undefined || bound === '') return undefined;
  const n = typeof bound === 'number' ? bound : Number(bound);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A plain `<input type="number">`, settled. Its spinner arrows count as typing:
 * holding one walks the value up without asking for the work at every step.
 *
 * Out-of-range values are deferred while typing (so intermediate digits like
 * `"0"` on the way to `"0.5"` or `"-"` on the way to `"-5"` survive) and are
 * never committed by the debounce timer; on blur or Enter they clamp to
 * `[min, max]`.
 */
export const SettledNumberInput: React.FC<SettledNumberInputProps> = ({
  value, onChange, min, max, onBlur, onKeyDown, ...rest
}) => {
  const lo = parseBound(min);
  const hi = parseBound(max);
  const [text, setText] = useState(String(value));
  const [seenValue, setSeenValue] = useState(value);
  if (!Object.is(value, seenValue)) {
    setSeenValue(value);
    setText(String(value));
  }

  const commit = useCallback((n: number) => {
    if (!Number.isFinite(n)) return;
    if (lo !== undefined && n < lo) return;
    if (hi !== undefined && n > hi) return;
    onChange(n);
  }, [hi, lo, onChange]);

  const resetText = useCallback(() => setText(String(value)), [value]);
  const [, setPending, flush, cancel] = useCommitted(value, commit, SETTLE_MS, resetText);

  const commitFinished = useCallback(() => {
    const n = parseFloat(text);
    if (!Number.isFinite(n)) {
      cancel();
      setText(String(value));
      return;
    }
    const clamped = Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, n));
    setText(String(clamped));
    if (clamped !== n) {
      if (!Object.is(clamped, value)) {
        setPending(clamped);
        flush();
      } else {
        cancel();
      }
      return;
    }
    flush();
  }, [cancel, flush, hi, lo, setPending, text, value]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    commitFinished();
    onBlur?.(e);
  }, [commitFinished, onBlur]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commitFinished();
    else if (e.key === 'Escape') {
      cancel();
      setText(String(value));
    }
    onKeyDown?.(e);
  }, [cancel, commitFinished, onKeyDown, value]);

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || (lo !== undefined && n < lo) || (hi !== undefined && n > hi)) {
          cancel();
          return;
        }
        setPending(n);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
};

export interface SettledColorInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (hex: string) => void;
  commitDelay?: number;
}

/** A colour picker that settles drag ticks before writing to the scene graph. */
export const SettledColorInput: React.FC<SettledColorInputProps> = ({
  value, onChange, commitDelay = 120, onBlur, ...rest
}) => {
  const [draft, setDraft, flush] = useCommitted(value, onChange, commitDelay);
  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    flush();
    onBlur?.(e);
  }, [flush, onBlur]);
  return (
    <input
      {...rest}
      type="color"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
    />
  );
};

export interface SettledNumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  className?: string;
}

/**
 * The shared-library `NumberInput`, settled. That component deliberately reports
 * every keystroke unclamped — a half-typed number is not out of range, it is
 * unfinished — and leaves it to the caller to decide when the number is done.
 * This is that decision, for the callers whose work is expensive.
 */
export const SettledNumberField: React.FC<SettledNumberFieldProps> = ({
  value, onChange, min, max, className,
}) => {
  const commit = useCallback((v: number) => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    onChange(clamped);
  }, [max, min, onChange]);
  const [draft, setDraft, flush] = useCommitted(value, commit, SETTLE_MS);
  return (
    <NumberInput
      value={draft}
      onChange={(v) => v !== undefined && setDraft(v)}
      onCommit={flush}
      min={min}
      className={className}
    />
  );
};
