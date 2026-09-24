// Giving a primitive enough surface to show a dent.
//
// A dent is a displacement of vertices, and a MuJoCo primitive has none: a box
// is six numbers and a sphere is one, evaluated analytically by the solver and
// by the renderer alike. There is nothing there to push in. So a body that is
// to be dented needs a real mesh — and rather than make that the user's
// problem, turning denting on converts the shape into the mesh it already
// looked like.
//
// Two things decide the tessellation, and neither is "as fine as possible":
//
//   * The dent brush has a radius. A grid coarser than that radius cannot hold
//     a crater — the displacement lands on two or three vertices and reads as a
//     crease rather than a dish.
//   * Every vertex is XML in the compiled model and a float in the render
//     buffer, on every rebuild. A 200x200 plate is forty thousand vertices of
//     text for a dent nobody can see the extra resolution of.
//
// So these are sized in absolute terms — a target edge length — rather than by
// a fixed subdivision count, which keeps a 20 mm boss and a 2 m floor panel
// equally dentable without either of them being absurd.

import type { SceneGeom } from '../types/scene';

/**
 * Roughly the edge length to aim for, in metres, as a fraction of the shape's
 * smallest useful dimension. A dent radius defaults to about a sixth of the
 * shape, so this puts five or six vertices across the brush.
 */
const TARGET_DIVISIONS = 24;
/** Below this a surface cannot show a dish, whatever its size. */
const MIN_DIVISIONS = 8;
/** Above this the vertex count starts costing more than the dent is worth. */
const MAX_DIVISIONS = 48;


/**
 * Point every triangle outward.
 *
 * All three shapes here are convex and centred on their own origin, so "which
 * way is out" is decided by a dot product rather than by reasoning about the
 * winding of six faces in six different orientations — which is what the first
 * version of the box tried to do, and got wrong on two of them. A backwards
 * triangle is not drawn at all under single-sided rendering, so the failure
 * shows up as a half-transparent shape rather than as a hole.
 */
function orientOutward(vertices: number[], faces: number[]): void {
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
    const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (vertices[a] + vertices[b] + vertices[c]) / 3;
    const my = (vertices[a + 1] + vertices[b + 1] + vertices[c + 1]) / 3;
    const mz = (vertices[a + 2] + vertices[b + 2] + vertices[c + 2]) / 3;
    if (nx * mx + ny * my + nz * mz < 0) {
      const t = faces[f + 1];
      faces[f + 1] = faces[f + 2];
      faces[f + 2] = t;
    }
  }
}

export interface DentMesh {
  vertices: number[];
  faces: number[];
}

const divisions = (span: number, reference: number): number => {
  if (!(reference > 0)) return MIN_DIVISIONS;
  const n = Math.round(TARGET_DIVISIONS * (span / reference));
  return Math.max(MIN_DIVISIONS, Math.min(MAX_DIVISIONS, n));
};

/**
 * A closed, gridded box. Y-up, centred on its own origin.
 *
 * Every face is subdivided, not just the top: which face gets hit is not known
 * in advance, and a box with one detailed face and five flat ones dents on one
 * side and creases on the others.
 */
export function boxMeshForDenting(hx: number, hy: number, hz: number): DentMesh {
  const longest = Math.max(hx, hy, hz);
  const nx = divisions(hx, longest), ny = divisions(hy, longest), nz = divisions(hz, longest);
  const vertices: number[] = [];
  const faces: number[] = [];
  const index = new Map<string, number>();

  // Shared corner and edge vertices, so the box comes out watertight rather
  // than as six separate sheets that a dent would tear apart at the seams.
  const vertexAt = (x: number, y: number, z: number): number => {
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = vertices.length / 3;
      vertices.push(x, y, z);
      index.set(key, i);
    }
    return i;
  };

  const face = (
    origin: [number, number, number],
    u: [number, number, number], nu: number,
    v: [number, number, number], nv: number,
  ) => {
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const p = (a: number, b: number) => vertexAt(
          origin[0] + u[0] * (a / nu) + v[0] * (b / nv),
          origin[1] + u[1] * (a / nu) + v[1] * (b / nv),
          origin[2] + u[2] * (a / nu) + v[2] * (b / nv),
        );
        const a = p(i, j), b = p(i + 1, j), c = p(i, j + 1), d = p(i + 1, j + 1);
        faces.push(a, c, b);
        faces.push(b, c, d);
      }
    }
  };

  const X = 2 * hx, Y = 2 * hy, Z = 2 * hz;
  face([-hx, hy, -hz], [X, 0, 0], nx, [0, 0, Z], nz);     // top    (+Y)
  face([-hx, -hy, -hz], [0, 0, Z], nz, [X, 0, 0], nx);    // bottom (-Y)
  face([-hx, -hy, hz], [X, 0, 0], nx, [0, Y, 0], ny);     // front  (+Z)
  face([-hx, -hy, -hz], [0, Y, 0], ny, [X, 0, 0], nx);    // back   (-Z)
  face([hx, -hy, -hz], [0, 0, Z], nz, [0, Y, 0], ny);     // right  (+X)
  face([-hx, -hy, -hz], [0, Y, 0], ny, [0, 0, Z], nz);    // left   (-X)
  orientOutward(vertices, faces);
  return { vertices, faces };
}

/** A closed cylinder about Y, centred on its own origin. */
export function cylinderMeshForDenting(radius: number, halfHeight: number): DentMesh {
  const radial = Math.max(12, Math.min(MAX_DIVISIONS, divisions(radius, radius)));
  const axial = divisions(halfHeight, radius);
  const vertices: number[] = [];
  const faces: number[] = [];
  const ring: number[][] = [];
  for (let i = 0; i <= axial; i++) {
    ring[i] = [];
    const y = -halfHeight + (2 * halfHeight * i) / axial;
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      ring[i][j] = vertices.length / 3;
      vertices.push(radius * Math.cos(th), y, radius * Math.sin(th));
    }
  }
  const wrap = (j: number) => (j + 1) % radial;
  for (let i = 0; i < axial; i++) {
    for (let j = 0; j < radial; j++) {
      const a = ring[i][j], b = ring[i][wrap(j)], c = ring[i + 1][j], d = ring[i + 1][wrap(j)];
      faces.push(a, c, b);
      faces.push(b, c, d);
    }
  }
  const bottomC = vertices.length / 3; vertices.push(0, -halfHeight, 0);
  const topC = vertices.length / 3; vertices.push(0, halfHeight, 0);
  for (let j = 0; j < radial; j++) {
    faces.push(bottomC, ring[0][j], ring[0][wrap(j)]);
    faces.push(topC, ring[axial][wrap(j)], ring[axial][j]);
  }
  orientOutward(vertices, faces);
  return { vertices, faces };
}

/** A UV sphere or ellipsoid, centred on its own origin. */
export function ellipsoidMeshForDenting(rx: number, ry: number, rz: number): DentMesh {
  const biggest = Math.max(rx, ry, rz);
  const seg = Math.max(12, Math.min(MAX_DIVISIONS, divisions(biggest, biggest)));
  const rings = Math.max(6, Math.round(seg / 2));
  const vertices: number[] = [];
  const faces: number[] = [];
  const grid: number[][] = [];
  for (let i = 1; i < rings; i++) {
    grid[i] = [];
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      grid[i][j] = vertices.length / 3;
      vertices.push(
        rx * Math.sin(phi) * Math.cos(th),
        ry * Math.cos(phi),
        rz * Math.sin(phi) * Math.sin(th),
      );
    }
  }
  const north = vertices.length / 3; vertices.push(0, ry, 0);
  const south = vertices.length / 3; vertices.push(0, -ry, 0);
  const wrap = (j: number) => (j + 1) % seg;
  for (let j = 0; j < seg; j++) {
    faces.push(north, grid[1][j], grid[1][wrap(j)]);
    faces.push(south, grid[rings - 1][wrap(j)], grid[rings - 1][j]);
  }
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = grid[i][j], b = grid[i][wrap(j)], c = grid[i + 1][j], d = grid[i + 1][wrap(j)];
      faces.push(a, c, b);
      faces.push(b, c, d);
    }
  }
  orientOutward(vertices, faces);
  return { vertices, faces };
}

/**
 * The mesh a primitive has to become before it can be dented, or null if it
 * already is one (or is a plane, which is scenery and has no surface to speak
 * of — it is infinite in the solver).
 *
 * A capsule is treated as a cylinder of the same radius and length. The
 * rounded ends are lost, which is visible on a stubby one and invisible on a
 * long one; the alternative is a special case for a shape nobody reaches for
 * when they want something they can dent.
 */
/**
 * Lay a mesh that was built along +Y down the axis a `fromto` describes, and
 * move it onto that axis.
 *
 * `fromto` is how MuJoCo writes a capsule or cylinder that does not run along
 * its own Z: the two end points, in the body frame, Z-up. The builders above
 * know nothing about that — they produce a shape centred on the origin running
 * along Three's +Y — so without this a `fromto` capsule converts to a mesh
 * standing upright at the body origin. That is what the double pendulum's
 * lower arm did when shattering was switched on for it.
 *
 * The offset is baked in here AND repeated on the geom's `pos`, which looks
 * redundant and is not, because the two consumers disagree about where a mesh
 * lives:
 *
 *   - The renderer, for a DYNAMIC mesh, draws renderVertices at the BODY's
 *     transform and never looks at the geom's pos (SceneLayer's useFrame:
 *     "renderVertices are in body-local space"). It needs the offset in the
 *     vertices.
 *   - MuJoCo recentres a mesh asset on its volume centroid and then places it
 *     at the geom's pos (GUIDE.md § Computing renderVertices). It throws the
 *     baked offset away, so it needs the offset on the pos.
 *
 * Feed only one and the body collides somewhere other than where it is drawn:
 * half its own length out, in the direction it runs. Since a cylinder's
 * centroid is the midpoint of its axis, the value both want is the same one —
 * see fromtoCenter.
 */
function placeAlongFromto(vertices: number[], fromto: number[]): void {
  // MuJoCo Z-up -> Three Y-up.
  let dx = fromto[3] - fromto[0];
  let dy = fromto[5] - fromto[2];
  let dz = -(fromto[4] - fromto[1]);

  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return;
  dx /= len; dy /= len; dz /= len;

  // Midpoint of the axis, in these vertices' Y-up space.
  const mx = (fromto[0] + fromto[3]) / 2;
  const my = (fromto[2] + fromto[5]) / 2;
  const mz = -(fromto[1] + fromto[4]) / 2;

  // Rotation taking +Y onto d, by Rodrigues about (Y x d). The two degenerate
  // cases are d parallel to +Y, where there is nothing to turn, and
  // antiparallel, where the axis is undefined and any half turn will do.
  const kx = dz, kz = -dx;              // Y x d = (dz, 0, -dx)
  const sin = Math.hypot(kx, kz);       // |Y x d|
  const cos = dy;                       // Y . d

  if (sin < 1e-12) {
    if (cos < 0) {
      for (let i = 0; i < vertices.length; i += 3) {
        vertices[i + 1] = -vertices[i + 1];   // half turn about X
        vertices[i + 2] = -vertices[i + 2];
      }
    }
    translate(vertices, mx, my, mz);
    return;
  }

  const ux = kx / sin, uz = kz / sin;   // unit axis; its y component is 0
  const t = 1 - cos;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    const cxv = -uz * y, cyv = uz * x - ux * z, czv = ux * y;  // k x v
    const kv = ux * x + uz * z;                                 // k . v
    vertices[i] = x * cos + cxv * sin + ux * kv * t;
    vertices[i + 1] = y * cos + cyv * sin;   // k has no y, so no k*(k.v) term
    vertices[i + 2] = z * cos + czv * sin + uz * kv * t;
  }
  translate(vertices, mx, my, mz);
}

/** Shift every vertex by a Three-space offset, in place. */
function translate(vertices: number[], dx: number, dy: number, dz: number): void {
  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] += dx;
    vertices[i + 1] += dy;
    vertices[i + 2] += dz;
  }
}

/**
 * Where a fromto shape's middle sits, in the MuJoCo body frame — the `pos` a
 * geom needs once its fromto has been turned into vertices. Same space as
 * fromto itself, so no axis swap here.
 */
export function fromtoCenter(fromto: number[]): [number, number, number] {
  return [
    (fromto[0] + fromto[3]) / 2,
    (fromto[1] + fromto[4]) / 2,
    (fromto[2] + fromto[5]) / 2,
  ];
}

export function meshForDenting(geom: SceneGeom): DentMesh | null {
  const size = geom.size || [];
  switch (geom.type) {
    case 'box':
      return boxMeshForDenting(size[0] ?? 0.1, size[1] ?? size[0] ?? 0.1, size[2] ?? size[0] ?? 0.1);
    case 'cylinder':
    case 'capsule': {
      const r = size[0] ?? 0.05;
      if (geom.fromto) {
        const ft = geom.fromto;
        const half = Math.hypot(ft[3] - ft[0], ft[4] - ft[1], ft[5] - ft[2]) / 2;
        const mesh = cylinderMeshForDenting(r, half);
        // Direction and offset both; the same offset is repeated on the geom's
        // pos by makeDentable. See placeAlongFromto for why both are needed.
        placeAlongFromto(mesh.vertices, ft);
        return mesh;
      }
      // No fromto means it already runs along its own Z, which is where
      // cylinderMeshForDenting puts it (Three +Y maps to MuJoCo +Z).
      return cylinderMeshForDenting(r, size[1] ?? r);
    }
    case 'sphere':
      return ellipsoidMeshForDenting(size[0] ?? 0.05, size[0] ?? 0.05, size[0] ?? 0.05);
    case 'ellipsoid':
      return ellipsoidMeshForDenting(size[0] ?? 0.05, size[1] ?? size[0] ?? 0.05, size[2] ?? size[0] ?? 0.05);
    default:
      return null; // already a mesh, or a plane
  }
}

/** Whether this geom could be dented as it stands, or would have to be converted. */
export function isDentable(geom: SceneGeom): boolean {
  return geom.type === 'mesh' && !!(geom.renderVertices || geom.vertices) && !!geom.faces;
}

/** Whether turning denting on for this geom means converting it first. */
export function needsConversionForDenting(geom: SceneGeom): boolean {
  return !isDentable(geom) && meshForDenting(geom) !== null;
}

// ---------------------------------------------------------------------------
// What the thing that hit it was shaped like
// ---------------------------------------------------------------------------
//
// A dent is not a generic round dish. A flat-ended slug dropped on a plate
// leaves a flat-bottomed pit its own width across, with a rim; a ball leaves a
// spherical cap; a corner leaves a crease. Taking the crater's width and
// profile from the STRIKER rather than from a constant is most of the
// difference between "there is a mark there" and "something landed there".
//
// This is a profile and a width, not a boolean of the two solids. Cutting the
// real intersection would be exact and would cost a mesh boolean per blow —
// seconds of wall clock at the moment of impact, for a shape that is a circle
// with a rim either way.

/** How the displacement falls off from the centre of the crater. */
export type DentProfile =
  /** Smooth dish: a soft or rounded thing, and the fallback. */
  | 'dish'
  /** Flat floor with a defined rim: anything that lands on a face or an end. */
  | 'flat'
  /** Spherical cap: a ball. */
  | 'round';

export interface Imprint {
  /** Half-width of the mark, in metres. */
  radius: number;
  profile: DentProfile;
}

/**
 * The mark a geom would leave in something softer.
 *
 * Deliberately the striker's own dimension rather than a tuned constant: a 38
 * mm slug should leave a 38 mm crater, and if somebody scales the slug up the
 * crater should follow without anybody editing a number.
 */
export function imprintOf(geom: SceneGeom | undefined): Imprint | null {
  if (!geom) return null;
  const size = geom.size || [];
  switch (geom.type) {
    case 'cylinder':
    case 'capsule':
      // Lands on its end far more often than not, and an end is flat.
      return { radius: Math.max(1e-3, size[0] ?? 0.03), profile: geom.type === 'capsule' ? 'round' : 'flat' };
    case 'box':
      // The smallest half-extent: a box landing square leaves a mark the size
      // of the face it landed on, and the narrow way is the one that fits.
      return { radius: Math.max(1e-3, Math.min(size[0] ?? 0.05, size[2] ?? size[0] ?? 0.05)), profile: 'flat' };
    case 'sphere':
      return { radius: Math.max(1e-3, size[0] ?? 0.03), profile: 'round' };
    case 'ellipsoid':
      return { radius: Math.max(1e-3, Math.min(size[0] ?? 0.03, size[2] ?? size[0] ?? 0.03)), profile: 'round' };
    case 'mesh': {
      const v = geom.renderVertices ?? geom.vertices;
      if (!v || v.length < 9) return null;
      // Half the smaller of its two cross-sectional spans, which is the width
      // of the mark it can make edge-on as well as face-on.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < v.length; i += 3) {
        if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i];
        if (v[i + 2] < minZ) minZ = v[i + 2]; if (v[i + 2] > maxZ) maxZ = v[i + 2];
      }
      const span = Math.min(maxX - minX, maxZ - minZ);
      return Number.isFinite(span) && span > 0 ? { radius: span / 2, profile: 'round' } : null;
    }
    default:
      return null;
  }
}

/**
 * The displacement at a distance `t` (0 at the centre, 1 at the rim), 0..1.
 *
 * 'flat' is the one worth reading. A flat-ended striker does not leave a dish:
 * it leaves a floor at full depth out to most of its width and then a wall, so
 * the profile is held at 1 and only turns over near the edge. The turn is
 * smoothed rather than square because a vertical wall in a triangle mesh is a
 * row of degenerate slivers, and because real metal does not fold that sharply.
 */
export function dentFalloff(t: number, profile: DentProfile): number {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  switch (profile) {
    case 'flat': {
      const RIM = 0.72;
      if (t <= RIM) return 1;
      const u = 1 - (t - RIM) / (1 - RIM);
      return u * u * (3 - 2 * u);
    }
    case 'round':
      // A spherical cap: the striker's own surface, pressed in.
      return Math.sqrt(Math.max(0, 1 - t * t));
    default: {
      const s = 1 - t;
      return s * s * (3 - 2 * s);
    }
  }
}
