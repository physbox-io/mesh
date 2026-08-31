import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Terminal, Trash2 } from 'lucide-react';
import { webSerialManager, type MachineLogEntry, type MachineState } from '../utils/webSerialManager';

/**
 * What the machine is actually saying.
 *
 * "I pressed start and nothing happened" has half a dozen causes that are
 * indistinguishable from the front of the app and immediately obvious from the
 * traffic: a line refused with `error:`, a controller sitting in `Alarm`, a
 * program streaming perfectly into a machine whose spindle is off — or the one
 * that reads exactly like a broken button, a controller that takes every
 * command and answers none of them, which leaves a job stopped on line one for
 * ever while the app shows it as running.
 *
 * None of that is guessable from a progress bar, and all of it is one glance at
 * this. Reading only: the buttons around it already send everything worth
 * sending, and a G-code prompt in the middle of the setup panel invites typing
 * into a machine rather than watching one.
 */
export const MachineConsole: React.FC = () => {
  const [log, setLog] = useState<MachineLogEntry[]>(() => webSerialManager.getLog());
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => webSerialManager.addLogListener(setLog), []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
        <Terminal className="w-3.5 h-3.5 text-emerald-500" />
        <span>Machine Console</span>
        <button
          onClick={() => webSerialManager.clearLog()}
          title="Clear the log"
          className="ml-auto p-1 rounded-lg text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </h3>

      <div className="h-40 overflow-y-auto rounded-lg bg-slate-950 border border-slate-800 p-2 font-mono text-[11px] leading-relaxed">
        {log.length === 0 ? (
          <p className="text-slate-600">
            No traffic yet. Status polls are left out — everything else you or the machine sends
            appears here.
          </p>
        ) : (
          log.map((entry, i) => (
            <div key={i} className={entry.dir === 'tx' ? 'text-slate-400' : 'text-emerald-400'}>
              {entry.dir === 'tx' ? '> ' : ''}
              {entry.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
};

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
    <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/50 px-3 py-2 text-[11px] leading-relaxed text-red-300">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{machineState.lastError}</span>
    </div>
  );
};

export const ControllerSilenceBanner: React.FC<{ machineState: MachineState }> = ({ machineState }) => {
  if (!machineState.connected || !machineState.controllerSilent) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/50 px-3 py-2 text-[11px] leading-relaxed text-red-300">
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
