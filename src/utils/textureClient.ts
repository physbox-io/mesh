// Thin postMessage client over the surface-pattern worker.
//
// Same answer as geomSurface.ts's texturedSurfaceOf, but async: the worker in
// a browser, the module directly under Node, where `Worker` does not exist.
// Either way the result lands in geomSurface's cache, so the exporters that
// run after the viewport has drawn a pattern find it already built.

import type { SceneGeom } from '../types/scene';
import type { TexturedSurface } from './surfaceTexture';
import {
  cachedTexturedSurface,
  geomLocalSurface,
  storeTexturedSurface,
  texturedSurfaceKey,
  texturedSurfaceOf,
} from './geomSurface';
import type { TextureRequest, TextureResponse } from '../workers/textureProtocol';
import { noteWorkerStopped } from './staleBuild';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (surface: TexturedSurface | null) => void>();
/** One build per key at a time: the viewport asks on every render. */
const inFlight = new Map<string, Promise<TexturedSurface | null>>();

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/textureWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<TextureResponse>) => {
      const msg = evt.data;
      const settle = pending.get(msg.id);
      if (!settle) return;
      pending.delete(msg.id);
      settle(msg.type === 'TEXTURE_DONE' ? msg.surface : null);
    };
    worker.onerror = () => {
      noteWorkerStopped();
      for (const settle of pending.values()) settle(null);
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * The geom's patterned surface, built off the main thread where it can be.
 * Resolves null when the geom has no patterns or the build failed; never
 * rejects.
 */
export function requestTexturedSurface(geom: SceneGeom, halfLen?: number): Promise<TexturedSurface | null> {
  if (!geom.textures?.length) return Promise.resolve(null);
  const hit = cachedTexturedSurface(geom, halfLen);
  if (hit) return Promise.resolve(hit);
  const key = texturedSurfaceKey(geom, halfLen);
  const running = inFlight.get(key);
  if (running) return running;

  const w = ensureWorker();
  const base = geomLocalSurface(geom, halfLen);
  let job: Promise<TexturedSurface | null>;
  if (!w || !base) {
    job = Promise.resolve(texturedSurfaceOf(geom, halfLen));
  } else {
    const textures = geom.textures;
    job = new Promise<TexturedSurface | null>((resolve) => {
      const id = ++seq;
      pending.set(id, (surface) => {
        if (surface) storeTexturedSurface(key, surface);
        resolve(surface);
      });
      const req: TextureRequest = {
        type: 'TEXTURE', id, textures, splits: geom.faceSplits,
        positions: Float64Array.from(base.positions),
        faces: Uint32Array.from(base.faces),
      };
      w.postMessage(req, [req.positions.buffer, req.faces.buffer]);
    });
  }
  inFlight.set(key, job);
  void job.finally(() => inFlight.delete(key));
  return job;
}
