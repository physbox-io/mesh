import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { formatDuration } from '../utils/timeEstimate';

/**
 * The job ran to its last line.
 *
 * A finish used to be a status flipping quietly from RUNNING to IDLE, which on
 * a job that has been cutting for hours, watched from across the shop, is the
 * one moment nobody is looking at the status bar. This says so where it can be
 * seen from a distance.
 *
 * Mounted at the top level rather than in an export modal, because a job can be
 * started from the bottom bar or by an agent over MCP with no modal open. It
 * shows only for `lastCompletedJob`, which the manager sets nowhere but at the
 * final acknowledged line — an E-Stop, an alarm or a dropped connection never
 * raise it.
 */
export const JobSucceededModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  // The finish that was dismissed, so the next one still shows.
  const [dismissedAt, setDismissedAt] = React.useState<number | null>(null);

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  const job = machineState.lastCompletedJob;
  const open = !!job && job.finishedAt !== dismissedAt;

  React.useEffect(() => {
    if (!open || !job) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissedAt(job.finishedAt);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, job]);

  if (!open || !job) return null;

  const done = () => setDismissedAt(job.finishedAt);

  return (
    <div
      className="fixed inset-0 z-[70] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={done}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-succeeded-title"
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center gap-3 p-6">
          <CheckCircle2 className="w-14 h-14 text-emerald-500" />
          <h3 id="job-succeeded-title" className="font-bold text-slate-800 dark:text-slate-100 text-lg">
            Job Succeeded
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Ran to the end in{' '}
            <span className="font-mono font-semibold tabular-nums">{formatDuration(job.elapsedSeconds)}</span>
            {job.estimatedSeconds !== null && (
              <span className="text-slate-400"> (estimated {formatDuration(job.estimatedSeconds)})</span>
            )}
            , {job.totalLines.toLocaleString()} lines.
          </p>
          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Let the spindle stop before reaching in, then clear the chips and unclamp the work.
          </p>
        </div>
        <div className="flex justify-center p-4 border-t border-slate-200 dark:border-slate-700">
          <button
            onClick={done}
            autoFocus
            className="px-6 py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold text-sm rounded-lg cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
