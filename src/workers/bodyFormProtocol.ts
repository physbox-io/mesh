// The messages between utils/cloth/bodyFormClient.ts and workers/bodyFormWorker.ts.
// One file imported by both sides, so a changed shape is a type error.

import type { BodyFormMeasurements } from '../types/cloth';
import type { SceneGeom } from '../types/scene';

export type BodyFormRequest = { type: 'BUILD'; id: number; measurements: BodyFormMeasurements; prefix: string };

export type BodyFormResponse =
  | { type: 'BUILT'; id: number; geoms: SceneGeom[] }
  | { type: 'FAILED'; id: number; error: string };
