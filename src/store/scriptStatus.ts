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

export function noteScriptStatus(status: ScriptStatus): void {
  latest = status;
}

export function lastScriptStatus(): ScriptStatus | null {
  return latest;
}
