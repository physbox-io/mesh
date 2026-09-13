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
    if (inner.every((v) => verts.includes(v))) continue;
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
  const pos = (v: number) => coordOf(lattice, v);
  for (let i = 0; i < original.length; i++) {
    const u = original[i];
    const w = original[(i + 1) % original.length];
    H.push(u);
    const pu = pos(u); const pw = pos(w);
    const e = [pw[0] - pu[0], pw[1] - pu[1], pw[2] - pu[2]];
    const len2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
    const onEdge: { v: number; t: number }[] = [];
    for (const v of inner) {
      if (original.includes(v)) continue;
      const p = pos(v);
      const d = [p[0] - pu[0], p[1] - pu[1], p[2] - pu[2]];
      const cross = [e[1] * d[2] - e[2] * d[1], e[2] * d[0] - e[0] * d[2], e[0] * d[1] - e[1] * d[0]];
      if (cross[0] !== 0 || cross[1] !== 0 || cross[2] !== 0) continue;
      const t = e[0] * d[0] + e[1] * d[1] + e[2] * d[2];
      if (t > 0 && t < len2) onEdge.push({ v, t });
    }
    onEdge.sort((a, b) => a.t - b.t);
    for (const { v } of onEdge) H.push(v);
    // The face on the other side of that edge has to know about the new
    // corners too, or the edge is one segment on its side and two on this
    // one — a crack, and a shape that is no longer watertight.
    if (onEdge.length > 0) spliceIntoNeighbours(lattice, host, u, w, onEdge.map((o) => o.v));
  }
  const innerN = newell(I.map((v) => coordOf(lattice, v)));
  if (hostN[0] * innerN[0] + hostN[1] * innerN[1] + hostN[2] * innerN[2] < 0) I = I.reverse();

  const shared = I.filter((v) => H.includes(v));
  let pieces: number[][] | null = null;

  if (shared.length >= 2) {
    // A bite. The shared corners must be one unbroken run of the host's
    // boundary; rotate the host so that run starts at index 0.
    const inHost = H.map((v) => I.includes(v));
    let start = -1;
    for (let i = 0; i < H.length; i++) {
      if (inHost[i] && !inHost[(i - 1 + H.length) % H.length]) { start = i; break; }
    }
    if (start !== -1) {
      const rotated = [...H.slice(start), ...H.slice(0, start)];
      let runEnd = 0;
      while (runEnd + 1 < rotated.length && I.includes(rotated[runEnd + 1])) runEnd++;
      const run = rotated.slice(0, runEnd + 1);
      // One unbroken run, and something of the host left over past it.
      if (run.length === shared.length && runEnd + 1 < rotated.length) {
        // The inner face's corners off the host, in the order they run from
        // the end of the shared run back round to its start.
        const at = I.indexOf(run[run.length - 1]);
        const forward = I[(at + 1) % I.length] !== run[run.length - 2] || run.length < 2;
        const path: number[] = [];
        for (let k = 1; k < I.length; k++) {
          const v = forward ? I[(at + k) % I.length] : I[(at - k + I.length) % I.length];
          if (v === run[0]) break;
          path.push(v);
        }
        if (path.length === I.length - run.length) {
          pieces = [[run[0], ...[...path].reverse(), run[run.length - 1], ...rotated.slice(runEnd + 1)]];
        }
      }
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
      const hostRun = (from: number, to: number) => { const out = [H[from]]; for (let k = from; k !== to; k = (k + 1) % H.length) out.push(H[(k + 1) % H.length]); return out; };
      const islandBack = (from: number, to: number) => { const out = [I[from]]; for (let k = from; k !== to; k = (k - 1 + I.length) % I.length) out.push(I[(k - 1 + I.length) % I.length]); return out; };
      pieces = [
        [...hostRun(h1, h2), ...islandBack(i2, i1)],
        [...hostRun(h2, h1), ...islandBack(i1, i2)],
      ];
    }
  }
  if (!pieces || pieces.some((p) => p.length < 3 || new Set(p).size !== p.length)) return null;

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
  return latticeBoolean(before, prism, steps > 0 ? 'union' : 'difference');
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
