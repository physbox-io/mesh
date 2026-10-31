// ---------------------------------------------------------------------------
// The colours of a part, carried onto the pieces it was cut into
// ---------------------------------------------------------------------------
//
// Split for Print and the knife put a single mesh in place of a part, one
// geom per piece, and that geom has one colour. A part brushed with paint, or
// built of geoms in different colours (a birdhouse with a red roof), used to
// come back in one plain colour, and the 3MF printed it that way.
//
// Each piece's surface is coloured from the part's own coloured triangles
// (utils/printColours, the same colours the 3MF writes): every vertex of the
// piece's paint surface that lies on the part's surface takes the colour of
// the nearest corner of the part's triangle there, and becomes paint wherever
// that is not the piece's own colour. The faces the cut made, and the holes
// and pegs of the joinery, lie on no part surface and stay bare.
// ---------------------------------------------------------------------------

import type { ColouredTriangles } from './printColours';
import {
  closestPointOnTriangleBary, emptyCanvas, layerFromCanvas, paintMeshResolution, subdivideMeshForPaint, type PaintLayer,
} from './vertexPaint';

/** A part's surface, coloured: triangles in the pieces' frame and the geom's own colour. */
export interface ColourSource extends ColouredTriangles {
  /** sRGB 0..1, the geom's colour, for corners `colors` does not give. */
  rgba: number[];
}

/** A point this close to the part's surface is on it, m: well above float32 rounding, well below a feature. */
const ON_SURFACE_M = 5e-5;

const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Whether colouring a piece from these sources could give it anything but its own colour. */
export function needsColourCarry(sources: ColourSource[], rgba: number[]): boolean {
  const byte = (v: number) => Math.round(v * 255);
  return sources.some((s) => s.colors || [0, 1, 2].some((k) => byte(s.rgba[k] ?? 0.8) !== byte(rgba[k] ?? 0.8)));
}

/**
 * The paint for a piece whose mesh is `positions`/`faces` (its renderVertices,
 * the space a dynamic mesh is painted in) and whose colour is `rgba`. `shift`
 * is added to the piece's points to put them in the sources' frame, for a
 * piece whose origin was moved. Undefined when nothing on it differs from
 * its own colour.
 */
export function sectionPaint(
  sources: ColourSource[], positions: ArrayLike<number>, faces: ArrayLike<number>, rgba: number[], shift: number[] = [0, 0, 0],
): PaintLayer | undefined {
  if (!sources.length || positions.length < 9) return undefined;
  const res = paintMeshResolution(positions);
  const surface = subdivideMeshForPaint(positions, faces, res);
  const pts = surface.positions;
  const count = pts.length / 3;

  // The piece's box, which bounds the triangles worth indexing.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i] + shift[i % 3];
    if (v < lo[i % 3]) lo[i % 3] = v;
    if (v > hi[i % 3]) hi[i % 3] = v;
  }
  for (let k = 0; k < 3; k++) { lo[k] -= ON_SURFACE_M; hi[k] += ON_SURFACE_M; }
  const cell = Math.max(1e-4, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 96);
  const at = (v: number, k: number) => Math.floor((v - lo[k]) / cell);

  // Each triangle that comes near the piece, in every cell its box touches.
  interface Tri { s: number; i: number }
  const grid = new Map<string, Tri[]>();
  sources.forEach((src, s) => {
    const t = src.tris;
    for (let i = 0; i + 8 < t.length; i += 9) {
      const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 9; c++) {
        const k = c % 3;
        a[k] = Math.min(a[k], t[i + c] - ON_SURFACE_M);
        b[k] = Math.max(b[k], t[i + c] + ON_SURFACE_M);
      }
      if ([0, 1, 2].some((k) => b[k] < lo[k] || a[k] > hi[k])) continue;
      const g0 = [0, 1, 2].map((k) => Math.max(0, at(a[k], k)));
      const g1 = [0, 1, 2].map((k) => Math.min(at(hi[k], k), at(b[k], k)));
      for (let x = g0[0]; x <= g1[0]; x++) for (let y = g0[1]; y <= g1[1]; y++) for (let z = g0[2]; z <= g1[2]; z++) {
        const key = `${x},${y},${z}`;
        const list = grid.get(key);
        if (list) list.push({ s, i }); else grid.set(key, [{ s, i }]);
      }
    }
  });

  const own = [0, 1, 2].map((k) => Math.round((rgba[k] ?? 0.8) * 255));
  const canvas = emptyCanvas(count, res);
  let any = false;
  for (let v = 0; v < count; v++) {
    const px = pts[v * 3] + shift[0], py = pts[v * 3 + 1] + shift[1], pz = pts[v * 3 + 2] + shift[2];
    let best: { d2: number; s: number; corner: number } | null = null;
    for (const { s, i } of grid.get(`${at(px, 0)},${at(py, 1)},${at(pz, 2)}`) ?? []) {
      const t = sources[s].tris;
      const r = closestPointOnTriangleBary(px, py, pz, t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5], t[i + 6], t[i + 7], t[i + 8]);
      if (r.d2 > ON_SURFACE_M * ON_SURFACE_M || (best && r.d2 >= best.d2)) continue;
      // A printer lays one filament or another, so the corner nearest wins.
      const corner = r.wa >= r.wb && r.wa >= r.wc ? 0 : r.wb >= r.wc ? 1 : 2;
      best = { d2: r.d2, s, corner: i + corner * 3 };
    }
    if (!best) continue;
    const src = sources[best.s];
    // Corner colours are linear, as the 3MF writer wants them; paint is sRGB.
    const rgb = src.colors
      ? [0, 1, 2].map((k) => toSrgb(src.colors![best!.corner + k]))
      : [0, 1, 2].map((k) => src.rgba[k] ?? 0.8);
    if (rgb.every((c, k) => Math.abs(Math.round(c * 255) - own[k]) <= 1)) continue;
    canvas.data.set([rgb[0], rgb[1], rgb[2], 1], v * 4);
    any = true;
  }
  return any ? layerFromCanvas(canvas) : undefined;
}
