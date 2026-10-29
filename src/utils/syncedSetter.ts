/**
 * A state setter that also records what it set, so a reader in the same tick
 * sees the new value rather than the one from the last render.
 *
 * React applies a set on the next render; anything that sets and then reads
 * back before that (the MCP bridge, through window globals) otherwise reads
 * the old value and can write it straight back.
 */
export type Update<T> = T | ((previous: T) => T);

export function syncedSetter<T>(ref: { current: T }, set: (value: T) => void): (next: Update<T>) => void {
  return (next) => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(ref.current) : next;
    ref.current = value;
    set(value);
  };
}
