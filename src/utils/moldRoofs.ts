// ---------------------------------------------------------------------------
// Roofs over the casting, as a slicer sees a mold half printed face up
// ---------------------------------------------------------------------------
//
// A mold half prints parting face up, so its cavity opens upward and needs no
// support. Mold that hangs over cast space is different. A slicer supports it,
// and support printed in the cavity fills what the casting needed: a real HIPS
// insert came off the printer with its face closed over the casting, apart
// from thin outlines, because "support everywhere" had filled in under it.
//
// This walks the printed body a layer at a time. Each layer is held up by the
// one below grown by a layer height (a 45° overhang), and whatever is not held
// up and lies over cast space is a roof. A roof printed without support has to
// be reached from where its layer is held up, a short way out. Anything further
// out is a roof a slicer will support.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, SimplePolygon } from 'manifold-3d';

/** Layer height the check slices at, mm. */
export const ROOF_LAYER_MM = 0.2;
/**
 * How far an unsupported layer can reach out from held-up material and still
 * print with nothing under it, mm. Kept short: Bambu Studio supported the
 * window pads of a gear insert that were bridges of under 6 mm, and support
 * in the cavity is the failure this guards against.
 */
export const ROOF_REACH_MM = 1;

/** Narrower than this, a roof is a sliver no slicer prints, mm. */
const SLIVER_MM = 0.3;

/** Signed area of a 2D polygon contour: positive for outer rims, negative for holes. */
function signedArea(poly: ArrayLike<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInPolys(polys: [number, number][][], x: number, y: number): boolean {
  let crossings = 0;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) crossings++;
    }
  }
  return (crossings & 1) === 1;
}

const BRIDGE_DIRS: ReadonlyArray<[number, number]> = Array.from({ length: 12 }, (_, k) => {
  const a = (k * Math.PI) / 12;
  return [Math.cos(a), Math.sin(a)];
});

/**
 * Whether `piece` can be bridged straight across with supports off:
 *  1. Every interior hole of `piece` must be filled by `held` (an open hole in
 *     mid-air forces the slicer to extrude a floating inner perimeter loop over
 *     empty cavity, which pulls radially inward onto the nozzle).
 *  2. Every part of `piece` must lie on a straight chord of span <= 2 * bridgeMm
 *     that stays inside `piece ∪ held` and anchors in `held` at both ends. A
 *     one-sided cantilever or inward flange around an open cavity fails this.
 */
function isPieceBridged(piece: CrossSection, held: CrossSection, bridgeMm: number): boolean {
  const polys = piece.toPolygons() as [number, number][][];
  const holes = polys.filter((p) => signedArea(p) < -1e-4);
  const pad = Math.max(ROOF_LAYER_MM * 2, 0.4);
  const rim = piece.offset(pad, 'Round');
  const anchors = rim.intersect(held);
  rim.delete();
  if (anchors.area() < 0.02) {
    anchors.delete();
    return false;
  }

  // If `piece` wraps around any hole that is not filled by `held`, its inner
  // perimeter hangs in mid-air over the cavity and cannot be bridged.
  if (holes.length > 0) {
    const heldGrown = held.offset(ROOF_LAYER_MM * 1.5, 'Round');
    const heldPolys = heldGrown.toPolygons() as [number, number][][];
    heldGrown.delete();
    for (const hole of holes) {
      // Test an interior point just inside the hole (or its centroid / sample).
      let cx = 0, cy = 0;
      for (const [x, y] of hole) { cx += x; cy += y; }
      cx /= hole.length;
      cy /= hole.length;
      // Check hole vertices nudged slightly into the hole, plus centroid.
      let unheldHole = !pointInPolys(heldPolys, cx, cy) && !pointInPolys(polys, cx, cy);
      if (!unheldHole) {
        for (let i = 0; i < hole.length; i++) {
          const p0 = hole[i];
          const p1 = hole[(i + 1) % hole.length];
          const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
          const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          // Hole is clockwise (negative area), so right-hand normal (+dy, -dx) points into the hole.
          const ix = mx + (dy / len) * 0.15;
          const iy = my - (dx / len) * 0.15;
          if (!pointInPolys(polys, ix, iy) && !pointInPolys(heldPolys, ix, iy)) {
            unheldHole = true;
            break;
          }
        }
      }
      if (unheldHole) {
        anchors.delete();
        return false;
      }
    }
  }

  const anchorPolys = anchors.toPolygons() as [number, number][][];
  const bPiece = piece.bounds();
  const bAnchor = anchors.bounds();
  anchors.delete();
  const x0 = Math.min(bPiece.min[0], bAnchor.min[0]) - 0.2;
  const y0 = Math.min(bPiece.min[1], bAnchor.min[1]) - 0.2;
  const x1 = Math.max(bPiece.max[0], bAnchor.max[0]) + 0.2;
  const y1 = Math.max(bPiece.max[1], bAnchor.max[1]) + 0.2;
  const step = Math.max(0.4, Math.max(x1 - x0, y1 - y0) / 120);
  const cols = Math.max(1, Math.ceil((x1 - x0) / step));
  const rows = Math.max(1, Math.ceil((y1 - y0) / step));
  // 0 = empty/unheld, 1 = roof piece, 2 = held anchor
  const grid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = y0 + (r + 0.5) * step;
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * step;
      if (pointInPolys(anchorPolys, x, y)) grid[r * cols + c] = 2;
      else if (pointInPolys(polys, x, y)) grid[r * cols + c] = 1;
    }
  }

  const maxSpan = 2 * bridgeMm + step;
  const maxSteps = Math.ceil(maxSpan / step) + 1;
  let unbridgedCells = 0;
  const maxUnbridgedCells = Math.ceil(0.25 / (step * step));

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r * cols + c] !== 1) continue;
      let cellBridged = false;
      for (const [ux, uy] of BRIDGE_DIRS) {
        let dPos = -1;
        for (let s = 1; s <= maxSteps; s++) {
          const cc = Math.floor(c + 0.5 + ux * s);
          const rr = Math.floor(r + 0.5 + uy * s);
          const v = cc < 0 || rr < 0 || cc >= cols || rr >= rows ? 0 : grid[rr * cols + cc];
          if (v === 0) break;
          if (v === 2) { dPos = (s - 0.5) * step; break; }
        }
        if (dPos < 0) continue;
        let dNeg = -1;
        for (let s = 1; s <= maxSteps; s++) {
          const cc = Math.floor(c + 0.5 - ux * s);
          const rr = Math.floor(r + 0.5 - uy * s);
          const v = cc < 0 || rr < 0 || cc >= cols || rr >= rows ? 0 : grid[rr * cols + cc];
          if (v === 0) break;
          if (v === 2) { dNeg = (s - 0.5) * step; break; }
        }
        if (dNeg >= 0 && dPos + dNeg <= maxSpan) {
          cellBridged = true;
          break;
        }
      }
      if (!cellBridged && ++unbridgedCells > maxUnbridgedCells) return false;
    }
  }
  return true;
}

/**
 * `beyond` less every roof the printer bridges with supports off: a piece of
 * the roof spanned straight across between two held anchors within 2 * bridgeMm
 * and free of unsupported mid-air holes. A cantilever or annular flange around
 * an open hole droops or pulls inward onto the nozzle, so it stays.
 */
function withoutBridges(beyond: CrossSection, roof: CrossSection, held: CrossSection, bridgeMm: number): CrossSection {
  const pieces = roof.decompose();
  let out = beyond;
  for (const piece of pieces) {
    const far = held.offset(bridgeMm, 'Round');
    const outOfReach = piece.subtract(far);
    far.delete();
    const inReach = outOfReach.area() < 1e-3;
    outOfReach.delete();
    if (inReach && isPieceBridged(piece, held, bridgeMm)) {
      const next = out.subtract(piece);
      if (out !== beyond) out.delete();
      out = next;
    }
    piece.delete();
  }
  return out;
}

export interface CavityRoof {
  /** Where the roof's underside is, below the parting face (z = 0 in the half's frame), mm. */
  depthMm: number;
  /** How much of it prints only with support under it, mm². */
  areaMm2: number;
  /** Middle of that region in the half's frame, mm. */
  at: [number, number];
  /** XY bounds [minX, minY, maxX, maxY] of that region in the half's frame, mm. */
  bounds?: [number, number, number, number];
  /** Exact 2D contours of the unprintable roof region in the half's frame, mm. */
  polys?: SimplePolygon[];
}

/**
 * The roofs over `cast` in `body` that print only with support under them,
 * one per layer they start in, worst first. Both solids are in the half's own
 * frame, parting face at z = 0, and the body prints the way up it lies.
 */
export function unprintableRoofs(
  body: Manifold,
  cast: Manifold,
  layerMm = ROOF_LAYER_MM,
  reachMm = ROOF_REACH_MM,
  bridgeMm = 0,
): CavityRoof[] {
  const box = body.boundingBox();
  const found: CavityRoof[] = [];
  let below: CrossSection | null = null;
  for (let z = box.min[2] + layerMm / 2; z < box.max[2]; z += layerMm) {
    const layer = body.slice(z);
    if (below) {
      const grown = below.offset(layerMm, 'Round');
      const held = layer.intersect(grown);
      const loose = layer.subtract(held);
      if (loose.area() > 1e-3) {
        const castBelow = cast.slice(z - layerMm);
        const roof = loose.intersect(castBelow);
        if (roof.area() > 1e-3) {
          const reach = held.offset(reachMm, 'Round');
          const beyond = roof.subtract(reach);
          const raw = bridgeMm > 0 ? withoutBridges(beyond, roof, held, bridgeMm) : beyond;
          if (raw !== beyond) beyond.delete();
          // Slivers thinner than a nozzle's line print as nothing.
          const thin = raw.offset(-SLIVER_MM / 2, 'Round');
          const bad = thin.offset(SLIVER_MM / 2, 'Round');
          raw.delete();
          thin.delete();
          const a = bad.area();
          if (a > 0.25) {
            const b = bad.bounds();
            found.push({
              depthMm: Math.round(-(z - layerMm / 2) * 100) / 100,
              areaMm2: Math.round(a * 10) / 10,
              at: [Math.round(((b.min[0] + b.max[0]) / 2) * 10) / 10, Math.round(((b.min[1] + b.max[1]) / 2) * 10) / 10],
              bounds: [b.min[0], b.min[1], b.max[0], b.max[1]],
              polys: bad.toPolygons(),
            });
          }
          bad.delete();
          reach.delete();
        }
        roof.delete();
        castBelow.delete();
      }
      grown.delete();
      held.delete();
      loose.delete();
      below.delete();
    }
    below = layer;
  }
  below?.delete();
  return found.sort((p, q) => q.areaMm2 - p.areaMm2);
}
