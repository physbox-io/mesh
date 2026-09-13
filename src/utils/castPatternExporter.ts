// ---------------------------------------------------------------------------
// Green-sand casting — the pattern, not the part
// ---------------------------------------------------------------------------
//
// The other exports hand you the part. This one hands you the *pattern*: the
// positive you pack sand around, pull out, and pour metal into the hollow it
// leaves. A pattern is not the part. Three things separate them:
//
//   - It is scaled up by the metal's shrink allowance, because metal contracts
//     as it freezes, so a pattern the size of the part casts a part that is
//     too small.
//   - It carries the gating: a sprue to pour down, a runner along the parting
//     line, a gate into the cavity, and a riser to feed the shrinkage. Printed
//     as one piece with the part, ramming sand around it forms the channels.
//   - It has to *draw* from the rammed sand, so anything that overhangs the
//     pull direction locks it in. That is the same analysis the mill uses to
//     find what it cannot reach, run here to find what will not pull.
//
// The pattern is meant to be 3D printed, so the printer imposes no shape limit;
// the only geometry rule is that it draws. Everything here is millimetres, pull
// straight up (+Z) from a flat parting plane, which suits the flat-backed,
// convex-ish patterns this is for. Undercuts are reported, not fixed: adding
// draft is a modelling job, and the walkthrough says how much to add.

import type { SceneGraph } from '../types/scene';
import { collectSceneTriangles } from './contourSliceExporter';
import { sampleColumns } from './solidMachiningExporter';

/** A castable metal: how much it shrinks, and what a cast of it weighs. */
export interface CastMetal {
  id: string;
  label: string;
  /** Solidification-plus-cooling contraction, as a percent the pattern is grown by. */
  shrinkPercent: number;
  /** Density in g/cm³, for the pour-weight estimate. */
  densityGcm3: number;
  /** Rough pouring temperature, for the walkthrough. */
  pourC: number;
}

export const CAST_METALS: CastMetal[] = [
  { id: 'aluminium', label: 'Aluminium', shrinkPercent: 1.3, densityGcm3: 2.70, pourC: 720 },
  { id: 'brass', label: 'Brass', shrinkPercent: 1.5, densityGcm3: 8.5, pourC: 1000 },
  { id: 'bronze', label: 'Bronze', shrinkPercent: 1.5, densityGcm3: 8.8, pourC: 1150 },
  { id: 'silver', label: 'Silver', shrinkPercent: 1.6, densityGcm3: 10.5, pourC: 1000 },
];

export function castMetal(id: string): CastMetal {
  return CAST_METALS.find((m) => m.id === id) ?? CAST_METALS[0];
}

export interface CastOptions {
  /** Which metal, which sets shrink, density and the pour-temperature note. */
  metalId: string;
  /**
   * Parting plane height in mm, measured from the part's base, or 'auto' to put
   * it at the base so the whole pattern is one flat-backed piece pulled upward.
   */
  partingFromBaseMm: number | 'auto';
  /** Print the sprue, runner, gate and riser as part of the pattern. */
  addGating: boolean;
  /** Sprue diameter, mm. 0 derives one from the cast weight. */
  sprueDiaMm: number;
  /** Riser diameter, mm. 0 derives one from the part's bulk. */
  riserDiaMm: number;
  /** A riser feeds shrinkage; leave it off only for the thinnest, flattest parts. */
  addRiser: boolean;
  /** Draft the walkthrough recommends on vertical walls, for the report. */
  recommendedDraftDeg: number;
}

export const DEFAULT_CAST_OPTIONS: CastOptions = {
  metalId: 'aluminium',
  partingFromBaseMm: 'auto',
  addGating: true,
  sprueDiaMm: 0,
  riserDiaMm: 0,
  addRiser: true,
  recommendedDraftDeg: 2,
};

export interface CastSummary {
  metalLabel: string;
  shrinkPercent: number;
  /** Plan-view and height of the pattern as it will print, mm. */
  patternSizeMm: { x: number; y: number; z: number };
  /** The finished part's size after shrink, mm. */
  partSizeMm: { x: number; y: number; z: number };
  partVolumeMm3: number;
  /** What the metal in the finished part weighs, grams. */
  castWeightG: number;
  /** Plus the gating, which is remelted; a rough guide to how much to pour. */
  pourWeightG: number;
  sprueDiaMm: number;
  riserDiaMm: number;
  partingFromBaseMm: number;
  pourC: number;
  /**
   * Share of the part's volume that will not pull from the sand — material that
   * overhangs the upward draw. 0 for a flat-backed convex part.
   */
  undrawablePercent: number;
}

export interface CastResult {
  success: boolean;
  error?: string;
  warnings: string[];
  /** The pattern, gating and all, as a binary STL to print. */
  patternStl: Uint8Array;
  summary: CastSummary;
}

/** Beyond this the draw analysis costs more than the extra fidelity is worth. */
const MAX_ANALYSIS_CELLS = 120_000;

/** Signed volume of a triangle soup (9 numbers per tri), mm³. */
function triSoupVolume(tris: Float64Array): number {
  let v = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(v) / 6;
}

/** Appends one triangle (three points) to a growing list. */
function pushTri(out: number[], a: number[], b: number[], c: number[]): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

/** A box aligned to the axes, as 12 triangles. */
function appendBox(out: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const face = (a: number, b: number, c: number, d: number) => {
    pushTri(out, p[a], p[b], p[c]);
    pushTri(out, p[a], p[c], p[d]);
  };
  face(0, 3, 2, 1); // bottom
  face(4, 5, 6, 7); // top
  face(0, 1, 5, 4); // front
  face(2, 3, 7, 6); // back
  face(1, 2, 6, 5); // right
  face(3, 0, 4, 7); // left
}

/** A vertical cylinder (axis along Z) as a fan of triangles. */
function appendCylinder(out: number[], cx: number, cy: number, z0: number, z1: number, r: number, seg = 24): void {
  const top = [cx, cy, z1];
  const bot = [cx, cy, z0];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI;
    const a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0), z0];
    const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1), z0];
    const q0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0), z1];
    const q1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1), z1];
    pushTri(out, bot, p1, p0); // bottom cap
    pushTri(out, top, q0, q1); // top cap
    pushTri(out, p0, p1, q1); // wall
    pushTri(out, p0, q1, q0);
  }
}

/** Writes a triangle soup (9 numbers per tri) as a binary STL. */
function trisToBinaryStl(tris: number[]): Uint8Array {
  const count = Math.floor(tris.length / 9);
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    // Face normal from the winding.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    view.setFloat32(o + 12, ax, true); view.setFloat32(o + 16, ay, true); view.setFloat32(o + 20, az, true);
    view.setFloat32(o + 24, bx, true); view.setFloat32(o + 28, by, true); view.setFloat32(o + 32, bz, true);
    view.setFloat32(o + 36, cx, true); view.setFloat32(o + 40, cy, true); view.setFloat32(o + 44, cz, true);
    view.setUint16(o + 48, 0, true);
    o += 50;
  }
  return new Uint8Array(buf);
}

/**
 * Turns a scene into a green-sand casting pattern, ready to print.
 */
export function generateCastPattern(scene: SceneGraph, userOptions?: Partial<CastOptions>): CastResult {
  const opts: CastOptions = { ...DEFAULT_CAST_OPTIONS, ...userOptions };
  const metal = castMetal(opts.metalId);
  const warnings: string[] = [];

  const fail = (error: string): CastResult => ({
    success: false,
    error,
    warnings,
    patternStl: new Uint8Array(84),
    summary: {
      metalLabel: metal.label,
      shrinkPercent: metal.shrinkPercent,
      patternSizeMm: { x: 0, y: 0, z: 0 },
      partSizeMm: { x: 0, y: 0, z: 0 },
      partVolumeMm3: 0,
      castWeightG: 0,
      pourWeightG: 0,
      sprueDiaMm: 0,
      riserDiaMm: 0,
      partingFromBaseMm: 0,
      pourC: metal.pourC,
      undrawablePercent: 0,
    },
  });

  const { tris: sceneTris, skipped, warnings: sceneWarnings } = collectSceneTriangles(scene);
  warnings.push(...sceneWarnings);
  if (skipped.length > 0) warnings.push(`Skipped (no solid volume to cast): ${skipped.join(', ')}.`);
  if (sceneTris.length === 0) return fail('No solid geometry found in the scene to cast.');

  // Scene units are metres; the part sits at its own place in the world, so it
  // is dropped to a base of Z = 0 and centred in X and Y for the pattern.
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < sceneTris.length; i += 3) {
    const x = sceneTris[i] * 1000, y = sceneTris[i + 1] * 1000, z = sceneTris[i + 2] * 1000;
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  const partW = mxX - mnX, partD = mxY - mnY, partH = mxZ - mnZ;
  if (partW <= 1e-6 || partD <= 1e-6 || partH <= 1e-6) {
    return fail('The scene has no volume, so there is no pattern to make.');
  }

  const cx = (mnX + mxX) / 2, cy = (mnY + mxY) / 2;
  // Part triangles in mm, based at Z = 0 and centred in plan.
  const part = new Float64Array(sceneTris.length);
  for (let i = 0; i < sceneTris.length; i += 3) {
    part[i] = sceneTris[i] * 1000 - cx;
    part[i + 1] = sceneTris[i + 1] * 1000 - cy;
    part[i + 2] = sceneTris[i + 2] * 1000 - mnZ;
  }

  const partVolumeMm3 = triSoupVolume(part);
  const castWeightG = (partVolumeMm3 / 1000) * metal.densityGcm3;

  // --- Draw check: will the pattern pull straight up? -----------------------
  // A flat-backed pattern pulled up locks in the sand wherever material sits
  // above a gap (an overhang) or floats above the parting plane. Measured the
  // same way the mill measures what it cannot reach: columns from above.
  const parting = opts.partingFromBaseMm === 'auto' ? 0 : Math.max(0, opts.partingFromBaseMm);
  const bounds2d = { minX: mnX - cx - 1, minY: mnY - cy - 1, maxX: mxX - cx + 1, maxY: mxY - cy + 1 };
  const span = Math.max(partW, partD);
  let res = Math.max(0.5, span / 200);
  let cols = Math.ceil((bounds2d.maxX - bounds2d.minX) / res) + 1;
  let rows = Math.ceil((bounds2d.maxY - bounds2d.minY) / res) + 1;
  if (cols * rows > MAX_ANALYSIS_CELLS) {
    const shrink = Math.sqrt((cols * rows) / MAX_ANALYSIS_CELLS);
    res *= shrink;
    cols = Math.ceil((bounds2d.maxX - bounds2d.minX) / res) + 1;
    rows = Math.ceil((bounds2d.maxY - bounds2d.minY) / res) + 1;
  }
  const { top, bottom, thickness, hit } = sampleColumns(part, bounds2d, cols, rows);
  const cellArea = ((bounds2d.maxX - bounds2d.minX) / (cols - 1)) * ((bounds2d.maxY - bounds2d.minY) / (rows - 1));
  let trapped = 0;
  for (let k = 0; k < hit.length; k++) {
    if (!hit[k]) continue;
    // Voids enclosed within the silhouette (material over a gap), plus anything
    // standing above the parting plane on a gap beneath it.
    const enclosed = Math.max(0, top[k] - bottom[k] - thickness[k]);
    const floating = Math.max(0, bottom[k] - parting);
    trapped += (enclosed + floating) * cellArea;
  }
  const undrawablePercent = partVolumeMm3 > 0 ? (100 * trapped) / partVolumeMm3 : 0;
  if (undrawablePercent > 1) {
    warnings.push(
      `About ${undrawablePercent.toFixed(0)}% of the part overhangs the upward pull, so the pattern ` +
        `will not draw cleanly from the sand there. Add ${opts.recommendedDraftDeg}° draft to the walls, ` +
        `move the parting plane, or print it as a lost-foam pattern and burn it out instead of pulling it.`
    );
  }

  // --- Shrink the pattern up so the casting comes out to size ----------------
  const grow = 1 + metal.shrinkPercent / 100;
  const pat: number[] = [];
  for (let i = 0; i < part.length; i += 9) {
    for (let v = 0; v < 9; v += 3) {
      pat.push(part[i + v] * grow, part[i + v + 1] * grow, part[i + v + 2] * grow);
    }
  }
  const gPartW = partW * grow, gPartD = partD * grow, gPartH = partH * grow;

  // --- Gating ----------------------------------------------------------------
  // Simple and honest: a downsprue beside the part, a runner along the parting
  // plane into a gate on the part, and a riser on top. Sized by rules of thumb,
  // meant as a starting rig to adjust, not a solved feed system.
  const sprueDia = opts.sprueDiaMm > 0 ? opts.sprueDiaMm : Math.max(8, Math.min(25, Math.cbrt(castWeightG) * 3));
  const riserDia = opts.riserDiaMm > 0 ? opts.riserDiaMm : Math.max(10, Math.min(40, Math.min(gPartW, gPartD) * 0.5));
  if (opts.addGating) {
    const gap = 8;
    const halfW = gPartW / 2;
    const sprueX = halfW + gap + sprueDia / 2;
    const sprueTop = Math.max(gPartH, 20) + 15;
    const runnerH = Math.max(6, sprueDia * 0.6);
    // Downsprue.
    appendCylinder(pat, sprueX, 0, 0, sprueTop, sprueDia / 2);
    // Runner along the parting plane, from the sprue to the edge of the part.
    appendBox(pat, halfW - 2, sprueX, -runnerH / 2, runnerH / 2, 0, runnerH);
    // A short gate stub where the runner meets the part.
    appendBox(pat, halfW - 4, halfW + 1, -runnerH / 2, runnerH / 2, 0, runnerH * 0.7);
    if (opts.addRiser) {
      // Riser on the far side, fed off the top of the part's bulk.
      appendCylinder(pat, -halfW - gap - riserDia / 2, 0, 0, Math.max(gPartH, 20) + 10, riserDia / 2);
      appendBox(pat, -halfW - gap - riserDia / 2, -halfW + 2, -runnerH / 2, runnerH / 2, 0, runnerH);
    }
  }

  // Gating is remelted, so it adds to what you pour but not to the part.
  const pourWeightG = castWeightG * (opts.addGating ? 1.6 : 1.15);

  const patternStl = trisToBinaryStl(pat);

  return {
    success: true,
    warnings,
    patternStl,
    summary: {
      metalLabel: metal.label,
      shrinkPercent: metal.shrinkPercent,
      patternSizeMm: { x: gPartW, y: gPartD, z: gPartH },
      partSizeMm: { x: partW, y: partD, z: partH },
      partVolumeMm3,
      castWeightG,
      pourWeightG,
      sprueDiaMm: opts.addGating ? sprueDia : 0,
      riserDiaMm: opts.addGating && opts.addRiser ? riserDia : 0,
      partingFromBaseMm: parting,
      pourC: metal.pourC,
      undrawablePercent,
    },
  };
}
