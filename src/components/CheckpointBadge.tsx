import React from 'react';
import { CloudOff, Cloud, HardDrive, ChevronsDown } from 'lucide-react';
import {
  getCheckpointStatus,
  subscribeCheckpoint,
  type CheckpointStatus,
} from '../utils/jobCheckpoint';

/**
 * A quiet note that the running job is, or is not, being written down.
 *
 * Shown next to the pause controls rather than at the top of the app, because
 * the question it answers — "can I walk away from this?" — is the one somebody
 * asks with their hand on the Pause button at the end of the day.
 */
export const CheckpointBadge: React.FC<{
  className?: string;
  /**
   * The machine is in a feed hold, as opposed to a tool-change or material stop.
   *
   * The difference is the whole reason this prop exists. A tool change has
   * already sent `M5` and lifted the spindle clear, so walking away from one is
   * merely idle. A feed hold has done neither: the bit is spinning, stationary,
   * in contact with the work. Saying "this job is saved, you can come back to
   * it" over the top of that would be answering the question somebody asked
   * while ignoring the one they should have asked.
   */
  feedHold?: boolean;
}> = ({ className = '', feedHold = false }) => {
  const [status, setStatus] = React.useState<CheckpointStatus>(getCheckpointStatus);

  React.useEffect(() => subscribeCheckpoint(setStatus), []);

  if (!status.active) return null;

  if (feedHold) {
    return (
      <p className={`text-[11px] leading-relaxed flex items-start gap-1.5 ${className}`}>
        <ChevronsDown className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
        <span>
          <strong>Stopping for more than a moment? Park instead.</strong> A pause leaves the spindle
          running with the tool still down in the cut, which scorches wood and welds itself into
          acrylic. Park retracts, stops the spindle and hands the machine back — and it records the
          line actually reached, so the job can be picked up later
          {status.local || status.cloud ? ' even after a power cut' : ''}.
        </span>
      </p>
    );
  }

  if (!status.local && !status.cloud) {
    return (
      <p className={`text-[11px] leading-relaxed flex items-start gap-1.5 ${className}`}>
        <CloudOff className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
        <span>
          This job is <strong>not saved</strong> — it is too big for this browser's storage
          {status.bytes > 0 && <> ({(status.bytes / 1024 / 1024).toFixed(1)} MB of G-code)</>}. If the
          tab closes or the laptop sleeps, it cannot be picked up again. PhysBox Pro keeps the program
          in your account, where size is not the limit.
        </span>
      </p>
    );
  }

  return (
    <p className={`text-[11px] leading-relaxed flex items-start gap-1.5 ${className}`}>
      {status.cloud ? (
        <Cloud className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-sky-500" />
      ) : (
        <HardDrive className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-slate-400" />
      )}
      <span>
        Saved {status.cloud ? 'to your account and to this browser' : 'in this browser'}: if the tab
        closes or the machine loses power, you will be offered this job again from the line it
        reached. Leave the work clamped where it is.
      </span>
    </p>
  );
};
