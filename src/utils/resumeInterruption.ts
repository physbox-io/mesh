/**
 * Mesh's resume offer, in the shape the other two apps report a stopped job.
 *
 * Etch and Volt keep a stopped job as the package's `interruption`, and
 * `describeMachine` reports that to agents. Mesh has its own, richer offer
 * (`resume`: parking, restored jobs, pending tool changes), so its machine
 * status said `interruption: null` while a resume was on offer, and an agent
 * working across the suite saw two shapes for one thing. `interruption` is kept
 * as a mirror of `resume`, written beside it in `MachineCore.updateState`.
 */

import type { JobInterruption } from '@physbox-io/machining';
import type { ResumePoint } from './machineTypes';

const REASON_WORDS: Record<ResumePoint['reason'], string> = {
  alarm: 'The controller alarmed.',
  cancelled: 'Stopped by the operator.',
  disconnected: 'The link to the machine was lost.',
  interrupted: 'The page closed while the job was running.',
};

/**
 * The interruption a resume offer describes, or null when there is none to make.
 * `previous` keeps `at` steady while the offer is unchanged, since a UI keys a
 * new stop on it.
 */
export function interruptionFor(
  resume: ResumePoint | null | undefined,
  jobOnWire: boolean,
  previous: JobInterruption | null | undefined
): JobInterruption | null {
  if (!resume || jobOnWire) return null;
  const stoppedAtLine = resume.stoppedAtLine ?? resume.fromLine;
  const reason = resume.message ?? REASON_WORDS[resume.reason];
  const restored =
    resume.restored && resume.from
      ? {
          source: resume.from.source,
          approximate: !!resume.approximate,
          jobName: resume.from.jobName,
          startedAt: resume.from.startedAt,
          ...(resume.pendingPause ? { pendingPause: resume.pendingPause } : {}),
        }
      : undefined;
  const same =
    previous &&
    previous.stoppedAtLine === stoppedAtLine &&
    previous.suggestedLine === resume.fromLine &&
    previous.reason === reason &&
    !!previous.restored === !!restored;
  if (same) return previous;
  return {
    stoppedAtLine,
    suggestedLine: resume.fromLine,
    reason,
    at: resume.from?.stoppedAt ?? Date.now(),
    ...(restored ? { restored } : {}),
  };
}
