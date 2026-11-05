// A solid cut along the planes of its inside corners until it is convex.
//
// For a concavity bounded by flat faces there is an exact convex
// decomposition, and no voxels in it: cut the solid along the plane of a face
// at a reflex (inside) edge, and that edge is gone from both halves — the
// material round it was a wedge of more than 180°, and the plane leaves a flat
// 180° on one side and the rest, now under 180°, on the other. A cut by a
// plane adds no reflex edge, so cutting until none is left ends with every
// cell convex and exactly part of the solid. Manifold's splitByPlane hands
// back both sides closed and capped.
//
// V-HACD and the planar cuts in tightPieces.ts got there only slowly. A 60 mm
// block with a 21 mm square pocket came out as 66 pieces still standing
// 4.8 mm proud into the pocket, and a 20 mm square peg with 0.5 mm clearance
// stopped 16 mm above the floor. Cut here it is 5 boxes, exact, in a few ms.
//
// Not every reflex edge is a corner. The facets of a round bore meet at
// 360°/segments — 5.6° in 64 — and cutting along each of those would be a
// sector slicer with none of its knowledge. So only SHARP edges are cut; a
// cell left with nothing but shallow ones is curved, and is handed back as
// `rest` for V-HACD to decompose. That is what lets a mixed part — a block
// with a pocket and a bore — have its flat corners cut exactly and only its
// curves approximated.
//
// The plane cut first is the one through the most length of sharp reflex
// edge: a pocket's floor takes all four of its floor edges at once, which is
// why coplanar edges are pooled. Ties go to the plane that runs through less
// other reflex edge (each crossed edge becomes two), then by the plane's own
// coordinates, so the same mesh is always cut the same way. Past `maxCells`
// cells it gives up (null) and the part goes the V-HACD way whole: a swept
// channel has a new plane at every station, and would be hundreds of cuts.
//
// Pure, store-free and Worker-safe.

import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import { convexHullOf } from './csg';
import { depthInside, hullPlanes } from './hullDepth';
import type { Chunk } from './chunkedDecomposition';
import { fromManifold, toManifoldSolid } from './chunkedDecomposition';

/** Millimetres inside Manifold, as in chunkedDecomposition.ts. */
const MM = 1000;

/**
 * A reflex edge turning more than this is a corner to cut along. A 16-sided
 * bore turns 22.5° a facet and is cut flat by flat; a 32-sided one (11.25°)
 * is left curved.
 */
export const SHARP_REFLEX_DEG = 15;

/** Turns under this, or rising less than NOISE_RISE, are flat: Manifold's own triangulation of a cut face. */
const NOISE_DEG = 0.5;
const NOISE_RISE = 1e-7;

/** A vertex within this of a plane lies in it, metres. */
const ON_PLANE = 1e-7;

/** How far into the air a cut goes to take a skin off a wall, metres. */
const SKIN = 1e-6;

/** A component smaller than this is a crumb of the cut, mm³. */
const CRUMB_MM3 = 1e-3;

export interface ReflexCutResult {
  /** Convex cells, exactly the solid between them. */
  convex: Chunk[];
  /** Cells with no corner left to cut, still curved somewhere. */
  rest: Chunk[];
  cuts: number;
}

interface Plane { n: [number, number, number]; d: number }
interface Edge { a: number; b: number; deg: number; length: number; planes: [Plane, Plane] }

function triPlane(v: number[], i: number, j: number, k: number): Plane | null {
  const ux = v[j * 3] - v[i * 3], uy = v[j * 3 + 1] - v[i * 3 + 1], uz = v[j * 3 + 2] - v[i * 3 + 2];
  const wx = v[k * 3] - v[i * 3], wy = v[k * 3 + 1] - v[i * 3 + 1], wz = v[k * 3 + 2] - v[i * 3 + 2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-18) return null;
  nx /= len; ny /= len; nz /= len;
  return { n: [nx, ny, nz], d: nx * v[i * 3] + ny * v[i * 3 + 1] + nz * v[i * 3 + 2] };
}

/** Every reflex edge of a closed, outward-wound mesh that turns more than noise. */
export function reflexEdges(c: Chunk): Edge[] {
  const { verts: v, faces: f } = c;
  // Directed edge a→b to the triangle it bounds and that triangle's third vertex.
  const half = new Map<number, { tri: number; opp: number }>();
  const big = v.length / 3 + 1;
  for (let t = 0; t < f.length; t += 3) {
    for (let k = 0; k < 3; k++) half.set(f[t + k] * big + f[t + (k + 1) % 3], { tri: t, opp: f[t + (k + 2) % 3] });
  }
  const out: Edge[] = [];
  for (const [key, h1] of half) {
    const a = Math.floor(key / big), b = key % big;
    if (a > b) continue;
    const h2 = half.get(b * big + a);
    if (!h2) continue;
    const p1 = triPlane(v, f[h1.tri], f[h1.tri + 1], f[h1.tri + 2]);
    const p2 = triPlane(v, f[h2.tri], f[h2.tri + 1], f[h2.tri + 2]);
    if (!p1 || !p2) continue;
    // Reflex: the far triangle's third corner stands in front of the near one.
    const rise = p1.n[0] * v[h2.opp * 3] + p1.n[1] * v[h2.opp * 3 + 1] + p1.n[2] * v[h2.opp * 3 + 2] - p1.d;
    if (rise <= NOISE_RISE) continue;
    const deg = (Math.acos(Math.max(-1, Math.min(1, p1.n[0] * p2.n[0] + p1.n[1] * p2.n[1] + p1.n[2] * p2.n[2]))) * 180) / Math.PI;
    if (deg < NOISE_DEG) continue;
    const length = Math.hypot(v[b * 3] - v[a * 3], v[b * 3 + 1] - v[a * 3 + 1], v[b * 3 + 2] - v[a * 3 + 2]);
    out.push({ a, b, deg, length, planes: [p1, p2] });
  }
  return out;
}

/** One sign and a rounded key per plane, so the planes of coplanar faces pool. */
function canonical(p: Plane): Plane & { key: string } {
  const [x, y, z] = p.n;
  const flip = Math.abs(x) > 1e-9 ? x < 0 : Math.abs(y) > 1e-9 ? y < 0 : z < 0;
  const n: [number, number, number] = flip ? [-x, -y, -z] : [x, y, z];
  const d = flip ? -p.d : p.d;
  const r = (u: number, s: number) => Math.round(u * s);
  return { n, d, key: `${r(n[0], 1e6)},${r(n[1], 1e6)},${r(n[2], 1e6)},${r(d, 1e7)}` };
}

/** The plane through the most sharp reflex edge, as described at the top. */
function bestPlane(c: Chunk, sharp: Edge[], all: Edge[]): (Plane & { air: number }) | null {
  const v = c.verts;
  const off = (p: Plane, i: number) => p.n[0] * v[i * 3] + p.n[1] * v[i * 3 + 1] + p.n[2] * v[i * 3 + 2] - p.d;
  const seen = new Map<string, Plane & { key: string; air: number }>();
  for (const e of sharp) {
    for (const p of e.planes) {
      const q = canonical(p);
      // The face's normal points into the air in front of it.
      if (!seen.has(q.key)) seen.set(q.key, { ...q, air: q.n[0] * p.n[0] + q.n[1] * p.n[1] + q.n[2] * p.n[2] });
    }
  }
  let best: { p: Plane & { air: number }; on: number; crossed: number; key: string } | null = null;
  for (const p of seen.values()) {
    let on = 0, crossed = 0;
    for (const e of all) {
      const sa = off(p, e.a), sb = off(p, e.b);
      if (Math.abs(sa) <= ON_PLANE && Math.abs(sb) <= ON_PLANE) { if (e.deg > SHARP_REFLEX_DEG) on += e.length; }
      else if ((sa < -ON_PLANE && sb > ON_PLANE) || (sa > ON_PLANE && sb < -ON_PLANE)) crossed += e.length;
    }
    const better = !best || on > best.on * (1 + 1e-9)
      || (on >= best.on * (1 - 1e-9) && (crossed < best.crossed * (1 - 1e-9) || (crossed <= best.crossed * (1 + 1e-9) && p.key < best.key)));
    if (better) best = { p, on, crossed, key: p.key };
  }
  return best && best.on > 0 ? best.p : null;
}

/**
 * The separate solids of a cut side, each with any sealed hollow it holds.
 * Takes ownership of `m`.
 *
 * A sealed hollow is a shell of its own, wound inward, with a negative volume.
 * It goes back with the solid round it — the smallest whose box holds it — or
 * that solid would read as convex and fill the hollow: a closed 60 mm box came
 * out as one cube.
 */
function solidComponents(wasm: ManifoldToplevel, m: Manifold): Manifold[] {
  const parts = m.decompose();
  m.delete();
  const solids: Manifold[] = [], voids: Manifold[] = [];
  for (const p of parts) {
    const vol = p.volume();
    if (vol > CRUMB_MM3) solids.push(p);
    else if (vol < -CRUMB_MM3) voids.push(p);
    else p.delete();
  }
  const holds = (o: Manifold, i: Manifold) => {
    const a = o.boundingBox(), b = i.boundingBox();
    return [0, 1, 2].every(k => a.min[k] <= b.min[k] && b.max[k] <= a.max[k]);
  };
  const inner = new Map<Manifold, Manifold[]>();
  for (const h of voids) {
    const round = solids.filter(o => holds(o, h)).sort((x, y) => x.volume() - y.volume())[0];
    if (round) inner.set(round, [...(inner.get(round) ?? []), h]);
    else h.delete();
  }
  return solids.map(o => {
    const hs = inner.get(o);
    if (!hs) return o;
    const whole = wasm.Manifold.compose([o, ...hs]);
    o.delete();
    for (const h of hs) h.delete();
    return whole;
  });
}

/**
 * Cuts a closed mesh along its sharp inside corners. Null when Manifold will
 * not take the mesh, or when it would come to more than `maxCells` cells. A
 * part curved throughout comes back whole, as one `rest` cell.
 */
export function cutAtReflexEdges(wasm: ManifoldToplevel, verts: number[], faces: number[], maxCells: number): ReflexCutResult | null {
  // Curved throughout, nothing to cut. With no reflex edge at all, every
  // shell is convex — boxes listed together in one mesh — and is a piece as
  // it stands: V-HACD made 236 pieces of an open-top box's five slabs, still
  // filling 59 places.
  const root = toManifoldSolid(wasm, verts, faces);
  if (!root) return null;

  const convex: Chunk[] = [], rest: Chunk[] = [];
  let queue: Manifold[] = [];
  let cuts = 0;
  try {
    queue = solidComponents(wasm, root);
    while (queue.length) {
      if (convex.length + rest.length + queue.length > maxCells) return null;
      const m = queue.shift()!;
      const cell = fromManifold(m);
      const edges = reflexEdges(cell);
      const sharp = edges.filter(e => e.deg > SHARP_REFLEX_DEG);
      const plane = sharp.length ? bestPlane(cell, sharp, edges) : null;
      if (!plane) {
        m.delete();
        (edges.length ? rest : convex).push(cell);
        continue;
      }
      let sides = m.splitByPlane(plane.n, plane.d * MM);
      // An empty side: the wall the plane came from is still here. Float
      // noise landed the cut before this one inside the material, leaving a
      // skin a micron thick over the opening and the pocket whole behind it.
      // A 21.16 mm hex pocket did that, threw its part back to V-HACD, and
      // stopped a peg at its rim. Take the cut a hair into the air, and the
      // skin off.
      if (sides.some(side => side.isEmpty())) {
        for (const side of sides) side.delete();
        sides = m.splitByPlane(plane.n, (plane.d + plane.air * SKIN) * MM);
      }
      m.delete();
      // Still empty, and cutting again would not end. The cell goes on as it is.
      if (sides.some(side => side.isEmpty())) {
        for (const side of sides) side.delete();
        rest.push(cell);
        continue;
      }
      const kept = sides.filter(side => {
        const whole = (2 * side.volume()) / side.surfaceArea() >= 2 * SKIN * MM;
        if (!whole) side.delete();
        return whole;
      });
      cuts++;
      for (const side of kept) queue.push(...solidComponents(wasm, side));
    }
  } finally {
    for (const m of queue) m.delete();
  }
  return { convex, rest, cuts };
}

/** Reflex points of a cell measured per cell at most, so a dense mesh costs the same to judge. */
const MAX_DEPTH_SAMPLES = 2000;

interface CurvedCell { m: Manifold; cell: Chunk; depth: number; edge: Edge | null }

/**
 * How far a cell's reflex edges lie inside its own hull, and which is deepest:
 * how far that hull would stand proud of the cell, were it kept as a piece.
 */
function concavityOf(c: Chunk): { depth: number; edge: Edge | null } {
  const edges = reflexEdges(c);
  if (edges.length === 0) return { depth: 0, edge: null };
  const v = c.verts;
  const points: number[][] = [];
  for (let i = 0; i < v.length; i += 3) points.push([v[i], v[i + 1], v[i + 2]]);
  const hull = convexHullOf(points);
  if (!hull) return { depth: 0, edge: null };
  const planes = hullPlanes(hull);
  const inside = (x: number, y: number, z: number) => depthInside(planes, x, y, z);
  const stride = Math.max(1, Math.ceil(edges.length / MAX_DEPTH_SAMPLES));
  let depth = 0, edge: Edge | null = null;
  for (let i = 0; i < edges.length; i += stride) {
    const e = edges[i];
    const ax = v[e.a * 3], ay = v[e.a * 3 + 1], az = v[e.a * 3 + 2];
    const bx = v[e.b * 3], by = v[e.b * 3 + 1], bz = v[e.b * 3 + 2];
    // The middle as well as the ends: a through bore's edges end on the
    // block's faces, and only their middles are inside its hull.
    const d = Math.max(inside(ax, ay, az), inside(bx, by, bz), inside((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2));
    if (d > depth) { depth = d; edge = e; }
  }
  return { depth, edge };
}

/**
 * Cuts cells with curved walls until each one's hull stands no more than
 * `tolerance` proud of it, the proudest first, or `maxCells` are made.
 *
 * The same cut as a corner's, taken along the plane that bisects a shallow
 * reflex edge, which leaves both sides of that edge under 180°. Round a bore
 * those planes are radial; along a filleted corner they fan through it. Each
 * cut halves the arc it lands in and so quarters its sag, and the cells are
 * pieces of the solid itself, with no voxels in them, so nothing stands proud
 * but the chord. V-HACD then tightPieces left a 22 mm bore in a block 5.9 mm
 * narrower in 68 pieces.
 */
export function cutCurved(wasm: ManifoldToplevel, cells: Chunk[], maxCells: number, tolerance: number): { cells: Chunk[]; cuts: number } {
  const open: CurvedCell[] = [];
  const done: Chunk[] = [];
  let cuts = 0;
  const judge = (m: Manifold): void => {
    const cell = fromManifold(m);
    const { depth, edge } = concavityOf(cell);
    if (edge && depth > tolerance) open.push({ m, cell, depth, edge });
    else { m.delete(); done.push(cell); }
  };
  for (const c of cells) {
    const m = toManifoldSolid(wasm, c.verts, c.faces);
    if (m) judge(m);
    else done.push(c);
  }
  try {
    while (open.length > 0 && open.length + done.length < maxCells) {
      let worst = 0;
      for (let i = 1; i < open.length; i++) if (open[i].depth > open[worst].depth) worst = i;
      const { m, cell, edge } = open.splice(worst, 1)[0];
      const [p1, p2] = edge!.planes;
      const n: [number, number, number] = [p1.n[0] - p2.n[0], p1.n[1] - p2.n[1], p1.n[2] - p2.n[2]];
      const len = Math.hypot(n[0], n[1], n[2]);
      const a = edge!.a * 3;
      const offset = len > 0 ? (n[0] * cell.verts[a] + n[1] * cell.verts[a + 1] + n[2] * cell.verts[a + 2]) / len : 0;
      const [pos, neg] = len > 0 ? m.splitByPlane([n[0] / len, n[1] / len, n[2] / len], offset * MM) : [null, null];
      if (!pos || !neg || pos.isEmpty() || neg.isEmpty()) {
        pos?.delete(); neg?.delete(); m.delete();
        done.push(cell);
        continue;
      }
      m.delete();
      cuts++;
      for (const side of [pos, neg]) for (const part of solidComponents(wasm, side)) judge(part);
    }
  } finally {
    for (const o of open) { o.m.delete(); done.push(o.cell); }
  }
  return { cells: done, cuts };
}
