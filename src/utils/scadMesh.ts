// An OpenSCAD STL's triangle soup, as the indexed mesh the scene stores.
//
// Out of workers/scadWorker.ts so it can be tested: the worker needs the
// openscad wasm and a browser, and this needs neither.

import { tidyMesh } from './meshTidy';

export type CompiledScad = { vertices: number[]; faces: number[]; renderVertices: number[] };

/**
 * `raw` is the STL's positions, three corners per triangle, in OpenSCAD's Z-up.
 *
 * OpenSCAD's STL output is in its own Z-up convention (X=right, Y=depth, Z=up),
 * but the `vertices` field is expected downstream in Three.js Y-up convention
 * (X=right, Y=up, Z=toward camera) - the renderVertices conversion below assumes
 * Y-up input and swaps it back to MuJoCo Z-up. Remap here (x,y,z)->(x,z,-y) so that
 * round-tripping through that conversion reproduces OpenSCAD's original Z-up
 * orientation instead of rotating every scad-compiled mesh 90° about X.
 */
export function indexScadTriangles(raw: ArrayLike<number>): CompiledScad {
  const uniqueVerts: number[] = [];
  const welded: number[] = [];

  // Coincident vertices are found by a numeric hash of their coordinates
  // quantised to 1e-5 (a hundredth of a millimetre), with an exact check on
  // the bucket. This used to build a string key per corner, which on a
  // threaded hole's million corners was the slowest step of the compile.
  const Q = 1e5;
  const buckets = new Map<number, number[]>();
  const quantised = (v: number) => Math.round(v * Q);
  for (let i = 0; i < raw.length; i += 3) {
    const yUpX = raw[i];
    const yUpY = raw[i + 2];
    const yUpZ = -raw[i + 1];
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
    welded.push(idx);
  }

  // The weld collapses the triangles a profile on the axis fans into, and a
  // polyhedron listed the wrong way round comes out inside out. Both are
  // closed meshes once tidied; see utils/meshTidy.ts. Already welded above.
  const { faces } = tidyMesh(uniqueVerts, welded, null);

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
