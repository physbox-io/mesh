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
export function fromtoFrame(fromto: number[]): { matrix: THREE.Matrix4; halfLen: number } {
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

/**
 * The program with its mesh literals stood down to a one-line note.
 *
 * A lattice body's polyhedron runs to tens of thousands of numbers. It has to
 * be in the source that goes to OpenSCAD, and it must not be in the source that
 * goes on the node: that string is shown in the inspector, kept in undo history
 * and written into every save of the document. The interesting half of the
 * program — what is being cut out of what — is the half that survives here.
 */
export function scadForDisplay(scad: string): string {
  return scad.replace(
    /polyhedron\(points=\[([\s\S]*?)\], faces=\[([\s\S]*?)\], convexity=4\);/g,
    (_match, points: string, faces: string) => {
      const count = (text: string) => (text.match(/\[/g) || []).length;
      return `polyhedron(/* the modelled mesh: ${count(points)} points, ${count(faces)} triangles */);`;
    },
  );
}
// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------
//
// A cut is an ordinary negative primitive. What makes it worth a section of its
// own is that the numbers a person means are not the numbers a primitive is
// made of: "6 mm across, 10 mm into that face" becomes a 12 mm cylinder centred
// 16 mm up and turned to match, and nobody should be doing that conversion in
// their head.
//
// A cut is therefore stated as three things:
//
//   cutNormal — the OUTWARD direction of the surface it enters. Any direction,
//               not one of six. A lattice vertex is three integers, but a face
//               joining any three of them can point anywhere, and a bevelled or
//               smoothed or imported surface certainly does. Snapping that to
//               the nearest axis gives a hole that is not perpendicular to the
//               face it was asked for, quietly.
//   cutAt     — the point on that surface the hole is centred on.
//   cutDepth  — how far into the material, from there. 0 goes right through.
//
// Everything the primitive is actually made of — position, length, orientation
// — is derived from those by cutGeometry, and re-derived whenever the part
// changes by reconcileCuts.
//
// The millimetre or two the cutter is longer than the hole is not an optional
// nicety. A negative that stops exactly flush with the surface leaves two
// coincident faces, and a boolean of two coincident faces is not reliably a
// solid — it is the classic way to get a mesh with its hole in the wrong sense.
// So the cutter always breaks out past the surface, and the depth still
// measures from the surface, because that is the depth of the hole.

/** Where a ray met a surface: how far along it, and which way that surface faces. */
export interface SurfaceHit {
  /** Distance along the ray's direction vector. */
  t: number;
  /** Outward unit normal in the body frame. */
  normal: number[];
}

/** A place a cut can go: a point on the part, and the way the part faces there. */
export interface CutSpot {
  at: number[];
  normal: number[];
}

/**
 * How far a cutter pokes out past the surface it enters.
 *
 * A proportion of the part, with a floor a long way under it. 2% of a 40 mm
 * block is over a millimetre: far more than any tolerance needs, and still
 * small enough that the red outline reads as belonging to the part rather than
 * skewering it. A fixed distance cannot do both jobs — a millimetre is
 * invisible on a 2 m beam and half the model on a 2 mm one — and the floor is
 * only there so that something microscopic still gets a gap it cannot round
 * away.
 *
 * Measured on the part's diagonal rather than on one axis, because a cut no
 * longer runs along an axis and the overshoot should not change when you turn
 * the hole.
 */
function cutOvershoot(node: SceneNode): number {
  const bounds = sourcePositiveBounds(node);
  if (!bounds) return 0.001;
  const diagonal = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  return Math.max(0.0001, diagonal * 0.02);
}

// ---------------------------------------------------------------------------
// Where the surface actually is
// ---------------------------------------------------------------------------
//
// A cut's depth has to be measured from the material, not from a bounding box.
// The two are the same on a cube and nowhere else: on a dome the box only
// touches at the pole, so a hole off to one side would come out shallower than
// the number typed; on an L-bracket the box's lid is the top of the TALL arm,
// and a hole over the low arm would be measured from a plane hanging in the air
// above it — if the step were deeper than the hole, the cutter would never
// reach the material and the hole would silently not happen.
//
// So the surface is found by casting a ray and taking the first thing it meets.
// Under the middle of the hole, which is the rule a person would state: a
// counterbore on a slope is measured at its centre.

/** Möller–Trumbore, returning the ray parameter or null. */
function rayTriangle(
  origin: THREE.Vector3, dir: THREE.Vector3,
  a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
): number | null {
  const e1 = b.clone().sub(a);
  const e2 = c.clone().sub(a);
  const p = dir.clone().cross(e2);
  const det = e1.dot(p);
  if (Math.abs(det) < 1e-12) return null;   // parallel to the triangle
  const inv = 1 / det;
  const t0 = origin.clone().sub(a);
  const u = t0.dot(p) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = t0.cross(e1);
  const v = dir.dot(q) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = e2.dot(q) * inv;
  return t >= 0 ? t : null;
}

/** Roots of at² + bt + c, in order, ignoring the imaginary ones. */
function quadratic(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-15) return Math.abs(b) < 1e-15 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

/**
 * Every point a ray enters or leaves one geom, with the surface normal there.
 *
 * Analytic rather than tessellated: a sphere approximated by triangles would
 * report a depth and a normal that depend on how finely it happened to be
 * divided, and the error would be worst exactly where a hole usually goes — the
 * top of a dome. Meshes are the one case with no closed form, and there the
 * triangles ARE the surface, so intersecting them is exact.
 */
function geomRayHits(geom: SceneGeom, origin: THREE.Vector3, dir: THREE.Vector3): SurfaceHit[] {
  const s = geom.size || [];
  const hits: SurfaceHit[] = [];

  if (geom.type === 'mesh') {
    const verts = geom.renderVertices;
    if (!verts || !geom.faces) return hits;
    const off = geom.pos || [0, 0, 0];
    const at = (i: number) => new THREE.Vector3(
      verts[i * 3] + (off[0] || 0), verts[i * 3 + 1] + (off[1] || 0), verts[i * 3 + 2] + (off[2] || 0),
    );
    for (let f = 0; f < geom.faces.length; f += 3) {
      const a = at(geom.faces[f]);
      const b = at(geom.faces[f + 1]);
      const c = at(geom.faces[f + 2]);
      const t = rayTriangle(origin, dir, a, b, c);
      if (t === null) continue;
      // Wound counter-clockwise seen from outside, so this points out.
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-24) continue;
      hits.push({ t, normal: n.normalize().toArray() });
    }
    return hits;
  }

  // Everything else is solved in the geom's own frame, where it is centred and
  // axis-aligned. The frame is rigid, so a ray parameter means the same thing
  // in both — no rescaling on the way back out — and a normal only needs
  // turning, not moving.
  let matrix = geomMatrix(geom);
  let halfLen = s[1] ?? s[0] ?? 0.1;
  if ((geom.type === 'cylinder' || geom.type === 'capsule') && geom.fromto && geom.fromto.length >= 6) {
    const f = fromtoFrame(geom.fromto);
    matrix = f.matrix;
    halfLen = f.halfLen;
  }
  const inverse = matrix.clone().invert();
  const o = origin.clone().applyMatrix4(inverse);
  const d = dir.clone().transformDirection(inverse);

  const rotation = new THREE.Matrix3().setFromMatrix4(matrix);
  const local: { t: number; normal: THREE.Vector3 }[] = [];
  const at = (t: number) => new THREE.Vector3(o.x + t * d.x, o.y + t * d.y, o.z + t * d.z);
  const withinZ = (t: number, h: number) => Math.abs(o.z + t * d.z) <= h + 1e-9;

  switch (geom.type) {
    case 'box': {
      // Slabs. A ray parallel to a slab either misses it or is inside it for
      // the whole of its length, which is what the degenerate branch says.
      const half = [s[0] ?? 0.1, s[1] ?? s[0] ?? 0.1, s[2] ?? s[0] ?? 0.1];
      const oa = [o.x, o.y, o.z];
      const da = [d.x, d.y, d.z];
      let near = -Infinity;
      let far = Infinity;
      let nearAxis = 0;
      let farAxis = 0;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(da[a]) < 1e-12) {
          if (Math.abs(oa[a]) > half[a]) return hits;
          continue;
        }
        const t1 = (-half[a] - oa[a]) / da[a];
        const t2 = (half[a] - oa[a]) / da[a];
        if (Math.min(t1, t2) > near) { near = Math.min(t1, t2); nearAxis = a; }
        if (Math.max(t1, t2) < far) { far = Math.max(t1, t2); farAxis = a; }
      }
      if (near > far) break;
      // The face a slab boundary belongs to is the one the ray is heading away
      // from on entry, and towards on exit.
      const faceNormal = (axis: number, sign: number) => {
        const n = new THREE.Vector3();
        n.setComponent(axis, sign);
        return n;
      };
      local.push({ t: near, normal: faceNormal(nearAxis, -Math.sign(da[nearAxis] || 1)) });
      local.push({ t: far, normal: faceNormal(farAxis, Math.sign(da[farAxis] || 1)) });
      break;
    }
    case 'sphere': {
      const r = s[0] ?? 0.1;
      for (const t of quadratic(d.lengthSq(), 2 * o.dot(d), o.lengthSq() - r * r)) {
        local.push({ t, normal: at(t).normalize() });
      }
      break;
    }
    case 'ellipsoid': {
      // Squashed onto the unit sphere. Scaling origin and direction by the same
      // factors leaves the ray parameter alone, so the roots need no undoing —
      // but the normal does, and it is the gradient rather than the point.
      const r = [s[0] ?? 0.1, s[1] ?? s[0] ?? 0.1, s[2] ?? s[0] ?? 0.1];
      const oe = new THREE.Vector3(o.x / r[0], o.y / r[1], o.z / r[2]);
      const de = new THREE.Vector3(d.x / r[0], d.y / r[1], d.z / r[2]);
      for (const t of quadratic(de.lengthSq(), 2 * oe.dot(de), oe.lengthSq() - 1)) {
        const p = at(t);
        local.push({
          t,
          normal: new THREE.Vector3(p.x / (r[0] * r[0]), p.y / (r[1] * r[1]), p.z / (r[2] * r[2])).normalize(),
        });
      }
      break;
    }
    case 'cylinder':
    case 'capsule': {
      const r = s[0] ?? (geom.type === 'capsule' ? 0.05 : 0.1);
      for (const t of quadratic(
        d.x * d.x + d.y * d.y,
        2 * (o.x * d.x + o.y * d.y),
        o.x * o.x + o.y * o.y - r * r,
      )) {
        if (!withinZ(t, halfLen)) continue;
        const p = at(t);
        local.push({ t, normal: new THREE.Vector3(p.x, p.y, 0).normalize() });
      }
      if (geom.type === 'cylinder') {
        // The flat ends, which is how a ray straight down the axis hits at all.
        for (const end of [-halfLen, halfLen]) {
          if (Math.abs(d.z) < 1e-12) continue;
          const t = (end - o.z) / d.z;
          const p = at(t);
          if (p.x * p.x + p.y * p.y <= r * r + 1e-12) {
            local.push({ t, normal: new THREE.Vector3(0, 0, Math.sign(end) || 1) });
          }
        }
      } else {
        // The rounded ends are whole spheres; only the half beyond the barrel
        // is really surface, which is what the z test keeps.
        for (const end of [-halfLen, halfLen]) {
          const centre = new THREE.Vector3(0, 0, end);
          const oc = o.clone().sub(centre);
          for (const t of quadratic(d.lengthSq(), 2 * oc.dot(d), oc.lengthSq() - r * r)) {
            const p = at(t);
            if ((end > 0 && p.z >= end - 1e-9) || (end < 0 && p.z <= end + 1e-9)) {
              local.push({ t, normal: p.clone().sub(centre).normalize() });
            }
          }
        }
      }
      break;
    }
    default:
      break; // a plane has no inside to enter
  }

  for (const hit of local) {
    if (hit.t < 0) continue;
    hits.push({ t: hit.t, normal: hit.normal.applyMatrix3(rotation).normalize().toArray() });
  }
  return hits;
}

/**
 * Every surface of a body's positive shapes that a ray meets, nearest first.
 *
 * Coordinates are the body's own frame — the frame a geom's `pos` is written
 * in — so a caller has only to say where the ray starts and which way it goes.
 */
export function probeRay(node: SceneNode, origin: number[], direction: number[]): SurfaceHit[] {
  const o = new THREE.Vector3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  const d = new THREE.Vector3(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0);
  if (d.lengthSq() < 1e-18) return [];
  d.normalize();
  const hits: SurfaceHit[] = [];
  for (const geom of csgSourceGeoms(node)) {
    if (!isPositive(geom)) continue;
    hits.push(...geomRayHits(geom, o, d));
  }
  return hits.sort((a, b) => a.t - b.t);
}

/** How far outside a body a ray has to start to be certain it starts outside. */
function clearOf(node: SceneNode): number {
  const bounds = sourcePositiveBounds(node);
  if (!bounds) return 1;
  return Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ) + 1;
}

/**
 * The spot a ray from outside lands on: where it meets the part, and which way
 * the part faces there.
 *
 * This is what a click on a body, or a look down the camera, turns into. The
 * normal is forced to face the ray, because a mesh whose winding disagrees with
 * its neighbours — which the lattice editor draws in red precisely because it
 * happens — would otherwise hand back an inward normal and put the hole on the
 * wrong side of the surface.
 */
export function pickCutSpot(node: SceneNode, origin: number[], direction: number[]): CutSpot | null {
  const hits = probeRay(node, origin, direction);
  if (hits.length === 0) return null;
  const d = new THREE.Vector3(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0).normalize();
  const first = hits[0];
  const at = [
    (origin[0] ?? 0) + d.x * first.t,
    (origin[1] ?? 0) + d.y * first.t,
    (origin[2] ?? 0) + d.z * first.t,
  ];
  const normal = new THREE.Vector3(first.normal[0], first.normal[1], first.normal[2]);
  if (normal.dot(d) > 0) normal.negate();
  return { at, normal: normal.toArray() };
}

/**
 * Where a cut's own line meets the part, and how much material is under it.
 *
 * The ray is the cut's line: it starts well outside along the stored normal and
 * travels back down it, so a hole re-measures itself against whatever is under
 * it now. `thickness` is from the first surface to the last, which is what a
 * hole going right through has to clear.
 *
 * Returns null when the line misses the part altogether — a hole hanging off
 * the edge — and the caller keeps whatever the cut had.
 */
export function surfaceUnder(
  node: SceneNode,
  at: number[],
  normal: number[],
): { entry: number[]; thickness: number } | null {
  const n = new THREE.Vector3(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 1);
  if (n.lengthSq() < 1e-18) return null;
  n.normalize();
  const away = clearOf(node);
  const origin = [
    (at[0] ?? 0) + n.x * away,
    (at[1] ?? 0) + n.y * away,
    (at[2] ?? 0) + n.z * away,
  ];
  const hits = probeRay(node, origin, [-n.x, -n.y, -n.z]);
  if (hits.length === 0) return null;
  const first = hits[0].t;
  const last = hits[hits.length - 1].t;
  return {
    entry: [origin[0] - n.x * first, origin[1] - n.y * first, origin[2] - n.z * first],
    thickness: Math.max(0, last - first),
  };
}

/**
 * `pos`, `size` and `quat` for a cut, from where it enters and how deep it goes.
 *
 * The cross-section comes from the geom's own `size`, so resizing a hole is an
 * ordinary size edit; the length, the place along the cut's line and the turn
 * onto it are what is worked out here.
 */
export function cutGeometry(
  node: SceneNode,
  geom: SceneGeom,
): { pos: number[]; size: number[]; quat: number[] } | null {
  const normal = geom.cutNormal ?? [0, 0, 1];
  const n = new THREE.Vector3(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 1);
  if (n.lengthSq() < 1e-18) return null;
  n.normalize();

  const under = surfaceUnder(node, geom.cutAt ?? [0, 0, 0], n.toArray());
  const entry = new THREE.Vector3(...(under ? under.entry : (geom.cutAt ?? [0, 0, 0])));
  const s = geom.size || [];
  const over = cutOvershoot(node);

  // A shape's own +Z turned onto the cut's line. Every solid here is a body of
  // revolution about that axis or a box, so one rotation orients all of them.
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const mjQuat = [quat.w, quat.x, quat.y, quat.z].map(v => +v.toFixed(9));

  if (geom.type === 'sphere') {
    // A scoop, not a bore: a sphere has no length to run, so it is always
    // blind. Its deepest point sits at the depth asked for, which puts its
    // centre most of a radius short of that.
    const r = Math.max(1e-6, s[0] ?? 0.005);
    // Deeper than its own diameter is a hole that has left the ball behind: the
    // sphere would stop short of the surface and cut a bubble inside the part.
    const depth = Math.min(Math.max(geom.cutDepth || r, 1e-6), 2 * r);
    const centre = entry.clone().addScaledVector(n, r - depth);
    return { pos: centre.toArray().map(v => +v.toFixed(6)), size: [r], quat: mjQuat };
  }

  // Through, or in by the depth asked for. Through is measured from the surface
  // to the far side of the part and then some, so both ends are clear of it
  // however thick the part turned out to be.
  const through = !(geom.cutDepth && geom.cutDepth > 0);
  const reach = through ? (under?.thickness ?? 0) + over : geom.cutDepth!;
  const length = reach + over;
  const centre = entry.clone().addScaledVector(n, (over - reach) / 2);
  const pos = centre.toArray().map(v => +v.toFixed(6));

  if (geom.type === 'box') {
    // The two cross-section numbers are the slot's own width and breadth, in
    // its own frame — they turn with it rather than staying world X and Y.
    return { pos, size: [s[0] ?? 0.005, s[1] ?? 0.005, length / 2], quat: mjQuat };
  }
  return { pos, size: [s[0] ?? 0.005, length / 2], quat: mjQuat };
}

/**
 * The depth a cut is set to, in metres, as the panel should show it — the
 * length of the hole, never the length of the cutter.
 */
export function cutDepthOf(node: SceneNode, geom: SceneGeom): number {
  if (geom.cutDepth && geom.cutDepth > 0) return geom.cutDepth;
  const under = surfaceUnder(node, geom.cutAt ?? [0, 0, 0], geom.cutNormal ?? [0, 0, 1]);
  return under ? under.thickness : 0;
}

/**
 * Brings a body's cuts back into agreement with the part they cut into.
 *
 * "10 mm into that face" has to go on meaning that after the face moves, or it
 * was never a statement about the part — only a way of arriving at a number
 * once. Push the top of a block up by 20 mm and an unreconciled cut stays where
 * it was in space, which is no longer a hole at all: it is a sealed void 20 mm
 * under the surface, and nothing in the viewport shows it.
 *
 * Only cuts that carry a direction are touched. A negative authored by hand — a
 * preset, an older scene, an agent placing a shape by coordinates — has no such
 * intent to honour, and its numbers are left exactly alone.
 *
 * Returns whether anything moved, so a caller can skip a recompile.
 */
export function reconcileCuts(node: SceneNode): boolean {
  const cuts = (node.geoms || []).filter(g => g.csg === 'difference' && !g.csgDerived && g.cutNormal);
  if (cuts.length === 0) return false;

  let changed = false;
  for (const geom of cuts) {
    const next = cutGeometry(node, geom);
    if (!next) continue;
    // The anchor follows the surface too, so the next reconcile measures from
    // where the material is now rather than from where it used to be.
    const under = surfaceUnder(node, geom.cutAt ?? [0, 0, 0], geom.cutNormal!);
    if (under) geom.cutAt = under.entry.map(v => +v.toFixed(6));

    const samePos = (geom.pos || []).length === 3
      && next.pos.every((v, a) => Math.abs(v - (geom.pos![a] ?? 0)) < 1e-9);
    const sameSize = (geom.size || []).length === next.size.length
      && next.size.every((v, i) => Math.abs(v - (geom.size![i] ?? 0)) < 1e-9);
    const sameQuat = (geom.quat || []).length === 4
      && next.quat.every((v, i) => Math.abs(v - (geom.quat![i] ?? 0)) < 1e-9);
    if (samePos && sameSize && sameQuat) continue;
    Object.assign(geom, next);
    changed = true;
  }
  return changed;
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
  let hull: ConvexHull;
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

  for (const face of hull.faces) {
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

/**
 * True if this geom would emit a solid into the program at all. Planes have no
 * volume, and a mesh with no faces yet — a lattice body whose cage is still
 * empty — has nothing to emit either.
 */
function emitsSolid(g: SceneGeom): boolean {
  if (g.type === 'plane') return false;
  if (g.type === 'mesh') {
    const v = g.renderVertices ?? g.vertices;
    return !!v && v.length > 0 && !!g.faces && g.faces.length > 0;
  }
  return true;
}

/**
 * A geom's contribution to the boolean's fingerprint.
 *
 * Everything `primitiveToScad` reads, and nothing else. A mesh is summarized by
 * a numeric checksum rather than by its vertices: this runs on EVERY store
 * update for every boolean body, and a lattice mesh is tens of thousands of
 * numbers — serializing them would build a megabyte of string per keystroke to
 * throw it away again.
 */
function geomCsgKey(g: SceneGeom): unknown[] {
  const shape = g.type === 'mesh' ? meshChecksum(g) : g.size;
  return [g.type, shape, g.pos, g.quat, g.euler, g.fromto, g.csg ?? 'union', g.role ?? null];
}

function meshChecksum(g: SceneGeom): string {
  const v = g.renderVertices ?? g.vertices ?? [];
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    // Rounded to the micron the emitter prints at, so a change too small to
    // reach the .scad source cannot invalidate the mesh that was built from it.
    h ^= Math.round(v[i] * 1e6) | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${v.length}:${g.faces?.length ?? 0}:${h.toString(16)}`;
}

// Cheap, stable fingerprint of everything the derived geoms depend on. When
// this matches node.csgHash the mesh on the node is already correct.
export function csgHashOf(node: SceneNode): string {
  if (!hasBooleanOps(node)) return '';
  const src = csgSourceGeoms(node);
  if (!src.filter(isPositive).some(emitsSolid)) return '';
  const key = JSON.stringify([
    src.filter(emitsSolid).map(geomCsgKey),
    node.csgFn ?? CSG_DEFAULT_FN,
    node.csgCollision ?? 'auto',
    node.csgSectors ?? CSG_DEFAULT_SECTORS,
    node.csgHoleAxis ?? 'auto',
    node.csgMass ?? null,
    src.filter(isPositive).map(g => [g.rgba, g.mass, g.friction, g.condim, g.solref, g.solimp]),
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

/**
 * How far the compiled body frame is shifted from the source primitives' frame.
 *
 * evaluateNodeCsg re-origins a compiled solid on its centre of mass, but only in
 * X and Y — Z is left alone so a body keeps sitting where it was modelled.
 * Anything drawn in the source frame (ghost outlines, bounds) has to apply the
 * same partial shift; subtracting the full centroid drops it by the solid's
 * height, which is invisible for a shape modelled about the origin and glaring
 * for one modelled from the ground up.
 */
export function csgFrameOffset(node: SceneNode): number[] {
  const c = node.csgCentroid || [0, 0, 0];
  return [c[0] || 0, c[1] || 0, 0];
}

/**
 * Bounds of a body's positive source geoms, in the frame those geoms are
 * AUTHORED in — before the compiled solid is re-origined on its centre of mass.
 *
 * This is the frame a negative's `pos` is written in, so it is the one a cut is
 * worked out in. `positiveBounds` below is the same box moved into the compiled
 * frame, which is what anything drawn alongside the compiled mesh wants.
 */
export function sourcePositiveBounds(node: SceneNode): { min: number[]; max: number[] } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const g of csgSourceGeoms(node)) {
    if (!isPositive(g)) continue;
    const b = geomBounds(g);
    if (!b) continue;
    for (let a = 0; a < 3; a++) {
      if (b.min[a] < min[a]) min[a] = b.min[a];
      if (b.max[a] > max[a]) max[a] = b.max[a];
    }
    any = true;
  }
  return any ? { min, max } : null;
}

export function positiveBounds(node: SceneNode): { min: number[]; max: number[] } | null {
  const source = sourcePositiveBounds(node);
  if (!source) return null;
  const csgOff = csgFrameOffset(node);
  return {
    min: source.min.map((v, a) => v - (csgOff[a] || 0)),
    max: source.max.map((v, a) => v - (csgOff[a] || 0)),
  };
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
