/**
 * The centreline of a limb: straight from its root to a joint, turning there
 * (smoothly, over a short arc) by the joint's bend, and straight on to the
 * next joint or its end. An arm turns forward at the elbow; a leg at the
 * knee, then forward at the ankle into the foot; the head runs straight up.
 * What the form's limb is lofted along and what a garment over it follows,
 * so the two agree.
 *
 * Positions by distance along the line from the root; Z-up, metres.
 */

export interface LimbPath {
  /** Root to end, along the line. */
  length: number;
  /** Distance of the (last) joint along the line. */
  jointAt: number;
  /** How far the line turns at the (last) joint, degrees. */
  bend: number;
  /** Every joint along it, root to end; the last is `jointAt`'s. */
  joints: { at: number; bend: number }[];
  /** Point on the line at distance s (straight on past either end). */
  at(s: number): number[];
  /** Unit direction of the line at distance s. */
  tangent(s: number): number[];
  /** Turns a vector square to the line at s0 into the same vector at s1 (the line's own frame). */
  carry(v: number[], s0: number, s1: number): number[];
  /** The nearest point on the line between 0 and `upTo` (default the whole length). */
  closest(p: number[], upTo?: number): { s: number; p: number[] };
  /**
   * Where a point near the line would be with the joints straight: the same
   * distance along it and the same offset from it, the line run straight on
   * from its root. How a garment over a bent limb is cut.
   */
  straighten(p: number[]): number[];
  /** The same, for a point known to be at distance s along the line and offset `v` from it. */
  straightAt(s: number, v: number[]): number[];
  /**
   * The same line turning on a wider radius at every joint (one for all, or
   * one per joint): what a tube
   * round the limb wider than a joint's own turn follows (the inside of a
   * sleeve's bend would otherwise fold through itself).
   */
  refillet(radius: number | number[]): LimbPath;
}

const STEP = 0.005;

/** A joint along a line: where (distance from the root), which way it turns (unit, square to the line coming in), how far in degrees, and on what radius. */
export interface PathJoint { at: number; forward: number[]; bend: number; fillet: number }

/**
 * `origin` the root, `dir` the direction to the joint, `forward` the way the
 * line turns there (square to `dir`), `bend` in degrees, the joint at
 * `upper` along it, `fillet` the radius the line turns on.
 */
export function makeLimbPath(origin: number[], dir: number[], forward: number[], upper: number, length: number, bend: number, fillet: number): LimbPath {
  return makeJointedPath(origin, dir, [{ at: upper, forward, bend, fillet }], length);
}

/**
 * A line through its joints in turn (a leg through the knee and the ankle),
 * each turning the line coming into it toward its own `forward`.
 */
export function makeJointedPath(origin: number[], dir: number[], joints: PathJoint[], length: number): LimbPath {
  // Each joint: the line coming in, the way it turns, by how much, and where
  // its arc starts. The turn is a circular arc tangent to both lines, meeting
  // each a tangent length from the joint; s stays the distance along the
  // lines, so over the arc (shorter than the two tangents it replaces) the
  // point moves slower. An arc of its own length centred on the joint left
  // the line past it off the next line: a foot 1.7 cm lower than meant.
  // A turn starts no sooner than the line does, or the last turn ends: its
  // radius is drawn in to fit.
  const J: { d: number[]; f: number[]; b: number; tl: number; arc: number; s0: number }[] = [];
  let d = dir, free = 0;
  for (const jt of joints) {
    const b = (jt.bend * Math.PI) / 180, half = Math.tan(b / 2), din = d, f = jt.forward;
    const fillet = half > 1e-9 ? Math.min(jt.fillet, Math.max(0, jt.at - free) / half) : jt.fillet;
    const tl = fillet * half;
    J.push({ d: din, f, b, tl, arc: fillet * b, s0: jt.at - tl });
    free = jt.at + tl;
    d = [0, 1, 2].map((k) => din[k] * Math.cos(b) + f[k] * Math.sin(b));
  }
  const last = J.length - 1;
  // Which joint's turn the line is in or past at s (the first, before any).
  const jointOf = (s: number) => { let j = 0; for (let i = 1; i <= last; i++) if (s >= J[i].s0) j = i; return j; };
  // How far the line has turned at s through joint j, 0..b.
  const turnAt = (j: number, s: number) => { const q = J[j]; return q.b <= 1e-9 ? 0 : q.b * Math.min(1, Math.max(0, (s - q.s0) / Math.max(1e-9, 2 * q.tl))); };
  const speed = (s: number) => { for (const q of J) if (q.b > 1e-9 && s > q.s0 && s < q.s0 + 2 * q.tl) return q.arc / (2 * q.tl); return 1; };
  const dirAt = (j: number, a: number) => { const q = J[j]; return [0, 1, 2].map((k) => q.d[k] * Math.cos(a) + q.f[k] * Math.sin(a)); };
  const tangent = (s: number) => { const j = jointOf(s); return dirAt(j, turnAt(j, s)); };
  // The line sampled, integrating its direction.
  const n = Math.ceil((length + 0.4) / STEP) + 1;
  const pts: number[][] = [origin.slice()];
  for (let i = 1; i < n; i++) {
    const sm = (i - 0.5) * STEP, t = tangent(sm), q = pts[i - 1], v = speed(sm) * STEP;
    pts.push([q[0] + t[0] * v, q[1] + t[1] * v, q[2] + t[2] * v]);
  }
  // Each joint's axis (unit: its line in and its forward are unit and square).
  const axes = J.map((q) => [q.d[1] * q.f[2] - q.d[2] * q.f[1], q.d[2] * q.f[0] - q.d[0] * q.f[2], q.d[0] * q.f[1] - q.d[1] * q.f[0]]);
  const rotate = (v: number[], a: number, axis: number[]) => {
    // Rodrigues, about `axis`.
    const c = Math.cos(a), sn = Math.sin(a), dv = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
    const x = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
    return [0, 1, 2].map((k) => v[k] * c + x[k] * sn + axis[k] * dv * (1 - c));
  };
  // Back through each joint's turn at s0, then on through each one's at s1.
  const carry = (v: number[], s0: number, s1: number) => {
    if (!last) return rotate(v, turnAt(0, s1) - turnAt(0, s0), axes[0]);
    let r = v;
    for (let j = last; j >= 0; j--) r = rotate(r, -turnAt(j, s0), axes[j]);
    for (let j = 0; j <= last; j++) r = rotate(r, turnAt(j, s1), axes[j]);
    return r;
  };
  const at = (s: number) => {
    if (s <= 0) return origin.map((v, k) => v + dir[k] * s);
    const f = s / STEP, i = Math.floor(f);
    if (i >= n - 1) { const t = dirAt(last, J[last].b), q = pts[n - 1]; return q.map((v, k) => v + t[k] * (s - (n - 1) * STEP)); }
    const u = f - i;
    return pts[i].map((v, k) => v + (pts[i + 1][k] - v) * u);
  };
  return {
    refillet: (radius) => makeJointedPath(origin, dir, joints.map((jt, i) => ({ ...jt, fillet: Math.max(jt.fillet, typeof radius === 'number' ? radius : radius[i] ?? 0) })), length),
    length,
    jointAt: joints[last].at,
    bend: joints[last].bend,
    joints: joints.map((jt) => ({ at: jt.at, bend: jt.bend })),
    at,
    tangent,
    carry,
    straighten(p) {
      const { s, p: c } = this.closest(p, length + 0.3);
      return this.straightAt(s, [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
    },
    straightAt(s, v) {
      const r = carry(v, s, 0);
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
