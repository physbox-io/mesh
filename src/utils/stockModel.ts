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
 * footprint reaches any part of, at its full height. So the model can
 * overstate what is left but never understate it.
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
    // sloping move lowers the stock by no more than it really cuts. A flat move
    // (z0 === z1) has the same height along its whole length and needs only one.
    const len = Math.hypot(x1 - x0, y1 - y0);
    const pieces = z0 === z1 ? 1 : Math.max(1, Math.ceil(len / this.cell));
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

  /**
   * The deepest a cutting move would bite into what is standing: the most
   * material over the cutter's profile anywhere along it, in mm, 0 if it would
   * cut nothing. Measured the generous way round — each cell against the lower
   * end of its piece and the cutter's nearest point — so it never reads short.
   *
   * `within` limits it to material that close to the axis. Over the whole
   * cutter, a pass running down a wall with half a millimetre left on it reads
   * as the wall's height; near the axis it reads as what the centre of the
   * tool, which cuts worst, would be driven into.
   */
  deepestCut(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    radius: number,
    profile: CutterProfile = FLAT_PROFILE,
    within: number = radius
  ): number {
    let worst = 0;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const pieces = z0 === z1 ? 1 : Math.max(1, Math.ceil(len / this.cell));
    for (let s = 0; s < pieces; s++) {
      const ta = s / pieces, tb = (s + 1) / pieces;
      const z = Math.min(z0 + (z1 - z0) * ta, z0 + (z1 - z0) * tb);
      this.near(
        x0 + (x1 - x0) * ta, y0 + (y1 - y0) * ta,
        x0 + (x1 - x0) * tb, y0 + (y1 - y0) * tb,
        Math.min(radius, within),
        (k, d) => {
          const bite = this.z[k] - (z + profile(d));
          if (bite > worst) worst = bite;
        }
      );
    }
    return worst;
  }

  /**
   * The lowest a cutter's tip can sit with its axis at (x, y) and touch
   * nothing: the highest material within `radius`, less what the cutter's
   * profile lifts its edge clear of it there.
   *
   * Each cell is measured at its nearest point to the axis, so a cell the
   * footprint does not reach is not counted. It used to be every cell whose
   * centre lay within the radius plus half a diagonal, which took in a ring of
   * cells wholly outside the cutter - and since a cell is only lowered once a
   * pass covers all of it, the ring round every cut stood at whatever was there
   * before. At the head of a second bite on an adaptive ring that read as the
   * stock's top face, and the tool lifted out of its own slot and ramped back
   * down through air.
   */
  highestUnder(x: number, y: number, radius: number, profile: CutterProfile = FLAT_PROFILE): number {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - radius - this.x0) / c));
    const i1 = Math.min(this.cols - 1, Math.floor((x + radius - this.x0) / c));
    const j0 = Math.max(0, Math.floor((y - radius - this.y0) / c));
    const j1 = Math.min(this.rows - 1, Math.floor((y + radius - this.y0) / c));
    const flat = profile === FLAT_PROFILE;
    const reachSq = radius * radius;
    let best = -Infinity;
    for (let j = j0; j <= j1; j++) {
      const ya = this.y0 + j * c;
      const dy = y < ya ? ya - y : y > ya + c ? y - ya - c : 0;
      const row = j * this.cols;
      for (let i = i0; i <= i1; i++) {
        const xa = this.x0 + i * c;
        const dx = x < xa ? xa - x : x > xa + c ? x - xa - c : 0;
        const dSq = dx * dx + dy * dy;
        if (dSq > reachSq) continue;
        // Called for every half cell along every roughing ring: no square
        // root unless the profile needs the distance.
        const level = flat ? this.z[row + i] : this.z[row + i] - profile(Math.sqrt(dSq));
        if (level > best) best = level;
      }
    }
    return best;
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
