// A binary STL as an indexed mesh: the triangles' corners welded where they
// are the same point, so the mesh is closed if the STL was. Used to put an
// exporter's own output (a casting pattern, mold halves) into the scene.

export interface IndexedMesh {
  /** x, y, z per vertex, in the STL's units. */
  positions: Float32Array;
  faces: Uint32Array;
}

export function stlToMesh(bytes: Uint8Array): IndexedMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 84) return { positions: new Float32Array(0), faces: new Uint32Array(0) };
  const count = Math.min(view.getUint32(80, true), Math.floor((bytes.byteLength - 84) / 50));
  const index = new Map<string, number>();
  const positions: number[] = [];
  const faces = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const base = 84 + t * 50 + 12; // past the normal
    for (let c = 0; c < 3; c++) {
      const o = base + c * 12;
      const x = view.getFloat32(o, true), y = view.getFloat32(o + 4, true), z = view.getFloat32(o + 8, true);
      // Exact: an STL writes a shared corner as the same three floats.
      const key = `${x},${y},${z}`;
      let k = index.get(key);
      if (k === undefined) {
        k = positions.length / 3;
        index.set(key, k);
        positions.push(x, y, z);
      }
      faces[t * 3 + c] = k;
    }
  }
  return { positions: new Float32Array(positions), faces };
}
