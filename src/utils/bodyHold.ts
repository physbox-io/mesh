// How high the finishing tool's body - shank, holder - holds its tip over what
// is standing when it gets there, rather than over the finished surface alone.

import { WALL_SLOPE } from './finishingPaths';
import type { Heightmap, ToolBodySection } from './reliefHeightmap';
import type { StockModel } from './stockModel';

/**
 * The finished surface at a point, a wall standing half way across the cell
 * it was sampled across (the 'middle' rule `dilateForTool` reads it by).
 */
function finishedAt(hm: Heightmap, x: number, y: number): number {
  const fx = Math.min(hm.cols - 1, Math.max(0, (x - hm.minX) / (hm.stepX || 1)));
  const fy = Math.min(hm.rows - 1, Math.max(0, (y - hm.minY) / (hm.stepY || 1)));
  const c0 = Math.min(hm.cols - 2, Math.floor(fx)), r0 = Math.min(hm.rows - 2, Math.floor(fy));
  if (c0 < 0 || r0 < 0) return hm.z[Math.round(fy) * hm.cols + Math.round(fx)];
  const tx = fx - c0, ty = fy - r0, k = r0 * hm.cols + c0;
  const z00 = hm.z[k], z10 = hm.z[k + 1], z01 = hm.z[k + hm.cols], z11 = hm.z[k + hm.cols + 1];
  const here = (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
  const wall = WALL_SLOPE * Math.min(hm.stepX || Infinity, hm.stepY || Infinity);
  if (
    Math.abs(z10 - z00) <= wall && Math.abs(z11 - z01) <= wall &&
    Math.abs(z01 - z00) <= wall && Math.abs(z11 - z10) <= wall
  ) return here;
  const high = Math.max(z00, z10, z01, z11), low = Math.min(z00, z10, z01, z11);
  return here >= (low + high) / 2 ? high : low;
}

/**
 * The lowest the tip may go at a point for every body section to clear what
 * the stock model holds there now; null when the tool has no body to clear.
 *
 * `dilateForTool` clears the body over the finished surface, which is all
 * that stands once the job is done but not while it runs: where roughing
 * could not get in, a valley narrower than its bit, the stock stands the
 * full depth beside the finisher's shank. Asked as each pass is cut, after
 * every pass before it, so stock the finishing pass has itself taken off is
 * not in the way.
 *
 * The model keeps a cell at its old height until a pass has covered all of
 * it, so the cells along the rim of every pass, the tool's own earlier ones
 * at the same spot included, stand up to a cell's diagonal in from where the
 * cut reached, and a cell a wall runs through stands at the wall's top. Each
 * section is measured two cells narrower, and material in a cell some of which is finished
 * ground as high as itself is taken to be that ground, which `dilateForTool`
 * has seen.
 */
export function bodyHold(
  stock: StockModel,
  surface: Heightmap,
  body: ToolBodySection[]
): ((x: number, y: number, tipZ: number) => number) | null {
  if (body.length === 0) return null;
  const c = stock.cell;
  const sections = body.map((s) => ({ above: s.aboveTipMm, reach: Math.max(0, s.radiusMm - 2 * c) }));
  const lowestAbove = Math.min(...sections.map((s) => s.above));
  const isGround = (x0: number, y0: number, x1: number, y1: number, z: number) => {
    const n = 4;
    for (let b = 0; b <= n; b++) {
      for (let a = 0; a <= n; a++) {
        const px = x0 + ((x1 - x0) * a) / n, py = y0 + ((y1 - y0) * b) / n;
        if (finishedAt(surface, px, py) >= z - 1e-3) return true;
      }
    }
    return false;
  };
  return (x, y, tipZ) => {
    // Nothing stands above the stock's face.
    if (tipZ + lowestAbove >= 0) return tipZ;
    let need = tipZ;
    for (const s of sections) {
      stock.forEachNear(x, y, s.reach, need + s.above, (x0, y0, x1, y1, z) => {
        if (z - s.above > need && !isGround(x0, y0, x1, y1, z)) { need = z - s.above; }
      });
    }
    return need;
  };
}
