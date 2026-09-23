// How thick a body is at the place it was hit.
//
// Glass does not break because it is crushed; it breaks when its surface is
// stretched and a flaw opens. A thick piece takes a blow as a local squeeze,
// which glass is very good at. A thin wall bends instead, and bending stretches
// the surface — so the same blow that bounces off a tumbler's base goes
// through a wine glass's bowl. Averaging thickness over the body would give a
// wine glass one blended figure and no idea its rim is the fragile part, so
// this measures it where the blow landed.
//
// The method: find the surface triangle nearest the contact point, step off it
// along its INWARD normal, and see how far the ray travels before it leaves the
// solid again. That distance is the wall. Starting from the mesh's own face
// rather than the contact normal matters, because the contact normal's sign
// depends on which geom MuJoCo listed first and the contact point sits
// somewhere inside the penetration, not on either surface.
//
// Pure, and O(faces) twice per blow, which for any mesh worth shattering is
// well under a millisecond — it runs once per impact, not per step.

type V3 = [number, number, number];

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Closest point to p on triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function closestOnTriangle(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/**
 * The wall thickness under `point`, in the mesh's own units, or null when the
 * mesh has no inside to measure (open, degenerate, or the ray never leaves).
 *
 * `verts`/`faces` are the body's mesh in the same frame as `point` — for a
 * body in the simulation, its renderVertices and the impact's local point.
 * Winding may be either way round; the signed volume says which is outward.
 */
export function wallThicknessAt(verts: ArrayLike<number>, faces: ArrayLike<number>, point: V3): number | null {
  const nTri = Math.floor(faces.length / 3);
  if (nTri === 0) return null;
  const P = (i: number): V3 => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];

  // Which way is out. An inside-out mesh (see CLAUDE.md § face winding) would
  // otherwise send the ray off into the air.
  let signedVol = 0;
  for (let t = 0; t < nTri; t++) {
    const a = P(faces[t * 3]), b = P(faces[t * 3 + 1]), c = P(faces[t * 3 + 2]);
    signedVol += dot(a, cross(b, c));
  }
  if (Math.abs(signedVol) < 1e-18) return null;
  const outward = signedVol > 0 ? 1 : -1;

  let best = -1, bestD2 = Infinity;
  let start: V3 = point;
  for (let t = 0; t < nTri; t++) {
    const q = closestOnTriangle(point, P(faces[t * 3]), P(faces[t * 3 + 1]), P(faces[t * 3 + 2]));
    const d = sub(q, point);
    const d2 = dot(d, d);
    if (d2 < bestD2) { bestD2 = d2; best = t; start = q; }
  }
  const a0 = P(faces[best * 3]), b0 = P(faces[best * 3 + 1]), c0 = P(faces[best * 3 + 2]);
  const n0 = cross(sub(b0, a0), sub(c0, a0));
  const len = Math.hypot(n0[0], n0[1], n0[2]);
  if (len < 1e-18) return null;
  const dir: V3 = [-outward * n0[0] / len, -outward * n0[1] / len, -outward * n0[2] / len];

  // Möller–Trumbore against every face; keep the nearest hit that is not the
  // face we started on. Anything nearer than a micron is that face's neighbour
  // along a shared edge.
  const EPS = 1e-6;
  let nearest = Infinity;
  for (let t = 0; t < nTri; t++) {
    if (t === best) continue;
    const a = P(faces[t * 3]), b = P(faces[t * 3 + 1]), c = P(faces[t * 3 + 2]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(dir, e2);
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-18) continue;
    const inv = 1 / det;
    const s = sub(start, a);
    const u = dot(s, h) * inv;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1);
    const v = dot(dir, q) * inv;
    if (v < 0 || u + v > 1) continue;
    const dist = dot(e2, q) * inv;
    if (dist > EPS && dist < nearest) nearest = dist;
  }
  return Number.isFinite(nearest) ? nearest : null;
}
