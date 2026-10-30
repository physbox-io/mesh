/**
 * A shallow copy without the keys whose value is null.
 *
 * JSON from an agent says "no value" with null as often as by leaving a key
 * out, and the scene graph's optional fields are all tested `!== undefined`:
 * `friction: null` reached `friction.join(' ')` in the compiler, and since it
 * stayed in the graph the scene never compiled again. Null is read as unset
 * wherever a body, geom or joint comes in, and as "remove this field" in a
 * physics_update_object merge.
 */
export function withoutNulls<T extends object>(o: T): T {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(o)) {
    if ((o as Record<string, unknown>)[k] !== null) continue;
    out ??= { ...(o as Record<string, unknown>) };
    delete out[k];
  }
  return (out ?? o) as T;
}
