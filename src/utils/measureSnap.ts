// ---------------------------------------------------------------------------
// Snapping for the measure tool
// ---------------------------------------------------------------------------
//
// A measurement is only worth taking if it lands on the feature you meant. Two
// clicks on a surface give the distance between two arbitrary points on it,
// which is a number nobody asked for; what people mean is corner-to-corner,
// face-to-face, or — most of all — hole centre to hole centre. So a click does
// not measure where the ray hit. It measures the most interesting thing NEAR
// where the ray hit.
//
// Everything here is deliberately free of three.js: the caller does the
// raycasting and hands over plain arrays, which is what makes the interesting
// part — deciding that a ring of vertices is a circle, and where its centre is
// — something that can be tested without a renderer.
//
// The circle detection is the piece that earns the file. A hole in this app is
// usually a cylinder cut out of a solid, and after the boolean evaluator has
// been through it, the only trace left is a rim of triangle vertices lying on a
// circle. Nothing in the mesh says "hole". So the rim is recovered the way a
// person recovers it by eye: gather the vertices near the click, ask whether
// they are flat, and ask whether the flat ones sit at a constant distance from
// a common point.
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3) => length(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};

// ---------------------------------------------------------------------------
// Eigen decomposition of a symmetric 3x3
// ---------------------------------------------------------------------------

/**
 * The eigenvector of a symmetric 3x3 with the SMALLEST eigenvalue, by cyclic
 * Jacobi rotation.
 *
 * Used on a covariance matrix, where that eigenvector is the normal of the
 * best-fit plane through the points. Jacobi rather than the analytic cubic:
 * the matrices here are routinely near-degenerate — a ring of points on a
 * circle has two equal eigenvalues — and the closed form loses the third
 * eigenvector to cancellation exactly there.
 */
export function smallestEigenvector(m: number[][]): Vec3 {
  const a = m.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
  return normalize([v[0][best], v[1][best], v[2][best]]);
}

/** The best-fit plane through the points: a centroid and a unit normal. */
export function fitPlane(points: Vec3[]): { centroid: Vec3; normal: Vec3 } | null {
  if (points.length < 3) return null;
  const centroid: Vec3 = [0, 0, 0];
  for (const p of points) {
    centroid[0] += p[0];
    centroid[1] += p[1];
    centroid[2] += p[2];
  }
  centroid[0] /= points.length;
  centroid[1] /= points.length;
  centroid[2] /= points.length;

  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points) {
    const d = sub(p, centroid);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const normal = smallestEigenvector(cov);
  if (length(normal) < 0.5) return null;
  return { centroid, normal };
}

/** Two unit vectors spanning the plane with this normal. */
export function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(normal, seed));
  const v = normalize(cross(normal, u));
  return { u, v };
}

// ---------------------------------------------------------------------------
// Circles
// ---------------------------------------------------------------------------

export interface CircleFit {
  centre: Vec3;
  normal: Vec3;
  radius: number;
  /** Root-mean-square radial error, as a fraction of the radius. */
  error: number;
  /** Degrees of the circle the points actually cover — a full rim is 360. */
  coverage: number;
}

/**
 * Solves a 3x3 linear system by Gaussian elimination with partial pivoting.
 * Returns null where the matrix is singular, which for the circle fit means
 * the points were collinear.
 */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-18) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = m[row][col] / m[col][col];
      for (let k = col; k < 4; k++) m[row][k] -= f * m[col][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * Fits a circle to points that are already believed to be coplanar.
 *
 * Kåsa's algebraic fit: minimising |x² + y² + Dx + Ey + F| is linear in
 * D, E, F, so it is one 3x3 solve rather than an iteration that can fail to
 * converge on a partial arc. It biases the radius slightly small on a short
 * arc, which does not matter here — the result is judged by `error`, and a
 * short arc is rejected by `coverage` long before the bias is visible.
 */
export function fitCircle(points: Vec3[]): CircleFit | null {
  if (points.length < 4) return null;
  const plane = fitPlane(points);
  if (!plane) return null;
  const { centroid, normal } = plane;
  const { u, v } = planeBasis(normal);

  const flat = points.map((p) => {
    const d = sub(p, centroid);
    return [dot(d, u), dot(d, v)] as [number, number];
  });

  const a = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const rhs = [0, 0, 0];
  for (const [x, y] of flat) {
    const row = [x, y, 1];
    const target = -(x * x + y * y);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) a[i][j] += row[i] * row[j];
      rhs[i] += row[i] * target;
    }
  }
  const solved = solve3(a, rhs);
  if (!solved) return null;
  const [D, E, F] = solved;
  const cx = -D / 2;
  const cy = -E / 2;
  const inside = cx * cx + cy * cy - F;
  if (!(inside > 0)) return null;
  const radius = Math.sqrt(inside);
  if (!(radius > 0) || !Number.isFinite(radius)) return null;

  let sum = 0;
  const angles: number[] = [];
  for (const [x, y] of flat) {
    const dx = x - cx;
    const dy = y - cy;
    sum += (Math.hypot(dx, dy) - radius) ** 2;
    angles.push(Math.atan2(dy, dx));
  }
  const error = Math.sqrt(sum / flat.length) / radius;

  angles.sort((p, q) => p - q);
  let widestGap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let i = 1; i < angles.length; i++) widestGap = Math.max(widestGap, angles[i] - angles[i - 1]);
  const coverage = Math.max(0, 360 - (widestGap * 180) / Math.PI);

  const centre = add(centroid, add(scale(u, cx), scale(v, cy)));
  return { centre, normal, radius, error, coverage };
}

export interface CircleOptions {
  /** Largest RMS radial error, as a fraction of the radius. */
  maxError?: number;
  /** Largest out-of-plane spread, as a fraction of the radius. */
  maxFlatness?: number;
  /** Least arc the points must span, in degrees. */
  minCoverage?: number;
}

/**
 * Decides whether a cloud of points is a circle, and where its centre is.
 *
 * Three tests, in the order that rejects fastest. Coplanar, or it is a sphere's
 * worth of vertices rather than a rim. Round, or it is a rectangular pocket's
 * corner. And enough of the way round, or it is three vertices of a flat face
 * that happen to lie on some circle — which any three points do.
 */
export function detectCircle(points: Vec3[], options: CircleOptions = {}): CircleFit | null {
  const { maxError = 0.02, maxFlatness = 0.05, minCoverage = 200 } = options;
  if (points.length < 6) return null;
  const fit = fitCircle(points);
  if (!fit) return null;
  if (fit.error > maxError) return null;
  if (fit.coverage < minCoverage) return null;
  for (const p of points) {
    if (Math.abs(dot(sub(p, fit.centre), fit.normal)) > maxFlatness * fit.radius) return null;
  }
  return fit;
}

/**
 * The vertices of one mesh that lie within `radius` of a point.
 *
 * Deduplicated on the way, because a triangle soup repeats every shared corner
 * once per face it belongs to — and a rim vertex repeated six times would let
 * six copies of one point outvote the rest of the ring in the circle fit.
 */
export function nearbyVertices(
  positions: ArrayLike<number>,
  centre: Vec3,
  radius: number,
  limit = 4096,
): Vec3[] {
  const found: Vec3[] = [];
  const seen = new Set<string>();
  const r2 = radius * radius;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const dx = positions[i] - centre[0];
    const dy = positions[i + 1] - centre[1];
    const dz = positions[i + 2] - centre[2];
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    // Quantised to a nanometre before the duplicate check: welded corners are
    // bit-identical, but a corner that came from two different CSG operands is
    // the same corner to every eye and a hair apart in the buffer.
    const key = `${Math.round(positions[i] * 1e9)},${Math.round(positions[i + 1] * 1e9)},${Math.round(positions[i + 2] * 1e9)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push([positions[i], positions[i + 1], positions[i + 2]]);
    if (found.length >= limit) break;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/** What a snap landed on. The order here is the order they outrank each other. */
export type SnapKind = 'centre' | 'vertex' | 'midpoint' | 'edge' | 'surface';

export interface SnapCandidate {
  point: Vec3;
  kind: SnapKind;
  label: string;
  /** Set for a circle centre, so the readout can quote the diameter too. */
  radius?: number;
}

const RANK: Record<SnapKind, number> = { centre: 0, vertex: 1, midpoint: 2, edge: 3, surface: 4 };

/**
 * Picks the candidate a click meant.
 *
 * Screen distance, not world distance: what a person is aiming at is what looks
 * closest to the pointer, and on a model seen in perspective those are not the
 * same ordering. Inside the pixel window the RANK decides — a hole centre a few
 * pixels further away than a stray vertex on its rim is still what was meant,
 * because nobody points at the middle of a hole hoping to hit the rim.
 */
export function chooseSnap(
  candidates: SnapCandidate[],
  project: (p: Vec3) => { x: number; y: number } | null,
  pointer: { x: number; y: number },
  pixelRadius = 18,
): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  let bestRank = Infinity;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const screen = project(candidate.point);
    if (!screen) continue;
    const away = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    const rank = RANK[candidate.kind];
    // A surface point is the fallback and never has to be within the window;
    // everything else has to be close enough to have been aimed at.
    if (candidate.kind !== 'surface' && away > pixelRadius) continue;
    if (rank < bestRank || (rank === bestRank && away < bestDistance)) {
      best = candidate;
      bestRank = rank;
      bestDistance = away;
    }
  }
  return best;
}

/**
 * Picks the candidate nearest a point in space, rather than on a screen.
 *
 * What a caller with no camera needs. The interactive tool ranks by pixels
 * because that is what a person is aiming with; an agent naming a coordinate
 * has no pixels, and the honest question is "what feature is nearest to the
 * place I said". The kind still breaks ties within a tolerance, for the same
 * reason: nobody names a point in the middle of a hole hoping for its rim.
 */
export function chooseSnapNear(
  candidates: SnapCandidate[],
  point: Vec3,
  radius: number,
  /** How much nearer a lower-ranked candidate has to be to win outright. */
  tieBreak = 0.5,
): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  let bestRank = Infinity;
  let bestAway = Infinity;
  for (const candidate of candidates) {
    const away = distance(candidate.point, point);
    if (candidate.kind !== 'surface' && away > radius) continue;
    const rank = RANK[candidate.kind];
    // A better kind wins unless the nearer one is nearer by a clear margin —
    // which is what stops a hole centre 40 mm away from beating the corner the
    // caller was plainly pointing at.
    const clearlyNearer = away < bestAway * tieBreak;
    if (rank < bestRank ? !(bestAway < away * tieBreak) : clearlyNearer || (rank === bestRank && away < bestAway)) {
      best = candidate;
      bestRank = rank;
      bestAway = away;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The measurements themselves
// ---------------------------------------------------------------------------

export interface DistanceReading {
  distance: number;
  delta: Vec3;
}

/** Straight-line distance and its per-axis parts, in the frame it is given. */
export function measureDistance(a: Vec3, b: Vec3): DistanceReading {
  const delta = sub(b, a);
  return { distance: length(delta), delta };
}

/**
 * The angle at `vertex` between the two arms, in degrees.
 *
 * Clamped before the arccos: two arms that are all but parallel produce a
 * cosine a rounding error outside [-1, 1], and NaN is a poor thing to put in a
 * readout.
 */
export function measureAngle(armA: Vec3, vertex: Vec3, armB: Vec3): number | null {
  const a = normalize(sub(armA, vertex));
  const b = normalize(sub(armB, vertex));
  if (length(a) < 0.5 || length(b) < 0.5) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
}

/** Metres to a millimetre string, at the precision a machinist reads. */
export function formatMm(metres: number): string {
  const mm = metres * 1000;
  const digits = Math.abs(mm) < 10 ? 3 : Math.abs(mm) < 100 ? 2 : 2;
  return `${mm.toFixed(digits)} mm`;
}
