// What the inspector's size controls send, checked before it is sent.
//
// updateNodeGeom refuses a bad size by throwing (utils/geomSize), and a throw
// out of a React event handler is an uncaught error in the console with the
// control left showing a value that never took. Two ways the inspector could
// get there:
//
// - a slider whose span reached down to 0: lengthSpan floors its minimum to
//   whole 10 mm steps, so a part under 10 mm got a slider that went to 0;
// - a short size: a box written as [0.1] (a cube) edited on one axis went out
//   as [v, undefined, undefined].
//
// So a resize is built here in full, from the shorthand the way the compiler
// reads it, and a value that is not a positive number is refused: the control
// keeps the size in force. Anything the store still refuses is caught by
// guardedEdit and logged, never thrown.

/**
 * `size` with entry `index` set to `value`, `entries` long, every entry left
 * out filled as the compiler fills it (from the first). Null when the result
 * would not be a usable size, so the caller sends nothing.
 */
export function resizedGeomSize(size: readonly number[] | undefined, index: number, value: number, entries: number): number[] | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const first = index === 0 ? value : size?.[0];
  const out: number[] = [];
  for (let i = 0; i < entries; i++) {
    const v = i === index ? value : (size?.[i] ?? first);
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    out.push(v);
  }
  return out;
}

/**
 * Runs a store edit from a UI handler. A refusal is logged and returned, so
 * the control stays as it was instead of an error escaping the handler.
 */
export function guardedEdit(edit: () => void): string | null {
  try {
    edit();
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`Edit refused: ${message}`);
    return message;
  }
}
