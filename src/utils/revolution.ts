// Is this mesh a solid of revolution, and about which axis?
//
// A lathed or rotate_extruded part — a cup, a bored boss, a bowl, a drum — is
// the one shape whose exact convex decomposition is known: angular sectors
// about its axis, tier by tier between its flat steps (csg.ts
// decomposeAroundAxis, the slicer a boolean with a piercing hole has always
// used). Each sector's chord stands r(1 - cos(pi/N)) proud of a round bore,
// 0.013 mm at r = 10.5 mm in 64 sectors, where V-HACD's pieces stood up to
// 2.4 mm proud and jammed a peg with 0.5 mm clearance at the rim.
//
// Recognised from the vertices alone: a lathed mesh's vertices lie in rings,
// each at one height and one radius about the axis, spaced evenly round it.
// The axis is one of the principal axes of the vertex cloud through its
// centroid — rings put the centroid on the axis and make the other two
// moments equal — and it is accepted when nearly every vertex sits in a ring
// of at least MIN_RING vertices. Pure and Worker-safe.

/** Vertices a ring must have to count: fewer is a polygon, not a lathe. */
const MIN_RING = 12;

/** Share of all vertices that must sit in rings. */
const IN_RINGS = 0.95;

export interface Revolution {
  origin: [number, number, number];
  axis: [number, number, number];
  /** Vertices round the commonest ring: the segment count it was lathed with. */
  segments: number;
}

function symmetricEigenvectors(m: number[][]): number[][] {
  // Jacobi rotations: 3x3, a handful of sweeps.
  const a = m.map(r => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map(j => [v[0][j], v[1][j], v[2][j]]);
}

/** The axis a mesh was lathed about, or null when it was not lathed. */
export function detectRevolution(verts: number[], faces: number[]): Revolution | null {
  // Only the vertices the faces use: a welded mesh can carry orphans.
  const used = new Uint8Array(verts.length / 3);
  for (const f of faces) used[f] = 1;
  const pts: number[][] = [];
  for (let i = 0; i < used.length; i++) if (used[i]) pts.push([verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]);
  if (pts.length < MIN_RING * 2) return null;
  const c = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let size = 0;
  for (const p of pts) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    size = Math.max(size, Math.hypot(d[0], d[1], d[2]));
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[r][s] += d[r] * d[s];
  }
  if (!(size > 0)) return null;
  const tol = size * 1e-4;
  for (const axis of symmetricEigenvectors(cov)) {
    const rings = new Map<string, number>();
    const keys: string[] = [];
    for (const p of pts) {
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const h = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      const r = Math.hypot(d[0] - h * axis[0], d[1] - h * axis[1], d[2] - h * axis[2]);
      const key = `${Math.round(h / tol)},${Math.round(r / tol)}`;
      keys.push(key);
      rings.set(key, (rings.get(key) ?? 0) + 1);
    }
    let inRings = 0;
    const sizes = new Map<number, number>();
    for (const k of keys) {
      const n = rings.get(k)!;
      if (n >= MIN_RING) inRings++;
    }
    for (const n of rings.values()) if (n >= MIN_RING) sizes.set(n, (sizes.get(n) ?? 0) + 1);
    if (inRings < pts.length * IN_RINGS) continue;
    const segments = [...sizes.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 0;
    return { origin: c as [number, number, number], axis: axis as [number, number, number], segments };
  }
  return null;
}
