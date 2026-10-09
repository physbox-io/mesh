/// <reference lib="webworker" />

// Split for Print, off the main thread: the search, the joinery, the exact
// checks, and the assembly test's MuJoCo runs.
//
// The search builds hundreds of Manifold solids for a big part, and an assembly
// test is thousands of MuJoCo steps a stage. Either on the main thread is the
// viewport frozen with the dialog open over it.
//
// utils/printSplit.ts and utils/printAssembly.ts stay Worker-free, so the tests
// call them directly and only the browser pays for this. The stage models come
// here already compiled: mjcf.ts drags in the CSG evaluator and three.js, and
// keeping those out of this bundle is the lesson of two Cloud Build failures.

import load_mujoco from '@mujoco/mujoco';
// The asset the Emscripten glue would fetch, as a URL; see physicsWorker.ts.
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { loadManifold } from '../utils/sculptCut';
import { checkSplit, splitForPrint, type SplitSection } from '../utils/printSplit';
import { runStage, type MujocoLike } from '../utils/printAssembly';
import type { PrintSplitRequest, PrintSplitResponse } from './printSplitProtocol';

const post = (msg: PrintSplitResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let mujoco: Promise<MujocoLike> | null = null;
function loadMujoco(): Promise<MujocoLike> {
  mujoco ??= new Promise<MujocoLike>((resolve, reject) => {
    load_mujoco({
      instantiateWasm: (
        imports: WebAssembly.Imports,
        done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
      ) => {
        WebAssembly.instantiateStreaming(fetch(mujocoWasmUrl), imports).then(
          (result) => done(result.instance, result.module),
          reject,
        );
        return {};
      },
    } as Parameters<typeof load_mujoco>[0]).then((m) => resolve(m as unknown as MujocoLike), reject);
  });
  mujoco.catch(() => { mujoco = null; });
  return mujoco;
}

const buffersOf = (s: SplitSection): ArrayBuffer[] => [
  s.positions.buffer, s.faces.buffer, s.plainPositions.buffer, s.plainFaces.buffer,
  ...s.convexPieces.flatMap((p) => [p.positions.buffer, p.faces.buffer]),
] as ArrayBuffer[];

self.onmessage = async (evt: MessageEvent<PrintSplitRequest>) => {
  const msg = evt.data;
  if (msg.type === 'WARM') {
    void loadManifold().catch(() => undefined);
    return;
  }
  try {
    if (msg.type === 'SPLIT') {
      const wasm = await loadManifold();
      const result = splitForPrint(wasm, msg.soups, msg.options);
      const checks = result.ok ? checkSplit(wasm, result.sections, result.joints, msg.soups) : null;
      post({ type: 'SPLIT_DONE', id: msg.id, result, checks }, result.ok ? result.sections.flatMap(buffersOf) : []);
      return;
    }
    const mj = await loadMujoco();
    msg.stages.forEach(({ xml, stage }, k) => {
      let result;
      try {
        result = runStage(mj, xml, stage);
      } catch (err) {
        result = {
          label: stage.label, kind: stage.kind, cut: stage.cut, ok: false, seated: false,
          gapMm: NaN, lateralMm: NaN, angleDeg: NaN, playMm: null, twistDeg: null,
          rotates: false, diverged: true, approximate: false,
          notes: [`MuJoCo would not load this stage: ${err instanceof Error ? err.message : String(err)}`],
          frames: [],
        };
      }
      post({ type: 'ASSEMBLE_PROGRESS', id: msg.id, done: k + 1, total: msg.stages.length, result });
    });
    post({ type: 'ASSEMBLE_DONE', id: msg.id });
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
