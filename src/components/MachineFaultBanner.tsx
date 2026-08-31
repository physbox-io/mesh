import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { type MachineState } from '../utils/webSerialManager';

/**
 * Says so when the controller has gone quiet.
 *
 * The app writes to the machine and reads back from it over the same lead, and
 * only one of those two failing is a state that looks entirely healthy from
 * here: commands go out, the machine moves, and nothing ever comes back. Every
 * feature built on the replies then fails silently and separately — the run
 * times stay assumed because `$$` was never answered, the position readout sits
 * at zero, and a job stops on its first line waiting for an `ok`, showing
 * RUNNING at 0% for as long as anyone cares to watch it.
 *
 * One banner, wherever a job can be started, is the difference between that and
 * an afternoon.
 */
export const MachineFaultBanner: React.FC<{ machineState: MachineState }> = ({ machineState }) => {
  if (!machineState.connected) return null;
  if (machineState.controllerSilent) return <ControllerSilenceBanner machineState={machineState} />;
  if (!machineState.lastError) return null;

  /*
   * The machine's own complaint, where the job is started from.
   *
   * It was only ever shown inside the machine setup window, which is the one
   * place nobody is looking when they have just pressed start — so a line
   * refused mid-program, the single commonest way a job stops early, arrived as
   * silence.
   */
  return (
    <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/50 px-3 py-2 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{machineState.lastError}</span>
    </div>
  );
};

export const ControllerSilenceBanner: React.FC<{ machineState: MachineState }> = ({ machineState }) => {
  if (!machineState.connected || !machineState.controllerSilent) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/50 px-3 py-2 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>
        <strong className="font-bold">The controller is not answering.</strong> Commands are going
        out — the machine may well still move — but nothing has come back for several seconds, and a
        job cannot stream without the replies: it will stop on its first line and sit there. Seen in
        the wild from a second controller sharing a USB hub, a lead with no receive line in it, the
        wrong baud rate (GRBL is 115200), and a controller that needed power-cycling — the hub is
        worth ruling out first, by going straight into the machine. The console below shows what, if
        anything, is arriving.
      </span>
    </div>
  );
};
