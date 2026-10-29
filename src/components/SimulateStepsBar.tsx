import { Box, CheckCircle2, FastForward, Loader2 } from 'lucide-react';
import type { useSimulationSteps } from '../hooks/useSimulationSteps';

/**
 * Watch the part being made: one obvious next step at a time, from the stock
 * as it goes on the machine to the part after the last setup, each added to
 * the scene beside the model, stood as the block stands for its setup.
 */
export function SimulateStepsBar({ steps, disabled }: { steps: ReturnType<typeof useSimulationSteps>; disabled: boolean }) {
  const { total, next, nextTitle, addUpTo, adding, progress, error } = steps;
  const setups = total - 1;
  const done = next >= total;
  const busy = adding !== null;
  const t = nextTitle ? nextTitle[0].toLowerCase() + nextTitle.slice(1) : '';
  const label = next === 0 ? 'Add the stock' : next === 1 ? `Add ${t}` : `Turn it, add ${t}`;
  return (
    <div className="flex flex-wrap items-center gap-2 p-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs">
      <span className="font-semibold text-slate-800 dark:text-slate-100">Watch it being made</span>
      <span className="text-slate-500 dark:text-slate-400">
        {busy
          ? `${adding === 0 ? 'Making the stock' : `Cutting step ${adding} of ${setups}`}${progress !== null ? ` — ${Math.round(progress * 100)}%` : ''}`
          : done
          ? 'Every step is in the scene, left to right.'
          : next === 0
          ? 'The stock first, then the block after each setup, in the scene beside the model.'
          : `Step ${next} of ${setups} next.`}
      </span>
      <div className="ml-auto flex items-center gap-1.5">
        {done ? (
          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-semibold">
            <CheckCircle2 className="w-3.5 h-3.5" /> Done
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void addUpTo(next)}
              disabled={disabled || busy}
              title="Add the next step of the job to the scene"
              className="py-1 px-2 rounded-lg font-bold flex items-center gap-1 bg-amber-400 hover:bg-amber-500 disabled:opacity-40 text-slate-950 cursor-pointer"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Box className="w-3.5 h-3.5" />}
              {label}
            </button>
            {total - next > 1 && (
              <button
                type="button"
                onClick={() => void addUpTo(setups)}
                disabled={disabled || busy}
                title="Add every step that is left"
                className="py-1 px-2 rounded-lg font-semibold flex items-center gap-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-40 text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                <FastForward className="w-3.5 h-3.5" /> All
              </button>
            )}
          </>
        )}
      </div>
      {error && <p className="w-full text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
