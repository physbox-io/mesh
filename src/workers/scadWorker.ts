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

let createOpenSCADFn: any = null;
let loadingPromise: Promise<any> | null = null;

async function loadCompiler(): Promise<any> {
  if (createOpenSCADFn) return createOpenSCADFn;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const cdnUrl = 'https://cdn.jsdelivr.net/npm/openscad-wasm@0.0.4/openscad.js';

      // Load the ES module dynamically in the browser, ignoring build-time parsing in Vite
      const module = await import(/* @vite-ignore */ cdnUrl);
      createOpenSCADFn = module.createOpenSCAD;
      if (!createOpenSCADFn) {
        throw new Error('createOpenSCAD export not found in openscad-wasm module.');
      }
      // Announce readiness here rather than in the LOAD handler, so the client's
      // isCompilerReady() mirror also flips when the load was triggered lazily
      // by a compile that arrived before any explicit LOAD.
      self.postMessage({ type: 'READY' });
      return createOpenSCADFn;
    } catch (err) {
      loadingPromise = null; // reset to allow retries
      throw err;
    }
  })();

  return loadingPromise;
}

type CompiledScad = { vertices: number[]; faces: number[]; renderVertices: number[] };

/**
 * Compiles a raw OpenSCAD source code string into 3D mesh vertex/face arrays.
 * Instantiates a fresh WebAssembly instance each time to prevent Emscripten exit status conflicts.
 */
async function compileSCAD(scadCode: string): Promise<CompiledScad> {
  // Ensure the script loader function is loaded
  const createOpenSCAD = await loadCompiler();
  if (!createOpenSCAD) {
    throw new Error('OpenSCAD compiler failed to initialize.');
  }

  // Instantiate a fresh compiler instance for this compilation
  const compiler = await createOpenSCAD();

  // Render the OpenSCAD code to ASCII STL string format
  const stlText = await compiler.renderToStl(scadCode);
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
