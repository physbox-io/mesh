import { useMemo } from 'react';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { sceneContentBounds } from '../../utils/frameScene';
import { GRID_NAME } from './gridConstants';

/** How far behind the part the upright grid of a Front or Side view stands, metres. */
const BEHIND = 0.002;

/**
 * The graph paper: the floor, or in the Front and Side views a wall behind the
 * part.
 *
 * The floor is edge-on in a front or side view, so those views had no grid at
 * all and only Top Down did. In them the grid stands up square to the view,
 * just behind everything in the scene so it is never drawn over a part. It goes
 * back to the floor when the view does — orbiting off a flat view returns to
 * the perspective camera (see CameraController).
 *
 * Settings as SceneCanvas explains them where this is used; the fade is taken
 * over each frame by GridFadeFollowsCamera, which finds the grid by its name.
 */
export function GroundGrid({ cellSizeMm, darkMode }: { cellSizeMm: number; darkMode: boolean }) {
  const cameraView = useStore((s) => s.cameraView);
  const sceneGraph = useStore((s) => s.sceneGraph);

  // Three.js frame (Y-up); the document is Z-up: (x, y, z) -> (x, z, -y).
  const pose = useMemo((): { position: [number, number, number]; rotation: [number, number, number] } => {
    if (cameraView === 'front' || cameraView === 'side') {
      const bounds = sceneContentBounds(sceneGraph?.nodes ?? []);
      if (cameraView === 'front') {
        // Looking along +Y, so behind is the far +Y side.
        const y = (bounds?.max[1] ?? 0) + BEHIND;
        return { position: [0, 0, -y], rotation: [Math.PI / 2, 0, 0] };
      }
      // Looking along -X from the +X side, so behind is the low-X side.
      const x = (bounds?.min[0] ?? 0) - BEHIND;
      return { position: [x, 0, 0], rotation: [0, 0, Math.PI / 2] };
    }
    return { position: [0, -0.005, 0], rotation: [0, 0, 0] };
  }, [cameraView, sceneGraph]);

  return (
    <Grid
      name={GRID_NAME}
      infiniteGrid
      side={THREE.DoubleSide}
      fadeDistance={1.6}
      fadeStrength={0.8}
      sectionSize={(cellSizeMm / 1000) * 5}
      cellSize={cellSizeMm / 1000}
      cellColor={darkMode ? '#334155' : '#cbd5e1'}
      sectionColor={darkMode ? '#64748b' : '#94a3b8'}
      position={pose.position}
      rotation={pose.rotation}
    />
  );
}
