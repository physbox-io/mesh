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
import type { PackedTexturedSurface, TextureRequest, TextureResponse } from '../workers/textureProtocol';
import { noteWorkerStopped } from './staleBuild';

const TEXTURE_TIMEOUT_MS = 60_000;

interface QueuedTexture {
  id: number;
  key: string;
  geom: SceneGeom;
  halfLen?: number;
  positions: Float64Array;
  faces: Uint32Array;
  textures: NonNullable<SceneGeom['textures']>;
  splits: SceneGeom['faceSplits'];
  resolve: (surface: TexturedSurface | null) => void;
}

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedTexture & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedTexture[] = [];
/** One build per key at a time: the viewport asks on every render. */
const inFlight = new Map<string, Promise<TexturedSurface | null>>();

function unpackSurface(packed: PackedTexturedSurface): TexturedSurface {
  return {
    vertices: Array.from(packed.vertices),
    faces: Array.from(packed.faces),
    ...(packed.paint
      ? {
          paint: {
            res: packed.paint.res,
            idx: Array.from(packed.paint.idx),
            rgba: Array.from(packed.paint.rgba),
          },
        }
      : {}),
    regions: packed.regions,
    warnings: packed.warnings,
  };
}

function dropWorker(w: Worker | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
  if (worker === w) worker = null;
}

function failAll(): void {
  if (active) {
    clearTimeout(active.timer);
    const done = active;
    active = null;
    done.resolve(null);
  }
  while (queued.length > 0) queued.shift()!.resolve(null);
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/textureWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<TextureResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      const surface =
        msg.type === 'TEXTURE_DONE'
          ? (msg.packed ? unpackSurface(msg.packed) : (msg.surface ?? null))
          : null;
      if (surface) storeTexturedSurface(done.key, surface);
      done.resolve(surface);
      pump();
    };
    const handleBroken = () => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll();
    };
    w.onerror = handleBroken;
    w.onmessageerror = handleBroken;
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function pump(): void {
  while (!active && queued.length > 0) {
    const next = queued.shift()!;
    const w = ensureWorker();
    if (!w) {
      next.resolve(texturedSurfaceOf(next.geom, next.halfLen));
      continue;
    }
    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.resolve(null);
      pump();
    }, TEXTURE_TIMEOUT_MS);
    active = { ...next, timer };
    try {
      const req: TextureRequest = {
        type: 'TEXTURE',
        id: next.id,
        textures: next.textures,
        splits: next.splits,
        positions: next.positions,
        faces: next.faces,
      };
      const transfer: Transferable[] = [];
      if (req.positions.byteLength > 0) transfer.push(req.positions.buffer);
      if (req.faces.byteLength > 0) transfer.push(req.faces.buffer);
      w.postMessage(req, transfer);
      return;
    } catch {
      clearTimeout(timer);
      active = null;
      next.resolve(null);
    }
  }
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

  const base = geomLocalSurface(geom, halfLen);
  let job: Promise<TexturedSurface | null>;
  if (typeof Worker === 'undefined' || !base) {
    job = Promise.resolve(texturedSurfaceOf(geom, halfLen));
  } else {
    const textures = geom.textures;
    job = new Promise<TexturedSurface | null>((resolve) => {
      queued.push({
        id: ++seq,
        key,
        geom,
        halfLen,
        positions: Float64Array.from(base.positions),
        faces: Uint32Array.from(base.faces),
        textures,
        splits: geom.faceSplits,
        resolve,
      });
      pump();
    });
  }
  inFlight.set(key, job);
  void job.finally(() => inFlight.delete(key));
  return job;
}
