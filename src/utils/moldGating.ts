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
import type { HalfFeatures, MoldFeatureReport } from './moldExporter';
import { buildPartManifold, manifoldToTriangles, type Triangle3D } from './moldManifold';
import { channelSolid } from './moldSprue';

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

/**
 * Every column of a connected region of the grid, by how many cells it lies
 * inside the region's edge: peeled from the edge in, so the highest is the
 * region's middle.
 */
function peelRegion(region: Set<number>, cols: number, rows: number): Map<number, number> {
  const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const inRegion = (c: number, r: number) => c >= 0 && r >= 0 && c < cols && r < rows && region.has(r * cols + c);
  const depth = new Map<number, number>();
  let ring = [...region].filter((col) => {
    const r = Math.floor(col / cols), c = col - r * cols;
    return around.some(([dc, dr]) => !inRegion(c + dc, r + dr));
  });
  for (let d = 0; ring.length; d++) {
    for (const col of ring) depth.set(col, d);
    const next = new Set<number>();
    for (const col of ring) {
      const r = Math.floor(col / cols), c = col - r * cols;
      for (const [dc, dr] of around) {
        if (inRegion(c + dc, r + dr) && !depth.has((r + dr) * cols + c + dc)) next.add((r + dr) * cols + c + dc);
      }
    }
    ring = [...next];
  }
  return depth;
}

/** The columns connected to `start` that pass `keep`. */
function floodRegion(start: number, cols: number, rows: number, keep: (col: number) => boolean): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const col = queue[q], r = Math.floor(col / cols), c = col - r * cols;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
      const n = rr * cols + cc;
      if (seen.has(n) || !keep(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** The least a vent or gate goes into the cavity, so its rim is not left as a skin, mm. */
export const MOUTH_SINK_MM = 0.3;

/**
 * How far a round bore (a vent coming down on a peak, a gate coming up to a
 * low point) has to go into the cavity past that point, mm. The bore stops
 * flat, so what it opens is the cavity's section there. On a ball that is all
 * of it at 0.3 mm; on a ridge or a cone's tip the same 0.3 mm opened a slot
 * ⌀1.4 mm across, for a bore of ⌀4, however wide the bore was.
 *
 * So it goes in until the section inside it reaches `wantMm2`, no further than
 * `maxMm`, and no further than the feature widens: a post the same all the
 * way down would gain nothing, and every millimetre is a collar on the casting.
 */
export function mouthSinkMm(
  spans: PourSpans,
  grid: Grid,
  at: { x: number; y: number; z: number },
  r: number,
  /** +1 going up into the cavity from a low point, -1 coming down from a peak. */
  dir: 1 | -1,
  wantMm2: number,
  maxMm: number,
): number {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const c0 = Math.max(0, Math.floor((at.x - r + halfW) / stepX));
  const c1 = Math.min(cols - 1, Math.ceil((at.x + r + halfW) / stepX));
  const r0 = Math.max(0, Math.floor((at.y - r + halfD) / stepY));
  const r1 = Math.min(rows - 1, Math.ceil((at.y + r + halfD) / stepY));
  const under: Float64Array[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let c = c0; c <= c1; c++) {
      if (Math.hypot(-halfW + c * stepX - at.x, -halfD + row * stepY - at.y) <= r) under.push(spans[row * cols + c]);
    }
  }
  const sectionMm2 = (sink: number) => {
    const z = at.z + dir * sink;
    let n = 0;
    for (const s of under) {
      for (let k = 0; k + 1 < s.length; k += 2) {
        if (z >= s[k] && z <= s[k + 1]) {
          n++;
          break;
        }
      }
    }
    return n * stepX * stepY;
  };
  const tries: number[] = [];
  for (let sink = MOUTH_SINK_MM; sink < maxMm + 1e-9; sink += 0.1) tries.push(sink);
  if (!tries.length) return MOUTH_SINK_MM;
  const areas = tries.map(sectionMm2);
  const enough = Math.min(wantMm2, 0.9 * Math.max(...areas));
  return tries[Math.max(0, areas.findIndex((a) => a >= enough))];
}

/**
 * The cavity on a grid of half the columns each way, whose columns are still
 * columns of the full one. Finding high points fills a voxel grid, so twice the
 * resolution is eight times the memory, for pockets that are no finer: a tall
 * mold would run out of it.
 */
export function everyOtherColumn(spans: PourSpans, grid: Grid): [PourSpans, Grid] {
  const cols = Math.ceil(grid.cols / 2);
  const rows = Math.ceil(grid.rows / 2);
  const out: PourSpans = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out[r * cols + c] = spans[2 * r * grid.cols + 2 * c];
  }
  return [out, { ...grid, cols, rows, stepX: grid.stepX * 2, stepY: grid.stepY * 2 }];
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
    const depth = peelRegion(floodRegion(start, cols, rows, (n) => solid(n, k)), cols, rows);
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
  /** Where the gate stops, mm: inside the cavity, as far as gives it a mouth as wide as it is. */
  gateTopZ: number;
  /** How wide the funnel above it may be and stay inside a block that follows the part. */
  roomR: number;
}

/** Wall between a down-sprue and the cavity or the block's edge, mm. */
export const FEED_WALL_MM = 1.5;
/** Mold between the runner and the cavity's lowest point, mm. */
export const RUNNER_CLEARANCE_MM = 1;
/** How much floor a bottom-fill runner of radius `r` needs under the cavity's lowest point, mm. */
export function bottomFillFloorMm(r: number): number {
  return RUNNER_CLEARANCE_MM + 2 * r + FEED_WALL_MM;
}

/**
 * Where a gate of radius `gateR` meets the cavity's lowest point. On a flat
 * underside every column is equally low, and taking the first found put the
 * gate on the part's corner, three quarters of it in solid mold. So: inside
 * the low region by the gate's radius (or as far as it goes), and of those the
 * spot nearest the block's edge, for the shortest runner.
 */
function lowestSpot(spans: PourSpans, grid: Grid, gateR: number): BottomFill['gate'] | null {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  let start = -1;
  let z = Infinity;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].length && spans[i][0] < z) {
      z = spans[i][0];
      start = i;
    }
  }
  if (start < 0) return null;
  const low = floodRegion(start, cols, rows, (n) => spans[n].length > 0 && spans[n][0] <= z + MOUTH_SINK_MM);
  const depth = peelRegion(low, cols, rows);
  const cell = Math.min(stepX, stepY);
  const need = Math.min(Math.ceil(gateR / cell), Math.max(...depth.values()));
  let best = start;
  let bestEdge = Infinity;
  let bestOff = Infinity;
  for (const [col, d] of depth) {
    if (d < need) continue;
    const x = -halfW + (col % cols) * stepX, y = -halfD + Math.floor(col / cols) * stepY;
    const edge = Math.min(halfW - Math.abs(x), halfD - Math.abs(y));
    const off = Math.hypot(x, y);
    if (edge < bestEdge - 1e-9 || (edge < bestEdge + 1e-9 && off < bestOff)) {
      best = col;
      bestEdge = edge;
      bestOff = off;
    }
  }
  return { x: -halfW + (best % cols) * stepX, y: -halfD + Math.floor(best / cols) * stepY, z };
}

/**
 * The bottom-fill route: the cavity's lowest point, and the nearest spot in
 * the wall beside the cavity a down-sprue fits, clear of the cavity, the
 * block's edge (`maxFromPartMm` of wall round the part, for a block that
 * follows it) and anything in `avoid`. Null when there is no such spot.
 * `gateDia` is what the cast material can pass (`gateDiaMm`, moldSprue.ts).
 */
export function planBottomFill(
  spans: PourSpans,
  grid: Grid,
  r: number,
  avoid: Array<{ x: number; y: number; r: number }>,
  maxFromPartMm: number,
  gateDia: number,
): BottomFill | null {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const xOf = (c: number) => -halfW + c * stepX;
  const yOf = (row: number) => -halfD + row * stepY;
  const gateR = Math.min(r, gateDia / 2);
  const gate = lowestSpot(spans, grid, gateR);
  if (!gate) return null;
  const hit = new Uint8Array(cols * rows);
  for (let i = 0; i < spans.length; i++) if (spans[i].length) hit[i] = 1;

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
    if (dist[i] < minFromPart) continue;
    // Bores are cut exactly, so a column just outside the block's limit comes
    // in to it. Held to the grid, a 10 mm wall on the 1.47 mm grid of a 200 mm
    // part had no column in the 1 mm band that fits, and was refused.
    const gx = xOf(i % cols), gy = yOf(Math.floor(i / cols));
    const x = Math.max(edge - halfW, Math.min(halfW - edge, gx));
    const y = Math.max(edge - halfD, Math.min(halfD - edge, gy));
    const fromPart = dist[i] - Math.hypot(gx - x, gy - y);
    if (fromPart < minFromPart || fromPart > maxFromPartMm - edge) continue;
    if (avoid.some((a) => Math.hypot(x - a.x, y - a.y) < a.r + r + FEED_WALL_MM)) continue;
    const d = Math.hypot(x - gate.x, y - gate.y);
    if (d < bestD) {
      bestD = d;
      best = { x, y, fromPart };
    }
  }
  if (!best) return null;
  return {
    down: { x: best.x, y: best.y },
    gate,
    runnerZ: gate.z - RUNNER_CLEARANCE_MM - r,
    r,
    gateR,
    gateTopZ: gate.z + mouthSinkMm(spans, grid, gate, gateR, 1, Math.PI * gateR * gateR, gateR),
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

/**
 * A half's sockets, channels, pins and bores cut into it, in that half's own
 * frame; `m` is consumed. Every mold gets the same exact, round features.
 */
export function cutHalfFeatures(wasm: ManifoldToplevel, m: Manifold, feats: HalfFeatures, blockHeightMm: number): Manifold {
  let out = m;
  const take = (tool: Manifold) => {
    const next = out.subtract(tool);
    out.delete();
    tool.delete();
    out = next;
  };
  for (const s of feats.sockets) take(wasm.Manifold.cylinder(s.depth + 0.5, s.botR, s.rimR, 24, false).translate([s.x, s.y, -s.depth]));
  for (const ch of feats.channels) take(channelSolid(wasm, ch, blockHeightMm));
  for (const p of feats.pins) {
    const pin = wasm.Manifold.cylinder(p.height + 0.5, p.baseR, p.topR, 24, false).translate([p.x, p.y, -0.5]);
    const next = out.add(pin);
    out.delete();
    pin.delete();
    out = next;
  }
  return feats.bores?.length ? cutBores(wasm, out, feats.bores) : out;
}

/**
 * A depth-field half with its features cut through the geometry engine. Null
 * if the half will not close. Sampled onto the grid instead, a pin and its
 * socket come out as two different lumps: 14 mm³ of them collided on a 300 mm
 * mold, and the seam stood open by it.
 */
export function cutHalfTriangles(wasm: ManifoldToplevel, tris: Triangle3D[], feats: HalfFeatures, blockHeightMm: number): Triangle3D[] | null {
  const flat = new Float64Array(tris.length * 9);
  tris.forEach((t, i) => flat.set([...t.a, ...t.b, ...t.c], i * 9));
  const { part } = buildPartManifold(wasm, flat);
  if (!part) return null;
  const cut = cutHalfFeatures(wasm, part, feats, blockHeightMm);
  const out = manifoldToTriangles(cut);
  cut.delete();
  return out.length ? out : null;
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
