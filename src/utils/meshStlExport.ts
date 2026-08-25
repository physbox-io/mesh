// ---------------------------------------------------------------------------
// STL export for a single mesh geom
// ---------------------------------------------------------------------------
//
// The scene-wide STL export walks the Three.js scene and bakes every drawn
// object into one file, which is the right thing when what you want is the
// assembly. It is the wrong thing when what you want is the one object you just
// sculpted: you get the floor, the other bodies and whatever else was on screen,
// all welded into a single shell.
//
// This takes one geom and writes exactly that geom. It reads `renderVertices`
// rather than `vertices` because STL is a Z-up format and `renderVertices` is
// already the Z-up copy — the Y-up one exists for the renderer, and exporting it
// would lay every model on its side.
// ---------------------------------------------------------------------------

import { exportBinarySTL, type Triangle3D } from './moldExporter';

export interface MeshGeomLike {
  name?: string;
  /** Z-up vertices, metres. The exported space. */
  renderVertices?: number[];
  /** Three.js Y-up vertices (x, z, -y). Used only if there is no Z-up copy. */
  vertices?: number[];
  faces?: number[];
}

/** Millimetres per metre. STL carries no units; slicers assume millimetres. */
const MM_PER_M = 1000;

/**
 * The geom's triangles, in millimetres, Z-up.
 *
 * Scaling here rather than leaving it to the slicer is what stops a 240 mm
 * figure arriving as a 0.24 mm speck: the file has no unit field, every slicer
 * reads it as millimetres, and the app works in metres.
 */
export function meshGeomTriangles(geom: MeshGeomLike): Triangle3D[] {
  const faces = geom.faces;
  if (!faces || faces.length < 3) return [];

  // Prefer the Z-up copy. Falling back means undoing the renderer's swap:
  // Y-up (x, y, z) came from Z-up (x, -z, y), so Z-up is (x, -z, y) again.
  const zUp = geom.renderVertices;
  const yUp = geom.vertices;
  if (!zUp && !yUp) return [];

  const point = (index: number): [number, number, number] => {
    if (zUp) {
      return [zUp[index * 3] * MM_PER_M, zUp[index * 3 + 1] * MM_PER_M, zUp[index * 3 + 2] * MM_PER_M];
    }
    const v = yUp!;
    return [v[index * 3] * MM_PER_M, -v[index * 3 + 2] * MM_PER_M, v[index * 3 + 1] * MM_PER_M];
  };

  const triangles: Triangle3D[] = [];
  for (let f = 0; f + 2 < faces.length; f += 3) {
    triangles.push({ a: point(faces[f]), b: point(faces[f + 1]), c: point(faces[f + 2]) });
  }
  return triangles;
}

/** The geom as a binary STL file. */
export function meshGeomToStl(geom: MeshGeomLike): Uint8Array {
  return exportBinarySTL(meshGeomTriangles(geom), `PhysBox mesh ${geom.name ?? ''}`.slice(0, 78));
}

/** A filename that a filesystem and a slicer will both accept. */
export function stlFileName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${safe || 'mesh'}.stl`;
}

/** Writes the geom out as a download. Browser only. */
export function downloadMeshGeomStl(geom: MeshGeomLike, name: string): void {
  const stl = meshGeomToStl(geom);
  const blob = new Blob([stl.buffer as ArrayBuffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = stlFileName(name);
  link.click();
  URL.revokeObjectURL(url);
}
