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
const BACKEND_ARGS = ['--backend', 'Manifold', '--export-format', 'asciistl'];

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
      await createOpenSCAD({ noInitialRun: true, print: () => {}, printErr: () => {} });
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
 * Runs one OpenSCAD program to an ASCII STL string.
 *
 * A fresh instance per run, as the build's own README asks: once the runtime
 * has exited it cannot be reused, and a compile that aborted would poison
 * every one after it.
 */
async function renderToStl(scadCode: string): Promise<string> {
  const stderr: string[] = [];
  const instance: OpenSCAD = await createOpenSCAD({
    noInitialRun: true,
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
  return instance.FS.readFile('/output.stl', { encoding: 'utf8' });
}

type CompiledScad = { vertices: number[]; faces: number[]; renderVertices: number[] };

/**
 * Compiles a raw OpenSCAD source code string into 3D mesh vertex/face arrays.
 * A fresh WebAssembly instance each time — see renderToStl.
 */
async function compileSCAD(scadCode: string): Promise<CompiledScad> {
  await loadCompiler();
  const stlText = await renderToStl(scadCode);
  if (!stlText || stlText.length === 0) {
    throw new Error('Compilation produced empty output.');
  }

  // Parse STL data into a BufferGeometry using STLLoader
  const loader = new STLLoader();
  const geometry = loader.parse(stlText);

  const positionAttr = geometry.attributes.position;
  if (!positionAttr) {
    throw new Error('Parsed STL geometry does not contain position attributes.');
  }

  const rawVerts = positionAttr.array;
  const uniqueVerts: number[] = [];
  const faces: number[] = [];
  const vertMap = new Map<string, number>();

  // Deduplicate vertices and index the face array.
  // OpenSCAD's STL output is in its own Z-up convention (X=right, Y=depth, Z=up),
  // but the `vertices` field is expected downstream in Three.js Y-up convention
  // (X=right, Y=up, Z=toward camera) - the renderVertices conversion below assumes
  // Y-up input and swaps it back to MuJoCo Z-up. Remap here (x,y,z)->(x,z,-y) so that
  // round-tripping through that conversion reproduces OpenSCAD's original Z-up
  // orientation instead of rotating every scad-compiled mesh 90° about X.
  for (let i = 0; i < rawVerts.length; i += 3) {
    const x = rawVerts[i];
    const y = rawVerts[i + 1];
    const z = rawVerts[i + 2];
    const yUpX = x;
    const yUpY = z;
    const yUpZ = -y;

    const key = `${yUpX.toFixed(5)},${yUpY.toFixed(5)},${yUpZ.toFixed(5)}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = uniqueVerts.length / 3;
      uniqueVerts.push(yUpX, yUpY, yUpZ);
      vertMap.set(key, idx);
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
