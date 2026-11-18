import type { RefObject } from 'react';
import type * as THREE from 'three';
import { Printer, Trash2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { useNodeStlExport } from '../../hooks/useMeshExport';
import type { SceneNode } from '../../types/scene';

/**
 * Export STL for this part alone — and the parts nested under it — as the
 * viewport draws it, so an OpenSCAD body, a boolean, a sculpt and a plain box
 * all export the same way. The bottom bar's STL writes the whole scene.
 */
export function ExportStlCard({ node, threeSceneRef }: { node: SceneNode; threeSceneRef: RefObject<THREE.Scene | null> }) {
  const exportNodeStl = useNodeStlExport(threeSceneRef);
  return (
    <button
      onClick={() => exportNodeStl(node)}
      className="flex items-center justify-center gap-2 w-full py-2 border border-emerald-200 rounded-lg text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-300 transition-colors shadow-sm cursor-pointer"
      title="Download this part on its own as a binary STL, in millimetres, Z up"
    >
      <Printer className="w-4 h-4" /> Export STL
    </button>
  );
}

/** Export STL and Delete Shape / Delete Component, together under the part's name. */
export function PartActions({ node, threeSceneRef }: { node: SceneNode; threeSceneRef: RefObject<THREE.Scene | null> }) {
  const deleteNode = useStore((s) => s.deleteNode);
  const deleteNodeGeom = useStore((s) => s.deleteNodeGeom);
  const setActiveGeomIndex = useStore((s) => s.setActiveGeomIndex);
  const geomFocused = useStore((s) => s.geomFocused);
  const activeGeomIndex = useStore((s) => s.activeGeomIndex);

  const focusedGeom = geomFocused && node.geoms && activeGeomIndex >= 0 && activeGeomIndex < node.geoms.length
    ? node.geoms[activeGeomIndex]
    : null;
  const hwGroup = focusedGeom?.hardware?.group;
  const canDeleteFocusedGeom = !!focusedGeom && (node.geoms ?? []).filter(
    (g, idx) => idx !== activeGeomIndex && !(hwGroup && g.hardware?.group === hwGroup) && !g.csgDerived && g.csg !== 'difference',
  ).length >= 1;

  return (
    <div className="flex flex-col gap-1.5">
      <ExportStlCard node={node} threeSceneRef={threeSceneRef} />
      {canDeleteFocusedGeom && focusedGeom && (
        <button
          onClick={() => {
            deleteNodeGeom(node.id, activeGeomIndex);
            setActiveGeomIndex(0, false);
          }}
          className="flex items-center justify-center gap-2 w-full py-2 border border-amber-300 dark:border-amber-800 rounded-lg text-xs font-semibold text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors shadow-sm cursor-pointer"
        >
          <Trash2 className="w-4 h-4" /> Delete Shape ({focusedGeom.name || `Geom ${activeGeomIndex + 1}`})
        </button>
      )}
      <button
        onClick={() => deleteNode(node.id)}
        className="flex items-center justify-center gap-2 w-full py-2 border border-red-200 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 hover:border-red-300 transition-colors shadow-sm cursor-pointer"
      >
        <Trash2 className="w-4 h-4" /> Delete Component
      </button>
    </div>
  );
}
