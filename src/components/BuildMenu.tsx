import React, { useState } from 'react';
import { ChevronUp, Hammer, ListChecks, Puzzle, Wrench } from 'lucide-react';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

export interface BuildItem {
  label: string;
  hint: string;
  icon: React.ReactNode;
  run: () => void;
  /** Why it cannot be used yet, said in place of the hint. */
  disabledReason?: string;
}

/**
 * What a model can be built as by hand, from bought stock.
 *
 * The export buttons beside the machine select change with whatever is on the
 * bench, which is right for a file the machine runs. A pipe frame, a timber
 * frame or the hardware list is none of that: the output is a cut list and a
 * set of steps, and it is the same whatever machine is chosen. Pipes used to
 * be repeated in every machine's list, and Joinery hid under the router even
 * though its tenons can be bandsawn. One menu holds them all, so the bar stays
 * the same width however many building methods there are.
 */
export const BuildMenu: React.FC<{ items: BuildItem[] }> = ({ items }) => {
  const [open, setOpen] = useState(false);
  useEscapeToClose(open, () => setOpen(false));
  if (items.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Build it by hand from bought stock — pipe and timber frames, and the hardware to buy. The same whatever machine is on the bench."
        className="flex items-center justify-center gap-1 p-1 px-1.5 rounded-md font-semibold hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus:outline-none cursor-pointer text-teal-600 dark:text-teal-400"
      >
        <Hammer className="w-3.5 h-3.5" />
        Build
        <ChevronUp className={`w-3 h-3 opacity-50 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute bottom-full right-0 mb-1.5 z-50 w-64 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg p-1"
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={!!item.disabledReason}
                onClick={() => {
                  setOpen(false);
                  item.run();
                }}
                className="w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <span className="mt-px shrink-0 text-slate-500 dark:text-slate-400">{item.icon}</span>
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-700 dark:text-slate-200">{item.label}</span>
                  <span className="block text-[10px] leading-snug text-slate-400 dark:text-slate-500 whitespace-normal font-sans">
                    {item.disabledReason ?? item.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

/** The building methods, in the order a person would reach for them. */
export function buildItems(actions: {
  pipes?: () => void;
  joinery?: () => void;
  partsList: () => void;
  hasHardware: boolean;
}): BuildItem[] {
  const icon = 'w-3.5 h-3.5';
  return [
    ...(actions.pipes
      ? [{ label: 'Pipe frame', hint: 'Frame a shape in PVC, EMT or aluminium tube, with the cut list and printable hubs. Best for: shelters, carts, racks and greenhouses.', icon: <Wrench className={icon} />, run: actions.pipes }]
      : []),
    ...(actions.joinery
      ? [{ label: 'Timber frame', hint: 'Break a frame into mortise-and-tenon parts with a cut list, cut by bandsaw or router. Best for: tables, chairs, benches and stands.', icon: <Puzzle className={icon} />, run: actions.joinery }]
      : []),
    {
      label: 'Parts list',
      hint: 'The hardware to buy, counted, with bar stock cut to length. Best for: the shopping list before a build.',
      icon: <ListChecks className={icon} />,
      run: actions.partsList,
      disabledReason: actions.hasHardware ? undefined : 'No bought hardware in the scene yet — add screws, bearings or bar stock from the left palette.',
    },
  ];
}
