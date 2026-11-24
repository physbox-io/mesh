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

export interface TexturedSurfaceResult {
  surface: TexturedSurface | null;
  error: string | null;
}

interface QueuedTexture {
  id: number;
  key: string;
  geomName: string;
  geom: SceneGeom;
  halfLen?: number;
  positions: Float64Array;
  faces: Uint32Array;
  textures: NonNullable<SceneGeom['textures']>;
  splits: SceneGeom['faceSplits'];
  resolve: (result: TexturedSurfaceResult) => void;
}

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedTexture & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedTexture[] = [];
/** One build per key at a time: the viewport asks on every render. */
const inFlight = new Map<string, Promise<TexturedSurfaceResult>>();

function unpackSurface(packed: PackedTexturedSurface): TexturedSurface {
  return {
    vertices: packed.vertices,
    faces: packed.faces,
    ...(packed.paint
      ? {
          paint: {
            res: packed.paint.res,
            idx: packed.paint.idx,
            rgba: packed.paint.rgba,
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

function failAll(error: string): void {
  if (active) {
    clearTimeout(active.timer);
    const done = active;
    active = null;
    done.resolve({ surface: null, error });
  }
  while (queued.length > 0) queued.shift()!.resolve({ surface: null, error });
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
      if (msg.type === 'TEXTURE_DONE') {
        const surface = msg.packed ? unpackSurface(msg.packed) : (msg.surface ?? null);
        if (surface) storeTexturedSurface(done.key, surface);
        done.resolve({ surface, error: surface ? null : 'Surface pattern build returned no mesh.' });
      } else {
        done.resolve({ surface: null, error: msg.error || 'Surface pattern build failed.' });
      }
      pump();
    };
    const handleBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll(error);
    };
    w.onerror = () => handleBroken('The surface pattern worker stopped working.');
    w.onmessageerror = () => handleBroken('Could not read the surface pattern worker response.');
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
      try {
        next.resolve({ surface: texturedSurfaceOf(next.geom, next.halfLen), error: null });
      } catch (err) {
        next.resolve({ surface: null, error: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.resolve({ surface: null, error: 'The surface pattern build timed out.' });
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
    } catch (err) {
      clearTimeout(timer);
      active = null;
      dropWorker(w);
      next.resolve({ surface: null, error: err instanceof Error ? err.message : 'Failed to start surface pattern build.' });
    }
  }
}

/**
 * The geom's patterned surface plus any worker/timeout error message.
 * Never rejects.
 */
export function requestTexturedSurfaceWithStatus(geom: SceneGeom, halfLen?: number): Promise<TexturedSurfaceResult> {
  if (!geom.textures?.length) return Promise.resolve({ surface: null, error: null });
  const hit = cachedTexturedSurface(geom, halfLen);
  if (hit) return Promise.resolve({ surface: hit, error: null });
  const key = texturedSurfaceKey(geom, halfLen);
  const running = inFlight.get(key);
  if (running) return running;

  const base = geomLocalSurface(geom, halfLen);
  let job: Promise<TexturedSurfaceResult>;
  if (typeof Worker === 'undefined' || !base) {
    try {
      job = Promise.resolve({ surface: texturedSurfaceOf(geom, halfLen), error: null });
    } catch (err) {
      job = Promise.resolve({ surface: null, error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    const textures = geom.textures;
    const geomName = geom.name;
    // Supersede any queued (not yet active) build for the same geom so rapid
    // slider edits do not pile up stale jobs behind the active one.
    if (geomName) {
      for (let i = queued.length - 1; i >= 0; i--) {
        if (queued[i].geomName === geomName && queued[i].key !== key) {
          const [stale] = queued.splice(i, 1);
          stale.resolve({ surface: null, error: null });
        }
      }
    }
    job = new Promise<TexturedSurfaceResult>((resolve) => {
      queued.push({
        id: ++seq,
        key,
        geomName,
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

/**
 * The geom's patterned surface, built off the main thread where it can be.
 * Resolves null when the geom has no patterns or the build failed; never
 * rejects.
 */
export function requestTexturedSurface(geom: SceneGeom, halfLen?: number): Promise<TexturedSurface | null> {
  return requestTexturedSurfaceWithStatus(geom, halfLen).then((r) => r.surface);
}
