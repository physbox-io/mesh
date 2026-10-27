import { Link2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { JOIN_MATERIALS, joinMaterial, rodJoinLimits } from '../../utils/joinMaterials';

/*
 * Joint — a blob that sticks together whatever reaches into it.
 * The material sets how strongly; the blob's size (Resize, below)
 * sets how much of each part it buries, and so how much it holds.
 * See utils/joinMaterials.ts.
 */
export function JoinCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  const m = joinMaterial(node.joinMaterial);
  if (!m) return null;
  const gi = (node.geoms || []).findIndex((g) => g.type === 'ellipsoid' || g.type === 'sphere');
  const radius = gi >= 0 ? Math.min(...(node.geoms[gi].size || [0]).filter((v) => v > 0)) : 0;
  // A 1.8 mm rod pushed in to the middle: the case people build with.
  const rod = rodJoinLimits(m, 0.0018, radius);

  const pick = (id: string) => {
    const next = joinMaterial(id);
    if (!next) return;
    updateNode(node.id, { joinMaterial: next.id });
    if (gi >= 0) updateNodeGeom(node.id, { rgba: [...next.rgba], density: next.density }, gi);
  };

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Link2 className="w-3.5 h-3.5 text-sky-600" /> Joint
      </h3>
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-slate-500 w-20 shrink-0">Made of</label>
        <select
          value={m.id}
          onChange={(e) => pick(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
          title="How strongly it holds, and whether it gives (putty) or lets go (glue)."
        >
          {JOIN_MATERIALS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
        </select>
      </div>
      <p className="text-[10px] text-slate-400 leading-snug">{m.note}</p>
      {radius > 0 && (
        <p className="text-[10px] text-slate-500 leading-snug">
          Anything reaching into it is stuck to it when you press play. A 1.8 mm rod pushed in to the
          middle {m.yields ? 'turns freely, like a pin, and' : `stays rigid up to ${(rod.torqueNm * 1000).toFixed(1)} N·mm of bending, and`} pulls
          out at {rod.pullN.toFixed(2)} N. A bigger blob buries more of the rod and holds more.
        </p>
      )}
    </div>
  );
}
