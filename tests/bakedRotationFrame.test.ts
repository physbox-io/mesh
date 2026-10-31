import { describe, expect, it } from 'vitest';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import { getNodeWorldTransform } from '../src/utils/laserCutExporter';
import { printableParts } from '../src/utils/printExport';
import { partSoups } from '../src/utils/partSoups';
import * as THREE from 'three';

// A mesh body turned in the inspector has the turn baked into its vertices and
// keeps its euler only for show; its frame has no rotation (mjcf.ts emits none).
// Everything that reads its geometry in world space must not turn it again.

/** A box, Z-up metres, outward-wound, as renderVertices + faces. */
function box(sx: number, sy: number, sz: number): { renderVertices: number[]; faces: number[] } {
  const v: number[] = [];
  for (const z of [-sz / 2, sz / 2]) for (const y of [-sy / 2, sy / 2]) for (const x of [-sx / 2, sx / 2]) v.push(x, y, z);
  const faces = [
    0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
    0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
    0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
  ];
  return { renderVertices: v, faces };
}

/** A 100 × 20 × 10 mm bar turned 90° about Z, baked: it now runs along Y. */
function bakedBar(id: string, pos: [number, number, number] = [0, 0, 0]): SceneNode {
  const base = box(0.1, 0.02, 0.01);
  const turned = box(0.02, 0.1, 0.01);
  const yUp = (zUp: number[]) => zUp.map((_, i) => (i % 3 === 0 ? zUp[i] : i % 3 === 1 ? zUp[i + 1] : -zUp[i - 1]));
  const geom: SceneGeom = {
    name: `${id}_mesh`, type: 'mesh', size: [1], dynamic: true,
    renderVertices: turned.renderVertices, baseRenderVertices: base.renderVertices,
    vertices: yUp(turned.renderVertices), faces: turned.faces,
  };
  return { id, name: id, type: 'body', pos, euler: [0, 0, 90], joints: [], geoms: [geom], children: [] } as SceneNode;
}

function extent(tris: ArrayLike<number>): number[] {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], tris[i]);
    hi[i % 3] = Math.max(hi[i % 3], tris[i]);
  }
  return [0, 1, 2].map((k) => +((hi[k] - lo[k]) * 1000).toFixed(3));
}

describe('a baked rotation is not applied twice', () => {
  it('getNodeWorldTransform gives a baked body no rotation', () => {
    const m = getNodeWorldTransform(bakedBar('b', [0.1, 0.2, 0.3]));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    expect(q.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9);
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([0.1, 0.2, 0.3]);
  });

  it('exports a baked body as drawn', () => {
    const { parts } = printableParts({ nodes: [bakedBar('b')] });
    expect(extent(parts[0].tris)).toEqual([20, 100, 10]);
  });

  it('takes a baked rigid child into the split as drawn', () => {
    const root: SceneNode = { id: 'root', name: 'root', type: 'body', pos: [0, 0, 0], joints: [], geoms: [], children: [bakedBar('child')] } as SceneNode;
    const { soups } = partSoups(root);
    expect(extent(soups[0])).toEqual([20, 100, 10]);
  });
});
