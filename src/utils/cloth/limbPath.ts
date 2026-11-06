/**
 * The centreline of a limb: straight from its root to its joint, turning
 * there (smoothly, over a short arc) by the joint's bend, and straight on to
 * its end. An arm turns forward at the elbow; a leg forward at the ankle,
 * into the foot; the head runs straight up. What the form's limb is lofted
 * along and what a garment over it follows, so the two agree.
 *
 * Positions by distance along the line from the root; Z-up, metres.
 */

export interface LimbPath {
  /** Root to end, along the line. */
  length: number;
  /** Distance of the joint along the line. */
  jointAt: number;
  /** How far the line turns at the joint, degrees. */
  bend: number;
  /** Point on the line at distance s (straight on past either end). */
  at(s: number): number[];
  /** Unit direction of the line at distance s. */
  tangent(s: number): number[];
  /** Turns a vector square to the line at s0 into the same vector at s1 (the line's own frame). */
  carry(v: number[], s0: number, s1: number): number[];
  /** The nearest point on the line between 0 and `upTo` (default the whole length). */
  closest(p: number[], upTo?: number): { s: number; p: number[] };
  /**
   * Where a point near the line would be with the joint straight: the same
   * distance along it and the same offset from it, the line run straight on
   * from its root. How a garment over a bent limb is cut.
   */
  straighten(p: number[]): number[];
  /** The same, for a point known to be at distance s along the line and offset `v` from it. */
  straightAt(s: number, v: number[]): number[];
  /**
   * The same line turning on a wider radius: what a tube round the limb
   * wider than the joint's own turn follows (the inside of a sleeve's bend
   * would otherwise fold through itself).
   */
  refillet(radius: number): LimbPath;
}

const STEP = 0.005;

/**
 * `origin` the root, `dir` the direction to the joint, `forward` the way the
 * line turns there (square to `dir`), `bend` in degrees, the joint at
 * `upper` along it, `fillet` the radius the line turns on.
 */
export function makeLimbPath(origin: number[], dir: number[], forward: number[], upper: number, length: number, bend: number, fillet: number): LimbPath {
  const b = (bend * Math.PI) / 180;
  // The turn is a circular arc tangent to both lines, meeting each a
  // tangent length from the joint; s stays the distance along the two
  // lines, so over the arc (shorter than the two tangents it replaces) the
  // point moves slower. An arc of its own length centred on the joint left
  // the line past it off the second line: a foot 1.7 cm lower than meant.
  const tangentLen = fillet * Math.tan(b / 2);
  const arc = fillet * b;
  const s0 = upper - tangentLen;
  // How far the line has turned at s, 0..b.
  const turn = (s: number) => (b <= 1e-9 ? 0 : b * Math.min(1, Math.max(0, (s - s0) / Math.max(1e-9, 2 * tangentLen))));
  const speed = (s: number) => (b > 1e-9 && s > s0 && s < s0 + 2 * tangentLen ? arc / (2 * tangentLen) : 1);
  const dirAt = (a: number) => [0, 1, 2].map((k) => dir[k] * Math.cos(a) + forward[k] * Math.sin(a));
  // The line sampled, integrating its direction.
  const n = Math.ceil((length + 0.4) / STEP) + 1;
  const pts: number[][] = [origin.slice()];
  for (let i = 1; i < n; i++) {
    const sm = (i - 0.5) * STEP, t = dirAt(turn(sm)), q = pts[i - 1], v = speed(sm) * STEP;
    pts.push([q[0] + t[0] * v, q[1] + t[1] * v, q[2] + t[2] * v]);
  }
  const axis = [dir[1] * forward[2] - dir[2] * forward[1], dir[2] * forward[0] - dir[0] * forward[2], dir[0] * forward[1] - dir[1] * forward[0]];
  const rotate = (v: number[], a: number) => {
    // Rodrigues, about `axis` (unit: dir and forward are unit and square).
    const c = Math.cos(a), sn = Math.sin(a), d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    const x = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
    return [0, 1, 2].map((k) => v[k] * c + x[k] * sn + axis[k] * d * (1 - c));
  };
  const at = (s: number) => {
    if (s <= 0) return origin.map((v, k) => v + dir[k] * s);
    const f = s / STEP, i = Math.floor(f);
    if (i >= n - 1) { const t = dirAt(b), q = pts[n - 1]; return q.map((v, k) => v + t[k] * (s - (n - 1) * STEP)); }
    const u = f - i;
    return pts[i].map((v, k) => v + (pts[i + 1][k] - v) * u);
  };
  return {
    refillet: (radius) => makeLimbPath(origin, dir, forward, upper, length, bend, Math.max(fillet, radius)),
    length,
    jointAt: upper,
    bend,
    at,
    tangent: (s) => dirAt(turn(s)),
    carry: (v, a, c) => rotate(v, turn(c) - turn(a)),
    straighten(p) {
      const { s, p: c } = this.closest(p, length + 0.3);
      return this.straightAt(s, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    },
    straightAt(s, v) {
      const r = rotate(v, turn(0) - turn(s));
      return [0, 1, 2].map((k) => origin[k] + dir[k] * s + r[k]);
    },
    closest(p, upTo = length) {
      let best = 0, bd = Infinity;
      for (let i = 0; i * STEP <= upTo; i++) {
        const q = pts[i], d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      // Before the root, on along its straight line.
      if (best === 0) {
        const s = Math.min(0, (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1] + (p[2] - origin[2]) * dir[2]);
        if (s < 0) return { s, p: at(s) };
      }
      const maxI = Math.min(n - 1, Math.floor(upTo / STEP));
      let bestS = best * STEP, bestP = pts[best];
      for (const i of [best - 1, best]) {
        if (i < 0 || i >= maxI) continue;
        const a = pts[i], b = pts[i + 1];
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const l2 = ux * ux + uy * uy + uz * uz;
        if (l2 < 1e-16) continue;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy + (p[2] - a[2]) * uz) / l2));
        const q = [a[0] + t * ux, a[1] + t * uy, a[2] + t * uz];
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d < bd) { bd = d; bestS = Math.min(upTo, (i + t) * STEP); bestP = q; }
      }
      return { s: bestS, p: bestP };
    },
  };
}
