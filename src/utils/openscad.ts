// Thin postMessage client over a pool of SCAD Workers (src/workers/scadWorker.ts).
//
// The workers own the openscad-wasm module, the per-compile WASM instances and
// the STL -> mesh conversion; this file does the plumbing and keeps the same
// exported API this module has always had, so call sites are unchanged.

import { useStore } from '../store/useStore';

type CompiledScad = { vertices: number[]; faces: number[]; renderVertices: number[] };

// openscad-wasm has shared global state *within a realm*, which is why a single
// worker has to serialize its own compiles (see scadWorker.ts's enqueue) and why
// autoCompileScad used to compile sequentially. Separate workers each get their
// own realm and their own globals, so that constraint doesn't apply across them
// - N workers give genuine N-way parallelism for scenes with several scad nodes.
// Leave headroom for the main thread and the physics worker rather than claiming
// every core, and cap the pool since each worker holds multi-MB WASM memory.
const MAX_POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));

// Each compile instantiates a fresh WASM module whose linear memory is never
// released - noExitRuntime:true and no dispose/free is exposed, and the CGAL
// caches alone run ~10MB per compile. Terminating the worker is the only way to
// actually reclaim it, so retire each one after a few compiles and immediately
// spawn a warm replacement. Cheap: a replacement's module load is served from
// the browser HTTP cache and is amortised over the next RECYCLE_AFTER compiles.
const RECYCLE_AFTER_COMPILES = 4;

interface Job {
  id: string;
  scad: string;
  resolve: (r: CompiledScad) => void;
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
// we've already done. Small cap since the underlying WASM churn (not this cache)
// is the actual memory risk.
//
// Deliberately kept on this side of the worker boundary: a hit resolves in-tick
// with no message round-trip, exactly as it did when compiling was inline. It
// also survives worker recycling, which a worker-side cache would not.
const compileCache = new Map<string, CompiledScad>();
const COMPILE_CACHE_MAX = 50;

function retire(pw: PoolWorker) {
  const idx = pool.indexOf(pw);
  if (idx !== -1) pool.splice(idx, 1);
  pw.worker.terminate();
}

function spawn(): PoolWorker {
  const pw: PoolWorker = {
    worker: new Worker(new URL('../workers/scadWorker.ts', import.meta.url), { type: 'module' }),
    job: null,
    ready: false,
    compilesDone: 0,
  };

  pw.worker.onmessage = (evt: MessageEvent) => {
    const msg = evt.data;
    switch (msg.type) {
      case 'READY':
        pw.ready = true;
        compilerReady = true;
        loadSettle?.resolve();
        loadSettle = null;
        break;

      case 'LOAD_ERROR': {
        // This worker can never compile anything. Fail whatever it was given and
        // drop it - don't respawn, or a persistently unreachable CDN would spin.
        const job = pw.job;
        pw.job = null;
        retire(pw);
        job?.reject(new Error(msg.message));
        loadSettle?.reject(new Error(msg.message));
        loadSettle = null;
        loadingPromise = null; // reset to allow retries
        break;
      }

      case 'COMPILED':
      case 'COMPILE_ERROR': {
        const job = pw.job;
        if (!job || job.id !== msg.id) break;
        pw.job = null;
        pw.compilesDone++;

        if (msg.type === 'COMPILED') {
          job.resolve({ vertices: msg.vertices, faces: msg.faces, renderVertices: msg.renderVertices });
        } else {
          job.reject(new Error(msg.message));
        }

        // Recycle only now that the worker is idle, so nothing in flight is lost.
        if (pw.compilesDone >= RECYCLE_AFTER_COMPILES) {
          retire(pw);
          // Keep one worker warm for the next interaction, mirroring the
          // background pre-load in App.tsx. dispatch() spawns any others it needs.
          if (pool.length === 0) spawn();
        }
        dispatch();
        break;
      }

      default:
        break;
    }
  };

  // A worker that dies (OOM from accumulated WASM instances, an unhandled
  // throw) would otherwise leave its caller awaiting forever. Fail its job and
  // drop it; the next dispatch spawns a replacement, which is also what finally
  // reclaims the leaked linear memory that a same-thread compiler never could.
  pw.worker.onerror = () => {
    const job = pw.job;
    pw.job = null;
    retire(pw);
    job?.reject(new Error('SCAD worker crashed.'));
    dispatch();
  };

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
    pw.job = job;
    pw.worker.postMessage({ type: 'COMPILE', id: job.id, scad: job.scad });
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
 * The work happens in the worker pool; concurrent calls run in parallel across
 * workers, while each individual worker compiles strictly one at a time.
 */
export async function compileSCAD(scadCode: string): Promise<CompiledScad> {
  const cached = compileCache.get(scadCode);
  if (cached) return cached;

  useStore.getState().incrementScadCompile();
  try {
    const result = await new Promise<CompiledScad>((resolve, reject) => {
      queue.push({ id: Math.random().toString(36).slice(2), scad: scadCode, resolve, reject });
      dispatch();
    });

    // Don't cache a degenerate empty-mesh result - openscad-wasm has been observed
    // to intermittently return a valid-but-empty STL for a legitimately non-empty
    // model. Caching that would make a caller's retry-on-empty logic pointless,
    // since the retry would just hit the same bad cached result forever.
    if (result.faces.length > 0) {
      if (compileCache.size >= COMPILE_CACHE_MAX) {
        const oldestKey = compileCache.keys().next().value;
        if (oldestKey !== undefined) compileCache.delete(oldestKey);
      }
      compileCache.set(scadCode, result);
    }

    return result;
  } finally {
    useStore.getState().decrementScadCompile();
  }
}
