// ---------------------------------------------------------------------------
// Marching squares — the contours of a scalar field
// ---------------------------------------------------------------------------
//
// Two quite different operations in this app need the same thing: the closed
// curves along which some quantity on a grid holds a constant value.
//
// V-carving needs the contours of a distance field, because a contour of
// constant distance from a letter's edge is a path along which the V bit sits
// at a constant depth. Adaptive roughing needs the contours of the same kind of
// field over the region it is clearing, because those are the concentric rings
// it walks inward along. Both are marching squares, so it lives here rather
// than inside either of them.

import type { Point2D } from './laserCutExporter';

/**
 * Which pairs of cell edges each marching-squares case joins.
 *
 * Edges are numbered from the top edge clockwise: 0 top, 1 right, 2 bottom,
 * 3 left. The case index has a bit per corner, in the same order — top-left,
 * top-right, bottom-right, bottom-left — set when that corner is inside.
 *
 * The two ambiguous cases, 5 and 10, are the ones where two opposite corners
 * are inside and the other two are not: the contour can either pinch the middle
 * or pass through it, and the cell alone does not say which. They are resolved
 * against the average of the four corners, which is the usual reading and the
 * one that keeps a diagonal stroke connected instead of beading up into a
 * dotted line.
 */
const CASE_EDGES: number[][] = [
  [],            // 0
  [3, 0],        // 1
  [0, 1],        // 2
  [3, 1],        // 3
  [1, 2],        // 4
  [],            // 5  — resolved below
  [0, 2],        // 6
  [3, 2],        // 7
  [2, 3],        // 8
  [2, 0],        // 9
  [],            // 10 — resolved below
  [2, 1],        // 11
  [1, 3],        // 12
  [1, 0],        // 13
  [0, 3],        // 14
  [],            // 15
];

/** A crossing: where the contour cuts a grid edge, and which edge it is. */
interface Crossing {
  p: Point2D;
  /**
   * The grid edge, as an integer: `2 * (r * cols + c)` for the edge running
   * right from pixel (c, r), plus one for the edge running down from it. Two
   * cells sharing an edge name it alike, so segment ends are joined by this
   * rather than by their coordinates. Joining by quantised coordinates both
   * split crossings that should meet (a last-bit difference across a rounding
   * boundary) and merged ones that should not (two crossings near the same
   * corner), and either way the loop failed to close and was dropped.
   */
  edge: number;
}

/**
 * The closed contours of `field` at a given level, in grid coordinates.
 *
 * Grid coordinates means pixel indices with fractional parts, so (2.5, 7) is
 * halfway between the pixels at column 2 and column 3 on row 7. Converting to
 * millimetres is the caller's business, because only the caller knows where the
 * grid sits on the stock.
 */
export function isoContours(
  field: Float32Array,
  cols: number,
  rows: number,
  level: number,
  /**
   * An edge rising more than this is a step, not a slope: crossed half way
   * along rather than where a straight line between its ends would put the
   * level. A heightmap's wall stands somewhere between its two samples, and
   * read as a ramp a contour near its foot lies against the low sample and
   * one near its top against the high, so the levels of a waterline lean a
   * cell out of true down every wall. Off by default.
   */
  stepRise = Infinity
): Point2D[][] {
  const segments: [Crossing, Crossing][] = [];
  const at = (c: number, r: number) => field[r * cols + c];

  // Interpolated crossing along an edge, so the contour is smooth rather than
  // stepped at pixel boundaries.
  const lerp = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): Point2D => {
    const denom = v1 - v0;
    const t = Math.abs(denom) < 1e-12 || Math.abs(denom) > stepRise ? 0.5 : (level - v0) / denom;
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    return { x: x0 + (x1 - x0) * clamped, y: y0 + (y1 - y0) * clamped };
  };

  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const va = at(c, r);
      const vb = at(c + 1, r);
      const vc = at(c + 1, r + 1);
      const vd = at(c, r + 1);

      const idx =
        (va >= level ? 1 : 0) |
        (vb >= level ? 2 : 0) |
        (vc >= level ? 4 : 0) |
        (vd >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;

      // Every edge is interpolated in the same direction, left to right or top
      // to bottom, so both cells that share it compute the same point.
      const edgePoint = (e: number): Crossing => {
        const h = 2 * (r * cols + c);
        switch (e) {
          case 0: return { p: lerp(c, r, va, c + 1, r, vb), edge: h };
          case 1: return { p: lerp(c + 1, r, vb, c + 1, r + 1, vc), edge: h + 3 };
          case 2: return { p: lerp(c, r + 1, vd, c + 1, r + 1, vc), edge: h + 2 * cols };
          default: return { p: lerp(c, r, va, c, r + 1, vd), edge: h + 1 };
        }
      };
      let pairs: number[][];
      if (idx === 5 || idx === 10) {
        const centre = (va + vb + vc + vd) / 4;
        const joined = centre >= level;
        if (idx === 5) pairs = joined ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
        else pairs = joined ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      } else {
        pairs = [CASE_EDGES[idx]];
      }

      for (const pair of pairs) {
        if (pair.length !== 2) continue;
        segments.push([edgePoint(pair[0]), edgePoint(pair[1])]);
      }
    }
  }

  return chainSegments(segments);
}

/**
 * Joins loose segments into closed loops.
 *
 * Marching squares emits each cell's piece of the contour independently, so
 * what comes out is a heap of two-point segments that happen to share
 * endpoints. Following those shared endpoints from segment to segment recovers
 * the loops. Anything that fails to close — which happens only where a contour
 * runs off the edge of the grid — is dropped, since an open path is not
 * something the tool can be sent around.
 */
function chainSegments(segments: [Crossing, Crossing][]): Point2D[][] {
  const starts = new Map<number, number[]>();
  const used = new Array(segments.length).fill(false);

  segments.forEach((seg, i) => {
    for (const end of [0, 1]) {
      const k = seg[end].edge;
      const list = starts.get(k);
      if (list) list.push(i);
      else starts.set(k, [i]);
    }
  });

  const loops: Point2D[][] = [];

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;

    const loop: Crossing[] = [segments[i][0], segments[i][1]];
    const startKey = segments[i][0].edge;

    for (;;) {
      const k = loop[loop.length - 1].edge;
      if (k === startKey && loop.length > 2) break; // closed

      const candidates = starts.get(k) ?? [];
      let advanced = false;
      for (const j of candidates) {
        if (used[j]) continue;
        const seg = segments[j];
        used[j] = true;
        loop.push(seg[0].edge === k ? seg[1] : seg[0]);
        advanced = true;
        break;
      }
      if (!advanced) break;
    }

    // Closed loops only. An open chain means the contour left the grid.
    if (loop.length >= 4 && loop[0].edge === loop[loop.length - 1].edge) {
      loop.pop();
      // A level that lands exactly on a pixel puts the crossings of both
      // edges meeting there on that pixel; keep one of them.
      const points: Point2D[] = [];
      for (const { p } of loop) {
        const last = points[points.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) points.push(p);
      }
      while (points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y) points.pop();
      if (points.length >= 3) loops.push(points);
    }
  }

  return loops;
}
