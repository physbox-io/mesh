// Program lines as the controller is given them, and what its refusals mean.

import { splitGcodeComments } from './gcodeComments';

/** One prepared program line: what the controller gets, and what it was for. */
export interface JobLine {
  /** The command with its comment stripped. */
  code: string;
  /** The trailing comment, if the exporter wrote one. Never sent. */
  note: string;
}

/**
 * Strips a program down to the lines a controller should receive.
 *
 * GRBL's serial input buffer is 128 bytes and the stream is paced one `ok` at a
 * time, so a comment sent down the wire costs a slot that a move could have had.
 * A relief carve is tens of thousands of lines and stalls the spindle in the cut
 * if it streams slower than it mills, which is the whole reason not to send
 * text the machine will only throw away.
 *
 * The comments are kept rather than dropped, because the pause prompts are
 * written in them: the exporter is the only thing that knows a `T2 M6` means the
 * 3.175 mm ball nose.
 */
export function prepareJobLines(gcode: string): JobLine[] {
  const out: JobLine[] = [];
  for (const raw of gcode.split('\n')) {
    /*
     * Parenthesised comments count too.
     *
     * G-code has two comment syntaxes and this file used to know about one of
     * them, which mattered more than it sounds: the sheet-swap pause is written
     * `M0 (PAUSE: Insert Material Sheet 2 of 3)`, and with the parens unread
     * the prompt at the machine said "Programmed stop. Resume when ready." to
     * an operator holding three sheets of ply and no way to tell which one.
     */
    const { code, notes } = splitGcodeComments(raw);
    const note = notes.join(' ');

    if (!code) continue;
    out.push({ code, note });
  }
  return out;
}

/**
 * Whether a line is a deliberate stop the operator has to act on.
 *
 * Matched on word boundaries rather than by substring: `M30` ends the program
 * and `M03` starts the spindle, and a job that paused for either would sit
 * waiting for a tool change that never comes, at the end of a carve that is
 * already finished.
 */
export function classifyJobLine(line: string): 'tool-change' | 'stop' | 'motion' {
  const code = line.toUpperCase();
  if (/\bM0*6\b/.test(code)) return 'tool-change';
  if (/\bM0*[01]\b/.test(code)) return 'stop';
  return 'motion';
}

/**
 * What GRBL's error numbers mean, for the ones a job actually hits.
 *
 * `error:9` on its own sends an operator to a forum. Written out, it is a
 * machine that needs unlocking and a job that can be run again in ten seconds —
 * and the same is true of most of these. Only the codes a streaming program can
 * realistically produce are here; the rest fall back to saying so plainly
 * rather than being guessed at.
 */
export function describeGrblError(line: string): string {
  const code = Number(/error:\s*(\d+)/i.exec(line)?.[1]);
  switch (code) {
    case 1:
    case 20:
      return 'The controller did not recognise a command in the program — check the machine profile it was exported for.';
    case 2:
      return 'A number in that line was malformed.';
    case 8:
      return 'That setting can only be changed while the machine is idle.';
    case 9:
      return 'The machine is locked out — it is in alarm, and will refuse G-code until it is homed or unlocked ($X).';
    case 15:
      return 'The move runs outside the machine\'s travel. Check where work zero is set.';
    case 22:
      return 'No feed rate was in effect for a cutting move.';
    case 24:
      return 'Two motions were commanded on one line.';
    case 25:
      return 'A G-code word was repeated on one line.';
    case 33:
      return 'The move is not geometrically valid — usually an arc whose radius does not reach its end point.';
    default:
      return 'The controller did not say more than that.';
  }
}
