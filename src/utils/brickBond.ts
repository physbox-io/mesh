// How well bricks are bonded, for any laid result: real bricks or toy.
//
// The same four questions a builder asks of a wall, read off the bricks'
// footprints course by course:
// - pieces: does it hold together as one thing? Two bricks are joined when
//   they overlap across a bed (mortar, or studs gripping). A brick-thick wall
//   in stretcher bond is two leaves that never cross, so two pieces: it needs
//   wall ties or a bond with headers.
// - unsupported: bricks with nothing under them (above the first course).
// - straightJoints: perpends (seams) sitting on a seam in the course below,
//   the line a wall cracks along. For brickwork, any perpend lapped less
//   than a quarter brick (the usual minimum lap).
// - singleRest: bricks resting wholly on one brick, which spread no load.
//
// Millimetres; footprints are rotated rectangles.

import type { PlacedBrick } from './brickwork';

export interface BondReport {
  pieces: number;
  /** Pieces beside another piece in the same course (leaves untied), less one: 0 when none are. */
  sideBySide: number;
  unsupported: number;
  straightJoints: number;
  singleRest: number;
}

type V2 = { x: number; y: number };

function corners(b: PlacedBrick, shrink: number): V2[] {
  const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) }, n = { x: -u.y, y: u.x };
  const l = b.lengthMm / 2 - shrink, d = b.depthMm / 2 - shrink;
  return [[-l, -d], [l, -d], [l, d], [-l, d]].map(([a, c]) => ({ x: b.x + u.x * a + n.x * c, y: b.y + u.y * a + n.y * c }));
}

/** Whether two convex quads overlap by more than a sliver (separating axes). */
function overlap(A: V2[], B: V2[]): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const e = { x: P[(i + 1) % 4].x - P[i].x, y: P[(i + 1) % 4].y - P[i].y };
      const ax = { x: -e.y, y: e.x };
      const pa = A.map((p) => p.x * ax.x + p.y * ax.y), pb = B.map((p) => p.x * ax.x + p.y * ax.y);
      if (Math.min(...pa) >= Math.max(...pb) || Math.min(...pb) >= Math.max(...pa)) return false;
    }
  }
  return true;
}

/**
 * The report. `joint` is the gap between neighbouring bricks (the mortar
 * joint, or a toy brick's 0.2 mm), so a seam can be told from a brick.
 */
export function bondReport(
  bricks: PlacedBrick[], joint: number,
  opts: {
    sides?: boolean;
    /** How far apart two perpends must be not to count as one on the other: the lap. Default a joint. */
    lap?: number;
    where?: { course: number; x: number; y: number }[];
  } = {},
): BondReport {
  const lap = opts.lap ?? joint + 1;
  // Across the joint, how far apart two marks can be and still be one crack:
  // within a leaf (the thinnest brick's depth).
  const leaf = Math.min(...bricks.map((b) => b.depthMm)) * 0.9;
  // Ends only for masonry: the joint between two leaves is what `pieces` is
  // about. Toy bricks are gripped all round, so a side seam counts too.
  const sideSeams = opts.sides ?? false;
  const byCourse = new Map<number, number[]>();
  bricks.forEach((b, k) => (byCourse.get(b.course) ?? byCourse.set(b.course, []).get(b.course)!).push(k));
  const quads = bricks.map((b) => corners(b, Math.max(0.5, joint / 4)));
  const parent = bricks.map((_, k) => k);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const first = Math.min(...byCourse.keys());

  let unsupported = 0, singleRest = 0, straightJoints = 0;
  // Seams of a course: the midpoints of the gaps where two bricks' ends meet.
  const seamsOf = (ks: number[]): (V2 & { dx: number; dy: number })[] => {
    const out: (V2 & { dx: number; dy: number })[] = [];
    for (const k of ks) {
      const b = bricks[k];
      const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) }, n = { x: -u.y, y: u.x };
      // The middle of each end and each side, just outside the brick.
      for (const [a, c] of sideSeams ? [[1, 0], [-1, 0], [0, 1], [0, -1]] : [[1, 0], [-1, 0]]) {
        const d = a !== 0 ? u : n;
        out.push({ x: b.x + u.x * a * (b.lengthMm / 2 + joint / 2) + n.x * c * (b.depthMm / 2 + joint / 2), y: b.y + u.y * a * (b.lengthMm / 2 + joint / 2) + n.y * c * (b.depthMm / 2 + joint / 2), dx: d.x, dy: d.y });
      }
    }
    return out;
  };
  const inside = (p: V2, k: number) => {
    const b = bricks[k];
    const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) };
    const dx = p.x - b.x, dy = p.y - b.y;
    return Math.abs(dx * u.x + dy * u.y) < b.lengthMm / 2 && Math.abs(-dx * u.y + dy * u.x) < b.depthMm / 2;
  };
  // A seam point is between two bricks: none on it, and one each side of it
  // across the joint. The end of a wall at an opening is not a seam.
  const isSeam = (p: V2 & { dx: number; dy: number }, ks: number[]) => {
    const near = ks.filter((k) => {
      const b = bricks[k];
      return Math.hypot(p.x - b.x, p.y - b.y) <= Math.max(b.lengthMm, b.depthMm) / 2 + joint * 2;
    });
    if (near.some((k) => inside(p, k))) return false;
    const reach = joint / 2 + 1;
    const a = { x: p.x + p.dx * reach, y: p.y + p.dy * reach }, b = { x: p.x - p.dx * reach, y: p.y - p.dy * reach };
    return near.some((k) => inside(a, k)) && near.some((k) => inside(b, k));
  };

  const courses = [...byCourse.keys()].sort((a, b) => a - b);
  for (let i = 0; i < courses.length; i++) {
    const here = byCourse.get(courses[i])!;
    const under = byCourse.get(courses[i] - 1) ?? [];
    for (const k of here) {
      const rests = under.filter((u) => overlap(quads[k], quads[u]));
      for (const u of rests) parent[find(u)] = find(k);
      if (courses[i] > first && under.length && !rests.length) unsupported++;
      if (rests.length === 1) {
        // Wholly on it: every corner of this brick inside the one below.
        const below = rests[0];
        if (corners(bricks[k], Math.max(0.5, joint / 4)).every((p) => inside(p, below))) singleRest++;
      }
    }
    if (!under.length) continue;
    // Perpends here that land on one below.
    // A straight joint is the same joint plane carried up: a joint facing the
    // other way through the same point (where an English quoin's closers
    // meet) only crosses it.
    const below = seamsOf(under).filter((p) => isSeam(p, under));
    // Along the course by less than the lap, across it by less than a leaf
    // (a header's joint is marked mid-wall, a stretcher's mid-leaf, 56 mm
    // apart on the same crack; the other leaf's joints are another matter).
    const sameJoint = (p: { x: number; y: number; dx: number; dy: number }, q: { x: number; y: number; dx: number; dy: number }) => {
      if (Math.abs(p.dx * q.dx + p.dy * q.dy) <= 0.9) return false;
      const ex = p.x - q.x, ey = p.y - q.y;
      const along = Math.abs(ex * p.dx + ey * p.dy), across = Math.abs(-ex * p.dy + ey * p.dx);
      return along < lap && across < leaf;
    };
    // Each seam once, though both bricks either side of it name it.
    const seen: V2[] = [];
    for (const p of seamsOf(here)) {
      if (seen.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < joint + 1)) continue;
      seen.push(p);
      if (!isSeam(p, here)) continue;
      if (below.some((q) => sameJoint(p, q))) { straightJoints++; opts.where?.push({ course: courses[i], x: Math.round(p.x), y: Math.round(p.y) }); }
    }
  }
  // Pieces that stand beside another in some course, within a couple of
  // joints: leaves with nothing tying them. A chimney on a slab stands alone.
  const beside = new Set<number>();
  for (const ks of byCourse.values()) {
    for (let i = 0; i < ks.length; i++) {
      for (let k = i + 1; k < ks.length; k++) {
        const a = find(ks[i]), b = find(ks[k]);
        if (a === b) continue;
        const A = bricks[ks[i]], B = bricks[ks[k]];
        if (Math.hypot(A.x - B.x, A.y - B.y) > (Math.max(A.lengthMm, A.depthMm) + Math.max(B.lengthMm, B.depthMm)) / 2 + 2 * joint) continue;
        if (overlap(corners(A, -2 * joint), corners(B, -2 * joint))) { beside.add(a); beside.add(b); }
      }
    }
  }
  return { pieces: new Set(bricks.map((_, k) => find(k))).size, sideBySide: Math.max(0, beside.size - 1), unsupported, straightJoints, singleRest };
}
