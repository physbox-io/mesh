// Thin postMessage client over a pool of SCAD Workers (src/workers/scadWorker.ts).
//
// The workers own the openscad-wasm module, the per-compile WASM instances and
// the STL -> mesh conversion; this file does the plumbing and keeps the same
// exported API this module has always had, so call sites are unchanged.

import { noteWorkerStopped } from './staleBuild';

/*
 * Who hears about compiles starting and ending — the store's "SCAD Compiling"
 * counter, registered by App.
 *
 * Reported through a listener rather than by importing the store: csg.ts
 * reaches this module, the fracture and vhacd workers reach csg.ts, and the
 * store spawns both workers, so a store import here made each worker import
 * the other — a cycle Vite refuses to build.
 */
let compileListener: ((delta: 1 | -1) => void) | null = null;
export function setScadCompileListener(listener: ((delta: 1 | -1) => void) | null): void {
  compileListener = listener;
}

type CompiledScad = { vertices: number[]; faces: number[]; renderVertices: number[] };

// openscad-wasm has shared global state *within a realm*, which is why a single
// worker has to serialize its own compiles (see scadWorker.ts's enqueue) and why
// autoCompileScad used to compile sequentially. Separate workers each get their
// own realm and their own globals, so that constraint doesn't apply across them
// - N workers give genuine N-way parallelism for scenes with several scad nodes.
// Leave headroom for the main thread and the physics worker rather than claiming
// every core, and cap the pool since each worker holds multi-MB WASM memory.
const MAX_POOL_SIZE = Math.max(
  1,
  Math.min(4, ((typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) || 4) - 2),
);

// Each compile instantiates a fresh WASM module whose linear memory is never
// released - noExitRuntime:true and no dispose/free is exposed, and the CGAL
// caches alone run ~10MB per compile. Terminating the worker is the only way to
// actually reclaim it, so retire each one after a few compiles and immediately
// spawn a warm replacement. Cheap: a replacement's module load is served from
// the browser HTTP cache and is amortised over the next RECYCLE_AFTER compiles.
const RECYCLE_AFTER_COMPILES = 4;

// Retiring idle extra workers beyond the single warm standby reclaims their
// leaked Emscripten WASM linear memory after a multi-node compile burst.
const IDLE_EXTRA_WORKER_MS = 30_000;

interface Job {
  id: string;
  scad: string;
  resolve: (r: CachedScad) => void;
  reject: (e: unknown) => void;
}

interface PoolWorker {
  worker: Worker;
  // The single in-flight job. The pool never gives a worker a second job while
  // one is outstanding, so the worker's internal queue only ever has to
  // serialize a compile against its own lazy module load.
  job: Job | null;
  ready: boolean;
  compilesDone: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const pool: PoolWorker[] = [];
const queue: Job[] = [];

// Sticky: records that the openscad-wasm module has been fetched successfully at
// least once this session. Deliberately not tied to whether a worker is warm
// right now - a recycled pool refetches from the browser HTTP cache, so the
// "loading CAD engine" hint in the UI would otherwise flicker back on for a
// download that isn't actually happening.
let compilerReady = false;
let loadingPromise: Promise<void> | null = null;
let loadSettle: { resolve: () => void; reject: (e: unknown) => void } | null = null;

// Each compile spins up a brand-new WASM module instance with its own linear
// memory. That's expensive, and identical scad source reliably reappears across
// a session (reloading/iterating on the same design, retries, etc.) - cache by
// exact source text to avoid spinning up a fresh multi-MB WASM instance for work
// we've already done. Bounded by both entry count AND total byte budget so 50
// massive threaded parts can never pin gigabytes of RAM, and stored as compact
// TypedArrays (matching the worker's zero-copy wire transfer).
//
// Deliberately kept on this side of the worker boundary: a hit resolves in-tick
// with no message round-trip, exactly as it did when compiling was inline. It
// also survives worker recycling, which a worker-side cache would not.
interface CachedScad {
  vertices: Float64Array;
  faces: Uint32Array;
  renderVertices: Float64Array;
  bytes: number;
}

const compileCache = new Map<string, CachedScad>();
const COMPILE_CACHE_MAX = 50;
const COMPILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let compileCacheBytes = 0;

/** Deduplicates concurrent compiles of the exact same SCAD source. */
const inFlightCompiles = new Map<string, Promise<CachedScad>>();

function toCachedScad(
  vertices: ArrayLike<number>,
  faces: ArrayLike<number>,
  renderVertices: ArrayLike<number>,
): CachedScad {
  const v = vertices instanceof Float64Array ? vertices : Float64Array.from(vertices);
  const f = faces instanceof Uint32Array ? faces : Uint32Array.from(faces);
  const rv = renderVertices instanceof Float64Array ? renderVertices : Float64Array.from(renderVertices);
  return {
    vertices: v,
    faces: f,
    renderVertices: rv,
    bytes: v.byteLength + f.byteLength + rv.byteLength,
  };
}

function materializeCompiled(c: CachedScad): CompiledScad {
  return {
    vertices: Array.from(c.vertices),
    faces: Array.from(c.faces),
    renderVertices: Array.from(c.renderVertices),
  };
}

function storeCachedScad(scadCode: string, entry: CachedScad): void {
  const existing = compileCache.get(scadCode);
  if (existing) {
    compileCacheBytes -= existing.bytes;
    compileCache.delete(scadCode);
  }
  while (
    compileCache.size > 0 &&
    (compileCache.size >= COMPILE_CACHE_MAX || compileCacheBytes + entry.bytes > COMPILE_CACHE_MAX_BYTES)
  ) {
    const oldest = compileCache.entries().next().value;
    if (!oldest) break;
    compileCache.delete(oldest[0]);
    compileCacheBytes -= oldest[1].bytes;
  }
  compileCache.set(scadCode, entry);
  compileCacheBytes += entry.bytes;
}

function clearIdleTimer(pw: PoolWorker): void {
  if (pw.idleTimer !== null) {
    clearTimeout(pw.idleTimer);
    pw.idleTimer = null;
  }
}

function scheduleIdleRetire(pw: PoolWorker): void {
  clearIdleTimer(pw);
  if (pool.length <= 1 || pw.job) return;
  pw.idleTimer = setTimeout(() => {
    pw.idleTimer = null;
    if (!pw.job && pool.length > 1) retire(pw);
  }, IDLE_EXTRA_WORKER_MS);
  (pw.idleTimer as { unref?: () => void }).unref?.();
}

function retire(pw: PoolWorker) {
  clearIdleTimer(pw);
  const idx = pool.indexOf(pw);
  if (idx !== -1) pool.splice(idx, 1);
  pw.worker.onmessage = null;
  pw.worker.onerror = null;
  pw.worker.onmessageerror = null;
  pw.worker.terminate();
}

function spawn(): PoolWorker {
  const pw: PoolWorker = {
    worker: new Worker(new URL('../workers/scadWorker.ts', import.meta.url), { type: 'module' }),
    job: null,
    ready: false,
    compilesDone: 0,
    idleTimer: null,
  };

  pw.worker.onmessage = (evt: MessageEvent) => {
    const msg = evt.data;
    switch (msg.type) {
      case 'READY':
        pw.ready = true;
        compilerReady = true;
        loadSettle?.resolve();
        loadSettle = null;
        if (!pw.job) scheduleIdleRetire(pw);
        break;

      case 'LOAD_ERROR': {
        // This worker can never compile anything. Fail whatever it was given and
        // drop it - don't respawn, or a persistently unreachable CDN would spin.
        const err = new Error(msg.message);
        const job = pw.job;
        pw.job = null;
        retire(pw);
        job?.reject(err);
        if (pool.some((p) => !p.job && p.ready)) {
          dispatch();
        } else if (pool.length === 0) {
          loadSettle?.reject(err);
          loadSettle = null;
          loadingPromise = null; // reset to allow retries
          while (queue.length > 0) {
            queue.shift()!.reject(new Error(msg.message));
          }
        }
        break;
      }

      case 'COMPILED':
      case 'COMPILE_ERROR': {
        const job = pw.job;
        if (!job || job.id !== msg.id) break;
        pw.job = null;
        pw.compilesDone++;

        if (msg.type === 'COMPILED') {
          job.resolve(toCachedScad(msg.vertices, msg.faces, msg.renderVertices));
        } else {
          job.reject(new Error(msg.message));
        }

        // Recycle only now that the worker is idle, so nothing in flight is lost.
        if (pw.compilesDone >= RECYCLE_AFTER_COMPILES) {
          retire(pw);
          // Keep one worker warm for the next interaction, mirroring the
          // background pre-load in App.tsx. dispatch() spawns any others it needs.
          if (pool.length === 0) spawn();
        } else {
          scheduleIdleRetire(pw);
        }
        dispatch();
        break;
      }

      default:
        break;
    }
  };

  // A worker that dies (OOM from accumulated WASM instances, an unhandled
  // throw, or deserialization failure) would otherwise leave its caller awaiting
  // forever. Fail its job and drop it; the next dispatch spawns a replacement,
  // which is also what finally reclaims leaked linear memory.
  const handleWorkerBroken = (reason: string) => {
    noteWorkerStopped();
    const job = pw.job;
    pw.job = null;
    retire(pw);
    job?.reject(new Error(reason));
    dispatch();
    if (loadSettle && pool.length === 0) {
      loadSettle.reject(new Error(reason));
      loadSettle = null;
      loadingPromise = null;
    }
  };
  pw.worker.onerror = () => handleWorkerBroken('SCAD worker crashed.');
  pw.worker.onmessageerror = () => handleWorkerBroken('SCAD worker message could not be read.');

  pool.push(pw);
  // Start fetching the module immediately so the worker is warm by the time a
  // job reaches it.
  pw.worker.postMessage({ type: 'LOAD' });
  return pw;
}

function dispatch() {
  while (queue.length > 0) {
    // Prefer an already-warm worker; fall back to an idle one that's still
    // loading (its own queue will run the compile straight after the load).
    let pw = pool.find(p => !p.job && p.ready) ?? pool.find(p => !p.job);
    if (!pw && pool.length < MAX_POOL_SIZE) pw = spawn();
    if (!pw) return; // every worker busy - the next completion re-dispatches

    const job = queue.shift()!;
    clearIdleTimer(pw);
    pw.job = job;
    try {
      pw.worker.postMessage({ type: 'COMPILE', id: job.id, scad: job.scad });
    } catch (err) {
      pw.job = null;
      job.reject(err instanceof Error ? err : new Error(String(err)));
      scheduleIdleRetire(pw);
    }
  }
}

/**
 * Spins up a SCAD worker and has it fetch the openscad-wasm module, so the first
 * real compile doesn't also pay for the download.
 */
export async function loadCompiler(): Promise<void> {
  if (compilerReady) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise<void>((resolve, reject) => {
    loadSettle = { resolve, reject };
    if (pool.length === 0) spawn();
  });

  return loadingPromise;
}

/**
 * Returns true if the compiler module has been fetched and is ready.
 */
export function isCompilerReady(): boolean {
  return compilerReady;
}

/**
 * Compiles a raw OpenSCAD source code string into 3D mesh vertex/face arrays.
 * The work happens in the worker pool; concurrent calls for distinct sources
 * run in parallel across workers, while identical concurrent sources share one
 * compile and each caller receives its own isolated arrays.
 */
export async function compileSCAD(scadCode: string): Promise<CompiledScad> {
  const cached = compileCache.get(scadCode);
  if (cached) {
    compileCache.delete(scadCode);
    compileCache.set(scadCode, cached);
    return materializeCompiled(cached);
  }

  const running = inFlightCompiles.get(scadCode);
  if (running) {
    return materializeCompiled(await running);
  }

  compileListener?.(1);
  const promise = new Promise<CachedScad>((resolve, reject) => {
    queue.push({ id: Math.random().toString(36).slice(2), scad: scadCode, resolve, reject });
    dispatch();
  });
  inFlightCompiles.set(scadCode, promise);

  try {
    const result = await promise;

    // Don't cache a degenerate empty-mesh result - openscad-wasm has been observed
    // to intermittently return a valid-but-empty STL for a legitimately non-empty
    // model. Caching that would make a caller's retry-on-empty logic pointless,
    // since the retry would just hit the same bad cached result forever.
    if (result.faces.length > 0) {
      storeCachedScad(scadCode, result);
    }

    return materializeCompiled(result);
  } finally {
    if (inFlightCompiles.get(scadCode) === promise) inFlightCompiles.delete(scadCode);
    compileListener?.(-1);
  }
}
