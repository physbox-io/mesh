/**
 * What the live control scripts last reported: their mistakes and their cost.
 *
 * The physics worker pushes a SCRIPT_STATUS after every build and at most
 * twice a second while playing (see postScriptStatus in physicsWorker.ts), so
 * physics_get_state can report it without asking a worker that may be busy
 * stepping a slow script, or dead. Module state, like modelProvenance.ts:
 * nothing renders from it.
 */
import type { ScriptStatus } from '../workers/physicsWorkerProtocol';

let latest: ScriptStatus | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function noteScriptStatus(status: ScriptStatus): void {
  latest = status;
  notify();
}

export function lastScriptStatus(): ScriptStatus | null {
  return latest;
}

/**
 * Clears cached script diagnostics altogether (when `body` is omitted), or
 * drops the recorded problems of a single body when its script is saved/cleared
 * so stale errors do not linger while the simulation is paused.
 */
export function clearScriptStatus(body?: string): void {
  if (!latest) return;
  if (body === undefined) {
    latest = null;
    notify();
    return;
  }
  const kept = latest.problems.filter((p) => p.body !== body);
  if (kept.length === latest.problems.length && !(kept.length === 0 && latest.moreProblems > 0)) return;
  latest = {
    ...latest,
    problems: kept,
    moreProblems: kept.length === 0 ? 0 : latest.moreProblems,
  };
  notify();
}

export function subscribeScriptStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
