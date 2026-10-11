// Runs a G-code program back through a block of stock and reports what each
// move took off.
//
// The exporters decide every traverse height and every entry themselves, and
// the only way to know they decided right is to cut the program: sweep a flat
// end mill along every move through a heightmap of the stock and look at what
// each one removed. A G0 that removes anything is a cutter driven through the
// work at the machine's top speed; a G1 that removes more than a stepdown is a
// dive.

export interface MoveCut {
  /** 1-based line number in the program. */
  line: number;
  text: string;
  rapid: boolean;
  /** Deepest the move cut below what was standing, mm. */
  removedMm: number;
}

/**
 * Cuts `gcode` with an end mill of `radius` out of `width` x `depth` mm of
 * stock whose top face is Z0, and returns every move that removed anything.
 * Linear moves only (G0/G1), which is all the surface exporters write.
 *
 * `finishing: 'ball'` swaps the flat end mill for a ball nose of the same
 * radius from the finishing operation on. Simulating a ball with a flat would
 * take off more than the real cutter does and hide a rapid through what it
 * left.
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

/** What the stock looks like afterwards: the height of each 0.25 mm cell. */
export interface CutResult {
  cuts: MoveCut[];
  cell: number;
  cols: number;
  rows: number;
  /** Row-major, row 0 at Y0; 0 is the stock's top face. */
  heights: Float32Array;
  /** Height at a point in work coordinates. */
  at(x: number, y: number): number;
}

/** `cutStock`, also handing back the stock it leaves. */
export function cutStockMap(
  gcode: string,
  width: number,
  depth: number,
  radius: number,
  finishing: 'flat' | 'ball' = 'flat'
): CutResult {
  const cell = 0.25;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(depth / cell);
  const h = new Float32Array(cols * rows); // 0 = stock top
  const reach = Math.ceil(radius / cell) + 1;
  const cuts: MoveCut[] = [];

  let x = 0, y = 0, z = 5, mode = 0;
  let ball = false;
  const lines = gcode.split('\n');
  for (let n = 0; n < lines.length; n++) {
    if (finishing === 'ball' && lines[n].includes('OP 2: finishing')) ball = true;
    const code = lines[n].split(';')[0].trim();
    if (!code) continue;
    let nx = x, ny = y, nz = z;
    for (const [, k, v] of code.matchAll(/([GXYZ])(-?\d*\.?\d+)/g)) {
      const val = parseFloat(v);
      if (k === 'G' && (val === 0 || val === 1)) mode = val;
      else if (k === 'X') nx = val;
      else if (k === 'Y') ny = val;
      else if (k === 'Z') nz = val;
    }
    if ((nx !== x || ny !== y || nz !== z) && Math.min(z, nz) < 0) {
      const len = Math.max(Math.hypot(nx - x, ny - y), Math.abs(nz - z));
      const steps = Math.max(1, Math.ceil(len / 0.1));
      let removed = 0;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = x + (nx - x) * t, py = y + (ny - y) * t, pz = z + (nz - z) * t;
        if (pz >= 0) continue;
        const ci = Math.floor(px / cell), cj = Math.floor(py / cell);
        for (let j = cj - reach; j <= cj + reach; j++) {
          if (j < 0 || j >= rows) continue;
          for (let i = ci - reach; i <= ci + reach; i++) {
            if (i < 0 || i >= cols) continue;
            const dx = (i + 0.5) * cell - px, dy = (j + 0.5) * cell - py;
            const dSq = dx * dx + dy * dy;
            if (dSq > radius * radius) continue;
            const level = ball ? pz + radius - Math.sqrt(radius * radius - dSq) : pz;
            const k = j * cols + i;
            if (h[k] > level) {
              removed = Math.max(removed, h[k] - level);
              h[k] = level;
            }
          }
        }
      }
      if (removed > 0) cuts.push({ line: n + 1, text: lines[n], rapid: mode === 0, removedMm: removed });
    }
    x = nx; y = ny; z = nz;
  }
  return {
    cuts, cell, cols, rows, heights: h,
    at: (px, py) => h[Math.min(rows - 1, Math.floor(py / cell)) * cols + Math.min(cols - 1, Math.floor(px / cell))],
  };
}
