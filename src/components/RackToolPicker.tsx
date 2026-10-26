import React from 'react';
import type { RackTool, ToolShape } from '@physbox-io/machining';
import { rackToolLabel, rackToolsFor, useToolRack } from '../utils/toolRack';

/**
 * The bits in the shared rack that suit a field, as a drop-down beside it.
 *
 * Beside the number rather than instead of it: the bit on the bench is not
 * always one somebody has put in the rack, and a field that only took rack
 * tools would be a field that could not say "3.0 mm" until the rack was
 * edited. Picking fills the number; typing over it is still the last word.
 *
 * It shows which rack tool the typed number already is, when one matches, so
 * the field says "T2" back for a 1.5 that was typed by hand.
 */
export const RackToolPicker: React.FC<{
  /** Which shapes can do this job. A V-bit's rack diameter is its tip, so it is never one for a Ø field. */
  shapes: ToolShape[];
  diameterMm: number | undefined;
  /** The shape the field is currently set to, when it has one, to match against. */
  shape?: ToolShape;
  onPick: (tool: RackTool) => void;
  disabled?: boolean;
}> = ({ shapes, diameterMm, shape, onPick, disabled }) => {
  const rack = useToolRack();
  // Keyed on the joined list so a new array literal per render does not
  // recompute; the rack object itself changes identity on every edit.
  const shapeKey = shapes.join(',');
  const tools = React.useMemo(() => rackToolsFor(rack, shapeKey.split(',') as ToolShape[]), [rack, shapeKey]);
  if (tools.length === 0) return null;

  const match = tools.find(
    (t) => diameterMm !== undefined && Math.abs(t.diameterMm - diameterMm) < 1e-3 && (!shape || t.shape === shape)
  );

  return (
    <select
      value={match?.uid ?? ''}
      disabled={disabled}
      onChange={(e) => {
        const tool = tools.find((t) => t.uid === e.target.value);
        if (tool) onPick(tool);
      }}
      title="Fill this from a bit in your tool rack (Machine Setup → Tools). You can still type any size."
      aria-label="Pick a bit from the tool rack"
      className="w-20 shrink-0 px-1.5 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-[11px] text-slate-700 dark:text-slate-200 disabled:opacity-40 cursor-pointer"
    >
      <option value="">Rack…</option>
      {tools.map((t) => (
        <option key={t.uid} value={t.uid}>
          {rackToolLabel(t)}
        </option>
      ))}
    </select>
  );
};
