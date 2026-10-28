/**
 * Whether the physics worker is running the scene the document describes.
 *
 * `isLoaded` goes true on the first build and stays true, and
 * `lastCompileError` is only cleared by a build that succeeds, so neither can
 * tell a scene the worker has never built - an edit whose build has not
 * landed, or a worker that has died - from one it is running. This can: it
 * compares the document with the graph the installed model was built from
 * (see store/modelProvenance.ts), and says how long ago the worker last sent
 * a frame.
 */
import type { SceneGraph } from '../types/scene';
import { staleBodies } from './sceneSummary';

/** Playing, and nothing from the worker for this long: it is not stepping. */
export const FRAME_STALL_MS = 2000;

export interface WorkerStatusInput {
  graph: SceneGraph;
  hasModel: boolean;
  builtFrom: SceneGraph | null;
  builtAt: number;
  frame: { at: number; simTime: number | null } | null;
  isPlaying: boolean;
  compiling: boolean;
  /** The tab is in the background, where the step loop is throttled by the browser. */
  hidden: boolean;
  now: number;
}

export interface WorkerStatus {
  /** The model the worker holds was built from the scene as it now stands. */
  sceneBuilt: boolean;
  /** Bodies the installed model does not describe (new, or changed since). */
  staleBodies: number;
  compiling: boolean;
  lastBuildAgoMs: number | null;
  lastFrameAgoMs: number | null;
  simTime: number | null;
  /** Playing in a visible tab, and no frame for FRAME_STALL_MS: the worker is not stepping. */
  stalled: boolean;
  note?: string;
}

export function describeWorker(i: WorkerStatusInput): WorkerStatus {
  const stale = staleBodies(i.graph, i.hasModel ? i.builtFrom : null).size;
  const sceneBuilt = i.hasModel && !!i.builtFrom && stale === 0;
  const lastFrameAgoMs = i.frame ? i.now - i.frame.at : null;
  const stalled = i.isPlaying && !i.hidden && !i.compiling && (lastFrameAgoMs === null || lastFrameAgoMs > FRAME_STALL_MS);
  const note = stalled
    ? 'Playing, but the physics worker has sent nothing for over two seconds: it is not stepping.'
    : !sceneBuilt
      ? i.compiling
        ? 'A compile is in flight; the worker is still running the previous build.'
        : 'The worker is not running the scene as it now stands: it was never built, or its last compile failed (see lastCompileError).'
      : undefined;
  return {
    sceneBuilt,
    staleBodies: stale,
    compiling: i.compiling,
    lastBuildAgoMs: i.builtFrom ? i.now - i.builtAt : null,
    lastFrameAgoMs,
    simTime: i.frame?.simTime ?? null,
    stalled,
    ...(note ? { note } : {}),
  };
}
