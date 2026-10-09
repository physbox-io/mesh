// ---------------------------------------------------------------------------
// Print poses, and laying posed parts out on the bed
// ---------------------------------------------------------------------------
//
// Split for Print (utils/printSplit.ts) decides which way up each section is
// printed, and the 3MF export (App.tsx) turns the sections that way and lays
// them out on the plate. Both have to mean the same thing by a pose, so the
// rotation lives here, in one place, with nothing heavy imported: the export
// is on the main thread, and has no business loading the split's wasm.
//
// A pose is two numbers' worth of turning. `up` is the direction, in the body's
// own frame, that ends up pointing up off the bed; `spin` then turns the part
// about the vertical so its footprint lines up with the bed's edges. Turning
// the body by `poseMatrix(pose)` gives the printed orientation, before it is
// dropped onto the plate and moved into its spot.
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface PrintPose {
  /** Body-local unit vector that points up off the bed when printed. */
  up: Vec3;
  /** Turn about the vertical after that, in radians. */
  spin: number;
}

/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The smallest rotation taking unit vector `a` onto unit vector `b`.
 *
 * Rodrigues, written out. Exactly opposite vectors have no smallest rotation —
 * any half turn about an axis square to them will do — so one is chosen, the
 * same one every time.
 */
export function rotationBetween(a: Vec3, b: Vec3): Mat3 {
  const [ax, ay, az] = norm(a);
  const [bx, by, bz] = norm(b);
  const c = ax * bx + ay * by + az * bz;
  if (c < -1 + 1e-9) {
    // Half a turn about any axis square to `a`.
    const helper: Vec3 = Math.abs(ax) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const k = norm([ay * helper[2] - az * helper[1], az * helper[0] - ax * helper[2], ax * helper[1] - ay * helper[0]]);
    // R = 2kk^T - I
    return [
      2 * k[0] * k[0] - 1, 2 * k[0] * k[1], 2 * k[0] * k[2],
      2 * k[1] * k[0], 2 * k[1] * k[1] - 1, 2 * k[1] * k[2],
      2 * k[2] * k[0], 2 * k[2] * k[1], 2 * k[2] * k[2] - 1,
    ];
  }
  const vx = ay * bz - az * by, vy = az * bx - ax * bz, vz = ax * by - ay * bx;
  const f = 1 / (1 + c);
  return [
    1 - f * (vy * vy + vz * vz), -vz + f * vx * vy, vy + f * vx * vz,
    vz + f * vx * vy, 1 - f * (vx * vx + vz * vz), -vx + f * vy * vz,
    -vy + f * vx * vz, vx + f * vy * vz, 1 - f * (vx * vx + vy * vy),
  ];
}

export function rotationZ(theta: number): Mat3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function applyMat3(m: Mat3, v: ArrayLike<number>, offset = 0): Vec3 {
  const x = v[offset], y = v[offset + 1], z = v[offset + 2];
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/** The rotation that stands a body in its print pose: `up` to +Z, then the spin. */
export function poseMatrix(pose: PrintPose): Mat3 {
  return mulMat3(rotationZ(pose.spin), rotationBetween(pose.up, [0, 0, 1]));
}

/** Every point of a flat xyz array turned by `m`. */
export function rotatePoints(m: Mat3, points: ArrayLike<number>): Float64Array {
  const out = new Float64Array(points.length);
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z;
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z;
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

export interface PlateRect {
  /** Footprint along the bed's X, mm. */
  w: number;
  /** Footprint along the bed's Y, mm. */
  d: number;
}

export interface Placement {
  /** Lower-left corner of the footprint on its plate, mm, bed origin at the corner. */
  x: number;
  y: number;
  /** Turned a quarter, so its w runs along Y. */
  turned: boolean;
  /** Which plate: 0 is the bed, 1 the next one over, and so on. */
  plate: number;
}

/**
 * Shelf packing: tallest first, left to right along a row, a new row when one
 * is full, and a new plate when the bed is.
 *
 * Not optimal and not meant to be. A slicer re-arranges a plate anyway; what
 * this has to get right is that nothing overlaps, everything that can be on the
 * bed is, and anything that cannot be goes on a plate of its own beside it
 * rather than being silently dropped. A part bigger than the bed still gets a
 * plate to itself.
 */
export function packOnBed(
  rects: PlateRect[],
  bed: { widthMm: number; depthMm: number },
  marginMm = 5,
  gapMm = 5,
): Placement[] {
  const W = bed.widthMm - 2 * marginMm;
  const D = bed.depthMm - 2 * marginMm;
  // Each part's long side along X, unless only the other way fits.
  const shaped = rects.map((r, i) => {
    const long = Math.max(r.w, r.d), short = Math.min(r.w, r.d);
    let turned: boolean;
    if (long <= W && short <= D) turned = r.w < r.d;
    else if (r.w <= W && r.d <= D) turned = false;
    else turned = r.d <= W && r.w <= D;
    return { i, w: turned ? r.d : r.w, d: turned ? r.w : r.d, turned };
  });
  const order = [...shaped].sort((a, b) => b.d - a.d || b.w - a.w);
  const out: Placement[] = new Array(rects.length);

  let plate = 0, rowY = 0, rowDepth = 0, cursorX = 0;
  let plateUsed = false;
  for (const s of order) {
    if (plateUsed && cursorX + s.w > W) {
      // New row.
      rowY += rowDepth + gapMm;
      cursorX = 0;
      rowDepth = 0;
    }
    if (plateUsed && rowY + s.d > D) {
      plate++;
      rowY = 0; cursorX = 0; rowDepth = 0;
    }
    out[s.i] = { x: marginMm + cursorX, y: marginMm + rowY, turned: s.turned, plate };
    plateUsed = true;
    cursorX += s.w + gapMm;
    rowDepth = Math.max(rowDepth, s.d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plate itself
// ---------------------------------------------------------------------------

export interface PosedPart {
  name: string;
  /** Body frame, Z-up, metres: a mesh geom's renderVertices. */
  positions: ArrayLike<number>;
  faces: ArrayLike<number>;
  pose: PrintPose;
  colour: [number, number, number];
}

export interface PlatedPart {
  name: string;
  /** Millimetres, on the plate, standing on Z = 0. */
  positions: Float32Array;
  indices: Uint32Array;
  colour: [number, number, number];
  plate: number;
}

/** Room between plates when a job needs more than one bed's worth. */
const PLATE_GAP_MM = 20;

/**
 * Stands every part the way it prints, puts it on the bed and lays the bed out.
 *
 * Each part is turned into its pose, sized in millimetres, dropped onto Z = 0
 * and given a spot by `packOnBed`. Parts that do not fit on the first bed go
 * on further plates in a row beside it, which a slicer will happily take as
 * separate plates or re-arrange.
 */
export function layoutOnBed(
  parts: PosedPart[],
  bed: { widthMm: number; depthMm: number },
  marginMm = 5,
): PlatedPart[] {
  const posed = parts.map((p) => {
    const turned = rotatePoints(poseMatrix(p.pose), p.positions);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < turned.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        turned[i + k] *= 1000;
        lo[k] = Math.min(lo[k], turned[i + k]);
        hi[k] = Math.max(hi[k], turned[i + k]);
      }
    }
    return { p, turned, lo, size: [hi[0] - lo[0], hi[1] - lo[1]] };
  });
  const places = packOnBed(posed.map(({ size }) => ({ w: size[0], d: size[1] })), bed, marginMm);
  return posed.map(({ p, turned, lo, size }, i) => {
    const place = places[i];
    const out = new Float32Array(turned.length);
    const plateX = place.plate * (bed.widthMm + PLATE_GAP_MM);
    for (let v = 0; v < turned.length; v += 3) {
      let x = turned[v] - lo[0], y = turned[v + 1] - lo[1];
      // A quarter turn about the vertical, keeping the footprint's corner at the origin.
      if (place.turned) [x, y] = [size[1] - y, x];
      out[v] = plateX + place.x + x;
      out[v + 1] = place.y + y;
      out[v + 2] = turned[v + 2] - lo[2];
    }
    return { name: p.name, positions: out, indices: Uint32Array.from(p.faces), colour: p.colour, plate: place.plate };
  });
}
