import { Donut } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { collisionModeOf } from '../../utils/csg';
import { collidersAreStale, solidMeshGeoms } from '../../utils/convexDecomposition';
import type { SceneNode } from '../../types/scene';

/*
 * Collision — how any mesh body reaches MuJoCo's contact solver.
 * A boolean body's equivalent lives in Boolean Modifiers below,
 * next to the sector and hole-axis controls it shares.
 */
export function CollisionCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);

  if (node.csgEnabled) return null;
  const meshes = solidMeshGeoms(node);
  if (meshes.length === 0) return null;

  const mode = collisionModeOf(node);
  const colliders = (node.geoms || []).filter((g) => g.csgDerived === 'collider');
  const stale = collidersAreStale(node);
  const solidity = node.collisionSolidity ?? null;

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Donut className="w-3.5 h-3.5 text-rose-500" /> Collision
        {stale && <span className="ml-auto text-[10px] font-semibold text-amber-600 animate-pulse">working…</span>}
      </h3>
      <select
        value={mode}
        onChange={(e) => updateNode(node.id, { collision: e.target.value as SceneNode['collision'] })}
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
        title="MuJoCo collides a mesh as its convex hull, which fills in any hollow. Auto breaks a hollow shape into convex pieces so it behaves like the shape it looks like."
      >
        <option value="auto">Auto</option>
        <option value="decompose">Convex pieces</option>
        <option value="hull">Convex hull</option>
      </select>
      <p className="text-[10px] text-slate-400 leading-snug">
        {colliders.length > 0
          ? `Colliding as ${colliders.length} convex pieces, so anything hollow in this shape is really hollow — a ball dropped into it lands inside.`
          : 'Colliding as one convex hull, so any hollow in this shape is filled in for contact.'}
        {solidity !== null && ` Solidity ${(solidity * 100).toFixed(0)}% — how much of its own hull this shape actually fills.`}
      </p>
      {node.collisionWarning && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">{node.collisionWarning}</p>
      )}
      {node.collisionError && (
        <p className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 leading-snug">Collision failed: {node.collisionError}</p>
      )}
    </div>
  );
}
