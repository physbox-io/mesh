import React from 'react';
import { createPortal } from 'react-dom';
import { Layers, Minus } from 'lucide-react';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { JobPauseBanner } from './MachineJobControls';
import { useJobPause, pauseKey } from '../store/jobPauseStore';

/** Stops that wait on the operator, as opposed to a feed hold they just pressed. */
function isOperatorStop(status: MachineState['status']): boolean {
  return status === 'PAUSED_TOOL' || status === 'PAUSED_MATERIAL' || status === 'PAUSED_PARKED';
}

/** A tool change has its own dialog, `ToolChangeModal`. */
function isNonToolStop(status: MachineState['status']): boolean {
  return status === 'PAUSED_MATERIAL' || status === 'PAUSED_PARKED';
}

/**
 * The job has stopped and is waiting for somebody: a tool change, a sheet swap,
 * a park.
 *
 * This used to be a card inside each export modal's scrolling body, which on a
 * laptop screen put it below the fold — the machine stopped, said why, and the
 * saying was out of sight while the operator stood at the spindle wondering.
 * It is now a dialog at the top of the app, over whatever is open, the same
 * weight as the job-finished and job-restore dialogs, and for the same reason:
 * a job can be started from the bottom bar or by an agent over MCP with no
 * export modal open at all.
 *
 * The body is `JobPauseBanner`, unchanged, so the Z-zero gate on Resume lives in
 * one place. There is no close: the job really is waiting. Hide tucks it away
 * for this stop; the pause line in the status bar and the note in the export
 * modal bring it back, and the next stop opens it again by itself.
 */
export const JobPauseModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  const hiddenKey = useJobPause((s) => s.hiddenKey);
  const hide = useJobPause((s) => s.hide);

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  const { status, pauseMessage } = machineState;
  const key = pauseKey(status, pauseMessage);
  if (!isNonToolStop(status) || hiddenKey === key) return null;

  const laser = webSerialManager.isLaserJob();
  const resumeLabel =
    status === 'PAUSED_MATERIAL' ? 'Resume Next Sheet (Cycle Start)' : 'Resume Job (Cycle Start)';

  const modal = (
    <div className="fixed inset-0 z-[70] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-pause-title"
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700">
          <h3
            id="job-pause-title"
            className="font-bold text-slate-800 dark:text-slate-100 text-base flex items-center gap-2"
          >
            <Layers className="w-5 h-5 text-amber-500" />
            {status === 'PAUSED_MATERIAL' ? 'Material change' : 'Job parked'}
          </h3>
          <button
            onClick={() => hide(key)}
            className="px-2 py-1 rounded-lg text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center gap-1 cursor-pointer"
            title="Tuck this away. The pause line in the status bar brings it back."
          >
            <Minus className="w-4 h-4" />
            Hide
          </button>
        </div>
        <div className="p-4 overflow-y-auto">
          <JobPauseBanner machineState={machineState} resumeLabel={resumeLabel} showZTools={!laser} />
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
};

/**
 * What an export modal shows in the place the pause card used to be.
 *
 * A feed hold the operator pressed in this modal is answered here, inline,
 * next to the button that caused it. Every other stop is answered in the
 * dialog, and this line says so and reopens it if it was hidden.
 */
export const InlineJobPause: React.FC<{
  machineState: MachineState;
  resumeLabel: string;
  showZTools?: boolean;
}> = ({ machineState, resumeLabel, showZTools }) => {
  const show = useJobPause((s) => s.show);
  if (machineState.status === 'PAUSED_OPERATOR') {
    return <JobPauseBanner machineState={machineState} resumeLabel={resumeLabel} showZTools={showZTools} />;
  }
  if (!isOperatorStop(machineState.status)) return null;
  return (
    <button
      onClick={show}
      className="w-full text-left px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500 text-amber-800 dark:text-amber-300 text-xs font-semibold cursor-pointer hover:bg-amber-500/20"
    >
      Paused: {machineState.pauseMessage ?? 'waiting for you'} — open the dialog to carry on
    </button>
  );
};
