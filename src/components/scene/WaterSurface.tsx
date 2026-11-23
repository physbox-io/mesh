import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { collectWaterBasins } from '../../utils/hydrostatics';

const NOOP_RAYCAST = () => null;

/**
 * Renders translucent 3D freshwater volumes strictly inside open-top containers
 * that have `waterFill > 0` (plus legacy plane fallback only if `waterLevel` is
 * set on a scene without container basins). Disables raycasting so clicking and
 * dragging floating objects works straight through the water.
 */
export function WaterSurface({ darkMode }: { darkMode: boolean }) {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const waterLevel = useStore((s) => s.waterLevel);
  const invalidate = useThree((s) => s.invalidate);

  const basins = useMemo(() => collectWaterBasins(sceneGraph?.nodes ?? []), [sceneGraph]);

  useEffect(() => {
    invalidate();
  }, [basins, waterLevel, darkMode, invalidate]);

  if (basins.length > 0) {
    return (
      // Z-up -> Three.js Y-up group matching SceneLayer's primitive coordinate frame
      <group rotation={[-Math.PI / 2, 0, 0]} userData={{ skipExport: true, isOverlay: true }}>
        {basins.map((b) => {
          const cx = 0.5 * (b.minX + b.maxX);
          const cy = 0.5 * (b.minY + b.maxY);
          const depthZ = Math.max(0.002, b.surfaceZ - b.floorZ);
          const cz = b.floorZ + 0.5 * depthZ;
          const spanX = Math.max(0.004, b.maxX - b.minX);
          const spanY = Math.max(0.004, b.maxY - b.minY);
          const rMean = 0.25 * (spanX + spanY);

          return (
            <group key={b.containerNodeId}>
              {/* 3D bounded translucent water volume inside the container */}
              <mesh
                position={[cx, cy, cz]}
                rotation={b.shape === 'cylinder' ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
                raycast={NOOP_RAYCAST}
                renderOrder={2}
              >
                {b.shape === 'cylinder' ? (
                  <cylinderGeometry args={[rMean, rMean, depthZ, 36]} />
                ) : (
                  <boxGeometry args={[spanX, spanY, depthZ]} />
                )}
                <meshPhysicalMaterial
                  color={darkMode ? '#0ea5e9' : '#38bdf8'}
                  transparent
                  opacity={darkMode ? 0.30 : 0.25}
                  roughness={0.10}
                  metalness={0.04}
                  clearcoat={0.75}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                />
              </mesh>

              {/* Crisp bright meniscus surface cap right at Z = surfaceZ */}
              <mesh
                position={[cx, cy, b.surfaceZ]}
                raycast={NOOP_RAYCAST}
                renderOrder={3}
              >
                {b.shape === 'cylinder' ? (
                  <circleGeometry args={[rMean, 36]} />
                ) : (
                  <planeGeometry args={[spanX, spanY]} />
                )}
                <meshPhysicalMaterial
                  color={darkMode ? '#38bdf8' : '#0284c7'}
                  transparent
                  opacity={darkMode ? 0.24 : 0.18}
                  roughness={0.06}
                  clearcoat={0.9}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                />
              </mesh>
            </group>
          );
        })}
      </group>
    );
  }

  if (waterLevel === null || !Number.isFinite(waterLevel)) return null;

  return (
    <group position={[0, waterLevel, 0]} userData={{ skipExport: true, isOverlay: true }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} raycast={NOOP_RAYCAST} renderOrder={2}>
        <planeGeometry args={[12, 12, 1, 1]} />
        <meshPhysicalMaterial
          color={darkMode ? '#0ea5e9' : '#38bdf8'}
          transparent
          opacity={darkMode ? 0.28 : 0.24}
          roughness={0.12}
          metalness={0.05}
          clearcoat={0.6}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
