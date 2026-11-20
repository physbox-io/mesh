import type { DartLine } from './garmentDarts';

/**
 * Darts for what a garment's sculpting (GarmentDraft.sculpt) made that cannot
 * lie flat. A dome is curvature: round each point the angles of its
 * triangles add up to less than a full turn, and the shortfall (the angle
 * deficit, Gaussian curvature summed) is the wedge a flat piece has to lose
 * there. Where the sculpted surface gathers enough of it, darts radiate from
 * the most curved point and take it out, a dart for every so much: the
 * flattening opens each slit into its wedge.
 *
 * Only where sculpting is: the plan already darts what it shapes itself (a
 * bust, a sleeve cap), and the cloth eases or stretches over a little.
 */

/** Less than this much curvature (radians) round a point the cloth takes up by easing and stretch. */
const MIN_CURVE = 0.14;
/** About this much curvature (radians) for each dart. */
const PER_DART = 0.35;
/** Down and up from it: more cut a small dome into slivers (four on a shoulder left pieces of 40 triangles). */
const MAX_DARTS = 2;
/** At most this many dart groups on a garment. */
const MAX_GROUPS = 8;

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? a.map((v) => v / l) : null; };

/** Each point's angle deficit (0 on the boundary) and outward normal. */
export function angleDeficits(points: number[][], tris: number[]): { deficit: Float64Array; normal: number[][] } {
  const n = points.length, angle = new Float64Array(n), normal = points.map(() => [0, 0, 0]);
  const edgeUse = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    const c = [tris[t], tris[t + 1], tris[t + 2]];
    const nt = cross(sub(points[c[1]], points[c[0]]), sub(points[c[2]], points[c[0]]));
    for (let k = 0; k < 3; k++) {
      const a = c[k], b = c[(k + 1) % 3], o = c[(k + 2) % 3];
      const u = unit(sub(points[b], points[a])), v = unit(sub(points[o], points[a]));
      if (u && v) angle[a] += Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
      for (let q = 0; q < 3; q++) normal[a][q] += nt[q];
      const key = a < b ? a * n + b : b * n + a;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const boundary = new Uint8Array(n);
  for (const [key, uses] of edgeUse) if (uses === 1) { boundary[Math.floor(key / n)] = 1; boundary[key % n] = 1; }
  const deficit = new Float64Array(n);
  for (let i = 0; i < n; i++) if (!boundary[i] && angle[i] > 0) deficit[i] = 2 * Math.PI - angle[i];
  return { deficit, normal: normal.map((v) => unit(v) ?? [0, 0, 1]) };
}

/**
 * Darts for the sculpted surface: `sculpted` says whether a point is in the
 * sculpting, `reach` how far one dab spreads (the radius curvature is gathered
 * over), `taken` the apexes already darted. `mirrored`: the sculpting is
 * the same either side, and so are its darts (chosen on the left, +x, and
 * mirrored), as the garment's two sides come out alike.
 */
export function sculptDarts(points: number[][], tris: number[], sculpted: (p: number[]) => boolean, reach: number, taken: number[][], mirrored = false): DartLine[] {
  if (!(reach > 0)) return [];
  const { deficit, normal } = angleDeficits(points, tris);
  const cand: number[] = [];
  for (let i = 0; i < points.length; i++) if (deficit[i] !== 0 && sculpted(points[i]) && (!mirrored || points[i][0] >= 0)) cand.push(i);
  if (!cand.length) return [];
  const r2 = reach * reach;
  const near = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 < r2;
  // Each candidate's curvature gathered over a dab's reach (domes positive; saddles take away).
  // Mirrored, the right side's points count too, as the left's mirror.
  const all: number[] = [];
  const key = (ix: number, iy: number, iz: number) => ((ix + 1024) * 2048 + (iy + 1024)) * 2048 + (iz + 1024);
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < points.length; i++) {
    if (deficit[i] === 0 || !sculpted(points[i])) continue;
    all.push(i);
    const kk = key(Math.floor(points[i][0] / reach), Math.floor(points[i][1] / reach), Math.floor(points[i][2] / reach));
    const b = buckets.get(kk);
    if (b) b.push(i); else buckets.set(kk, [i]);
  }
  const gathered = cand.map((i) => {
    const p = points[i], cx = Math.floor(p[0] / reach), cy = Math.floor(p[1] / reach), cz = Math.floor(p[2] / reach);
    let acc = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const b = buckets.get(key(cx + dx, cy + dy, cz + dz));
      if (!b) continue;
      for (const j of b) if (near(p, points[j])) acc += deficit[j];
    }
    return acc;
  });
  const order = cand.map((_, k) => k).sort((a, b) => gathered[b] - gathered[a]);
  const apexes: number[][] = [...taken];
  const out: DartLine[] = [];
  let groups = 0;
  for (const k of order) {
    if (gathered[k] < MIN_CURVE || out.length >= MAX_GROUPS * MAX_DARTS) break;
    const i = cand[k];
    // Mirrored and near the centre, on it: one group for both sides, square to them.
    const centred = mirrored && points[i][0] <= reach / 2;
    const p = centred ? [0, points[i][1], points[i][2]] : points[i];
    if (apexes.some((a) => (a[0] - p[0]) ** 2 + (a[1] - p[1]) ** 2 + (a[2] - p[2]) ** 2 < 2.25 * r2)) continue;
    // A mirrored pair, unless it is on the centre (one dart group there for both).
    const pair = mirrored && p[0] > reach / 2;
    apexes.push(p);
    groups++;
    // Its mirror on the surface itself: the two sides' meshes are not each
    // other's exact mirror, and mirrored by number an apex by an edge (an
    // armhole) fell just off the cloth and cut nothing.
    const n0 = normal[i];
    let twin = [-p[0], p[1], p[2]], twinN = [-n0[0], n0[1], n0[2]];
    if (pair) {
      let best = -1, bd = Infinity;
      for (const j of all) { const d = (points[j][0] - twin[0]) ** 2 + (points[j][1] - twin[1]) ** 2 + (points[j][2] - twin[2]) ** 2; if (d < bd) { bd = d; best = j; } }
      if (best >= 0) { twin = points[best]; twinN = normal[best]; }
      apexes.push(twin);
    }
    const n = centred ? unit([0, normal[i][1], normal[i][2]]) ?? normal[i] : normal[i];
    // Down the garment first (toward a hem), then evenly round.
    const flat = (v: number[]) => unit(sub(v, n.map((x) => x * dot(v, n))));
    const down = flat([0, 0, -1]) ?? flat([0, -1, 0])!;
    const side = cross(n, down);
    const count = Math.min(MAX_DARTS, Math.max(1, Math.round(gathered[k] / PER_DART)));
    for (let d = 0; d < count; d++) {
      const a = (2 * Math.PI * d) / count;
      const dir = [0, 1, 2].map((q) => Math.cos(a) * down[q] + Math.sin(a) * side[q]);
      const name = `shape${groups}${count > 1 ? String.fromCharCode(97 + d) : ''}`;
      out.push({ name: pair ? `${name}L` : name, apex: { point: p.slice(), facing: n }, direction: dir, length: Infinity, back: 0 });
      if (pair) out.push({ name: `${name}R`, apex: { point: twin.slice(), facing: twinN }, direction: [-dir[0], dir[1], dir[2]], length: Infinity, back: 0 });
    }
  }
  return out;
}
