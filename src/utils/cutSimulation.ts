// ---------------------------------------------------------------------------
// Cutting a program back out of a block
// ---------------------------------------------------------------------------
//
// The exporters decide every traverse height, every entry and every pass
// themselves, and the only way to know they decided right is to run the
// program: sweep each cutter along every move through a heightmap of the stock
// and look at what is left. A G0 that removes anything is a cutter driven
// through the work at the machine's top speed; a G1 that removes more than a
// stepdown is a dive; and what is left at the end is the part, as it will come
// off the machine. The tests use the first two, Add Simulation the third.
//
// Unlike `StockModel`, which overstates what is left on purpose because its job
// is keeping rapids out of the stock, this is meant to be exact at the cells it
// samples: each cell is cut to the lowest point the cutter reaches on the
// vertical line through its centre. Centre sampling matched the model on the
// giraffe relief, where a conservative grid showed fins along every edge that
// the real cutter does not leave.
//
// Each move is swept in closed form rather than by stepping the cutter along
// it. The cutter tip moves on a straight line; at a given cell the height it
// cuts to is the tip height plus the cutter's profile at the cell's distance
// from the axis, and for a flat, a ball or a V that is a convex function of the
// position along the move, so its minimum is one formula and a clamp. That
// visits each cell under a move once, where stepping would visit it once per
// step, and is never fooled by a step that jumps a cell.

/** A cutter as the simulation sees it. */
export interface SimTool {
  shape: 'flat' | 'ball' | 'v_bit';
  /** For a V-bit, the diameter at full depth. */
  diameterMm: number;
  /** Included angle of a V-bit, degrees. */
  vAngleDeg?: number;
}

export interface SimulateOptions {
  /** Stock X extent from the work origin, mm. */
  widthMm: number;
  /** Stock Y extent from the work origin, mm. */
  depthMm: number;
  /** Where the stock starts, in work coordinates. Default 0, 0. */
  originX?: number;
  originY?: number;
  /** Cutters by tool number. Switched at each `T<n> M6`. */
  tools: Record<number, SimTool>;
  /** The tool in the spindle when the program starts. Default the lowest number. */
  initialTool?: number;
  /** Wanted cell size, mm. Raised so the grid stays under `maxCells`. Default 0.1. */
  cellMm?: number;
  /** Default four million. */
  maxCells?: number;
  /** Called now and then with the fraction of the program run. */
  onProgress?: (fraction: number) => void;
}

/** One move that took material off. */
export interface MoveCut {
  /** 1-based line number in the program. */
  line: number;
  text: string;
  rapid: boolean;
  /** Deepest the move cut below what was standing, mm. */
  removedMm: number;
}

/** What the stock looks like afterwards. */
export interface CutResult {
  cuts: MoveCut[];
  cell: number;
  cols: number;
  rows: number;
  originX: number;
  originY: number;
  /** Row-major, row 0 at the stock's low Y edge; 0 is the stock's top face. */
  heights: Float64Array;
  /** Tool numbers that cut anything, in the order they did. */
  toolsUsed: number[];
  /** Height at a point in work coordinates. */
  at(x: number, y: number): number;
}

/** Cell size the simulation picks for a stock, mm. */
export function simulationCellMm(widthMm: number, depthMm: number, cellMm = 0.1, maxCells = 4e6): number {
  const area = Math.max(1e-6, widthMm * depthMm);
  return Math.max(0.01, cellMm, Math.sqrt(area / maxCells));
}

/**
 * A cell the cutter only grazes, this close to its rim, is still cut but does
 * not count towards how deep a move cut. G-code coordinates are rounded to a
 * micron, so two passes along the same line can reach a cell at the stock's
 * edge 3 µm apart, and the second then reads as a 4 mm dive into what is a
 * sliver of nothing.
 */
const GRAZE_MM = 0.01;

interface Cutter {
  r: number;
  r2: number;
  /** Squared radius inside which a cut counts towards a move's depth. */
  counted2: number;
  shape: SimTool['shape'];
  /** Rise of a V-bit's flank per mm out from the axis. */
  k: number;
}

const cutterOf = (tool: SimTool): Cutter => {
  const r = Math.max(1e-3, tool.diameterMm / 2);
  const half = ((tool.vAngleDeg ?? 90) * Math.PI) / 360;
  const counted = Math.max(0, r - GRAZE_MM);
  return { r, r2: r * r, counted2: counted * counted, shape: tool.shape, k: 1 / Math.max(1e-6, Math.tan(half)) };
};

/**
 * Runs `gcode` through the stock. Linear moves only (G0/G1, absolute), which is
 * all the surface exporters write; anything else is skipped.
 */
export function simulateMilling(gcode: string, opts: SimulateOptions): CutResult {
  const cell = simulationCellMm(opts.widthMm, opts.depthMm, opts.cellMm, opts.maxCells);
  const cols = Math.max(1, Math.ceil(opts.widthMm / cell - 1e-9));
  const rows = Math.max(1, Math.ceil(opts.depthMm / cell - 1e-9));
  const x0 = opts.originX ?? 0, y0 = opts.originY ?? 0;
  const h = new Float64Array(cols * rows); // 0 = stock top
  const cuts: MoveCut[] = [];
  const toolsUsed: number[] = [];

  const numbers = Object.keys(opts.tools).map(Number).sort((a, b) => a - b);
  let toolNo = opts.initialTool ?? numbers[0];
  const cutters = new Map<number, Cutter>();
  const cutterFor = (n: number): Cutter | null => {
    if (!cutters.has(n)) {
      const t = opts.tools[n];
      if (!t) return null;
      cutters.set(n, cutterOf(t));
    }
    return cutters.get(n)!;
  };

  /** Cuts one straight move of the tip; returns the most it took off anywhere. */
  const sweep = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: Cutter): number => {
    const zLow = Math.min(az, bz);
    if (zLow >= 0) return 0;
    const { r, r2, counted2, shape, k } = c;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell));
    const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + r - x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - y0) / cell));
    const j1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + r - y0) / cell));
    if (i0 > i1 || j0 > j1) return 0;
    const ex = bx - ax, ey = by - ay, dz = bz - az;
    const L2 = ex * ex + ey * ey;
    const L = Math.sqrt(L2);
    const plunge = L < 1e-9;
    // The V's turning point exists only when the move climbs or falls more
    // gently than the flank; steeper, the lowest point is an end of the move.
    const vRoot = shape === 'v_bit' && !plunge ? k * k * L2 - dz * dz : 0;
    const ballScale = shape === 'ball' && !plunge ? -dz / (L * Math.sqrt(L2 + dz * dz)) : 0;
    let removed = 0;

    for (let j = j0; j <= j1; j++) {
      const py = y0 + (j + 0.5) * cell - ay;
      const row = j * cols;
      for (let i = i0; i <= i1; i++) {
        const idx = row + i;
        const now = h[idx];
        // Every profile is at or above the tip, so a cell already as low as the
        // lowest the tip goes cannot be cut by this move.
        if (now <= zLow) continue;
        const px = x0 + (i + 0.5) * cell - ax;
        let level: number;
        let reach2: number;
        if (plunge) {
          const d2 = px * px + py * py;
          if (d2 > r2) continue;
          reach2 = d2;
          level = zLow + (shape === 'flat' ? 0 : shape === 'ball' ? r - Math.sqrt(r2 - d2) : k * Math.sqrt(d2));
        } else {
          // Position along the move is u + s; h2 is the cell's squared
          // distance from the line, and the cutter reaches it for |s| <= w.
          const u = (px * ex + py * ey) / L2;
          let h2 = px * px + py * py - u * u * L2;
          if (h2 < 0) h2 = 0;
          if (h2 > r2) continue;
          const w = Math.sqrt(r2 - h2) / L;
          const lo = Math.max(-u, -w), hi = Math.min(1 - u, w);
          if (lo > hi) continue;
          let s: number;
          if (shape === 'flat') s = dz > 0 ? lo : dz < 0 ? hi : Math.min(hi, Math.max(lo, 0));
          else if (shape === 'ball') s = ballScale * Math.sqrt(r2 - h2);
          else s = vRoot > 0 ? (-dz * Math.sqrt(h2)) / (L * Math.sqrt(vRoot)) : dz > 0 ? lo : hi;
          if (s < lo) s = lo;
          else if (s > hi) s = hi;
          const d2 = h2 + L2 * s * s;
          // Whether the move passed well inside the cell anywhere, not only at
          // the point it cut deepest.
          const near = u < 0 ? -u : u > 1 ? 1 - u : 0;
          reach2 = h2 + L2 * near * near;
          const tip = az + dz * (u + s);
          level = tip + (shape === 'flat' ? 0 : shape === 'ball' ? r - Math.sqrt(Math.max(0, r2 - d2)) : k * Math.sqrt(d2));
        }
        // A re-pass at the same height computes the same level to within
        // rounding, and must not read as a cut.
        if (level < now - 1e-6) {
          if (now - level > removed && reach2 <= counted2) removed = now - level;
          h[idx] = level;
        }
      }
    }
    return removed;
  };

  let x = 0, y = 0, z = 5, mode = 0;
  const lines = gcode.split('\n');
  const every = Math.max(1, Math.floor(lines.length / 100));
  for (let n = 0; n < lines.length; n++) {
    if (opts.onProgress && n % every === 0) opts.onProgress(n / lines.length);
    const code = lines[n].replace(/\(.*?\)/g, '').split(';')[0].trim().toUpperCase();
    if (!code) continue;
    if (/\bM0?6\b/.test(code)) {
      const t = /\bT(\d+)/.exec(code);
      if (t) toolNo = parseInt(t[1], 10);
    }
    let nx = x, ny = y, nz = z, motion = false;
    for (const [, key, v] of code.matchAll(/([GXYZ])\s*(-?\d*\.?\d+)/g)) {
      const val = parseFloat(v);
      if (key === 'G') {
        if (val === 0 || val === 1) { mode = val; motion = true; }
        else if (val === 2 || val === 3) mode = -1; // arcs: not simulated
      } else {
        motion = true;
        if (key === 'X') nx = val;
        else if (key === 'Y') ny = val;
        else nz = val;
      }
    }
    if (motion && mode >= 0 && (nx !== x || ny !== y || nz !== z)) {
      const cutter = cutterFor(toolNo);
      if (cutter) {
        const removed = sweep(x, y, z, nx, ny, nz, cutter);
        if (removed > 0) {
          cuts.push({ line: n + 1, text: lines[n], rapid: mode === 0, removedMm: removed });
          if (toolsUsed[toolsUsed.length - 1] !== toolNo) toolsUsed.push(toolNo);
        }
      }
    }
    x = nx; y = ny; z = nz;
  }
  opts.onProgress?.(1);

  return {
    cuts, cell, cols, rows, originX: x0, originY: y0, heights: h, toolsUsed,
    at: (px, py) => {
      const i = Math.min(cols - 1, Math.max(0, Math.floor((px - x0) / cell)));
      const j = Math.min(rows - 1, Math.max(0, Math.floor((py - y0) / cell)));
      return h[j * cols + i];
    },
  };
}

/**
 * The tests' shorthand: cut `gcode` with an end mill of `radius` out of
 * `width` x `depth` mm of stock whose top face is Z0, on a 0.25 mm grid, and
 * return every move that removed anything.
 *
 * `finishing: 'ball'` fits a ball nose of the same radius at the `T2 M6`.
 * Simulating a ball with a flat would take off more than the real cutter does
 * and hide a rapid through what it left.
 */
export function cutStock(
  gcode: string,
  width: number,
  depth: number,
  radius: number,
  finishing: 'flat' | 'ball' = 'flat'
): MoveCut[] {
  return cutStockMap(gcode, width, depth, radius, finishing).cuts;
}

/** `cutStock`, also handing back the stock it leaves. */
export function cutStockMap(
  gcode: string,
  width: number,
  depth: number,
  radius: number,
  finishing: 'flat' | 'ball' = 'flat'
): CutResult {
  return simulateMilling(gcode, {
    widthMm: width,
    depthMm: depth,
    cellMm: 0.25,
    tools: {
      1: { shape: 'flat', diameterMm: radius * 2 },
      2: { shape: finishing, diameterMm: radius * 2 },
    },
    // A finishing-only program never changes tool: the finisher is in from
    // the start.
    initialTool: /\bT2\s*M0?6\b/i.test(gcode) ? 1 : 2,
  });
}
