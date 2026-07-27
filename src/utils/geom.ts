export interface MeshData {
  vertices: number[];
  faces: number[];
  renderVertices: number[];
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
  
  const apexIndex = segments;
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    faces.push(i, next, apexIndex); // CCW looking outward
  }
  
  for (let i = 1; i < segments - 1; i++) {
    faces.push(0, i, i + 1); // pointing down -Y
  }
  
  return { vertices, faces, renderVertices };
}

export function generateTorusMeshData(
  R: number, // Major radius
  r: number, // Minor (tube) radius
  radialSegments: number = 24,
  tubularSegments: number = 16
): MeshData {
  const vertices: number[] = [];
  const renderVertices: number[] = [];
  const faces: number[] = [];

  for (let i = 0; i <= radialSegments; i++) {
    const u = (i / radialSegments) * Math.PI * 2;
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);

    for (let j = 0; j <= tubularSegments; j++) {
      const v = (j / tubularSegments) * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);

      const x = (R + r * cosV) * cosU;
      const y = r * sinV;
      const z = (R + r * cosV) * sinU;

      vertices.push(x, y, z);
      renderVertices.push(x, -z, y);
    }
  }

  const stride = tubularSegments + 1;
  for (let i = 0; i < radialSegments; i++) {
    for (let j = 0; j < tubularSegments; j++) {
      const a = i * stride + j;
      const b = i * stride + j + 1;
      const c = (i + 1) * stride + j;
      const d = (i + 1) * stride + j + 1;

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

    // Outer wall faces (looking outward)
    faces.push(ot_curr, ob_curr, ob_next);
    faces.push(ot_curr, ob_next, ot_next);

    // Inner wall faces (looking inward)
    faces.push(it_curr, ib_next, ib_curr);
    faces.push(it_curr, it_next, ib_next);

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
): any[] {
  const nSeg = Math.max(2, segments);
  const samples = closed
    ? sampleCatmullRom(points, nSeg, true)
    : sampleCatmullRom(points, nSeg + 1);
  const bank = (bankDeg * Math.PI) / 180;
  const cosB = Math.cos(bank), sinB = Math.sin(bank);
  const geoms: any[] = [];
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

  // MuJoCo Z-up renderVertices (Z=UP, Y=DEPTH, X=RIGHT)
  const renderVertices = [
    -halfW, -halfD, height, // 0
    -halfW,  halfD, height, // 1
     halfW, -halfD, 0,      // 2
     halfW,  halfD, 0,      // 3
    -halfW, -halfD, 0,      // 4
    -halfW,  halfD, 0,      // 5
  ];

  const faces = [
    0, 1, 3,  0, 3, 2, // Slanted top face
    4, 2, 3,  4, 3, 5, // Bottom flat face
    4, 5, 1,  4, 1, 0, // Back vertical wall
    4, 0, 2,           // Left triangle side (z = -halfD)
    5, 3, 1,           // Right triangle side (z = +halfD)
  ];

  return { vertices, faces, renderVertices };
}
