import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
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
 * with three's SimplifyModifier. Throws, with a message fit to show the user,
 * when the input is too small or the result collapses.
 */
export function simplifyGeomMesh(g: Pick<SceneGeom, 'vertices' | 'faces' | 'dynamic'>, ratio: number): SimplifiedMesh {
  if (!g.vertices || g.vertices.length < 9) {
    throw new Error('Not enough vertices to simplify (need at least 3 triangles / 9 coordinates).');
  }

  // 1. Weld/deduplicate vertices first so that the edge collapse algorithm works properly on a connected mesh
  const uniqueInputVerts: number[] = [];
  const inputFaces: number[] = [];
  const inputVertMap = new Map<string, number>();

  for (let i = 0; i < g.vertices.length; i += 3) {
    const x = g.vertices[i];
    const y = g.vertices[i + 1];
    const z = g.vertices[i + 2];
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    let idx = inputVertMap.get(key);
    if (idx === undefined) {
      idx = uniqueInputVerts.length / 3;
      uniqueInputVerts.push(x, y, z);
      inputVertMap.set(key, idx);
    }
  }

  if (g.faces && g.faces.length > 0) {
    for (let i = 0; i < g.faces.length; i++) {
      const oldIdx = g.faces[i];
      const vx = g.vertices[oldIdx * 3];
      const vy = g.vertices[oldIdx * 3 + 1];
      const vz = g.vertices[oldIdx * 3 + 2];
      const key = `${vx.toFixed(5)},${vy.toFixed(5)},${vz.toFixed(5)}`;
      inputFaces.push(inputVertMap.get(key)!);
    }
  } else {
    // If not indexed, build faces sequentially
    for (let i = 0; i < g.vertices.length; i += 3) {
      const x = g.vertices[i];
      const y = g.vertices[i + 1];
      const z = g.vertices[i + 2];
      const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
      inputFaces.push(inputVertMap.get(key)!);
    }
  }

  // 2. Create a THREE.BufferGeometry from the welded geometry
  const geometry = new THREE.BufferGeometry();
  const positionArray = new Float32Array(uniqueInputVerts);
  geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
  geometry.setIndex(inputFaces);

  // 3. Compute the number of vertices to remove
  const originalVertexCount = uniqueInputVerts.length / 3;
  const targetCount = Math.max(4, Math.floor(originalVertexCount * ratio));
  const countToRemove = originalVertexCount - targetCount;

  if (countToRemove <= 0) {
    throw new Error('Already at or below target vertex count. Try a lower quality/ratio.');
  }

  // 4. Apply the SimplifyModifier
  const modifier = new SimplifyModifier();
  const simplifiedGeometry = modifier.modify(geometry, countToRemove);
  
  const simplifiedPositions = simplifiedGeometry.attributes.position.array;
  const simplifiedIndex = simplifiedGeometry.index ? simplifiedGeometry.index.array : null;
  if (!simplifiedPositions || simplifiedPositions.length === 0) {
    throw new Error('Simplification produced an empty geometry.');
  }

  // 5. Extract the resulting vertices and faces using the index array from SimplifyModifier
  const uniqueVerts: number[] = [];
  const faces: number[] = [];
  const vertMap = new Map<number, number>();

  if (simplifiedIndex) {
    for (let i = 0; i < simplifiedIndex.length; i++) {
      const oldIdx = simplifiedIndex[i];
      let newIdx = vertMap.get(oldIdx);
      if (newIdx === undefined) {
        newIdx = uniqueVerts.length / 3;
        const vx = simplifiedPositions[oldIdx * 3];
        const vy = simplifiedPositions[oldIdx * 3 + 1];
        const vz = simplifiedPositions[oldIdx * 3 + 2];
        uniqueVerts.push(
          Number(vx.toFixed(5)),
          Number(vy.toFixed(5)),
          Number(vz.toFixed(5))
        );
        vertMap.set(oldIdx, newIdx);
      }
      faces.push(newIdx);
    }
  } else {
    // Fallback for non-indexed output
    const vertMapStr = new Map<string, number>();
    for (let i = 0; i < simplifiedPositions.length; i += 3) {
      const x = simplifiedPositions[i];
      const y = simplifiedPositions[i + 1];
      const z = simplifiedPositions[i + 2];
      const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
      let idx = vertMapStr.get(key);
      if (idx === undefined) {
        idx = uniqueVerts.length / 3;
        uniqueVerts.push(
          Number(x.toFixed(5)),
          Number(y.toFixed(5)),
          Number(z.toFixed(5))
        );
        vertMapStr.set(key, idx);
      }
      faces.push(idx);
    }
  }

  if (uniqueVerts.length < 9) {
    throw new Error('Simplification reduced geometry below minimum visible threshold.');
  }

  // 6. A dynamic mesh is drawn from renderVertices, in MuJoCo's Z-up frame.
  const newRenderVerts = g.dynamic ? toRenderVertices(uniqueVerts) : undefined;

  return { vertices: uniqueVerts, faces, ...(newRenderVerts ? { renderVertices: newRenderVerts } : {}) };
}
