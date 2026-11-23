/// <reference lib="webworker" />

// Builds the path tracer's BVH off the main thread.
//
// Render mode merges every body into one geometry and builds a SAH tree over
// it, one triangle a leaf. On a sculpt-and-mould scene of 600 k triangles that
// build alone is about 3 s, and on the main thread it was 3 s of a frozen page
// with no word of why. three-mesh-bvh ships a worker for this, but it finds its
// script by import.meta.url from inside node_modules, which Vite's dependency
// pre-bundling moves; a worker of our own, beside the others, avoids that.
//
// utils/meshBvhWorkerClient.ts is the other half.

import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import type { MeshBvhRequest, MeshBvhResponse } from './meshBvhProtocol';
import { collectTransferables } from './transferables';

const post = (msg: MeshBvhResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (evt: MessageEvent<MeshBvhRequest>) => {
  const { id, position, index, groups, options } = evt.data;
  try {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3, false));
    if (index) geometry.setIndex(new BufferAttribute(index, 1, false));
    for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex);

    const bvh = new MeshBVH(geometry, options as MeshBVHOptions);
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const reply: MeshBvhResponse = { id, ok: true, serialized, position };
    post(reply, collectTransferables({ serialized, position }));
  } catch (e) {
    post(
      { id, ok: false, error: e instanceof Error ? e.message : String(e), position, index },
      collectTransferables({ position, index }),
    );
  }
};
