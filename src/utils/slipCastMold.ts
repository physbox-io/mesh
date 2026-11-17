// ---------------------------------------------------------------------------
// A plaster mold for slip casting, and the printed cases that make it
// ---------------------------------------------------------------------------
//
// Slip casting pours liquid clay into a plaster mold; the plaster drinks the
// water, a wall of clay builds up on the cavity, and the rest is poured back
// out. So the mold is only ever the part's outside, open at the top through a
// spare (the reservoir that keeps the level up while the wall builds), and the
// inside of a vessel is slip, not plaster.
//
// The mold is n pieces round the pour axis:
//   sides — k wedges (2-6) split by half-planes through the spare's centre, each
//           pulled straight out along its own bisector. Registered by conical
//           natches, steep enough to release along that pull.
//   base  — optional: a tapered plug under the part, pulled down. It centres
//           itself in the sides by its taper, so it needs no natches.
// The number of sides and the angle of the split are chosen by measuring the
// part's surface: the fewest sides that leave no face looking away from the
// piece that has to pull off it.
//
// What is printed is not the plaster but a case for each piece: an open box
// whose inside is that piece, the part's surface standing up off its floor.
// Fill a case with plaster to the brim, and the piece comes out of it. Every
// case is handed back stood as it prints, its open face up.
//
// All lengths are millimetres in the world frame, Z up, the part as it stands
// (its opening up). The part is grown by the clay's shrink first, so the fired
// piece comes out the size it was modelled.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { buildPartManifold } from './moldManifold';
import { printedMeshOf } from './printedMesh';
import { castMaterial, castWeightG, mixGrams, type CastMaterialId } from './castMaterials';

export interface SlipMoldOptions {
  /** Side pieces round the pour axis, 2-6, or 'auto' for the fewest that release the part. */
  sides: number | 'auto';
  /**
   * A separate tapered base plug under the part, or 'auto': one when the part
   * stands on a foot, none when it stands on a point or an edge, where a plug
   * would only be an extra piece.
   */
  base: boolean | 'auto';
  /** Plaster round the cavity at its thinnest, mm. Thicker plaster drinks more slip before it is saturated. */
  plasterMm: number;
  /** Plaster powder to hand, g: the plaster is made as thick as this allows (overrides plasterMm). */
  plasterBudgetG?: number | null;
  /** Spare (reservoir) height above the part, mm. */
  spareHeightMm: number;
  /** The spare's narrowest mouth, mm: a part narrower at the top than this gets a funnel. */
  spareDiaMm: number;
  /**
   * Where the spare goes, in plan, mm, world frame: the inside whose mouth
   * holds the point, else the part's top there. Null: over the largest
   * inside's mouth, or the part's top when nothing is filled.
   */
  spareAtMm?: [number, number] | null;
  /** Whatever is enclosed in plan (the inside of a vessel) is cavity, so no plaster core is left in it. */
  fillInside: boolean;
  /** Linear shrink of the clay from wet to fired, %; null for the clay's own. */
  shrinkPercent: number | null;
  /** Printed case wall, mm. */
  caseWallMm: number;
  /** Case wall standing past the plaster's back, so a brimming pour does not spill, mm. */
  freeboardMm: number;
  /** Natch base diameter, mm. */
  natchDiaMm: number;
  /** The base plug's taper, degrees from vertical. */
  baseTaperDeg: number;
  /**
   * Draft on the part's walls, degrees, each piece's own way: walls lean in
   * away from the parting lines, so every side piece draws off along its
   * pull. The parting lines keep their size, so the pieces still meet.
   */
  draftDeg: number;
  /**
   * Split each side piece's printed case into a seamless pattern base, two
   * U-shaped wall halves split at the middle of the long edges, and two
   * sliding dovetail clips, so the walls unclip and slide off sideways rather
   * than locking onto set plaster.
   */
  splitCase: boolean;
  /** The clay body. */
  slip: CastMaterialId;
}

export const DEFAULT_SLIP_MOLD_OPTIONS: SlipMoldOptions = {
  sides: 'auto',
  base: 'auto',
  plasterMm: 25,
  spareHeightMm: 25,
  spareDiaMm: 30,
  fillInside: true,
  shrinkPercent: null,
  caseWallMm: 2.4,
  freeboardMm: 4,
  natchDiaMm: 14,
  baseTaperDeg: 10,
  draftDeg: 0,
  splitCase: true,
  slip: 'porcelain-slip',
};

/** The least share of the part's volume an inside must hold to take the spare and be warned of. */
const INSIDE_SHARE = 0.1;

/** The largest number of side pieces 'auto' tries, and the field takes. */
export const MAX_SLIP_SIDES = 6;

/** Plaster thickness: the least the planner takes, the least a budget thins it to, and the most, mm. */
export const MIN_PLASTER_MM = 5;
export const BUDGET_FLOOR_MM = 10;
export const MAX_PLASTER_MM = 60;

/** An indexed mesh, millimetres, Z up. */
export interface SlipMesh {
  positions: number[];
  faces: number[];
}

export type SlipCasePartRole = 'case' | 'base' | 'wall' | 'clip';

/** One printable part of a piece's plaster-casting case, stood on Z = 0. */
export interface SlipCasePart {
  /** File-safe suffix: 'case' (one-piece), or 'base', 'wall1', 'wall2', 'clip1', 'clip2'. */
  key: string;
  /** Human-readable part label. */
  label: string;
  role: SlipCasePartRole;
  /** Centred in plan on Z = 0, ready to print on its own. */
  mesh: SlipMesh;
  /** In its assembled pose on Z = 0 round the pattern base. */
  assembled: SlipMesh;
  /** Unit vector this part moves along to disassemble ([0,0,1] for clips, ±slide for walls, [0,0,0] for base). */
  release: [number, number, number];
  sizeMm: [number, number, number];
}

export interface SlipPiece {
  /** 'side 1' … or 'base'. */
  name: string;
  /** The plaster piece, in place round the part. */
  plaster: SlipMesh;
  /** Its printed case, in place: overlapping its neighbours' cases, as they never stand together. */
  caseInPlace: SlipMesh;
  /** The one-piece case stood as it prints: open face up, on Z = 0, centred on the origin in plan. */
  casePrint: SlipMesh;
  /** The printable parts of the case: [base, wall1, wall2, clip1, clip2] when split, [case] otherwise. */
  caseParts: SlipCasePart[];
  /** Which way the piece pulls off the casting, a unit vector. */
  pull: [number, number, number];
  plasterMm3: number;
  /** Assembled case footprint and height as it stands on the bench, mm. */
  caseSizeMm: [number, number, number];
  /** Part surface facing away from this piece's pull, mm²: it would lock the piece on. */
  undercutMm2: number;
  /** Natches on this piece: bumps and dimples. */
  natches: { bumps: number; dimples: number };
}

export interface SlipMoldReport {
  sides: number;
  base: boolean;
  /** Whether side cases are split into a pattern base, two wall halves, and sliding clips. */
  splitCase: boolean;
  /** The split's turn about Z, degrees: the first parting half-plane's direction. */
  splitDeg: number;
  /** Where the pour axis is, in plan, mm. */
  axisMm: [number, number];
  /** How much the part was grown for shrink, about `footMm`. */
  scale: number;
  /** The middle of the part's foot, as it stands, mm: where the growth is centred. */
  footMm: [number, number, number];
  /** The top of the part (grown) in the mold, mm: the spare above it is trimmed off a casting. */
  partTopMm: number;
  /** Where the spare stands: its axis in plan and the height of the mouth it feeds, mm. */
  spareAtMm: [number, number, number];
  /** Draft on the part's walls, each piece's own way, degrees. */
  draftDeg: number;
  shrinkPercent: number;
  blockMm: [number, number, number];
  /** Slip to fill the cavity and spare, ml. */
  slipMl: number;
  plasterMm3: number;
  /** The plaster round the cavity at its thinnest, as planned, mm (a budget sets it). */
  plasterMm: number;
  /** Mixed plaster for all the pieces, grams of powder and of water (100:70). */
  plasterPowderG: number;
  plasterWaterG: number;
  /** Total part surface facing away from the piece that pulls off it, mm². */
  undercutMm2: number;
  slipName: string;
  warnings: string[];
}

export interface SlipMold {
  pieces: SlipPiece[];
  /** The clay it was planned for. */
  slip: CastMaterialId;
  /** The cavity, spare included, grown for shrink: what the slip fills. */
  cavity: SlipMesh;
  /** The spare less the part standing in it: what is trimmed off a casting. */
  spare: SlipMesh;
  report: SlipMoldReport;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

type Vec2 = [number, number];

function meshOf(m: Manifold): SlipMesh {
  // Without the slivers booleans leave along their seams (see printedMesh.ts).
  return printedMeshOf(m);
}

/** Signed area of a 2D contour. */
function contourArea(c: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Whether a point is inside a region given as contours, by nonzero winding. */
function insideContours(contours: readonly (readonly Vec2[])[], x: number, y: number): boolean {
  let wind = 0;
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const [ax, ay] = c[i], [bx, by] = c[(i + 1) % c.length];
      if (ay <= y) {
        if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) wind++;
      } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) wind--;
    }
  }
  return wind !== 0;
}

/**
 * WASM objects done with, freed when the mold is finished. Not at once:
 * Manifold evaluates booleans and transforms lazily, so a result still holds
 * its operands, and freeing one before the result is read crashes the WASM.
 */
let bin: (Manifold | CrossSection)[] | null = null;

function free(...objs: (Manifold | CrossSection | null | undefined)[]) {
  for (const o of objs) {
    if (!o) continue;
    if (bin) bin.push(o);
    else try { o.delete(); } catch { /* already freed */ }
  }
}

function emptyBin() {
  const objs = new Set(bin ?? []);
  bin = null;
  for (const o of objs) {
    try { o.delete(); } catch { /* already freed */ }
  }
}

/** The largest connected lump of a solid, and the volume of the rest. */
function largestLump(m: Manifold): { lump: Manifold; droppedMm3: number } {
  const parts = m.decompose();
  if (parts.length <= 1) {
    free(...parts);
    return { lump: m, droppedMm3: 0 };
  }
  let best = 0, bestVol = -Infinity, dropped = 0;
  const vols = parts.map((p) => p.volume());
  vols.forEach((v, i) => { if (v > bestVol) { bestVol = v; best = i; } });
  vols.forEach((v, i) => { if (i !== best) dropped += v; });
  parts.forEach((p, i) => { if (i !== best) free(p); });
  free(m);
  return { lump: parts[best], droppedMm3: dropped };
}

// ---------------------------------------------------------------------------
// The cavity: the part, its inside filled, and the spare
// ---------------------------------------------------------------------------

/**
 * The inside of a vessel, as cavity: at each height, the holes in the part's
 * plan that open upward to the top, the way slip poured in at the top reaches
 * them. A recess under a foot is a hole in plan too, but it is roofed over by
 * the part, so it stays plaster (the base plug takes it).
 *
 * Each slab is its reachable holes grown well into the wall (so no skin of
 * plaster is left against a sloping inner wall), held inside the part's
 * outline at that height and both neighbours (so it never pokes out through a
 * sloping outer wall). The overlap with the wall is cavity anyway.
 */
function insideFill(wasm: ManifoldToplevel, part: Manifold, zMin: number, zTop: number): Manifold | null {
  const height = zTop - zMin;
  // A whole number of steps to the top: a fill that stops short of the rim
  // leaves a shallow dish there whose inner wall locks the side pieces on.
  const n = Math.max(1, Math.round(height / Math.min(1.5, Math.max(0.5, height / 150))));
  const dz = height / n;
  const pb = part.boundingBox();
  const pad = 10;
  const sheet = wasm.CrossSection.square([pb.max[0] - pb.min[0] + 2 * pad, pb.max[1] - pb.min[1] + 2 * pad]).translate([pb.min[0] - pad, pb.min[1] - pad]);
  /** Per slice: each outline (outer contour) on its own, and whether a reachable hole is in it. */
  const outlines: { shape: CrossSection; filled: boolean }[][] = new Array(n);
  // Air reachable from above, slice by slice from the top down.
  let reach: CrossSection = sheet;
  for (let k = n - 1; k >= 0; k--) {
    const cs = part.slice(zMin + (k + 0.5) * dz);
    const polys = cs.toPolygons();
    const outs = polys.filter((c) => contourArea(c) > 0);
    const air = sheet.subtract(cs);
    const kept: CrossSection[] = [];
    for (const piece of air.decompose()) {
      const meet = piece.intersect(reach);
      if (meet.area() > 1e-3) kept.push(piece);
      else free(piece);
      free(meet);
    }
    free(cs, air);
    const next = kept.length ? wasm.CrossSection.union(kept) : wasm.CrossSection.square(0);
    free(...kept);
    if (reach !== sheet) free(reach);
    reach = next;
    // A hole is reachable when the reachable air has a piece inside it; its
    // outline is then filled whole.
    const holeContours = outs.length < polys.length ? next.toPolygons() : [];
    outlines[k] = outs.map((c) => {
      const shape = wasm.CrossSection.ofPolygons([c], 'Positive').simplify(0.02);
      const filled = holeContours.some((h) => contourArea(h) > 1e-3 && h.every((p) => insideContours([c], p[0], p[1])));
      return { shape, filled };
    });
  }
  const filledAt = (k: number) => (outlines[k] ?? []).filter((o) => o.filled).map((o) => o.shape);
  const allAt = (k: number) => (outlines[k] ?? []).map((o) => o.shape);
  const slabs: Manifold[] = [];
  for (let k = 0; k < n; k++) {
    const own = filledAt(k);
    const near = own.length ? own : [...filledAt(k - 1), ...filledAt(k + 1)].length ? allAt(k) : [];
    if (!near.length) continue;
    // Held inside the part's outline at the slices either side too.
    let region = wasm.CrossSection.union(near);
    for (const j of [k - 1, k + 1]) {
      const around = allAt(j);
      if (!around.length) continue;
      const u = wasm.CrossSection.union(around);
      const clipped = region.intersect(u);
      free(region, u);
      region = clipped;
    }
    // A hair taller than the step, so neighbours overlap and fuse rather than
    // touch, which leaves zero-thick sheets in the plaster.
    if (!region.isEmpty()) slabs.push(region.extrude(dz + 0.02).translate([0, 0, zMin + k * dz - 0.01]));
    free(region);
  }
  free(...outlines.flat().map((o) => o.shape), sheet, reach);
  if (!slabs.length) return null;
  const fill = wasm.Manifold.union(slabs);
  free(...slabs);
  return fill;
}

const fmtMm = (p: readonly number[]) => `(${p.map((v) => v.toFixed(0)).join(', ')} mm)`;

interface SpareChoice {
  spare: Manifold;
  centre: [number, number];
  /** The height the spare stands on: the mouth it feeds, mm. */
  footZ: number;
  warnings: string[];
}

/**
 * The spare: from the outline of the opening it feeds up to the mold's top
 * face, widening to at least `diaMm` across, so the slip has a mouth to go in
 * by and enough above the part to keep the level up.
 *
 * It feeds an opening, not the highest point. The slip has to drain back out
 * of the inside through the spare, so with an inside filled (`inside`, the
 * reachable inside of a vessel, less the part) it stands on the mouth of the largest inside;
 * any other inside is warned of, since plaster roofs it over and it casts
 * solid. With nothing filled it stands on the part's top. `at` (plan, mm)
 * picks the inside whose mouth holds that point, or else the part's top
 * surface there.
 */
function spare(
  wasm: ManifoldToplevel, filled: Manifold, inside: Manifold | null, zTop: number, zBlockTop: number, diaMm: number, at: [number, number] | null,
  partMm3: number,
): SpareChoice {
  const e = 0.5;
  const warnings: string[] = [];
  // An inside worth draining holds a real share of the part: a gap between
  // an arm and a body is open from above too, and is cast as clay.
  const all = inside ? inside.decompose() : [];
  const insides = all.filter((c) => c.volume() > Math.max(1, INSIDE_SHARE * partMm3));
  free(...all.filter((c) => !insides.includes(c)));
  // The mouth: the highest height where the inside is whole, not where the
  // fill's step leaves slivers above a rim that opens on one side - a slice
  // there is most of the one 3 mm below it.
  const mouthOf = (c: Manifold) => {
    const cb = c.boundingBox();
    let z = cb.max[2];
    for (; z > cb.min[2] + 3; z -= 0.5) {
      const here = c.slice(z - e), below = c.slice(z - e - 3);
      const ok = here.area() >= 0.6 * below.area();
      free(here, below);
      if (ok) break;
    }
    const cs = c.slice(z - e);
    return { z, cs, polys: cs.toPolygons() };
  };
  const mouths = insides.map(mouthOf);

  let chosen = -1;
  let footZ: number;
  let foot: CrossSection;
  if (at) {
    chosen = mouths.findIndex((m) => insideContours(m.polys, at[0], at[1]));
  } else if (insides.length) {
    insides.forEach((c, i) => { if (chosen < 0 || c.volume() > insides[chosen].volume()) chosen = i; });
  }
  /** The part's outline pieces at a height that a test keeps, hulled. */
  const outlineAt = (z: number, keep: (piece: CrossSection) => boolean): CrossSection | null => {
    const cs = filled.slice(z);
    const pieces = cs.decompose();
    const kept = pieces.filter(keep);
    free(cs, ...pieces.filter((p) => !kept.includes(p)));
    if (!kept.length) return null;
    const u = wasm.CrossSection.union(kept);
    const h = u.hull();
    free(u, ...kept);
    return h;
  };
  let centredAt: [number, number] | null = null;
  if (chosen >= 0) {
    const m = mouths[chosen];
    footZ = m.z;
    // On the mouth itself, where the rim first closes round the inside: a
    // rim that rises higher on one side (a spout, a slanted lip) keeps its
    // plaster outside, and casts against it.
    foot = m.cs.hull();
  } else if (at) {
    const b = filled.boundingBox();
    const col = wasm.Manifold.cylinder(b.max[2] - b.min[2] + 2, 0.5, 0.5, 12).translate([at[0], at[1], b.min[2] - 1]);
    const hit = filled.intersect(col);
    free(col);
    if (hit.isEmpty()) {
      free(hit);
      throw new Error(`The spare position ${fmtMm(at)} is not over the part.`);
    }
    footZ = hit.boundingBox().max[2];
    free(hit);
    // Centred on the point asked for, as wide as the spare's mouth where the part allows.
    const piece = outlineAt(footZ - e, (pc) => insideContours(pc.toPolygons(), at[0], at[1]));
    const disc = wasm.CrossSection.circle(diaMm / 2, 64).translate(at);
    foot = piece ? piece.intersect(disc) : wasm.CrossSection.circle(0.5, 16).translate(at);
    free(piece, disc);
    centredAt = at;
  } else {
    // On a pointed or domed top (a pyramid, cone, sphere), a slice 0.5 mm below
    // the apex is a 1 mm pinhole that barely touches the part and seals shut as
    // soon as clay builds on it. Walk down until the slice is wide enough to
    // pour and drain slip through (up to 40 % down the part).
    const b = filled.boundingBox();
    const minThroat = Math.min(diaMm, 20);
    const floorLimit = b.min[2] + 0.6 * (zTop - b.min[2]);
    let bestZ = zTop - e;
    for (let z = zTop - e; z >= floorLimit; z -= 1) {
      const cs = filled.slice(z);
      const h = cs.hull();
      const hb = h.bounds();
      const span = Math.min(hb.max[0] - hb.min[0], hb.max[1] - hb.min[1]);
      free(cs, h);
      bestZ = z;
      if (span >= minThroat) break;
    }
    footZ = bestZ + e;
    const top = filled.slice(bestZ);
    foot = top.hull();
    free(top);
  }

  let cx: number, cy: number;
  if (centredAt) {
    [cx, cy] = centredAt;
  } else if (foot.area() < 0.5) {
    const fb = foot.bounds();
    cx = (fb.min[0] + fb.max[0]) / 2; cy = (fb.min[1] + fb.max[1]) / 2;
    free(foot);
    foot = wasm.CrossSection.circle(0.5, 16).translate([cx, cy]);
  } else {
    // The area-weighted middle of the foot's outline.
    let ax = 0, ay = 0, aa = 0;
    for (const c of foot.toPolygons()) {
      for (let i = 0; i < c.length; i++) {
        const p = c[i], q = c[(i + 1) % c.length];
        const cross = p[0] * q[1] - q[0] * p[1];
        aa += cross; ax += (p[0] + q[0]) * cross; ay += (p[1] + q[1]) * cross;
      }
    }
    cx = ax / (3 * aa); cy = ay / (3 * aa);
  }
  const mouthCircle = wasm.CrossSection.circle(diaMm / 2, 64).translate([cx, cy]);
  const mouth = wasm.CrossSection.hull([foot, mouthCircle]);
  const bottomSlab = foot.extrude(0.01).translate([0, 0, footZ - e]);
  const topSlab = mouth.extrude(1).translate([0, 0, zBlockTop]);
  const s = wasm.Manifold.hull([bottomSlab, topSlab]);
  free(foot, mouthCircle, mouth, bottomSlab, topSlab);

  // Every inside the spare does not reach is roofed in plaster: the slip in
  // it cannot pour out, and it casts solid.
  mouths.forEach((m, i) => {
    if (i === chosen) return;
    const meet = s.intersect(insides[i]);
    const reached = meet.volume() > 1;
    free(meet);
    if (reached) return;
    const mb = m.cs.bounds();
    warnings.push(`The opening at ${fmtMm([(mb.min[0] + mb.max[0]) / 2, (mb.min[1] + mb.max[1]) / 2, m.z])} is roofed in plaster away from the spare: its slip can only leave through the part, and it casts solid if that way closes. Put the spare over it, or turn the part.`);
  });
  // Part standing up inside the spare is cut off with it.
  const above = wasm.Manifold.cube([1e5, 1e5, zBlockTop - footZ + 2]).translate([-5e4, -5e4, footZ + 1]);
  const rising = filled.intersect(s).intersect(above);
  if (rising.volume() > 1) {
    const rb = rising.boundingBox();
    warnings.push(`The part rises into the spare at ${fmtMm([(rb.min[0] + rb.max[0]) / 2, (rb.min[1] + rb.max[1]) / 2, rb.max[2]])}: it is trimmed off with the spare and does not cast there. Lower it, or move the spare.`);
  }
  free(above, rising, ...insides, ...mouths.map((m) => m.cs));
  return { spare: s, centre: [cx, cy], footZ, warnings };
}

// ---------------------------------------------------------------------------
// Choosing the split
// ---------------------------------------------------------------------------

interface SurfaceSample {
  /** Centroid, mm. */
  x: number; y: number; z: number;
  /** Unit outward normal. */
  nx: number; ny: number; nz: number;
  area: number;
}

function surfaceSamples(m: Manifold): SurfaceSample[] {
  const mesh = m.getMesh();
  const p = mesh.vertProperties, s = mesh.numProp, t = mesh.triVerts;
  const out: SurfaceSample[] = [];
  for (let f = 0; f < t.length; f += 3) {
    const a = t[f] * s, b = t[f + 1] * s, c = t[f + 2] * s;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    out.push({
      x: (p[a] + p[b] + p[c]) / 3, y: (p[a + 1] + p[b + 1] + p[c + 1]) / 3, z: (p[a + 2] + p[b + 2] + p[c + 2]) / 3,
      nx: nx / len, ny: ny / len, nz: nz / len, area: len / 2,
    });
  }
  return out;
}

/** A face turned further from its piece's pull than this (as a cosine) locks the piece on. */
const UNDERCUT_COS = -0.02;

interface Split {
  sides: number;
  /** Radians: the first parting half-plane's direction. */
  theta: number;
  /** Undercut area per side piece, then the base's, mm². */
  undercut: number[];
  total: number;
}

/**
 * The surface each piece pulls off, and what of it faces away. A face goes to
 * the base when there is one, it faces down and it is over the plug; to the
 * side wedge its centroid is in otherwise.
 */
function scoreSplit(
  samples: SurfaceSample[], axis: [number, number], sides: number, theta: number,
  overBase: ((s: SurfaceSample) => boolean) | null,
): Split {
  const undercut = new Array<number>(sides + 1).fill(0);
  const wedge = (2 * Math.PI) / sides;
  for (const s of samples) {
    if (overBase && s.nz < -0.3 && overBase(s)) {
      if (-s.nz < UNDERCUT_COS) undercut[sides] += s.area;
      continue;
    }
    let a = Math.atan2(s.y - axis[1], s.x - axis[0]) - theta;
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const j = Math.min(sides - 1, Math.floor(a / wedge));
    const bis = theta + (j + 0.5) * wedge;
    const dot = s.nx * Math.cos(bis) + s.ny * Math.sin(bis);
    if (dot < UNDERCUT_COS) undercut[j] += s.area;
  }
  return { sides, theta, undercut, total: undercut.reduce((x, y) => x + y, 0) };
}

/** The best turn of the split for a number of sides: least undercut, every 2°. */
function bestTurn(samples: SurfaceSample[], axis: [number, number], sides: number, overBase: ((s: SurfaceSample) => boolean) | null): Split {
  const span = (2 * Math.PI) / sides;
  let best: Split | null = null;
  for (let deg = 0; deg * DEG < span - 1e-9; deg += 2) {
    const s = scoreSplit(samples, axis, sides, deg * DEG, overBase);
    if (!best || s.total < best.total - 1e-6) best = s;
  }
  return best!;
}

/**
 * The fewest sides that leave no more than a trace of undercut (0.2% of the
 * surface, which is facet noise), else the sides with the least.
 */
export function chooseSplit(
  samples: SurfaceSample[], axis: [number, number], sides: number | 'auto',
  overBase: ((s: SurfaceSample) => boolean) | null,
): Split {
  if (sides !== 'auto') return bestTurn(samples, axis, Math.max(2, Math.min(MAX_SLIP_SIDES, Math.round(sides))), overBase);
  const area = samples.reduce((a, s) => a + s.area, 0);
  let least: Split | null = null;
  for (let k = 2; k <= MAX_SLIP_SIDES; k++) {
    const s = bestTurn(samples, axis, k, overBase);
    if (s.total <= area * 0.002) return s;
    // More pieces must earn their keep: a quarter less undercut each.
    if (!least || s.total < least.total * 0.75) least = s;
  }
  return least!;
}

/**
 * Splits every triangle that crosses one of the vertical planes through
 * (cx, cy) with these directions, at points shared by the triangles either
 * side of each edge, so the mesh stays closed and has vertices on the planes.
 * Booleans will not do this: Manifold merges a cut that is fused again back
 * into the faces it came from.
 */
export function splitByVerticalPlanes(
  positions: number[], faces: number[], c: [number, number], angles: number[],
): { positions: number[]; faces: number[] } {
  const P = positions.slice();
  let F = faces.slice();
  for (const a of angles) {
    // The plane's normal in plan.
    const nx = -Math.sin(a), ny = Math.cos(a);
    const side = (i: number) => (P[i * 3] - c[0]) * nx + (P[i * 3 + 1] - c[1]) * ny;
    const nv = P.length / 3;
    const d = new Float64Array(nv);
    let scale = 0;
    for (let i = 0; i < nv; i++) { d[i] = side(i); scale = Math.max(scale, Math.abs(d[i])); }
    const eps = 1e-9 * Math.max(1, scale);
    const sgn = (i: number) => (d[i] > eps ? 1 : d[i] < -eps ? -1 : 0);
    const cut = new Map<string, number>();
    const cross = (i: number, j: number) => {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      let v = cut.get(key);
      if (v === undefined) {
        const t = d[i] / (d[i] - d[j]);
        v = P.length / 3;
        P.push(P[i * 3] + (P[j * 3] - P[i * 3]) * t, P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * t, P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * t);
        cut.set(key, v);
      }
      return v;
    };
    const out: number[] = [];
    for (let f = 0; f < F.length; f += 3) {
      const t = [F[f], F[f + 1], F[f + 2]];
      const s3 = t.map(sgn);
      const pos = s3.filter((x) => x > 0).length, neg = s3.filter((x) => x < 0).length;
      if (!pos || !neg) { out.push(...t); continue; }
      // Rotate so the lone vertex (or the one on the plane) comes first.
      const r = pos + neg === 3 ? s3.indexOf(pos === 1 ? 1 : -1) : s3.indexOf(0);
      const [A, B, C] = [t[r], t[(r + 1) % 3], t[(r + 2) % 3]];
      if (pos + neg === 3) {
        const ab = cross(A, B), ac = cross(A, C);
        out.push(A, ab, ac, ab, B, C, ab, C, ac);
      } else {
        // A on the plane, B and C either side.
        const bc = cross(B, C);
        out.push(A, B, bc, A, bc, C);
      }
    }
    F = out;
  }
  return { positions: P, faces: F };
}

/**
 * Draft for side pieces that each pull a different way: the part's walls,
 * tapered so each draws off along its own piece's pull. A vertex in side j
 * moves within the plane square to that side's pull, by h·tanθ, inward, where
 * h is its distance from the nearest parting half-plane of its side; so the
 * parting lines keep their size and neighbouring sides still meet, and a wall
 * leans away from the line it was cast against. Which way it moves is a miter
 * of the walls round it, as castPrep's draftTriangles does for a single pull;
 * faces turned within 3° of the pull, the rim (faces looking up within 2 mm
 * of the top) and the underside over the base plug have no say.
 */
function draftForPieces(
  wasm: ManifoldToplevel, m: Manifold, axis: [number, number], sides: number, theta: number, deg: number,
  overBase: ((x: number, y: number, nz: number) => boolean) | null,
): Manifold {
  // Vertices on every parting line first, so the draft can leave them there.
  const raw = meshOf(m);
  const wedgeAngles: number[] = [];
  for (let j = 0; j < sides; j++) {
    const a = theta + j * ((2 * Math.PI) / sides);
    if (!wedgeAngles.some((b) => Math.abs(Math.sin(a - b)) < 1e-9)) wedgeAngles.push(a);
  }
  const split = splitByVerticalPlanes(raw.positions, raw.faces, axis, wedgeAngles);
  const P = Float64Array.from(split.positions);
  const T = Uint32Array.from(split.faces);
  const stride = 3;
  const nv = P.length / 3;
  const wedge = (2 * Math.PI) / sides;
  const sectorOf = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    let a = Math.atan2(P[i * 3 + 1] - axis[1], P[i * 3] - axis[0]) - theta;
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    sectorOf[i] = Math.min(sides - 1, Math.floor(a / wedge));
  }
  let top = -Infinity;
  for (let i = 0; i < nv; i++) top = Math.max(top, P[i * 3 + 2]);
  const rimZ = top - 2;
  // Per vertex, in its side's frame (e1 horizontal along the parting, e2 = +Z):
  // Σ ĥĥᵀ and Σ ĥ of the walls round it.
  const acc = new Float64Array(nv * 5);
  const FLAT = Math.sin(3 * DEG);
  for (let f = 0; f < T.length; f += 3) {
    const ia = T[f] * 3, ib = T[f + 1] * 3, ic = T[f + 2] * 3;
    const ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2];
    const vx = P[ic] - P[ia], vy = P[ic + 1] - P[ia + 1], vz = P[ic + 2] - P[ia + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    nx /= len; ny /= len; nz /= len;
    // The rim has no say: drafted down away from the parting, it folds its
    // edge over the wall below it, and the spare is over it anyway.
    if (nz > 0.7 && (P[ia + 2] + P[ib + 2] + P[ic + 2]) / 3 > rimZ) continue;
    if (overBase && nz < -0.3 && overBase((P[ia] + P[ib] + P[ic]) / 3, (P[ia + 1] + P[ib + 1] + P[ic + 1]) / 3, nz)) continue;
    for (let q = 0; q < 3; q++) {
      const v = T[f + q];
      const bis = theta + (sectorOf[v] + 0.5) * wedge;
      // e1 = (-sin, cos, 0) square to the pull in plan; e2 = z.
      const a1 = -nx * Math.sin(bis) + ny * Math.cos(bis), a2 = nz;
      const hl = Math.hypot(a1, a2);
      if (hl < FLAT) continue;
      const h1 = a1 / hl, h2 = a2 / hl;
      const o = v * 5;
      acc[o] += h1 * h1; acc[o + 1] += h1 * h2; acc[o + 2] += h2 * h2;
      acc[o + 3] += h1; acc[o + 4] += h2;
    }
  }
  const tan = Math.tan(deg * DEG);
  const out = Float32Array.from(P);
  for (let i = 0; i < nv; i++) {
    const o = i * 5;
    const a11 = acc[o], a12 = acc[o + 1], a22 = acc[o + 2], b1 = acc[o + 3], b2 = acc[o + 4];
    const trace = a11 + a22;
    if (trace === 0) continue;
    let d1: number, d2: number;
    const det = a11 * a22 - a12 * a12;
    if (det > 1e-6 * trace * trace) { d1 = (a22 * b1 - a12 * b2) / det; d2 = (a11 * b2 - a12 * b1) / det; }
    else { d1 = b1 / trace; d2 = b2 / trace; }
    const dl = Math.hypot(d1, d2);
    if (dl > 2) { d1 *= 2 / dl; d2 *= 2 / dl; }
    // Distance from the nearer of this side's two parting half-planes.
    const j = sectorOf[i];
    const px = P[i * 3] - axis[0], py = P[i * 3 + 1] - axis[1];
    let h = Infinity;
    for (const b of [theta + j * wedge, theta + (j + 1) * wedge]) {
      const bx = Math.cos(b), by = Math.sin(b);
      const along = px * bx + py * by;
      h = Math.min(h, along >= 0 ? Math.abs(px * by - py * bx) : Math.hypot(px, py));
    }
    const bis = theta + (j + 0.5) * wedge;
    const shift = -h * tan;
    out[i * stride] += -Math.sin(bis) * d1 * shift;
    out[i * stride + 1] += Math.cos(bis) * d1 * shift;
    out[i * stride + 2] += d2 * shift;
  }
  const drafted = new wasm.Mesh({ numProp: stride, vertProperties: out, triVerts: T });
  drafted.merge();
  const result = new wasm.Manifold(drafted);
  if (result.status() !== 'NoError') {
    free(result);
    throw new Error(`The part does not take ${deg}° of draft: its walls would cross. Try less.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The mold
// ---------------------------------------------------------------------------

/** A convex polygon from half-planes (p - c)·d_j <= a_j, as a CrossSection, by clipping a big square. */
function halfPlanePolygon(wasm: ManifoldToplevel, c: [number, number], planes: { d: [number, number]; a: number }[], big: number): CrossSection {
  let poly: Vec2[] = [[c[0] - big, c[1] - big], [c[0] + big, c[1] - big], [c[0] + big, c[1] + big], [c[0] - big, c[1] + big]];
  for (const { d, a } of planes) {
    const f = (p: Vec2) => (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1] - a;
    const next: Vec2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const fp = f(p), fq = f(q);
      if (fp <= 0) next.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
        const t = fp / (fp - fq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    poly = next;
  }
  return wasm.CrossSection.ofPolygons([poly], 'Positive');
}

/**
 * Side j's wedge of k round c, from parting half-plane j to j+1 (half-plane
 * k is half-plane 0), reaching `big` out. Each half-plane's direction is
 * worked out from its index mod k, so neighbouring wedges share an edge to
 * the last bit: theta and theta + 2π are not the same float, and an edge a
 * hair off leaves a membrane between the pieces.
 */
function wedgePolygon(wasm: ManifoldToplevel, c: [number, number], theta: number, k: number, j: number, big: number): CrossSection {
  const wedge = (2 * Math.PI) / k;
  const edge = (i: number): Vec2 => {
    const a = theta + (i % k) * wedge;
    return [c[0] + big * Math.cos(a), c[1] + big * Math.sin(a)];
  };
  const pts: Vec2[] = [[c[0], c[1]], edge(j)];
  const steps = Math.max(2, Math.ceil(wedge / (Math.PI / 8)));
  for (let i = 1; i < steps; i++) {
    const a = theta + j * wedge + (wedge * i) / steps;
    pts.push([c[0] + big * Math.cos(a), c[1] + big * Math.sin(a)]);
  }
  pts.push(edge(j + 1));
  return wasm.CrossSection.ofPolygons([pts], 'Positive');
}

/**
 * The case that casts a plaster piece: a box round the piece, its inside the
 * piece, open on the face the piece pulls out through, standing `freeboard`
 * past it, and flat underneath so it stands on the bed.
 */
function caseFor(
  wasm: ManifoldToplevel, piece: Manifold, pull: [number, number, number], backOffset: number,
  wall: number, freeboard: number,
): Manifold {
  const hull = piece.hull();
  const lifted = hull.translate([pull[0] * freeboard, pull[1] * freeboard, pull[2] * freeboard]);
  const reach = wasm.Manifold.hull([hull, lifted]);
  // Minkowski with a cube: the hull of its eight corner-shifted copies.
  const corners: Manifold[] = [];
  for (const sx of [-wall, wall]) for (const sy of [-wall, wall]) for (const sz of [-wall, wall]) corners.push(reach.translate([sx, sy, sz]));
  // Flat underneath: the far side squared off to a plane square to the pull,
  // so a wedge's case stands on a face rather than on its ridge.
  const box = wasm.Manifold.hull(corners);
  const verts = box.getMesh();
  let lo = Infinity;
  for (let i = 0; i < verts.numVert; i++) {
    const o = i * verts.numProp;
    lo = Math.min(lo, verts.vertProperties[o] * pull[0] + verts.vertProperties[o + 1] * pull[1] + verts.vertProperties[o + 2] * pull[2]);
  }
  const flat: Manifold[] = [box];
  const pts: [number, number, number][] = [];
  for (let i = 0; i < verts.numVert; i++) {
    const o = i * verts.numProp;
    const x = verts.vertProperties[o], y = verts.vertProperties[o + 1], z = verts.vertProperties[o + 2];
    const h = x * pull[0] + y * pull[1] + z * pull[2] - lo;
    pts.push([x - pull[0] * h, y - pull[1] * h, z - pull[2] * h]);
  }
  const hulled = wasm.Manifold.hull([...flat, ...pts]);
  // The rim stands `freeboard` past the plaster's back, no more.
  const container = hulled.trimByPlane([-pull[0], -pull[1], -pull[2]], -(backOffset + freeboard));
  free(hulled);
  // Open past the plaster's back: everything of the case the piece would
  // have to pass through on its way out, beyond the back face.
  const sweep = wasm.Manifold.hull([hull, hull.translate([pull[0] * (freeboard + wall + 1), pull[1] * (freeboard + wall + 1), pull[2] * (freeboard + wall + 1)])]);
  const beyond = sweep.trimByPlane([pull[0], pull[1], pull[2]], backOffset - 1e-3);
  const open = container.subtract(piece).subtract(beyond);
  free(hull, lifted, reach, ...corners, box, container, sweep, beyond);
  return open;
}

/** Turns a mesh so `up` points +Z, then sits it on Z = 0 centred in plan. */
function standUp(m: Manifold, up: [number, number, number]): Manifold {
  // Rotation taking `up` to +Z, about the axis up × z.
  const [ux, uy, uz] = up;
  const angle = Math.acos(Math.max(-1, Math.min(1, uz)));
  let turned: Manifold;
  if (angle < 1e-9) turned = m.translate([0, 0, 0]);
  else if (Math.PI - angle < 1e-9) turned = m.rotate([180, 0, 0]);
  else {
    // Axis k = (uy, -ux, 0)/|.|; Rodrigues as a 4x3 column-major matrix.
    const kl = Math.hypot(uy, ux);
    const kx = uy / kl, ky = -ux / kl;
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    const r = [
      t * kx * kx + c, t * kx * ky, -s * ky,
      t * kx * ky, t * ky * ky + c, s * kx,
      s * ky, -s * kx, c,
    ];
    // Manifold's Mat4 is column-major, 16 numbers.
    turned = m.transform([r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1]);
  }
  const b = turned.boundingBox();
  const placed = turned.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
  free(turned);
  return placed;
}

/** Counter-clockwise 2D polygon section. */
function polySection(wasm: ManifoldToplevel, pts: Vec2[]): CrossSection {
  const ccw = contourArea(pts) >= 0 ? pts : [...pts].reverse();
  return wasm.CrossSection.ofPolygons([ccw], 'Positive');
}

/** Extrudes an (X, Z) profile along Y in [y0, y1] with outward winding. */
function extrudeAlongY(wasm: ManifoldToplevel, xz: Vec2[], y0: number, y1: number): Manifold {
  const cs = polySection(wasm, xz);
  const slab = cs.extrude(y1 - y0);
  const rot = slab.rotate([90, 0, 0]);
  const out = rot.translate([0, y1, 0]);
  free(cs, slab, rot);
  return out;
}

/** Extrudes a (Y, Z) profile along X in [x0, x1] with outward winding. */
function extrudeAlongX(wasm: ManifoldToplevel, yz: Vec2[], x0: number, x1: number): Manifold {
  const cs = polySection(wasm, yz);
  const slab = cs.extrude(x1 - x0);
  const r1 = slab.rotate([90, 0, 0]);
  const r2 = r1.rotate([0, 0, 90]);
  const out = r2.translate([x0, 0, 0]);
  free(cs, slab, r1, r2);
  return out;
}

function centredOnBed(m: Manifold): { mesh: SlipMesh; sizeMm: [number, number, number] } {
  const b = m.boundingBox();
  const c = m.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -b.min[2]]);
  const out = meshOf(c);
  free(c);
  return {
    mesh: out,
    sizeMm: [+(b.max[0] - b.min[0]).toFixed(1), +(b.max[1] - b.min[1]).toFixed(1), +(b.max[2] - b.min[2]).toFixed(1)],
  };
}

/**
 * A separable case for a side plaster piece:
 *   - `base`: seamless pattern floor + positive pot/spare + 45° captive V-rails + pry notches;
 *   - `wall1`, `wall2`: U-shaped wall halves split at the middle of the long edges (Y = 0),
 *     with 45° V-grooves that slide onto the base along ±Y, a tongue-and-groove seam seal,
 *     and tapered dovetail flanges;
 *   - `clip1`, `clip2`: vertical C-clips that slide down over the dovetail flanges to wedge
 *     the seam shut during the pour, and tap upward to release set plaster without prying.
 */
function buildSplitSideCase(
  wasm: ManifoldToplevel, piece: Manifold, pull: [number, number, number],
  wall: number, freeboard: number,
): { parts: SlipCasePart[]; sizeMm: [number, number, number]; lumpInCase: Manifold } {
  // Rotate so pull -> +Z, world +Z -> +Y, [-pull_y, pull_x, 0] -> +X (det = +1).
  const pl = Math.hypot(pull[0], pull[1]) || 1;
  const px = pull[0] / pl, py = pull[1] / pl;
  let turned = piece.transform([-py, 0, px, 0, px, 0, py, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
  const b0 = turned.boundingBox();
  if ((b0.max[0] - b0.min[0]) > (b0.max[1] - b0.min[1]) + 1e-6) {
    const r90 = turned.rotate([0, 0, 90]);
    free(turned);
    turned = r90;
  }
  const bb = turned.boundingBox();
  const cx = (bb.min[0] + bb.max[0]) / 2;
  const cy = (bb.min[1] + bb.max[1]) / 2;
  const hx = (bb.max[0] - bb.min[0]) / 2;
  const hy = (bb.max[1] - bb.min[1]) / 2;
  const zMinAll = bb.min[2];

  // Ensure at least `wall` under the deepest natch bump, and at least DAM_Z
  // around the perimeter so the trapezoidal tongue and dam sit below the plaster.
  const DAM_Z = 6.8;
  const rm = turned.getMesh();
  let zPerimMin = Infinity;
  for (let i = 0; i < rm.numVert; i++) {
    const o = i * rm.numProp;
    if (Math.abs(rm.vertProperties[o] - cx) >= hx - 2 || Math.abs(rm.vertProperties[o + 1] - cy) >= hy - 2) {
      zPerimMin = Math.min(zPerimMin, rm.vertProperties[o + 2]);
    }
  }
  if (!Number.isFinite(zPerimMin)) zPerimMin = zMinAll;
  const zShift = Math.max(wall - zMinAll, DAM_Z - zPerimMin);
  const lumpP = turned.translate([-cx, -cy, zShift]);
  free(turned);

  const lbb = lumpP.boundingBox();
  const zBack = lbb.max[2];
  const zRim = zBack + Math.max(0, freeboard);

  const rectSlab = (wx: number, wy: number, z0: number, h: number) =>
    wasm.Manifold.cube([2 * wx, 2 * wy, h]).translate([-wx, -wy, z0]);

  // --- 1. Seamless pattern base -----------------------------------------------
  // Full 4-sided mitered trapezoidal perimeter tongue (45° ramps + 1.2 mm flat
  // vertical crest so FDM layers print a crisp blunt land with no 90° overhang
  // droop and no fragile knife-edge apex) around all four edges of the floor.
  const RIB_OUT = 1.6;
  const zDam = Math.max(DAM_Z, zPerimMin + zShift) - 0.02;
  const damBox = wasm.Manifold.cube([2 * hx, 2 * hy, zDam]).translate([-hx, -hy, 0]);
  const coreHx = Math.max(0.1, hx - 0.01), coreHy = Math.max(0.1, hy - 0.01);
  const coreBox = wasm.Manifold.cube([2 * coreHx, 2 * coreHy, Math.max(0.1, zBack - 0.01)]).translate([-coreHx, -coreHy, 0]);
  const tBot = rectSlab(hx, hy, 1.2, 0.02);
  const tMid = rectSlab(hx + RIB_OUT, hy + RIB_OUT, 2.8, 1.2);
  const tTop = rectSlab(hx, hy, 5.58, 0.02);
  const perimeterTongue = wasm.Manifold.hull([tBot, tMid, tTop]);
  const baseBlank = wasm.Manifold.union([damBox, coreBox, perimeterTongue]);
  let baseSolid = baseBlank.subtract(lumpP);
  free(damBox, coreBox, tBot, tMid, tTop, perimeterTongue, baseBlank);

  // Starter pry slots under the short ends (below Z = 1.2 so the 4-sided tongue stays unbroken).
  const pryW = Math.min(16, hx);
  if (pryW >= 4) {
    const pryNeg = extrudeAlongX(wasm, [[-hy - 1, -0.5], [-hy + 1.15, -0.5], [-hy + 1.15, 0.01], [-hy, 1.16], [-hy - 1, 1.16]], -pryW / 2, pryW / 2);
    const pryPos = extrudeAlongX(wasm, [[hy + 1, -0.5], [hy - 1.15, -0.5], [hy - 1.15, 0.01], [hy, 1.16], [hy + 1, 1.16]], -pryW / 2, pryW / 2);
    const notched = baseSolid.subtract(pryNeg).subtract(pryPos);
    free(pryNeg, pryPos, baseSolid);
    baseSolid = notched;
  }
  baseSolid = largestLump(baseSolid).lump;

  // --- 2. Two U-shaped wall halves (split at Y = 0, middle of long edges) ------
  const CLEAR = 0.2;
  const CLIP_CLEAR = 0.25;
  const SEAM_HALF = 0.05;
  const ix = hx + CLEAR;
  const iy = hy + CLEAR;
  const wUpper = Math.max(1.6, wall);
  const wSkirt = Math.max(wUpper, RIB_OUT + 2.4); // >= 4.0 mm around groove & rim
  const dw = wSkirt - wUpper;

  const outerParts: Manifold[] = [rectSlab(ix + wUpper, iy + wUpper, 0, zRim)];
  if (dw > 1e-3 && zRim > 9) {
    const zSkirt = Math.min(6.0, zRim * 0.48);
    const botWide = rectSlab(ix + wSkirt, iy + wSkirt, 0, zSkirt);
    const botTop = rectSlab(ix + wUpper, iy + wUpper, Math.min(zRim - 0.02, zSkirt + dw), 0.02);
    outerParts.push(wasm.Manifold.hull([botWide, botTop]));
    free(botWide, botTop);
    if (zRim > zSkirt + dw + 6) {
      const topH = Math.min(3.0, zRim * 0.2);
      const topWide = rectSlab(ix + wSkirt, iy + wSkirt, zRim - topH, topH);
      const topBot = rectSlab(ix + wUpper, iy + wUpper, zRim - topH - dw, 0.02);
      outerParts.push(wasm.Manifold.hull([topBot, topWide]));
      free(topWide, topBot);
    }
  }

  // Dovetail seam pads & tapered vertical rails at Y = 0 on both long edges (X = ±xPad).
  const DOVE_H = 3.8;
  const flare = 2.0;
  const taper = Math.min(0.5, Math.max(0.25, zRim * 0.007));
  const neckTop = Math.min(5.2, Math.max(3.2, hy * 0.18));
  const neckBot = neckTop + taper;
  const xPad = ix + wSkirt;
  const padHalfY = neckBot + 1.0;

  for (const sx of [-1, 1] as const) {
    // Flush vertical pad from ix to xPad across |Y| <= padHalfY, chamfered at 45° along Y.
    if (dw > 1e-3) {
      const xIn = sx > 0 ? ix + 0.2 : -xPad;
      const xOut = sx > 0 ? xPad : -(ix + 0.2);
      const padCore = wasm.Manifold.cube([xOut - xIn, 2 * padHalfY, zRim]).translate([xIn, -padHalfY, 0]);
      const xNarrowIn = sx > 0 ? ix + 0.2 : -(ix + wUpper);
      const xNarrowOut = sx > 0 ? ix + wUpper : -(ix + 0.2);
      const padWide = wasm.Manifold.cube([xNarrowOut - xNarrowIn, 2 * (padHalfY + dw), zRim]).translate([xNarrowIn, -(padHalfY + dw), 0]);
      outerParts.push(wasm.Manifold.hull([padCore, padWide]));
      free(padCore, padWide);
    }
    // Tapered dovetail rail from Z = 0 (wider) to Z = zRim (narrower).
    const railTrap = (neck: number, z0: number) => {
      const x0 = sx * (xPad - 0.5), x1 = sx * (xPad + DOVE_H);
      const cs = polySection(wasm, [[x0, -neck], [x1, -(neck + flare)], [x1, neck + flare], [x0, neck]]);
      const s = cs.extrude(0.02).translate([0, 0, z0]);
      free(cs);
      return s;
    };
    const rBot = railTrap(neckBot, 0);
    const rTop = railTrap(neckTop, zRim - 0.02);
    outerParts.push(wasm.Manifold.hull([rBot, rTop]));
    free(rBot, rTop);
  }

  // Finger pull handles on the two short ends (Y = ±(iy + wSkirt)).
  if (zRim >= 14) {
    const pullW = Math.min(28, ix * 1.2);
    const pullOut = 3.0;
    const yOut = iy + wSkirt;
    outerParts.push(extrudeAlongX(wasm, [
      [-yOut + 0.5, zRim - 3.0 - pullOut - dw],
      [-(yOut + pullOut), zRim - 3.0],
      [-(yOut + pullOut), zRim],
      [-yOut + 0.5, zRim],
    ], -pullW / 2, pullW / 2));
    outerParts.push(extrudeAlongX(wasm, [
      [yOut - 0.5, zRim - 3.0 - pullOut - dw],
      [yOut + pullOut, zRim - 3.0],
      [yOut + pullOut, zRim],
      [yOut - 0.5, zRim],
    ], -pullW / 2, pullW / 2));
  }

  const outerUnion = wasm.Manifold.union(outerParts);
  const innerCut = wasm.Manifold.cube([2 * ix, 2 * iy, zRim + 2]).translate([-ix, -iy, -1]);
  let collar = outerUnion.subtract(innerCut);
  free(...outerParts, outerUnion, innerCut);

  // Subtract a continuous 4-sided flat-bottomed trapezoidal groove (45° ramps)
  // around the entire inner perimeter so each U-wall half gets all 3 mitered
  // grooves: both side arms AND its longer end wall.
  const CLEAR_V = 0.28;
  const gPeak = RIB_OUT + CLEAR_V; // 1.88 mm past (hx, hy)
  const gBot = rectSlab(hx - 0.5, hy - 0.5, 2.65 - gPeak - 0.5, 0.02);
  const gMid = rectSlab(hx + gPeak, hy + gPeak, 2.65, 1.5);
  const gTop = rectSlab(hx - 0.5, hy - 0.5, 4.15 + gPeak + 0.48, 0.02);
  const grooveAll = wasm.Manifold.hull([gBot, gMid, gTop]);
  const grooved = collar.subtract(grooveAll);
  free(gBot, gMid, gTop, grooveAll, collar);
  collar = grooved;

  let wall1 = collar.trimByPlane([0, -1, 0], SEAM_HALF);
  let wall2 = collar.trimByPlane([0, 1, 0], SEAM_HALF);
  free(collar);

  // Vertical labyrinth tongue-and-groove across Y = 0 inside the seam pads.
  if (zRim >= 11) {
    const tongues: Manifold[] = [];
    const grooves: Manifold[] = [];
    for (const sx of [-1, 1] as const) {
      const tx0 = sx > 0 ? ix + 1.3 : -(ix + 2.7);
      const tx1 = sx > 0 ? ix + 2.7 : -(ix + 1.3);
      tongues.push(extrudeAlongX(wasm, [[-0.4, 6.3], [1.4, 8.1], [1.4, zRim], [-0.4, zRim]], tx0, tx1));
      const gx0 = sx > 0 ? ix + 1.05 : -(ix + 2.95);
      const gx1 = sx > 0 ? ix + 2.95 : -(ix + 1.05);
      grooves.push(extrudeAlongX(wasm, [[-0.1, 5.9], [1.75, 5.9], [1.75, zRim + 1], [-0.1, zRim + 1]], gx0, gx1));
    }
    const tUnion = wasm.Manifold.union(tongues);
    const gUnion = wasm.Manifold.union(grooves);
    const w1Next = wall1.add(tUnion);
    const w2Next = wall2.subtract(gUnion);
    free(...tongues, ...grooves, tUnion, gUnion, wall1, wall2);
    wall1 = w1Next;
    wall2 = w2Next;
  }
  wall1 = largestLump(wall1).lump;
  wall2 = largestLump(wall2).lump;

  // --- 3. Sliding C-clips (one on +X seam, one on -X seam) --------------------
  const cFlank = CLIP_CLEAR / Math.cos(Math.atan2(flare, DOVE_H));
  const xClipFront = xPad + 0.4;
  const uPocketBack = DOVE_H + 0.35;
  const xPocketBack = xPad + uPocketBack;
  const clipJaw = 3.4;
  const xSpineOut = xPocketBack + 3.6;
  const wNeckAt = (z: number) => neckBot - (taper / zRim) * z;
  const yPocketAt = (z: number, u: number) => wNeckAt(z) + cFlank + u * (flare / DOVE_H);

  const clipOuterSlab = (z: number, z0: number) => {
    const yOut = yPocketAt(z, uPocketBack) + clipJaw;
    const cs = polySection(wasm, [[xClipFront, -yOut], [xSpineOut, -yOut], [xSpineOut, yOut], [xClipFront, yOut]]);
    const s = cs.extrude(0.02).translate([0, 0, z0]);
    free(cs);
    return s;
  };
  const coBot = clipOuterSlab(0, 0);
  const coTop = clipOuterSlab(zRim, zRim - 0.02);
  let clipOuter = wasm.Manifold.hull([coBot, coTop]);
  free(coBot, coTop);

  if (zRim >= 12) {
    const yTop = yPocketAt(zRim, uPocketBack) + clipJaw;
    const tab = extrudeAlongY(wasm, [
      [xSpineOut - 0.5, zRim - 5.6],
      [xSpineOut + 2.6, zRim - 2.5],
      [xSpineOut + 2.6, zRim],
      [xSpineOut - 0.5, zRim],
    ], -yTop, yTop);
    const withTab = clipOuter.add(tab);
    free(tab, clipOuter);
    clipOuter = withTab;
  }

  const clipPocketSlab = (z: number, z0: number) => {
    const u0 = -0.5;
    const y0 = yPocketAt(z, u0), y1 = yPocketAt(z, uPocketBack);
    const cs = polySection(wasm, [[xPad + u0, -y0], [xPad + uPocketBack, -y1], [xPad + uPocketBack, y1], [xPad + u0, y0]]);
    const s = cs.extrude(0.02).translate([0, 0, z0]);
    free(cs);
    return s;
  };
  const cpBot = clipPocketSlab(-0.5, -0.5);
  const cpTop = clipPocketSlab(zRim + 0.5, zRim + 0.48);
  const clipPocket = wasm.Manifold.hull([cpBot, cpTop]);
  const clip1 = largestLump(clipOuter.subtract(clipPocket)).lump;
  free(cpBot, cpTop, clipPocket, clipOuter);
  const clip2 = clip1.rotate([0, 0, 180]);

  // Measure assembled envelope across all 5 parts.
  const asmSolids = [baseSolid, wall1, wall2, clip1, clip2];
  let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
  for (const s of asmSolids) {
    const sb = s.boundingBox();
    ax0 = Math.min(ax0, sb.min[0]); ay0 = Math.min(ay0, sb.min[1]); az0 = Math.min(az0, sb.min[2]);
    ax1 = Math.max(ax1, sb.max[0]); ay1 = Math.max(ay1, sb.max[1]); az1 = Math.max(az1, sb.max[2]);
  }
  // Centre the whole assembled cluster on (0, 0) in plan so it lines up with casePrint.
  const acx = (ax0 + ax1) / 2, acy = (ay0 + ay1) / 2;
  const shiftAsm = (m: Manifold) => {
    const s = m.translate([-acx, -acy, -az0]);
    free(m);
    return s;
  };
  const baseA = shiftAsm(baseSolid);
  const wall1A = shiftAsm(wall1);
  const wall2A = shiftAsm(wall2);
  const clip1A = shiftAsm(clip1);
  const clip2A = shiftAsm(clip2);
  const lumpA = shiftAsm(lumpP);

  const mkPart = (key: string, label: string, role: SlipCasePartRole, m: Manifold, release: [number, number, number]): SlipCasePart => {
    const { mesh, sizeMm } = centredOnBed(m);
    return { key, label, role, mesh, assembled: meshOf(m), release, sizeMm };
  };
  const parts: SlipCasePart[] = [
    mkPart('base', 'base', 'base', baseA, [0, 0, 0]),
    mkPart('wall1', 'wall 1', 'wall', wall1A, [0, -1, 0]),
    mkPart('wall2', 'wall 2', 'wall', wall2A, [0, 1, 0]),
    mkPart('clip1', 'clip 1', 'clip', clip1A, [0, 0, 1]),
    mkPart('clip2', 'clip 2', 'clip', clip2A, [0, 0, 1]),
  ];
  free(baseA, wall1A, wall2A, clip1A, clip2A);
  return {
    parts,
    sizeMm: [+(ax1 - ax0).toFixed(1), +(ay1 - ay0).toFixed(1), +(az1 - az0).toFixed(1)],
    lumpInCase: lumpA,
  };
}

/**
 * Natch centres on one parting half-plane: where a natch and a clear margin
 * round it sit in plaster on both sides, spread as far apart as they go.
 * The half-plane runs from the axis along `u` (unit, in plan), and its
 * points are (r, z): r along u from the axis, z the world height.
 */
function natchSites(
  wasm: ManifoldToplevel, keepOut: Manifold, axis: [number, number], angle: number,
  reach: number, z0: number, z1: number, radius: number, depth: number,
): [number, number][] {
  // Into the half-plane's frame: the axis at the origin, u along +X, the
  // plane's normal along +Z (so a slice at 0 is the plane), world Z along +Y.
  const moved = keepOut.translate([-axis[0], -axis[1], 0]).rotate([0, 0, -angle / DEG]).rotate([-90, 0, 0]);
  // After rotating -90° about X: world z -> +Y... check: (x, y, z) -> (x, z, -y).
  const sections: CrossSection[] = [];
  for (const off of [-depth, 0, depth]) sections.push(moved.slice(off));
  free(moved);
  const blocked = wasm.CrossSection.union(sections);
  // Plaster round a natch: 3 mm to the cavity (past the cone's own reach off
  // the plane, which the slices either side already hold), 2 mm to the
  // block's edge, so even a 25 mm wall takes one.
  const margin = radius + 3;
  const edge = radius + 2;
  const grownBlock = blocked.offset(margin, 'Round', 2, 32);
  const sheet = wasm.CrossSection.square([reach, z1 - z0]).translate([0, z0]);
  const inner = sheet.offset(-edge, 'Miter', 2);
  const room = inner.subtract(grownBlock);
  const contours = room.toPolygons();
  free(...sections, blocked, grownBlock, sheet, inner, room);
  if (!contours.length) return [];
  const step = Math.max(2, radius / 2);
  const candidates: [number, number][] = [];
  for (let r = edge; r <= reach - edge + 1e-9; r += step) {
    for (let z = z0 + edge; z <= z1 - edge + 1e-9; z += step) {
      if (insideContours(contours, r, z)) candidates.push([r, z]);
    }
  }
  if (!candidates.length) return [];
  // Farthest-point picks, starting from the highest: one near the top and one
  // near the bottom, and a third between on a tall mold.
  const picks: [number, number][] = [candidates.reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a))];
  const want = z1 - z0 > 12 * radius ? 3 : 2;
  while (picks.length < want) {
    let best: [number, number] | null = null, bestD = -1;
    for (const c of candidates) {
      const d = Math.min(...picks.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
      if (d > bestD) { bestD = d; best = c; }
    }
    if (!best || bestD < 4 * radius) break;
    picks.push(best);
  }
  return picks;
}

/** A cone natch standing on a plane at `at`, pointing along `dir` (unit, horizontal). */
function natchCone(wasm: ManifoldToplevel, at: [number, number, number], dir: [number, number], radius: number, height: number): Manifold {
  const cone = wasm.Manifold.cylinder(height, radius, 0, 48);
  const angle = Math.atan2(dir[1], dir[0]) / DEG;
  const placed = cone.rotate([0, 90, angle]).translate(at);
  free(cone);
  return placed;
}

/**
 * Builds the slip-cast mold round a part given as a closed triangle soup in
 * mm, Z up. Throws, saying why, when the part cannot be molded.
 */
export function buildSlipMold(
  wasm: ManifoldToplevel,
  soup: Float64Array,
  partial: Partial<SlipMoldOptions> = {},
  solidIds?: number[],
  solidNames?: string[],
): SlipMold {
  bin = [];
  try {
    return build(wasm, soup, partial, solidIds, solidNames);
  } finally {
    emptyBin();
  }
}

function build(
  wasm: ManifoldToplevel,
  soup: Float64Array,
  partial: Partial<SlipMoldOptions>,
  solidIds?: number[],
  solidNames?: string[],
): SlipMold {
  const o: SlipMoldOptions = { ...DEFAULT_SLIP_MOLD_OPTIONS, ...partial };
  if (soup.length < 36) throw new Error('Select the part to make a slip-cast mold of.');
  const slip = castMaterial(o.slip);
  const shrink = Math.max(0, Math.min(30, o.shrinkPercent ?? slip.shrinkPercent ?? 0));
  const scale = 1 / (1 - shrink / 100);
  let plaster = Math.max(MIN_PLASTER_MM, o.plasterMm);
  const wall = Math.max(0.8, o.caseWallMm);
  const warnings: string[] = [];

  const built = buildPartManifold(wasm, soup, solidIds);
  if (!built.part) {
    const names = [...new Set(built.unsolid.map((s) => solidNames?.[s]).filter(Boolean))];
    throw new Error(names.length
      ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not a closed solid even after repair, so the mold cannot hold it; repair the mesh and try again.`
      : 'The part could not be made into a solid; repair the mesh and try again.');
  }

  // Grown about the middle of its foot, so it still stands where it stood.
  const b0 = built.part.boundingBox();
  const foot: [number, number, number] = [(b0.min[0] + b0.max[0]) / 2, (b0.min[1] + b0.max[1]) / 2, b0.min[2]];
  const part = built.part.translate([-foot[0], -foot[1], -foot[2]]).scale(scale).translate(foot);
  free(built.part);
  const pb = part.boundingBox();
  const zMin = pb.min[2], zTop = pb.max[2];
  if (zTop - zMin < 2) { free(part); throw new Error('The part is under 2 mm tall: there is nothing to slip cast.'); }

  // --- The cavity -------------------------------------------------------------
  let filled = part;
  const fill = o.fillInside ? insideFill(wasm, part, zMin, zTop) : null;
  if (fill) filled = part.add(fill);
  const zBlockTop = zTop + Math.max(5, o.spareHeightMm);
  const spareAt = o.spareAtMm && o.spareAtMm.every(Number.isFinite) ? o.spareAtMm : null;
  // The inside itself: the fill less the part (a fill slab borrows the part's
  // outlines next to a filled slice, so it holds lumps of wall too).
  const inside = fill ? fill.subtract(part) : null;
  const sp = spare(wasm, filled, inside, zTop, zBlockTop, Math.max(5, o.spareDiaMm), spareAt, part.volume());
  free(fill, inside, filled !== part ? part : null);
  warnings.push(...sp.warnings);
  const axis = sp.centre;

  // --- The base plug ----------------------------------------------------------
  const rise = Math.min(0.3, (zTop - zMin) / 10);
  const zPlug = zMin + rise;
  let plugTop: CrossSection | null = null;
  const footSlice = filled.slice(zPlug);
  // A foot: what the part stands on covers at least a tenth of its plan, and
  // more than a plug's width across.
  const footHull = footSlice.hull();
  const plan = filled.boundingBox();
  const standsOnFoot = footHull.area() >= Math.max(Math.PI * 15 * 15, 0.1 * (plan.max[0] - plan.min[0]) * (plan.max[1] - plan.min[1]));
  free(footHull);
  const withBase = o.base === 'auto' ? standsOnFoot : Boolean(o.base);
  if (withBase) {
    const s = footSlice;
    // At least a plug's width, centred on the foot itself: centred on the
    // pour axis, an off-centre foot got a sliver of a plug reaching to it.
    const fb = s.bounds();
    const footAt: [number, number] = s.isEmpty() ? axis : [(fb.min[0] + fb.max[0]) / 2, (fb.min[1] + fb.max[1]) / 2];
    const minFoot = wasm.CrossSection.circle(Math.max(10, o.natchDiaMm), 48).translate(footAt);
    plugTop = wasm.CrossSection.hull([s, minFoot]);
    free(minFoot);
  }
  free(footSlice);

  // --- The split --------------------------------------------------------------
  const samples = surfaceSamples(filled);
  const plugContours = plugTop ? plugTop.toPolygons() : null;
  const overBase = plugContours ? (s: SurfaceSample) => insideContours(plugContours, s.x, s.y) : null;
  const split = chooseSplit(samples, axis, o.sides, overBase);
  const k = split.sides;
  const wedge = (2 * Math.PI) / k;
  const bisector = (j: number) => split.theta + (j + 0.5) * wedge;
  const boundary = (j: number) => split.theta + j * wedge;
  const pulls: [number, number, number][] = Array.from({ length: k }, (_, j) => [Math.cos(bisector(j)), Math.sin(bisector(j)), 0]);

  // Draft goes on once the pulls are known, and what undercut is left is
  // measured on the drafted part.
  const draftDeg = Math.max(0, Math.min(15, o.draftDeg));
  if (draftDeg > 0) {
    const drafted = draftForPieces(wasm, filled, axis, k, split.theta, draftDeg, plugContours ? (x, y) => insideContours(plugContours, x, y) : null);
    free(filled);
    filled = drafted;
    const again = scoreSplit(surfaceSamples(filled), axis, k, split.theta, overBase);
    split.undercut = again.undercut;
    split.total = again.total;
  }
  const cavity = filled.add(sp.spare);
  // What a casting is trimmed of: the spare, less the part standing in it.
  const spareOnly = sp.spare.subtract(filled);
  free(sp.spare);

  // --- The block --------------------------------------------------------------
  // Each side's back face square to its pull, the plaster at least `plaster`
  // clear of the cavity, and the plug at least half that inside the block.
  const cavityPts: Vec2[] = [];
  {
    const m = cavity.getMesh();
    for (let i = 0; i < m.numVert; i++) cavityPts.push([m.vertProperties[i * m.numProp], m.vertProperties[i * m.numProp + 1]]);
  }
  const reachAlong = (d: [number, number], pad: number, pts: Vec2[]) =>
    pts.reduce((a, p) => Math.max(a, (p[0] - axis[0]) * d[0] + (p[1] - axis[1]) * d[1]), -Infinity) + pad;
  const taper = Math.tan(Math.max(3, Math.min(30, o.baseTaperDeg)) * DEG);
  /** The block for plaster `t` thick: its outline, back faces, floor and the plug's foot. */
  const blockAt = (t: number) => {
    const zBottom = (withBase ? zPlug : zMin) - t;
    const plugBot = plugTop ? plugTop.offset(withBase ? (zPlug - zBottom) * taper : 0, 'Round', 2, 64) : null;
    const plugPts: Vec2[] = plugBot ? plugBot.toPolygons().flat() : [];
    const along = (d: [number, number]) => Math.max(reachAlong(d, t, cavityPts), plugPts.length ? reachAlong(d, t / 2, plugPts) : -Infinity);
    let planes: { d: [number, number]; a: number }[];
    const backs: number[] = [];
    if (k === 2) {
      const u: [number, number] = [Math.cos(split.theta), Math.sin(split.theta)];
      planes = [];
      for (let j = 0; j < 2; j++) {
        const d: [number, number] = [pulls[j][0], pulls[j][1]];
        const a = along(d);
        planes.push({ d, a });
        backs.push(a);
      }
      planes.push({ d: u, a: along(u) }, { d: [-u[0], -u[1]], a: along([-u[0], -u[1]]) });
    } else {
      const a = Math.max(...pulls.map((p) => along([p[0], p[1]])));
      planes = pulls.map((p) => ({ d: [p[0], p[1]] as [number, number], a }));
      for (let j = 0; j < k; j++) backs.push(a);
    }
    const big = 10 * Math.max(...planes.map((p) => p.a)) + 1000;
    return { planes, backs, big, outline: halfPlanePolygon(wasm, axis, planes, big), zBottom, plugBot };
  };
  // Given a budget of plaster powder, the plaster is as thick as it allows:
  // the block's volume less the cavity's, solved for the thickness.
  const cavityInBlock = cavity.volume();
  const powderFor = (t: number) => {
    const b = blockAt(t);
    const mm3 = Math.max(0, b.outline.area() * (zBlockTop - b.zBottom) - cavityInBlock);
    free(b.outline, b.plugBot);
    return mixGrams('plaster', castWeightG('plaster', mm3))?.a ?? castWeightG('plaster', mm3);
  };
  if (o.plasterBudgetG && o.plasterBudgetG > 0) {
    const budget = o.plasterBudgetG;
    if (powderFor(BUDGET_FLOOR_MM) > budget) {
      plaster = BUDGET_FLOOR_MM;
      warnings.push(`Even ${BUDGET_FLOOR_MM} mm of plaster, the thinnest that stays thirsty for a cast or two, takes about ${Math.round(powderFor(BUDGET_FLOOR_MM))} g of powder, over the ${Math.round(budget)} g budget: the mold is planned at ${BUDGET_FLOOR_MM} mm.`);
    } else {
      let lo = BUDGET_FLOOR_MM, hi = MAX_PLASTER_MM;
      if (powderFor(hi) <= budget) lo = hi;
      else for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (powderFor(mid) <= budget) lo = mid; else hi = mid; }
      plaster = Math.floor(lo * 2) / 2;
    }
  }
  const { planes, backs, big, outline, zBottom: zBlockBottom, plugBot: plugBottom } = blockAt(plaster);
  const blockHeight = zBlockTop - zBlockBottom;
  const block = outline.extrude(blockHeight).translate([0, 0, zBlockBottom]);
  const ob = outline.bounds();
  const blockMm: [number, number, number] = [+(ob.max[0] - ob.min[0]).toFixed(1), +(ob.max[1] - ob.min[1]).toFixed(1), +blockHeight.toFixed(1)];

  const plasterAll = block.subtract(cavity);

  // --- Base region: the plug, and the pockets under the part over it -----------
  let baseRegion: Manifold | null = null;
  if (plugTop && plugBottom) {
    const topSlab = plugTop.extrude(0.01).translate([0, 0, zPlug - 0.01]);
    const bottomSlab = plugBottom.extrude(0.01).translate([0, 0, zBlockBottom]);
    let region = wasm.Manifold.hull([topSlab, bottomSlab]);
    free(topSlab, bottomSlab);
    // A recess in the part's foot is plaster the sides cannot pull out of; it
    // goes with the plug when it is walled in by the part and the plug's top.
    const prism = plugTop.extrude(zBlockTop - zPlug).translate([0, 0, zPlug]);
    const shrunk = plugTop.offset(-0.5, 'Round', 2, 32);
    const innerPrism = shrunk.isEmpty() ? null : shrunk.extrude(zBlockTop + 2 - zPlug).translate([0, 0, zPlug - 1]);
    const over = plasterAll.intersect(prism);
    for (const lump of over.decompose()) {
      const lb = lump.boundingBox();
      const outside = innerPrism ? lump.subtract(innerPrism) : null;
      // Booleans along the part's walls leave slivers of no volume; a real
      // recess holds at least a cubic millimetre.
      const walledIn = innerPrism && lump.volume() > 1 && outside!.volume() < 1e-3 && lb.min[2] <= zPlug + 0.05 && lb.max[2] < zBlockTop - 0.05;
      free(outside);
      if (walledIn) {
        const next = region.add(lump);
        free(region);
        region = next;
      }
      free(lump);
    }
    free(prism, shrunk, innerPrism, over);
    baseRegion = region;
  }

  // --- The pieces ---------------------------------------------------------------
  const raw: { name: string; solid: Manifold; pull: [number, number, number]; back: number; undercut: number }[] = [];
  for (let j = 0; j < k; j++) {
    const w = wedgePolygon(wasm, axis, split.theta, k, j, big);
    const prism = w.extrude(blockHeight + 2).translate([0, 0, zBlockBottom - 1]);
    let solid = plasterAll.intersect(prism);
    if (baseRegion) {
      const cut = solid.subtract(baseRegion);
      free(solid);
      solid = cut;
    }
    // The back offset is along the pull from the origin, not the axis.
    const back = backs[j] + axis[0] * pulls[j][0] + axis[1] * pulls[j][1];
    raw.push({ name: `side ${j + 1}`, solid, pull: pulls[j], back, undercut: split.undercut[j] });
    free(w, prism);
  }
  if (baseRegion) {
    const solid = baseRegion.subtract(cavity);
    raw.push({ name: 'base', solid, pull: [0, 0, -1], back: -zBlockBottom, undercut: split.undercut[k] });
  }

  // --- Natches between the sides --------------------------------------------------
  // A cone releases along any pull within its half-angle of its axis; a side
  // pulls (90 - 180/k)° off the parting plane's normal.
  const natchR = Math.max(3, o.natchDiaMm / 2);
  const psi = Math.min(75, Math.max(45, 90 - 180 / k + 10)) * DEG;
  const natchH = natchR / Math.tan(psi);
  const natchCount = raw.map(() => ({ bumps: 0, dimples: 0 }));
  const keepOut = baseRegion ? cavity.add(baseRegion) : cavity.translate([0, 0, 0]);
  const reach = Math.max(...planes.map((p) => p.a)) / Math.cos(Math.PI / Math.max(k, 3)) + 1;
  for (let j = 0; j < k; j++) {
    // The half-plane between side j (behind it) and side j+1 (ahead of it).
    const a = boundary(j + 1);
    const u: [number, number] = [Math.cos(a), Math.sin(a)];
    const n: [number, number] = [-u[1], u[0]]; // into side j+1
    // How far the half-plane runs inside the block.
    let len = 0;
    for (const p of planes) {
      const du = u[0] * p.d[0] + u[1] * p.d[1];
      if (du > 1e-9) len = len ? Math.min(len, p.a / du) : p.a / du;
    }
    len = Math.min(len || reach, reach);
    const sites = natchSites(wasm, keepOut, axis, a, len, zBlockBottom, zBlockTop, natchR, natchH);
    const next = (j + 1) % k;
    for (const [r, z] of sites) {
      // Its foot sunk 0.5 mm into side j: a cone that only touches the face
      // stays a lump of its own, and its dimple a sealed void.
      const sink = 0.5;
      const at: [number, number, number] = [axis[0] + u[0] * r - n[0] * sink, axis[1] + u[1] * r - n[1] * sink, z];
      const cone = natchCone(wasm, at, n, natchR + sink * Math.tan(psi), natchH + sink);
      const bumped = raw[j].solid.add(cone);
      const dimpled = raw[next].solid.subtract(cone);
      free(raw[j].solid, raw[next].solid, cone);
      raw[j].solid = bumped;
      raw[next].solid = dimpled;
      natchCount[j].bumps++;
      natchCount[next].dimples++;
    }
    if (!sites.length) warnings.push(`No room for natches between side ${j + 1} and side ${next + 1}: thicken the plaster.`);
  }
  free(keepOut);

  // --- Cases ------------------------------------------------------------------------
  const pieces: SlipPiece[] = [];
  let plasterMm3 = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const { lump, droppedMm3 } = largestLump(r.solid);
    if (droppedMm3 > 50) warnings.push(`The ${r.name} came out in more than one lump (${Math.round(droppedMm3)} mm³ left out): plaster is caught somewhere it cannot be pulled from, so try more sides.`);
    const vol = lump.volume();
    plasterMm3 += vol;
    // A sliver of the case that only touches the rest face to face (the 0.3 mm
    // of the part's foot over the plug) would print loose: one lump only.
    const c = largestLump(caseFor(wasm, lump, r.pull, r.back, wall, Math.max(0, o.freeboardMm))).lump;
    const print = standUp(c, r.pull);
    const pbb = print.boundingBox();
    const onePieceMesh = meshOf(print);
    const onePieceSize: [number, number, number] = [+(pbb.max[0] - pbb.min[0]).toFixed(1), +(pbb.max[1] - pbb.min[1]).toFixed(1), +(pbb.max[2] - pbb.min[2]).toFixed(1)];
    let caseParts: SlipCasePart[];
    let caseSizeMm: [number, number, number];
    if (o.splitCase && r.name !== 'base') {
      const splitOut = buildSplitSideCase(wasm, lump, r.pull, wall, Math.max(0, o.freeboardMm));
      free(splitOut.lumpInCase);
      caseParts = splitOut.parts;
      caseSizeMm = splitOut.sizeMm;
    } else {
      caseParts = [{ key: 'case', label: 'case', role: 'case', mesh: onePieceMesh, assembled: onePieceMesh, release: [0, 0, 0], sizeMm: onePieceSize }];
      caseSizeMm = onePieceSize;
    }
    pieces.push({
      name: r.name,
      plaster: meshOf(lump),
      caseInPlace: meshOf(c),
      casePrint: onePieceMesh,
      caseParts,
      pull: r.pull,
      plasterMm3: Math.round(vol),
      caseSizeMm,
      undercutMm2: Math.round(r.undercut),
      natches: natchCount[i],
    });
    free(lump, c, print);
  }

  const undercutMm2 = Math.round(split.total);
  const totalArea = samples.reduce((a, s) => a + s.area, 0);
  if (split.total > totalArea * 0.002) {
    const worst = pieces.filter((p) => p.undercutMm2 > 0).sort((a, b) => b.undercutMm2 - a.undercutMm2)[0];
    warnings.push(
      `${undercutMm2.toLocaleString()} mm² of the part faces away from the piece that has to pull off it` +
      (worst ? ` (most on the ${worst.name})` : '') +
      (k < MAX_SLIP_SIDES && o.sides !== 'auto' ? ': try more sides, or Add Draft.' : ': Add Draft, or turn the part.'),
    );
  }

  const cavityMm3 = cavity.volume();
  const plasterG = castWeightG('plaster', plasterMm3);
  const mix = mixGrams('plaster', plasterG);
  const report: SlipMoldReport = {
    sides: k,
    base: Boolean(baseRegion),
    splitCase: Boolean(o.splitCase),
    splitDeg: +((split.theta / DEG) % 360).toFixed(1),
    axisMm: [+axis[0].toFixed(2), +axis[1].toFixed(2)],
    scale: +scale.toFixed(4),
    footMm: [+foot[0].toFixed(3), +foot[1].toFixed(3), +foot[2].toFixed(3)],
    partTopMm: +zTop.toFixed(3),
    spareAtMm: [+axis[0].toFixed(2), +axis[1].toFixed(2), +sp.footZ.toFixed(2)],
    draftDeg,
    shrinkPercent: shrink,
    blockMm,
    slipMl: Math.round(cavityMm3 / 1000),
    plasterMm3: Math.round(plasterMm3),
    plasterMm: plaster,
    plasterPowderG: Math.round(mix?.a ?? plasterG),
    plasterWaterG: Math.round(mix?.b ?? 0),
    undercutMm2,
    slipName: slip.label,
    warnings,
  };
  const out: SlipMold = { pieces, slip: o.slip, cavity: meshOf(cavity), spare: meshOf(spareOnly), report };
  free(filled, cavity, spareOnly, plasterAll, block, outline, plugTop, plugBottom, baseRegion);
  return out;
}
