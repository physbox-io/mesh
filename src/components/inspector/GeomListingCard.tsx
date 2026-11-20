import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { geomIsRebuilt } from '../../utils/generatedGeoms';

/**
 * Whether the active geom is a generated part, left out of the parts list
 * until "Show generated parts" is on; and, for a part rebuilt from its body's
 * measurements, where to change it instead.
 */
export function GeomListingCard({ node }: { node: SceneNode }) {
  const activeGeomIndex = useStore((s) => s.activeGeomIndex);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  if (!node.geoms || node.geoms.length < 2) return null;
  const idx = activeGeomIndex >= 0 && activeGeomIndex < node.geoms.length ? activeGeomIndex : 0;
  const geom = node.geoms[idx];
  if (!geom || geom.csgDerived) return null;
  return (
    <div className="flex flex-col gap-1.5 p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm">
      <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 font-medium cursor-pointer"
        title="Left out of the parts list unless Show generated parts is on. It still draws and collides.">
        <input type="checkbox" checked={!!geom.internal} className="accent-blue-500"
          onChange={(e) => updateNodeGeom(node.id, { internal: e.target.checked ? true : undefined }, idx)} />
        Generated part: hide from the parts list
      </label>
      {geomIsRebuilt(node, geom) && (
        <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">
          {geom.name || 'This part'} is rebuilt from the form's measurements, so it is not edited directly: change it with the Measurements card above.
        </p>
      )}
    </div>
  );
}
