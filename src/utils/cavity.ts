// The air inside a body: a speaker box's volume, and its port.
//
// A loudspeaker enclosure is a watertight solid with a void in it. Sealed, the
// void is a second shell of the mesh, wound inward — its triangles face into
// the cavity, away from the material — so its signed volume is negative, and
// its size is the box's Vb. That needs nothing from the body but its mesh, so
// it measures any watertight body: a box, a cylinder, a sculpted horn.
//
// Ported, there is no second shell: the port's bore joins the inner surface to
// the outer one, and the mesh is a single shell with a tunnel through it. Here
// the port has to be named — a cylinder the body cuts out (a `difference`
// geom), whose axis and radius say which triangles are the bore. Take those
// out and the inner and outer surfaces fall apart; cap each one where the bore
// left it open and the inner one is the cavity again, closed at the bore's
// inner end so the tube's own air is not counted, and with any tube that
// stands into the box displacing its share. The bore's extent along the axis
// is the port's length and its distance from the axis its radius: what a
// speaker's port mass is made of.
//
// Measured in the units the mesh is in — metres here — and Z-up, the frame of
// `renderVertices`, which is the frame a negative's `pos` is written in once
// the compiled body's re-centring is taken off (see csgFrameOffset).

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { csgFrameOffset, csgSourceGeoms, fromtoFrame, geomMatrixOf, meshVolumeAndCentroid } from './csg';
import { analyzeMesh } from './meshIntegrity';

/** A cylinder through the body that may be its port. */
export interface PortAxis {
  /** A point on the axis, in the mesh's frame. */
  origin: number[];
  /** The axis direction; any length. */
  axis: number[];
  /** The bore's radius. */
  radius: number;
}

export interface Cavity {
  /** Air volume inside, in cubic mesh units. */
  volume: number;
  /** The port, when the cavity opens through one. */
  port?: { length: number; radius: number };
}

export type CavityResult = { ok: true; cavity: Cavity } | { ok: false; reason: string };

/** Points closer than this are the same point: OpenSCAD repeats them along creases. */
const WELD = 1e-9;

/** One index per distinct position, so edges can be matched across triangles. */
function weld(verts: number[], faces: number[]): { points: number[]; faces: number[] } {
  const seen = new Map<string, number>();
  const points: number[] = [];
  const remap: number[] = [];
  for (let i = 0; i < verts.length / 3; i++) {
    const key = `${Math.round(verts[3 * i] / WELD)},${Math.round(verts[3 * i + 1] / WELD)},${Math.round(verts[3 * i + 2] / WELD)}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = points.length / 3;
      seen.set(key, at);
      points.push(verts[3 * i], verts[3 * i + 1], verts[3 * i + 2]);
    }
    remap.push(at);
  }
  const out: number[] = [];
  for (let t = 0; t + 2 < faces.length; t += 3) {
    const a = remap[faces[t]], b = remap[faces[t + 1]], c = remap[faces[t + 2]];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  return { points, faces: out };
}

/** Triangles grouped into pieces that share a vertex. Indices are into the same point list. */
function pieces(faces: number[], vertexCount: number): number[][] {
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let t = 0; t < faces.length; t += 3) {
    const r = find(faces[t]);
    parent[find(faces[t + 1])] = r;
    parent[find(faces[t + 2])] = r;
  }
  const byRoot = new Map<number, number[]>();
  for (let t = 0; t < faces.length; t += 3) {
    const r = find(faces[t]);
    const list = byRoot.get(r) ?? [];
    list.push(faces[t], faces[t + 1], faces[t + 2]);
    byRoot.set(r, list);
  }
  return [...byRoot.values()];
}

/**
 * A piece closed over every hole in it: each loop of edges that only one of
 * its triangles uses gets a fan to the loop's centroid, wound the other way
 * round the edge, so the cap faces the same side the piece does. Exact for a
 * flat hole, which is what a bore leaves in a flat wall or a tube's end.
 */
function capped(points: number[], faces: number[]): { points: number[]; faces: number[] } {
  const directed = new Set<string>();
  for (let t = 0; t < faces.length; t += 3) {
    for (let e = 0; e < 3; e++) directed.add(`${faces[t + e]},${faces[t + (e + 1) % 3]}`);
  }
  const next = new Map<number, number>();
  for (let t = 0; t < faces.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = faces[t + e], b = faces[t + (e + 1) % 3];
      if (!directed.has(`${b},${a}`)) next.set(a, b);
    }
  }
  const outPoints = [...points];
  const outFaces = [...faces];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !done.has(v)) {
      done.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (loop.length < 3) continue;
    const c = [0, 0, 0];
    for (const i of loop) for (let k = 0; k < 3; k++) c[k] += points[3 * i + k] / loop.length;
    const ci = outPoints.length / 3;
    outPoints.push(c[0], c[1], c[2]);
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      outFaces.push(b, a, ci);
    }
  }
  return { points: outPoints, faces: outFaces };
}

/** The volume of a closed piece wound inward — a void — or null for anything else. */
function voidVolume(points: number[], faces: number[]): number | null {
  const integrity = analyzeMesh(points, faces);
  if (!integrity?.closed || !integrity.consistentlyWound || !(integrity.volume < 0)) return null;
  return meshVolumeAndCentroid(points, faces).volume;
}

/**
 * The triangles of the bore: every corner on the cylinder of `port`'s radius
 * about its axis, and facing across the axis rather than along it.
 */
function boreTriangles(points: number[], faces: number[], port: PortAxis): Set<number> {
  const axis = new THREE.Vector3(...port.axis).normalize();
  const origin = new THREE.Vector3(...port.origin);
  const tol = Math.max(port.radius * 1e-3, 1e-9);
  const p = new THREE.Vector3();
  const onCylinder = (i: number) => {
    p.set(points[3 * i], points[3 * i + 1], points[3 * i + 2]).sub(origin);
    const along = p.dot(axis);
    const radial = Math.sqrt(Math.max(0, p.lengthSq() - along * along));
    return Math.abs(radial - port.radius) <= tol;
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const bore = new Set<number>();
  for (let t = 0; t < faces.length; t += 3) {
    if (!onCylinder(faces[t]) || !onCylinder(faces[t + 1]) || !onCylinder(faces[t + 2])) continue;
    a.fromArray(points, 3 * faces[t]);
    b.fromArray(points, 3 * faces[t + 1]);
    c.fromArray(points, 3 * faces[t + 2]);
    const n = b.sub(a).cross(c.sub(a));
    const len = n.length();
    if (len > 0 && Math.abs(n.dot(axis)) / len < 0.1) bore.add(t);
  }
  return bore;
}

/**
 * Measures the cavity of a watertight mesh: the inward shells' volume when it
 * has any, else the cavity behind the first of `ports` that opens into one.
 */
export function measureCavity(verts: number[], faces: number[], ports: PortAxis[] = []): CavityResult {
  const mesh = weld(verts, faces);
  const whole = analyzeMesh(mesh.points, mesh.faces);
  if (!whole) return { ok: false, reason: 'The body has no mesh to measure, or too large a one.' };
  if (!whole.closed || !whole.consistentlyWound) {
    return { ok: false, reason: 'The body is not watertight, so it has no inside to measure. Check it in the scene summary.' };
  }

  // Sealed: every inward shell is air.
  let sealed = 0;
  for (const piece of pieces(mesh.faces, mesh.points.length / 3)) {
    const v = voidVolume(mesh.points, piece);
    if (v !== null) sealed += v;
  }
  if (sealed > 0) return { ok: true, cavity: { volume: sealed } };

  // Ported: open each candidate's bore and see whether a void is left behind it.
  for (const port of ports) {
    const bore = boreTriangles(mesh.points, mesh.faces, port);
    if (bore.size === 0) continue;
    const rest: number[] = [];
    for (let t = 0; t < mesh.faces.length; t += 3) if (!bore.has(t)) rest.push(mesh.faces[t], mesh.faces[t + 1], mesh.faces[t + 2]);
    let volume = 0;
    for (const piece of pieces(rest, mesh.points.length / 3)) {
      const closed = capped(mesh.points, piece);
      const v = voidVolume(closed.points, closed.faces);
      if (v !== null) volume += v;
    }
    if (!(volume > 0)) continue;

    const axis = new THREE.Vector3(...port.axis).normalize();
    const origin = new THREE.Vector3(...port.origin);
    const p = new THREE.Vector3();
    let lo = Infinity, hi = -Infinity, radial = 0, n = 0;
    const seen = new Set<number>();
    for (const t of bore) {
      for (let k = 0; k < 3; k++) {
        const i = mesh.faces[t + k];
        if (seen.has(i)) continue;
        seen.add(i);
        p.fromArray(mesh.points, 3 * i).sub(origin);
        const along = p.dot(axis);
        lo = Math.min(lo, along);
        hi = Math.max(hi, along);
        radial += Math.sqrt(Math.max(0, p.lengthSq() - along * along));
        n++;
      }
    }
    return { ok: true, cavity: { volume, port: { length: hi - lo, radius: radial / n } } };
  }

  return {
    ok: false,
    reason: ports.length
      ? 'No sealed cavity, and none of the cylinders this body cuts out opens into one.'
      : 'No sealed cavity. If the box is ported, cut the port as a cylinder (a difference geom) so it can be found.',
  };
}

/** The mesh a body is drawn with, in its Z-up frame: the compiled boolean, or its own mesh geom. */
export function bodyMesh(node: SceneNode): { verts: number[]; faces: number[] } | null {
  const geoms = node.geoms ?? [];
  const compiled = geoms.find(g => g.type === 'mesh' && g.csgDerived === 'visual');
  const own = geoms.find(g => g.type === 'mesh' && !g.csgDerived && g.role !== 'collision');
  const g = compiled ?? own;
  const verts = g?.renderVertices ?? g?.vertices;
  return g && verts && g.faces ? { verts, faces: g.faces } : null;
}

/**
 * The cylinders a body cuts out, as candidate ports in its compiled mesh's
 * frame: the bore of each, with its axis.
 */
export function portCandidates(node: SceneNode): PortAxis[] {
  if (!node.csgEnabled) return [];
  const offset = csgFrameOffset(node);
  return csgSourceGeoms(node)
    .filter((g: SceneGeom) => g.csg === 'difference' && g.type === 'cylinder')
    .map((g: SceneGeom) => {
      const m = g.fromto && g.fromto.length >= 6 ? fromtoFrame(g.fromto).matrix : geomMatrixOf(g);
      const e = m.elements;
      return {
        origin: [e[12] - offset[0], e[13] - offset[1], e[14] - offset[2]],
        axis: [e[8], e[9], e[10]],
        radius: g.size?.[0] ?? 0,
      };
    })
    .filter(p => p.radius > 0);
}

/** The cavity of a scene body. */
export function measureBodyCavity(node: SceneNode): CavityResult {
  const mesh = bodyMesh(node);
  if (!mesh) return { ok: false, reason: 'Only a body with a mesh — a boolean, an import or a sculpt — has an inside to measure.' };
  return measureCavity(mesh.verts, mesh.faces, portCandidates(node));
}
