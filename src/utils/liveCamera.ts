import * as THREE from 'three';

// Registers references to the live R3F camera + OrbitControls target so the
// MCP bridge (which runs outside React, via useStore.getState()) can read the
// camera's CURRENT pose — including manual orbiting/panning done by a human
// in the browser after the last programmatic camera move — without any
// polling or per-frame store writes.
//
// This works because we store references to the actual mutable THREE.Vector3
// objects that OrbitControls mutates in place during drag, not snapshots:
// reading .x/.y/.z off them at any later point reflects whatever the user (or
// CameraController) has done to the camera since, with zero extra wiring.
let liveCamera: THREE.Camera | null = null;
let liveTarget: THREE.Vector3 | null = null;

export function registerLiveCamera(camera: THREE.Camera, target: THREE.Vector3) {
  liveCamera = camera;
  liveTarget = target;
}

// Three.js scene space -> MuJoCo world space. Inverse of the SceneVisuals
// group's rotation={[-Math.PI/2, 0, 0]} (which maps MuJoCo (x,y,z) to Three
// (x, z, -y)): given Three (x,y,z), MuJoCo is (x, -z, y).
const threeToMujoco = (x: number, y: number, z: number): [number, number, number] => [x, -z, y];

export type CameraPose = { position: [number, number, number]; target: [number, number, number] };

// Returns the camera's current pose in MuJoCo world space (same convention as
// every pos field elsewhere in the app), or null if the viewport hasn't
// mounted yet.
export function getLiveCameraPose(): CameraPose | null {
  if (!liveCamera || !liveTarget) return null;
  return {
    position: threeToMujoco(liveCamera.position.x, liveCamera.position.y, liveCamera.position.z),
    target: threeToMujoco(liveTarget.x, liveTarget.y, liveTarget.z),
  };
}
