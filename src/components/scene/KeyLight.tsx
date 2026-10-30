import { useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { SceneNode } from '../../types/scene';
import { sceneContentBounds } from '../../utils/frameScene';
import { KEY_LIGHT_OFFSET, shadowFrame } from '../../utils/shadowFrame';

/**
 * The shadow-casting key light, and the ground plane that catches its shadows.
 * Both follow the scene's extent (utils/shadowFrame.ts): at bench scale that
 * is the ±0.8 m box on the origin they always were.
 */
export function KeyLight({ darkMode, hiRes, nodes }: { darkMode: boolean; hiRes: boolean; nodes: SceneNode[] }) {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const invalidate = useThree((s) => s.invalidate);
  const frame = useMemo(() => shadowFrame(sceneContentBounds(nodes)), [nodes]);
  const [cx, cz] = frame.center;
  const { half, far } = frame;

  // three allocates a shadow map once and never resizes it, so a new mapSize
  // only takes once the old map is gone. Layout effect: the frame the switch
  // asked for must find the map already dropped.
  useLayoutEffect(() => {
    const shadow = lightRef.current?.shadow;
    if (!shadow?.map) return;
    shadow.map.dispose();
    shadow.map = null;
  }, [hiRes]);

  // The light's target is not in the scene graph, so nothing updates its
  // matrix but this; and the shadow camera's box needs its projection rebuilt.
  useLayoutEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    light.target.position.set(cx, 0, cz);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.far = far;
    cam.updateProjectionMatrix();
    invalidate();
  }, [cx, cz, half, far, invalidate]);

  return (
    <>
      {/* The shadow camera is an orthographic box, and its default is +/-5m
          with a 512px map. This scene lives at part scale — the camera
          sits about 300mm out and shows 250mm of world — so the default
          spends its whole depth texture on empty space and resolves a
          part's shadow at roughly 20mm per texel, which is mush. Bounded
          to +/-0.8m at 2048px it lands near 0.8mm per texel instead,
          which is what a 250mm part needs to cast a shadow with an edge
          on it rather than a grey cloud. A scene laid out wider than that
          gets a box to fit it, at a coarser texel (shadowFrame.ts).
          normalBias offsets the lookup along the surface normal, which is
          what keeps a body resting flat on the ground from shadow-acneing
          itself into stripes. 0.01 was tuned against that case — coarse,
          low-poly primitives. A lathed mesh with 96-120 radial wedges
          around a ~5cm cap works out to roughly 2-3mm of arc per wedge,
          right at this map's own ~2mm/texel resolution, so the acne
          shows up radiating with the wedges instead of as stripes. 0.03
          clears that without visible peter-panning at bench scale. */}
      {/* Hi-Res doubles the map (about 0.4mm per texel) and widens the
          PCF filter to soften the shadow's edge. Only so far: three r184
          filters with five taps rotated per pixel, so a wider radius goes
          grainy rather than softer. */}
      <directionalLight
        ref={lightRef}
        position={[cx + KEY_LIGHT_OFFSET[0], KEY_LIGHT_OFFSET[1], cz + KEY_LIGHT_OFFSET[2]]}
        intensity={darkMode ? 1.4 : 1.2}
        castShadow
        shadow-mapSize={hiRes ? [4096, 4096] : [2048, 2048]}
        shadow-radius={hiRes ? 4 : 1}
        shadow-camera-near={0.1}
        shadow-normalBias={0.03}
      />
      {/* Every geom already casts and receives, but until now nothing on
          the ground caught any of it: drei's Grid is a custom shader that
          doesn't receive shadows, so bodies only shadowed each other and
          the floor stayed clean. That's the one place the eye reads
          contact and height from, so a part hovering 20mm up looked
          identical to one sitting down.
          ShadowMaterial draws nothing but the shadow itself, so the grid
          still shows through underneath. Sized to match the shadow
          camera's footprint exactly — a larger plane would sample
          outside the depth texture and smear its edge texels outward.
          raycast is stubbed off deliberately: a plane across the
          viewport floor would otherwise swallow every background click,
          and onPointerMissed — the only thing that clears the selection —
          would never fire again. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[cx, 0, cz]}
        receiveShadow
        raycast={() => null}
      >
        <planeGeometry args={[2 * half, 2 * half]} />
        <shadowMaterial transparent opacity={darkMode ? 0.5 : 0.32} depthWrite={false} />
      </mesh>
    </>
  );
}
