// The nesting-bowls scene: four paraboloid bowls (sweptMeshes.paraboloidBowl,
// rims 55/45/35/25 mm) as free bodies of density 1200, with colliders cut
// exactly from the profile — one piece round the axis, then sectors by bands
// of four profile steps — so a test of the physics does not spend a minute
// in V-HACD, and its pieces stand at most ~0.1 mm proud.

import { colliderTemplateOf, convexHullOf, hullsToColliderGeoms, type Hull } from '../../src/utils/csg';
import type { SceneGeom, SceneNode } from '../../src/types/scene';
import { paraboloidBowl } from './sweptMeshes';
import { zupToYupFlat } from './meshes';

const A = 10, T = 0.004, R0 = 0.0005, N = 32, SEG = 64;
export const BOWL_RIMS = [0.055, 0.045, 0.035, 0.025];

/** One piece round the axis, then `sectors` x bands of `band` profile steps. */
export function bowlPieces(h: number, sectors: number, band = 4): Hull[] {
  const R = Math.sqrt(h / A);
  const at = (k: number, j: number, inner: boolean) => {
    const r = R0 + ((R - R0) * k) / N, th = (2 * Math.PI * j) / SEG;
    return [r * Math.cos(th), r * Math.sin(th), A * r * r + (inner ? T : 0)];
  };
  const hull = (ks: number[], js: number[]) => {
    const hl = convexHullOf(ks.flatMap(k => js.flatMap(j => [at(k, j, false), at(k, j, true)])))!;
    return { ...hl, volume: Math.abs(hl.volume) };
  };
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const out = [hull([0, 1], range(0, SEG - 1))];
  const per = SEG / sectors;
  for (let k = 1; k < N; k += band) {
    for (let s = 0; s < sectors; s++) out.push(hull(range(k, Math.min(N, k + band)), range(s * per, (s + 1) * per)));
  }
  return out;
}

/** The four bowls, bowl i at pos(i), each mesh carrying `geom` (its pieces inherit it). */
export function nestingBowls(sectors: number, pos: (i: number) => number[], geom: Partial<SceneGeom> = {}): SceneNode[] {
  return BOWL_RIMS.map((h, i) => {
    const m = paraboloidBowl(h);
    const src: SceneGeom = {
      name: `bowl${i}_m`, type: 'mesh', size: [1], dynamic: true, density: 1200,
      renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces, ...geom,
    };
    const hulls = bowlPieces(h, sectors);
    const pieces = hullsToColliderGeoms(hulls, `bowl${i}`, colliderTemplateOf(src, [0.3, 0.6, 0.9, 1]), 1200 * hulls.reduce((v, p) => v + p.volume, 0))
      .map(g => ({ ...g, colliderOf: src.name }));
    return {
      id: `bowl${i}`, name: `bowl${i}`, type: 'body', pos: pos(i), children: [],
      joints: [{ name: `bowl${i}_free`, type: 'free' }], geoms: [src, ...pieces],
      collisionHash: 'test', collisionDecomposed: true,
    } as SceneNode;
  });
}
