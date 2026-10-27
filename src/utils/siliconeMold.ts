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

export type PourBoxShape = 'fit' | 'round' | 'box';

export type HolePurpose = 'wick' | 'pour' | 'fixing';

/** Narrower than this, mm, and a pour will not go in through a hole. */
export const MIN_POUR_HOLE_MM = 6;
/** The largest hole a pour through the foot takes as plugged, mm² (pourCast's limit). */
const MAX_PLUGGED_MM2 = 20;
const MAX_PLUGGED_DIA_MM = Math.floor(2 * Math.sqrt(MAX_PLUGGED_MM2 / Math.PI) * 10) / 10;

/** A hole's diameter until one is set, mm: a wick's, a pour spout's, a fixing screw's. */
export const HOLE_DIA_MM: Record<HolePurpose, number> = { wick: 2.5, pour: 8, fixing: 3 };

export interface PourBoxOptions {
  /** Silicone round the sides and over the top of the master. */
  coverMm: number;
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
  silicone: 'platinum',
};

/** An indexed mesh, millimetres, Z up. */
export interface PourBoxMesh {
  positions: number[];
  faces: number[];
}

export interface PourBoxReport {
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
  const mesh = m.getMesh();
  const positions: number[] = [];
  for (let i = 0; i < mesh.numVert; i++) {
    positions.push(mesh.vertProperties[i * mesh.numProp], mesh.vertProperties[i * mesh.numProp + 1], mesh.vertProperties[i * mesh.numProp + 2]);
  }
  return { positions, faces: Array.from(mesh.triVerts) };
}

function extent(cs: CrossSection): [number, number] {
  const b = cs.bounds();
  return [+(b.max[0] - b.min[0]).toFixed(1), +(b.max[1] - b.min[1]).toFixed(1)];
}

/**
 * Builds the pour box round a master given as a triangle soup in mm, Z up.
 * Throws when the master is empty.
 */
export function buildPourBox(wasm: ManifoldToplevel, masterSoup: ArrayLike<number>, partial: Partial<PourBoxOptions> = {}): PourBox {
  const o = { ...DEFAULT_POUR_BOX_OPTIONS, ...partial };
  if (masterSoup.length < 9) throw new Error('The master has no geometry to build a pour box round.');
  const warnings: string[] = [];
  const cover = Math.max(1, o.coverMm);
  const wall = Math.max(0.8, o.wallMm);
  const clear = Math.max(0, o.clearanceMm);
  const groove = Math.max(0.5, Math.min(o.grooveMm, o.baseMm - 1));

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
      warnings.push(`A pour hole ${diaMm} mm across is too narrow to pour through; make it at least ${MIN_POUR_HOLE_MM} mm.`);
    }
    if (o.hole !== 'pour' && Math.PI * (diaMm / 2) ** 2 > MAX_PLUGGED_MM2) {
      warnings.push(`A ${o.hole} hole ${diaMm} mm across is too big to plug while pouring through the master's foot; keep it under ${MAX_PLUGGED_DIA_MM} mm, or make it a pour hole.`);
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
  const silicone = isSiliconeId(o.silicone) ? o.silicone : 'platinum';
  const grams = castWeightG(silicone, siliconeMm3);
  const parts = mixGrams(silicone, grams);

  if (zTop - zMin < 1) warnings.push('The master is less than 1 mm tall.');

  const result: PourBox = {
    base: meshOf(baseM),
    sleeve: meshOf(sleeveM),
    ...(hole ? { hole } : {}),
    report: {
      fillHeightMm: +(fillZ - zMin).toFixed(2),
      fillZMm: +fillZ.toFixed(3),
      pourDepthMm: +(fillZ - (clear > 0 ? sleeveBottom : zMin)).toFixed(2),
      sleeveHeightMm: +(sleeveTop - sleeveBottom).toFixed(2),
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
