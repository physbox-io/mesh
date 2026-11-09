import React from 'react';
import { createPortal } from 'react-dom';
import { JobPauseDialog, jobPauseKind } from '@physbox-io/ui';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { OpenSetupButton } from './MachineJobControls';
import { showJobWindow } from '../utils/jobWindow';
import { CheckpointBadge } from './CheckpointBadge';
import { useJobPause, pauseKey } from '../store/jobPauseStore';

/**
 * The job has stopped and is waiting for somebody: a feed hold, a sheet swap,
 * a park. A tool change has its own dialog, `ToolChangeModal`.
 *
 * The shared `JobPauseDialog`, so a paused job looks the same in Etch, Volt
 * and Mesh. It sits at the top of the app, over whatever is open, because a
 * job can be started from the bottom bar or by an agent over MCP with no
 * export modal open at all. There is no close: the job really is waiting.
 * Hide tucks it away for this stop; the pause line in the export modal brings
 * it back, and the next stop opens it again by itself.
 *
 * Resume stays shut while Z is unset on a cutting job, with no override:
 * Machine Setup re-zeroes it.
 */
export const JobPauseModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  const hiddenKey = useJobPause((s) => s.hiddenKey);
  const hide = useJobPause((s) => s.hide);

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  const { status, pauseMessage } = machineState;
  const key = pauseKey(status, pauseMessage);
  const kind = jobPauseKind(status);
  if (!kind || hiddenKey === key) return null;

  const laser = webSerialManager.isLaserJob();
  const parked = kind === 'parked';
  const blocked = !laser && machineState.needsZZero;

  const dialog = (
    <JobPauseDialog
      machine={laser ? 'laser' : 'cnc'}
      kind={kind}
      message={pauseMessage}
      progress={machineState.totalLines > 0 ? { line: machineState.currentLine, total: machineState.totalLines } : undefined}
      jog={{
        position: machineState.wpos,
        connected: machineState.connected,
        onJog: (delta, feed) => webSerialManager.jog(delta, feed),
        onJogStop: () => webSerialManager.jogCancel(),
      }}
      resumeBlockedReason={blocked ? 'Set Z zero first: open Machine Setup.' : null}
      resumeLabel={kind === 'material' ? 'Resume next sheet' : undefined}
      onResume={() =>
        // A park let go of the program, so `resumeJob` has nothing to release;
        // it is put back from the park point.
        (parked
          ? webSerialManager.resumeFromPark({ isLaser: laser })
          : webSerialManager.resumeJob()
        ).then((ok) => ok !== false && showJobWindow())
      }
      onStop={() => webSerialManager.cancelJob()}
      onHide={() => hide(key)}
      footerExtra={<OpenSetupButton />}
    >
      {/* What a pause is and is not insurance against: a feed hold lives in
          the controller and dies with its power; the checkpoint does not. */}
      <CheckpointBadge feedHold={kind === 'hold'} className="text-slate-500 dark:text-slate-400" />
    </JobPauseDialog>
  );

  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
};

/**
 * What an export modal shows in the place the pause card used to be: a line
 * that says the job is paused and reopens the dialog if it was hidden.
 */
export const InlineJobPause: React.FC<{
  machineState: MachineState;
  resumeLabel?: string;
  showZTools?: boolean;
}> = ({ machineState }) => {
  const show = useJobPause((s) => s.show);
  // A tool change hidden from `ToolChangeModal` comes back through here too.
  if (!jobPauseKind(machineState.status) && machineState.status !== 'PAUSED_TOOL') return null;
  return (
    <button
      onClick={show}
      className="w-full text-left px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500 text-amber-800 dark:text-amber-300 text-xs font-semibold cursor-pointer hover:bg-amber-500/20"
    >
      Paused: {machineState.pauseMessage ?? 'waiting for you'} — open the dialog to carry on
    </button>
  );
};
