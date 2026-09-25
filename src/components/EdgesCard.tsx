import React from 'react';
import { SquareRoundCorner, Trash2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import type { SceneNode } from '../types/scene';
import { whyNotRoundable } from '../utils/edgeRoundBase';
import { SettledNumberField } from './SettledInputs';

/**
 * The inspector card for a part's rounded and bevelled edges.
 *
 * Each rounding is listed as the thing a person made — "Round 3 mm, 4 edges" —
 * and stays editable: its size and kind in place, its edges by reopening the
 * tool on it. The card's <h3> is a direct child of its outer div, which is the
 * contract the inspector's fold-away headers are wired to.
 */
export const EdgesCard: React.FC<{ node: SceneNode }> = ({ node }) => {
  const session = useStore((s) => s.edgeRoundSession);
  const playing = useStore((s) => s.isPlaying);
  if (whyNotRoundable(node) || node.isCurve || node.isPulleyRope) return null;

  const store = useStore.getState();
  const features = node.edgeRounds ?? [];
  const editingHere = session?.nodeId === node.id;

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <SquareRoundCorner className="w-3.5 h-3.5 text-amber-500" /> Edges
      </h3>
      <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
        Round or bevel the part’s edges so it looks finished and is kinder to hands. The rounded
        shape is what collides, prints and machines.
      </p>

      {features.map((f, i) => (
        <div key={i} className="flex items-center gap-1.5 text-[11px]">
          <select
            value={f.mode}
            onChange={(e) => store.setEdgeRoundFeature(node.id, i, { mode: e.target.value as 'fillet' | 'chamfer' })}
            className="px-1.5 py-1 border border-slate-200 rounded text-[10px] bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-semibold"
            title="Round is a smooth curve (a fillet); Bevel is a flat cut (a chamfer)"
            disabled={editingHere || playing}
          >
            <option value="fillet">Round</option>
            <option value="chamfer">Bevel</option>
          </select>
          <SettledNumberField
            value={Math.round(f.size * 1e5) / 100}
            min={0.1}
            onChange={(v) => v > 0 && store.setEdgeRoundFeature(node.id, i, { size: v / 1000 })}
            className="w-14 text-right"
          />
          <span className="text-slate-400">mm</span>
          <span className="flex-1 text-slate-500 truncate">· {f.edges.length} edge{f.edges.length === 1 ? '' : 's'}</span>
          <button
            type="button"
            onClick={() => store.startEdgeRound(node.id, i)}
            disabled={editingHere || playing}
            className="px-1.5 py-0.5 rounded text-[10px] text-slate-500 hover:bg-slate-100 cursor-pointer disabled:opacity-40"
            title="Change which edges this applies to"
          >
            Edges…
          </button>
          <button
            type="button"
            onClick={() => store.removeEdgeRoundFeature(node.id, i)}
            disabled={editingHere || playing}
            className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 cursor-pointer disabled:opacity-40"
            title="Take this rounding off"
            aria-label="Remove rounding"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      ))}

      {editingHere ? (
        <p className="text-[10px] text-amber-600 leading-snug">Picking edges — use the panel over the part, then Apply.</p>
      ) : (
        <button
          type="button"
          onClick={() => store.startEdgeRound(node.id)}
          disabled={playing}
          className="w-full py-1.5 rounded-md border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 text-xs font-semibold cursor-pointer disabled:opacity-50"
          title="Or press E with the part selected"
        >
          {features.length ? 'Round more edges…' : 'Round edges…'}
        </button>
      )}
    </div>
  );
};

export default EdgesCard;
