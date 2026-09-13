// ---------------------------------------------------------------------------
// Combining two bodies into one
// ---------------------------------------------------------------------------
//
// A boolean is a program over ONE body's shapes. Two bodies dragged in from the
// sidebar are two MuJoCo objects, each with its own mass and joints, and a
// cylinder on one of them is invisible to the other's boolean — which is why
// subtracting a sphere from a cube needed the sphere to be created on the cube
// in the first place.
//
// This is the missing move: take the shapes off one body, rewrite them in
// another body's frame, and hand them over. After that they are ordinary geoms
// on one body and everything downstream — the evaluator, the collision modes,
// the Cut controls, the exporters — works on them unchanged.
//
// The whole difficulty is the rewrite. A geom's numbers are relative to the
// body carrying it, so moving it to a different body means composing three
// transforms: the source body's pose, the geom's own, and the inverse of the
// destination body's. Meshes have to have their vertices carried through it,
// and a capsule written as `fromto` has two endpoints in body coordinates
// rather than a position and a rotation. Getting any of that wrong lands the
// shape somewhere plausible-looking and wrong.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { createLattice, mergeLattice, type Lattice } from './latticeMesh';
import type { SceneGeom, SceneNode } from '../types/scene';

/** How a combined shape takes part in the boolean it lands in. */
export type CombineOp = 'union' | 'difference' | 'intersection';

/** A node's own transform, in its parent's frame. */
export function nodeMatrix(node: SceneNode): THREE.Matrix4 {
  const m = node.quat
    ? new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(node.quat[1] || 0, node.quat[2] || 0, node.quat[3] || 0, node.quat[0] ?? 1).normalize(),
    )
    : node.euler
      ? new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
        (node.euler[0] || 0) * THREE.MathUtils.DEG2RAD,
        (node.euler[1] || 0) * THREE.MathUtils.DEG2RAD,
        (node.euler[2] || 0) * THREE.MathUtils.DEG2RAD,
        'XYZ',
      ))
      : new THREE.Matrix4();
  const p = node.pos || [0, 0, 0];
  m.setPosition(p[0] || 0, p[1] || 0, p[2] || 0);
  return m;
}

/**
 * A node's transform in world space, or null if it isn't in the tree.
 *
 * Accumulated through the parents rather than read off the node, because a body
 * parented to another is positioned relative to it — and a child dragged onto a
 * gear is exactly the case where forgetting that puts the shape a metre away.
 */
export function nodeWorldMatrix(nodes: SceneNode[], id: string): THREE.Matrix4 | null {
  const walk = (list: SceneNode[], parent: THREE.Matrix4): THREE.Matrix4 | null => {
    for (const node of list || []) {
      const here = parent.clone().multiply(nodeMatrix(node));
      if (node.id === id) return here;
      const found = walk(node.children || [], here);
      if (found) return found;
    }
    return null;
  };
  return walk(nodes, new THREE.Matrix4());
}

/** Flat [x,y,z,...] run through a matrix, in place of a copy. */
function transformFlat(flat: number[], m: THREE.Matrix4, offset: number[] = [0, 0, 0]): number[] {
  const out = new Array<number>(flat.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < flat.length; i += 3) {
    v.set(flat[i] + (offset[0] || 0), flat[i + 1] + (offset[1] || 0), flat[i + 2] + (offset[2] || 0));
    v.applyMatrix4(m);
    out[i] = +v.x.toFixed(9);
    out[i + 1] = +v.y.toFixed(9);
    out[i + 2] = +v.z.toFixed(9);
  }
  return out;
}

/**
 * Z-up (how geoms are written) to Y-up (what the renderer reads).
 *
 * The `+ 0` is not decoration: negating a zero gives -0, and a mesh written out
 * with negative zeros in it is noise in every file it reaches.
 */
function zupToYupFlat(zup: number[]): number[] {
  const out = new Array<number>(zup.length);
  for (let i = 0; i < zup.length; i += 3) {
    out[i] = zup[i];
    out[i + 1] = zup[i + 2];
    out[i + 2] = -zup[i + 1] + 0;
  }
  return out;
}

/**
 * One geom, rewritten from its own body's frame into another's.
 *
 * `relative` is destination⁻¹ · source: apply it to anything written in the
 * source body's coordinates and you get the same point written in the
 * destination's.
 *
 * Rotation is carried as a quat and the euler is dropped, because the two
 * cannot both be right and MuJoCo reads the quat first. A geom with no rotation
 * of its own still gets one when the bodies are turned relative to each other —
 * that is the whole point.
 */
export function rewriteGeom(geom: SceneGeom, relative: THREE.Matrix4): SceneGeom {
  const next: SceneGeom = { ...geom };
  delete next.euler;

  if (geom.type === 'mesh') {
    // A mesh's vertices ARE its position: they are written in the body frame
    // and only shifted by an explicit pos, never turned by a quat (see
    // geomBounds). So the transform goes into the vertices and the geom comes
    // out sitting at the origin of its new body.
    const zup = geom.renderVertices ?? [];
    const moved = transformFlat(zup, relative, geom.pos || [0, 0, 0]);
    next.renderVertices = moved;
    next.vertices = zupToYupFlat(moved);
    next.pos = [0, 0, 0];
    delete next.quat;
    return next;
  }

  if (geom.fromto && geom.fromto.length >= 6) {
    // Two endpoints in body coordinates. There is no rotation to compose —
    // moving the ends moves the capsule, and pos and quat are ignored for a
    // geom written this way.
    const ends = transformFlat([...geom.fromto], relative);
    next.fromto = ends;
    delete next.quat;
    delete next.pos;
    return next;
  }

  const composed = relative.clone().multiply(geomMatrixOf(geom));
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  composed.decompose(pos, quat, new THREE.Vector3());
  next.pos = [+pos.x.toFixed(9), +pos.y.toFixed(9), +pos.z.toFixed(9)];
  // MuJoCo orders a quat [w, x, y, z]; THREE stores (x, y, z, w).
  next.quat = [quat.w, quat.x, quat.y, quat.z].map(v => +v.toFixed(9));
  return next;
}

/** A geom's own transform within its body. Mirrors utils/csg's private copy. */
function geomMatrixOf(geom: SceneGeom): THREE.Matrix4 {
  const m = geom.quat
    ? new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion(geom.quat[1] || 0, geom.quat[2] || 0, geom.quat[3] || 0, geom.quat[0] ?? 1).normalize(),
    )
    : geom.euler
      ? new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
        (geom.euler[0] || 0) * THREE.MathUtils.DEG2RAD,
        (geom.euler[1] || 0) * THREE.MathUtils.DEG2RAD,
        (geom.euler[2] || 0) * THREE.MathUtils.DEG2RAD,
        'XYZ',
      ))
      : new THREE.Matrix4();
  const p = geom.pos || [0, 0, 0];
  m.setPosition(p[0] || 0, p[1] || 0, p[2] || 0);
  return m;
}

/**
 * The shapes one body should hand to another, ready to append.
 *
 * Generated geoms are left behind — they are the previous boolean's output and
 * would be recompiled from the sources anyway — and so are negatives, which
 * belong to a hole in a body that is about to stop existing. Names are made
 * unique against `taken`, because two geoms sharing a name is a MuJoCo model
 * that will not build.
 */
export function geomsForCombine(
  source: SceneNode,
  relative: THREE.Matrix4,
  op: CombineOp,
  taken: Set<string>,
  /**
   * Leave the cage's own mesh behind — for when the cage itself is going
   * across instead (see the store's combineBodies), and the mesh would only
   * be the same shape twice.
   */
  withoutCage = false,
): SceneGeom[] {
  const out: SceneGeom[] = [];
  for (const geom of source.geoms || []) {
    if (geom.csgDerived) continue;
    if (withoutCage && geom.latticeGeom) continue;
    if (geom.csg === 'difference' || geom.csg === 'intersection') continue;
    if (geom.type === 'plane') continue;

    const next = rewriteGeom(geom, relative);
    // The cage that owned this mesh is being left behind with its body, so the
    // marker has to go too — otherwise the destination has two geoms claiming
    // to be its cage's, and the next lattice edit overwrites the wrong one.
    delete next.latticeGeom;
    delete next.cutNormal;
    delete next.cutAt;
    delete next.cutDepth;

    if (op === 'union') delete next.csg;
    else next.csg = op;

    let name = next.name || `${source.id}_geom`;
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    taken.add(name);
    next.name = name;
    out.push(next);
  }
  return out;
}

/**
 * A cage said in another body's coordinates.
 *
 * The cage equivalent of `rewriteGeom`, and the step that has to happen before
 * two lattice bodies can be booleaned together: a boolean compares two solids,
 * and two solids described in different frames are not comparable.
 *
 * A cage corner lives in its body's frame at `coord * unit - origin` — the mesh
 * is recentred on its own centre of mass, and the origin is how far it moved.
 * That point goes through the same transform as any other geom and comes back
 * onto the destination's grid, ROUNDED. Rounding is not a compromise here, it
 * is what the grid means: a body turned by something other than a right angle
 * arrives as the nearest shape the grid can hold, which is the same rule that
 * governs every other corner in the app.
 */
export function cageInFrame(
  source: Lattice,
  relative: THREE.Matrix4,
  sourceOrigin: number[] | undefined,
  targetOrigin: number[] | undefined,
  targetUnit: number,
): Lattice {
  const from = sourceOrigin ?? [0, 0, 0];
  const to = targetOrigin ?? [0, 0, 0];
  const point = new THREE.Vector3();
  const moved = createLattice(targetUnit);
  mergeLattice(moved, source, ([i, j, k]) => {
    point
      .set(i * source.unit - from[0], j * source.unit - from[1], k * source.unit - from[2])
      .applyMatrix4(relative);
    return [
      Math.round((point.x + to[0]) / targetUnit),
      Math.round((point.y + to[1]) / targetUnit),
      Math.round((point.z + to[2]) / targetUnit),
    ];
  });
  return moved;
}
