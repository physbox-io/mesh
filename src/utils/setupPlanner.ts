/**
 * Which faces of the block a part has to be machined from, and in what order.
 *
 * A 3-axis router only cuts what it can see from above, so a part with an
 * overhang (a phone slot that leans back, the hole in an "o" standing upright)
 * keeps material no single setup can reach. This looks at the part from all
 * six faces of the block, works out what each can reach with the cutter it
 * has, and picks the fewest setups that clear it, cheapest first.
 *
 * Everything here is in setup 1's work frame (`orient.ts`): the block runs +X
 * +Y from its near-left corner and down from Z0, and the part sits in it at
 * `partBox`. The top (+Z) is always a setup: it is the one solid machining has
 * always cut, with the channel, frame and tabs round the part. The underside
 * (-Z) is the flip it has always offered. The four sides are the new ones.
 */

import { voxelize, castColumnSpans, type VoxelGrid } from './columnSolid';
import { BLOCK_FACES, FACE_NAME, type BlockFace } from './orient';

export interface PartBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface PlannerInput {
  /** The part's triangles placed in the stock, setup 1's frame, mm. */
  tris: Float64Array;
  /** The part's bounds in the same frame. */
  partBox: PartBox;
  /** The stock, from its near-left top corner. */
  stock: { widthMm: number; depthMm: number; thicknessMm: number };
  /** Diameter of the cutter a side setup reaches in with, mm. */
  toolDiaMm: number;
  /**
   * How deep below a face that cutter can go, mm: its flute or stickout, and
   * no more than `MAX_REACH_DIAMETERS` diameters unless the bit is a
   * long-reach one.
   */
  reachMm: number;
  /** At most this many setups. Default 4. */
  maxSetups?: number;
  /** Whether the underside may be a setup (the flip). */
  allowUnderside?: boolean;
  /** Whether the four sides may be setups. */
  allowSides?: boolean;
  /**
   * Height free under the spindle with the bit fitted, mm, from the bed. A
   * block stood on end has to fit under it. 0 when unknown, which is not
   * checked and is said so.
   */
  clearanceMm?: number;
  /** How far the bit sticks out of the collet, mm. */
  stickoutMm?: number;
  /** Voxel size for the search, mm. Default from the part's size. */
  cellMm?: number;
  /** Plan exactly these faces, without searching: the plan made again on the final placement. */
  onlyFaces?: BlockFace[];
}

/** What a chosen face cuts, for a setup to be built from. */
export interface FacePlan {
  face: BlockFace;
  /** Material this face is the best way to, mm³. */
  clearedMm3: number;
  /** Deepest it has to go below its own stock face, mm. */
  depthMm: number;
  /** That depth in cutter diameters. */
  lengthOverDia: number;
  /** How tall the block stands for this setup, mm. */
  standingHeightMm: number;
}

export interface SetupPlan {
  /** Faces in the order they are run. */
  order: BlockFace[];
  faces: Record<string, FacePlan>;
  /** The setup that cuts the part free of its frame: the last one. */
  freeing: BlockFace;
  /** Material between the part and the stock inside the part's bounds, mm³. */
  targetMm3: number;
  /** What no chosen face reaches, mm³. */
  unreachedMm3: number;
  /** Where that is, in setup 1's frame. */
  unreachedBounds: PartBox | null;
  /** What the top alone would leave, mm³: the reason any other setup is here. */
  topOnlyUnreachedMm3: number;
  /**
   * What no face at all can reach with this cutter, mm³: inside corners
   * sharper than it, a pocket's square corners. Left as a fillet whatever the
   * plan; a smaller cutter makes it smaller.
   */
  unreachableAnywhereMm3: number;
  /** Faces considered and left out, and why. */
  dropped: { face: BlockFace; reason: string }[];
  cost: number;
  /** Every choice weighed, cheapest first: what each would leave, and its cost. */
  alternatives: { faces: BlockFace[]; cost: number; unreachedMm3: number }[];
  /** The voxel grid the plan was made on, and per voxel which face clears it. */
  grid: VoxelGrid;
  owner: Int8Array;
}

/** Index of a face in `BLOCK_FACES`. */
const faceIndex = (f: BlockFace) => BLOCK_FACES.indexOf(f);

/**
 * How a face looks into the voxel grid: which axis it looks down, from which
 * end, and which two axes make the plane it sees.
 */
interface FaceView {
  /** Axis looked down: 0 x, 1 y, 2 z. */
  axis: 0 | 1 | 2;
  /** True when the face is at the high end of that axis. */
  high: boolean;
  /** The plane's two axes. */
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
}

const VIEW: Record<BlockFace, FaceView> = {
  '+z': { axis: 2, high: true, u: 0, v: 1 },
  '-z': { axis: 2, high: false, u: 0, v: 1 },
  '+x': { axis: 0, high: true, u: 1, v: 2 },
  '-x': { axis: 0, high: false, u: 1, v: 2 },
  '+y': { axis: 1, high: true, u: 0, v: 2 },
  '-y': { axis: 1, high: false, u: 0, v: 2 },
};

const dims = (g: VoxelGrid): [number, number, number] => [g.nx, g.ny, g.nz];

/**
 * Per voxel, how far below `face` it is in voxels when the cutter can get to
 * it from there, else -1.
 *
 * "Can get to it" is an opening: the cutter's centre can only stand where its
 * whole disc is clear of the part down to that depth (an erosion of the
 * first-hit depth by the disc), and what it then clears is everything its disc
 * sweeps (a dilation). A sliver under an overhang thinner than the cutter is
 * not reachable on its own, but is when it opens off a slot the cutter fits.
 */
function reachFrom(g: VoxelGrid, face: BlockFace, radiusCells: number): Int16Array {
  const n = dims(g);
  const { axis, high, u, v } = VIEW[face];
  const nu = n[u], nv = n[v], nd = n[axis];
  const stride = [1, g.nx, g.nx * g.ny];
  const index = (iu: number, iv: number, d: number) =>
    iu * stride[u] + iv * stride[v] + (high ? nd - 1 - d : d) * stride[axis];

  // First solid voxel down each column; nd when there is none.
  const first = new Int32Array(nu * nv).fill(nd);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      for (let d = 0; d < nd; d++) {
        if (g.solid[index(iu, iv, d)]) {
          first[iv * nu + iu] = d;
          break;
        }
      }
    }
  }

  // The disc, as offsets. Off the grid is stock round the part, not part, so
  // a cutter may stand there at any depth.
  const disc: [number, number][] = [];
  const rc = Math.max(0, radiusCells);
  const R = Math.ceil(rc);
  for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) if (a * a + b * b <= rc * rc + 1e-9) disc.push([a, b]);
  const at = (m: Int32Array, iu: number, iv: number) =>
    iu < 0 || iv < 0 || iu >= nu || iv >= nv ? 1 << 30 : m[iv * nu + iu];

  const eroded = new Int32Array(nu * nv);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      let lo = 1 << 30;
      for (const [a, b] of disc) lo = Math.min(lo, at(first, iu + a, iv + b));
      eroded[iv * nu + iu] = lo;
    }
  }
  const opened = new Int32Array(nu * nv);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      let hi = 0;
      for (const [a, b] of disc) {
        const iu2 = iu + a, iv2 = iv + b;
        if (iu2 < 0 || iv2 < 0 || iu2 >= nu || iv2 >= nv) continue;
        hi = Math.max(hi, eroded[iv2 * nu + iu2]);
      }
      // Never past the part itself in this column.
      opened[iv * nu + iu] = Math.min(hi, first[iv * nu + iu]);
    }
  }

  const out = new Int16Array(g.solid.length).fill(-1);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      const limit = opened[iv * nu + iu];
      for (let d = 0; d < Math.min(limit, nd); d++) out[index(iu, iv, d)] = d;
    }
  }
  return out;
}

/** How far the stock runs past the part on each face, mm. */
function margins(input: PlannerInput): Record<BlockFace, number> {
  const b = input.partBox, s = input.stock;
  return {
    '+z': Math.max(0, -b.maxZ),
    '-z': Math.max(0, b.minZ + s.thicknessMm),
    '+x': Math.max(0, s.widthMm - b.maxX),
    '-x': Math.max(0, b.minX),
    '+y': Math.max(0, s.depthMm - b.maxY),
    '-y': Math.max(0, b.minY),
  };
}

/** How tall the block stands with `face` up, mm. */
function standingHeight(face: BlockFace, s: PlannerInput['stock']): number {
  return face === '+x' || face === '-x' ? s.widthMm : face === '+y' || face === '-y' ? s.depthMm : s.thicknessMm;
}

/**
 * A face has to clear at least this share of what the top leaves, and this
 * much at all, to be worth turning the block for.
 */
const MIN_SHARE = 0.05;
const MIN_MM3 = 20;
/**
 * What is left uncut is weighed in units of this share of the part's volume
 * (never under `MIN_MM3`): a setup is worth adding once it clears about one
 * unit more than the block's turn costs. Material left on is a part that is
 * wrong, not one that is slow, so it outweighs time by far.
 */
const LEFT_UNIT_SHARE = 0.0005;
/** Which side to stand the block on when two cost the same: the front is the one an operator reads. */
const SIDE_PREFERENCE: BlockFace[] = ['-y', '-x', '+x', '+y'];

/**
 * The plan: every subset of faces up to `maxSetups`, scored, cheapest kept.
 *
 * Each bit of material is given to the chosen face it is shallowest under, so
 * an opposite pair splits at the middle and a side only takes what is nearer
 * its end than the top. Cost is the setups, a penalty for reaching deep with a
 * thin cutter, the cutting time, and ten times the share left unreached, so a
 * setup is only added when it clears enough to pay for turning the block.
 */
export function planSetups(input: PlannerInput): SetupPlan {
  const b = input.partBox;
  const size = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
  const volume = (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ);
  // A third of the cutter's radius, so the opening resolves what the cutter
  // fits into, and no more than two million voxels.
  const cell =
    input.cellMm ??
    Math.max(0.2, Math.cbrt(volume / 2_000_000), Math.min(input.toolDiaMm / 6, size / 40));
  const grid = voxelize(input.tris, b, cell);
  const margin = margins(input);
  const radiusCells = input.toolDiaMm / 2 / cell;

  const allowed: BlockFace[] = ['+z'];
  const dropped: { face: BlockFace; reason: string }[] = [];
  if (input.allowUnderside !== false) allowed.push('-z');
  if (input.allowSides !== false) {
    for (const f of ['+x', '-x', '+y', '-y'] as BlockFace[]) {
      const standing = standingHeight(f, input.stock);
      if (input.clearanceMm && input.clearanceMm > 0) {
        const need = standing + (input.stickoutMm ?? 0);
        if (need > input.clearanceMm) {
          dropped.push({
            face: f,
            reason:
              `stood on end the block is ${standing.toFixed(0)} mm tall, and with the bit's ` +
              `${(input.stickoutMm ?? 0).toFixed(0)} mm that needs ${need.toFixed(0)} mm under the spindle, ` +
              `against ${input.clearanceMm.toFixed(0)} mm`,
          });
          continue;
        }
      }
      allowed.push(f);
    }
  }

  // Depth below each allowed face, in mm, for every air voxel it can reach.
  const air: number[] = [];
  for (let i = 0; i < grid.solid.length; i++) if (!grid.solid[i]) air.push(i);
  const depthMm = new Map<BlockFace, Float32Array>();
  for (const f of allowed) {
    const reach = reachFrom(grid, f, radiusCells);
    const d = new Float32Array(air.length);
    // The top and underside are cut by solid machining's own surface jobs,
    // which hold the cutter's body clear and warn about reach themselves.
    const limit = f === '+z' || f === '-z' ? Infinity : input.reachMm;
    for (let a = 0; a < air.length; a++) {
      const r = reach[air[a]];
      const mm = r < 0 ? Infinity : (r + 1) * cell + margin[f];
      d[a] = mm <= limit ? mm : Infinity;
    }
    depthMm.set(f, d);
  }

  const voxelMm3 = cell ** 3;
  const targetMm3 = air.length * voxelMm3;
  const sides = SIDE_PREFERENCE.filter((f) => allowed.includes(f));
  const maxSetups = Math.max(1, input.maxSetups ?? 4);

  /** Scores one choice of faces. */
  const score = (chosen: BlockFace[]) => {
    const cleared = new Map<BlockFace, number>(chosen.map((f) => [f, 0]));
    const deepest = new Map<BlockFace, number>(chosen.map((f) => [f, 0]));
    const arrays = chosen.map((f) => depthMm.get(f)!);
    let unreached = 0;
    for (let a = 0; a < air.length; a++) {
      let best = Infinity, who = -1;
      for (let c = 0; c < arrays.length; c++) {
        const v = arrays[c][a];
        if (v < best) { best = v; who = c; }
      }
      if (who < 0) { unreached++; continue; }
      const f = chosen[who];
      cleared.set(f, cleared.get(f)! + 1);
      if (best > deepest.get(f)!) deepest.set(f, best);
    }
    return { cleared, deepest, unreached };
  };

  const topOnly = score(['+z']);
  // Air no face at all can reach (a square inside corner a round cutter
  // cannot get into) is no reason to turn the block.
  const anyFace = score(allowed);
  const partMm3 = Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ) - targetMm3);
  const unit = Math.max(MIN_MM3, LEFT_UNIT_SHARE * partMm3);
  const alternatives: SetupPlan['alternatives'] = [];
  let best: { chosen: BlockFace[]; cost: number; s: ReturnType<typeof score> } | null = null;
  const zSets: BlockFace[][] = allowed.includes('-z') ? [['+z'], ['+z', '-z']] : [['+z']];
  const forced = input.onlyFaces?.filter((f) => allowed.includes(f) || f === '+z');
  for (const zs of forced ? [forced.filter((f) => f === '+z' || f === '-z')] : zSets) {
    for (let mask = 0; mask < 1 << sides.length; mask++) {
      const chosenSides = sides.filter((_, i) => mask & (1 << i));
      const chosen = [...zs, ...chosenSides];
      if (forced && (chosen.length !== forced.length || !forced.every((f) => chosen.includes(f)))) continue;
      if (!forced && chosen.length > maxSetups) continue;
      const s = score(chosen);
      // A setup that clears next to nothing is a block turned for nothing.
      const floor = Math.max(MIN_MM3, MIN_SHARE * (topOnly.unreached - anyFace.unreached) * voxelMm3);
      if (!forced && chosen.slice(1).some((f) => s.cleared.get(f)! * voxelMm3 < floor)) continue;
      let ld = 0;
      for (const f of chosenSides) ld += Math.max(0, s.deepest.get(f)! / input.toolDiaMm - 3) * 0.25;
      // Cutting time, as a share of what the top alone would take: only
      // differences between plans matter here.
      const time = (air.length - s.unreached) / Math.max(1, air.length);
      const left = ((s.unreached - anyFace.unreached) * voxelMm3) / unit;
      const cost = (chosen.length - 1) + ld + time + left;
      alternatives.push({ faces: chosen, cost, unreachedMm3: s.unreached * voxelMm3 });
      const better =
        !best ||
        cost < best.cost - 1e-9 ||
        (Math.abs(cost - best.cost) <= 1e-9 && chosen.length < best.chosen.length);
      if (better) best = { chosen, cost, s };
    }
  }
  const pick = best!;

  // Order: sides before the setup that frees the part, which goes last. With
  // the underside in the plan the top runs first, as side A always has, and
  // the flip frees it.
  const twoSided = pick.chosen.includes('-z');
  const chosenSides = pick.chosen.filter((f) => f !== '+z' && f !== '-z');
  const order: BlockFace[] = twoSided ? ['+z', ...chosenSides, '-z'] : [...chosenSides, '+z'];

  // Who clears each voxel, for the setups to be built from.
  const owner = new Int8Array(grid.solid.length).fill(-1);
  const arrays = pick.chosen.map((f) => depthMm.get(f)!);
  let lo: PartBox | null = null;
  for (let a = 0; a < air.length; a++) {
    let bestD = Infinity, who = -1;
    for (let c = 0; c < arrays.length; c++) if (arrays[c][a] < bestD) { bestD = arrays[c][a]; who = c; }
    if (who >= 0) {
      owner[air[a]] = faceIndex(pick.chosen[who]);
      continue;
    }
    const i = air[a];
    const ix = i % grid.nx, iy = Math.floor(i / grid.nx) % grid.ny, iz = Math.floor(i / (grid.nx * grid.ny));
    const x = grid.minX + (ix + 0.5) * cell, y = grid.minY + (iy + 0.5) * cell, z = grid.minZ + (iz + 0.5) * cell;
    lo = lo
      ? { minX: Math.min(lo.minX, x), minY: Math.min(lo.minY, y), minZ: Math.min(lo.minZ, z), maxX: Math.max(lo.maxX, x), maxY: Math.max(lo.maxY, y), maxZ: Math.max(lo.maxZ, z) }
      : { minX: x, minY: y, minZ: z, maxX: x, maxY: y, maxZ: z };
  }

  for (const f of allowed) {
    if (pick.chosen.includes(f) || f === '+z') continue;
    const alone = score(['+z', f]);
    const gain = (topOnly.unreached - alone.unreached) * voxelMm3;
    if (gain <= 0) continue;
    dropped.push({
      face: f,
      reason: `it would clear ${Math.round(gain)} mm³ the top cannot, not enough to be worth turning the block for`,
    });
  }

  const faces: Record<string, FacePlan> = {};
  for (const f of pick.chosen) {
    const depth = pick.s.deepest.get(f)!;
    faces[f] = {
      face: f,
      clearedMm3: pick.s.cleared.get(f)! * voxelMm3,
      depthMm: depth,
      lengthOverDia: depth / input.toolDiaMm,
      standingHeightMm: standingHeight(f, input.stock),
    };
  }

  return {
    order,
    faces,
    freeing: order[order.length - 1],
    targetMm3,
    unreachedMm3: pick.s.unreached * voxelMm3,
    unreachedBounds: lo,
    topOnlyUnreachedMm3: topOnly.unreached * voxelMm3,
    unreachableAnywhereMm3: anyFace.unreached * voxelMm3,
    dropped,
    cost: pick.cost,
    alternatives: alternatives.sort((p, q) => p.cost - q.cost),
    grid,
    owner,
  };
}

/**
 * How deep, below `face`'s own stock face, the setup for it has to cut at each
 * point of a grid laid over that face, mm; 0 where it cuts nothing. Read off
 * the voxels the plan gave the face, then widened by `widenMm` so the cutter
 * has room to get down to them past the skin left on the walls beside them:
 * what it clears there is air another face would have cut, and the surface
 * job never cuts the part itself.
 */
export function neededDepth(
  plan: SetupPlan,
  face: BlockFace,
  stock: PlannerInput['stock'],
  partBox: PartBox,
  widenMm: number
): (u: number, v: number) => number {
  const g = plan.grid;
  const n = dims(g);
  const { axis, high, u, v } = VIEW[face];
  const nu = n[u], nv = n[v], nd = n[axis];
  const stride = [1, g.nx, g.nx * g.ny];
  const fi = faceIndex(face);
  const margin = margins({ partBox, stock } as PlannerInput)[face];
  const deepest = new Float32Array(nu * nv);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      for (let d = nd - 1; d >= 0; d--) {
        const i = iu * stride[u] + iv * stride[v] + (high ? nd - 1 - d : d) * stride[axis];
        if (plan.owner[i] === fi) {
          deepest[iv * nu + iu] = (d + 1) * g.cell + margin;
          break;
        }
      }
    }
  }
  const R = Math.ceil(widenMm / g.cell) + 1;
  const widened = new Float32Array(nu * nv);
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      let m = 0;
      for (let a = -R; a <= R; a++) {
        for (let c = -R; c <= R; c++) {
          if (a * a + c * c > R * R) continue;
          const iu2 = iu + a, iv2 = iv + c;
          if (iu2 < 0 || iv2 < 0 || iu2 >= nu || iv2 >= nv) continue;
          m = Math.max(m, deepest[iv2 * nu + iu2]);
        }
      }
      widened[iv * nu + iu] = m;
    }
  }
  const origin = [g.minX, g.minY, g.minZ];
  return (pu: number, pv: number) => {
    const iu = Math.floor((pu - origin[u]) / g.cell), iv = Math.floor((pv - origin[v]) / g.cell);
    if (iu < -R || iv < -R || iu >= nu + R || iv >= nv + R) return 0;
    const cu = Math.min(nu - 1, Math.max(0, iu)), cv = Math.min(nv - 1, Math.max(0, iv));
    // Past the grid's edge only as far as the widening reaches, at the edge's depth.
    return widened[cv * nu + cu];
  };
}

/** The part's first surface below `face`, as a height in that face's setup frame. */
export { castColumnSpans };

/** A plain sentence naming the faces, for the plan summary. */
export function describePlan(plan: SetupPlan): string {
  const names = plan.order.map((f) => FACE_NAME[f]);
  if (names.length === 1) return 'One setup, from the top.';
  return `${names.length} setups: ${names.join(', then ')}.`;
}
