// The messages between utils/cloth/clothModelClient.ts and workers/clothModelWorker.ts.
// One file imported by both sides, so a changed shape is a type error.

import type { SceneNode } from '../types/scene';
import type { ClothModel } from '../utils/cloth/clothModel';

/** One cloth to model: its node, its world frame (column-major, as THREE.Matrix4.elements), and the scene as the physics worker gets it. */
export type ClothModelRequest = { type: 'MODEL'; id: number; node: SceneNode; world: number[]; nodes: SceneNode[] };

export type ClothModelResponse =
  | { type: 'MODELLED'; id: number; model: ClothModel }
  | { type: 'FAILED'; id: number; error: string };
