import React, { useCallback } from 'react';
import { useCommitted } from '../hooks/useSettled';

/**
 * A slider that reports where it landed, not every place it passed through.
 *
 * A plain `<input type="range">` fires `onChange` on every pointer move, and in
 * this app most of those handlers rebuild the MuJoCo model and discard the sim
 * state. Dragging a size slider across its travel asked for a hundred rebuilds
 * to get one shape, and the drag itself was what made the app too busy to draw
 * the slider moving.
 *
 * So the handle is driven from a local draft, which moves with the pointer at
 * full rate, and `onChange` runs once the drag settles — or immediately on
 * pointer-up, key-up and blur, which is where a drag actually ends. The short
 * idle window is there for the in-between case: a slow drag that never quite
 * stops should still show its effect, not wait for the finger to lift.
 *
 * Drop-in for the element it replaces: same props, same `className`, `value`
 * and `onChange` as numbers rather than form events. Imports nothing from this
 * app beyond the hook, so it can move to `@physbox-io/ui` beside `NumberInput`.
 */
export interface RangeInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number;
  onChange: (v: number) => void;
  /** How long a drag may pause before the value is sent anyway. */
  commitDelay?: number;
}

export const RangeInput: React.FC<RangeInputProps> = ({
  value,
  onChange,
  commitDelay = 120,
  onPointerUp,
  onKeyUp,
  onBlur,
  ...rest
}) => {
  const [draft, setDraft, flush] = useCommitted(value, onChange, commitDelay);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLInputElement>) => {
      flush();
      onPointerUp?.(e);
    },
    [flush, onPointerUp],
  );
  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      flush();
      onKeyUp?.(e);
    },
    [flush, onKeyUp],
  );
  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      flush();
      onBlur?.(e);
    },
    [flush, onBlur],
  );

  return (
    <input
      {...rest}
      type="range"
      value={Number.isFinite(draft) ? draft : 0}
      onChange={(e) => setDraft(parseFloat(e.target.value))}
      onPointerUp={handlePointerUp}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
    />
  );
};
