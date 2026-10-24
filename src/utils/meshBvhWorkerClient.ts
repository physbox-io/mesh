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
    const id = ++this.seq;
    return new Promise<MeshBVH>((resolve, reject) => {
      this.pending = { id, reject };
      worker.onerror = (e) => {
        this.pending = null;
        reject(new Error(`BVH worker: ${e.message || 'could not start'}`));
      };
      worker.onmessage = (evt: MessageEvent<MeshBvhResponse>) => {
        const msg = evt.data;
        if (msg.id !== id) return;
        this.pending = null;
        if (!msg.ok) {
          reject(new Error(msg.error));
          return;
        }
        (geometry.attributes.position as BufferAttribute).array = msg.position;
        const index = msg.serialized.index as Uint32Array | Uint16Array | null;
        if (index) {
          if (geometry.index) geometry.index.array = index;
          else geometry.setIndex(new BufferAttribute(index, 1, false));
        }
        const bvh = MeshBVH.deserialize(msg.serialized, geometry, { setIndex: false });
        geometry.boundingBox = bvh.getBoundingBox(new Box3());
        resolve(bvh);
      };

      const position = geometry.attributes.position.array as Float32Array;
      const index = (geometry.index?.array ?? null) as Uint32Array | Uint16Array | null;
      const transfer: Transferable[] = [position.buffer as ArrayBuffer];
      if (index) transfer.push(index.buffer as ArrayBuffer);
      const { onProgress: _onProgress, ...rest } = options;
      const request: MeshBvhRequest = { id, position, index, groups: [...geometry.groups], options: { ...rest } };
      worker.postMessage(request, transfer);
    });
  }

  dispose(): void {
    this.pending?.reject(new Error('BVH worker was disposed mid-build'));
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
  }
}
