/**
 * Which scene the physics worker is actually running, and when it last said so.
 *
 * `isLoaded` goes true on the first build and stays true, and
 * `lastCompileError` is only cleared by a build that succeeds - so a scene
 * that never reached the worker (an edit whose build has not landed, or a
 * worker that has died) looked exactly like one that had. These two facts are
 * what tell them apart: the document graph the installed model was compiled
 * from, and the last frame the worker sent.
 *
 * Module state rather than store fields: nothing renders from it, and writing
 * it on every frame would wake every subscriber for nothing.
 */
import type { SceneGraph } from '../types/scene';

let builtFrom: SceneGraph | null = null;
let builtAt = 0;
let frameAt = 0;
let frameSimTime: number | null = null;

/** The document graph the model now installed was compiled from. */
export function noteModelBuilt(graph: SceneGraph): void {
  builtFrom = graph;
  builtAt = Date.now();
}

/** A frame arrived from the worker. */
export function noteWorkerFrame(simTime: number | undefined): void {
  frameAt = Date.now();
  if (typeof simTime === 'number') frameSimTime = simTime;
}

export function modelBuiltFrom(): { graph: SceneGraph | null; at: number } {
  return { graph: builtFrom, at: builtAt };
}

export function lastWorkerFrame(): { at: number; simTime: number | null } | null {
  return frameAt ? { at: frameAt, simTime: frameSimTime } : null;
}
