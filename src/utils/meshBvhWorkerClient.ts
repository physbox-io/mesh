import { Box3, BufferAttribute, type BufferGeometry } from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import type { MeshBvhRequest, MeshBvhResponse } from '../workers/meshBvhProtocol';

/**
 * The BVH worker, in the shape three-gpu-pathtracer's setBVHWorker expects:
 * `generate(geometry, options)` resolving to a MeshBVH over that geometry.
 *
 * The geometry's position and index arrays are transferred to the worker and
 * come back with the tree, so they are put back on the geometry before it
 * resolves; until then the geometry has none, and nothing may read it. One job
 * at a time, as the tracer only ever asks for one.
 */
export class MeshBvhWorkerClient {
  private worker: Worker | null;
  private seq = 0;
  private pending: { id: number; reject: (e: Error) => void } | null = null;

  constructor() {
    this.worker = new Worker(new URL('../workers/meshBvhWorker.ts', import.meta.url), { type: 'module' });
  }

  generate(geometry: BufferGeometry, options: MeshBVHOptions = {}): Promise<MeshBVH> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('BVH worker has been disposed'));
    if (this.pending) return Promise.reject(new Error('BVH worker is already building'));
    const posAttr = geometry.attributes.position as BufferAttribute | undefined;
    if (!posAttr || !(posAttr.array instanceof Float32Array)) {
      return Promise.reject(new Error('BVH worker requires a Float32Array position attribute'));
    }
    const id = ++this.seq;
    return new Promise<MeshBVH>((resolve, reject) => {
      const standalone = <T extends Float32Array | Uint32Array | Uint16Array>(arr: T): T =>
        arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength ? arr : (arr.slice() as T);
      const position = standalone(posAttr.array as Float32Array);
      const rawIndex = (geometry.index?.array ?? null) as Uint32Array | Uint16Array | null;
      const index = rawIndex
        ? (rawIndex.buffer === position.buffer ? (rawIndex.slice() as Uint32Array | Uint16Array) : standalone(rawIndex))
        : null;
      const detachedPos = position === posAttr.array;
      const detachedIdx = !!rawIndex && index === rawIndex;

      this.pending = { id, reject };
      worker.onerror = (e) => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        reject(new Error(`BVH worker: ${e.message || 'could not start'}`));
      };
      worker.onmessageerror = () => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        reject(new Error('BVH worker: response could not be deserialized'));
      };
      worker.onmessage = (evt: MessageEvent<MeshBvhResponse>) => {
        const msg = evt.data;
        if (msg.id !== id) return;
        this.pending = null;
        if (!msg.ok) {
          if (detachedPos && msg.position) posAttr.array = msg.position;
          if (detachedIdx && msg.index && geometry.index) geometry.index.array = msg.index;
          reject(new Error(msg.error));
          return;
        }
        if (detachedPos) posAttr.array = msg.position;
        const outIndex = msg.serialized.index as Uint32Array | Uint16Array | null;
        if (outIndex) {
          if (geometry.index && geometry.index.array.constructor === outIndex.constructor && geometry.index.count === outIndex.length) {
            geometry.index.array = outIndex;
            geometry.index.needsUpdate = true;
          } else {
            geometry.setIndex(new BufferAttribute(outIndex, 1, false));
          }
        }
        const bvh = MeshBVH.deserialize(msg.serialized, geometry, { setIndex: false });
        geometry.boundingBox = bvh.getBoundingBox(new Box3());
        resolve(bvh);
      };

      const transferSet = new Set<ArrayBuffer>();
      if (position.byteLength > 0) transferSet.add(position.buffer as ArrayBuffer);
      if (index && index.byteLength > 0) transferSet.add(index.buffer as ArrayBuffer);
      const transfer: Transferable[] = Array.from(transferSet);
      const { onProgress: _onProgress, ...rest } = options;
      const request: MeshBvhRequest = { id, position, index, groups: [...geometry.groups], options: { ...rest } };
      try {
        worker.postMessage(request, transfer);
      } catch (err) {
        this.pending = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.pending?.reject(new Error('BVH worker was disposed mid-build'));
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
