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
import type { ScriptStatus } from '../workers/physicsWorkerProtocol';
import { SCRIPT_DOMINANT_SHARE, SLOW_RTF, type ScriptProblem } from '../workers/scriptDiagnostics';
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
  /** What the live scripts last reported (store/scriptStatus.ts). */
  scripts?: ScriptStatus | null;
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
  /** Live script mistakes since the run started (or the script changed), each with when and how often. */
  scriptProblems?: ScriptProblem[];
  /** Problems beyond those listed. */
  moreScriptProblems?: number;
  /** Sim seconds per wall second over the last second of play; 1 is real time. */
  realtimeFactor?: number;
  /** Mean wall time all scripts took per physics step over that second, ms. */
  scriptMsPerStep?: number;
  /** The most expensive script then. */
  slowestScript?: { body: string; msPerStep: number };
  note?: string;
}

const round = (v: number, digits: number) => +v.toFixed(digits);

/** Why live play is slower than real time, or undefined when it is not (or cannot be told). */
function slowNote(i: WorkerStatusInput): string | undefined {
  const t = i.scripts?.timing;
  if (!t || t.realtimeFactor === null || !i.isPlaying || i.hidden || t.realtimeFactor >= SLOW_RTF) return undefined;
  const rtf = `${t.realtimeFactor.toFixed(2)}x real time`;
  if (t.scriptShare >= SCRIPT_DOMINANT_SHARE) {
    const who = t.slowest ? ` (slowest: '${t.slowest.body}' at ${t.slowest.msPerStep.toFixed(2)} ms)` : '';
    return `Playing at ${rtf} because of the control scripts: they take ${t.scriptMsPerStep.toFixed(2)} ms per step${who} against a ${i.scripts!.timestepMs.toFixed(2)} ms timestep. Do less work per step, or only every Nth step (keep a counter on api.state).`;
  }
  return `Playing at ${rtf}: the model itself is slower to step than real time (scripts take only ${Math.round(t.scriptShare * 100)}% of the time). Fewer contacts, simpler colliders or a larger timestep would help.`;
}

export function describeWorker(i: WorkerStatusInput): WorkerStatus {
  const stale = staleBodies(i.graph, i.hasModel ? i.builtFrom : null).size;
  const sceneBuilt = i.hasModel && !!i.builtFrom && stale === 0;
  const lastFrameAgoMs = i.frame ? i.now - i.frame.at : null;
  const stalled = i.isPlaying && !i.hidden && !i.compiling && (lastFrameAgoMs === null || lastFrameAgoMs > FRAME_STALL_MS);
  const scripts = i.scripts;
  const problemCount = scripts?.problems.length ?? 0;
  const note = stalled
    ? 'Playing, but the physics worker has sent nothing for over two seconds: it is not stepping.'
    : !sceneBuilt
      ? i.compiling
        ? 'A compile is in flight; the worker is still running the previous build.'
        : 'The worker is not running the scene as it now stands: it was never built, or its last compile failed (see lastCompileError).'
      : slowNote(i) ?? (problemCount
        ? `The control scripts are failing: see scriptProblems (${problemCount}${scripts?.moreProblems ? '+' : ''}).`
        : undefined);
  const timing = scripts?.timing;
  return {
    sceneBuilt,
    staleBodies: stale,
    compiling: i.compiling,
    lastBuildAgoMs: i.builtFrom ? i.now - i.builtAt : null,
    lastFrameAgoMs,
    simTime: i.frame?.simTime ?? null,
    stalled,
    ...(scripts?.problems.length ? { scriptProblems: scripts.problems } : {}),
    ...(scripts?.moreProblems ? { moreScriptProblems: scripts.moreProblems } : {}),
    ...(timing && timing.realtimeFactor !== null ? { realtimeFactor: round(timing.realtimeFactor, 3) } : {}),
    ...(timing ? { scriptMsPerStep: round(timing.scriptMsPerStep, 3) } : {}),
    ...(timing?.slowest ? { slowestScript: { body: timing.slowest.body, msPerStep: round(timing.slowest.msPerStep, 3) } } : {}),
    ...(note ? { note } : {}),
  };
}
