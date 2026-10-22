// ---------------------------------------------------------------------------
// Drawing on a face
// ---------------------------------------------------------------------------
//
// In a sketcher, an outline drawn on a face divides that face: the region
// inside the outline and the region outside it become two things, and each can
// be pushed or pulled on its own. The cage had no such rule. A face drawn on
// top of another simply shared its corners with it, so the two were welded
// wherever they touched — extrude the big one and the small one came along,
// because the corners it stood on had moved.
//
// This is that rule. Given the corners of a new face, it finds the face the new
// one lies in (same plane, every corner inside or on the boundary) and replaces
// that host with the part of it the new face does not cover. Two shapes of
// cover are handled: a BITE, where the new face shares a run of the host's
// boundary and the host simply loses that bite; and an ISLAND, where the new
// face floats inside the host and the host becomes a ring — cut into two
// polygons by a pair of bridges, because a cage face cannot have a hole.
// ---------------------------------------------------------------------------

import {
  addFace, coordOf, isCrease, removeFace, setCrease, cloneLattice, createLattice, extrudeFace, faceCount,
  isWatertight, latticeBounds, mergeLattice, separablePieces, vertexAt,
  type Axis, type Lattice, type LatticeCoord,
} from './latticeMesh';
import { latticeBoolean } from './latticeBoolean';

type Vec = [number, number, number];

/** Newell's normal, in whole numbers: exact for integer corners. */
function newell(points: LatticeCoord[]): Vec {
  let nx = 0, ny = 0, nz = 0;
  for (let a = 0; a < points.length; a++) {
    const [x1, y1, z1] = points[a];
    const [x2, y2, z2] = points[(a + 1) % points.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  return [nx, ny, nz];
}

/** The two axes to read a polygon in, given the axis its normal leans on. */
function planeAxes(normal: Vec): [0 | 1 | 2, 0 | 1 | 2] {
  const [ax, ay, az] = normal.map(Math.abs);
  if (az >= ax && az >= ay) return [0, 1];
  if (ay >= ax) return [0, 2];
  return [1, 2];
}

/** 0 outside, 1 inside, 2 on the boundary — for a point and a simple polygon, in 2D. */
function classify(p: [number, number], poly: [number, number][]): 0 | 1 | 2 {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    // On the segment: collinear and within its box.
    const cross = (xj - xi) * (p[1] - yi) - (yj - yi) * (p[0] - xi);
    if (cross === 0
      && p[0] >= Math.min(xi, xj) && p[0] <= Math.max(xi, xj)
      && p[1] >= Math.min(yi, yj) && p[1] <= Math.max(yi, yj)) return 2;
    if ((yi > p[1]) !== (yj > p[1])) {
      const x = xi + ((p[1] - yi) * (xj - xi)) / (yj - yi);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside ? 1 : 0;
}

/** Inserts corners along the edge u→w into every face but `except` that runs along it. */
function spliceIntoNeighbours(lattice: Lattice, except: number, u: number, w: number, between: number[]) {
  for (let f = 0; f < lattice.faces.length; f++) {
    if (f === except) continue;
    const verts = lattice.faces[f];
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      if (!((a === u && b === w) || (a === w && b === u))) continue;
      const insert = a === u ? between : [...between].reverse();
      const ring = [...verts.slice(0, i + 1), ...insert, ...verts.slice(i + 1)];
      const sharp: [number, number][] = [];
      for (let k = 0; k < verts.length; k++) {
        const p = verts[k]; const q = verts[(k + 1) % verts.length];
        if (isCrease(lattice, p, q)) sharp.push([p, q]);
      }
      // A crease along the edge being split carries on along its parts.
      const edgeSharp = isCrease(lattice, u, w);
      const added = addFace(lattice, ring);
      removeFace(lattice, f);
      if (added === -1) break;
      for (const [p, q] of sharp) setCrease(lattice, p, q, true);
      if (edgeSharp) {
        const chain = [u, ...between, w];
        for (let k = 1; k < chain.length; k++) setCrease(lattice, chain[k - 1], chain[k], true);
      }
      break;
    }
  }
}

/**
 * The face `inner` lies in, if it lies in one.
 *
 * Same plane exactly — integer corners, integer normal, no tolerance — and
 * every corner of the new face inside the host or on its boundary. A face
 * that is the host itself, or shares all its corners with it, is not a face
 * drawn ON the host and is left alone.
 */
export function hostFaceOf(lattice: Lattice, inner: number[]): number | null {
  const innerPts = inner.map((v) => coordOf(lattice, v));
  const innerSet = new Set(inner);
  for (let f = 0; f < lattice.faces.length; f++) {
    const verts = lattice.faces[f];
    if (!verts || verts.length < 3) continue;
    if (verts.every((v) => innerSet.has(v)) && inner.every((v) => verts.includes(v))) continue;
    const pts = verts.map((v) => coordOf(lattice, v));
    const n = newell(pts);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
    const p0 = pts[0];
    const coplanar = innerPts.every((p) =>
      n[0] * (p[0] - p0[0]) + n[1] * (p[1] - p0[1]) + n[2] * (p[2] - p0[2]) === 0);
    if (!coplanar) continue;
    const [u, w] = planeAxes(n);
    const poly = pts.map((p) => [p[u], p[w]] as [number, number]);
    const within = inner.every((v, i) => innerSet.has(v) && (verts.includes(v) || classify([innerPts[i][u], innerPts[i][w]], poly) !== 0));
    if (within) return f;
  }
  return null;
}

/** Candidate vertices that lie strictly inside segment u→w, ordered from u to w. */
function pointsOnSegment(lattice: Lattice, u: number, w: number, candidates: number[], skip: Set<number>): number[] {
  const pu = coordOf(lattice, u);
  const pw = coordOf(lattice, w);
  const e = [pw[0] - pu[0], pw[1] - pu[1], pw[2] - pu[2]];
  const len2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  if (len2 === 0) return [];
  const onEdge: { v: number; t: number }[] = [];
  for (const v of candidates) {
    if (v === u || v === w || skip.has(v)) continue;
    const p = coordOf(lattice, v);
    const d = [p[0] - pu[0], p[1] - pu[1], p[2] - pu[2]];
    const cross = [e[1] * d[2] - e[2] * d[1], e[2] * d[0] - e[0] * d[2], e[0] * d[1] - e[1] * d[0]];
    if (cross[0] !== 0 || cross[1] !== 0 || cross[2] !== 0) continue;
    const t = e[0] * d[0] + e[1] * d[1] + e[2] * d[2];
    if (t > 0 && t < len2) onEdge.push({ v, t });
  }
  onEdge.sort((a, b) => a.t - b.t);
  return onEdge.map((o) => o.v);
}

/**
 * Cuts the host face around a new face drawn on it, and gives back the new
 * face's corners wound the same way as the host — so the pieces and the new
 * face agree about which side is out, which is what lets any of them be
 * extruded afterwards without the others coming along.
 *
 * Returns null, and changes nothing, when the new face is not on a face.
 */
export function splitHostAround(lattice: Lattice, inner: number[]): { host: number; pieces: number[]; inner: number[] } | null {
  const host = hostFaceOf(lattice, inner);
  if (host === null) return null;
  const hostN = newell(lattice.faces[host]!.map((v) => coordOf(lattice, v)));
  let I = [...inner];
  /*
   * The host's boundary, with any corner of the new face that sits ON one of
   * its edges spliced in where it sits. A face drawn from corner to corner of
   * the host, with its far corners halfway along the host's sides, touches
   * the host along a run that includes those halfway points; unless they are
   * corners of the host too, the piece left behind gets built with the
   * host's original corners in it, doubled back along its own sides.
   */
  const H: number[] = [];
  const original = lattice.faces[host]!;
  const originalSet = new Set(original);
  const pos = (v: number) => coordOf(lattice, v);
  const neighbourSplices: { u: number; w: number; between: number[] }[] = [];
  for (let i = 0; i < original.length; i++) {
    const u = original[i];
    const w = original[(i + 1) % original.length];
    H.push(u);
    const between = pointsOnSegment(lattice, u, w, inner, originalSet);
    for (const v of between) H.push(v);
    if (between.length > 0) neighbourSplices.push({ u, w, between });
  }
  const innerN = newell(I.map((v) => coordOf(lattice, v)));
  if (hostN[0] * innerN[0] + hostN[1] * innerN[1] + hostN[2] * innerN[2] < 0) I = I.reverse();

  // If an edge of the new face passes straight through a corner of the host
  // that was not explicitly clicked, splice that corner into I too so the two
  // boundaries know they meet there.
  const iSet = new Set(I);
  const splicedI: number[] = [];
  for (let i = 0; i < I.length; i++) {
    const u = I[i];
    const w = I[(i + 1) % I.length];
    splicedI.push(u);
    for (const v of pointsOnSegment(lattice, u, w, H, iSet)) {
      splicedI.push(v);
      iSet.add(v);
    }
  }
  I = splicedI;

  const shared = H.filter((v) => I.includes(v));
  const hostRun = (from: number, to: number) => {
    const out = [H[from]];
    for (let k = from; k !== to; k = (k + 1) % H.length) out.push(H[(k + 1) % H.length]);
    return out;
  };
  const islandBack = (from: number, to: number) => {
    const out = [I[from]];
    for (let k = from; k !== to; k = (k - 1 + I.length) % I.length) out.push(I[(k - 1 + I.length) % I.length]);
    return out;
  };
  const innerRun = (from: number, to: number) => {
    const out = [I[from]];
    for (let k = from; k !== to; k = (k + 1) % I.length) out.push(I[(k + 1) % I.length]);
    return out;
  };

  let pieces: number[][] | null = null;

  if (shared.length >= 2) {
    // Partition both H and I into arcs between consecutive shared vertices.
    // Every arc where I leaves H's boundary cuts off a simple polygon piece
    // bounded by H's arc forward and I's arc reversed. This handles single
    // contiguous bites, strips across the middle of a face, corner cuts, and
    // inscribed polygons touching multiple edges at single vertices.
    const sharedSet = new Set(shared);
    const built: number[][] = [];
    let valid = true;
    for (let m = 0; m < shared.length; m++) {
      const sA = shared[m];
      const sB = shared[(m + 1) % shared.length];
      const hArc = hostRun(H.indexOf(sA), H.indexOf(sB));
      const iArc = innerRun(I.indexOf(sA), I.indexOf(sB));
      // Shared vertices must appear in the same cyclic order around I and H.
      if (iArc.slice(1, -1).some((v) => sharedSet.has(v))) {
        valid = false;
        break;
      }
      if (hArc.length === iArc.length && hArc.every((v, idx) => v === iArc[idx])) continue;
      built.push([...hArc, ...iArc.slice(1, -1).reverse()]);
    }
    if (valid && built.length > 0) pieces = built;
  } else if (shared.length === 1) {
    // Pinched ring: I touches H at a single corner, which already acts as one
    // bridge; one bridge on the far side of I cuts the ring into two polygons.
    const d2 = (a: number, b: number) => {
      const p = pos(a); const q = pos(b);
      return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    };
    const h1 = H.indexOf(shared[0]);
    const i1 = I.indexOf(shared[0]);
    const i2 = (i1 + Math.floor(I.length / 2)) % I.length;
    let h2 = -1, best = Infinity;
    H.forEach((hv, h) => { if (h === h1) return; const d = d2(I[i2], hv); if (d < best) { best = d; h2 = h; } });
    if (h2 !== -1 && i2 !== i1) {
      pieces = [
        [...hostRun(h1, h2), ...islandBack(i2, i1).slice(0, -1)],
        [...hostRun(h2, h1), ...islandBack(i1, i2).slice(1)],
      ];
    }
  } else if (shared.length === 0) {
    // An island. Two bridges from the island to the host, at the nearest
    // corner and at the far side of the island from it, cut the ring into two
    // polygons a cage can hold.
    const d2 = (a: number, b: number) => {
      const p = pos(a); const q = pos(b);
      return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
    };
    let i1 = 0, h1 = 0, best = Infinity;
    I.forEach((iv, i) => H.forEach((hv, h) => { const d = d2(iv, hv); if (d < best) { best = d; i1 = i; h1 = h; } }));
    const i2 = (i1 + Math.floor(I.length / 2)) % I.length;
    let h2 = -1; best = Infinity;
    H.forEach((hv, h) => { if (h === h1) return; const d = d2(I[i2], hv); if (d < best) { best = d; h2 = h; } });
    if (h2 !== -1) {
      pieces = [
        [...hostRun(h1, h2), ...islandBack(i2, i1)],
        [...hostRun(h2, h1), ...islandBack(i1, i2)],
      ];
    }
  }
  if (!pieces || pieces.some((p) => p.length < 3 || new Set(p).size !== p.length)) return null;

  // The face on the other side of any split boundary edge has to know about the
  // new corners too, or the edge is one segment on its side and two on this
  // one — a crack, and a shape that is no longer watertight.
  for (const { u, w, between } of neighbourSplices) {
    spliceIntoNeighbours(lattice, host, u, w, between);
  }

  // Sharp edges of the host stay sharp on whichever piece keeps them: the
  // pieces go in first so the creases still have an edge to live on when the
  // host goes.
  const sharp: [number, number][] = [];
  for (let i = 0; i < H.length; i++) {
    const a = H[i]; const b = H[(i + 1) % H.length];
    if (isCrease(lattice, a, b)) sharp.push([a, b]);
  }
  const added = pieces.map((p) => addFace(lattice, p)).filter((f) => f !== -1);
  removeFace(lattice, host);
  for (const [a, b] of sharp) setCrease(lattice, a, b, true);
  return { host, pieces: added, inner: I };
}

/**
 * Splits a host face in two along an open chain (a 2-point line or multi-point
 * polyline/curve) drawn across it from one point on its boundary to another.
 *
 * Any leading or trailing segments that run along the host's boundary before
 * the chain enters the interior are trimmed first, so drawing a corner box by
 * starting at the corner, clicking out along one edge, into the face, and onto
 * the adjacent edge splits the corner cleanly on the final click.
 *
 * Returns null, and changes nothing, when the chain is not a chord across a face.
 */
export function splitHostByChord(lattice: Lattice, chain: number[]): { host: number; pieces: number[] } | null {
  if (chain.length < 2 || new Set(chain).size !== chain.length) return null;
  const host = hostFaceOf(lattice, chain);
  if (host === null) return null;
  const original = lattice.faces[host]!;
  const pts = original.map((v) => coordOf(lattice, v));
  const hostN = newell(pts);
  const [uAxis, wAxis] = planeAxes(hostN);
  const poly = pts.map((p) => [p[uAxis], p[wAxis]] as [number, number]);
  const pt2d = (v: number): [number, number] => {
    const c = coordOf(lattice, v);
    return [c[uAxis], c[wAxis]];
  };
  const onBoundary = (v: number) => original.includes(v) || classify(pt2d(v), poly) === 2;
  const segInside = (a: number, b: number) => {
    const pa = pt2d(a); const pb = pt2d(b);
    return classify([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], poly) === 1;
  };

  // Trim any leading/trailing boundary-hugging segments so we are left with the
  // chord that actually crosses the interior of the host face.
  let start = 0;
  while (start + 1 < chain.length && onBoundary(chain[start]) && onBoundary(chain[start + 1]) && !segInside(chain[start], chain[start + 1])) {
    start++;
  }
  let end = chain.length - 1;
  while (end - 1 > start && onBoundary(chain[end]) && onBoundary(chain[end - 1]) && !segInside(chain[end - 1], chain[end])) {
    end--;
  }
  const chord = chain.slice(start, end + 1);
  if (chord.length < 2) return null;
  if (!onBoundary(chord[0]) || !onBoundary(chord[chord.length - 1])) return null;
  for (let i = 1; i < chord.length - 1; i++) {
    if (classify(pt2d(chord[i]), poly) !== 1) return null;
  }
  for (let i = 0; i < chord.length - 1; i++) {
    if (!segInside(chord[i], chord[i + 1])) return null;
  }

  const originalSet = new Set(original);
  const endpoints = [chord[0], chord[chord.length - 1]];
  const H: number[] = [];
  const neighbourSplices: { u: number; w: number; between: number[] }[] = [];
  for (let i = 0; i < original.length; i++) {
    const u = original[i];
    const w = original[(i + 1) % original.length];
    H.push(u);
    const between = pointsOnSegment(lattice, u, w, endpoints, originalSet);
    for (const v of between) H.push(v);
    if (between.length > 0) neighbourSplices.push({ u, w, between });
  }

  const hStart = H.indexOf(chord[0]);
  const hEnd = H.indexOf(chord[chord.length - 1]);
  if (hStart === -1 || hEnd === -1 || hStart === hEnd) return null;

  const hostRun = (from: number, to: number) => {
    const out = [H[from]];
    for (let k = from; k !== to; k = (k + 1) % H.length) out.push(H[(k + 1) % H.length]);
    return out;
  };
  const interior = chord.slice(1, -1);
  const pieces = [
    [...hostRun(hStart, hEnd), ...[...interior].reverse()],
    [...hostRun(hEnd, hStart), ...interior],
  ];
  if (pieces.some((p) => p.length < 3 || new Set(p).size !== p.length)) return null;
  if (pieces.some((p) => {
    const n = newell(p.map((v) => coordOf(lattice, v)));
    return n[0] * hostN[0] + n[1] * hostN[1] + n[2] * hostN[2] <= 0;
  })) return null;

  for (const { u, w, between } of neighbourSplices) {
    spliceIntoNeighbours(lattice, host, u, w, between);
  }
  const sharp: [number, number][] = [];
  for (let i = 0; i < H.length; i++) {
    const a = H[i]; const b = H[(i + 1) % H.length];
    if (isCrease(lattice, a, b)) sharp.push([a, b]);
  }
  const added = pieces.map((p) => addFace(lattice, p)).filter((f) => f !== -1);
  removeFace(lattice, host);
  for (const [a, b] of sharp) setCrease(lattice, a, b, true);
  return { host, pieces: added };
}

/**
 * Fuses the cage wherever two of its faces lie flat against each other,
 * facing opposite ways — the wall an extrusion just pushed into the far side
 * of the same body, or the cap it left flush against another part of it.
 *
 * Nothing about a cage stops one part of it being pushed into another; the
 * corners are integers and every face still has its neighbours. What went
 * wrong was that nothing HAPPENED either: the cap sat inside the other face,
 * both drawn, both still whole, and pulling the outer one pulled the cap's
 * corners with it. A solid touching itself has no surface there. So: where a
 * face lies inside a face that faces back at it, the bigger one is cut around
 * the smaller one's footprint and both facing faces go, which leaves the two
 * parts one part with an opening between them. Faces that only partly overlap
 * are left alone — that needs a polygon clipper, and a wrong cut is worse than
 * none. Returns how many pairs were fused.
 */
export function fuseFlushFaces(lattice: Lattice): number {
  let fused = 0;
  for (;;) {
    const pair = findFlushPair(lattice);
    if (!pair) return fused;
    const { small, big, identical } = pair;
    const smallVerts = [...lattice.faces[small]!];
    if (identical) {
      removeFace(lattice, small);
      removeFace(lattice, big);
    } else {
      // The small face is taken out first so it cannot be found as its own
      // host, then the big one is cut around where it was.
      removeFace(lattice, small);
      const split = splitHostAround(lattice, smallVerts);
      if (!split) {
        // Could not be cut (a corner touching the host boundary in a way the
        // splitter does not handle): put the small face back and stop, rather
        // than loop on it forever.
        addFace(lattice, smallVerts);
        return fused;
      }
    }
    fused++;
  }
}

function findFlushPair(lattice: Lattice): { small: number; big: number; identical: boolean } | null {
  const faces = lattice.faces;
  for (let f = 0; f < faces.length; f++) {
    const F = faces[f];
    if (!F || F.length < 3) continue;
    const fPts = F.map((v) => coordOf(lattice, v));
    const fN = newell(fPts);
    if (fN[0] === 0 && fN[1] === 0 && fN[2] === 0) continue;
    const [u, w] = planeAxes(fN);
    const fPoly = fPts.map((p) => [p[u], p[w]] as [number, number]);
    for (let g = 0; g < faces.length; g++) {
      if (g === f) continue;
      const G = faces[g];
      if (!G || G.length < 3) continue;
      const gPts = G.map((v) => coordOf(lattice, v));
      const gN = newell(gPts);
      // Facing back at F, and in F's plane, exactly.
      if (fN[0] * gN[0] + fN[1] * gN[1] + fN[2] * gN[2] >= 0) continue;
      const p0 = fPts[0];
      if (!gPts.every((p) => fN[0] * (p[0] - p0[0]) + fN[1] * (p[1] - p0[1]) + fN[2] * (p[2] - p0[2]) === 0)) continue;
      const sameCorners = F.length === G.length && G.every((v) => F.includes(v));
      if (sameCorners) return { small: g, big: f, identical: true };
      // G inside F: every corner of G on or inside F's outline.
      const gInF = G.every((v, i) => F.includes(v) || classify([gPts[i][u], gPts[i][w]], fPoly) !== 0);
      if (gInF) return { small: g, big: f, identical: false };
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Pushing one part of a body through another
// ---------------------------------------------------------------------------
//
// Flush contact, above, is the easy case: the faces line up and the cut is
// exact. Past flush, the extruded part runs INTO the other, and there is no
// face to cut around — the two volumes overlap. That is a boolean. An extrude
// is, precisely, the body united with the prism the face sweeps out (or, pushed
// inward, the body with that prism taken away, which is how a face pushed in
// through the far side becomes a hole). So when an extrusion's new faces are
// found crossing the body's old ones, the plain extrude is thrown away and the
// boolean is done instead, with the prism built from the face as it was.
// ---------------------------------------------------------------------------

/**
 * Whether any edge of one set of faces passes through the inside of a face in
 * the other set: the edge has to have an end strictly on each side of the
 * face's plane, and cross it inside or on the outline. Checked both ways
 * round.
 */
export function facesCross(lattice: Lattice, someFaces: number[], otherFaces: number[]): boolean {
  const pts = (f: number) => lattice.faces[f]!.map((v) => coordOf(lattice, v));
  const crosses = (edges: number[], faces: number[]) => {
    const polys = faces.map((f) => {
      const p = pts(f);
      const n = newell(p);
      const [u, w] = planeAxes(n);
      return { n, p0: p[0], u, w, poly: p.map((q) => [q[u], q[w]] as [number, number]) };
    });
    for (const f of edges) {
      const ring = lattice.faces[f]!;
      for (let i = 0; i < ring.length; i++) {
        const a = coordOf(lattice, ring[i]);
        const b = coordOf(lattice, ring[(i + 1) % ring.length]);
        for (const { n, p0, u, w, poly } of polys) {
          const sa = n[0] * (a[0] - p0[0]) + n[1] * (a[1] - p0[1]) + n[2] * (a[2] - p0[2]);
          const sb = n[0] * (b[0] - p0[0]) + n[1] * (b[1] - p0[1]) + n[2] * (b[2] - p0[2]);
          if ((sa > 0 && sb > 0) || (sa < 0 && sb < 0) || sa === 0 || sb === 0) continue;
          const t = sa / (sa - sb);
          const x: [number, number] = [a[u] + (b[u] - a[u]) * t, a[w] + (b[w] - a[w]) * t];
          // On the outline counts: a prism the same size as the face it
          // enters runs its edges exactly along that face's edges, and that
          // is as much inside as any. A union that was not needed costs a
          // moment; one that was missed leaves the overlap in the model.
          if (classify(x, poly) !== 0) return true;
        }
      }
    }
    return false;
  };
  return crosses(someFaces, otherFaces) || crosses(otherFaces, someFaces);
}

/** The closed prism a face sweeps out when extruded, as a cage of its own. */
export function prismOf(lattice: Lattice, face: number, steps: number, axis?: Axis): Lattice | null {
  const ring = lattice.faces[face];
  if (!ring || steps === 0) return null;
  const prism = createLattice(lattice.unit);
  const verts = ring.map((v) => { const [i, j, k] = coordOf(lattice, v); return vertexAt(prism, i, j, k); });
  const floor = addFace(prism, verts);
  if (floor === -1) return null;
  if (!extrudeFace(prism, floor, steps, axis)) return null;
  return isWatertight(prism) ? prism : null;
}

/**
 * The seams on the body that a boolean must leave alone: every edge where two
 * faces lie flat against each other in one plane, unless it dead-ends at the
 * face being extruded.
 *
 * Those are the splits somebody drew — a line across a face is a seam from one
 * fold of the body to another, and merging it away on the next push would
 * undo it. The ones left out are the bridges splitHostAround cuts from a host
 * face to a shape drawn inside it, because a face cannot have a hole: they run
 * from the host's edge to a corner of the drawn shape and nowhere else, and
 * once that shape is pushed in or out they are scaffolding the merge should
 * clear. Seams are followed as chains between folds and junctions, so a drawn
 * line made of several segments is kept or left whole.
 */
export function existingCoplanarSeams(lattice: Lattice, exceptFace: number): [Vec, Vec][] {
  const faces = lattice.faces;
  const normals = faces.map((F) => {
    if (!F || F.length < 3) return null;
    const n = newell(F.map((v) => coordOf(lattice, v)));
    const l = Math.hypot(n[0], n[1], n[2]);
    return l === 0 ? null : [n[0] / l, n[1] / l, n[2] / l];
  });
  const edgeFaces = new Map<string, { a: number; b: number; faces: number[] }>();
  faces.forEach((F, f) => {
    if (!F || F.length < 3) return;
    for (let i = 0; i < F.length; i++) {
      const a = F[i];
      const b = F[(i + 1) % F.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = edgeFaces.get(key);
      if (entry) entry.faces.push(f);
      else edgeFaces.set(key, { a, b, faces: [f] });
    }
  });

  // Folds: where the body turns a corner (or is open). A seam that reaches one
  // has reached the edge of the flat region it divides.
  const fold = new Set<number>();
  const seamsAt = new Map<number, string[]>();
  for (const [key, { a, b, faces: fs }] of edgeFaces) {
    const [f, g] = fs;
    const nf = normals[f];
    const ng = g === undefined ? null : normals[g];
    const flat = fs.length === 2 && !!nf && !!ng && nf[0] * ng[0] + nf[1] * ng[1] + nf[2] * ng[2] >= 0.999999;
    if (!flat) { fold.add(a); fold.add(b); continue; }
    if (f === exceptFace || g === exceptFace) continue;
    for (const v of [a, b]) {
      const list = seamsAt.get(v);
      if (list) list.push(key);
      else seamsAt.set(v, [key]);
    }
  }
  const extruded = new Set(faces[exceptFace] ?? []);
  const stopsAt = (v: number) => fold.has(v) || (seamsAt.get(v)?.length ?? 0) !== 2;

  const edgeOther = (key: string, v: number) => {
    const { a, b } = edgeFaces.get(key)!;
    return a === v ? b : a;
  };
  /*
   * Whether a seam arriving at `v` from `from` carries straight on, along any
   * edge, to a fold. A drawn line that ends on the extruded face's rim — a
   * second line run up to the first, with the corner between them the one
   * being pushed — does: the rest of the first line goes on in the same
   * direction. A bridge meets the drawn shape at an angle and stops.
   */
  const neighbours = new Map<number, number[]>();
  for (const { a, b } of edgeFaces.values()) {
    (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a);
  }
  const reachesFold = (v: number, from: number): boolean => {
    let prev = from;
    let here = v;
    for (let guard = 0; guard < faces.length + 4; guard++) {
      if (fold.has(here)) return true;
      const p = coordOf(lattice, prev);
      const h = coordOf(lattice, here);
      const d = [h[0] - p[0], h[1] - p[1], h[2] - p[2]];
      const next = (neighbours.get(here) ?? []).find((n) => {
        if (n === prev) return false;
        const c = coordOf(lattice, n);
        const e = [c[0] - h[0], c[1] - h[1], c[2] - h[2]];
        const cross = [d[1] * e[2] - d[2] * e[1], d[2] * e[0] - d[0] * e[2], d[0] * e[1] - d[1] * e[0]];
        return cross[0] === 0 && cross[1] === 0 && cross[2] === 0 && d[0] * e[0] + d[1] * e[1] + d[2] * e[2] > 0;
      });
      if (next === undefined) return false;
      prev = here;
      here = next;
    }
    return false;
  };

  const out: [Vec, Vec][] = [];
  const seen = new Set<string>();
  for (const [start] of seamsAt) {
    for (const first of seamsAt.get(start)!) {
      if (seen.has(first) || !stopsAt(start)) continue;
      // Walk from a stopping vertex along the chain to the next one.
      const chain: string[] = [];
      let at = start;
      let key = first;
      for (;;) {
        seen.add(key);
        chain.push(key);
        const { a, b } = edgeFaces.get(key)!;
        at = a === at ? b : a;
        if (stopsAt(at)) break;
        const next = seamsAt.get(at)!.find((k) => k !== key)!;
        if (seen.has(next)) break;
        key = next;
      }
      const ends: [number, number][] = [
        [start, edgeOther(first, start)],
        [at, edgeOther(key, at)],
      ];
      if (ends.some(([v, from]) => extruded.has(v) && !reachesFold(v, from))) continue;
      for (const k of chain) {
        const { a, b } = edgeFaces.get(k)!;
        out.push([coordOf(lattice, a) as Vec, coordOf(lattice, b) as Vec]);
      }
    }
  }
  return out;
}

/**
 * The body after extruding `face` by `steps`, where the extrusion runs into
 * the body itself — or null when it does not, and the plain extrude stands.
 *
 * `before` is the body as it was, untouched. The plain extrude is tried on a
 * copy; if none of its new faces cross the old ones there is nothing to
 * resolve. Otherwise the answer is the boolean: body ∪ prism pushed out,
 * body − prism pushed in. Refused (null) when the body is not closed, since
 * a boolean of an open shell means nothing.
 */
export function resolveExtrusion(before: Lattice, face: number, steps: number, axis?: Axis): Lattice | null {
  if (steps === 0 || !before.faces[face]) return null;
  const trial = cloneLattice(before);
  const made = extrudeFace(trial, face, steps, axis);
  if (!made) return null;
  const fresh = [made.cap, ...made.sides];
  const old = trial.faces.map((f, i) => (f && !fresh.includes(i) && i !== made.floor ? i : -1)).filter((i) => i !== -1);
  if (!facesCross(trial, fresh, old)) return null;
  if (!isWatertight(before)) return null;
  const prism = prismOf(before, face, steps, axis);
  if (!prism) return null;
  return latticeBoolean(before, prism, steps > 0 ? 'union' : 'difference', existingCoplanarSeams(before, face));
}

/**
 * Unites separate pieces of one cage whose volumes overlap, so a piece moved
 * into another becomes part of it. Pieces that merely sit near each other are
 * left as they are: only pairs whose bounding boxes properly overlap are
 * tried, and only closed ones, since the boolean refuses the rest. Returns
 * the rebuilt cage, or null when nothing needed doing.
 */
export function unionOverlappingPieces(lattice: Lattice): Lattice | null {
  const pieces = separablePieces(lattice);
  if (pieces.length < 2) return null;
  let changed = false;
  const overlaps = (a: Lattice, b: Lattice) => {
    const ba = latticeBounds(a); const bb = latticeBounds(b);
    if (!ba || !bb) return false;
    return [0, 1, 2].every((k) => ba.min[k] < bb.max[k] && bb.min[k] < ba.max[k]);
  };
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (!overlaps(pieces[i], pieces[j])) continue;
      if (!isWatertight(pieces[i]) || !isWatertight(pieces[j])) continue;
      const joined = latticeBoolean(pieces[i], pieces[j], 'union');
      if (!joined || faceCount(joined) === 0) continue;
      pieces[i] = joined;
      pieces.splice(j, 1);
      changed = true;
      j = i; // start this row again: the joined piece may now overlap another
    }
  }
  if (!changed) return null;
  const out = createLattice(lattice.unit);
  for (const piece of pieces) mergeLattice(out, piece, (c) => c);
  return out;
}
