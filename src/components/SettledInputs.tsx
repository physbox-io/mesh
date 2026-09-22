import React, { useCallback } from 'react';
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
}

export const SettledTextInput: React.FC<SettledTextInputProps> = ({
  value, onChange, clean, onBlur, onKeyDown, ...rest
}) => {
  const [draft, setDraft, flush] = useCommitted(value, onChange, SETTLE_MS);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    flush();
    onBlur?.(e);
  }, [flush, onBlur]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') flush();
    onKeyDown?.(e);
  }, [flush, onKeyDown]);

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

/**
 * A plain `<input type="number">`, settled. Its spinner arrows count as typing:
 * holding one walks the value up without asking for the work at every step.
 */
export const SettledNumberInput: React.FC<SettledNumberInputProps> = ({
  value, onChange, onBlur, onKeyDown, ...rest
}) => {
  // Kept as text so a half-typed number — "-", "1.", "" — survives; only a
  // finished, parseable one is ever sent on.
  const [draft, setDraft, flush] = useCommitted(String(value), (text) => {
    const n = parseFloat(text);
    if (Number.isFinite(n)) onChange(n);
  }, SETTLE_MS);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    flush();
    onBlur?.(e);
  }, [flush, onBlur]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') flush();
    onKeyDown?.(e);
  }, [flush, onKeyDown]);

  return (
    <input
      {...rest}
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
};

export interface SettledNumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  className?: string;
}

/**
 * The shared-library `NumberInput`, settled. That component deliberately reports
 * every keystroke unclamped — a half-typed number is not out of range, it is
 * unfinished — and leaves it to the caller to decide when the number is done.
 * This is that decision, for the callers whose work is expensive.
 */
export const SettledNumberField: React.FC<SettledNumberFieldProps> = ({
  value, onChange, min, className,
}) => {
  const [draft, setDraft, flush] = useCommitted(value, onChange, SETTLE_MS);
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
