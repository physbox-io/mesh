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
  const summary = [
    mold.laidOpen ? 'Two halves, laid out as they print' : 'One piece, open on top',
    mold.feed ? 'filled from the bottom' : null,
  ].filter(Boolean).join(', ');

  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
      <div className="flex justify-between items-center">
        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Mold</label>
        {mold.masterVolumeMm3 > 0 && (
          <span className="text-[10px] text-slate-500" title="The part it was made from, and so what a pour takes.">
            casts {Math.round(mold.masterVolumeMm3 / 100) / 10} ml
          </span>
        )}
      </div>
      <div className="text-xs text-slate-700">{summary}.</div>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-1 text-[10px] leading-snug text-slate-500 list-disc pl-3.5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => openPour(true)}
        title="Pour into this mold: closed, poured through its sprue, with the air in it. The same as Cast on the bottom bar."
        className="flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded border border-orange-200 bg-white text-xs font-semibold text-orange-600 hover:bg-orange-50 shadow-sm"
      >
        <Flame className="w-3.5 h-3.5" />
        Pour…
      </button>
    </div>
  );
}
