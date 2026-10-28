// Closed, outward-wound mesh fixtures for the collision tests.
//
// Winding matters more here than anywhere else in the suite: solidity is read
// from a signed volume, so a fixture built inside-out reports a negative volume
// and every assertion about concavity quietly inverts. Each builder below is
// checked by tests/convexDecomposition.test.ts via analyzeMesh before it is
// trusted — see the winding trap in CLAUDE.md.
//
// Everything is in Z-up (the `renderVertices` space), because that is what the
// decomposition and the MJCF emitter both work in.

export interface MeshData {
  /** Flat Z-up positions. */
  verts: number[];
  faces: number[];
}

/** Appends one triangle, given vertex indices wound CCW seen from outside. */
const tri = (faces: number[], a: number, b: number, c: number) => { faces.push(a, b, c); };

/** Appends a quad as two outward triangles. */
const quad = (faces: number[], a: number, b: number, c: number, d: number) => {
  tri(faces, a, b, c);
  tri(faces, a, c, d);
};

/**
 * An axis-aligned solid box centred on `c` with half-extents `h`.
 * Solidity 1: it is its own convex hull.
 */
export function boxMesh(
  c: [number, number, number] = [0, 0, 0],
  h: [number, number, number] = [0.1, 0.1, 0.1],
): MeshData {
  const [cx, cy, cz] = c;
  const [hx, hy, hz] = h;
  const verts = [
    cx - hx, cy - hy, cz - hz,  // 0
    cx + hx, cy - hy, cz - hz,  // 1
    cx + hx, cy + hy, cz - hz,  // 2
    cx - hx, cy + hy, cz - hz,  // 3
    cx - hx, cy - hy, cz + hz,  // 4
    cx + hx, cy - hy, cz + hz,  // 5
    cx + hx, cy + hy, cz + hz,  // 6
    cx - hx, cy + hy, cz + hz,  // 7
  ];
  const faces: number[] = [];
  quad(faces, 4, 5, 6, 7);  // +Z
  quad(faces, 3, 2, 1, 0);  // -Z
  quad(faces, 0, 1, 5, 4);  // -Y
  quad(faces, 2, 3, 7, 6);  // +Y
  quad(faces, 1, 2, 6, 5);  // +X
  quad(faces, 3, 0, 4, 7);  // -X
  return { verts, faces };
}

/**
 * A cup: a solid disc base with an annular wall standing on it, open at the top.
 *
 * This is the shape the whole feature exists for. Its convex hull is the full
 * cylinder — base, wall AND the column of air between them — so an undecomposed
 * cup collides as a solid billet and a ball dropped in rests on its rim.
 *
 * Built as one closed surface: outer wall, inner wall (wound inward, because its
 * outward direction points at the axis), the annular rim on top, and the disc
 * underneath.
 */
export function cupMesh({
  outerR = 0.10,
  innerR = 0.08,
  height = 0.12,
  baseThickness = 0.02,
  segments = 48,
  z0 = 0,
}: {
  outerR?: number; innerR?: number; height?: number;
  baseThickness?: number; segments?: number; z0?: number;
} = {}): MeshData {
  const verts: number[] = [];
  const faces: number[] = [];
  const zTop = z0 + height;
  const zFloor = z0 + baseThickness;

  const ring = (r: number, z: number) => {
    const base = verts.length / 3;
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      verts.push(r * Math.cos(t), r * Math.sin(t), z);
    }
    return base;
  };

  const outerBottom = ring(outerR, z0);
  const outerTop    = ring(outerR, zTop);
  const innerTop    = ring(innerR, zTop);
  const innerFloor  = ring(innerR, zFloor);

  const centreBottom = verts.length / 3; verts.push(0, 0, z0);
  const centreFloor  = verts.length / 3; verts.push(0, 0, zFloor);

  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    // Outer wall: outward normal points away from the axis.
    quad(faces, outerBottom + i, outerBottom + j, outerTop + j, outerTop + i);
    // Rim: the annulus on top, normal +Z.
    quad(faces, outerTop + i, outerTop + j, innerTop + j, innerTop + i);
    // Inner wall: this surface faces the cavity, so it winds the other way.
    quad(faces, innerTop + i, innerTop + j, innerFloor + j, innerFloor + i);
    // The cavity floor, normal +Z.
    tri(faces, innerFloor + i, innerFloor + j, centreFloor);
    // The underside, normal -Z.
    tri(faces, outerBottom + j, outerBottom + i, centreBottom);
  }
  return { verts, faces };
}

/**
 * A box with its lid missing: five slabs of wall around an open cavity.
 *
 * Returned as ONE mesh (the thing MuJoCo would hull) — `openTopBoxSlabs` gives
 * the same solid as the convex pieces it ought to collide as.
 */
export function openTopBoxMesh({
  outer = 0.1,
  wall = 0.02,
  height = 0.12,
}: { outer?: number; wall?: number; height?: number } = {}): MeshData {
  const verts: number[] = [];
  const faces: number[] = [];
  for (const slab of openTopBoxSlabs({ outer, wall, height })) {
    const base = verts.length / 3;
    const b = boxMesh(slab.c, slab.h);
    verts.push(...b.verts);
    faces.push(...b.faces.map(i => i + base));
  }
  return { verts, faces };
}

/** The five convex pieces an open-top box is exactly equal to. */
export function openTopBoxSlabs({
  outer = 0.1,
  wall = 0.02,
  height = 0.12,
}: { outer?: number; wall?: number; height?: number } = {}): Array<{
  c: [number, number, number]; h: [number, number, number];
}> {
  const hw = wall / 2;
  const inner = outer - wall;
  const wallH = (height - wall) / 2;
  const wallZ = wall + wallH;
  return [
    { c: [0, 0, hw], h: [outer, outer, hw] },                    // floor
    { c: [outer - hw, 0, wallZ], h: [hw, outer, wallH] },        // +X
    { c: [-(outer - hw), 0, wallZ], h: [hw, outer, wallH] },     // -X
    { c: [0, outer - hw, wallZ], h: [inner, hw, wallH] },        // +Y
    { c: [0, -(outer - hw), wallZ], h: [inner, hw, wallH] },     // -Y
  ];
}

/**
 * A UV sphere — convex, and dense enough to clear the triangle floor.
 *
 * The seam is shared rather than duplicated, and the poles are single vertices,
 * so every edge is used by exactly two triangles. A sphere built the usual way,
 * with a doubled seam column, is not closed and integrates to the wrong volume.
 */
export function sphereMesh(r = 0.1, segments = 24, rings = 16): MeshData {
  const verts: number[] = [];
  const faces: number[] = [];
  // rings - 1 latitude bands of real vertices, poles held separately.
  const ringBase: number[] = [];
  for (let iy = 1; iy < rings; iy++) {
    const phi = (iy / rings) * Math.PI;
    ringBase.push(verts.length / 3);
    for (let ix = 0; ix < segments; ix++) {
      const theta = (ix / segments) * Math.PI * 2;
      verts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      );
    }
  }
  const top = verts.length / 3; verts.push(0, 0, r);
  const bottom = verts.length / 3; verts.push(0, 0, -r);

  for (let ix = 0; ix < segments; ix++) {
    const i = ix, j = (ix + 1) % segments;
    tri(faces, ringBase[0] + i, ringBase[0] + j, top);
    tri(faces, ringBase[rings - 2] + j, ringBase[rings - 2] + i, bottom);
  }
  for (let b = 0; b < rings - 2; b++) {
    const upper = ringBase[b], lower = ringBase[b + 1];
    for (let ix = 0; ix < segments; ix++) {
      const i = ix, j = (ix + 1) % segments;
      quad(faces, lower + i, lower + j, upper + j, upper + i);
    }
  }
  return { verts, faces };
}

/** Y-up positions, as SceneGeom.vertices wants them. mjcf.ts swaps back. */
export function zupToYupFlat(zup: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < zup.length; i += 3) out.push(zup[i], zup[i + 2], -zup[i + 1]);
  return out;
}

/**
 * Indexed mesh to the flat triangle soup the DFM engine and the column samplers
 * work in: 9 floats per triangle, no indices.
 */
export function toSoup(m: MeshData): Float64Array {
  const out = new Float64Array(m.faces.length * 3);
  for (let f = 0; f < m.faces.length; f++) {
    const v = m.faces[f] * 3;
    out[f * 3] = m.verts[v];
    out[f * 3 + 1] = m.verts[v + 1];
    out[f * 3 + 2] = m.verts[v + 2];
  }
  return out;
}

/**
 * A torus about Z: major radius `R` to the middle of the tube, tube radius `r`.
 * Solidity well under 1 — the hole in the middle is in its hull.
 */
export function torusMesh(R = 0.08, r = 0.006, segments = 32, sides = 12): MeshData {
  const verts: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const rr = R + r * Math.cos(v);
      verts.push(rr * Math.cos(u), rr * Math.sin(u), r * Math.sin(v));
    }
  }
  const at = (i: number, j: number) => (i % segments) * sides + (j % sides);
  // d/du x d/dv points out of the tube, so u-then-v corners run CCW from outside.
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) quad(faces, at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
  }
  return { verts, faces };
}

/** The coaster profile the U-channel fixture follows: (x, z) knots in metres, cosine-eased between. */
export const COASTER_KNOTS: [number, number][] = [
  [-0.22, 0.05], [-0.15, 0.11], [-0.13, 0.11], [-0.03, 0.012], [0.07, 0.045], [0.15, 0.012], [0.22, 0.06],
];

/** Height of the channel floor at x, along COASTER_KNOTS. */
export function coasterFloorZ(x: number, knots = COASTER_KNOTS): number {
  const cx = Math.max(knots[0][0], Math.min(knots[knots.length - 1][0], x));
  for (let i = 0; i < knots.length - 1; i++) {
    const [x0, z0] = knots[i], [x1, z1] = knots[i + 1];
    if (cx >= x0 && cx <= x1) {
      const u = (cx - x0) / (x1 - x0);
      return z0 + (z1 - z0) * (1 - Math.cos(Math.PI * u)) / 2;
    }
  }
  return knots[knots.length - 1][1];
}

/**
 * A rolling-coaster track: a U-channel swept along COASTER_KNOTS, x from -220
 * to +220 mm. The channel is `width` wide inside and `depth` deep, with `wall`
 * thick sides and a `base` thick floor, its cross-section kept square to the
 * slope. Solidity about 0.09 — almost all of its hull is air, most of it the
 * channel a car runs in.
 */
export function uChannelTrack({
  stations = 120, width = 0.032, wall = 0.003, depth = 0.012, base = 0.004, knots = COASTER_KNOTS,
}: { stations?: number; width?: number; wall?: number; depth?: number; base?: number; knots?: [number, number][] } = {}): MeshData {
  const x0 = knots[0][0], x1 = knots[knots.length - 1][0];
  const a = width / 2 + wall;
  // The section in (y, height above the floor), counter-clockwise seen from +x.
  const poly: [number, number][] = [
    [-a, -base], [a, -base], [a, depth], [width / 2, depth], [width / 2, 0], [-width / 2, 0], [-width / 2, depth], [-a, depth],
  ];
  const m = poly.length;
  const verts: number[] = [];
  for (let s = 0; s < stations; s++) {
    const x = x0 + ((x1 - x0) * s) / (stations - 1);
    const h = 1e-5;
    const dz = (coasterFloorZ(x + h, knots) - coasterFloorZ(x - h, knots)) / (2 * h);
    const n = Math.hypot(1, dz), tx = 1 / n, tz = dz / n;
    for (const [y, up] of poly) verts.push(x - tz * up, y, coasterFloorZ(x, knots) + tx * up);
  }
  const faces: number[] = [];
  // The section runs counter-clockwise seen from +x, so seen from outside a
  // side face, round the section then +x is counter-clockwise: p, q, q+m, p+m.
  for (let s = 0; s < stations - 1; s++) {
    for (let k = 0; k < m; k++) {
      const p = s * m + k, q = s * m + ((k + 1) % m);
      quad(faces, p, q, q + m, p + m);
    }
  }
  // The end caps, the section split into three convex pieces: floor and walls.
  const cap: [number, number, number][] = [[0, 1, 4], [0, 4, 5], [1, 2, 3], [1, 3, 4], [0, 5, 6], [0, 6, 7]];
  const last = (stations - 1) * m;
  for (const [p, q, r] of cap) tri(faces, p, r, q);
  for (const [p, q, r] of cap) tri(faces, last + p, last + q, last + r);
  return { verts, faces };
}
