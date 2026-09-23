import { useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { dfmLensFor } from '../../utils/dfm';
import { analyseDfmShared } from '../../utils/analysisCache';
import { buildHeatGeometry } from '../../utils/dfmHeatGeometry';

/**
 * The DFM heat map: the whole scene's surface, drawn again in the colour of
 * whatever is wrong with it.
 *
 * One mesh for the entire scene rather than a colour attribute per body. The
 * analysis already works on a single flat triangle soup and hands back one heat
 * value per triangle of it, so the overlay is that same soup with a colour
 * attribute — no indices, no per-geom bookkeeping, and no way for the colours to
 * end up on different triangles than the ones that were measured.
 *
 * Drawn slightly in front of the part with a polygon offset. Depth testing stays
 * ON, so the heat map is occluded by the geometry in front of it and reads as
 * paint on the surface rather than as an x-ray.
 */

export function DfmHeatmap() {
  const sceneGraph = useStore(state => state.sceneGraph);
  const dfmEnabled = useStore(state => state.dfmEnabled);
  const machineTarget = useStore(state => state.machineTarget);
  const castOpen = useStore(state => state.dfmCastOpen);
  const minimized = useStore(state => state.dfmPanel.minimized);
  const material = useStore(state => state.material);
  const filament = useStore(state => state.filament);
  const stock = useStore(state => state.stock);
  const selectedNodeId = useStore(state => state.selectedNodeId);

  const geometry = useMemo(() => {
    // Follows the panel: the casting section takes the colours with it, because
    // reading about undercuts while the viewport is still shaded for overhangs
    // is worse than showing neither. Rolled up, it stops sampling entirely.
    const lens = dfmEnabled && !minimized ? (castOpen ? 'cast' : dfmLensFor(machineTarget)) : null;
    if (!lens || !sceneGraph) return null;
    try {
      return buildHeatGeometry(analyseDfmShared(sceneGraph, lens, { material, filament, stock, nodeId: selectedNodeId }));
    } catch {
      // A scene the analyser cannot read should cost the viewport nothing.
      return null;
    }
  }, [sceneGraph, dfmEnabled, minimized, castOpen, machineTarget, material, filament, stock, selectedNodeId]);

  if (!geometry) return null;

  return (
    <mesh geometry={geometry} renderOrder={998} name="dfm-heatmap">
      {/* Both sides: an overhang is seen from underneath more often than not. */}
      <meshBasicMaterial
        vertexColors
        side={THREE.DoubleSide}
        transparent
        opacity={0.85}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}
