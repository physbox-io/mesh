import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

/**
 * A faint glow lying on the ground at the world origin, so an empty scene
 * still shows where things will land. Flat on the floor rather than a
 * camera-facing sprite: a sprite's lower half sinks under the ground and the
 * glow reads as sitting above the origin. Sized by the grid cell so it scales
 * with the scene. A basic material that casts no shadow keeps it out of
 * exports and the path tracer, which only collect lit, shadow-casting meshes.
 */
export function OriginGlow({ darkMode, cellSizeMm }: { darkMode: boolean; cellSizeMm: number }) {
  const texture = useMemo(() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.15, 'rgba(255,255,255,0.4)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  const diameter = (cellSizeMm / 1000) * 1.6;
  return (
    <mesh
      name="origin-glow"
      rotation={[-Math.PI / 2, 0, 0]}
      // On the grid's own plane, which is drawn 5 mm below the floor:
      // at y = 0 the glow floats over the grid and parallax shifts it off the
      // axis crossing in any oblique view.
      position={[0, -0.0048, 0]}
      raycast={() => null}
    >
      <planeGeometry args={[diameter, diameter]} />
      <meshBasicMaterial
        map={texture}
        color={darkMode ? '#6ee7b7' : '#34d399'}
        transparent
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-1}
        toneMapped={false}
      />
    </mesh>
  );
}
