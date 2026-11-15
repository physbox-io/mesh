import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';

const NOOP_RAYCAST = () => null;

/**
 * Translucent free-surface water plane rendered only when `waterLevel` is enabled.
 * Uses Three.js Y-up (`y = waterLevel`, matching MuJoCo world `z = waterLevel`)
 * and disables raycasting so pointer selection/dragging works straight through water.
 */
export function WaterSurface({ darkMode }: { darkMode: boolean }) {
  const waterLevel = useStore((s) => s.waterLevel);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    invalidate();
  }, [waterLevel, darkMode, invalidate]);

  if (waterLevel === null || !Number.isFinite(waterLevel)) return null;

  return (
    <group position={[0, waterLevel, 0]}>
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
      <gridHelper
        args={[12, 48, darkMode ? '#0284c7' : '#0ea5e9', darkMode ? '#0c4a6e' : '#bae6fd']}
        position={[0, 0.0004, 0]}
        raycast={NOOP_RAYCAST}
      />
    </group>
  );
}
