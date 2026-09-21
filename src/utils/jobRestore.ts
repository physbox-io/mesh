/**
 * Looking for a job the last session did not finish, and putting it back.
 *
 * A module of its own rather than a method on either side, because it is the
 * one place the two halves meet: `jobCheckpoint` knows how to find a stopped
 * job and `webSerialManager` knows what to do with one, and neither may import
 * the other — the manager already imports the checkpoint store to write to it.
 *
 * It is also deliberately not a React effect. The lookup is a question asked of
 * storage and of the account, which is to say of an external system, and the
 * answer arrives as a change to machine state like any other. The modal that
 * offers the job subscribes to that state; it does not go looking itself.
 */

import { loadCheckpoint, type RestorableCheckpoint } from './jobCheckpoint';
import { webSerialManager } from './webSerialManager';

/** Whether a lookup is already out, so a burst of tab focus events is one query. */
let inFlight = false;

/**
 * Finds an interrupted job and posts it as a resume point.
 *
 * Returns what it found, or null when there was nothing to find — which is the
 * ordinary case, and is why this is quiet about failing.
 *
 * Safe to call repeatedly: a job already restored, or a job already running, is
 * left alone.
 */
export async function restoreInterruptedJob(): Promise<RestorableCheckpoint | null> {
  if (inFlight) return null;

  const before = webSerialManager.getState();
  if (before.resume?.restored) return null;
  if (before.status === 'RUNNING' || before.status.startsWith('PAUSED')) return null;

  inFlight = true;
  try {
    const cp = await loadCheckpoint();
    if (!cp) return null;

    // Checked again on the way out. The account round trip is slow enough that
    // somebody can have pressed Start in the middle of it, and restoring over a
    // running job would swap the program out from under the streamer.
    const now = webSerialManager.getState();
    if (now.status === 'RUNNING' || now.status.startsWith('PAUSED')) return null;

    const ok = webSerialManager.restoreCheckpoint(cp.program, cp.progress.fromLine, {
      source: cp.source,
      approximate: cp.approximate,
      jobName: cp.program.jobName,
      startedAt: cp.program.startedAt,
      stoppedAt: cp.progress.at,
    });
    return ok ? cp : null;
  } catch {
    // Nothing here is load-bearing: a lookup that fails is a resume that is not
    // offered, never a reason to get in the way of the app starting.
    return null;
  } finally {
    inFlight = false;
  }
}
