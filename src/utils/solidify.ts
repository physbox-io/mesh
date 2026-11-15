// ---------------------------------------------------------------------------
// Giving a surface a wall
// ---------------------------------------------------------------------------
//
// A lattice is a surface. That is the right thing to edit — you draw the shape
// of a thing, not the shape of its material — and the wrong thing to
// manufacture: a slicer, a mold and a CAM job all want a closed solid, and a
// surface has no inside for them to fill. Until now the panel could only report
// the problem ("surface is not closed") and leave the person to place the
// second half of every wall by hand.
//
// So this offsets the whole surface inwards by a thickness, reverses the copy,
// and stitches the two together around the border. What was a skin becomes a
// shell of a stated wall thickness, closed, and machinable.
//
// It runs on the MESH rather than on the cage, after subdivision, for the same
// reason smoothing does: the offset direction is a vertex normal, which points
// wherever the surface happens to face and almost never along the grid. Keeping
// it out of the cage means the thing being edited stays exactly the integers
// that were placed, and the thickness stays a property that can be changed or
// taken off at any time without the shape remembering it was ever applied.
// ---------------------------------------------------------------------------

import type { PolyMesh } from './subdivide';

const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const MIN_MITER_COS = 0.35;
const MAX_MITER = 1 / MIN_MITER_COS;

function canonicalCycle(face: number[]): string {
  if (face.length === 0) return '';
  let minIdx = 0;
  for (let i = 1; i < face.length; i++) {
    if (face[i] < face[minIdx]) minIdx = i;
  }
  const rotated: number[] = [];
  for (let i = 0; i < face.length; i++) rotated.push(face[(minIdx + i) % face.length]);
  return rotated.join(',');
}

/**
 * Strips exact duplicate and opposite-winding twin faces (from double-sided
 * zero-thickness triangle soups) while leaving genuine closed solids intact.
 */
function singleSidedFaces(faces: number[][]): number[][] {
  const seen = new Set<string>();
  const kept: number[][] = [];
  for (const face of faces) {
    if (face.length < 3) continue;
    const fwd = canonicalCycle(face);
    const rev = canonicalCycle([...face].reverse());
    if (seen.has(fwd) || seen.has(rev)) continue;
    seen.add(fwd);
    kept.push(face);
  }
  return kept;
}

/** Symmetric 3x3 eigensolver (Jacobi rotations) for mitered normal offsets. */
function eigenSym3(m: number[]): { values: [number, number, number]; vectors: [[number, number, number], [number, number, number], [number, number, number]] } {
  const a = [...m];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pairs: [number, number][] = [[0, 1], [0, 2], [1, 2]];
  for (let iter = 0; iter < 16; iter++) {
    let maxOff = 0;
    for (const [p, q] of pairs) maxOff = Math.max(maxOff, Math.abs(a[p * 3 + q]));
    if (maxOff < 1e-13) break;
    for (const [p, q] of pairs) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-13) continue;
      const app = a[p * 3 + p];
      const aqq = a[q * 3 + q];
      const tau = (aqq - app) / (2 * apq);
      const t = tau >= 0 ? 1 / (tau + Math.hypot(1, tau)) : -1 / (-tau + Math.hypot(1, tau));
      const c = 1 / Math.hypot(1, t);
      const s = t * c;
      a[p * 3 + p] = app - t * apq;
      a[q * 3 + q] = aqq + t * apq;
      a[p * 3 + q] = 0;
      a[q * 3 + p] = 0;
      for (let r = 0; r < 3; r++) {
        if (r === p || r === q) continue;
        const arp = a[r * 3 + p];
        const arq = a[r * 3 + q];
        a[r * 3 + p] = a[p * 3 + r] = c * arp - s * arq;
        a[r * 3 + q] = a[q * 3 + r] = s * arp + c * arq;
      }
      for (let r = 0; r < 3; r++) {
        const vrp = v[r * 3 + p];
        const vrq = v[r * 3 + q];
        v[r * 3 + p] = c * vrp - s * vrq;
        v[r * 3 + q] = s * vrp + c * vrq;
      }
    }
  }
  return {
    values: [a[0], a[4], a[8]],
    vectors: [
      [v[0], v[3], v[6]],
      [v[1], v[4], v[7]],
      [v[2], v[5], v[8]],
    ],
  };
}

/**
 * Per-vertex inward offset vectors, area-weighted and mitered at corners.
 *
 * Weighted by area so sliver triangles on a flat face cannot swing the normal,
 * and mitered against the incident face planes (`1 / max(0.35, cos θ)` along
 * each principal plane direction, clamped to `MAX_MITER`) so 90° tray and box
 * corners keep full wall thickness instead of thinning to `thickness / √2` or
 * `thickness / √3`.
 */
function vertexNormals(mesh: PolyMesh, faces: number[][]): number[] {
  const count = mesh.positions.length / 3;
  const normals = new Array<number>(mesh.positions.length).fill(0);
  const cov = new Array<number>(count * 9).fill(0);
  const weightSum = new Array<number>(count).fill(0);
  const fallback = new Array<[number, number, number] | null>(count).fill(null);
  const at = (v: number): [number, number, number] => [mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]];

  for (const face of faces) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < face.length; i++) {
      const [x1, y1, z1] = at(face[i]);
      const [x2, y2, z2] = at(face[(i + 1) % face.length]);
      nx += (y1 - y2) * (z1 + z2);
      ny += (z1 - z2) * (x1 + x2);
      nz += (x1 - x2) * (y1 + y2);
    }
    const w = Math.hypot(nx, ny, nz);
    if (w < 1e-12) continue;
    const fx = nx / w, fy = ny / w, fz = nz / w;
    for (const v of face) {
      normals[v * 3] += nx;
      normals[v * 3 + 1] += ny;
      normals[v * 3 + 2] += nz;
      weightSum[v] += w;
      if (!fallback[v]) fallback[v] = [fx, fy, fz];
      const base = v * 9;
      cov[base] += w * fx * fx;
      cov[base + 1] += w * fx * fy;
      cov[base + 2] += w * fx * fz;
      cov[base + 3] += w * fy * fx;
      cov[base + 4] += w * fy * fy;
      cov[base + 5] += w * fy * fz;
      cov[base + 6] += w * fz * fx;
      cov[base + 7] += w * fz * fy;
      cov[base + 8] += w * fz * fz;
    }
  }

  for (let v = 0; v < count; v++) {
    const W = weightSum[v];
    if (W < 1e-12) continue;
    const gx = normals[v * 3] / W;
    const gy = normals[v * 3 + 1] / W;
    const gz = normals[v * 3 + 2] / W;
    const gLen = Math.hypot(gx, gy, gz);
    if (gLen < 1e-6) {
      const fb = fallback[v];
      if (fb) {
        normals[v * 3] = fb[0];
        normals[v * 3 + 1] = fb[1];
        normals[v * 3 + 2] = fb[2];
      }
      continue;
    }
    const base = v * 9;
    const m = cov.slice(base, base + 9).map((c) => c / W);
    const { values, vectors } = eigenSym3(m);
    let dx = 0, dy = 0, dz = 0;
    for (let i = 0; i < 3; i++) {
      const lam = values[i];
      if (lam <= 1e-3) continue;
      const [ex, ey, ez] = vectors[i];
      const proj = ex * gx + ey * gy + ez * gz;
      const denom = Math.max(lam, MIN_MITER_COS * Math.abs(proj));
      if (denom <= 1e-12) continue;
      const coeff = proj / denom;
      dx += coeff * ex;
      dy += coeff * ey;
      dz += coeff * ez;
    }
    let dLen = Math.hypot(dx, dy, dz);
    if (dLen < 1e-9) {
      dx = gx / gLen;
      dy = gy / gLen;
      dz = gz / gLen;
      dLen = 1;
    } else if (dLen > MAX_MITER) {
      const scale = MAX_MITER / dLen;
      dx *= scale;
      dy *= scale;
      dz *= scale;
    }
    normals[v * 3] = dx;
    normals[v * 3 + 1] = dy;
    normals[v * 3 + 2] = dz;
  }
  return normals;
}

/** Edges used by a single direction or single face: the border of an open surface. */
function borderEdges(faces: number[][]): { a: number; b: number }[] {
  const uses = new Map<string, { a: number; b: number; count: number; sameDir: number }>();
  for (const face of faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const found = uses.get(key);
      // The direction of the first use is kept: it is the direction the outer
      // surface runs, and the stitched wall has to agree with it or the solid
      // comes out with its rim inside out.
      if (found) {
        found.count++;
        if (found.a === a && found.b === b) found.sameDir++;
      } else {
        uses.set(key, { a, b, count: 1, sameDir: 1 });
      }
    }
  }
  return [...uses.values()].filter((e) => e.count === 1 || e.sameDir === e.count).map(({ a, b }) => ({ a, b }));
}

export function isClosed(mesh: PolyMesh): boolean {
  if (mesh.faces.length === 0) return false;
  const faces = singleSidedFaces(mesh.faces);
  return faces.length === mesh.faces.length && borderEdges(faces).length === 0;
}

/**
 * Thickens an open surface into a closed shell.
 *
 * `thickness` is in the mesh's own units (metres here) and offsets INWARDS —
 * against the surface normals — so a shape drawn as the outside of a part keeps
 * its outside dimensions and grows its wall inwards, which is what somebody
 * measuring the thing they drew expects.
 *
 * A mesh that is already closed is returned untouched: it is a solid, and what
 * "thickness" would mean for one is hollowing it, which is a different
 * operation with a different question to answer (where does the material get
 * out?).
 */
export function solidify(mesh: PolyMesh, thickness: number): PolyMesh {
  if (thickness <= 0 || mesh.faces.length === 0) return mesh;
  if (isClosed(mesh)) return mesh;
  const sourceFaces = singleSidedFaces(mesh.faces);
  const border = borderEdges(sourceFaces);
  if (border.length === 0) return mesh;

  const normals = vertexNormals(mesh, sourceFaces);
  const count = mesh.positions.length / 3;
  const positions = [...mesh.positions];

  // The inner shell's vertices follow the outer ones, so vertex v has its twin
  // at v + count and no lookup is needed anywhere below.
  for (let v = 0; v < count; v++) {
    positions.push(
      mesh.positions[v * 3] - normals[v * 3] * thickness,
      mesh.positions[v * 3 + 1] - normals[v * 3 + 1] * thickness,
      mesh.positions[v * 3 + 2] - normals[v * 3 + 2] * thickness,
    );
  }

  const faces: number[][] = [];
  for (const face of sourceFaces) faces.push([...face]);
  // Reversed, because a copy offset inwards is seen from the other side: left
  // as it was, the shell would have its inner surface facing into the material.
  for (const face of sourceFaces) faces.push([...face].reverse().map((v) => v + count));

  // The rim. The outer surface already runs a→b along this edge and the
  // reversed inner one runs b'→a', so the wall has to take the two directions
  // nobody has used: b→a across the top, a'→b' back along the bottom. Get this
  // the other way round and the mesh is closed, passes an edge count, and is
  // still a solid no slicer will accept.
  for (const { a, b } of border) {
    faces.push([b, a, a + count, b + count]);
  }

  const creases = new Set<string>();
  if (mesh.creases) {
    for (const key of mesh.creases) {
      const [a, b] = key.split(':').map(Number);
      creases.add(edgeKey(a, b));
      creases.add(edgeKey(a + count, b + count));
    }
  }
  // The rim itself is always sharp: a wall meets a face at an edge, and rounding
  // it would eat the wall it was supposed to be the end of.
  for (const { a, b } of border) {
    creases.add(edgeKey(a, b));
    creases.add(edgeKey(a + count, b + count));
  }

  return { positions, faces, creases };
}
