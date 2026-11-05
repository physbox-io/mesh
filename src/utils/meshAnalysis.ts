// The measurements convexDecomposition.ts decides by, in one Worker-safe place.
//
// Hulling every vertex of a dense sculpt and walking its edges took long
// enough on the main thread to hitch the viewport after every stroke, before
// V-HACD had even been asked. So the vhacd worker runs this, and the module
// stays plain so the inline fallback (Node, tests) can run it too.

import { convexHullOf, meshVolumeAndCentroid } from './csg';
import { concavityDepth } from './hullDepth';
import { analyzeMesh } from './meshIntegrity';
import type { MeshAnalysis } from '../workers/vhacdProtocol';

export function analyseMesh(verts: number[], faces: number[]): MeshAnalysis {
  const { volume } = meshVolumeAndCentroid(verts, faces);
  const points: number[][] = [];
  for (let i = 0; i < verts.length; i += 3) points.push([verts[i], verts[i + 1], verts[i + 2]]);
  const hull = convexHullOf(points);
  return {
    volume, hullVolume: hull?.volume ?? 0, integrity: analyzeMesh(verts, faces),
    concavityDepth: hull ? concavityDepth(verts, faces, hull) : 0,
  };
}
