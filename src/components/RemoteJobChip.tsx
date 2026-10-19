import React from 'react';
import { Radio } from 'lucide-react';
import { subscribeRemoteJob, type RemoteJob } from '../utils/jobCheckpoint';
import { restoreInterruptedJob } from '../utils/jobRestore';

/** How often to ask again while another tab or machine has a job going. */
const RECHECK_MS = 30_000;

/**
 * A job is being cut from another tab or another machine.
 *
 * Without this, opening Mesh on a second computer while the first one carved
 * met you with "a job was still running when this was last open" — true of
 * the other machine, and an offer to restore it here, which is an offer to put
 * a second copy of the program against a machine already cutting. The lookup
 * now recognises a job whose own tab wrote recently and says so here instead.
 *
 * It asks again every half minute while showing. When the job finishes the
 * chip goes; when its tab stops writing (the laptop shut mid-job) the next look
 * finds it abandoned and the restore dialog offers it, as before.
 */
export const RemoteJobChip: React.FC = () => {
  const [job, setJob] = React.useState<RemoteJob | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => subscribeRemoteJob(setJob), []);

  React.useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void restoreInterruptedJob();
    }, RECHECK_MS);
    return () => clearInterval(timer);
  }, [job]);

  if (!job) return null;

  const ago = Math.max(0, Math.round((now - job.at) / 1000));
  const heard = ago < 60 ? `${ago} s ago` : `${Math.round(ago / 60)} min ago`;
  const where = job.where === 'tab' ? 'another tab' : 'another device';

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-sky-500/10 border border-sky-500/40 text-sky-700 dark:text-sky-300"
      title={`${job.jobName || 'A job'} is streaming from ${where}. Control it there.`}
    >
      <Radio className="w-3.5 h-3.5" />
      <span className="font-semibold">Job running on {where}</span>
      <span className="text-sky-600/80 dark:text-sky-400/80">
        line {job.fromLine}/{job.totalLines} · heard {heard}
      </span>
    </div>
  );
};
