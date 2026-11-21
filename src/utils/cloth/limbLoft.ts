/**
 * A limb as one smooth surface: lofted along a path of points, each with an
 * elliptical cross-section (half-width across `side`, half-height across
 * the third axis), and closed at both ends with rounded caps. What a body
 * form's arms, hands, legs and feet are drawn and collided as; built from
 * capsules and boxes they met in lips at the elbows and read as tubes.
 *
 * Points are Z-up (MuJoCo); the mesh it returns is Y-up, as scene meshes are.
 */

export interface LimbSection {
  p: number[];
  /** Half-width, along `side`. */
  w: number;
  /** Half-height, across the path and `side`. */
  h: number;
  /** This section's own width direction, if not the limb's. */
  side?: number[];
  /** Optional custom section contour at angle `a` (0 = +side, pi/2 = +up), returning [along side, along up]. */
  shape?: (a: number) => [number, number];
}

const ANG = 24;
const CAP_RINGS = 4;

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: number[]) => { const l = Math.sqrt(dot(a, a)) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Orthogonalize `sd` against unit vector `t`, falling back to a perpendicular axis if nearly parallel. */
function perpUnit(sd: number[], t: number[]): number[] {
  const proj = sub(sd, t.map((v) => v * dot(sd, t)));
  const l = Math.sqrt(dot(proj, proj));
  if (l >= 1e-6) return [proj[0] / l, proj[1] / l, proj[2] / l];
  const fb = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return unit(sub(fb, t.map((v) => v * dot(fb, t))));
}

/**
 * The limb's mesh. `side` is the direction the sections' width lies along
 * (made square to the path at each point).
 */
export function limbLoft(path: LimbSection[], side: number[], caps: { start?: number; end?: number; partialEnd?: boolean; angles?: number; capRings?: number } = {}): { vertices: number[]; faces: number[] } {
  const n = path.length;
  const ang = caps.angles ?? (path.some((s) => s.shape) ? 48 : ANG);
  const capRings = caps.capRings ?? CAP_RINGS;
  const frames = path.map((s, i) => {
    const t = unit(sub(path[Math.min(n - 1, i + 1)].p, path[Math.max(0, i - 1)].p));
    const sd = s.side ?? side;
    const w = perpUnit(sd, t);
    return { t, w, u: cross(t, w) };
  });
  const rings: number[][][] = [];
  const ring = (c: number[], f: { w: number[]; u: number[] }, w: number, h: number, shape?: (a: number) => [number, number]) =>
    Array.from({ length: ang }, (_, k) => {
      const a = (2 * Math.PI * k) / ang;
      const [cw, sh] = shape ? shape(a) : [Math.cos(a) * w, Math.sin(a) * h];
      return [c[0] + f.w[0] * cw + f.u[0] * sh, c[1] + f.w[1] * cw + f.u[1] * sh, c[2] + f.w[2] * cw + f.u[2] * sh];
    });
  // Rounded caps: rings shrinking as a quarter ellipse beyond each end, or
  // continuing the end section's own ellipsoid dome when `caps` gives the
  // remaining height above a partial dome (so the crown has no slope jump).
  const depthAt = (s: LimbSection, dir: number) => (dir < 0 ? caps.start : caps.end) ?? Math.min(s.w, s.h);
  const cap = (s: LimbSection, f: { t: number[]; w: number[]; u: number[] }, dir: number) => {
    const out: number[][][] = [];
    const depth = depthAt(s, dir);
    const a0 = dir > 0 && caps.partialEnd ? Math.acos(0.6) : 0;
    const s0 = Math.sin(a0), c0 = Math.cos(a0);
    const aspect = a0 === 0 && caps.capRings !== undefined ? Math.min(1, depth / Math.max(1e-6, depth, s.w, s.h)) : 1;
    for (let r = 1; r <= capRings; r++) {
      const psi = a0 + (r / (capRings + 1)) * (Math.PI / 2 - a0);
      const a = aspect < 1 ? Math.atan(aspect * Math.tan(psi)) : psi;
      const k = Math.cos(a) / c0;
      const zOff = depth * (Math.sin(a) - s0) / (1 - s0);
      const capShape = s.shape ? (ang: number): [number, number] => { const [cw, sh] = s.shape!(ang); return [cw * k, sh * k]; } : undefined;
      out.push(ring(s.p.map((v, j) => v + f.t[j] * dir * zOff), f, s.w * k, s.h * k, capShape));
    }
    return out;
  };
  rings.push(...cap(path[0], frames[0], -1).reverse());
  const pathRings = path.map((s, i) => ring(s.p, frames[i], s.w, s.h, s.shape));
  // At a sharp elbow or knee bend whose cross-section radius exceeds the centreline
  // fillet radius, adjacent rings overtake each other on the inside of the crease
  // and invert their faces (`windingMixed`). Clamp each vertex along the local
  // ring-strip normal so every quad advances monotonically and keeps outward winding.
  const MIN_ADV = 5e-4;
  for (let i = 1; i < n; i++) {
    const tAvg = unit([frames[i - 1].t[0] + frames[i].t[0], frames[i - 1].t[1] + frames[i].t[1], frames[i - 1].t[2] + frames[i].t[2]]);
    for (let k = 0; k < ang; k++) {
      const prev = pathRings[i - 1][k], cur = pathRings[i][k];
      const prevNext = pathRings[i - 1][(k + 1) % ang], prevPrev = pathRings[i - 1][(k - 1 + ang) % ang];
      // Ring tangent along +k; for outward winding, cross(ringTan, cur - prev) must point outward.
      const ringTan = sub(prevNext, prevPrev);
      const adv = dot(sub(cur, prev), tAvg);
      // Also ensure the step does not cross backward relative to the local ring plane spanned by ringTan and outward radial.
      const rad = sub(prev, path[i - 1].p);
      const planeAdv = unit(cross(rad, ringTan));
      const useAxis = dot(planeAdv, tAvg) > 0.2 ? planeAdv : tAvg;
      const projAdv = dot(sub(cur, prev), useAxis);
      if (adv < MIN_ADV || projAdv < MIN_ADV) {
        const push = Math.max(MIN_ADV - adv, MIN_ADV - projAdv);
        pathRings[i][k] = [cur[0] + useAxis[0] * push, cur[1] + useAxis[1] * push, cur[2] + useAxis[2] * push];
      }
    }
  }
  rings.push(...pathRings);
  // End cap starts from the clamped last ring's centroid so it cannot cross pathRings[n - 1].
  const endCentre = [0, 1, 2].map((j) => pathRings[n - 1].reduce((acc, q) => acc + q[j], 0) / ang);
  rings.push(...cap({ ...path[n - 1], p: endCentre }, frames[n - 1], 1));

  const pts: number[][] = rings.flat();
  const tip0 = path[0].p.map((v, j) => v - frames[0].t[j] * depthAt(path[0], -1));
  const tip1 = endCentre.map((v, j) => v + frames[n - 1].t[j] * depthAt(path[n - 1], 1));
  pts.push(tip0, tip1);
  const i0 = pts.length - 2, i1 = pts.length - 1;
  const faces: number[] = [];
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < ang; k++) {
      const a = r * ang + k, b = r * ang + ((k + 1) % ang), c = (r + 1) * ang + ((k + 1) % ang), d = (r + 1) * ang + k;
      const midA = (2 * Math.PI * (k + 0.5)) / ang;
      if (Math.cos(midA) * Math.sin(midA) > 0) faces.push(a, b, d, b, c, d);
      else faces.push(a, b, c, a, c, d);
    }
  }
  const last = (rings.length - 1) * ang;
  for (let k = 0; k < ang; k++) {
    faces.push(i0, (k + 1) % ang, k);
    faces.push(i1, last + k, last + ((k + 1) % ang));
  }
  // Wound outward: if the enclosed volume comes out negative, turn every face.
  let vol = 0;
  for (let f = 0; f < faces.length; f += 3) vol += dot(pts[faces[f]], cross(pts[faces[f + 1]], pts[faces[f + 2]]));
  if (vol < 0) for (let f = 0; f < faces.length; f += 3) { const tmp = faces[f + 1]; faces[f + 1] = faces[f + 2]; faces[f + 2] = tmp; }
  const vertices: number[] = [];
  for (const p of pts) vertices.push(p[0], p[2], -p[1]);
  return { vertices, faces };
}
