import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import { GRID_FADE_RATIO, GRID_NAME } from './gridConstants';

/**
 * Keeps the grid's fade a fixed share of the view, however far out the camera
 * is.
 *
 * drei's `fadeDistance` is a distance in metres, and the camera's is not: a
 * fixed value means the fade is whatever the zoom happens to make of it. On a
 * 40 mm part, viewed from 120 mm, a four-metre fade is thirty windows away and
 * the graph paper is flat and hard-edged to the horizon; on a half-metre
 * pendulum viewed from 800 mm the same number is five windows and the ground
 * washes out right behind the model. Same setting, opposite complaints.
 *
 * So the fade follows the orbit distance instead — always GRID_FADE_RATIO
 * viewing distances out — and the grid reads the same at every zoom. Written
 * straight into the shader uniform in useFrame rather than through the prop,
 * because the prop is React state and this changes on every frame of a drag.
 */
export const GridFadeFollowsCamera = () => {
  const found = useRef<THREE.Mesh | undefined>(undefined);
  useFrame((state) => {
    // Looked up from the live scene rather than held from render, the same way
    // the near-plane effect in SceneLayer reads the camera through R3F's
    // get(): this writes into an object R3F owns, and a value captured during
    // render is not ours to modify. The lookup walks the whole scene, so what
    // it finds is kept until it leaves the scene rather than searched for
    // again every frame.
    if (!found.current?.parent) found.current = state.scene.getObjectByName(GRID_NAME) as THREE.Mesh | undefined;
    const grid = found.current;
    const material = grid?.material as THREE.ShaderMaterial | undefined;
    const uniform = material?.uniforms?.fadeDistance;
    if (!uniform) return;
    // OrbitControls is `makeDefault`, so R3F holds it and its target is what
    // the camera is actually circling — the distance to it is the scale of
    // what is on screen. Falling back to the origin covers the frame or two
    // before the controls mount.
    const target = (state.controls as { target?: THREE.Vector3 } | null)?.target;
    const distance = target ? state.camera.position.distanceTo(target) : state.camera.position.length();
    uniform.value = Math.max(0.05, distance * GRID_FADE_RATIO);
  });
  return null;
};
