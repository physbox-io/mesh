import { loadSimplifier } from './denseMesh';
import type { SceneGeom } from '../types/scene';

export interface SimplifiedMesh {
  vertices: number[];
  faces: number[];
  /** Only for a dynamic mesh: the same vertices in MuJoCo's Z-up frame. */
  renderVertices?: number[];
}

/**
 * A mesh's Y-up `vertices` as the Z-up `renderVertices` a dynamic mesh is
 * drawn from: (x, y, z) becomes (x, -z, y), rounded to 5 places.
 */
export function toRenderVertices(vertices: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    out.push(+vertices[i].toFixed(5), +(-vertices[i + 2]).toFixed(5), +vertices[i + 1].toFixed(5));
  }
  return out;
}

/**
 * Reduces a mesh geom to about `ratio` of its vertices (never fewer than 4)
 * with meshoptimizer's edge collapse, which keeps the surface's topology: a
 * closed mesh stays closed. three's SimplifyModifier, used before, opened a
 * mold at 10% and took fifteen seconds over it on the main thread. Throws, with
 * a message fit to show the user, when the input is too small or nothing can
 * be taken away.
 */
export async function simplifyGeomMesh(g: Pick<SceneGeom, 'vertices' | 'faces' | 'dynamic'>, ratio: number): Promise<SimplifiedMesh> {
  if (!g.vertices || g.vertices.length < 9) {
    throw new Error('Not enough vertices to simplify (need at least 3 triangles / 9 coordinates).');
  }

  // 1. Weld so the edge collapse sees one connected surface, not a soup.
  const uniqueInputVerts: number[] = [];
  const inputFaces: number[] = [];
  const inputVertMap = new Map<string, number>();
  const corners = g.faces && g.faces.length > 0 ? g.faces.length : g.vertices.length / 3;
  for (let i = 0; i < corners; i++) {
    const v = g.faces && g.faces.length > 0 ? g.faces[i] : i;
    const x = g.vertices[v * 3];
    const y = g.vertices[v * 3 + 1];
    const z = g.vertices[v * 3 + 2];
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    let idx = inputVertMap.get(key);
    if (idx === undefined) {
      idx = uniqueInputVerts.length / 3;
      uniqueInputVerts.push(x, y, z);
      inputVertMap.set(key, idx);
    }
    inputFaces.push(idx);
  }

  // 2. A closed surface has about twice as many triangles as vertices, so the
  // share of vertices asked for is the share of triangles kept.
  const originalVertexCount = uniqueInputVerts.length / 3;
  const targetCount = Math.max(4, Math.floor(originalVertexCount * ratio));
  if (targetCount >= originalVertexCount) {
    throw new Error('Already at or below target vertex count. Try a lower quality/ratio.');
  }
  const triangles = inputFaces.length / 3;
  const targetIndices = Math.max(3, Math.round((triangles * targetCount) / originalVertexCount)) * 3;

  const simplifier = await loadSimplifier();
  const positions = new Float32Array(uniqueInputVerts);
  // target_error 1 is the mesh's whole extent, relative: no bound but the count.
  const [out] = simplifier.simplify(new Uint32Array(inputFaces), positions, 3, targetIndices, 1);
  if (out.length >= inputFaces.length) {
    throw new Error('Nothing can be taken away without opening the surface.');
  }

  // 3. Keep only the vertices the result uses, renumbered in order of first use.
  const uniqueVerts: number[] = [];
  const faces: number[] = new Array(out.length);
  const remap = new Int32Array(originalVertexCount).fill(-1);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (remap[v] === -1) {
      remap[v] = uniqueVerts.length / 3;
      uniqueVerts.push(
        Number(uniqueInputVerts[v * 3].toFixed(5)),
        Number(uniqueInputVerts[v * 3 + 1].toFixed(5)),
        Number(uniqueInputVerts[v * 3 + 2].toFixed(5)),
      );
    }
    faces[i] = remap[v];
  }

  if (uniqueVerts.length < 9) {
    throw new Error('Simplification reduced geometry below minimum visible threshold.');
  }

  // 4. A dynamic mesh is drawn from renderVertices, in MuJoCo's Z-up frame.
  const newRenderVerts = g.dynamic ? toRenderVertices(uniqueVerts) : undefined;

  return { vertices: uniqueVerts, faces, ...(newRenderVerts ? { renderVertices: newRenderVerts } : {}) };
}
