// Owns the openscad-wasm compiler and all SCAD -> mesh work, off the main thread.
//
// Everything in here used to run inline in src/utils/openscad.ts on the main
// thread. The `async`/`await` there was misleading: `renderToStl` is a
// synchronous Emscripten call into WASM that a promise wrapper only resolves
// *after* the CSG evaluation has already finished, so the event loop was frozen
// for the whole compile - no rendering, no physics message pump, nothing. WASM
// has no yield points, so the only fix is to move the work to another thread.
//
// src/utils/openscad.ts is now a thin postMessage client over this worker and
// keeps the same exported API (loadCompiler / isCompilerReady / compileSCAD).

import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
// A static import on purpose: Vite follows it into the module graph, splits
// the Emscripten glue into its own chunk and emits openscad.wasm as an asset
// next to it, so nothing is fetched from a CDN and the cross-origin isolation
// headers the physics worker needs never come into it.
import createOpenSCAD, { type OpenSCAD } from '@lofcz/openscad-wasm';
// The same asset the glue would fetch by import.meta.url, as a URL — Vite
// emits it once and both references point at the one file. Wanted here so
// the wasm can be COMPILED once (see compiledModule) rather than per run.
// A relative path into node_modules because the package's exports map does
// not list the .wasm, so the bare specifier cannot be resolved.
import wasmUrl from '../../node_modules/@lofcz/openscad-wasm/openscad.wasm?url';

/*
 * Which build, and why.
 *
 * openscad-wasm 0.0.4 (the npm package this used to load from jsDelivr) is
 * OpenSCAD with CGAL as its only geometry engine. CGAL is exact arithmetic
 * over Nef polyhedra, and its time grows faster than the vertex count: a
 * plate with 27 holes took ten seconds, an M8 thread through a 20 mm block
 * seven, the same thread through 100 mm a minute and a half. Every one of
 * those is a boolean of a few thousand triangles.
 *
 * @lofcz/openscad-wasm tracks openscad/openscad-wasm's current build, which
 * carries the Manifold engine as well. Asked for with `--backend Manifold`,
 * the same three inputs take 0.1 s, 0.2 s and 0.2 s, with identical triangle
 * counts. Manifold is floating point rather than exact, which for parts
 * measured in millimetres and drawn at 1e-5 precision makes no difference
 * anyone can see, and it does not share CGAL's habit of giving up on
 * coincident faces — the overshoot every cutter here carries is kept anyway,
 * because a flush cut is a modelling mistake whichever engine evaluates it.
 */
const BACKEND_ARGS = ['--backend', 'Manifold', '--export-format', 'binstl'];

/**
 * The wasm, compiled once.
 *
 * A fresh Emscripten instance per run is right (see renderToStl), but left to
 * itself each instance fetches and COMPILES the 11 MB module again — a couple
 * of hundred milliseconds on a fast machine, most of a second on a slow one,
 * for a boolean that then takes six. Compiling to a WebAssembly.Module once
 * and instantiating from it makes an instance cost about ten milliseconds.
 */
let compiledModule: Promise<WebAssembly.Module> | null = null;
function compiledWasm(): Promise<WebAssembly.Module> {
  if (!compiledModule) {
    compiledModule = WebAssembly.compileStreaming(fetch(wasmUrl)).catch((err) => {
      compiledModule = null; // a failed fetch can be retried
      throw err;
    });
  }
  return compiledModule;
}

async function freshInstance(io: { print: (l: string) => void; printErr: (l: string) => void }): Promise<OpenSCAD> {
  const module = await compiledWasm();
  return createOpenSCAD({
    noInitialRun: true,
    ...io,
    instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
      WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
      return {};
    },
  });
}

let loadingPromise: Promise<void> | null = null;

/**
 * Brings the compiler in. The module is already imported; what this waits
 * for is the first instance, which is the one that fetches and compiles the
 * 11 MB wasm — after that the browser has it cached and instances are cheap.
 */
async function loadCompiler(): Promise<void> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      await freshInstance({ print: () => {}, printErr: () => {} });
      // Announce readiness here rather than in the LOAD handler, so the client's
      // isCompilerReady() mirror also flips when the load was triggered lazily
      // by a compile that arrived before any explicit LOAD.
      self.postMessage({ type: 'READY' });
    } catch (err) {
      loadingPromise = null; // reset to allow retries
      throw err;
    }
  })();
  return loadingPromise;
}

/**
 * Runs one OpenSCAD program to a binary STL.
 *
 * A fresh instance per run, as the build's own README asks: once the runtime
 * has exited it cannot be reused, and a compile that aborted would poison
 * every one after it. Binary rather than ASCII STL because a threaded hole is
 * a few hundred thousand triangles, which as text is tens of megabytes to
 * write, hand over and parse; as binary it is fifty bytes a triangle.
 */
async function renderToStl(scadCode: string): Promise<Uint8Array> {
  const stderr: string[] = [];
  const instance: OpenSCAD = await freshInstance({
    print: (line: string) => stderr.push(line),
    printErr: (line: string) => {
      stderr.push(line);
      // OpenSCAD's own chatter — "Compiling design", cache sizes, timings —
      // stays visible in the console at debug level, where it used to be.
      console.debug('[OpenSCAD]:', line);
    },
  });
  instance.FS.writeFile('/input.scad', scadCode);
  const exit = instance.callMain(['/input.scad', ...BACKEND_ARGS, '-o', '/output.stl']);
  if (exit !== 0) {
    // The last few lines are where OpenSCAD puts the ERROR: it stopped on,
    // which is a better message than an exit code.
    const said = stderr.filter((l) => /ERROR|WARNING/.test(l)).slice(-3).join(' · ');
    throw new Error(`OpenSCAD failed (exit ${exit})${said ? `: ${said}` : ''}`);
  }
  return instance.FS.readFile('/output.stl', { encoding: 'binary' });
}

type CompiledScad = { vertices: number[]; faces: number[]; renderVertices: number[] };

/**
 * Compiles a raw OpenSCAD source code string into 3D mesh vertex/face arrays.
 * A fresh WebAssembly instance each time — see renderToStl.
 */
async function compileSCAD(scadCode: string): Promise<CompiledScad> {
  await loadCompiler();
  const stl = await renderToStl(scadCode);
  if (!stl || stl.byteLength === 0) {
    throw new Error('Compilation produced empty output.');
  }

  // Parse STL data into a BufferGeometry using STLLoader
  const loader = new STLLoader();
  const geometry = loader.parse(stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength) as ArrayBuffer);

  const positionAttr = geometry.attributes.position;
  if (!positionAttr) {
    throw new Error('Parsed STL geometry does not contain position attributes.');
  }

  const rawVerts = positionAttr.array;
  const uniqueVerts: number[] = [];
  const faces: number[] = [];

  // Deduplicate vertices and index the face array.
  // OpenSCAD's STL output is in its own Z-up convention (X=right, Y=depth, Z=up),
  // but the `vertices` field is expected downstream in Three.js Y-up convention
  // (X=right, Y=up, Z=toward camera) - the renderVertices conversion below assumes
  // Y-up input and swaps it back to MuJoCo Z-up. Remap here (x,y,z)->(x,z,-y) so that
  // round-tripping through that conversion reproduces OpenSCAD's original Z-up
  // orientation instead of rotating every scad-compiled mesh 90° about X.
  //
  // Coincident vertices are found by a numeric hash of their coordinates
  // quantised to 1e-5 (a hundredth of a millimetre), with an exact check on
  // the bucket. This used to build a string key per corner, which on a
  // threaded hole's million corners was the slowest step of the compile.
  const Q = 1e5;
  const buckets = new Map<number, number[]>();
  const quantised = (v: number) => Math.round(v * Q);
  for (let i = 0; i < rawVerts.length; i += 3) {
    const yUpX = rawVerts[i];
    const yUpY = rawVerts[i + 2];
    const yUpZ = -rawVerts[i + 1];
    const qx = quantised(yUpX), qy = quantised(yUpY), qz = quantised(yUpZ);
    // Three large primes, xor-folded: cheap, and collisions only cost a
    // comparison against the bucket's other members.
    const hash = ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) | 0;
    let bucket = buckets.get(hash);
    let idx = -1;
    if (bucket) {
      for (const candidate of bucket) {
        const c = candidate * 3;
        if (quantised(uniqueVerts[c]) === qx && quantised(uniqueVerts[c + 1]) === qy && quantised(uniqueVerts[c + 2]) === qz) {
          idx = candidate;
          break;
        }
      }
    } else {
      bucket = [];
      buckets.set(hash, bucket);
    }
    if (idx === -1) {
      idx = uniqueVerts.length / 3;
      uniqueVerts.push(yUpX, yUpY, yUpZ);
      bucket.push(idx);
    }
    faces.push(idx);
  }

  // Swap Y and Z for MuJoCo's Z-up space representation
  const renderVertices: number[] = [];
  for (let i = 0; i < uniqueVerts.length; i += 3) {
    const x = uniqueVerts[i];
    const y = uniqueVerts[i + 1];
    const z = uniqueVerts[i + 2];
    renderVertices.push(
      Number(x.toFixed(5)),
      Number((-z).toFixed(5)),
      Number(y.toFixed(5))
    );
  }

  return { vertices: uniqueVerts, faces, renderVertices };
}

// onmessage handlers run to their first await and then interleave, so two
// COMPILE messages arriving close together would have their compiles running
// concurrently inside this one worker - and openscad-wasm has shared global
// state across instances that makes concurrent compiles silently return an
// empty mesh (see the comment in useMCPBridge.ts's autoCompileScad). Chain
// every compile onto a single promise so they run strictly one at a time.
let compileQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = compileQueue.then(job, job);
  // Keep the chain alive regardless of whether this job settled or threw.
  compileQueue = run.catch(() => {});
  return run;
}

self.onmessage = (evt: MessageEvent) => {
  const msg = evt.data;
  switch (msg.type) {
    case 'LOAD':
      // Serialized alongside compiles too: a LOAD racing an in-flight compile's
      // own lazy load would double-instantiate the module.
      enqueue(async () => {
        try {
          await loadCompiler(); // posts READY itself on success
        } catch (err) {
          self.postMessage({ type: 'LOAD_ERROR', message: err instanceof Error ? err.message : String(err) });
        }
      });
      break;
    case 'COMPILE':
      enqueue(async () => {
        try {
          const result = await compileSCAD(msg.scad);
          self.postMessage({ type: 'COMPILED', id: msg.id, ...result });
        } catch (err) {
          self.postMessage({
            type: 'COMPILE_ERROR',
            id: msg.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
      break;
    default:
      break;
  }
};
