import { Flame } from 'lucide-react';
import type { SceneNode } from '../../types/scene';
import { useCastDialog } from '../../store/castDialogStore';

/**
 * A mold Mesh made: what its holes and pegs are, and a way to pour into it.
 * Cast stays on the bottom bar with Mold, where every job is; this is the same
 * panel, found at the moment it is wanted. Shown only for a body that records
 * being a mold (simulation.mold), so an imported mold STL is poured from the
 * bottom bar as before.
 */
export function MoldCard({ node }: { node: SceneNode }) {
  const openPour = useCastDialog((s) => s.setPourOpen);
  const mold = node.simulation?.mold;
  if (node.simulation?.kind !== 'mold' || !mold) return null;
  // Without their coordinates, which a narrow sidebar turns into a wall of
  // numbers; the note card and an agent's reply keep them.
  const lines = (mold.featureLines ?? []).map((l) => l.replace(/ at \(-?[\d.]+, -?[\d.]+\)(, \(-?[\d.]+, -?[\d.]+\))*/g, ''));
  const pieceDesc = mold.liner
    ? mold.liner.construction === 'insert'
      ? mold.laidOpen ? 'Two reusable holders + soluble inserts' : 'Reusable holder + soluble insert, open on top'
      : mold.laidOpen ? 'Two lined halves, laid out as they print' : 'Lined open mold'
    : mold.laidOpen
      ? 'Two halves, laid out as they print'
      : mold.splitOpenShiftMm
        ? 'Two split halves + sliding clips, open on top'
        : 'One piece, open on top';
  const summary = [
    pieceDesc,
    mold.feed ? 'filled from the bottom' : null,
  ].filter(Boolean).join(', ');

  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <div className="flex justify-between items-center">
        <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Mold</label>
        {mold.masterVolumeMm3 > 0 && (
          <span className="text-[10px] text-slate-500 dark:text-slate-400" title="The part it was made from, and so what a pour takes.">
            casts {Math.round(mold.masterVolumeMm3 / 100) / 10} ml
          </span>
        )}
      </div>
      <div className="text-xs text-slate-700 dark:text-slate-200">{summary}.</div>
      {mold.liner && (
        <div className="text-[11px] text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/40 border border-purple-200/70 dark:border-purple-900/60 rounded px-2 py-1 leading-snug">
          <strong>{mold.liner.label}</strong> ({mold.liner.construction === 'insert' ? 'holder + insert' : 'one two-filament print'}) · dissolves in {mold.liner.solvent}. Export via <strong>3MF</strong> on the bottom bar (STL merges materials).
        </div>
      )}
      {lines.length > 0 && (
        <ul className="flex flex-col gap-1 text-[10px] leading-snug text-slate-500 dark:text-slate-400 list-disc pl-3.5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => openPour(true)}
        title="Pour into this mold: closed, poured through its sprue, with the air in it. The same as Cast on the bottom bar."
        className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded border border-orange-200 dark:border-orange-900/60 bg-white dark:bg-slate-800 text-xs font-semibold text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/40 shadow-sm cursor-pointer"
      >
        <Flame className="w-3.5 h-3.5" />
        Pour…
      </button>
    </div>
  );
}
