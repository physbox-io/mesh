/**
 * What is still standing on the stock, as the program that cuts it is written.
 *
 * The surface exporter used to decide how high a traverse had to fly from a
 * model of where the material *would* be — the finished surface plus the
 * roughing allowance. That is not where it is. Roughing clears in layers, so a
 * cell whose surface lies between two layer planes is left at the plane above
 * it, and ground shallower than the first layer is not touched by roughing at
 * all: it stands at the stock's face until the finishing pass reaches it. A
 * traverse measured against the model then flew through up to a whole layer of
 * stock at rapid: on the part this was found on, a 3 mm cutter was sent
 * sideways through 1.7 mm of it at the machine's top speed.
 *
 * So the exporter keeps this instead: a grid that starts at the stock's top
 * face and is lowered by every cutting move as it is emitted. It is
 * deliberately pessimistic, because what it is for is keeping rapids out of
 * the stock. A cell is lowered only when the cutter covers all of it — every
 * corner, clipped to the stock, within the radius — to the highest
 * level the cutter leaves anywhere across it. A query counts every cell the
 * footprint could touch — centre within the radius plus half the diagonal. So
 * the model can overstate what is left but never understate it.
 *
 * Sampling cells at their centres was tried, and is not safe: a cell whose
 * centre a pass covers can still hold a wedge the pass missed, and the inside
 * corner of a roughing ring is exactly that. A traverse measured against it
 * went through 5.75 mm of aluminium on the wall bracket.
 */

/** How high a cutter cuts at a distance from its axis, above its tip, in mm. */
export type CutterProfile = (distanceFromAxisMm: number) => number;

export const FLAT_PROFILE: CutterProfile = () => 0;

export function ballProfile(radiusMm: number): CutterProfile {
  return (d) => radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d));
}

/** A cone whose flank rises `1 / tanHalfAngle` mm per mm out from the tip. */
export function vProfile(tanHalfAngle: number): CutterProfile {
  const rise = 1 / Math.max(1e-6, tanHalfAngle);
  return (d) => d * rise;
}

export interface StockBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class StockModel {
  readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly x1: number;
  private readonly y1: number;
  /** Highest material in each cell. Stock top is 0. */
  private readonly z: Float32Array;

  /**
   * `cellMm` sets the price of the pessimism: a cell only counts as cut once
   * the cutter covers all of it, so a coarse grid leaves a rim of "uncut" cells
   * round every pass and flies traverses higher than they need to be. It never
   * makes them lower. Capped so the grid never passes four million cells.
   */
  constructor(bounds: StockBounds, cellMm: number) {
    const area = Math.max(1e-6, (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY));
    this.cell = Math.max(0.05, cellMm, Math.sqrt(area / 4e6));
    this.x0 = bounds.minX;
    this.y0 = bounds.minY;
    this.x1 = bounds.maxX;
    this.y1 = bounds.maxY;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / this.cell));
    this.rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / this.cell));
    this.z = new Float32Array(this.cols * this.rows); // all 0: the stock's face
  }

  /**
   * Visits every cell whose centre is within `reach` of the segment from
   * (ax, ay) to (bx, by), with that distance.
   */
  private near(
    ax: number, ay: number, bx: number, by: number, reach: number,
    visit: (k: number, distance: number) => void
  ): void {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - this.x0) / c));
    const i1 = Math.min(this.cols - 1, Math.floor((Math.max(ax, bx) + reach - this.x0) / c));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - reach - this.y0) / c));
    const j1 = Math.min(this.rows - 1, Math.floor((Math.max(ay, by) + reach - this.y0) / c));
    const ex = bx - ax, ey = by - ay;
    const lenSq = ex * ex + ey * ey;
    const reachSq = reach * reach;
    for (let j = j0; j <= j1; j++) {
      const py = this.y0 + (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const px = this.x0 + (i + 0.5) * c;
        let t = lenSq > 1e-12 ? ((px - ax) * ex + (py - ay) * ey) / lenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = ax + ex * t - px, dy = ay + ey * t - py;
        const dSq = dx * dx + dy * dy;
        if (dSq <= reachSq) visit(j * this.cols + i, Math.sqrt(dSq));
      }
    }
  }

  /** Farthest in-stock corner of cell `k` from the segment (ax, ay)-(bx, by). */
  private farthestCorner(k: number, ax: number, ay: number, bx: number, by: number): number {
    const i = k % this.cols, j = (k - i) / this.cols;
    const xa = this.x0 + i * this.cell, ya = this.y0 + j * this.cell;
    const xb = Math.min(this.x1, xa + this.cell), yb = Math.min(this.y1, ya + this.cell);
    const ex = bx - ax, ey = by - ay;
    const lenSq = ex * ex + ey * ey;
    const dist = (px: number, py: number) => {
      let t = lenSq > 1e-12 ? ((px - ax) * ex + (py - ay) * ey) / lenSq : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(ax + ex * t - px, ay + ey * t - py);
    };
    return Math.max(dist(xa, ya), dist(xb, ya), dist(xa, yb), dist(xb, yb));
  }

  /** A cutting move from one tip position to another. */
  cut(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    radius: number,
    profile: CutterProfile = FLAT_PROFILE
  ): void {
    if (Math.min(z0, z1) >= 0) return; // above the stock's face
    // Whole cells only, each at the highest the cutter leaves across it.
    const half = this.cell * Math.SQRT1_2;
    // In pieces no longer than a cell, each taken at its own higher end, so a
    // sloping move lowers the stock by no more than it really cuts.
    const len = Math.hypot(x1 - x0, y1 - y0);
    const pieces = Math.max(1, Math.ceil(len / this.cell));
    for (let s = 0; s < pieces; s++) {
      const ta = s / pieces, tb = (s + 1) / pieces;
      const za = z0 + (z1 - z0) * ta, zb = z0 + (z1 - z0) * tb;
      const z = Math.max(za, zb);
      const ax = x0 + (x1 - x0) * ta, ay = y0 + (y1 - y0) * ta;
      const bx = x0 + (x1 - x0) * tb, by = y0 + (y1 - y0) * tb;
      this.near(ax, ay, bx, by, radius, (k, d) => {
        // Well inside the cutter, the centre's distance and half a diagonal
        // settle it. In the band near its edge, the corners are measured —
        // clipped to the stock, since a cell hanging off the edge has nothing
        // there to cut — or a pass running one radius in from the stock's
        // edge would never count the edge as cut.
        let far = d + half;
        if (far > radius) {
          far = this.farthestCorner(k, ax, ay, bx, by);
          // A micron of slack: the outermost pass runs exactly one radius in
          // from the stock's edge, and rounding put the edge a hair outside.
          if (far > radius + 1e-3) return;
          far = Math.min(far, radius);
        }
        const level = z + profile(far);
        if (level < this.z[k]) this.z[k] = level;
      });
    }
  }

  /** Highest material a cutter of `radius` centred at (x, y) would touch. */
  highestUnder(x: number, y: number, radius: number): number {
    return this.highestAlong(x, y, x, y, radius);
  }

  /** Highest material a cutter of `radius` would touch flying from one point to another. */
  highestAlong(x0: number, y0: number, x1: number, y1: number, radius: number): number {
    let best = -Infinity;
    this.near(x0, y0, x1, y1, radius + this.cell * Math.SQRT1_2, (k) => {
      if (this.z[k] > best) best = this.z[k];
    });
    return best;
  }
}
