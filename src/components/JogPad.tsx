import React, { useState } from 'react';
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ChevronsUp, ChevronsDown, Octagon } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { webSerialManager } from '../utils/webSerialManager';

/**
 * Driving the machine by hand: XY on the left cluster, Z on its own column, as
 * on a pendant, with the usual coarse/medium/fine step ladder so the last
 * approach is a tenth at a time.
 *
 * Shared by the Machine Setup origin panel and the pause banner. The banner
 * used to tell the operator at a tool change to "jog the tip down onto the
 * work" with nothing on screen to jog with: the only pad was in Machine Setup,
 * underneath the export modal that was running the job.
 *
 * Follows the app's theme wherever it is put, so every colour is written for
 * both.
 */
export const JogPad: React.FC<{
  disabled?: boolean;
  /** Called after each jog is sent, e.g. to mark an XY zero as no longer here. */
  onJogged?: () => void;
}> = ({ disabled = false, onJogged }) => {
  const [step, setStep] = useState(1);
  const [feedrate, setFeedrate] = useState(1000);

  const jog = (x: number, y: number, z: number) => {
    onJogged?.();
    // A refusal (a job holding the machine) is already said in `lastError`;
    // swallowing it here keeps it from surfacing as an unhandled rejection.
    webSerialManager.jog({ x: x * step, y: y * step, z: z * step }, feedrate).catch(() => {});
  };

  const jogBtn =
    'flex items-center justify-center h-8 rounded-lg bg-slate-200 dark:bg-slate-800 ' +
    'hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-30 disabled:hover:bg-slate-200 ' +
    'dark:disabled:hover:bg-slate-800 disabled:cursor-not-allowed text-slate-700 dark:text-slate-200 ' +
    'transition-colors cursor-pointer';

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex items-start space-x-3">
        <div className="grid grid-cols-3 gap-1 w-[132px]">
          <span />
          <button disabled={disabled} onClick={() => jog(0, 1, 0)} title={`Y +${step} mm`} className={jogBtn}>
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <span />
          <button disabled={disabled} onClick={() => jog(-1, 0, 0)} title={`X -${step} mm`} className={jogBtn}>
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <button
            disabled={disabled}
            onClick={() => webSerialManager.jogCancel()}
            title="Stop the current jog"
            className={`${jogBtn} text-red-400`}
          >
            <Octagon className="w-3.5 h-3.5" />
          </button>
          <button disabled={disabled} onClick={() => jog(1, 0, 0)} title={`X +${step} mm`} className={jogBtn}>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <span />
          <button disabled={disabled} onClick={() => jog(0, -1, 0)} title={`Y -${step} mm`} className={jogBtn}>
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <span />
        </div>

        <div className="grid grid-cols-1 gap-1 w-10">
          <button disabled={disabled} onClick={() => jog(0, 0, 1)} title={`Z +${step} mm`} className={jogBtn}>
            <ChevronsUp className="w-3.5 h-3.5" />
          </button>
          <span className="text-[9px] text-center text-slate-500 font-bold leading-8">Z</span>
          <button disabled={disabled} onClick={() => jog(0, 0, -1)} title={`Z -${step} mm`} className={jogBtn}>
            <ChevronsDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="space-y-2 min-w-[140px] flex-1">
        <div>
          <span className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Jog Step (mm)</span>
          <div className="flex space-x-1">
            {[0.1, 1, 10].map((s) => (
              <button
                key={s}
                onClick={() => setStep(s)}
                className={`flex-1 py-1 text-xs font-bold rounded-lg transition-colors cursor-pointer ${
                  step === s ? 'bg-emerald-500 text-slate-950' : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <span className="text-[10px] uppercase font-bold text-slate-500 whitespace-nowrap">Feed</span>
          <NumberInput
            min={10}
            max={5000}
            step={50}
            integer
            value={feedrate}
            onChange={(v) => v !== undefined && setFeedrate(v)}
            className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-2 py-1 text-xs font-mono text-slate-800 dark:text-slate-200"
          />
          <span className="text-[10px] text-slate-500">mm/min</span>
        </div>
      </div>
    </div>
  );
};
