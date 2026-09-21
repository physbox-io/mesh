import React from 'react';
import { RotateCcw, X, Cloud, HardDrive } from 'lucide-react';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { restoreInterruptedJob } from '../utils/jobRestore';
import { JobResumeBanner } from './MachineJobControls';

/**
 * The job that was still cutting when this browser last went away.
 *
 * Every other resume offer in the app is a banner inside the export modal that
 * started the job, which works because that modal is still open: the thing that
 * killed the cut was a snapped cutter or a limit switch, not the tab. The case
 * this component exists for has no such modal and no such session. Somebody
 * closed a laptop at hour six of a twenty-hour relief, and what they see when
 * they open it again is a blank scene with no hint that the machine has a job
 * against it — so the offer has to come to them, at the top of the app, before
 * they touch anything.
 *
 * It is deliberately a modal rather than a banner. A banner is the right weight
 * for "the cutter broke, pick it up"; it is the wrong weight for "there is a
 * half-finished piece bolted to your machine", which is a thing to be decided
 * before doing anything else.
 *
 * When it appears: on load, and whenever the tab is brought back to the front.
 * The second is the one that matters in practice — the machine is in a shed and
 * the laptop lives on the bench with twenty tabs open, so "came back to it" is
 * the ordinary way a person returns to a stopped job. Dismissing it with Later
 * stops it asking again for the session; the banner in the export modal, and
 * this modal on the next load, still offer it.
 */
export const JobRestoreModal: React.FC = () => {
  const [machineState, setMachineState] = React.useState<MachineState>(webSerialManager.getState());
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => webSerialManager.addListener(setMachineState), []);

  /*
   * Coming back to the tab is the ordinary way somebody returns to a stopped
   * job: the machine is in a shed and the laptop lives on the bench with twenty
   * tabs open. `restoreInterruptedJob` is cheap when there is nothing to find
   * and a no-op when the job is already restored, so this can fire freely.
   *
   * The initial lookup is not here. It is done once at start-up in `main.tsx`,
   * because the answer is a change to machine state arriving from storage and
   * from the account, and this component's job is to render that state, not to
   * go and fetch it.
   */
  React.useEffect(() => {
    const onBack = () => {
      if (document.visibilityState === 'visible') void restoreInterruptedJob();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
  }, []);

  const resume = machineState.resume;
  const from = resume?.from;

  // The banner below is the whole interactive half, and it renders nothing once
  // the job is running or the offer has been discarded. When it has nothing to
  // say, neither has this. `dismissed` is Later: the offer stays live in the
  // export modal and comes back on the next load, it just stops interrupting.
  if (dismissed || !resume?.restored || !from) return null;

  const started = new Date(from.startedAt);
  const stopped = new Date(from.stoppedAt);

  const later = () => setDismissed(true);

  return (
    <div className="fixed inset-0 z-[70] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-200 dark:border-slate-700">
          <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base flex items-center gap-2">
            <RotateCcw className="w-5 h-5 text-sky-500" />
            A job was still running when this was last open
          </h3>
          <button
            onClick={later}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title="Decide later. The offer stays in the export modal."
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex flex-col gap-2">
            <p>
              <strong className="text-slate-800 dark:text-slate-100">
                {from.jobName || 'A job'}
              </strong>{' '}
              was streaming to the machine and stopped without finishing. It started{' '}
              {started.toLocaleString()} and last reported {stopped.toLocaleString()}.{' '}
              The program itself was saved, so it can be picked up from where it got to rather than
              run again from the top.
            </p>

            <p className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              {from.source === 'cloud' ? (
                  <>
                    <Cloud className="w-3.5 h-3.5 text-sky-500" />
                  Recovered from your PhysBox Pro account.
                  {resume.approximate && (
                      <>
                        {' '}The line is recorded once a minute there, so the real stopping point may
                        be a little further on — wind it back rather than forward.
                      </>
                    )}
                </>
              ) : (
                <>
                  <HardDrive className="w-3.5 h-3.5 text-slate-400" />
                  Recovered from this browser's storage.
                </>
              )}
            </p>
          </div>

          {/*
            The hard part, and the reason this is not a one-click "carry on".
            Nothing in this app stopped that job, so the controller went round a
            power cycle with it: it is not homed, and the tool in the spindle is
            whatever is in the spindle. Everything the ordinary resume banner
            warns about is true here and one step worse.
          */}
          <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/40 rounded-xl p-4 flex flex-col gap-2">
            <strong className="text-amber-800 dark:text-amber-300 font-semibold text-xs">
              Before you resume, the machine does not know any of this
            </strong>
            <ul className="text-amber-700/90 dark:text-amber-200/80 text-[11px] leading-relaxed list-disc pl-4 flex flex-col gap-1">
              <li>
                The work must still be clamped exactly where it was. If it has been unbolted or
                nudged, there is nothing to resume onto — start again.
              </li>
              <li>
                <strong>Home the machine first.</strong> It has been off since; its position is
                whatever it powered up in.
              </li>
              <li>
                <strong>Check the work origin.</strong> G54 lives in the controller's EEPROM and
                usually survives a power cut, but confirm it with Go To Zero before trusting it.
              </li>
              <li>
                <strong>Zero Z again.</strong> The tool may have been taken out, and a different
                stickout makes the old datum wrong in the direction of driving the bit into the work.
              </li>
            </ul>
          </div>

          <JobResumeBanner machineState={machineState} />

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={later}
              className="px-3 py-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-semibold rounded-lg cursor-pointer"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
