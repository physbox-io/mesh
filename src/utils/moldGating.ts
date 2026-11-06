// ---------------------------------------------------------------------------
// Where a closed mold is filled from and where its air goes
// ---------------------------------------------------------------------------
//
// A lined gear sculpture's mold was poured from the top: in through the lid,
// down into a cavity whose deep half hangs from the lid's layer by posts
// 2.6 mm across. Air under liquid in a passage that narrow cannot get past
// it, and the mold had two vents, both in the lid's layer, so how much ever
// filled turned on paths nobody could see.
//
// Filled from the bottom instead, the liquid rises and pushes the air up
// ahead of it, so it never has to pass the liquid anywhere. That needs:
//
//  - a down-sprue beside the cavity, in the wall, from the funnel on the
//    lid's outer face down below the cavity's lowest point, a runner along
//    under the cavity (nothing is there to cross: run level with the lowest
//    point, it cut through the gears hanging beside it), and a short gate up
//    into the lowest point (`planBottomFill`);
//  - a vent at every high point, every place the rising level would close
//    over air (`planPeakVents`): the top of each pocket of the cavity as it
//    is poured, found by sweeping the level down from the top and noting
//    where each separate pocket of air is born.
//
// Everything here is in the pour frame: the closed mold standing lid up, the
// parting face at z = 0, x and y the cavity half's own (the lid's are the
// same with y negated), on the mold's sampling grid.
// ---------------------------------------------------------------------------

import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Grid, ColumnField } from './moldColumns';
import type { FeedRoute, VentStub } from '../types/scene';
import type { MoldFeatureReport } from './moldExporter';
import { buildPartManifold, manifoldToTriangles, type Triangle3D } from './moldManifold';

/** The cavity as poured, per grid column: solid spans (bottom, top) in z, mm, parting face at 0. */
export type PourSpans = Float64Array[];

/**
 * The rigid mold's cavity: each half's depth field, the lid's turned to the
 * cavity half's frame (its rows reversed), as spans.
 */
export function rigidPourSpans(baseDepth: Float64Array, lidDepth: Float64Array, grid: Grid): PourSpans {
  const { cols, rows } = grid;
  const out: PourSpans = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const lo = baseDepth[i] > 0 ? -baseDepth[i] : 0;
      const hi = lidDepth[(rows - 1 - r) * cols + c] > 0 ? lidDepth[(rows - 1 - r) * cols + c] : 0;
      out[i] = hi > lo ? Float64Array.of(lo, hi) : new Float64Array(0);
    }
  }
  return out;
}

/**
 * The exact part's cavity (undercuts kept: the lined mold and the exact one)
 * from its column field. `flipped` is the cavity half holding the part turned
 * over, as the exporter builds it when the detail is above the parting.
 */
export function exactPourSpans(field: ColumnField, grid: Grid, partingZ: number, flipped: boolean): PourSpans {
  const { cols, rows } = grid;
  const out: PourSpans = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const src = field.spans[(flipped ? rows - 1 - r : r) * cols + c];
      const mapped: number[] = [];
      for (let k = 0; k + 1 < src.length; k += 2) {
        const lo = flipped ? partingZ - src[k + 1] : src[k] - partingZ;
        const hi = flipped ? partingZ - src[k] : src[k + 1] - partingZ;
        mapped.push(lo, hi);
      }
      out[r * cols + c] = Float64Array.from(mapped);
    }
  }
  return out;
}

export interface PeakVent {
  x: number;
  y: number;
  /** Height of the pocket's top, mm above the parting face (negative: in the cavity half). */
  z: number;
  /** How far the pocket goes down before it meets a higher one's air, mm. */
  prominenceMm: number;
}

/**
 * The tops of the cavity's pockets of air, as poured: every place a rising
 * level would close over air with nowhere to go. Pockets both shallower than
 * `minProminenceMm` and smaller than `minPocketMm3` are left (a bubble that
 * small is a pit, not a void; depth alone let a wide shallow ceiling go, 12 mm³
 * of air on a gear sculpture's face), and no more than `max` are kept, the
 * deepest first.
 */
export function planPeakVents(spans: PourSpans, grid: Grid, minProminenceMm = 0.5, max = 24, minPocketMm3 = 3): PeakVent[] {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const dz = Math.min(stepX, stepY);
  let zMin = Infinity, zMax = -Infinity;
  for (const s of spans) for (let k = 0; k < s.length; k++) { zMin = Math.min(zMin, s[k]); zMax = Math.max(zMax, s[k]); }
  if (!(zMax > zMin)) return [];
  const layers = Math.ceil((zMax - zMin) / dz);
  const plane = cols * rows;
  const zOf = (k: number) => zMin + (k + 0.5) * dz;
  const solid = (col: number, k: number) => {
    const s = spans[col];
    const z = zOf(k);
    for (let j = 0; j + 1 < s.length; j += 2) if (z >= s[j] && z <= s[j + 1]) return true;
    return false;
  };

  // Union-find over cells, the level swept down from the top.
  const parent = new Int32Array(plane * layers).fill(-1);
  const birth = new Int32Array(plane * layers); // the root's highest cell
  const size = new Int32Array(plane * layers); // the root's cells
  const cellMm3 = stepX * stepY * dz;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const peaks: PeakVent[] = [];
  // A pocket's vent goes at the middle of its top, not at whichever cell of
  // it the sweep met first: that was an edge, and left vents half off a bar.
  const cellXYZ = (i: number) => {
    const k = Math.floor(i / plane);
    const start = i - k * plane;
    const region = [start];
    const seen = new Set([start]);
    for (let q = 0; q < region.length; q++) {
      const col = region[q], r = Math.floor(col / cols), c = col - r * cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const n = rr * cols + cc;
        if (seen.has(n) || !solid(n, k)) continue;
        seen.add(n);
        region.push(n);
      }
    }
    // Peel the region from its edge in; the last cell left is the middle.
    const depth = new Map<number, number>();
    let ring = region.filter((col) => {
      const r = Math.floor(col / cols), c = col - r * cols;
      return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => !seen.has((r + dr) * cols + c + dc) || c + dc < 0 || c + dc >= cols);
    });
    let d = 0;
    for (const col of ring) depth.set(col, d);
    while (ring.length) {
      d++;
      const next: number[] = [];
      for (const col of ring) {
        const r = Math.floor(col / cols), c = col - r * cols;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cc = c + dc, rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
          const n = rr * cols + cc;
          if (!seen.has(n) || depth.has(n)) continue;
          depth.set(n, d);
          next.push(n);
        }
      }
      ring = next;
    }
    let mid = start;
    for (const [col, dd] of depth) if (dd > (depth.get(mid) ?? -1)) mid = col;
    const r = Math.floor(mid / cols), c = mid - r * cols;
    return { x: -halfW + c * stepX, y: -halfD + r * stepY, z: zOf(k) };
  };
  const union = (a: number, b: number, zNow: number) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // The pocket born lower dies here; the higher one goes on.
    const za = Math.floor(birth[ra] / plane), zb = Math.floor(birth[rb] / plane);
    const [elder, younger] = za >= zb ? [ra, rb] : [rb, ra];
    // Measured from the layer it was born in; only a pocket kept is centred.
    const prominence = zOf(Math.min(za, zb)) - zNow;
    // Cells of one flat ceiling meeting each other are not a pocket: it needs a layer of depth.
    if (prominence >= minProminenceMm || (prominence > dz / 2 && size[younger] * cellMm3 >= minPocketMm3)) {
      const top = cellXYZ(birth[younger]);
      peaks.push({ x: top.x, y: top.y, z: top.z, prominenceMm: prominence });
    }
    parent[younger] = elder;
    size[elder] += size[younger];
  };

  for (let k = layers - 1; k >= 0; k--) {
    const zNow = zOf(k);
    for (let col = 0; col < plane; col++) {
      if (!solid(col, k)) continue;
      const i = k * plane + col;
      parent[i] = i;
      birth[i] = i;
      size[i] = 1;
    }
    for (let col = 0; col < plane; col++) {
      const i = k * plane + col;
      if (parent[i] < 0) continue;
      const r = Math.floor(col / cols), c = col - r * cols;
      if (k < layers - 1 && parent[i + plane] >= 0) union(i, i + plane, zNow);
      if (c > 0 && parent[i - 1] >= 0) union(i, i - 1, zNow);
      if (r > 0 && parent[i - cols] >= 0) union(i, i - cols, zNow);
    }
  }
  // What is left at the bottom: each separate piece's own top.
  const roots = new Set<number>();
  for (let i = 0; i < parent.length; i++) if (parent[i] >= 0) roots.add(find(i));
  for (const root of roots) {
    const top = cellXYZ(birth[root]);
    peaks.push({ x: top.x, y: top.y, z: top.z, prominenceMm: top.z - zMin });
  }
  peaks.sort((a, b) => b.prominenceMm - a.prominenceMm);
  return peaks.slice(0, max);
}

export interface BottomFill {
  /** The down-sprue's axis, beside the cavity. */
  down: { x: number; y: number };
  /** Where the runner meets the cavity: its lowest point, mm (z below the parting face). */
  gate: { x: number; y: number; z: number };
  /** Height of the runner's axis, mm: below the lowest point by its radius and a millimetre. */
  runnerZ: number;
  /** Neck radius, which the down-sprue and runner both have. */
  r: number;
  /** The gate's radius, up from the runner into the lowest point: no air has to pass it, so it can be narrow. */
  gateR: number;
  /** How wide the funnel above it may be and stay inside a block that follows the part. */
  roomR: number;
}

/** Wall between a down-sprue and the cavity or the block's edge, mm. */
export const FEED_WALL_MM = 1.5;
/** Mold between the runner and the cavity's lowest point, mm. */
export const RUNNER_CLEARANCE_MM = 1;
/** The widest a bottom-fill gate is, mm radius. */
const MAX_GATE_R = 2;

/** How much floor a bottom-fill runner of radius `r` needs under the cavity's lowest point, mm. */
export function bottomFillFloorMm(r: number): number {
  return RUNNER_CLEARANCE_MM + 2 * r + FEED_WALL_MM;
}

/**
 * The bottom-fill route: the cavity's lowest point, and the nearest spot in
 * the wall beside the cavity a down-sprue fits, clear of the cavity, the
 * block's edge (`maxFromPartMm` of wall round the part, for a block that
 * follows it) and anything in `avoid`. Null when there is no such spot.
 */
export function planBottomFill(
  spans: PourSpans,
  grid: Grid,
  r: number,
  avoid: Array<{ x: number; y: number; r: number }>,
  maxFromPartMm: number,
): BottomFill | null {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const xOf = (c: number) => -halfW + c * stepX;
  const yOf = (row: number) => -halfD + row * stepY;
  let gate: BottomFill['gate'] | null = null;
  const hit = new Uint8Array(cols * rows);
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i];
    if (s.length === 0) continue;
    hit[i] = 1;
    if (!gate || s[0] < gate.z) gate = { x: xOf(i % cols), y: yOf(Math.floor(i / cols)), z: s[0] };
  }
  if (!gate) return null;

  // Distance from every column to the part's footprint.
  const dist = new Float64Array(cols * rows);
  for (let i = 0; i < dist.length; i++) dist[i] = hit[i] ? 0 : Infinity;
  const diag = Math.hypot(stepX, stepY);
  const sweep = (fwd: boolean) => {
    for (let s = 0; s < dist.length; s++) {
      const i = fwd ? s : dist.length - 1 - s;
      if (dist[i] === 0) continue;
      const row = Math.floor(i / cols), c = i % cols;
      const look = fwd
        ? [[-1, 0, stepX], [0, -1, stepY], [-1, -1, diag], [1, -1, diag]]
        : [[1, 0, stepX], [0, 1, stepY], [1, 1, diag], [-1, 1, diag]];
      for (const [dc, dr, w] of look) {
        const cc = c + dc, rr = row + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        dist[i] = Math.min(dist[i], dist[rr * cols + cc] + w);
      }
    }
  };
  sweep(true);
  sweep(false);

  const minFromPart = r + FEED_WALL_MM;
  const edge = r + FEED_WALL_MM;
  let best: { x: number; y: number; fromPart: number } | null = null;
  let bestD = Infinity;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] < minFromPart || dist[i] > maxFromPartMm - edge) continue;
    const x = xOf(i % cols), y = yOf(Math.floor(i / cols));
    if (Math.abs(x) > halfW - edge || Math.abs(y) > halfD - edge) continue;
    if (avoid.some((a) => Math.hypot(x - a.x, y - a.y) < a.r + r + FEED_WALL_MM)) continue;
    const d = Math.hypot(x - gate.x, y - gate.y);
    if (d < bestD) {
      bestD = d;
      best = { x, y, fromPart: dist[i] };
    }
  }
  if (!best) return null;
  return {
    down: { x: best.x, y: best.y },
    gate,
    runnerZ: gate.z - RUNNER_CLEARANCE_MM - r,
    r,
    gateR: Math.min(r, MAX_GATE_R),
    roomR: maxFromPartMm - best.fromPart,
  };
}

/** The stubs a closed mold's vents leave on a casting, for trimming; `at` in the cavity half's frame. */
export function ventStubsOf(f: MoldFeatureReport | undefined): VentStub[] | undefined {
  if (!f?.vents.length) return undefined;
  return f.vents.flatMap((v) => (v.pocketZMm === undefined ? [] : [{ at: [v.atMm[0], -v.atMm[1]] as [number, number], r: v.diaMm / 2, z: v.pocketZMm }]));
}

/** A round bore from `a` to `b` in a half's own frame, mm; `ends` rounds its ends off with balls. */
export interface BoreCut {
  a: [number, number, number];
  b: [number, number, number];
  r: number;
  /** Radius at `b`, for a cone; `r` if not given. */
  rB?: number;
  ends?: boolean;
}

/**
 * A bore as solids to subtract one at a time: a cylinder turned onto its
 * axis, and balls on its ends if asked. Not unioned: a union whose parts were
 * deleted before Manifold evaluated it once lost a mold its sprue (moldSprue.ts).
 */
export function boreSolids(wasm: ManifoldToplevel, cut: BoreCut): Manifold[] {
  const [ax, ay, az] = cut.a;
  const d = [cut.b[0] - ax, cut.b[1] - ay, cut.b[2] - az];
  const len = Math.hypot(d[0], d[1], d[2]);
  // From +z onto the axis: tilt about y, then turn about z.
  const tilt = len > 1e-9 ? (Math.acos(Math.max(-1, Math.min(1, d[2] / len))) * 180) / Math.PI : 0;
  const turn = len > 1e-9 ? (Math.atan2(d[1], d[0]) * 180) / Math.PI : 0;
  const out = [wasm.Manifold.cylinder(Math.max(len, 1e-3), cut.r, cut.rB ?? cut.r, 32, false).rotate([0, tilt, 0]).rotate([0, 0, turn]).translate([ax, ay, az])];
  if (cut.ends) for (const p of [cut.a, cut.b]) out.push(wasm.Manifold.sphere(cut.r, 32).translate(p));
  return out;
}

/** Subtracts every bore from `m`, one solid at a time; `m` is consumed. */
export function cutBores(wasm: ManifoldToplevel, m: Manifold, cuts: BoreCut[]): Manifold {
  let out = m;
  for (const cut of cuts) {
    for (const tool of boreSolids(wasm, cut)) {
      const next = out.subtract(tool);
      out.delete();
      tool.delete();
      out = next;
    }
  }
  return out;
}

/** A half built as triangles (the depth-field mold) with its bores cut, through the geometry engine. */
export function boreTriangles(wasm: ManifoldToplevel, tris: Triangle3D[], cuts: BoreCut[]): Triangle3D[] {
  if (!cuts.length || !tris.length) return tris;
  const flat = new Float64Array(tris.length * 9);
  tris.forEach((t, i) => flat.set([...t.a, ...t.b, ...t.c], i * 9));
  const { part } = buildPartManifold(wasm, flat);
  if (!part) return tris;
  const cut = cutBores(wasm, part, cuts);
  const out = manifoldToTriangles(cut);
  cut.delete();
  return out.length ? out : tris;
}

/** A bottom-filled mold's route from its feature report, for trimming it off a casting. */
export function feedRouteOf(f: MoldFeatureReport | undefined): FeedRoute | undefined {
  if (!f || f.feed !== 'bottom' || !f.downSprue || !f.gate) return undefined;
  const r = f.downSprue.diaMm / 2;
  return {
    down: f.downSprue.atMm,
    gate: [f.gate.atMm[0], f.gate.atMm[1], -(f.gate.depthMm ?? 0)],
    runnerZ: r - (f.downSprue.depthMm ?? 0),
    r,
    gateR: f.gate.diaMm / 2,
    ...(f.sprue ? { funnelR: f.sprue.diaMm / 2, funnelDepth: f.sprue.depthMm ?? 0 } : {}),
  };
}
