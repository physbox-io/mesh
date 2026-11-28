/// <reference lib="webworker" />

// One cloth's model (clothModel: a garment's shell, cut and flattened, or
// plain pieces meshed), off the physics worker: a scene's garments are
// modelled side by side on a few of these (clothModelClient), where the
// physics worker modelled them one after another, answering nothing meanwhile.

import * as THREE from 'three';
import { clothModel } from '../utils/cloth/clothModel';
import type { ClothModelRequest, ClothModelResponse } from './clothModelProtocol';
import { collectTransferables } from './transferables';

const post = (msg: ClothModelResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (evt: MessageEvent<ClothModelRequest>) => {
  const msg = evt.data;
  try {
    const model = clothModel(msg.node, new THREE.Matrix4().fromArray(msg.world), msg.nodes);
    post({ type: 'MODELLED', id: msg.id, model }, collectTransferables(model));
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
