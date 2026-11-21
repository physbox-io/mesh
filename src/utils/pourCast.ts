// ---------------------------------------------------------------------------
// Pouring into a mold that is already in the scene
// ---------------------------------------------------------------------------
//
// A mold body in the scene need not stand open side up: a silicone mold comes
// off its master with the opening underneath, and a printed mold may lie on its
// side. So the empty space inside the mold is found once, and each of the six
// sides is tried as the one to pour from. The pour fills a pocket open only on
// that side, to the fill height asked for, or to where it would spill over the
// lowest point of its rim — a flash fin round a silicone mold's edge makes a
// pocket that is open on its sides too, and the liquid stops below the fin.
// ---------------------------------------------------------------------------

import type { Manifold as ManifoldT, ManifoldToplevel } from 'manifold-3d';
import { manifoldToMeshMm } from './timberBreakdown';
import { castColumnSpans } from './columnSolid';

export type PourDirection = '+z' | '-z' | '+x' | '-x' | '+y' | '-y';

/** In preference order: as the mold stands first, then turned over, then on its sides. */
export const POUR_DIRECTIONS: readonly PourDirection[] = ['+z', '-z', '+x', '-x', '+y', '-y'];

export interface PourOptions {
  /** The side poured from, or 'auto' for the side that takes the most. */
  direction?: PourDirection | 'auto';
  /** How deep to fill, mm above the lowest point of the pocket. Absent or 0 fills to the rim. */
  fillMm?: number;
}

export interface PourInfo {
  direction: PourDirection;
  /** The deepest the pocket can be filled before it spills, mm. */
  depthMm: number;
  /** How deep it was filled, mm. */
  filledMm: number;
  /**
   * Plan area of the casting that the mold overhangs, seen from the side it was
   * poured from, mm². Anything over zero is held in by a rigid mold.
   */
  undercutMm2: number;
  /** Area of a hole through the mold's far side that must be plugged (a wick does), mm². */
  plugMm2?: number;
}

export interface Box {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
}

/** Turns a solid so `dir` points up (+Z). */
export function turnUp(m: ManifoldT, dir: PourDirection): ManifoldT {
  switch (dir) {
    case '+z': return m.rotate([0, 0, 0]);
    case '-z': return m.rotate([180, 0, 0]);
    case '+x': return m.rotate([0, -90, 0]);
    case '-x': return m.rotate([0, 90, 0]);
    case '+y': return m.rotate([-90, 0, 0]);
    case '-y': return m.rotate([90, 0, 0]);
  }
}

/** The probe box as seen once `dir` is turned up: the box itself, turned the same way. */
function turnBox(wasm: ManifoldToplevel, box: Box, dir: PourDirection): Box {
  const cube = wasm.Manifold.cube([box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ], false)
    .translate([box.minX, box.minY, box.minZ]);
  const turned = turnUp(cube, dir);
  const { min, max } = turned.boundingBox();
  cube.delete();
  turned.delete();
  return { minX: min[0], maxX: max[0], minY: min[1], maxY: max[1], minZ: min[2], maxZ: max[2] };
}

const EPS = 1e-3;

/** Which faces of the box a piece reaches: [-x, +x, -y, +y, -z, +z]. */
export function facesTouched(m: ManifoldT, b: Box): boolean[] {
  const { min, max } = m.boundingBox();
  return [
    min[0] <= b.minX + EPS, max[0] >= b.maxX - EPS,
    min[1] <= b.minY + EPS, max[1] >= b.maxY - EPS,
    min[2] <= b.minZ + EPS, max[2] >= b.maxZ - EPS,
  ];
}

/** How many faces of the box a piece reaches. */
export function probeFacesTouched(m: ManifoldT, b: Box): number {
  return facesTouched(m, b).filter(Boolean).length;
}

/** Inside the box's sides, clear of all four. */
function clearOfSides(lo: readonly number[], hi: readonly number[], b: Box): boolean {
  return lo[0] > b.minX + EPS && hi[0] < b.maxX - EPS && lo[1] > b.minY + EPS && hi[1] < b.maxY - EPS;
}

/**
 * The highest level a pour from the top can reach in a piece of cavity before
 * it runs out over a side of the box: the top of the highest cross-section that
 * stays clear of the sides. -Infinity when none does.
 */
export function spillLevel(m: ManifoldT, b: Box, step = 0.25): number {
  const { min, max } = m.boundingBox();
  if (clearOfSides(min, max, b)) return max[2];
  for (let z = max[2] - step / 2; z > min[2]; z -= step) {
    const section = m.slice(z);
    const empty = section.isEmpty();
    const r = empty ? null : section.bounds();
    section.delete();
    if (r && clearOfSides(r.min, r.max, b)) return z;
  }
  return -Infinity;
}

/** A filled piece left out of the casting: its volume and middle, in the frame poured in. */
export interface DroppedPocket { volumeMm3: number; atMm: [number, number, number] }

/**
 * Decomposes `m` into disconnected solid bodies while keeping any enclosed
 * internal void shells (`volume() < 0`) composed inside their enclosing outer
 * solid. Plain `m.decompose()` splits disconnected boundary shells regardless
 * of orientation, which separates a submerged master + pour-hole pin void from
 * the silicone cylinder surrounding it.
 */
export function decomposeSolids(wasm: ManifoldToplevel, m: ManifoldT): ManifoldT[] {
  const raw = m.decompose();
  if (raw.length <= 1) return raw;
  const pos: ManifoldT[] = [];
  const neg: ManifoldT[] = [];
  for (const p of raw) {
    if (p.volume() < 0) neg.push(p);
    else pos.push(p);
  }
  if (neg.length === 0) return pos;
  if (pos.length === 0) {
    for (const n of neg) n.delete();
    return [];
  }
  const posMeta = pos.map((p) => ({ b: p.boundingBox(), vol: p.volume() }));
  const grouped: ManifoldT[][] = pos.map((p) => [p]);
  for (const n of neg) {
    const nb = n.boundingBox();
    const pad = 1;
    const cube = wasm.Manifold.cube(
      [nb.max[0] - nb.min[0] + 2 * pad, nb.max[1] - nb.min[1] + 2 * pad, nb.max[2] - nb.min[2] + 2 * pad],
      false,
    ).translate([nb.min[0] - pad, nb.min[1] - pad, nb.min[2] - pad]);
    const withHole = wasm.Manifold.compose([cube, n]);
    withHole.numTri();
    const posN = cube.subtract(withHole);
    posN.numTri();
    cube.delete();
    withHole.delete();

    const wantVol = Math.abs(n.volume()) * 0.5;
    let bestIdx = -1;
    let bestVol = Infinity;
    for (let i = 0; i < pos.length; i++) {
      const pb = posMeta[i].b;
      if (
        nb.min[0] < pb.min[0] - 1e-3 || nb.max[0] > pb.max[0] + 1e-3 ||
        nb.min[1] < pb.min[1] - 1e-3 || nb.max[1] > pb.max[1] + 1e-3 ||
        nb.min[2] < pb.min[2] - 1e-3 || nb.max[2] > pb.max[2] + 1e-3
      ) continue;
      const hit = pos[i].intersect(posN);
      const hitVol = hit.volume();
      hit.delete();
      if (hitVol > wantVol && posMeta[i].vol < bestVol) {
        bestVol = posMeta[i].vol;
        bestIdx = i;
      }
    }
    posN.delete();
    if (bestIdx >= 0) grouped[bestIdx].push(n);
    else n.delete();
  }
  return grouped.map((g) => {
    if (g.length === 1) return g[0];
    const composed = wasm.Manifold.compose(g);
    composed.numTri();
    for (const x of g) x.delete();
    return composed;
  });
}

const middleOf = (m: ManifoldT): [number, number, number] => {
  const { min, max } = m.boundingBox();
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
};

/**
 * The largest piece of `m` at or below `level` that stays clear of the sides
 * (null when none), and the other pieces that fill too but are not joined to it.
 */
function filledBelow(wasm: ManifoldToplevel, m: ManifoldT, level: number, b: Box): { best: ManifoldT | null; others: DroppedPocket[] } {
  const below = m.trimByPlane([0, 0, -1], -level);
  const parts = decomposeSolids(wasm, below);
  below.delete();
  let best: ManifoldT | null = null;
  let bestVol = 0;
  const clear: DroppedPocket[] = [];
  let bestEntry: DroppedPocket | null = null;
  for (const p of parts) {
    const { min, max } = p.boundingBox();
    const v = p.volume();
    if (!clearOfSides(min, max, b)) { p.delete(); continue; }
    const entry = { volumeMm3: Math.round(v), atMm: middleOf(p) };
    clear.push(entry);
    if (v > bestVol) {
      bestEntry = entry;
      best?.delete();
      best = p;
      bestVol = v;
    } else {
      p.delete();
    }
  }
  const others = clear.filter((d) => d !== bestEntry && d.volumeMm3 > Math.max(1, bestVol * 0.01));
  return { best, others };
}

/**
 * Plan area, mm², of the casting that something stands over when seen from
 * above — a column through it with a gap in it, or that stops short of the
 * surface the pour left. A rigid mold cannot let go of any of it.
 */
export function undercutArea(m: ManifoldT): number {
  const { min, max } = m.boundingBox();
  const span = Math.max(max[0] - min[0], max[1] - min[1]);
  if (!(span > 0)) return 0;
  const cell = Math.max(0.2, span / 200);
  const cols = Math.ceil((max[0] - min[0]) / cell) + 1;
  const rows = Math.ceil((max[1] - min[1]) / cell) + 1;
  const { positionsMm, faces } = manifoldToMeshMm(m);
  const tris = new Float64Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    const v = faces[i] * 3;
    tris[i * 3] = positionsMm[v];
    tris[i * 3 + 1] = positionsMm[v + 1];
    tris[i * 3 + 2] = positionsMm[v + 2];
  }
  const spans = castColumnSpans(tris, { minX: min[0], minY: min[1], stepX: cell, stepY: cell, cols, rows });
  // A slope drawn by a coarse grid steps by up to a cell's rise; the surface
  // tolerance has to sit above that or every gently sloped casting is "undercut".
  const tol = Math.max(0.3, cell);
  let held = 0;
  for (let k = 0; k < cols * rows; k++) {
    const a = spans.offset[k];
    const n = spans.offset[k + 1] - a;
    if (n === 0) continue;
    const top = spans.z[a + n - 1];
    if (n > 2 || top < max[2] - tol) held++;
  }
  return held * cell * cell;
}

/**
 * Pours into the empty space round a mold: `cavity` is the probe box less the
 * mold. Returns the casting turned so the side it was poured from is up, or
 * null when no side holds a pour.
 */
export function pourIntoCavity(
  wasm: ManifoldToplevel,
  cavity: ManifoldT,
  box: Box,
  options: PourOptions = {},
): { casting: ManifoldT; info: PourInfo; pieces: number; dropped: DroppedPocket[] } | null {
  const parts = decomposeSolids(wasm, cavity);
  const pieces = parts.length;
  const dirs = !options.direction || options.direction === 'auto' ? POUR_DIRECTIONS : [options.direction];

  type Held = { dir: PourDirection; volumeMm3: number; atMm: [number, number, number] };
  let best: { casting: ManifoldT; info: PourInfo; volume: number; others: DroppedPocket[]; held: Held } | null = null;
  /** Every pocket that holds a pour, by side: the ones not chosen are left out of the casting. */
  const held: Held[] = [];
  for (const dir of dirs) {
    const b = turnBox(wasm, box, dir);
    for (const part of parts) {
      const touched = facesTouched(part, box);
      // A pocket sealed on every side is a void, not something to pour into.
      const top = POUR_DIRECTIONS.indexOf(dir);
      const topFace = [5, 4, 1, 0, 3, 2][top];
      const bottomFace = [4, 5, 0, 1, 2, 3][top];
      if (!touched[topFace]) continue;
      const turned = turnUp(part, dir);
      // Open underneath as well: a wick hole through a silicone mold, which the
      // wick plugs. A small hole is taken as plugged and named; anything bigger
      // and the pour runs straight out.
      let plugMm2 = 0;
      if (touched[bottomFace]) {
        const { min: lo, max: hi } = turned.boundingBox();
        const section = turned.slice(lo[2] + 0.05);
        plugMm2 = section.area();
        section.delete();
        const meanArea = turned.volume() / Math.max(1e-6, hi[2] - lo[2]);
        if (!(plugMm2 <= Math.max(20, 0.02 * meanArea))) {
          turned.delete();
          continue;
        }
      }
      const level = spillLevel(turned, b);
      const { min } = turned.boundingBox();
      if (!(level > min[2])) {
        turned.delete();
        continue;
      }
      const depthMm = level - min[2];
      const filledMm = options.fillMm && options.fillMm > 0 ? Math.min(options.fillMm, depthMm) : depthMm;
      const { best: casting, others } = filledBelow(wasm, turned, min[2] + filledMm, b);
      turned.delete();
      if (!casting) continue;
      const volume = casting.volume();
      const h: Held = { dir, volumeMm3: Math.round(volume), atMm: middleOf(casting) };
      held.push(h);
      // The way the mold stands wins unless another side holds a good deal more.
      if (!best || volume > best.volume * 1.05) {
        best?.casting.delete();
        best = { casting, info: { direction: dir, depthMm, filledMm, undercutMm2: 0, ...(plugMm2 > 0 ? { plugMm2: Math.round(plugMm2 * 10) / 10 } : {}) }, volume, others, held: h };
      } else {
        casting.delete();
      }
    }
  }
  for (const p of parts) p.delete();
  if (!best) return null;
  best.info.undercutMm2 = Math.round(undercutArea(best.casting));
  best.info.depthMm = Math.round(best.info.depthMm * 100) / 100;
  best.info.filledMm = Math.round(best.info.filledMm * 100) / 100;
  const chosen = best;
  const dropped = [
    ...chosen.others,
    ...held.filter((h) => h !== chosen.held && h.dir === chosen.info.direction && h.volumeMm3 > Math.max(1, chosen.volume * 0.01))
      .map(({ volumeMm3, atMm }) => ({ volumeMm3, atMm })),
  ].sort((a, b) => b.volumeMm3 - a.volumeMm3);
  return { casting: chosen.casting, info: chosen.info, pieces, dropped };
}
