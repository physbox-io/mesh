import type { RefObject } from 'react';
import type * as THREE from 'three';
import { Printer } from 'lucide-react';
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
