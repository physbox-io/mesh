/**
 * Does a control script compile?
 *
 * The physics worker compiles each script with `new Function('api', src)` the
 * first time it runs, and a script that does not compile used to be found only
 * there: the MCP write that set it said ok, and the failure went to the
 * worker's console. Checking at the write puts it in the reply. The script is
 * still applied — a half-written script is a normal thing to save — this only
 * says so. Compiling does not run anything. Store-free.
 */
import type { SceneNode } from '../types/scene';

/** The compile error of a script, or null when it compiles (or is empty). */
export function scriptSyntaxError(src: string | undefined | null): string | null {
  if (!src || src.trim() === '') return null;
  try {
    new Function('api', src);
    return null;
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

/** One warning per body in `nodes` (at any depth) whose script does not compile. */
export function scriptWarnings(nodes: SceneNode[] | undefined): string[] {
  const out: string[] = [];
  const walk = (list: SceneNode[] | undefined) => {
    for (const n of list || []) {
      const err = scriptSyntaxError(n.script);
      if (err) out.push(`Script on '${n.name || n.id}' does not compile: ${err}. It was saved as written and will do nothing until fixed.`);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
