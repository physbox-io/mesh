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
import { checkSplit, cutAlongPlane, splitForPrint, type SplitSection } from '../utils/printSplit';
import { runStage, type MujocoLike } from '../utils/printAssembly';
import type { PrintSplitRequest, PrintSplitResponse } from './printSplitProtocol';
import { collectTransferables } from './transferables';

const post = (msg: PrintSplitResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let mujoco: Promise<MujocoLike> | null = null;
let activeJobId: number | null = null;
let activeAborted = false;

async function instantiateMujocoWasm(
  imports: WebAssembly.Imports,
): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  const response = await fetch(mujocoWasmUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch MuJoCo WASM (${response.status} ${response.statusText}).`);
  }
  if (typeof WebAssembly.instantiateStreaming === 'function') {
    try {
      return await WebAssembly.instantiateStreaming(response.clone(), imports);
    } catch {
      // Fallback when the server serves .wasm with a non-application/wasm MIME type.
    }
  }
  const bytes = await response.arrayBuffer();
  return WebAssembly.instantiate(bytes, imports);
}

function loadMujoco(): Promise<MujocoLike> {
  if (!mujoco) {
    mujoco = new Promise<MujocoLike>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        mujoco = null;
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      load_mujoco({
        instantiateWasm: (
          imports: WebAssembly.Imports,
          done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
        ) => {
          instantiateMujocoWasm(imports).then(
            (result) => done(result.instance, result.module),
            fail,
          );
          return {};
        },
        onAbort: (what: unknown) => {
          const reason = `MuJoCo aborted: ${what instanceof Error ? what.message : String(what)}`;
          mujoco = null;
          if (!settled) {
            fail(new Error(reason));
          } else if (activeJobId !== null && !activeAborted) {
            activeAborted = true;
            post({ type: 'FAILED', id: activeJobId, error: reason });
          }
        },
      } as Parameters<typeof load_mujoco>[0]).then(
        (m) => {
          if (!settled) {
            settled = true;
            resolve(m as unknown as MujocoLike);
          }
        },
        fail,
      );
    });
    mujoco.catch(() => { mujoco = null; });
  }
  return mujoco;
}

const buffersOf = (sections: SplitSection[]): ArrayBuffer[] => collectTransferables(sections);

async function handleMessage(msg: PrintSplitRequest): Promise<void> {
  if (msg.type === 'WARM') {
    await loadManifold().catch(() => undefined);
    return;
  }
  activeJobId = msg.id;
  activeAborted = false;
  try {
    if (msg.type === 'SPLIT') {
      const wasm = await loadManifold();
      const result = splitForPrint(wasm, msg.soups, msg.options);
      const checks = result.ok ? checkSplit(wasm, result.sections, result.joints, msg.soups) : null;
      post({ type: 'SPLIT_DONE', id: msg.id, result, checks }, result.ok ? buffersOf(result.sections) : []);
      return;
    }
    if (msg.type === 'PLANE_CUT') {
      const wasm = await loadManifold();
      const result = cutAlongPlane(wasm, msg.soups, msg.at, msg.normal);
      post({ type: 'PLANE_CUT_DONE', id: msg.id, result }, result.ok ? buffersOf(result.sections) : []);
      return;
    }
    const mj = await loadMujoco();
    for (let k = 0; k < msg.stages.length; k++) {
      if (activeAborted) return;
      const { xml, stage } = msg.stages[k];
      let result;
      try {
        result = runStage(mj, xml, stage);
      } catch (err) {
        if (activeAborted) return;
        result = {
          label: stage.label, kind: stage.kind, cut: stage.cut, ok: false, seated: false,
          gapMm: NaN, lateralMm: NaN, angleDeg: NaN, playMm: null, twistDeg: null,
          rotates: false, diverged: true, approximate: false,
          notes: [`MuJoCo would not load this stage: ${err instanceof Error ? err.message : String(err)}`],
          frames: [],
        };
      }
      if (activeAborted) return;
      post({ type: 'ASSEMBLE_PROGRESS', id: msg.id, done: k + 1, total: msg.stages.length, result });
    }
    if (!activeAborted) post({ type: 'ASSEMBLE_DONE', id: msg.id });
  } catch (err) {
    if (!activeAborted) {
      post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    activeJobId = null;
    activeAborted = false;
  }
}

// Serialize all incoming messages so concurrent arrivals during async WASM
// instantiation never interleave out of order.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (evt: MessageEvent<PrintSplitRequest>) => {
  const msg = evt.data;
  queue = queue.then(() => handleMessage(msg));
};
