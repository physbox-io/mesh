import React from 'react';
import { JobCompleteDialog } from '@physbox-io/ui';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';

/**
 * The job ran to its last line.
 *
 * Mounted at the top level rather than in an export modal, because a job can be
 * started from the bottom bar or by an agent over MCP with no modal open. It
 * shows only for `lastCompletedJob`, which the manager sets nowhere but at the
 * final acknowledged line — an E-Stop, an alarm or a dropped connection never
 * raise it. The dialog itself is shared with Etch and Volt.
 */
export const JobSucceededModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  // The finish that was dismissed, so the next one still shows.
  const [dismissedAt, setDismissedAt] = React.useState<number | null>(null);

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  const job = machineState.lastCompletedJob;
  if (!job || job.finishedAt === dismissedAt) return null;
  return (
    <JobCompleteDialog
      job={job}
      machine={webSerialManager.isLaserJob() ? 'laser' : 'cnc'}
      onClose={() => setDismissedAt(job.finishedAt)}
    />
  );
};
