// A pour box for a silicone mold: the printed "mother mold" a master stands in
// while silicone is poured round it.
//
// Three printed pieces, as a maker builds one by hand:
//   base   — a plate the master stands on, with a groove the sleeve drops into,
//            so the silicone cannot run out underneath;
//   sleeve — a wall round the master, `coverMm` clear of it on every side,
//            standing `freeboardMm` above the fill line;
//   pin    — optional: a wick (or sprue) pin from the master's highest point to
//            just above the fill line, leaving a hole through the silicone.
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

export type PourBoxShape = 'fit' | 'round' | 'box';

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
  /** A wick or sprue pin from the master's top to 1 mm above the fill line. */
  pin: boolean;
  pinDiaMm: number;
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
  pin: false,
  pinDiaMm: 2.5,
  silicone: 'platinum',
};

export type SiliconeId = 'platinum' | 'tin';

/** Mold silicones: density, and the A:B mix ratio by weight. */
export const SILICONES: Record<SiliconeId, { name: string; densityGcm3: number; ratioA: number; ratioB: number }> = {
  platinum: { name: 'Platinum-cure silicone', densityGcm3: 1.08, ratioA: 1, ratioB: 1 },
  tin: { name: 'Tin-cure silicone', densityGcm3: 1.15, ratioA: 10, ratioB: 1 },
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
  pinTopMm?: [number, number, number];
  warnings: string[];
}

export interface PourBox {
  base: PourBoxMesh;
  sleeve: PourBoxMesh;
  /** The pin as a cylinder: centre of its foot, length and diameter (mm). */
  pin?: { footMm: [number, number, number]; lengthMm: number; diaMm: number };
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
  // The pin rises from the middle of the master's top when the top is a flat
  // face (a candle), not from whichever corner of it came first.
  let tx = 0, ty = 0, tn = 0;
  for (let i = 0; i + 2 < masterSoup.length; i += 3) {
    if (masterSoup[i + 2] > zTop - 0.05) { tx += masterSoup[i]; ty += masterSoup[i + 1]; tn++; }
  }
  if (tn) topAt = [tx / tn, ty / tn];

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

  const pin = o.pin
    ? { footMm: [topAt[0], topAt[1], zTop - 0.5] as [number, number, number], lengthMm: fillZ + 1 - (zTop - 0.5), diaMm: Math.max(0.5, o.pinDiaMm) }
    : undefined;

  // Silicone: the sleeve's bore up to the fill line, less the master, less the
  // pin below the line. The same sum build_mold.py made by hand; the pour
  // simulation of the result agrees with it (tests/siliconeMold.test.ts).
  const bore = inner.area() * (fillZ - zMin);
  const masterVol = soupVolumeBelow(wasm, masterSoup, fillZ);
  if (masterVol === null) warnings.push('The master is not a closed solid, so its volume is not known and the silicone figure counts it as empty space. Repair it first (physics_repair_mesh) for a true figure.');
  const pinVol = pin ? Math.PI * (pin.diaMm / 2) ** 2 * cover : 0;
  const siliconeMm3 = Math.max(0, bore - (masterVol ?? 0) - pinVol);
  const s = SILICONES[o.silicone] ?? SILICONES.platinum;
  const grams = (siliconeMm3 / 1000) * s.densityGcm3;

  if (zTop - zMin < 1) warnings.push('The master is less than 1 mm tall.');

  const result: PourBox = {
    base: meshOf(baseM),
    sleeve: meshOf(sleeveM),
    ...(pin ? { pin } : {}),
    report: {
      fillHeightMm: +(fillZ - zMin).toFixed(2),
      fillZMm: +fillZ.toFixed(3),
      pourDepthMm: +(fillZ - (clear > 0 ? sleeveBottom : zMin)).toFixed(2),
      sleeveHeightMm: +(sleeveTop - sleeveBottom).toFixed(2),
      sleeveFootprintMm: extent(outer),
      baseFootprintMm: extent(baseOutline),
      siliconeMm3: Math.round(siliconeMm3),
      siliconeG: Math.round(grams),
      partAG: Math.round((grams * s.ratioA) / (s.ratioA + s.ratioB)),
      partBG: Math.round((grams * s.ratioB) / (s.ratioA + s.ratioB)),
      siliconeName: s.name,
      ...(pin ? { pinTopMm: [+topAt[0].toFixed(2), +topAt[1].toFixed(2), +(fillZ + 1).toFixed(2)] as [number, number, number] } : {}),
      warnings,
    },
  };
  for (const x of [plan, inner, outer, grooveOuter, grooveInner, baseOutline, ring, grooveRing]) x.delete();
  for (const x of [sleeveM, plate, grooveCut, baseM]) x.delete();
  return result;
}
