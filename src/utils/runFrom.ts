/**
 * What the run area says about a job that stopped early, and whether its Run
 * From can be pressed — kept out of the component so it can be tested without
 * a DOM, which is where the wrong-failure wording below was first missed.
 *
 * The offer itself is made by the serial manager (`ResumePoint`); this only
 * reads it. The line it suggests is the manager's, not
 * `suggestRestartLine` from the package: the manager already winds back a
 * planner's worth of lines from the last one sent and stops at a tool change
 * or programmed stop, and when the job was parked it located the line from
 * where the tool stood, which is better than any rule run over the text.
 */

import type { MachineState, ResumePoint } from './webSerialManager';

export interface StoppedJobSummary {
  /** Why it stopped, in a sentence. */
  why: string;
  /**
   * The controller's or app's own words, when they say more than `why` does —
   * shown under it. Null when `why` already is them.
   */
  detail: string | null;
  /** The line the stream had reached. */
  stoppedAtLine: number;
  /** Where Run From starts out pointing. */
  suggestedLine: number;
  /** How far the suggestion winds back from the stop, in lines. */
  windBack: number;
}

export function describeStoppedJob(resume: ResumePoint): StoppedJobSummary {
  const pending = resume.pendingPause;
  const atToolChange = pending?.kind === 'tool-change';
  const message = resume.message?.trim() || null;

  let why: string;
  if (pending && resume.reason === 'alarm') {
    // It had already stopped, on purpose, and the alarm came after: a stop
    // that otherwise reads as random, and a re-zero demand that reads as
    // arbitrary, until it says what the job was waiting for.
    why = `It had stopped for ${atToolChange ? 'a tool change' : 'a programmed stop'}, with everything before it cut, when the controller alarmed (a limit switch while lifting clear).`;
  } else if (resume.reason === 'alarm' && message) {
    // 'alarm' also covers a line the controller refused and a restart nobody
    // asked for. The generic "a limit switch" sent people to the switches for
    // what was an error:22 on line 4,210, so the words it stopped with win.
    why = message;
  } else if (resume.reason === 'alarm') {
    why = 'The controller alarmed (a limit switch, or a reset part way through).';
  } else if (resume.reason === 'disconnected') {
    why = 'The connection to the machine dropped.';
  } else if (resume.reason === 'interrupted') {
    // Nothing in the app saw this one end. The program was read back out of
    // storage, which is the only reason there is anything to offer.
    why = 'This browser went away while the job was streaming — a closed tab, a sleeping laptop, or the power going off.';
  } else {
    why = 'The job was stopped.';
  }

  const stoppedAtLine = Math.max(resume.fromLine, resume.stoppedAtLine ?? resume.fromLine);
  return {
    why,
    detail: message && message !== why ? message : null,
    stoppedAtLine,
    suggestedLine: resume.fromLine,
    windBack: stoppedAtLine - resume.fromLine,
  };
}

/** Keeps a typed line inside the program. */
export function clampRunFromLine(line: number, totalLines: number): number {
  return Math.max(0, Math.min(totalLines, Math.round(line)));
}

/**
 * Whether Run From can be pressed, and what its tooltip says either way.
 *
 * `blockedReason` is the manager's `resumeBlockedReason` — a lost position, or
 * an untrusted Z on a router — the same check `resumeFromLine` makes, so the
 * button and the refusal cannot disagree about why.
 */
export function runFromGate(
  state: Pick<MachineState, 'connected'>,
  blockedReason: string | null
): { disabled: boolean; title: string } {
  if (!state.connected) return { disabled: true, title: 'Connect to the machine first' };
  if (blockedReason) return { disabled: true, title: blockedReason };
  return { disabled: false, title: 'Rebuild the machine state for that line and carry on from there' };
}
