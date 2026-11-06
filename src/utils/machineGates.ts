/**
 * What the machine's state allows the panels to offer. Kept here so a button and
 * the refusal behind it read the same rule, and so it can be tested with no DOM.
 * Store-free and type-only on the machine: the manager imports this too.
 */

import type { MachineState } from './machineTypes';

type Gated = Pick<MachineState, 'connected' | 'status' | 'grblState' | 'spindleSpeed' | 'guideSpot'>;

/** The controller's words for something in motion or waiting to carry on. */
const BUSY_WORD = /^(Run|Jog|Home|Hold|Door)/;

const jobHolds = (s: Gated) => s.status === 'RUNNING' || s.status.startsWith('PAUSED');

/**
 * Which stop the operator needs, if any: the job's, or the machine's when it is
 * moving with no job, or left a spindle on. A lit guide spot reports an S word
 * too, and has its own off.
 */
export function stopControl(s: Gated): 'job' | 'machine' | null {
  if (!s.connected) return null;
  if (jobHolds(s)) return 'job';
  if (BUSY_WORD.test(s.grblState ?? '')) return 'machine';
  return s.spindleSpeed > 0 && !s.guideSpot ? 'machine' : null;
}

/** `$X`: to clear an alarm, or on a controller at rest with no job on it. */
export function unlockAllowed(s: Gated): boolean {
  if (s.status === 'ALARM' || (s.grblState ?? '').startsWith('Alarm')) return true;
  return !jobHolds(s) && !BUSY_WORD.test(s.grblState ?? '');
}

/** `$$`, which GRBL refuses under a running or held program. A tool change is neither. */
export function settingsReadable(s: Pick<MachineState, 'status'>): boolean {
  return s.status !== 'RUNNING' && s.status !== 'PAUSED_OPERATOR';
}

/** Whether Start can be pressed: the program on screen is the current one, and the machine is free. */
export function canStartProgram(
  s: Pick<MachineState, 'connected' | 'status'>,
  job: { ready: boolean; busy: boolean; pending: boolean; failure: string | null | undefined }
): boolean {
  return job.ready && !job.busy && !job.pending && !job.failure && s.connected && s.status === 'IDLE';
}
