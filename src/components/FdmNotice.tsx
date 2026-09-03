import React from 'react';
import { Package, Printer } from 'lucide-react';
import { Hint } from './ExportFields';

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
    /*
     * Green, and the app's own hint bubble rather than a `title`.
     *
     * Amber is what the machine panel uses for a job that has stopped and wants
     * somebody, and this is not that — nothing is wrong, the app simply hands
     * printing over to a slicer. It opens upwards because the status bar is at
     * the foot of the window.
     */
    return (
      <Hint
        hint="You can direct drive CNC and laser cutters with Mesh, but for 3D printing you need to export STL or 3MF to your own slicer."
        placement="above"
      >
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          Export only
        </span>
      </Hint>
    );
  }

  return (
    <div className="p-4 rounded-xl bg-sky-500/10 border border-sky-500/40 flex items-start gap-3 text-xs leading-relaxed text-sky-900 dark:text-sky-200">
      <Printer className="w-5 h-5 flex-shrink-0 text-sky-500 mt-0.5" />
      <div className="space-y-1.5">
        <h4 className="font-bold text-sm">Export to your slicer for 3D printing</h4>
        <p>
          Mesh exports clean 3MF and STL models for your 3D printer slicer. Slicers calculate
          temperatures, retractions, and motion paths tuned to your specific printer and filament.
        </p>
        <p className="flex items-start gap-1.5 font-semibold">
          <Package className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <span>
            Export 3MF to preserve painted colors and multi-material slots, or STL for geometry
            alone, and slice in PrusaSlicer, OrcaSlicer, Bambu Studio, or Cura.
          </span>
        </p>
      </div>
    </div>
  );
};
