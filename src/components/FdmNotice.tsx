import React from 'react';
import { Info, Package, Printer } from 'lucide-react';

/**
 * Why the app does not drive the printer on the bench.
 *
 * FDM is the default machine because it is the one most people opening this app
 * own, and pretending otherwise would be the wrong kind of tidy. But a printer
 * is not a machine you hand G-code to from here, and the reason is not that
 * nobody got round to it.
 *
 * A cutter takes a path and a depth. A printer takes a path, a temperature, a
 * flow rate, a fan curve, a retraction distance, a pressure-advance figure, a
 * start script for that firmware and an end script for that model — and every
 * one of those is specific to the machine, the filament, and frequently the
 * batch of filament. That is a slicer's job, it is a large one, and the slicers
 * are good at it. What this app owes a printer is a clean mesh with its colours
 * intact, which is what 3MF and STL are for.
 *
 * Shown wherever someone with a printer selected might reasonably expect to
 * press start.
 */
export const FdmNotice: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  if (compact) {
    return (
      <span
        title="This app exports meshes for a printer; it does not drive one. Slice the 3MF or STL in your own slicer."
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400"
      >
        <Info className="w-3 h-3" />
        <span>Export only</span>
      </span>
    );
  }

  return (
    <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/40 flex items-start gap-3 text-xs leading-relaxed text-sky-900 dark:text-sky-200">
      <Printer className="w-5 h-5 flex-shrink-0 text-sky-500 mt-0.5" />
      <div className="space-y-1.5">
        <h4 className="font-bold text-sm">Printing is done in your slicer, not here.</h4>
        <p>
          A cutter takes a path and a depth. A printer takes a path, a temperature, a flow rate, a
          fan curve, a retraction distance, a pressure-advance figure, and start and end scripts
          written for that firmware — all of it specific to your machine, your filament, and often
          the spool. Doing that half-well would be worse than not doing it, so this app does not
          drive printers.
        </p>
        <p className="flex items-start gap-1.5 font-semibold">
          <Package className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Export 3MF — it carries the painted colour, a filament slot per triangle — or STL for
            geometry alone, and slice it as you normally would. Or change the machine type in the
            status bar to CNC Router or Laser, and cut the thing instead.
          </span>
        </p>
      </div>
    </div>
  );
};
