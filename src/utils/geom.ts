import * as THREE from 'three';
import type { SceneGeom } from '../types/scene';
import { analyzeMesh } from './meshIntegrity';
export { analyzeMesh };

export interface MeshData {
  vertices: number[];
  faces: number[];
  renderVertices: number[];
}

/**
 * Smoothly snaps a rotation angle (in degrees) to cardinal values (0, 90, 180, 270, 360, etc.)
 * using a continuous magnetic attraction curve to eliminate step jumps and slider input traps.
 */
export function getStickyRotation(val: number, snapRadius = 1.5, magneticRange = 4.0): number {
  const targetAngles = [0, 90, 180, 270, 360, -90, -180, -270, -360];
  for (const target of targetAngles) {
    const diff = val - target;
    const absDiff = Math.abs(diff);
    if (absDiff <= snapRadius) {
      return target;
    }
    if (absDiff < magneticRange) {
      const t = (absDiff - snapRadius) / (magneticRange - snapRadius);
      const smoothFactor = t * t * (3 - 2 * t);
      return target + Math.sign(diff) * (snapRadius + smoothFactor * (magneticRange - snapRadius));
    }
  }
  return val;
}

export function generatePyramidMeshData(w: number, d: number, h: number): MeshData {
  const hw = w / 2;
  const hd = d / 2;
  
  // Three.js Y-up (X=right, Y=up, Z=depth)
  const vertices = [
    -hw, 0,  hd,  // 0: front-left
     hw, 0,  hd,  // 1: front-right
     hw, 0, -hd,  // 2: back-right
    -hw, 0, -hd,  // 3: back-left
     0,  h,   0   // 4: apex
  ];
  
  const faces = [
    0, 1, 4, // front side (CCW looking outward)
    1, 2, 4, // right side (CCW looking outward)
    2, 3, 4, // back side (CCW looking outward)
    3, 0, 4, // left side (CCW looking outward)
    0, 2, 1, // base tri 1 (pointing down -Y)
    0, 3, 2  // base tri 2 (pointing down -Y)
  ];
  
  // Z-up: mapping (x, y, z) -> (x, -z, y)
  const renderVertices = [
    -hw, -hd, 0,
     hw, -hd, 0,
     hw,  hd, 0,
    -hw,  hd, 0,
     0,   0,  h
  ];
  
  return { vertices, faces, renderVertices };
}

export function generateConeMeshData(r: number, h: number, segments: number = 16): MeshData {
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];
  
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);
    vertices.push(x, 0, z);
    renderVertices.push(x, -z, 0);
  }
  
  vertices.push(0, h, 0);
  renderVertices.push(0, 0, h);
  
  // Wound CCW seen from OUTSIDE, so face normals point out of the solid. The
  // comments here used to claim that while the indices said the opposite: the
  // mesh's signed volume was negative, i.e. every normal pointed inwards.
  const apexIndex = segments;
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    faces.push(next, i, apexIndex); // side, normal pointing away from the axis
  }
  
  // The base fan was already correct and is left alone. Note that signed volume
  // CANNOT verify it: the base lies in the y=0 plane through the origin, so its
  // tetrahedra have zero volume and an inverted base is invisible to that test.
  // Only a directed-edge consistency check catches it.
  for (let i = 1; i < segments - 1; i++) {
    faces.push(0, i, i + 1); // base fan, normal pointing down -Y
  }
  
  return { vertices, faces, renderVertices };
}

export function generateTorusMeshData(
  R: number, // Major radius
  r: number, // Minor (tube) radius
  radialSegments: number = 24,
  tubularSegments: number = 16
): MeshData {
  const nRad = Math.max(3, Math.floor(radialSegments));
  const nTub = Math.max(3, Math.floor(tubularSegments));
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];

  for (let i = 0; i < nRad; i++) {
    const u = (i / nRad) * Math.PI * 2;
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);

    for (let j = 0; j < nTub; j++) {
      const v = (j / nTub) * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);

      const x = (R + r * cosV) * cosU;
      const y = r * sinV;
      const z = (R + r * cosV) * sinU;

      vertices.push(x, y, z);
      renderVertices.push(x, -z, y);
    }
  }

  for (let i = 0; i < nRad; i++) {
    const nextI = (i + 1) % nRad;
    for (let j = 0; j < nTub; j++) {
      const nextJ = (j + 1) % nTub;
      const a = i * nTub + j;
      const b = i * nTub + nextJ;
      const c = nextI * nTub + j;
      const d = nextI * nTub + nextJ;

      faces.push(a, b, d);
      faces.push(a, d, c);
    }
  }

  return { vertices, faces, renderVertices };
}

export function generateTubeMeshData(
  innerRadius: number,
  outerRadius: number,
  height: number,
  segments: number = 24
): MeshData {
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];
  
  const hh = height / 2;
  
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // Outer top
    vertices.push(outerRadius * cosT, hh, outerRadius * sinT);
    renderVertices.push(outerRadius * cosT, -outerRadius * sinT, hh);

    // Outer bottom
    vertices.push(outerRadius * cosT, -hh, outerRadius * sinT);
    renderVertices.push(outerRadius * cosT, -outerRadius * sinT, -hh);

    // Inner top
    vertices.push(innerRadius * cosT, hh, innerRadius * sinT);
    renderVertices.push(innerRadius * cosT, -innerRadius * sinT, hh);

    // Inner bottom
    vertices.push(innerRadius * cosT, -hh, innerRadius * sinT);
    renderVertices.push(innerRadius * cosT, -innerRadius * sinT, -hh);
  }

  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;

    const ot_curr = i * 4;
    const ob_curr = i * 4 + 1;
    const it_curr = i * 4 + 2;
    const ib_curr = i * 4 + 3;

    const ot_next = next * 4;
    const ob_next = next * 4 + 1;
    const it_next = next * 4 + 2;
    const ib_next = next * 4 + 3;

    // Outer wall — normal points away from the axis.
    // These two triangles and the inner-wall pair below were both wound the
    // wrong way round, while the caps were correct: the mesh had MIXED winding,
    // so no single orientation convention could interpret it. That left the
    // per-vertex normals wrong on all four walls (bad shading, and an STL export
    // whose walls face inwards) and made the mesh's signed volume meaningless.
    faces.push(ot_curr, ob_next, ob_curr);
    faces.push(ot_curr, ot_next, ob_next);

    // Inner wall — normal points TOWARD the axis, i.e. out of the solid and into
    // the hole.
    faces.push(it_curr, ib_curr, ib_next);
    faces.push(it_curr, ib_next, it_next);

    // Top cap (outer top to inner top, looking up)
    faces.push(ot_curr, it_curr, it_next);
    faces.push(ot_curr, it_next, ot_next);

    // Bottom cap (outer bottom to inner bottom, looking down)
    faces.push(ob_curr, ib_next, ib_curr);
    faces.push(ob_curr, ob_next, ib_next);
  }

  return { vertices, faces, renderVertices };
}

// ---------------------------------------------------------------------------
// Curve (rigid curved track) component
//
// A curve is defined by a handful of user-editable control points. A
// Catmull-Rom spline is threaded through them and decomposed into many small
// box geoms, each rotated to follow the local tangent. Every box is convex,
// so MuJoCo collision follows the real curve — unlike a single concave mesh,
// which MuJoCo would collapse to its (solid) convex hull.
//
// Control points are in body-local MuJoCo Z-up space. The spline defines the
// ROLLING SURFACE: each box is offset half a thickness below it, so a ball
// rolls exactly along the authored curve.
// ---------------------------------------------------------------------------

export const DEFAULT_CURVE_POINTS: number[][] = [
  [-1.6, 0, 1.4],
  [-0.55, 0, 0.45],
  [0.45, 0, 0.12],
  [1.6, 0, 0.7],
];
export const DEFAULT_CURVE_WIDTH = 0.5;
export const DEFAULT_CURVE_THICKNESS = 0.06;
export const DEFAULT_CURVE_SEGMENTS = 28;

// Uniform Catmull-Rom through all control points, endpoints included.
// closed=true wraps the spline back to the first point (seamless loop); the
// returned samples then do NOT repeat the first point — the caller connects
// last→first.
export function sampleCatmullRom(points: number[][], samples: number, closed: boolean = false): number[][] {
  if (points.length < 2) return points.slice();
  const n = points.length;
  const P = closed
    ? (i: number) => points[((i % n) + n) % n]
    : (i: number) => points[Math.max(0, Math.min(n - 1, i))];
  const out: number[][] = [];
  const spans = closed ? n : n - 1;
  for (let s = 0; s < samples; s++) {
    const u = closed ? (s / samples) * spans : (s / (samples - 1)) * spans;
    const seg = Math.min(spans - 1, Math.floor(u));
    const t = u - seg;
    const p0 = P(seg - 1), p1 = P(seg), p2 = P(seg + 1), p3 = P(seg + 2);
    const t2 = t * t, t3 = t2 * t;
    const pt = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      pt[k] = 0.5 * (
        (2 * p1[k]) +
        (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3
      );
    }
    out.push(pt);
  }
  return out;
}

// Rotation matrix with columns (xAxis, yAxis, zAxis) -> MuJoCo quat [w,x,y,z]
function frameToQuat(x: number[], y: number[], z: number[]): number[] {
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const trace = m00 + m11 + m22;
  let qw: number, qx: number, qy: number, qz: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s; qx = (m21 - m12) * s; qy = (m02 - m20) * s; qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  const n = Math.sqrt(qw * qw + qx * qx + qy * qy + qz * qz) || 1;
  return [qw / n, qx / n, qy / n, qz / n];
}

export function generateCurveGeoms(
  id: string,
  points: number[][] = DEFAULT_CURVE_POINTS,
  width: number = DEFAULT_CURVE_WIDTH,
  thickness: number = DEFAULT_CURVE_THICKNESS,
  segments: number = DEFAULT_CURVE_SEGMENTS,
  rgba: number[] = [0.85, 0.45, 0.15, 1],
  closed: boolean = false,
  bankDeg: number = 0
): SceneGeom[] {
  const nSeg = Math.max(2, segments);
  const samples = closed
    ? sampleCatmullRom(points, nSeg, true)
    : sampleCatmullRom(points, nSeg + 1);
  const bank = (bankDeg * Math.PI) / 180;
  const cosB = Math.cos(bank), sinB = Math.sin(bank);
  const geoms: SceneGeom[] = [];
  const pairCount = closed ? samples.length : samples.length - 1;
  for (let i = 0; i < pairCount; i++) {
    const a = samples[i], b = samples[(i + 1) % samples.length];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    if (len < 1e-6) continue;
    const xAxis = [d[0] / len, d[1] / len, d[2] / len];
    // Flat-banked frame: yAxis horizontal, zAxis the "up-ish" surface normal.
    const ref = Math.abs(xAxis[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    const yRaw = [
      ref[1] * xAxis[2] - ref[2] * xAxis[1],
      ref[2] * xAxis[0] - ref[0] * xAxis[2],
      ref[0] * xAxis[1] - ref[1] * xAxis[0],
    ];
    const yLen = Math.sqrt(yRaw[0] * yRaw[0] + yRaw[1] * yRaw[1] + yRaw[2] * yRaw[2]) || 1;
    let yAxis = [yRaw[0] / yLen, yRaw[1] / yLen, yRaw[2] / yLen];
    let zAxis = [
      xAxis[1] * yAxis[2] - xAxis[2] * yAxis[1],
      xAxis[2] * yAxis[0] - xAxis[0] * yAxis[2],
      xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0],
    ];
    if (bank !== 0) {
      // Roll the cross-section about the tangent: positive bank raises the
      // +y (left-of-travel) edge, tipping the surface toward the right.
      const yB = [
        cosB * yAxis[0] + sinB * zAxis[0],
        cosB * yAxis[1] + sinB * zAxis[1],
        cosB * yAxis[2] + sinB * zAxis[2],
      ];
      const zB = [
        -sinB * yAxis[0] + cosB * zAxis[0],
        -sinB * yAxis[1] + cosB * zAxis[1],
        -sinB * yAxis[2] + cosB * zAxis[2],
      ];
      yAxis = yB; zAxis = zB;
    }
    // Center sits half a thickness below the spline so the TOP face is the track.
    const halfT = thickness / 2;
    const center = [
      (a[0] + b[0]) / 2 - zAxis[0] * halfT,
      (a[1] + b[1]) / 2 - zAxis[1] * halfT,
      (a[2] + b[2]) / 2 - zAxis[2] * halfT,
    ];
    // Slight tangential overlap hides the gaps where adjacent segments meet.
    const halfL = len / 2 + Math.min(len * 0.35, thickness * 0.5);
    geoms.push({
      name: `${id}_seg${i}`,
      type: 'box',
      size: [halfL, width / 2, halfT],
      pos: center,
      quat: frameToQuat(xAxis, yAxis, zAxis),
      rgba: [...rgba],
    });
  }
  return geoms;
}

// Solid triangular-prism collision mesh for a wedge body, authored in the same
// "pre-tilted" local frame as the WedgeGeometry renderer in App.tsx: the slanted
// top face lies on the local z = 0 plane and the solid bulk hangs below it, so a
// body euler of [0, theta, 0] lands the base flat on the ground.
//
// Before this existed the wedge collided as a thin slab straddling the slanted
// face, which is fine for something welded in place but leaves a free-jointed
// wedge resting on a 5cm plate with its visible bulk buried underground.
export function generateWedgeMeshData(width: number, depth: number, height: number): MeshData {
  const halfW = width / 2;
  const halfD = depth / 2;

  // Three.js Y-up vertices (Y=UP, Z=DEPTH, X=RIGHT)
  const vertices = [
    -halfW, height, -halfD, // 0: back-left top
    -halfW, height,  halfD, // 1: back-right top
     halfW, 0,      -halfD, // 2: toe-left bottom
     halfW, 0,       halfD, // 3: toe-right bottom
    -halfW, 0,      -halfD, // 4: back-left bottom
    -halfW, 0,       halfD, // 5: back-right bottom
  ];

  // MuJoCo Z-up renderVertices (Z=UP, Y=DEPTH, X=RIGHT).
  // This is the Y-up list above mapped through (x,y,z) -> (x,-z,y), the same
  // rotation every other generator here uses and the one mjcf.ts applies to
  // `vertices`. It previously used (x,y,z) -> (x,z,y), which is a REFLECTION:
  // the two arrays described mirror-image solids with opposite winding, so
  // anything reading renderVertices got a wedge flipped in depth.
  const renderVertices = [
    -halfW,  halfD, height, // 0
    -halfW, -halfD, height, // 1
     halfW,  halfD, 0,      // 2
     halfW, -halfD, 0,      // 3
    -halfW,  halfD, 0,      // 4
    -halfW, -halfD, 0,      // 5
  ];

  // Wound CCW seen from outside, matching the Y-up `vertices` above. (These were
  // already correct: the earlier appearance of an inverted wedge came entirely
  // from renderVertices being a mirror image, not from the winding.)
  const faces = [
    0, 1, 3,  0, 3, 2, // Slanted top face
    4, 2, 3,  4, 3, 5, // Bottom flat face
    4, 5, 1,  4, 1, 0, // Back vertical wall
    4, 0, 2,           // Left triangle side (z = -halfD)
    5, 3, 1,           // Right triangle side (z = +halfD)
  ];

  return { vertices, faces, renderVertices };
}

function cleanRing2D(ring: number[][], wantCCW: boolean): number[][] {
  const pts: number[][] = [];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]) || 0;
    const y = Number(p[1]) || 0;
    if (pts.length > 0) {
      const prev = pts[pts.length - 1];
      if (Math.hypot(x - prev[0], y - prev[1]) < 1e-7) continue;
    }
    pts.push([x, y]);
  }
  if (pts.length >= 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-7) {
      pts.pop();
    }
  }
  if (pts.length < 3) return pts;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  const isCCW = area2 > 0;
  if (isCCW !== wantCCW) {
    pts.reverse();
  }
  return pts;
}

/**
 * Extrudes a 2D polygon `[x, y][]` in the MuJoCo XY plane along the Z axis by `height`.
 * Optionally accepts 2D interior `holes` (`[x, y][][]`).
 * Produces a watertight, outward-wound mesh in both Y-up (`vertices`) and Z-up (`renderVertices`).
 */
export function generateExtrudedPolygonMeshData(
  polygon: number[][],
  height: number = 0.1,
  centered: boolean = true,
  holes: number[][][] = []
): MeshData {
  const outer = cleanRing2D(polygon, true);
  if (outer.length < 3) {
    return generatePyramidMeshData(0.1, 0.1, Math.max(0.01, height));
  }
  const cleanedHoles = Array.isArray(holes)
    ? holes.map((h) => cleanRing2D(h, false)).filter((h) => h.length >= 3)
    : [];

  const h = Math.max(1e-4, Number(height) || 0.1);
  const zBottom = centered ? -h / 2 : 0;
  const zTop = centered ? h / 2 : h;

  const contourVec = outer.map(([x, y]) => new THREE.Vector2(x, y));
  const holeVecs = cleanedHoles.map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y)));
  const tris = THREE.ShapeUtils.triangulateShape(contourVec, holeVecs);

  const rings: number[][][] = [outer, ...cleanedHoles];
  const allPts: number[][] = [];
  for (const ring of rings) {
    for (const pt of ring) allPts.push(pt);
  }
  const n = allPts.length;
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];

  // Bottom ring: indices 0 .. n-1
  for (let i = 0; i < n; i++) {
    const [rx, ry] = allPts[i];
    const rz = zBottom;
    renderVertices.push(rx, ry, rz);
    vertices.push(rx, rz, -ry);
  }
  // Top ring: indices n .. 2n-1
  for (let i = 0; i < n; i++) {
    const [rx, ry] = allPts[i];
    const rz = zTop;
    renderVertices.push(rx, ry, rz);
    vertices.push(rx, rz, -ry);
  }

  for (const tri of tris) {
    const i0 = tri[0];
    let i1 = tri[1], i2 = tri[2];
    const p0 = allPts[i0], p1 = allPts[i1], p2 = allPts[i2];
    const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (cross < 0) {
      const tmp = i1;
      i1 = i2;
      i2 = tmp;
    }
    // Top cap (+Z normal)
    faces.push(n + i0, n + i1, n + i2);
    // Bottom cap (-Z normal)
    faces.push(i0, i2, i1);
  }

  // Side walls for outer ring and each hole ring
  let offset = 0;
  for (const ring of rings) {
    const m = ring.length;
    for (let i = 0; i < m; i++) {
      const curr = offset + i;
      const next = offset + ((i + 1) % m);
      faces.push(curr, next, n + next);
      faces.push(curr, n + next, n + curr);
    }
    offset += m;
  }

  return { vertices, faces, renderVertices };
}

/**
 * Revolves a 2D `[r, z][]` profile around the Z axis into a watertight 3D mesh.
 * - If the profile is an open outer contour (start/end have `r > 0` and do not meet),
 *   flat caps to `r = 0` on the Z axis are added automatically at the bottom and top.
 * - If the profile is a closed loop in `r > 0` (e.g. a hollow cup or custom ring section),
 *   it is revolved as a closed toroidal shell.
 */
export function generateLatheMeshData(
  profile: number[][],
  segments: number = 24
): MeshData {
  const nSeg = Math.max(3, Math.floor(segments));
  const rawPts: [number, number][] = [];
  for (const p of profile || []) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const r = Math.max(0, Number(p[0]) || 0);
    const z = Number(p[1]) || 0;
    if (rawPts.length > 0) {
      const prev = rawPts[rawPts.length - 1];
      if (Math.hypot(r - prev[0], z - prev[1]) < 1e-7) continue;
    }
    rawPts.push([r, z]);
  }
  if (rawPts.length < 2) {
    return generateConeMeshData(0.1, 0.2, nSeg);
  }

  const EPS = 1e-6;
  const first = rawPts[0];
  const last = rawPts[rawPts.length - 1];
  const isClosedLoop = rawPts.length >= 3 && Math.hypot(first[0] - last[0], first[1] - last[1]) < EPS;

  const pts: [number, number][] = [];
  if (isClosedLoop) {
    for (let i = 0; i < rawPts.length - 1; i++) pts.push(rawPts[i]);
  } else {
    if (first[0] > EPS) pts.push([0, first[1]]);
    for (const pt of rawPts) pts.push(pt);
    if (last[0] > EPS) pts.push([0, last[1]]);
  }

  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];

  // Map each profile station to either a single axis vertex (when r <= EPS)
  // or a ring of nSeg vertices.
  const stationIndices: number[][] = [];
  for (let k = 0; k < pts.length; k++) {
    const [r, z] = pts[k];
    if (r <= EPS) {
      const idx = renderVertices.length / 3;
      renderVertices.push(0, 0, z);
      vertices.push(0, z, 0);
      stationIndices.push([idx]);
    } else {
      const ring: number[] = [];
      for (let s = 0; s < nSeg; s++) {
        const theta = (s / nSeg) * Math.PI * 2;
        const rx = r * Math.cos(theta);
        const ry = r * Math.sin(theta);
        const rz = z;
        const idx = renderVertices.length / 3;
        renderVertices.push(rx, ry, rz);
        vertices.push(rx, rz, -ry);
        ring.push(idx);
      }
      stationIndices.push(ring);
    }
  }

  const spanCount = isClosedLoop ? pts.length : pts.length - 1;
  for (let k = 0; k < spanCount; k++) {
    const ringA = stationIndices[k];
    const ringB = stationIndices[(k + 1) % pts.length];
    if (ringA.length === 1 && ringB.length === 1) {
      continue;
    } else if (ringA.length === 1) {
      const pole = ringA[0];
      for (let s = 0; s < nSeg; s++) {
        const nextS = (s + 1) % nSeg;
        faces.push(pole, ringB[nextS], ringB[s]);
      }
    } else if (ringB.length === 1) {
      const pole = ringB[0];
      for (let s = 0; s < nSeg; s++) {
        const nextS = (s + 1) % nSeg;
        faces.push(ringA[s], ringA[nextS], pole);
      }
    } else {
      for (let s = 0; s < nSeg; s++) {
        const nextS = (s + 1) % nSeg;
        const a0 = ringA[s];
        const a1 = ringA[nextS];
        const b0 = ringB[s];
        const b1 = ringB[nextS];
        faces.push(a0, a1, b1);
        faces.push(a0, b1, b0);
      }
    }
  }

  const integrity = analyzeMesh(vertices, faces);
  if (integrity && integrity.volume < 0) {
    for (let i = 0; i < faces.length; i += 3) {
      const tmp = faces[i + 1];
      faces[i + 1] = faces[i + 2];
      faces[i + 2] = tmp;
    }
  }

  return { vertices, faces, renderVertices };
}

export const PARAMETRIC_MESH_TYPES = new Set([
  'cone',
  'pyramid',
  'wedge',
  'torus',
  'tube',
  'pipe',
  'hollow_cylinder',
  'extrude',
  'prism',
  'lathe',
  'revolve',
]);

/**
 * Expands parametric mesh geom types (`cone`, `pyramid`, `wedge`, `torus`, `tube`,
 * `extrude`/`prism`, `lathe`/`revolve`), normalises `verticesZUp` / `renderVertices` / `vertices`
 * so agents can author meshes in Z-up without Three.js Y-up confusion, auto-fixes closed
 * inverted-winding meshes, and computes bounding `size` half-extents.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeMeshGeomData<T extends Record<string, any>>(geom: T): T {
  if (!geom || typeof geom !== 'object') return geom;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g: Record<string, any> = geom;

  const rawType = typeof g.type === 'string' ? g.type.toLowerCase() : '';
  const hasPolygon = Array.isArray(g.polygon) && g.polygon.length >= 3;
  const hasProfile = Array.isArray(g.profile) && g.profile.length >= 2;

  let generated: MeshData | null = null;
  if (rawType === 'cone') {
    const r = Number(g.radius ?? g.size?.[0] ?? 0.15) || 0.15;
    const h = Number(
      g.height ?? (Array.isArray(g.size) ? (g.size.length >= 3 ? g.size[2] * 2 : g.size[1] != null ? g.size[1] * 2 : 0.3) : 0.3)
    ) || 0.3;
    const segs = Number(g.segments ?? 24) || 24;
    generated = generateConeMeshData(r, h, segs);
  } else if (rawType === 'pyramid') {
    const w = Number(g.width ?? (g.size?.[0] != null ? g.size[0] * 2 : 0.3)) || 0.3;
    const d = Number(g.depth ?? (g.size?.[1] != null ? g.size[1] * 2 : w)) || w;
    const h = Number(g.height ?? (g.size?.[2] != null ? g.size[2] * 2 : 0.3)) || 0.3;
    generated = generatePyramidMeshData(w, d, h);
  } else if (rawType === 'wedge') {
    const w = Number(g.width ?? (g.size?.[0] != null ? g.size[0] * 2 : 0.4)) || 0.4;
    const d = Number(g.depth ?? (g.size?.[1] != null ? g.size[1] * 2 : 0.3)) || 0.3;
    const h = Number(g.height ?? (g.size?.[2] != null ? g.size[2] * 2 : 0.2)) || 0.2;
    generated = generateWedgeMeshData(w, d, h);
  } else if (rawType === 'torus') {
    const R = Number(g.majorRadius ?? g.radius ?? g.size?.[0] ?? 0.2) || 0.2;
    const r = Number(g.minorRadius ?? g.tubeRadius ?? g.size?.[1] ?? 0.06) || 0.06;
    const radSeg = Number(g.radialSegments ?? g.segments ?? 24) || 24;
    const tubSeg = Number(g.tubularSegments ?? 16) || 16;
    generated = generateTorusMeshData(R, r, radSeg, tubSeg);
  } else if (rawType === 'tube' || rawType === 'pipe' || rawType === 'hollow_cylinder') {
    const outerRadius = Number(g.outerRadius ?? g.radius ?? g.size?.[0] ?? 0.15) || 0.15;
    const innerRadius = Number(
      g.innerRadius ??
      (g.wallThickness != null
        ? Math.max(0.001, outerRadius - Number(g.wallThickness))
        : Array.isArray(g.size) && g.size.length >= 3
          ? g.size[1]
          : outerRadius * 0.65)
    ) || outerRadius * 0.65;
    const height = Number(
      g.height ??
      (Array.isArray(g.size)
        ? g.size.length >= 3
          ? g.size[2] * 2
          : g.size[1] != null
            ? g.size[1] * 2
            : 0.3
        : 0.3)
    ) || 0.3;
    const segs = Number(g.segments ?? 24) || 24;
    generated = generateTubeMeshData(Math.min(innerRadius, outerRadius * 0.98), outerRadius, height, segs);
  } else if (rawType === 'extrude' || rawType === 'prism' || ((rawType === 'mesh' || !rawType) && hasPolygon)) {
    const h = Number(g.height ?? (g.size?.[2] != null ? g.size[2] * 2 : 0.1)) || 0.1;
    const centered = g.centered !== false;
    generated = generateExtrudedPolygonMeshData(g.polygon || [[-0.1, -0.1], [0.1, -0.1], [0, 0.1]], h, centered, g.holes);
  } else if (rawType === 'lathe' || rawType === 'revolve' || ((rawType === 'mesh' || !rawType) && hasProfile)) {
    const segs = Number(g.segments ?? 24) || 24;
    generated = generateLatheMeshData(g.profile || [[0.1, 0], [0.1, 0.2]], segs);
  }

  if (generated) {
    g.type = 'mesh';
    g.vertices = generated.vertices;
    g.faces = generated.faces;
    g.renderVertices = generated.renderVertices;
  }

  // Z-up / Y-up vertex array synchronisation for any mesh geom
  if (Array.isArray(g.verticesZUp) && g.verticesZUp.length >= 9) {
    const zUp = g.verticesZUp.map((v: unknown) => Number(v) || 0);
    const yUp: number[] = [];
    for (let i = 0; i + 2 < zUp.length; i += 3) {
      yUp.push(zUp[i], zUp[i + 2], -zUp[i + 1]);
    }
    g.renderVertices = zUp;
    g.vertices = yUp;
    delete g.verticesZUp;
    if (!g.type || g.type === 'box') g.type = 'mesh';
  } else if (
    Array.isArray(g.renderVertices) &&
    g.renderVertices.length >= 9 &&
    (!Array.isArray(g.vertices) || g.vertices.length === 0)
  ) {
    const zUp = g.renderVertices.map((v: unknown) => Number(v) || 0);
    const yUp: number[] = [];
    for (let i = 0; i + 2 < zUp.length; i += 3) {
      yUp.push(zUp[i], zUp[i + 2], -zUp[i + 1]);
    }
    g.renderVertices = zUp;
    g.vertices = yUp;
    if (!g.type || g.type === 'box') g.type = 'mesh';
  } else if (
    Array.isArray(g.vertices) &&
    g.vertices.length >= 9 &&
    (!Array.isArray(g.renderVertices) || g.renderVertices.length === 0)
  ) {
    const yUp = g.vertices.map((v: unknown) => Number(v) || 0);
    const zUp: number[] = [];
    for (let i = 0; i + 2 < yUp.length; i += 3) {
      zUp.push(yUp[i], -yUp[i + 2], yUp[i + 1]);
    }
    g.vertices = yUp;
    g.renderVertices = zUp;
  }

  if (g.type === 'mesh' && Array.isArray(g.vertices) && g.vertices.length >= 9 && Array.isArray(g.faces) && g.faces.length >= 3) {
    // Auto-flip closed meshes that were wound consistently inside-out
    const m = analyzeMesh(g.vertices, g.faces);
    if (m && m.closed && m.consistentlyWound && m.volume < 0) {
      const flipped = [...g.faces];
      for (let i = 0; i + 2 < flipped.length; i += 3) {
        const tmp = flipped[i + 1];
        flipped[i + 1] = flipped[i + 2];
        flipped[i + 2] = tmp;
      }
      g.faces = flipped;
    }

    // Default dynamic = true so static & jointed meshes both render at body.pos / body.quat
    if (g.dynamic === undefined) {
      g.dynamic = true;
    }

    // Populate bounding half-extents in g.size when not explicitly provided
    if (!Array.isArray(g.size) || g.size.length < 3) {
      const rv = Array.isArray(g.renderVertices) && g.renderVertices.length >= 9 ? g.renderVertices : g.vertices;
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i + 2 < rv.length; i += 3) {
        const x = rv[i], y = rv[i + 1], z = rv[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (isFinite(minX)) {
        g.size = [
          Math.max(0.005, (maxX - minX) / 2),
          Math.max(0.005, (maxY - minY) / 2),
          Math.max(0.005, (maxZ - minZ) / 2),
        ];
      }
    }
  }
  return geom;
}

