// ---------------------------------------------------------------------------
// The knife's geometry, shared by the K tool (FaceKnife.tsx) and MCP
// ---------------------------------------------------------------------------
//
// A plane through a part either leaves a seam on the faces it crosses
// (SceneGeom.faceSplits) or cuts the part into pieces (cutAlongPlane). The
// pieces keep the patterns and seams of the faces they were cut from:
// carryAcrossCut re-seeds each one on the piece its faces landed on.
//
// Everything here is in the body's own frame, metres, Z-up: the frame the cut
// pieces come back in, and the frame each piece's single mesh geom is then
// drawn in (it has no pos of its own).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { patternSurfaces } from './facePatternPick';
import { partSoups } from './printSplitClient';
import { patternRegionAt, planeSeeds, splitSeams, type FaceSplit, type SurfaceTexture } from './surfaceTexture';

const round = (v: THREE.Vector3 | number[]) => (Array.isArray(v) ? v : v.toArray()).map((x) => +x.toFixed(7));

/** A geom's seam for a plane, in the geom's own frame. */
export function splitFor(toBody: THREE.Matrix4, at: THREE.Vector3, normal: THREE.Vector3, seeds: number[][]): FaceSplit {
  const toGeom = toBody.clone().invert();
  return {
    at: round(at.clone().applyMatrix4(toGeom)),
    normal: round(normal.clone().transformDirection(toGeom)),
    seeds: seeds.map((s) => round(s)),
  };
}

/**
 * The seams a plane leaves on a part, one for each geom it divides. `seeds`
 * are points (each geom's frame) on the faces to divide, as the K tool finds
 * them under the line drawn; left out, every face the plane crosses is
 * divided. A plane that divides nothing (along an edge, or past the part)
 * leaves no seam.
 */
export function seamsAcross(
  node: SceneNode,
  at: THREE.Vector3,
  normal: THREE.Vector3,
  seeds?: Map<string, number[][]>,
): { geomName: string; split: FaceSplit }[] {
  const out: { geomName: string; split: FaceSplit }[] = [];
  for (const { geom, base, toBody } of patternSurfaces(node)) {
    let list = seeds?.get(geom.name);
    if (!seeds) {
      const toGeom = toBody.clone().invert();
      list = planeSeeds(base.positions, base.faces, at.clone().applyMatrix4(toGeom).toArray(), normal.clone().transformDirection(toGeom).toArray());
    }
    if (!list?.length) continue;
    const split = splitFor(toBody, at, normal, list);
    if (!splitSeams(base.positions, base.faces, [split])[0].length) continue;
    out.push({ geomName: geom.name, split });
  }
  return out;
}

/** The nearest a point comes to a triangle soup's surface, squared. */
function nearest2(p: THREE.Vector3, positions: ArrayLike<number>, faces: ArrayLike<number>): number {
  const tri = new THREE.Triangle(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Vector3();
  let best = Infinity;
  for (let i = 0; i < faces.length; i += 3) {
    a.fromArray(positions as number[], 3 * faces[i]);
    b.fromArray(positions as number[], 3 * faces[i + 1]);
    c.fromArray(positions as number[], 3 * faces[i + 2]);
    tri.set(a, b, c).closestPointToPoint(p, q);
    best = Math.min(best, q.distanceToSquared(p));
    if (best === 0) break;
  }
  return best;
}

/** At most `n` of a list, evenly spread through it. */
function spread<T>(list: T[], n: number): T[] {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);
}

/**
 * The part as the knife cuts it: its own faces as authored, not patterned.
 * Cut through the patterned surface, a piece came back as that surface baked
 * into a plain mesh -- hundreds of thousands of triangles, no longer a pattern
 * anyone can edit, and the seams gone -- where carryAcrossCut lays the
 * patterns on again. (Bodies attached to it keep theirs baked, as before.)
 */
export function knifeSoups(node: SceneNode): { soups: Float64Array[]; absorbed: string[] } {
  const plain = { ...node, geoms: (node.geoms ?? []).map((g) => (g.textures?.length ? { ...g, textures: undefined } : g)) };
  return partSoups(plain);
}

export interface CarriedFeatures {
  textures?: SurfaceTexture[];
  faceSplits?: FaceSplit[];
}

/**
 * The patterns and seams of a part, for each of the pieces a plane cut it
 * into, in the body's frame (the frame of each piece's mesh).
 *
 * A pattern goes to every piece some of its face landed on, seeded on that
 * piece as far from the cut as its face reaches, so it grows over what is
 * left of the face and stops at the new edge. A pattern a cut ran through is
 * on both pieces, each laid out afresh. A seam goes with the stretch of it
 * on each piece.
 */
export function carryAcrossCut(
  node: SceneNode,
  sections: { positions: ArrayLike<number>; faces: ArrayLike<number> }[],
  at: number[],
  normal: number[],
): CarriedFeatures[] {
  const out: CarriedFeatures[] = sections.map(() => ({}));
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3().fromArray(normal).normalize(), new THREE.Vector3().fromArray(at));
  // A point on a piece lies on its surface to within rounding; the far side
  // of the part is never this close.
  const box = new THREE.Box3();
  for (const s of sections) for (let i = 0; i < s.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(s.positions[i], s.positions[i + 1], s.positions[i + 2]));
  const size = box.getSize(new THREE.Vector3()).length();
  const tol2 = (Math.max(1e-6, size * 1e-5)) ** 2;
  // Off the cut, so a seed is never on the cut face of the piece.
  const margin = Math.max(1e-5, size * 1e-3);
  const pieceOf = (p: THREE.Vector3) => {
    if (Math.abs(plane.distanceToPoint(p)) < margin) return -1;
    for (let k = 0; k < sections.length; k++) if (nearest2(p, sections[k].positions, sections[k].faces) <= tol2) return k;
    return -1;
  };

  for (const { geom, base, toBody } of patternSurfaces(node)) {
    const turn = new THREE.Matrix3().getNormalMatrix(toBody);
    const splits = geom.faceSplits ?? [];

    (geom.textures ?? []).forEach((texture) => {
      const region = patternRegionAt(base.positions, base.faces, geom.textures ?? [], texture.seedAt, texture.seedNormal, splits);
      if (!region) return;
      const t = region.triangles;
      // Each piece's seed: the point of the face on it farthest from the cut.
      const best = new Map<number, { d: number; at: THREE.Vector3; n: THREE.Vector3 }>();
      const tris = spread(Array.from({ length: t.length / 9 }, (_, i) => i), 400);
      for (const i of tris) {
        const a = new THREE.Vector3(t[9 * i], t[9 * i + 1], t[9 * i + 2]);
        const b = new THREE.Vector3(t[9 * i + 3], t[9 * i + 4], t[9 * i + 5]);
        const c = new THREE.Vector3(t[9 * i + 6], t[9 * i + 7], t[9 * i + 8]);
        const n = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3()).applyMatrix3(turn).normalize();
        const p = a.add(b).add(c).divideScalar(3).applyMatrix4(toBody);
        const d = Math.abs(plane.distanceToPoint(p));
        const k = pieceOf(p);
        if (k < 0 || (best.get(k)?.d ?? -1) >= d) continue;
        best.set(k, { d, at: p, n });
      }
      for (const [k, seed] of best) {
        (out[k].textures ??= []).push({ ...texture, seedAt: round(seed.at), seedNormal: round(seed.n) });
      }
    });

    splitSeams(base.positions, base.faces, splits).forEach((segments, s) => {
      const split = splits[s];
      const points = new Map<number, number[][]>();
      for (let i = 0; i + 5 < segments.length; i += 6) {
        const p = new THREE.Vector3(
          (segments[i] + segments[i + 3]) / 2, (segments[i + 1] + segments[i + 4]) / 2, (segments[i + 2] + segments[i + 5]) / 2,
        ).applyMatrix4(toBody);
        const k = pieceOf(p);
        if (k >= 0) points.set(k, [...(points.get(k) ?? []), round(p)]);
      }
      for (const [k, seeds] of points) {
        const moved: FaceSplit = {
          at: round(new THREE.Vector3().fromArray(split.at).applyMatrix4(toBody)),
          normal: round(new THREE.Vector3().fromArray(split.normal).applyMatrix3(turn).normalize()),
          seeds: spread(seeds, 12),
        };
        if (splitSeams(sections[k].positions, sections[k].faces, [moved])[0].length) (out[k].faceSplits ??= []).push(moved);
      }
    });
  }
  return out;
}
