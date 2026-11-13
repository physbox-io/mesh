// ---------------------------------------------------------------------------
// Gaps in a casting narrower than the printer can line.
//
// Whatever surrounds a casting in its mold (liner, shell, an insert) is as thin
// as the gap between two parts of it. A gear sculpture's stacked gears stood
// 0.03-0.4 mm apart, and the liner between them came out a sub-layer film that
// lifted off the bed and wrapped the nozzle. Found two ways, both exact for the
// prismatic shapes these castings are made of:
//
//  - skins: an upward flat face of the part with a downward one over it,
//    closer than the printer's thinnest skin (one FDM layer);
//  - walls: between flat-face heights the part is prismatic, so a closing of
//    its slice in that band by half the thinnest wall finds every gap narrower
//    than one nozzle line.
//
// Each can be left (and named in a warning), closed (filled with casting: the
// casting gains a web there) or opened (the part trimmed back until the gap is
// printable).
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
import type { PrintLimits } from './printLimits';

export type ThinGapMode = 'leave' | 'close' | 'fix';

export interface ThinGapReport {
  /** Gaps between stacked flat faces thinner than the thinnest skin. */
  skin: { areaMm2: number; thinnestMm: number; atMm: [number, number, number] | null };
  /** Gaps side by side narrower than the thinnest wall. */
  wall: { areaMm2: number; thinnestMm: number; atMm: [number, number, number] | null };
  /** Casting added (close) or taken away (fix), mm³. */
  changedMm3: number;
}

/** Below this a gap is a crumb of numerical noise, not a feature, mm². */
const MIN_GAP_AREA_MM2 = 0.05;
/** Heights closer than this are one flat face, mm. */
const FLAT_SNAP_MM = 1e-3;

export interface Flats {
  up: Map<number, SimplePolygon[]>;
  down: Map<number, SimplePolygon[]>;
}

/** The part's horizontal faces, as polygons by height, upward and downward apart. */
export function flatFaces(part: Manifold): Flats {
  const mesh = part.getMesh();
  const p = mesh.vertProperties;
  const st = mesh.numProp;
  const t = mesh.triVerts;
  const up = new Map<number, SimplePolygon[]>();
  const down = new Map<number, SimplePolygon[]>();
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * st, t[k + 1] * st, t[k + 2] * st];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
    if (len < 1e-12 || Math.abs(nz / len) < 0.999) continue;
    const z = Math.round((p[a + 2] + p[b + 2] + p[c + 2]) / 3 / FLAT_SNAP_MM) * FLAT_SNAP_MM;
    const tri: SimplePolygon = nz > 0
      ? [[p[a], p[a + 1]], [p[b], p[b + 1]], [p[c], p[c + 1]]]
      : [[p[a], p[a + 1]], [p[c], p[c + 1]], [p[b], p[b + 1]]];
    const m = nz > 0 ? up : down;
    const list = m.get(z);
    if (list) list.push(tri);
    else m.set(z, [tri]);
  }
  return { up, down };
}

/** The point of a cross-section's biggest piece nearest its centre, for saying where a gap is. */
function where(cs: CrossSection, z: number): [number, number, number] {
  const b = cs.bounds();
  return [Math.round(((b.min[0] + b.max[0]) / 2) * 10) / 10, Math.round(((b.min[1] + b.max[1]) / 2) * 10) / 10, Math.round(z * 10) / 10];
}

/**
 * Finds the thin gaps in `part` and, for 'close' or 'fix', returns the part
 * with them filled or opened. `part` stays the caller's; the returned part is
 * new unless the mode is 'leave' or nothing was found.
 */
export function treatThinGaps(wasm: ManifoldToplevel, part: Manifold, limits: PrintLimits, mode: ThinGapMode): { part: Manifold; report: ThinGapReport } {
  const report: ThinGapReport = {
    skin: { areaMm2: 0, thinnestMm: Infinity, atMm: null },
    wall: { areaMm2: 0, thinnestMm: Infinity, atMm: null },
    changedMm3: 0,
  };
  const fills: Manifold[] = [];
  const cuts: Manifold[] = [];
  const { up, down } = flatFaces(part);

  // Skins: an upward face with a downward one just over it.
  let worstSkinArea = 0;
  for (const [h1, upPolys] of up) {
    for (const [h2, downPolys] of down) {
      const gap = h2 - h1;
      if (!(gap > FLAT_SNAP_MM && gap < limits.minSkinMm - 1e-6)) continue;
      const lo = new wasm.CrossSection(upPolys, 'Positive');
      const hi = new wasm.CrossSection(downPolys, 'Positive');
      const both = lo.intersect(hi);
      lo.delete();
      hi.delete();
      if (both.area() < MIN_GAP_AREA_MM2) {
        both.delete();
        continue;
      }
      // Only where nothing of the part lies between the two faces.
      const prism = wasm.Manifold.extrude(both, gap).translate([0, 0, h1]);
      const space = prism.subtract(part);
      prism.delete();
      const area = space.volume() / gap;
      if (area >= MIN_GAP_AREA_MM2) {
        report.skin.areaMm2 += area;
        report.skin.thinnestMm = Math.min(report.skin.thinnestMm, gap);
        if (area > worstSkinArea) {
          worstSkinArea = area;
          report.skin.atMm = where(both, (h1 + h2) / 2);
        }
        if (mode === 'close') fills.push(space);
        else {
          space.delete();
          if (mode === 'fix') {
            // Half the shortfall off each face.
            const half = (limits.minSkinMm - gap) / 2;
            cuts.push(wasm.Manifold.extrude(both, gap + 2 * half).translate([0, 0, h1 - half]));
          }
        }
      } else {
        space.delete();
      }
      both.delete();
    }
  }

  // Walls: the part's slice in each band between flat heights, closed by half a wall.
  const r = limits.minWallMm / 2;
  const box = part.boundingBox();
  const heights = [...new Set([box.min[2], box.max[2], ...up.keys(), ...down.keys()])].sort((a, b) => a - b);
  let worstWallArea = 0;
  for (let i = 0; i + 1 < heights.length; i++) {
    const a = heights[i], b = heights[i + 1];
    if (b - a < FLAT_SNAP_MM) continue;
    const slice = part.slice((a + b) / 2);
    const grown = slice.offset(r, 'Round');
    const closed = grown.offset(-r, 'Round');
    grown.delete();
    const gaps = closed.subtract(slice);
    closed.delete();
    // A closing also rounds every inside corner a hair; a gap is a piece much
    // bigger than that fillet.
    const pieces = gaps.decompose().filter((g) => {
      const keep = g.area() >= Math.max(MIN_GAP_AREA_MM2, 2 * limits.minWallMm * limits.minWallMm);
      if (!keep) g.delete();
      return keep;
    });
    gaps.delete();
    for (const g of pieces) {
      const area = g.area();
      report.wall.areaMm2 += area;
      // Mean width of a strip: twice its area over its outline.
      const perimeter = g.toPolygons().reduce((sum, poly) => sum + poly.reduce((s, pt, k) => {
        const q = poly[(k + 1) % poly.length];
        return s + Math.hypot(q[0] - pt[0], q[1] - pt[1]);
      }, 0), 0);
      report.wall.thinnestMm = Math.min(report.wall.thinnestMm, perimeter > 0 ? (2 * area) / perimeter : 0);
      if (area > worstWallArea) {
        worstWallArea = area;
        report.wall.atMm = where(g, (a + b) / 2);
      }
      if (mode === 'close') fills.push(wasm.Manifold.extrude(g, b - a).translate([0, 0, a]));
      else if (mode === 'fix') {
        const opened = g.offset(r, 'Round');
        cuts.push(wasm.Manifold.extrude(opened, b - a).translate([0, 0, a]));
        opened.delete();
      }
      g.delete();
    }
    slice.delete();
  }

  if (!fills.length && !cuts.length) return { part, report };
  let out = part;
  if (fills.length) {
    const all = wasm.Manifold.union([out, ...fills]);
    report.changedMm3 += all.volume() - out.volume();
    out = all;
  }
  if (cuts.length) {
    const tool = wasm.Manifold.union(cuts);
    const trimmed = out.subtract(tool);
    tool.delete();
    report.changedMm3 += out.volume() - trimmed.volume();
    if (out !== part) out.delete();
    out = trimmed;
  }
  for (const m of [...fills, ...cuts]) m.delete();
  return { part: out, report };
}

/** One line for the mold's warnings, or null when the casting has no thin gaps. */
export function thinGapWarning(report: ThinGapReport, limits: PrintLimits, mode: ThinGapMode): string | null {
  const parts: string[] = [];
  const at = (p: [number, number, number] | null) => (p ? ` (the biggest near ${p[0]}, ${p[1]}, ${p[2]} mm)` : '');
  if (report.skin.areaMm2 >= MIN_GAP_AREA_MM2) {
    parts.push(`${Math.round(report.skin.areaMm2 * 10) / 10} mm² of stacked faces under ${limits.minSkinMm} mm apart, down to ${report.skin.thinnestMm.toFixed(2)} mm${at(report.skin.atMm)}`);
  }
  if (report.wall.areaMm2 >= MIN_GAP_AREA_MM2) {
    parts.push(`${Math.round(report.wall.areaMm2 * 10) / 10} mm² of side-by-side gaps under ${limits.minWallMm} mm, down to ${report.wall.thinnestMm.toFixed(2)} mm${at(report.wall.atMm)}`);
  }
  if (!parts.length) return null;
  const found = `The casting has ${parts.join(', and ')}.`;
  if (mode === 'close') return `${found} Closed: filled with casting, ${Math.round(report.changedMm3 * 10) / 10} mm³ added, so the mold around them prints.`;
  if (mode === 'fix') return `${found} Opened: the part trimmed back by ${Math.round(report.changedMm3 * 10) / 10} mm³ until each gap prints.`;
  return `${found} The mold there is thinner than the printer makes, and prints as loose film or not at all. Set Thin gaps to Close (fill them with casting) or Fix model (open them up).`;
}
