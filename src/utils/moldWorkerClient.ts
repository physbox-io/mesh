// ---------------------------------------------------------------------------
// The export modal's end of the mold worker
// ---------------------------------------------------------------------------
//
// One worker per open modal, torn down with it. Requests are numbered and
// answered in order — the worker is single-threaded and handles one message at a
// time — so the caller can tell a stale answer from the current one by its id
// and drop what it no longer wants.
//
// Falls back to generating inline where there is no Worker at all (a test
// environment, an ancient browser). That path blocks, which is the thing this
// module exists to avoid, but a modal that works slowly beats one that does not
// work.

import {
  generateMoldMeshes,
  moldSummary,
  trianglesToBuffers,
  type MoldHalfBuffers,
  type MoldOptions,
  type MoldSummary,
} from './moldExporter';
import type { SceneGraph } from '../types/scene';

export interface MoldPreview {
  summary: MoldSummary;
  bottom: MoldHalfBuffers;
  top: MoldHalfBuffers | null;
}

type Settle = { resolve: (v: never) => void; reject: (e: Error) => void };

export class MoldWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Settle>();
  /** The scene the worker already holds, so a slider drag sends options alone. */
  private sceneSent: SceneGraph | null = null;
  private lastResult: ReturnType<typeof generateMoldMeshes> | null = null;

  constructor() {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('../workers/moldWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (evt: MessageEvent) => {
        const msg = evt.data;
        const settle = this.pending.get(msg.id);
        if (!settle) return;
        this.pending.delete(msg.id);
        if (msg.type === 'FAILED') settle.reject(new Error(msg.message));
        else if (msg.type === 'GENERATED') {
          settle.resolve({ summary: msg.summary, bottom: msg.bottom, top: msg.top } as never);
        } else if (msg.type === 'STL') settle.resolve(msg.bytes as never);
      };
      // A worker that dies leaves every caller awaiting forever otherwise.
      this.worker.onerror = () => {
        const failed = new Error('The mold worker stopped.');
        for (const settle of this.pending.values()) settle.reject(failed);
        this.pending.clear();
        this.sceneSent = null;
      };
    } catch {
      this.worker = null;
    }
  }

  /** Numbers a request and hands back the promise its answer will settle. */
  private send<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker!.postMessage({ ...message, id }, transfer);
    });
  }

  generate(scene: SceneGraph, options: Partial<MoldOptions>): Promise<MoldPreview> {
    if (!this.worker) {
      const result = generateMoldMeshes(scene, options);
      this.lastResult = result;
      return Promise.resolve({
        summary: moldSummary(result),
        bottom: trianglesToBuffers(result.bottomHalf.triangles),
        top: result.topHalf ? trianglesToBuffers(result.topHalf.triangles) : null,
      });
    }

    const fresh = scene !== this.sceneSent;
    this.sceneSent = scene;
    return this.send<MoldPreview>({ type: 'GENERATE', options, ...(fresh ? { scene } : {}) });
  }

  /** The plate as binary STL, encoded from whatever was generated last. */
  stl(): Promise<Uint8Array> {
    if (!this.worker) return Promise.resolve(this.lastResult?.binarySTL ?? new Uint8Array(84));
    return this.send<Uint8Array>({ type: 'STL' });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.sceneSent = null;
  }
}
