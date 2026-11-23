import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useCastDialog } from '../../store/castDialogStore';
import { dfmLensFor } from '../../utils/dfm';
import { getLivePosedScene, useDfmFocus, useDfmReport } from '../../utils/dfmWorkerClient';
import { buildHeatGeometry } from '../../utils/dfmHeatGeometry';
import { livePoses } from './bodyPose';

/**
 * The DFM heat map: the analysed surface, drawn again in the colour of
 * whatever is wrong with it.
 *
 * One mesh for the entire scene rather than a colour attribute per body. The
 * analysis already works on a single flat triangle soup and hands back one heat
 * value per triangle of it, so the overlay is that same soup with a colour
 * attribute — no indices, no per-geom bookkeeping, and no way for the colours to
 * end up on different triangles than the ones that were measured.
 *
 * Because SceneCanvas enables `logarithmicDepthBuffer: true` (making WebGL
 * `polygonOffset` a no-op), `buildHeatGeometry` lifts each triangle slightly
 * outward along its geometric face normal, and the material renders front faces
 * with `depthWrite={false}` so faces never Z-fight or bleed through backfaces.
 */

const NO_RAYCAST = () => null;
const OVERLAY_USER_DATA = { isOverlay: true, skipExport: true } as const;

export function DfmHeatmap() {
  const open = useStore((state) => state.dfmEnabled && !state.dfmPanel.minimized);
  if (!open) return null;
  return <DfmHeatmapActive />;
}

function DfmHeatmapActive() {
  const sceneGraph = useStore(state => state.sceneGraph);
  const machineTarget = useStore(state => state.machineTarget);
  const castOpen = useStore(state => state.dfmCastOpen);
  const material = useStore(state => state.material);
  const filament = useStore(state => state.filament);
  const stock = useStore(state => state.stock);
  const printBed = useStore(state => state.printBed);
  const printer = useStore(state => state.printer);
  const selectedNodeId = useStore(state => state.selectedNodeId);
  const recompileId = useStore(state => state.recompileId);
  const isPlaying = useStore(state => state.isPlaying);
  const { checkAllAsPlate } = useDfmFocus();

  // Follows the panel: the casting section takes the colours with it, because
  // reading about undercuts while the viewport is still shaded for overhangs
  // is worse than showing neither. Rolled up, it stops sampling entirely.
  const lens = castOpen ? 'cast' : dfmLensFor(machineTarget);

  // Align heatmap triangles with post-simulation / VoltLink body poses using
  // the exact same shared SceneGraph reference as DfmHUD so both hit one cache.
  const live = useMemo(() => {
    // Re-read mutable MuJoCo poses after a sim pause or reset (`recompileId`).
    void recompileId;
    if (isPlaying || !sceneGraph) return null;
    return livePoses(sceneGraph.nodes || []);
  }, [sceneGraph, recompileId, isPlaying]);
  const effectiveScene = useMemo(
    () => (sceneGraph ? getLivePosedScene(sceneGraph, live) : null),
    [sceneGraph, live],
  );

  // The same bench, key for key, as the panel's, so the two share one analysis.
  const castMaterial = useCastDialog((s) => s.materialByTab.rigid);
  const bench = useMemo(
    () => ({
      material,
      filament,
      stock,
      printBed,
      printer,
      nodeId: selectedNodeId,
      ...(!selectedNodeId && checkAllAsPlate ? { checkAllAsPlate: true } : {}),
      ...(castMaterial ? { castMaterial } : {}),
    }),
    [material, filament, stock, printBed, printer, selectedNodeId, checkAllAsPlate, castMaterial],
  );
  const report = useDfmReport(effectiveScene, lens, bench);

  const geometry = useMemo(() => {
    if (!report) return null;
    try {
      return buildHeatGeometry(report);
    } catch {
      // A scene the analyser cannot read should cost the viewport nothing.
      return null;
    }
  }, [report]);
  // Passed in as a prop, so react-three-fiber leaves it alone: each edit's
  // geometry is freed here, or its GPU buffers outlive it.
  useEffect(() => () => geometry?.dispose(), [geometry]);

  if (!geometry) return null;

  return (
    <mesh
      geometry={geometry}
      renderOrder={998}
      userData={OVERLAY_USER_DATA}
      raycast={NO_RAYCAST}
    >
      <meshBasicMaterial
        vertexColors
        side={THREE.FrontSide}
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </mesh>
  );
}
