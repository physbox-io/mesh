// A pour box for a silicone mold: the printed "mother mold" a master stands in
// while silicone is poured round it.
//
// Three printed pieces, as a maker builds one by hand:
//   base   — a plate the master stands on, with a groove the sleeve drops into,
//            so the silicone cannot run out underneath;
//   sleeve — a wall round the master, `coverMm` clear of it on every side,
//            standing `freeboardMm` above the fill line;
//   pin    — optional: a pin from a point on the master's top (its highest
//            point unless one is given) to just above the fill line, leaving
//            a hole through the silicone for a wick, a pour or a fixing.
// Fill the sleeve to `fillZ`: `coverMm` over the master's top.
//
// The master is taken as it stands: it is poured from +Z, and it stands on its
// lowest point. Everything is built from 2D outlines extruded by Manifold, so
// every piece is closed by construction. The footprint follows the master's
// plan (its convex hull grown by the cover) unless a round or box sleeve is
// asked for: a round sleeve is a length of tube, and wastes silicone on a long
// master; a hull sleeve wastes none.
//
// All lengths are millimetres in the world frame, Z up, as moldExporter works.

import type { ManifoldToplevel, CrossSection, Manifold } from 'manifold-3d';
import { castMaterial, castWeightG, isSiliconeId, mixGrams, type SiliconeId } from './castMaterials';
import { trappedAirInSoup } from './trappedAir';
import { printedMeshOf } from './printedMesh';

/** Starts the pour box's warning of air held at other high points; the Silicone chain vents them and drops it. */
export const OTHER_PEAKS_PREFIX = 'A pour through the hole traps air at';

export type PourBoxShape = 'fit' | 'round' | 'box';

export type HolePurpose = 'wick' | 'pour' | 'fixing';

/** Narrower than this, mm, and a pour will not go in through a hole. */
export const MIN_POUR_HOLE_MM = 6;
/** Silicone cover a budget may thin the box to, and thicken it to, mm. */
export const MIN_COVER_MM = 4;
export const MAX_COVER_MM = 30;
/** The largest hole a pour through the foot takes as plugged, mm² (pourCast's limit). */
const MAX_PLUGGED_MM2 = 20;
const MAX_PLUGGED_DIA_MM = Math.floor(2 * Math.sqrt(MAX_PLUGGED_MM2 / Math.PI) * 10) / 10;

/** A hole's diameter until one is set, mm: a wick's, a pour spout's, a fixing screw's. */
export const HOLE_DIA_MM: Record<HolePurpose, number> = { wick: 2.5, pour: 8, fixing: 3 };

export interface PourBoxOptions {
  /** Silicone round the sides and over the top of the master. */
  coverMm: number;
  /** Silicone to hand, g (A + B): the cover is made as thick as this allows (overrides coverMm). */
  siliconeBudgetG?: number | null;
  /** Sleeve wall. */
  wallMm: number;
  /** Gap each side between the sleeve and its groove. */
  clearanceMm: number;
  /** Base plate thickness. */
  baseMm: number;
  /** Groove depth into the base. */
  grooveMm: number;
  /** Sleeve above the fill line, so a full pour does not slop over. */
  freeboardMm: number;
  /** Base plate past the groove's outer edge. */
  rimMm: number;
  shape: PourBoxShape;
  /**
   * A hole through the silicone above the master, made by a printed pin from
   * the master's top to 1 mm above the fill line, and what it is for; null for
   * none. A pour hole is poured through, the mold standing as it was made; a
   * wick or fixing hole is plugged and the mold poured through the master's foot.
   */
  hole: HolePurpose | null;
  /** The hole across, mm; null takes the purpose's own (HOLE_DIA_MM). */
  holeDiaMm: number | null;
  /** Where on the master, in plan (world mm); null for its highest point. */
  holeAtMm: [number, number] | null;
  /**
   * Split the sleeve across the middle of its long edges into two halves with
   * a labyrinth seam seal and two sliding dovetail C-clips, so cured silicone
   * releases sideways instead of being pushed out of a closed layer-lined tube.
   */
  splitSleeve: boolean;
  silicone: SiliconeId;
}

export const DEFAULT_POUR_BOX_OPTIONS: PourBoxOptions = {
  coverMm: 8,
  wallMm: 2.4,
  clearanceMm: 0.2,
  baseMm: 6,
  grooveMm: 3,
  freeboardMm: 2,
  rimMm: 3,
  shape: 'fit',
  hole: null,
  holeDiaMm: null,
  holeAtMm: null,
  splitSleeve: true,
  silicone: 'platinum',
};

/** An indexed mesh, millimetres, Z up. */
export interface PourBoxMesh {
  positions: number[];
  faces: number[];
}

export interface PourSleevePart {
  /** 'sleeve' (one-piece), or 'sleeve1', 'sleeve2', 'clip1', 'clip2'. */
  key: string;
  label: string;
  role: 'sleeve' | 'clip';
  /** Centred in plan on Z = 0, ready to print on its own. */
  mesh: PourBoxMesh;
  /** In world mm around the master, as placed in the scene. */
  assembled: PourBoxMesh;
  /** Unit vector this part moves along to release ([0,0,1] for clips, ±slide for sleeve halves). */
  release: [number, number, number];
  sizeMm: [number, number, number];
}

export interface PourBoxReport {
  /** Silicone round the master and over its top, as planned, mm (a budget sets it). */
  coverMm: number;
  /** Whether the sleeve is split into two halves with sliding clips. */
  splitSleeve: boolean;
  /** Fill line, as a height above the base plate's top (where the master stands). */
  fillHeightMm: number;
  /** World Z of the fill line. */
  fillZMm: number;
  /**
   * The fill as a pour simulation measures it: from the lowest point the
   * silicone reaches, which is the groove's floor when there is clearance
   * down the groove's inside for it to run into.
   */
  pourDepthMm: number;
  sleeveHeightMm: number;
  /** The groove's depth as built: grooveMm, less if the base is too thin for it. */
  grooveMm: number;
  sleeveFootprintMm: [number, number];
  baseFootprintMm: [number, number];
  siliconeMm3: number;
  siliconeG: number;
  /** The two parts to weigh out, grams. */
  partAG: number;
  partBG: number;
  siliconeName: string;
  silicone: SiliconeId;
  /** Where the hole comes out above the fill line, world mm. */
  holeTopMm?: [number, number, number];
  warnings: string[];
}

export interface PourBox {
  base: PourBoxMesh;
  sleeve: PourBoxMesh;
  /** Printable sleeve parts: [sleeve1, sleeve2, clip1, clip2] when split, [sleeve] otherwise. */
  sleeveParts: PourSleevePart[];
  /** The hole's pin as a cylinder: centre of its foot, length and diameter (mm), and what it is for. */
  hole?: { footMm: [number, number, number]; lengthMm: number; diaMm: number; purpose: HolePurpose };
  report: PourBoxReport;
}

/** Signed volume of a triangle soup (9 numbers per triangle), mm³ when given mm. */
export function soupVolume(soup: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i + 8 < soup.length; i += 9) {
    v += (soup[i] * (soup[i + 4] * soup[i + 8] - soup[i + 5] * soup[i + 7])
      - soup[i + 1] * (soup[i + 3] * soup[i + 8] - soup[i + 5] * soup[i + 6])
      + soup[i + 2] * (soup[i + 3] * soup[i + 7] - soup[i + 4] * soup[i + 6])) / 6;
  }
  return v;
}

/**
 * The hole's pin as a printable mesh, mm, standing on Z = 0: a closed
 * cylinder, its faces wound outward (the sides from their own direction, the
 * bottom down, the top up).
 */
export function holePinMesh(hole: NonNullable<PourBox['hole']>, segments = 32): PourBoxMesh {
  const r = hole.diaMm / 2;
  const h = hole.lengthMm;
  const positions: number[] = [];
  for (const z of [0, h]) {
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * 2 * Math.PI;
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
    }
  }
  const bottomCentre = positions.length / 3;
  positions.push(0, 0, 0);
  const topCentre = bottomCentre + 1;
  positions.push(0, 0, h);
  const faces: number[] = [];
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    // Side, facing out: counter-clockwise seen from outside.
    faces.push(k, k1, segments + k1, k, segments + k1, segments + k);
    // Bottom, facing -z; top, facing +z.
    faces.push(bottomCentre, k1, k);
    faces.push(topCentre, segments + k, segments + k1);
  }
  return { positions, faces };
}

/** The top of the master's surface over a point in plan, mm, or null when nothing is under it. */
export function topZAt(soup: ArrayLike<number>, x: number, y: number): number | null {
  let top: number | null = null;
  for (let i = 0; i + 8 < soup.length; i += 9) {
    const ax = soup[i], ay = soup[i + 1], bx = soup[i + 3], by = soup[i + 4], cx = soup[i + 6], cy = soup[i + 7];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) continue;
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
    const z = u * soup[i + 2] + v * soup[i + 5] + w * soup[i + 8];
    if (top === null || z > top) top = z;
  }
  return top;
}

/** Volume of a closed soup below the plane z = zCut, mm³. */
function soupVolumeBelow(wasm: ManifoldToplevel, soup: ArrayLike<number>, zCut: number): number | null {
  // The master is usually below the fill line entirely; only a pin or a
  // sprue reaches above it. Clip only when something does.
  let top = -Infinity;
  for (let i = 2; i < soup.length; i += 3) top = Math.max(top, soup[i]);
  if (top <= zCut) return Math.abs(soupVolume(soup));
  try {
    const n = soup.length / 3;
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(soup), triVerts: Uint32Array.from({ length: n }, (_, i) => i) });
    mesh.merge();
    const m = wasm.Manifold.ofMesh(mesh);
    const below = m.trimByPlane([0, 0, -1], -zCut);
    const v = below.volume();
    m.delete(); below.delete();
    return v;
  } catch {
    return null;
  }
}

function meshOf(m: Manifold): PourBoxMesh {
  // Without the slivers booleans leave along their seams (see printedMesh.ts).
  return printedMeshOf(m);
}

function extent(cs: CrossSection): [number, number] {
  const b = cs.bounds();
  return [+(b.max[0] - b.min[0]).toFixed(1), +(b.max[1] - b.min[1]).toFixed(1)];
}

type Vec2 = [number, number];

function signedArea2D(pts: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function poly2D(wasm: ManifoldToplevel, pts: Vec2[]): CrossSection {
  const ccw = signedArea2D(pts) >= 0 ? pts : [...pts].reverse();
  return wasm.CrossSection.ofPolygons([ccw], 'Positive');
}

function centredBedMesh(m: Manifold): { mesh: PourBoxMesh; sizeMm: [number, number, number] } {
  const b = m.boundingBox();
  const c = m.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
  const mesh = meshOf(c);
  c.delete();
  return {
    mesh,
    sizeMm: [+(b.max[0] - b.min[0]).toFixed(1), +(b.max[1] - b.min[1]).toFixed(1), +(b.max[2] - b.min[2]).toFixed(1)],
  };
}

function largestSolid(m: Manifold): Manifold {
  const parts = m.decompose();
  if (parts.length <= 1) {
    for (const p of parts) p.delete();
    return m;
  }
  let best = 0, bestVol = -Infinity;
  parts.forEach((p, i) => {
    const v = p.volume();
    if (v > bestVol) { bestVol = v; best = i; }
  });
  parts.forEach((p, i) => { if (i !== best) p.delete(); });
  m.delete();
  return parts[best];
}

/**
 * Splits the pour sleeve across the middle of its long edges into two halves
 * (`sleeve1`, `sleeve2`) with 45°-supported tapered dovetail rails above the
 * base groove, a vertical tongue-and-groove seam seal, and two sliding C-clips
 * (`clip1`, `clip2`) so cured silicone peels out sideways without tearing.
 */
function buildSplitPourSleeve(
  wasm: ManifoldToplevel,
  inner: CrossSection,
  outer: CrossSection,
  wall: number,
  clear: number,
  zMin: number,
  sleeveBottom: number,
  sleeveTop: number,
): PourSleevePart[] {
  const trash: (Manifold | CrossSection)[] = [];
  const keep = <T extends Manifold | CrossSection>(x: T) => (trash.push(x), x);
  try {
    const ob = outer.bounds();
    const scx = (ob.min[0] + ob.max[0]) / 2, scy = (ob.min[1] + ob.max[1]) / 2;
    const turn90 = (ob.max[0] - ob.min[0]) > (ob.max[1] - ob.min[1]) + 1e-6;
    const toLocal2D = (cs: CrossSection) => {
      const s = keep(cs.translate([-scx, -scy]));
      return turn90 ? keep(s.rotate(90)) : s;
    };
    const fromLocal3D = (m: Manifold) => {
      const r = turn90 ? keep(m.rotate([0, 0, -90])) : m;
      return keep(r.translate([scx, scy, 0]));
    };

    const innerL = toLocal2D(inner);
    const outerL = toLocal2D(outer);
    const outerPts = outerL.toPolygons().flat();
    let uMin = Infinity, vAtMin = 0, uMax = -Infinity, vAtMax = 0;
    for (const [u, v] of outerPts) {
      if (u < uMin) { uMin = u; vAtMin = v; }
      if (u > uMax) { uMax = u; vAtMax = v; }
    }
    const lb = outerL.bounds();
    const spanV = lb.max[1] - lb.min[1];

    // Split chord connecting the two u-extrema on the long edges: guarantees
    // zero undercut when the two halves pull along -v and +v for any convex hull.
    const dx = uMax - uMin, dy = vAtMax - vAtMin;
    const dLen = Math.hypot(dx, dy) || 1;
    const nx = -dy / dLen, ny = dx / dLen; // points toward +v
    const cLine = uMin * nx + vAtMin * ny;

    const ringL = keep(outerL.subtract(innerL));
    const fullH = sleeveTop - sleeveBottom;
    const baseSleeve = keep(keep(ringL.extrude(fullH)).translate([0, 0, sleeveBottom]));

    const DOVE_H = 3.6;
    const flare = 1.8;
    const CLIP_CLEAR = 0.25;
    const padExtra = Math.max(1.0, 3.8 - wall);
    const zPadStart = Math.min(zMin + Math.max(0.5, clear + 0.3), sleeveTop - 3);
    const rampH = Math.min(padExtra + DOVE_H, Math.max(0.5, (sleeveTop - zPadStart) * 0.35));
    const zClipSeat = zPadStart + rampH;
    const clipH = Math.max(2, sleeveTop - zClipSeat);
    const taper = Math.min(0.45, Math.max(0.2, clipH * 0.007));
    const neckTop = Math.min(4.8, Math.max(3.0, spanV * 0.14));
    const neckBot = neckTop + taper;
    const padHalfV = neckBot + 1.0;

    const innerCut = keep(keep(innerL.extrude(fullH + 4)).translate([0, 0, sleeveBottom - 2]));
    const padAndRails: Manifold[] = [baseSleeve];
    const clipsLocal: Manifold[] = [];
    const tongues: Manifold[] = [];
    const grooves: Manifold[] = [];

    for (const sx of [-1, 1] as const) {
      const uOut = sx > 0 ? uMax : uMin;
      const vAt = sx > 0 ? vAtMax : vAtMin;
      const uPad = uOut + sx * padExtra;
      const uReachIn = uOut - sx * Math.max(wall + 4, (uMax - uMin) * 0.35);

      // Seam pad: flush inside outerL at zPadStart, 45° ramp out to uPad at zClipSeat, vertical to sleeveTop.
      const padBox2D = keep(poly2D(wasm, [
        [uReachIn, vAt - padHalfV],
        [uPad, vAt - padHalfV],
        [uPad, vAt + padHalfV],
        [uReachIn, vAt + padHalfV],
      ]));
      const padFoot2D = keep(padBox2D.intersect(outerL));
      const padFoot = keep(keep(padFoot2D.extrude(0.02)).translate([0, 0, zPadStart]));
      const padBody = keep(keep(padBox2D.extrude(clipH)).translate([0, 0, zClipSeat]));
      padAndRails.push(keep(wasm.Manifold.hull([padFoot, padBody])));

      // Tapered dovetail rail: 45° ramp from outerL at zPadStart to full dovetail at zClipSeat..sleeveTop.
      const railTrap2D = (neck: number) => keep(poly2D(wasm, [
        [uPad - sx * 0.5, vAt - neck],
        [uPad + sx * DOVE_H, vAt - (neck + flare)],
        [uPad + sx * DOVE_H, vAt + (neck + flare)],
        [uPad - sx * 0.5, vAt + neck],
      ]));
      const rFoot2D = keep(padFoot2D.intersect(keep(poly2D(wasm, [
        [uReachIn, vAt - neckBot],
        [uOut, vAt - neckBot],
        [uOut, vAt + neckBot],
        [uReachIn, vAt + neckBot],
      ]))));
      const rBot = keep(keep(railTrap2D(neckBot).extrude(0.02)).translate([0, 0, zClipSeat]));
      const rTop = keep(keep(railTrap2D(neckTop).extrude(0.02)).translate([0, 0, sleeveTop - 0.02]));
      padAndRails.push(keep(wasm.Manifold.hull([rBot, rTop])));
      if (!rFoot2D.isEmpty() && rampH > 0.2) {
        const rFoot = keep(keep(rFoot2D.extrude(0.02)).translate([0, 0, zPadStart]));
        padAndRails.push(keep(wasm.Manifold.hull([rFoot, rBot])));
      }

      // Vertical labyrinth tongue & groove inside the thickened pad above zClipSeat.
      if (clipH >= 6) {
        const uMid = uPad - sx * 1.8;
        const t2d = keep(poly2D(wasm, [[uMid - 0.6, vAt - 0.4], [uMid + 0.6, vAt - 0.4], [uMid + 0.6, vAt + 1.3], [uMid - 0.6, vAt + 1.3]]));
        const tBase2d = keep(poly2D(wasm, [[uMid - 0.6, vAt - 0.4], [uMid + 0.6, vAt - 0.4], [uMid + 0.6, vAt - 0.1], [uMid - 0.6, vAt - 0.1]]));
        const t0 = keep(keep(tBase2d.extrude(0.02)).translate([0, 0, zClipSeat + 0.2]));
        const t1 = keep(keep(t2d.extrude(clipH - 2.0)).translate([0, 0, zClipSeat + 2.0]));
        tongues.push(keep(wasm.Manifold.hull([t0, t1])));

        const g2d = keep(poly2D(wasm, [[uMid - 0.85, vAt - 0.2], [uMid + 0.85, vAt - 0.2], [uMid + 0.85, vAt + 1.65], [uMid - 0.85, vAt + 1.65]]));
        grooves.push(keep(keep(g2d.extrude(clipH + 1)).translate([0, 0, zClipSeat - 0.1])));
      }

      // Matching sliding C-clip for this long edge (z in [zClipSeat, sleeveTop]).
      const cFlank = CLIP_CLEAR / Math.cos(Math.atan2(flare, DOVE_H));
      const uFront = uPad + sx * 0.4;
      const dPocketBack = DOVE_H + 0.35;
      const uPocketBack = uPad + sx * dPocketBack;
      const clipJaw = 3.2;
      const uSpine = uPocketBack + sx * 3.4;
      const wNeckAt = (zRel: number) => neckBot - (taper / clipH) * zRel;
      const vPocketAt = (zRel: number, d: number) => wNeckAt(zRel) + cFlank + d * (flare / DOVE_H);

      const outerClipAt = (zRel: number, zWorld: number) => {
        const vOut = vPocketAt(zRel, dPocketBack) + clipJaw;
        const cs = keep(poly2D(wasm, [[uFront, vAt - vOut], [uSpine, vAt - vOut], [uSpine, vAt + vOut], [uFront, vAt + vOut]]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, zWorld]));
      };
      let clipBody = keep(wasm.Manifold.hull([outerClipAt(0, zClipSeat), outerClipAt(clipH, sleeveTop - 0.02)]));
      if (clipH >= 10) {
        const vTop = vPocketAt(clipH, dPocketBack) + clipJaw;
        const tabFoot = keep(keep(poly2D(wasm, [[uSpine - sx * 0.4, vAt - vTop], [uSpine, vAt - vTop], [uSpine, vAt + vTop], [uSpine - sx * 0.4, vAt + vTop]]).extrude(0.02)).translate([0, 0, sleeveTop - 5.2]));
        const tabTop = keep(keep(poly2D(wasm, [[uSpine - sx * 0.4, vAt - vTop], [uSpine + sx * 2.4, vAt - vTop], [uSpine + sx * 2.4, vAt + vTop], [uSpine - sx * 0.4, vAt + vTop]]).extrude(2.4)).translate([0, 0, sleeveTop - 2.4]));
        clipBody = keep(clipBody.add(keep(wasm.Manifold.hull([tabFoot, tabTop]))));
      }
      const pocketAt = (zRel: number, zWorld: number) => {
        const d0 = -0.5;
        const v0 = vPocketAt(zRel, d0), v1 = vPocketAt(zRel, dPocketBack);
        const cs = keep(poly2D(wasm, [[uPad + sx * d0, vAt - v0], [uPocketBack, vAt - v1], [uPocketBack, vAt + v1], [uPad + sx * d0, vAt + v0]]));
        return keep(keep(cs.extrude(0.02)).translate([0, 0, zWorld]));
      };
      const pocket = keep(wasm.Manifold.hull([pocketAt(-0.5, zClipSeat - 0.5), pocketAt(clipH + 0.5, sleeveTop + 0.48)]));
      clipsLocal.push(keep(largestSolid(clipBody.subtract(pocket))));
    }

    const fullCollar = keep(keep(wasm.Manifold.union(padAndRails)).subtract(innerCut));

    // Print halves: 0.02 mm clearance off the split plane so standalone STLs never touch;
    // Assembled halves: 0.02 mm press-fit overlap so pour simulations see a sealed sleeve.
    const makeHalf = (sign: -1 | 1, offsetDelta: number) => {
      let h = keep(fullCollar.trimByPlane([sign * nx, sign * ny, 0], sign * cLine + offsetDelta));
      if (tongues.length) {
        if (sign < 0) h = keep(h.add(keep(wasm.Manifold.union(tongues))));
        else h = keep(h.subtract(keep(wasm.Manifold.union(grooves))));
      }
      return keep(largestSolid(h));
    };

    const s1Print = fromLocal3D(makeHalf(-1, 0.02));
    const s2Print = fromLocal3D(makeHalf(1, 0.02));
    const s1Asm = fromLocal3D(makeHalf(-1, -0.02));
    const s2Asm = fromLocal3D(makeHalf(1, -0.02));
    const c1World = fromLocal3D(clipsLocal[0]);
    const c2World = fromLocal3D(clipsLocal[1]);

    const relNeg: [number, number, number] = turn90 ? [-1, 0, 0] : [0, -1, 0];
    const relPos: [number, number, number] = turn90 ? [1, 0, 0] : [0, 1, 0];
    const s1Bed = centredBedMesh(s1Print);
    const s2Bed = centredBedMesh(s2Print);
    const c1Bed = centredBedMesh(c1World);
    const c2Bed = centredBedMesh(c2World);

    return [
      { key: 'sleeve1', label: 'sleeve 1', role: 'sleeve', mesh: s1Bed.mesh, assembled: meshOf(s1Asm), release: relNeg, sizeMm: s1Bed.sizeMm },
      { key: 'sleeve2', label: 'sleeve 2', role: 'sleeve', mesh: s2Bed.mesh, assembled: meshOf(s2Asm), release: relPos, sizeMm: s2Bed.sizeMm },
      { key: 'clip1', label: 'clip 1', role: 'clip', mesh: c1Bed.mesh, assembled: meshOf(c1World), release: [0, 0, 1], sizeMm: c1Bed.sizeMm },
      { key: 'clip2', label: 'clip 2', role: 'clip', mesh: c2Bed.mesh, assembled: meshOf(c2World), release: [0, 0, 1], sizeMm: c2Bed.sizeMm },
    ];
  } finally {
    for (const x of new Set(trash)) {
      try { x.delete(); } catch { /* already freed */ }
    }
  }
}

/**
 * Builds the pour box round a master given as a triangle soup in mm, Z up.
 * Throws when the master is empty.
 */
export function buildPourBox(wasm: ManifoldToplevel, masterSoup: ArrayLike<number>, partial: Partial<PourBoxOptions> = {}): PourBox {
  const o = { ...DEFAULT_POUR_BOX_OPTIONS, ...partial };
  if (masterSoup.length < 9) throw new Error('The master has no geometry to build a pour box round.');
  const warnings: string[] = [];
  let cover = Math.max(1, o.coverMm);
  const wall = Math.max(0.8, o.wallMm);
  const clear = Math.max(0, o.clearanceMm);
  const groove = Math.max(0.5, Math.min(o.grooveMm, o.baseMm - 1));
  if (Math.abs(groove - o.grooveMm) > 1e-9) {
    warnings.push(
      `Groove depth clamped to ${+groove.toFixed(2)} mm (from ${o.grooveMm} mm) to leave 1 mm floor in the ${o.baseMm} mm base.`,
    );
  }

  let zMin = Infinity, zTop = -Infinity, topAt: [number, number] = [0, 0];
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  const points: [number, number][] = [];
  for (let i = 0; i + 2 < masterSoup.length; i += 3) {
    const x = masterSoup[i], y = masterSoup[i + 1], z = masterSoup[i + 2];
    points.push([x, y]);
    if (z < zMin) zMin = z;
    if (z > zTop) { zTop = z; topAt = [x, y]; }
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  // The hole rises from the middle of the master's top when the top is a flat
  // face (a candle), not from whichever corner of it came first.
  let tx = 0, ty = 0, tn = 0;
  for (let i = 0; i + 2 < masterSoup.length; i += 3) {
    if (masterSoup[i + 2] > zTop - 0.05) { tx += masterSoup[i]; ty += masterSoup[i + 1]; tn++; }
  }
  // The middle of the flat top, so long as that is on it: two equal peaks or a
  // U-shaped top average to a point in the air, so then the highest vertex.
  const highest = topAt;
  if (tn) {
    const mid: [number, number] = [tx / tn, ty / tn];
    const z = topZAt(masterSoup, mid[0], mid[1]);
    topAt = z !== null && z > zTop - 0.05 ? mid : highest;
  }

  const segs = 96;
  let plan: CrossSection;
  if (o.shape === 'round') {
    let r = 0;
    for (const [x, y] of points) r = Math.max(r, Math.hypot(x - cx, y - cy));
    plan = wasm.CrossSection.circle(r, segs).translate(cx, cy);
  } else if (o.shape === 'box') {
    plan = wasm.CrossSection.square([xMax - xMin, yMax - yMin], true).translate(cx, cy);
  } else {
    plan = wasm.CrossSection.hull([points]);
  }

  // Given the silicone to hand, the cover is as thick as it allows: the bore
  // to the fill line less the master, solved for the cover.
  const siliconeId = isSiliconeId(o.silicone) ? o.silicone : 'platinum';
  if (o.siliconeBudgetG && o.siliconeBudgetG > 0) {
    const budget = o.siliconeBudgetG;
    const masterAll = soupVolumeBelow(wasm, masterSoup, zTop + 1) ?? 0;
    const gramsFor = (t: number) => {
      const ring = plan.offset(t, 'Round', 2, segs);
      const mm3 = Math.max(0, ring.area() * (zTop + t - zMin) - masterAll);
      ring.delete();
      return castWeightG(siliconeId, mm3);
    };
    if (gramsFor(MIN_COVER_MM) > budget) {
      cover = MIN_COVER_MM;
      warnings.push(`Even ${MIN_COVER_MM} mm of silicone round the master takes about ${Math.round(gramsFor(MIN_COVER_MM))} g, over the ${Math.round(budget)} g budget: the box is planned at ${MIN_COVER_MM} mm.`);
    } else {
      let lo = MIN_COVER_MM, hi = MAX_COVER_MM;
      if (gramsFor(hi) <= budget) lo = hi;
      else for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (gramsFor(mid) <= budget) lo = mid; else hi = mid; }
      cover = Math.floor(lo * 2) / 2;
    }
  }
  const inner = plan.offset(cover, 'Round', 2, segs);
  const outer = inner.offset(wall, 'Round', 2, segs);
  const grooveOuter = outer.offset(clear, 'Round', 2, segs);
  const grooveInner = inner.offset(-clear, 'Round', 2, segs);
  const baseOutline = grooveOuter.offset(Math.max(1, o.rimMm), 'Round', 2, segs);

  const fillZ = zTop + cover;
  const sleeveBottom = zMin - groove;
  const sleeveTop = fillZ + Math.max(0, o.freeboardMm);

  const ring = outer.subtract(inner);
  const sleeveM = ring.extrude(sleeveTop - sleeveBottom).translate([0, 0, sleeveBottom]);
  const plate = baseOutline.extrude(o.baseMm).translate([0, 0, zMin - o.baseMm]);
  const grooveRing = grooveOuter.subtract(grooveInner);
  // A hair past the plate's top, so the cut is clean through that face.
  const grooveCut = grooveRing.extrude(groove + 0.01).translate([0, 0, zMin - groove]);
  const baseM = plate.subtract(grooveCut);

  let hole: PourBox['hole'];
  if (o.hole) {
    const [hx, hy] = o.holeAtMm ?? topAt;
    const diaMm = Math.max(0.5, o.holeDiaMm ?? HOLE_DIA_MM[o.hole]);
    const centreZ = topZAt(masterSoup, hx, hy);
    if (centreZ === null) throw new Error(`The hole at ${hx.toFixed(1)}, ${hy.toFixed(1)} mm is not over the master: pick a point on it.`);
    // On a sloped top the pin goes down to the lowest point under its rim, so
    // no silicone runs in under it and closes the hole.
    let footZ = centreZ;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI;
      const z = topZAt(masterSoup, hx + (diaMm / 2) * Math.cos(a), hy + (diaMm / 2) * Math.sin(a));
      if (z !== null) footZ = Math.min(footZ, z);
    }
    hole = {
      footMm: [hx, hy, footZ - 0.5],
      lengthMm: fillZ + 1 - (footZ - 0.5),
      diaMm,
      purpose: o.hole,
    };
    if (o.hole === 'pour' && diaMm < MIN_POUR_HOLE_MM) {
      warnings.push(`Pour hole diameter (${diaMm} mm) is below the ${MIN_POUR_HOLE_MM} mm minimum.`);
    }
    if (o.hole === 'pour') {
      // Resin poured through the hole fills the master's shape from the
      // bottom; every other high point holds its air unless vented.
      const others = trappedAirInSoup(Float64Array.from(masterSoup), fillZ + 1, undefined, [{ x: hx, y: hy, r: diaMm / 2 + 1 }]);
      if (others.length) {
        warnings.push(`${OTHER_PEAKS_PREFIX} ${others.length} other high point${others.length === 1 ? '' : 's'} of the master (${others.slice(0, 3).map((p) => `(${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)} mm)`).join(', ')}${others.length > 3 ? ' and more' : ''}): each needs a vent through the silicone, or the hole moved over it (hole_at_mm).`);
      }
    }
    if (o.hole !== 'pour' && Math.PI * (diaMm / 2) ** 2 > MAX_PLUGGED_MM2) {
      warnings.push(`${o.hole} hole diameter (${diaMm} mm) exceeds ${MAX_PLUGGED_DIA_MM} mm max for a plugged hole; reduce diameter or switch to a pour hole.`);
    }
  }

  // Silicone: the sleeve's bore up to the fill line, less the master, less the
  // pin below the line. The same sum build_mold.py made by hand; the pour
  // simulation of the result agrees with it (tests/siliconeMold.test.ts).
  const bore = inner.area() * (fillZ - zMin);
  const masterVol = soupVolumeBelow(wasm, masterSoup, fillZ);
  if (masterVol === null) warnings.push('The master is not a closed solid, so its volume is not known and the silicone figure counts it as empty space. Repair it first (physics_repair_mesh) for a true figure.');
  const pinVol = hole ? Math.PI * (hole.diaMm / 2) ** 2 * (fillZ - hole.footMm[2] - 0.5) : 0;
  const siliconeMm3 = Math.max(0, bore - (masterVol ?? 0) - pinVol);
  const silicone = siliconeId;
  const grams = castWeightG(silicone, siliconeMm3);
  const parts = mixGrams(silicone, grams);

  if (zTop - zMin < 1) warnings.push('The master is less than 1 mm tall.');

  const sleeveMesh = meshOf(sleeveM);
  const oneSleeveBed = centredBedMesh(sleeveM);
  const sleeveParts: PourSleevePart[] = o.splitSleeve
    ? buildSplitPourSleeve(wasm, inner, outer, wall, clear, zMin, sleeveBottom, sleeveTop)
    : [{ key: 'sleeve', label: 'sleeve', role: 'sleeve', mesh: oneSleeveBed.mesh, assembled: sleeveMesh, release: [0, 0, 0], sizeMm: oneSleeveBed.sizeMm }];

  const result: PourBox = {
    base: meshOf(baseM),
    sleeve: sleeveMesh,
    sleeveParts,
    ...(hole ? { hole } : {}),
    report: {
      coverMm: cover,
      splitSleeve: Boolean(o.splitSleeve),
      fillHeightMm: +(fillZ - zMin).toFixed(2),
      fillZMm: +fillZ.toFixed(3),
      pourDepthMm: +(fillZ - (clear > 0 ? sleeveBottom : zMin)).toFixed(2),
      sleeveHeightMm: +(sleeveTop - sleeveBottom).toFixed(2),
      grooveMm: +groove.toFixed(2),
      sleeveFootprintMm: extent(outer),
      baseFootprintMm: extent(baseOutline),
      siliconeMm3: Math.round(siliconeMm3),
      siliconeG: Math.round(grams),
      partAG: Math.round(parts?.a ?? grams),
      partBG: Math.round(parts?.b ?? 0),
      siliconeName: castMaterial(silicone).label,
      silicone,
      ...(hole ? { holeTopMm: [+hole.footMm[0].toFixed(2), +hole.footMm[1].toFixed(2), +(fillZ + 1).toFixed(2)] as [number, number, number] } : {}),
      warnings,
    },
  };
  for (const x of [plan, inner, outer, grooveOuter, grooveInner, baseOutline, ring, grooveRing]) x.delete();
  for (const x of [sleeveM, plate, grooveCut, baseM]) x.delete();
  return result;
}
