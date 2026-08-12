import React, { useState } from 'react';

/**
 * Numeric field that lets you type.
 *
 * Clamping on every keystroke means the box can never hold a value on its way to
 * a good one: emptying it snaps back to a default, and typing "150" into a field
 * with a minimum of 50 goes through "1", which becomes "1000" before the "5" is
 * even typed. So the box keeps whatever text is in it, and the value only leaves
 * here when it is a number in range. Blur settles it — an empty or out-of-range
 * box shows the value that is actually in force, which is the one that was there
 * before the edit started.
 *
 * Styling comes from the caller's `className`, so the export modals keep their
 * own accent colours.
 */
export function NumberInput({
  value, onChange, min, max, integer, ...rest
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'>) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(value);

  // Follow the value while the box is not being typed into, so a change made
  // elsewhere (the max S-value clamping the power, say) still shows up.
  if (!editing && value !== seen) {
    setSeen(value);
    setText(String(value));
  }

  const parse = (raw: string): number | null => {
    const n = integer ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    if (min !== undefined && n < min) return null;
    if (max !== undefined && n > max) return null;
    return n;
  };

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n !== null) onChange(n);
      }}
      onBlur={() => {
        setEditing(false);
        setSeen(value);
        setText(String(value));
      }}
    />
  );
}
