/**
 * Collision proxies a SCAD script draws for itself.
 *
 * Hand-placed proxy boxes go stale the moment a parameter changes: the tray's
 * hidden boxes were worked out for one groove width and wrong for the next.
 * So a script can draw its own colliders. When its source mentions
 * `$physbox_collision`, it is compiled a second time with that variable set
 * true — `if ($physbox_collision) { proxies } else { the part }` — and every
 * separate piece of that output becomes one convex collider, in place of the
 * automatic decomposition. The proxies are computed from the same parameters
 * as the part, so they follow every change to it.
 */
import { convexHullOf, usableColliderHulls, type Hull } from './csg';

export const COLLISION_FLAG = '$physbox_collision';

export function usesCollisionProxies(scad: string | undefined): boolean {
  return !!scad && scad.includes(COLLISION_FLAG);
}

/** The script with the flag set. Appended, so it wins over a default the script assigns itself. */
export function collisionVariant(scad: string): string {
  return `${scad}\n${COLLISION_FLAG} = true;\n`;
}

/** The mesh's separate pieces, as lists of points, with coincident vertices treated as one. */
export function meshPieces(verts: number[], faces: number[]): number[][][] {
  const key = (i: number) => `${verts[i * 3].toFixed(7)},${verts[i * 3 + 1].toFixed(7)},${verts[i * 3 + 2].toFixed(7)}`;
  const canon = new Map<string, number>();
  const id = (i: number) => {
    const k = key(i);
    let c = canon.get(k);
    if (c === undefined) { c = i; canon.set(k, i); }
    return c;
  };
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const join = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (let t = 0; t < faces.length; t += 3) {
    const a = id(faces[t]), b = id(faces[t + 1]), c = id(faces[t + 2]);
    for (const v of [a, b, c]) if (!parent.has(v)) parent.set(v, v);
    join(a, b);
    join(b, c);
  }
  const groups = new Map<number, number[][]>();
  for (const v of parent.keys()) {
    const r = find(v);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push([verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]]);
  }
  return [...groups.values()];
}

/** One convex hull per separate piece of the collision compile, in the part's own frame. */
export async function scadProxyHulls(scad: string): Promise<Hull[]> {
  const { compileSCAD } = await import('./openscad');
  const compiled = await compileSCAD(collisionVariant(scad));
  const verts = compiled.renderVertices;
  const hulls = meshPieces(verts, compiled.faces)
    .map((pts) => convexHullOf(pts))
    .filter((h): h is Hull => h !== null);
  return usableColliderHulls(hulls);
}
