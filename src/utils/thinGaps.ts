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

  // Sloped/curved stacked faces (where |nz| < 0.999 missed flatFaces): ray-cast on
  // an XY grid when the part has non-horizontal, non-vertical faces and minSkinMm > 0.
  const box = part.boundingBox();
  const mesh = part.getMesh();
  const vp = mesh.vertProperties;
  const st = mesh.numProp;
  const tv = mesh.triVerts;
  const triCount = Math.floor(tv.length / 3);
  const triZMin = new Float64Array(triCount);
  const triZMax = new Float64Array(triCount);
  const triNz = new Float64Array(triCount);
  let hasSlopedSkinCandidate = false;
  let hasNonPrismaticFace = false;
  for (let ti = 0; ti < triCount; ti++) {
    const a = tv[ti * 3] * st, b = tv[ti * 3 + 1] * st, c = tv[ti * 3 + 2] * st;
    const z0 = vp[a + 2], z1 = vp[b + 2], z2 = vp[c + 2];
    triZMin[ti] = Math.min(z0, z1, z2);
    triZMax[ti] = Math.max(z0, z1, z2);
    const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = z1 - z0;
    const vx = vp[c] - vp[a], vy = vp[c + 1] - vp[a + 1], vz = z2 - z0;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const unz = len > 1e-12 ? nz / len : 0;
    triNz[ti] = unz;
    const anz = Math.abs(unz);
    if (anz > 1e-3 && anz < 0.999) {
      hasNonPrismaticFace = true;
      if (anz > 0.5) hasSlopedSkinCandidate = true;
    }
  }

  if (hasSlopedSkinCandidate && limits.minSkinMm > FLAT_SNAP_MM) {
    const spanX = box.max[0] - box.min[0];
    const spanY = box.max[1] - box.min[1];
    if (spanX > 1e-3 && spanY > 1e-3) {
      const ds = Math.max(0.3, Math.min(0.6, Math.max(spanX, spanY) / 72));
      const nx = Math.max(2, Math.ceil(spanX / ds));
      const ny = Math.max(2, Math.ceil(spanY / ds));
      const dx = spanX / nx;
      const dy = spanY / ny;
      const buckets: number[][] = Array.from({ length: nx * ny }, () => []);
      for (let ti = 0; ti < triCount; ti++) {
        if (Math.abs(triNz[ti]) < 1e-4) continue;
        const a = tv[ti * 3] * st, b = tv[ti * 3 + 1] * st, c = tv[ti * 3 + 2] * st;
        const x0 = Math.min(vp[a], vp[b], vp[c]), x1 = Math.max(vp[a], vp[b], vp[c]);
        const y0 = Math.min(vp[a + 1], vp[b + 1], vp[c + 1]), y1 = Math.max(vp[a + 1], vp[b + 1], vp[c + 1]);
        const c0 = Math.max(0, Math.floor((x0 - box.min[0]) / dx));
        const c1 = Math.min(nx - 1, Math.floor((x1 - box.min[0]) / dx));
        const r0 = Math.max(0, Math.floor((y0 - box.min[1]) / dy));
        const r1 = Math.min(ny - 1, Math.floor((y1 - box.min[1]) / dy));
        for (let r = r0; r <= r1; r++) {
          for (let col = c0; col <= c1; col++) buckets[r * nx + col].push(ti);
        }
      }
      let slopedArea = 0;
      let slopedThin = Infinity;
      let slopedWx = 0, slopedWy = 0, slopedWz = 0, slopedW = 0;
      for (let r = 0; r < ny; r++) {
        const y = box.min[1] + (r + 0.5) * dy;
        for (let col = 0; col < nx; col++) {
          const cand = buckets[r * nx + col];
          if (cand.length < 4) continue;
          const x = box.min[0] + (col + 0.5) * dx;
          const hits: Array<{ z: number; nz: number }> = [];
          for (const ti of cand) {
            const a = tv[ti * 3] * st, b = tv[ti * 3 + 1] * st, c = tv[ti * 3 + 2] * st;
            const ax = vp[a], ay = vp[a + 1], bx = vp[b], by = vp[b + 1], cx = vp[c], cy = vp[c + 1];
            const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(det) < 1e-12) continue;
            const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
            const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
            const l3 = 1 - l1 - l2;
            if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
            const z = l1 * vp[a + 2] + l2 * vp[b + 2] + l3 * vp[c + 2];
            hits.push({ z, nz: triNz[ti] });
          }
          if (hits.length < 4) continue;
          hits.sort((p, q) => p.z - q.z);
          // Collapse shared-edge duplicate crossings of the same sign.
          const clean: Array<{ z: number; nz: number }> = [];
          for (const h of hits) {
            const prev = clean[clean.length - 1];
            if (prev && Math.abs(h.z - prev.z) < 1e-4 && Math.sign(h.nz) === Math.sign(prev.nz)) continue;
            clean.push(h);
          }
          for (let k = 0; k + 3 < clean.length; k += 2) {
            const enterLo = clean[k], leaveLo = clean[k + 1], enterHi = clean[k + 2], leaveHi = clean[k + 3];
            if (!(leaveLo.nz > 0.3 && enterHi.nz < -0.3)) continue;
            // Purely horizontal flat-to-flat pairs were already measured above.
            if (leaveLo.nz >= 0.999 && enterHi.nz <= -0.999) continue;
            const dz = enterHi.z - leaveLo.z;
            const cosTilt = Math.min(Math.abs(leaveLo.nz), Math.abs(enterHi.nz));
            const gNorm = dz * cosTilt;
            if (!(dz > FLAT_SNAP_MM && gNorm < limits.minSkinMm - 1e-6)) continue;
            const cellArea = (dx * dy) / Math.max(0.5, cosTilt);
            slopedArea += cellArea;
            slopedThin = Math.min(slopedThin, gNorm);
            slopedWx += x * cellArea;
            slopedWy += y * cellArea;
            slopedWz += ((leaveLo.z + enterHi.z) / 2) * cellArea;
            slopedW += cellArea;
            if (mode === 'close') {
              const padLo = Math.min(0.15, Math.max(0.02, (leaveLo.z - enterLo.z) * 0.35));
              const padHi = Math.min(0.15, Math.max(0.02, (leaveHi.z - enterHi.z) * 0.35));
              fills.push(
                wasm.Manifold.cube([dx + 0.04, dy + 0.04, dz + padLo + padHi], false)
                  .translate([x - dx / 2 - 0.02, y - dy / 2 - 0.02, leaveLo.z - padLo]),
              );
            } else if (mode === 'fix') {
              const needDz = limits.minSkinMm / Math.max(0.5, cosTilt);
              const half = Math.max(0.02, (needDz - dz) / 2);
              cuts.push(
                wasm.Manifold.cube([dx + 0.04, dy + 0.04, dz + 2 * half], false)
                  .translate([x - dx / 2 - 0.02, y - dy / 2 - 0.02, leaveLo.z - half]),
              );
            }
          }
        }
      }
      if (slopedArea >= MIN_GAP_AREA_MM2) {
        report.skin.areaMm2 += slopedArea;
        report.skin.thinnestMm = Math.min(report.skin.thinnestMm, slopedThin);
        if (slopedArea > worstSkinArea && slopedW > 0) {
          report.skin.atMm = [
            Math.round((slopedWx / slopedW) * 10) / 10,
            Math.round((slopedWy / slopedW) * 10) / 10,
            Math.round((slopedWz / slopedW) * 10) / 10,
          ];
        }
      }
    }
  }

  // Walls: the part's slice in each band between flat heights, closed by half a wall.
  // Where a band contains sloped or curved faces, subdivide into thin sub-bands so
  // equatorial/curved gaps are caught and 'close'/'fix' never extrudes vertical fins.
  const r = limits.minWallMm / 2;
  const minWallPieceArea = Math.max(MIN_GAP_AREA_MM2, 0.35 * limits.minWallMm * limits.minWallMm);
  const heights = [...new Set([box.min[2], box.max[2], ...up.keys(), ...down.keys()])].sort((a, b) => a - b);
  let worstWallArea = 0;
  if (r > 1e-6) {
    for (let i = 0; i + 1 < heights.length; i++) {
      const a = heights[i], b = heights[i + 1];
      if (b - a < FLAT_SNAP_MM) continue;
      let bandCurved = false;
      if (hasNonPrismaticFace && b - a > 0.8) {
        for (let ti = 0; ti < triCount; ti++) {
          const anz = Math.abs(triNz[ti]);
          if (anz > 1e-3 && anz < 0.999 && triZMax[ti] > a + FLAT_SNAP_MM && triZMin[ti] < b - FLAT_SNAP_MM) {
            bandCurved = true;
            break;
          }
        }
      }
      const subStep = mode === 'leave' ? 0.8 : 0.5;
      const steps = bandCurved ? Math.min(40, Math.max(1, Math.ceil((b - a) / subStep))) : 1;
      const dh = (b - a) / steps;
      let bandUnion: CrossSection | null = null;
      let bandAtZ = (a + b) / 2;
      let bandMaxSubArea = 0;

      for (let s = 0; s < steps; s++) {
        const z0 = a + s * dh;
        const z1 = z0 + dh;
        const zMid = (z0 + z1) / 2;
        const slice = part.slice(zMid);
        const grown = slice.offset(r, 'Round');
        const closed = grown.offset(-r, 'Round');
        grown.delete();
        const gaps = closed.subtract(slice);
        closed.delete();
        // A closing also rounds every inside corner a hair (~0.054 * minWallMm² for 90°);
        // a real gap between two walls is appreciably larger than a corner fillet.
        const pieces = gaps.decompose().filter((g) => {
          const keep = g.area() >= minWallPieceArea;
          if (!keep) g.delete();
          return keep;
        });
        gaps.delete();

        // For curved sub-bands in 'close' mode, clip the gap to the intersection of
        // the grown slices near z0 and z1 so the web follows the curve without fins.
        let clipGuard: CrossSection | null = null;
        if (bandCurved && mode === 'close' && pieces.length > 0) {
          const eps = Math.min(0.05, dh * 0.15);
          const sLo = part.slice(z0 + eps);
          const sHi = part.slice(z1 - eps);
          const gLo = sLo.offset(r * 1.25, 'Round');
          const gHi = sHi.offset(r * 1.25, 'Round');
          sLo.delete();
          sHi.delete();
          clipGuard = gLo.intersect(gHi);
          gLo.delete();
          gHi.delete();
        }

        for (const g of pieces) {
          const area = g.area();
          const perimeter = g.toPolygons().reduce((sum, poly) => sum + poly.reduce((acc, pt, k) => {
            const q = poly[(k + 1) % poly.length];
            return acc + Math.hypot(q[0] - pt[0], q[1] - pt[1]);
          }, 0), 0);
          report.wall.thinnestMm = Math.min(report.wall.thinnestMm, perimeter > 0 ? (2 * area) / perimeter : 0);

          if (!bandCurved) {
            report.wall.areaMm2 += area;
            if (area > worstWallArea) {
              worstWallArea = area;
              report.wall.atMm = where(g, zMid);
            }
          } else {
            if (bandUnion) {
              const nextUnion: CrossSection = bandUnion.add(g);
              bandUnion.delete();
              bandUnion = nextUnion;
            } else {
              bandUnion = g.offset(0);
            }
            if (area > bandMaxSubArea) {
              bandMaxSubArea = area;
              bandAtZ = zMid;
            }
          }

          if (mode === 'close') {
            const fillCs = clipGuard ? g.intersect(clipGuard) : g;
            if (!fillCs.isEmpty()) {
              fills.push(wasm.Manifold.extrude(fillCs, dh).translate([0, 0, z0]));
            }
            if (fillCs !== g) fillCs.delete();
          } else if (mode === 'fix') {
            const opened = g.offset(r, 'Round');
            cuts.push(wasm.Manifold.extrude(opened, dh).translate([0, 0, z0]));
            opened.delete();
          }
          g.delete();
        }
        clipGuard?.delete();
        slice.delete();
      }

      if (bandUnion) {
        const area = bandUnion.area();
        if (area >= MIN_GAP_AREA_MM2) {
          report.wall.areaMm2 += area;
          if (area > worstWallArea) {
            worstWallArea = area;
            report.wall.atMm = where(bandUnion, bandAtZ);
          }
        }
        bandUnion.delete();
      }
    }
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
