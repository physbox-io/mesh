/**
 * Collects unique, standalone, non-empty `ArrayBuffer`s reachable from `value`
 * for zero-copy `postMessage(..., transfer)`.
 *
 * Safety invariants:
 * - Only `ArrayBuffer` (never `SharedArrayBuffer`, which cannot be transferred).
 * - Only standalone views (`view.byteOffset === 0 && view.byteLength === view.buffer.byteLength`)
 *   so a subarray or WASM linear-memory view is never detached.
 * - Deduplicates via `Set` so two views referencing the same buffer never throw
 *   `DataCloneError: ArrayBuffer at index X is a duplicate`.
 * - Guarded against object cycles via `WeakSet`.
 * - Only call on sender-owned outputs that will never be read after `postMessage`.
 */
export function isStandaloneView(view: ArrayBufferView): boolean {
  const buf = view.buffer;
  return (
    buf instanceof ArrayBuffer &&
    view.byteLength > 0 &&
    view.byteOffset === 0 &&
    view.byteLength === buf.byteLength
  );
}

export function collectTransferables(
  value: unknown,
  exclude?: ReadonlySet<ArrayBuffer>,
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const seen = new WeakSet<object>();

  const walk = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (v instanceof ArrayBuffer) {
      if (v.byteLength > 0 && !exclude?.has(v)) buffers.add(v);
      return;
    }
    if (ArrayBuffer.isView(v)) {
      if (isStandaloneView(v) && !exclude?.has(v.buffer as ArrayBuffer)) {
        buffers.add(v.buffer as ArrayBuffer);
      }
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const item = v[i];
        if (item !== null && typeof item === 'object') walk(item);
      }
      return;
    }
    if (v instanceof Map) {
      for (const entry of v.values()) {
        if (entry !== null && typeof entry === 'object') walk(entry);
      }
      return;
    }
    if (v instanceof Set) {
      for (const entry of v.values()) {
        if (entry !== null && typeof entry === 'object') walk(entry);
      }
      return;
    }
    const obj = v as Record<string, unknown>;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const prop = obj[key];
      if (prop !== null && typeof prop === 'object') walk(prop);
    }
  };

  walk(value);
  return Array.from(buffers);
}
