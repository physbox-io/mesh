// Boolean modifiers ("CSG") for primitive bodies.
//
// A body whose node has csgEnabled is no longer a bag of independent solids —
// its geoms become a small CSG program: positives are unioned, geoms marked
// csg:'difference' are cut out, csg:'intersection' geoms intersect. So one
// ellipsoid with a smaller piercing ellipsoid marked negative is a ring.
//
// Evaluation reuses the OpenSCAD pipeline that already exists for hand-written
// scad bodies (src/utils/openscad.ts -> the worker pool): we emit an equivalent
// .scad program from the primitives and compile it to a mesh. The primitives
// stay the source of truth — the mesh is a derived artefact, regenerated
// whenever a size, position or operator changes.
//
// COLLISION is the part that needs care. MuJoCo takes the CONVEX HULL of every
// mesh geom, so a subtracted hole simply does not exist for contact: a ring
// would collide as a solid disc. Three answers, chosen per body:
//
//   'primitives' — the boolean mesh is visual only (role:'visual', contype 0)
//                  and the positive source primitives are the colliders. Exact
//                  convex collision, but holes are solid.
//   'decompose'  — slice the boolean mesh into N angular sectors about the hole
//                  axis and emit one convex collider per sector. The hole
//                  survives (each sector's hull spans a chord of the inner
//                  surface, intruding by only inner*(1-cos(pi/N)) — 1.9% at
//                  N=16), and every collider is genuinely convex, so MuJoCo's
//                  hulling is a no-op. Same trick generateCurveGeoms uses to
//                  keep a concave track concave.
//   'hull'       — one mesh geom that both draws and collides, i.e. collides as
//                  the filled hull. Cheapest, occasionally what you want.
//
// A general convex decomposition (V-HACD) would subsume 'decompose' for shapes
// that aren't rings; nothing here precludes adding it as a fourth mode.

import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { SceneGeom, SceneNode } from '../types/scene';
// NOTE: ./openscad is imported lazily inside evaluateNodeCsg, not here. It
// reaches the Zustand store (for the compile counter), which reaches the physics
// worker client and the MuJoCo wasm glue — so a static import would drag the
// entire app into anything that only wants the geometry helpers in this file,
// and make them untestable outside a browser.

export const CSG_DEFAULT_SECTORS = 16;
export const CSG_DEFAULT_FN = 32;

// ---------------------------------------------------------------------------
// Coordinate spaces
//
// Geom pos/quat and OpenSCAD are both Z-up, so the emitted program is authored
// directly in the body's MuJoCo frame with no conversion. Only the stored
// vertex arrays differ: SceneGeom.vertices is Three.js Y-up (mjcf.ts swaps it
// back when emitting <mesh>), SceneGeom.renderVertices is Z-up.
// ---------------------------------------------------------------------------

const zupToYup = (v: number[]): number[] => [v[0], v[2], -v[1]];

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

// MuJoCo's default eulerseq is "xyz" applied in the rotating frame, i.e.
// R = Rx * Ry * Rz, in degrees (no <compiler> element = angle="degree").
function eulerDegToMatrix(e: number[]): THREE.Matrix4 {
  const rx = new THREE.Matrix4().makeRotationX((e[0] || 0) * THREE.MathUtils.DEG2RAD);
  const ry = new THREE.Matrix4().makeRotationY((e[1] || 0) * THREE.MathUtils.DEG2RAD);
  const rz = new THREE.Matrix4().makeRotationZ((e[2] || 0) * THREE.MathUtils.DEG2RAD);
  return rx.multiply(ry).multiply(rz);
}

// MuJoCo quats are [w, x, y, z]; THREE.Quaternion is (x, y, z, w).
function quatToMatrix(q: number[]): THREE.Matrix4 {
  const t = new THREE.Quaternion(q[1] || 0, q[2] || 0, q[3] || 0, q[0] ?? 1).normalize();
  return new THREE.Matrix4().makeRotationFromQuaternion(t);
}

export function geomMatrixOf(geom: SceneGeom): THREE.Matrix4 {
  return geomMatrix(geom);
}

function geomMatrix(geom: SceneGeom): THREE.Matrix4 {
  const m = geom.quat
    ? quatToMatrix(geom.quat)
    : geom.euler
      ? eulerDegToMatrix(geom.euler)
      : new THREE.Matrix4();
  const p = geom.pos || [0, 0, 0];
  m.setPosition(p[0] || 0, p[1] || 0, p[2] || 0);
  return m;
}

// capsule/cylinder geoms may be authored as fromto (two endpoints) instead of
// pos+size[1]. Reduce that to the centre, the rotation taking local +Z onto the
// axis, and the half-length — the form the scad emitter wants.
function fromtoFrame(fromto: number[]): { matrix: THREE.Matrix4; halfLen: number } {
  const a = new THREE.Vector3(fromto[0], fromto[1], fromto[2]);
  const b = new THREE.Vector3(fromto[3], fromto[4], fromto[5]);
  const dir = new THREE.Vector3().subVectors(b, a);
  const halfLen = dir.length() / 2;
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const q = new THREE.Quaternion();
  if (halfLen > 1e-9) q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  m.setPosition(mid);
  return { matrix: m, halfLen };
}

const fmt = (n: number) => (Number.isFinite(n) ? +n.toFixed(6) : 0);

function multmatrixWrap(m: THREE.Matrix4, inner: string, indent: string): string {
  const e = m.elements; // column-major
  const rows = [
    [e[0], e[4], e[8], e[12]],
    [e[1], e[5], e[9], e[13]],
    [e[2], e[6], e[10], e[14]],
    [0, 0, 0, 1],
  ];
  const isIdentity = rows.every((r, i) => r.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-9));
  if (isIdentity) return `${indent}${inner}`;
  const mat = rows.map(r => `[${r.map(fmt).join(', ')}]`).join(', ');
  return `${indent}multmatrix([${mat}]) ${inner}`;
}

// ---------------------------------------------------------------------------
// Primitive -> OpenSCAD
// ---------------------------------------------------------------------------

/**
 * Emits a single primitive geom as an OpenSCAD solid, positioned and oriented in
 * the body frame. Returns null for geoms with no solid volume (planes) or
 * unusable mesh data.
 *
 * Sizes follow MuJoCo's conventions: box size is HALF-extents, cylinder and
 * capsule are [radius, half-length] along local Z, ellipsoid is three radii.
 */
export function primitiveToScad(geom: SceneGeom, fn: number = CSG_DEFAULT_FN, indent = '  '): string | null {
  const s = geom.size || [];
  let matrix = geomMatrix(geom);
  let body: string;

  switch (geom.type) {
    case 'sphere':
      body = `sphere(r=${fmt(s[0] ?? 0.1)}, $fn=${fn});`;
      break;
    case 'box':
      body = `cube([${fmt((s[0] ?? 0.1) * 2)}, ${fmt((s[1] ?? s[0] ?? 0.1) * 2)}, ${fmt((s[2] ?? s[0] ?? 0.1) * 2)}], center=true);`;
      break;
    case 'ellipsoid':
      body = `scale([${fmt(s[0] ?? 0.1)}, ${fmt(s[1] ?? s[0] ?? 0.1)}, ${fmt(s[2] ?? s[0] ?? 0.1)}]) sphere(r=1, $fn=${fn});`;
      break;
    case 'cylinder': {
      let halfLen = s[1] ?? s[0] ?? 0.1;
      if (geom.fromto && geom.fromto.length >= 6) {
        const f = fromtoFrame(geom.fromto);
        matrix = f.matrix;
        halfLen = f.halfLen;
      }
      body = `cylinder(h=${fmt(halfLen * 2)}, r=${fmt(s[0] ?? 0.1)}, center=true, $fn=${fn});`;
      break;
    }
    case 'capsule': {
      let halfLen = s[1] ?? 0.1;
      if (geom.fromto && geom.fromto.length >= 6) {
        const f = fromtoFrame(geom.fromto);
        matrix = f.matrix;
        halfLen = f.halfLen;
      }
      const r = fmt(s[0] ?? 0.05);
      // hull() of the two end spheres is exactly a capsule, and it keeps the
      // result a single closed solid (unlike cylinder + two spheres unioned).
      body = `hull() { translate([0, 0, ${fmt(-halfLen)}]) sphere(r=${r}, $fn=${fn}); translate([0, 0, ${fmt(halfLen)}]) sphere(r=${r}, $fn=${fn}); }`;
      break;
    }
    case 'mesh': {
      // Prefer renderVertices: already Z-up, same space as everything else here.
      const zup = geom.renderVertices ?? (geom.vertices ? yupArrayToZup(geom.vertices) : null);
      if (!zup || !geom.faces || geom.faces.length === 0) return null;
      const pts: string[] = [];
      for (let i = 0; i < zup.length; i += 3) pts.push(`[${fmt(zup[i])},${fmt(zup[i + 1])},${fmt(zup[i + 2])}]`);
      const tris: string[] = [];
      // OpenSCAD wants each face wound CLOCKWISE seen from outside; ours are CCW.
      for (let i = 0; i < geom.faces.length; i += 3) {
        tris.push(`[${geom.faces[i + 2]},${geom.faces[i + 1]},${geom.faces[i]}]`);
      }
      body = `polyhedron(points=[${pts.join(',')}], faces=[${tris.join(',')}], convexity=4);`;
      break;
    }
    default:
      return null; // plane, or anything with no volume
  }

  return multmatrixWrap(matrix, body, indent);
}

function yupArrayToZup(v: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 3) out.push(v[i], -v[i + 2], v[i + 1]);
  return out;
}

/** The geoms a CSG node was authored from, i.e. everything not generated by us. */
export function csgSourceGeoms(node: SceneNode): SceneGeom[] {
  return (node.geoms || []).filter(g => !g.csgDerived);
}

export function csgDerivedGeoms(node: SceneNode): SceneGeom[] {
  return (node.geoms || []).filter(g => !!g.csgDerived);
}

const isNegative = (g: SceneGeom) => g.csg === 'difference';
const isIntersect = (g: SceneGeom) => g.csg === 'intersection';
const isPositive = (g: SceneGeom) => (!g.csg || g.csg === 'union') && g.role !== 'visual';

/**
 * True if this node's geoms actually describe a boolean — i.e. there is
 * something to subtract or intersect, and something to subtract it from.
 * A csgEnabled node with only positives needs no CSG at all.
 */
export function hasBooleanOps(node: SceneNode): boolean {
  const src = csgSourceGeoms(node);
  const pos = src.filter(isPositive);
  return pos.length > 0 && src.some(g => isNegative(g) || isIntersect(g));
}

/**
 * Emits the whole body as one OpenSCAD program, or null if there's no boolean
 * to evaluate. Order of operations: intersect the union of positives, then
 * subtract the negatives.
 */
export function csgProgram(node: SceneNode): string | null {
  if (!hasBooleanOps(node)) return null;
  const fn = node.csgFn ?? CSG_DEFAULT_FN;
  const src = csgSourceGeoms(node);

  const emit = (geoms: SceneGeom[], indent: string) =>
    geoms.map(g => primitiveToScad(g, fn, indent)).filter(Boolean).join('\n');

  // The source is shown to the user in the properties panel, so it's worth
  // indenting properly: each wrapper re-indents the block it encloses.
  const reindent = (block: string) => block.split('\n').map(l => `  ${l}`).join('\n');

  // Emitted at column 0; each enclosing wrapper below re-indents what it wraps.
  const positives = emit(src.filter(isPositive), '');
  if (!positives.trim()) return null;

  let body = src.filter(isPositive).length > 1 ? `union() {\n${reindent(positives)}\n}` : positives;

  const intersects = src.filter(isIntersect);
  if (intersects.length > 0) {
    body = `intersection() {\n${reindent(body)}\n${emit(intersects, '  ')}\n}`;
  }

  const negatives = src.filter(isNegative);
  if (negatives.length > 0) {
    body = `difference() {\n${reindent(body)}\n${emit(negatives, '  ')}\n}`;
  }

  return `// Generated from ${node.name || node.id}'s primitives — edit the shapes, not this.\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Mesh measurement
// ---------------------------------------------------------------------------

/**
 * Signed volume and volume centroid of a closed triangle mesh, by summing the
 * signed tetrahedra each face makes with the origin. Vertices flat, any space.
 */
export function meshVolumeAndCentroid(verts: number[], faces: number[]): { volume: number; centroid: number[] } {
  let vol = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, d = faces[i + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
    const cx = verts[d], cy = verts[d + 1], cz = verts[d + 2];
    // (a x b) . c / 6
    const v = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    c[0] += v * (ax + bx + cx) / 4;
    c[1] += v * (ay + by + cy) / 4;
    c[2] += v * (az + bz + cz) / 4;
  }
  if (Math.abs(vol) < 1e-12) return { volume: 0, centroid: [0, 0, 0] };
  return { volume: Math.abs(vol), centroid: [c[0] / vol, c[1] / vol, c[2] / vol] };
}

// ---------------------------------------------------------------------------
// Convex hull
// ---------------------------------------------------------------------------

interface Hull {
  verts: number[];  // flat, in the input space
  faces: number[];  // triangle indices, CCW outward
  volume: number;
  centroid: number[];
}

/**
 * Convex hull of a point cloud as an indexed triangle mesh. ConvexHull yields
 * arbitrary convex polygons; each is fan-triangulated, which is valid because a
 * convex polygon's fan from any of its vertices stays inside it.
 */
export function convexHullOf(points: number[][]): Hull | null {
  if (points.length < 4) return null;
  let hull: any;
  try {
    hull = new ConvexHull().setFromPoints(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
  } catch {
    return null; // degenerate (coplanar) clouds throw
  }
  if (!hull.faces || hull.faces.length < 4) return null;

  const verts: number[] = [];
  const faces: number[] = [];
  const index = new Map<string, number>();
  const idxOf = (v: THREE.Vector3) => {
    const key = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = verts.length / 3;
      verts.push(v.x, v.y, v.z);
      index.set(key, i);
    }
    return i;
  };

  for (const face of hull.faces as any[]) {
    const ring: number[] = [];
    let edge = face.edge;
    do {
      ring.push(idxOf(edge.head().point));
      edge = edge.next;
    } while (edge !== face.edge);
    for (let i = 1; i < ring.length - 1; i++) {
      if (ring[0] !== ring[i] && ring[i] !== ring[i + 1] && ring[0] !== ring[i + 1]) {
        faces.push(ring[0], ring[i], ring[i + 1]);
      }
    }
  }
  if (faces.length < 12) return null; // fewer than 4 triangles isn't a solid
  const { volume, centroid } = meshVolumeAndCentroid(verts, faces);
  if (volume < 1e-12) return null;
  return { verts, faces, volume, centroid };
}

// ---------------------------------------------------------------------------
// Hole axis detection
// ---------------------------------------------------------------------------

/**
 * The interval a geom projects onto a direction — its exact extent along `d`,
 * via each primitive's support function.
 *
 * Deliberately not the projection of the geom's AABB: for an obliquely rotated
 * cylinder the AABB is far fatter than the cylinder in the directions across its
 * axis, which makes a legitimately rotated hole look as though it spans the solid
 * sideways too, and get rejected.
 */
export function supportInterval(g: SceneGeom, d: THREE.Vector3): { lo: number; hi: number } | null {
  const s = g.size || [];
  const r = s[0] ?? 0.1;

  if (g.type === 'mesh') {
    const v = g.renderVertices;
    if (!v || v.length === 0) return null;
    const off = g.pos || [0, 0, 0];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const t = (v[i] + (off[0] || 0)) * d.x + (v[i + 1] + (off[1] || 0)) * d.y + (v[i + 2] + (off[2] || 0)) * d.z;
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return { lo, hi };
  }

  let m = geomMatrix(g);
  let halfLen = s[1] ?? r;
  if (g.fromto && g.fromto.length >= 6 && (g.type === 'cylinder' || g.type === 'capsule')) {
    const f = fromtoFrame(g.fromto);
    m = f.matrix;
    halfLen = f.halfLen;
  }
  const centre = new THREE.Vector3().setFromMatrixPosition(m).dot(d);
  // Columns of the rotation part: the geom's local axes, in body space.
  const e = m.elements;
  const ax = new THREE.Vector3(e[0], e[1], e[2]);
  const ay = new THREE.Vector3(e[4], e[5], e[6]);
  const az = new THREE.Vector3(e[8], e[9], e[10]);

  let radius: number;
  switch (g.type) {
    case 'box':
      radius = Math.abs(r * ax.dot(d)) + Math.abs((s[1] ?? r) * ay.dot(d)) + Math.abs((s[2] ?? r) * az.dot(d));
      break;
    case 'sphere':
      radius = r;
      break;
    case 'ellipsoid':
      radius = Math.hypot(r * ax.dot(d), (s[1] ?? r) * ay.dot(d), (s[2] ?? r) * az.dot(d));
      break;
    case 'cylinder': {
      const along = az.dot(d);
      radius = Math.abs(halfLen * along) + r * Math.sqrt(Math.max(0, 1 - along * along));
      break;
    }
    case 'capsule':
      // The end caps contribute their full radius in every direction.
      radius = Math.abs(halfLen * az.dot(d)) + r;
      break;
    default:
      return null;
  }
  return { lo: centre - radius, hi: centre + radius };
}

/**
 * The axis a hole runs along: the one on which a negative geom fully SPANS the
 * solid, i.e. goes right through it and out the other side.
 *
 * This deliberately does not use "the negative's longest axis". A hole through a
 * thin plate is wider than it is deep — the ring in the boolean_shapes preset
 * subtracts a 0.062-radius ellipsoid only 0.05 deep — so the longest axis of the
 * negative is across the hole, not along it, and slicing about it would fill the
 * hole back in. Piercing is the property that actually defines a hole.
 *
 * Returns null when nothing pierces: a negative wholly inside the solid is a
 * sealed cavity and a negative that only bites into one face is a notch. Neither
 * has an axis to decompose about, and the caller falls back to colliding the
 * source primitives.
 */
export function detectHoleAxis(node: SceneNode): { origin: number[]; axis: number[] } | null {
  const negatives = csgSourceGeoms(node).filter(isNegative);
  if (negatives.length === 0) return null;

  const host = positiveBounds(node);
  if (!host) return null;

  const axisFor = (i: number) => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const forced = node.csgHoleAxis;

  // An explicit choice wins, but still needs a negative to centre the slicing on:
  // pick the largest, as below.
  const bySize = negatives
    .map(g => ({ g, b: geomBounds(g) }))
    .filter((x): x is { g: SceneGeom; b: { min: number[]; max: number[] } } => !!x.b)
    .sort((a, b) => {
      const vol = (x: { min: number[]; max: number[] }) =>
        (x.max[0] - x.min[0]) * (x.max[1] - x.min[1]) * (x.max[2] - x.min[2]);
      return vol(b.b) - vol(a.b);
    });
  if (bySize.length === 0) return null;

  if (forced && forced !== 'auto') {
    const i = forced === 'x' ? 0 : forced === 'y' ? 1 : 2;
    return { origin: bySize[0].g.pos ? [...bySize[0].g.pos!] : [0, 0, 0], axis: axisFor(i) };
  }

  // The solid's extent along a direction: the union of its positives' intervals.
  const hostInterval = (d: THREE.Vector3) => {
    let lo = Infinity, hi = -Infinity;
    for (const g of csgSourceGeoms(node)) {
      if (!isPositive(g)) continue;
      const iv = supportInterval(g, d);
      if (!iv) continue;
      if (iv.lo < lo) lo = iv.lo;
      if (iv.hi > hi) hi = iv.hi;
    }
    return lo <= hi ? { lo, hi } : null;
  };

  const EPS = 1e-9;
  const spans = (g: SceneGeom, d: THREE.Vector3) => {
    const n = supportInterval(g, d);
    const h = hostInterval(d);
    if (!n || !h) return false;
    return n.lo <= h.lo + EPS && n.hi >= h.hi - EPS;
  };

  // Source order breaks ties, so a body with several shafts (the hollow cube has
  // three) decomposes about the first one declared — documented, not arbitrary.
  for (const g of negatives) {
    // The negative's OWN axes come first — for a cylinder or capsule, local +Z is
    // the direction it was built to cut along, and testing it means an obliquely
    // rotated hole is still found. Body axes follow as the fallback.
    const rot = g.quat ? quatToMatrix(g.quat)
      : g.euler ? eulerDegToMatrix(g.euler)
      : (g.fromto && g.fromto.length >= 6 && (g.type === 'cylinder' || g.type === 'capsule'))
        ? new THREE.Matrix4().extractRotation(fromtoFrame(g.fromto).matrix)
        : new THREE.Matrix4();

    const candidates: THREE.Vector3[] = [];
    for (const local of [[0, 0, 1], [1, 0, 0], [0, 1, 0]]) {
      candidates.push(new THREE.Vector3(local[0], local[1], local[2]).applyMatrix4(rot).normalize());
    }
    for (const a of [2, 0, 1]) {
      const v = new THREE.Vector3(...(axisFor(a) as [number, number, number]));
      if (!candidates.some(c => Math.abs(c.dot(v)) > 0.999)) candidates.push(v);
    }

    for (const d of candidates) {
      if (!spans(g, d)) continue;

      // A HOLE spans exactly one direction: material has to remain all around it.
      // Spanning two means the negative removes an entire end of the solid — a
      // chop or a slot, not a hole. (The chopped cone's cutting box spans the
      // cone in both x and y, and slicing about either would be nonsense.)
      const p0 = new THREE.Vector3(1, 0, 0);
      if (Math.abs(d.dot(p0)) > 0.9) p0.set(0, 1, 0);
      p0.sub(d.clone().multiplyScalar(d.dot(p0))).normalize();
      const p1 = new THREE.Vector3().crossVectors(d, p0).normalize();
      if (spans(g, p0) || spans(g, p1)) continue;

      return { origin: g.pos ? [...g.pos] : [0, 0, 0], axis: [d.x, d.y, d.z] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sector decomposition
// ---------------------------------------------------------------------------

/**
 * Slices a mesh into `sectors` angular wedges about `axis` through `origin` and
 * returns the convex hull of each wedge.
 *
 * Each wedge's point cloud is its own vertices PLUS the points where mesh edges
 * cross the two bounding half-planes. Those crossing points are shared exactly
 * with the neighbouring wedge, so adjacent hulls meet face-to-face instead of
 * leaving a V-shaped gap along every boundary.
 *
 * What survives: the hole (each hull only spans a chord of the inner surface).
 * What doesn't: concavities WITHIN one wedge, which get filled — the price of
 * every collider being convex, and the reason a V-HACD mode would still have
 * something to offer for non-ring shapes.
 */
export function decomposeAroundAxis(
  verts: number[],
  faces: number[],
  origin: number[],
  axis: number[],
  sectors: number
): Hull[] {
  const n = Math.max(3, Math.floor(sectors));
  const a = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
  const o = new THREE.Vector3(origin[0], origin[1], origin[2]);
  // Any two directions perpendicular to the axis; the sector boundaries are
  // arbitrary in absolute terms, only their spacing matters.
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(a.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(a.clone().multiplyScalar(a.dot(u))).normalize();
  const v = new THREE.Vector3().crossVectors(a, u).normalize();

  const delta = (Math.PI * 2) / n;
  // Inward normals of the two half-planes bounding sector s. Valid as an
  // intersection-of-two-halfspaces test only while the wedge is under 180°,
  // hence n >= 3.
  const normals: THREE.Vector3[] = [];
  for (let s = 0; s <= n; s++) {
    const ang = s * delta;
    normals.push(
      u.clone().multiplyScalar(-Math.sin(ang)).add(v.clone().multiplyScalar(Math.cos(ang)))
    );
  }

  const P: THREE.Vector3[] = [];
  for (let i = 0; i < verts.length; i += 3) {
    P.push(new THREE.Vector3(verts[i] - o.x, verts[i + 1] - o.y, verts[i + 2] - o.z));
  }
  // Signed distance of every vertex to every boundary plane, computed once.
  const dist: Float64Array[] = normals.map(nn => {
    const d = new Float64Array(P.length);
    for (let i = 0; i < P.length; i++) d[i] = P[i].dot(nn);
    return d;
  });

  const EPS = 1e-9;
  const clouds: number[][][] = Array.from({ length: n }, () => []);

  // Vertices land in the sector whose two half-planes they're both inside of.
  for (let i = 0; i < P.length; i++) {
    for (let s = 0; s < n; s++) {
      if (dist[s][i] >= -EPS && dist[s + 1][i] <= EPS) {
        clouds[s].push([P[i].x, P[i].y, P[i].z]);
      }
    }
  }

  // Unique mesh edges, so a boundary crossing is only computed once per edge.
  const edges = new Set<number>();
  const pushEdge = (i: number, j: number) => edges.add(i < j ? i * P.length + j : j * P.length + i);
  for (let i = 0; i < faces.length; i += 3) {
    pushEdge(faces[i], faces[i + 1]);
    pushEdge(faces[i + 1], faces[i + 2]);
    pushEdge(faces[i + 2], faces[i]);
  }

  for (const key of edges) {
    const i = Math.floor(key / P.length), j = key % P.length;
    for (let b = 0; b < n; b++) {
      const di = dist[b][i], dj = dist[b][j];
      if ((di > EPS && dj < -EPS) || (di < -EPS && dj > EPS)) {
        const t = di / (di - dj);
        const p = P[i].clone().lerp(P[j], t);
        // A crossing of boundary b belongs to the two sectors that share it —
        // but only if it's within their OTHER bound, since a plane is infinite
        // while the wedge is not.
        const prev = (b - 1 + n) % n;
        const pt = [p.x, p.y, p.z];
        if (p.dot(normals[b + 1]) <= EPS) clouds[b].push(pt);
        if (p.dot(normals[prev]) >= -EPS) clouds[prev].push(pt);
      }
    }
  }

  const out: Hull[] = [];
  for (const cloud of clouds) {
    const hull = convexHullOf(cloud);
    if (!hull) continue;
    // Back into the mesh's own frame (the clouds were built relative to origin).
    for (let i = 0; i < hull.verts.length; i += 3) {
      hull.verts[i] += o.x;
      hull.verts[i + 1] += o.y;
      hull.verts[i + 2] += o.z;
    }
    hull.centroid = [hull.centroid[0] + o.x, hull.centroid[1] + o.y, hull.centroid[2] + o.z];
    out.push(hull);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

// Cheap, stable fingerprint of everything the derived geoms depend on. When
// this matches node.csgHash the mesh on the node is already correct.
export function csgHashOf(node: SceneNode): string {
  const program = csgProgram(node);
  if (!program) return '';
  const key = JSON.stringify([
    program,
    node.csgCollision ?? 'auto',
    node.csgSectors ?? CSG_DEFAULT_SECTORS,
    node.csgHoleAxis ?? 'auto',
    node.csgMass ?? null,
    csgSourceGeoms(node).filter(isPositive).map(g => [g.rgba, g.mass, g.friction, g.condim, g.solref, g.solimp]),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `${h.toString(16)}_${key.length}`;
}

export interface CsgResult {
  hash: string;
  scad: string;
  geoms: SceneGeom[];      // derived geoms only — the visual mesh and any colliders
  volume: number;
  hullVolume: number;
  centroid: number[];
  mode: 'decompose' | 'primitives' | 'hull';
  warning?: string;
}

const MAX_COMPILE_ATTEMPTS = 3;

/**
 * Evaluates a node's boolean program and builds the derived geoms for it.
 * Throws if the shape cannot be compiled at all.
 */
export async function evaluateNodeCsg(node: SceneNode): Promise<CsgResult | null> {
  const scad = csgProgram(node);
  if (!scad) return null;
  const hash = csgHashOf(node);
  const { compileSCAD } = await import('./openscad');

  // Same retry dance as autoCompileScad: openscad-wasm intermittently returns a
  // valid-but-empty STL, and a clean retry reliably succeeds.
  let compiled: { vertices: number[]; faces: number[]; renderVertices: number[] } | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_COMPILE_ATTEMPTS && !compiled; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 100));
    try {
      const result = await compileSCAD(scad);
      if (result.faces.length === 0) {
        lastErr = new Error('Boolean produced an empty mesh — do the shapes actually overlap?');
        continue;
      }
      compiled = result;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!compiled) throw (lastErr instanceof Error ? lastErr : new Error(String(lastErr)));

  const src = csgSourceGeoms(node);
  const positives = src.filter(isPositive);
  const template = positives[0] || src[0];
  const baseName = node.name || node.id;
  const rgba = template?.rgba ? [...template.rgba] : [0.3, 0.6, 0.9, 1];

  // renderVertices is the Z-up copy — the space the sizes, positions and hole
  // axis all live in, so all measurement and slicing happens there.
  const zup = compiled.renderVertices;
  // The volume centroid doubles as the body origin below, so that a CSG body's
  // origin is its centre of mass — matching every other mesh shape in the app,
  // and what the dynamic-mesh renderer assumes (it draws renderVertices
  // straight at the body frame).
  const { volume, centroid } = meshVolumeAndCentroid(zup, compiled.faces);
  const fullHull = convexHullOf(chunk3(zup));
  const hullVolume = fullHull?.volume ?? 0;

  const requested = node.csgCollision ?? 'auto';
  const totalMass = node.csgMass ?? template?.mass ?? 1;

  const centeredZup = translateFlat(zup, [-centroid[0], -centroid[1], 0]);
  const centeredYup = zupArrayToYup(centeredZup);

  const visual: SceneGeom = {
    name: `${baseName}_csg`,
    type: 'mesh',
    size: [1],
    rgba,
    dynamic: true,
    condim: template?.condim ?? 3,
    ...(template?.friction ? { friction: [...template.friction] } : {}),
    ...(template?.solref ? { solref: [...template.solref] } : {}),
    ...(template?.solimp ? { solimp: [...template.solimp] } : {}),
    vertices: centeredYup,
    faces: compiled.faces,
    renderVertices: centeredZup,
    csgDerived: 'visual',
  };

  if (requested === 'hull') {
    return {
      hash, scad, volume, hullVolume, centroid, mode: 'hull',
      geoms: [{ ...visual, mass: totalMass }],
    };
  }

  let colliders: SceneGeom[] = [];
  let warning: string | undefined;
  let mode: CsgResult['mode'] = 'primitives';

  if (requested === 'auto' || requested === 'decompose') {
    const holeAxis = detectHoleAxis(node);
    if (!holeAxis) {
      warning = requested === 'decompose'
        ? 'No hole axis found (the negative shape is not elongated in any direction) — colliding as the source primitives instead.'
        : undefined;
    } else {
      const sectors = node.csgSectors ?? CSG_DEFAULT_SECTORS;
      // Slice in the SAME centred frame the visual mesh uses, so collider
      // positions are body-frame directly.
      const shiftedOrigin = [
        holeAxis.origin[0] - centroid[0],
        holeAxis.origin[1] - centroid[1],
        holeAxis.origin[2] - centroid[2],
      ];
      const hulls = decomposeAroundAxis(centeredZup, compiled.faces, shiftedOrigin, holeAxis.axis, sectors);
      const totalHullVol = hulls.reduce((s, h) => s + h.volume, 0);
      if (hulls.length >= 3 && totalHullVol > 0) {
        mode = 'decompose';
        colliders = hulls.map((h, i) => {
          // MuJoCo translates every mesh asset so its centre of mass sits at the
          // asset frame's origin, then places that frame at the geom's pos. So
          // pre-centre each sector on its own centroid and hand that centroid
          // back as pos — otherwise MuJoCo's recentring silently stacks every
          // sector on top of the body origin.
          const localZup = translateFlat(h.verts, [-h.centroid[0], -h.centroid[1], -h.centroid[2]]);
          return {
            name: `${baseName}_csg_col${i}`,
            type: 'mesh' as const,
            size: [1],
            pos: [+h.centroid[0].toFixed(6), +h.centroid[1].toFixed(6), +h.centroid[2].toFixed(6)],
            rgba: [...rgba],
            mass: +(totalMass * (h.volume / totalHullVol)).toFixed(8),
            condim: template?.condim ?? 3,
            ...(template?.friction ? { friction: [...template.friction] } : {}),
            ...(template?.solref ? { solref: [...template.solref] } : {}),
            ...(template?.solimp ? { solimp: [...template.solimp] } : {}),
            vertices: zupArrayToYup(localZup),
            faces: h.faces,
            role: 'collision' as const,
            csgDerived: 'collider' as const,
          };
        });
      } else {
        warning = 'Sector decomposition degenerated — colliding as the source primitives instead.';
      }
    }
  }

  if (mode === 'decompose') {
    // Colliders carry the mass; the visual shell must not double-count it.
    return { hash, scad, volume, hullVolume, centroid, mode, warning, geoms: [{ ...visual, role: 'visual', mass: 0 }, ...colliders] };
  }

  // 'primitives': the authored positives stay as the colliders (mjcf.ts keeps
  // them and drops the negatives), and the boolean mesh is visual only.
  return {
    hash, scad, volume, hullVolume, centroid, mode: 'primitives', warning,
    geoms: [{ ...visual, role: 'visual', mass: 0 }],
  };
}

function chunk3(flat: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]]);
  return out;
}

function translateFlat(flat: number[], d: number[]): number[] {
  const out = new Array<number>(flat.length);
  for (let i = 0; i < flat.length; i += 3) {
    out[i] = +(flat[i] + d[0]).toFixed(6);
    out[i + 1] = +(flat[i + 1] + d[1]).toFixed(6);
    out[i + 2] = +(flat[i + 2] + d[2]).toFixed(6);
  }
  return out;
}

function zupArrayToYup(zup: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < zup.length; i += 3) {
    const [x, y, z] = zupToYup([zup[i], zup[i + 1], zup[i + 2]]);
    out.push(x, y, z);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution — shared by the MJCF builder and the renderer
// ---------------------------------------------------------------------------

/**
 * Which of a CSG node's geoms the given consumer should see.
 *
 *   'physics' — negatives never; source positives only when they're the
 *               colliders (mode 'primitives', or the mesh isn't compiled yet);
 *               derived geoms always.
 *   'render'  — the boolean mesh once it exists, else the source positives so
 *               an uncompiled body still shows something. Negatives are never
 *               in this list: they're drawn separately as ghosts, only in the
 *               editor, only for the selected body.
 *
 * A non-CSG node is returned untouched, so every existing scene is unaffected.
 */
export function resolveCsgGeoms(node: SceneNode, target: 'physics' | 'render'): SceneGeom[] {
  const geoms = node.geoms || [];
  // A negative is a hole. It is never a solid — not drawn, not simulated — and
  // that holds whether or not csgEnabled is set. Enforcing it here rather than
  // relying on the flag means a scene that marks a geom 'difference' without the
  // flag (hand-authored JSON, an older save, an agent that forgot it) shows an
  // un-subtracted solid at worst, never a solid lump where the hole should be.
  const solid = geoms.filter(g => g.csg !== 'difference');
  // role is meaningful with or without CSG: a collision-only geom is never
  // drawn, and a visual-only one is still emitted (mjcf.ts zeroes its contact).
  if (!node.csgEnabled) {
    return target === 'render' ? solid.filter(g => g.role !== 'collision') : solid;
  }

  const derived = geoms.filter(g => !!g.csgDerived);
  const source = geoms.filter(g => !g.csgDerived);
  const hasMesh = derived.some(g => g.csgDerived === 'visual');
  const collidingWithPrimitives = !hasMesh || derived.every(g => g.csgDerived !== 'collider');

  const visualSource = source.filter(g => g.role === 'visual');
  if (target === 'render') {
    if (hasMesh) return [...derived.filter(g => g.csgDerived === 'visual'), ...visualSource];
    return [...source.filter(isPositive), ...visualSource];
  }

  const out: SceneGeom[] = [];
  if (collidingWithPrimitives) {
    const positives = source.filter(isPositive);
    // With an explicit total mass, split it across the primitive colliders by
    // volume — their union overlaps, so simply giving each the total (or keeping
    // whatever they were authored with) would make the body heavier than the
    // solid it represents.
    const vols = positives.map(primitiveVolume);
    const totalVol = vols.reduce((s, v) => s + v, 0);
    out.push(...positives.map((g, i) => ({
      ...g,
      role: 'collision' as const,
      ...(node.csgMass !== undefined && totalVol > 0
        ? { mass: +(node.csgMass * (vols[i] / totalVol)).toFixed(8) }
        : {}),
    })));
  }
  out.push(...derived, ...visualSource);
  return out;
}

/**
 * Axis-aligned bounds of a body's POSITIVE source geoms, in body-local Z-up.
 *
 * Used to clip the drawn outline of a negative shape. A negative has to extend
 * beyond the solid it cuts — a flush cut leaves coincident faces, which is how
 * you get non-manifold CSG output — but drawing it at full length is misleading:
 * a cylinder punched through a thin disc renders as a tall tube floating in
 * space, with only a sliver of it doing anything.
 *
 * Returns null if there is nothing positive to bound.
 */
export function geomBounds(g: SceneGeom): { min: number[]; max: number[] } | null {
  const s = g.size || [];
  const r = s[0] ?? 0.1;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  if (g.type === 'mesh') {
    // Mesh vertices are already in the body frame; only an explicit pos shifts them.
    const v = g.renderVertices;
    if (!v || v.length === 0) return null;
    const off = g.pos || [0, 0, 0];
    for (let i = 0; i < v.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const c = v[i + a] + (off[a] || 0);
        if (c < min[a]) min[a] = c;
        if (c > max[a]) max[a] = c;
      }
    }
    return { min, max };
  }

  let half: number[];
  switch (g.type) {
    case 'sphere': half = [r, r, r]; break;
    case 'box':
    case 'ellipsoid': half = [r, s[1] ?? r, s[2] ?? r]; break;
    case 'cylinder': half = [r, r, s[1] ?? r]; break;
    case 'capsule': half = [r, r, (s[1] ?? r) + r]; break;
    default: return null; // a plane has no bounds worth taking
  }
  // Transform the local box's corners, so a rotated geom bounds correctly.
  const m = geomMatrix(g);
  if (g.fromto && g.fromto.length >= 6 && (g.type === 'cylinder' || g.type === 'capsule')) {
    const f = fromtoFrame(g.fromto);
    half = [r, r, f.halfLen + (g.type === 'capsule' ? r : 0)];
    m.copy(f.matrix);
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = new THREE.Vector3(sx * half[0], sy * half[1], sz * half[2]).applyMatrix4(m);
    const c = [p.x, p.y, p.z];
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  }
  return { min, max };
}

export function positiveBounds(node: SceneNode): { min: number[]; max: number[] } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  const csgOff = node.csgCentroid || [0, 0, 0];
  for (const g of csgSourceGeoms(node)) {
    if (!isPositive(g)) continue;
    const b = geomBounds(g);
    if (!b) continue;
    for (let a = 0; a < 3; a++) {
      const bMin = b.min[a] - (csgOff[a] || 0);
      const bMax = b.max[a] - (csgOff[a] || 0);
      if (bMin < min[a]) min[a] = bMin;
      if (bMax > max[a]) max[a] = bMax;
    }
    any = true;
  }
  return any ? { min, max } : null;
}

/**
 * Clips a flat list of line SEGMENTS (x0,y0,z0, x1,y1,z1, ... two points per
 * segment) against an axis-aligned box, dropping the parts outside it. Standard
 * slab method; segments entirely outside vanish, straddling ones are shortened.
 *
 * The box is an over-approximation of the solid, so a little outline can still
 * fall outside a curved surface near the box's corners. For the ordinary case —
 * a negative narrower than its host, punched straight through — the overshoot is
 * purely along the hole axis and this clips it exactly.
 */
export function clipSegmentsToBox(
  segments: ArrayLike<number>,
  min: number[],
  max: number[],
  padding = 0
): number[] {
  const out: number[] = [];
  const lo = [min[0] - padding, min[1] - padding, min[2] - padding];
  const hi = [max[0] + padding, max[1] + padding, max[2] + padding];

  for (let i = 0; i + 5 < segments.length; i += 6) {
    const p = [segments[i], segments[i + 1], segments[i + 2]];
    const q = [segments[i + 3], segments[i + 4], segments[i + 5]];
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    let t0 = 0, t1 = 1, keep = true;

    for (let a = 0; a < 3 && keep; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        // Parallel to this slab: in or out wholesale.
        if (p[a] < lo[a] || p[a] > hi[a]) keep = false;
        continue;
      }
      let tA = (lo[a] - p[a]) / d[a];
      let tB = (hi[a] - p[a]) / d[a];
      if (tA > tB) { const tmp = tA; tA = tB; tB = tmp; }
      if (tA > t0) t0 = tA;
      if (tB < t1) t1 = tB;
      if (t0 > t1) keep = false;
    }
    if (!keep || t1 - t0 < 1e-9) continue;

    out.push(
      p[0] + d[0] * t0, p[1] + d[1] * t0, p[2] + d[2] * t0,
      p[0] + d[0] * t1, p[1] + d[1] * t1, p[2] + d[2] * t1,
    );
  }
  return out;
}

/** Analytic volume of a primitive geom, for splitting mass across colliders. */
export function primitiveVolume(g: SceneGeom): number {
  const s = g.size || [];
  const r = s[0] ?? 0.1;
  switch (g.type) {
    case 'sphere': return (4 / 3) * Math.PI * r ** 3;
    case 'box': return 8 * r * (s[1] ?? r) * (s[2] ?? r);
    case 'ellipsoid': return (4 / 3) * Math.PI * r * (s[1] ?? r) * (s[2] ?? r);
    case 'cylinder': {
      const hl = g.fromto && g.fromto.length >= 6 ? fromtoFrame(g.fromto).halfLen : (s[1] ?? r);
      return Math.PI * r * r * 2 * hl;
    }
    case 'capsule': {
      const hl = g.fromto && g.fromto.length >= 6 ? fromtoFrame(g.fromto).halfLen : (s[1] ?? r);
      return Math.PI * r * r * 2 * hl + (4 / 3) * Math.PI * r ** 3;
    }
    case 'mesh': {
      if (!g.faces) return 0;
      const v = g.renderVertices ?? g.vertices;
      return v ? meshVolumeAndCentroid(v, g.faces).volume : 0;
    }
    default: return 0;
  }
}
