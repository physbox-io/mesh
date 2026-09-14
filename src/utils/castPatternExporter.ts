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
   * Parting plane height in mm, measured from the part's base, or 'auto' to
   * search a few heights and take whichever leaves the least material trapped.
   */
  partingFromBaseMm: number | 'auto';
  /** Print the sprue, runner, gate and riser as part of the pattern. */
  addGating: boolean;
  /** Sprue diameter, mm. 0 sizes the choke from the fill rate the casting needs. */
  sprueDiaMm: number;
  /**
   * Riser diameter, mm. 0 derives one from the casting's modulus — and may
   * decide the part does not need a riser at all.
   */
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
  /**
   * Volume of the sprue, runner, gate and riser actually printed, mm³ — the
   * metal that fills the channels rather than the part. Carried separately so
   * the pour weight can be checked against the rig instead of taken on faith.
   */
  gatingVolumeMm3: number;
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

/** Surface area of a triangle soup (9 numbers per tri), mm². */
function triSoupArea(tris: Float64Array): number {
  let a = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return a / 2;
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
      gatingVolumeMm3: 0,
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

  // --- Draw check: will the pattern pull out of the sand? -------------------
  // The parting plane splits the mould in two: everything above it comes away
  // upward with the cope, everything below it downward with the drag. So a
  // column of material is trapped if it starts above the plane on nothing (the
  // cope would have to lift sand out from under it), if it ends below the plane
  // under nothing (the same problem mirrored, pulled downward), or if a void
  // inside the column separates its material from the plane, which no pull
  // frees. Measured the same way the mill measures what it cannot reach:
  // columns from above.
  //
  // What is counted is MATERIAL, not the air the material sits over. That
  // distinction is the whole bug this had: charging each column the height of
  // the gap beneath it, or the size of the void inside it, measures empty space
  // — and empty space is unbounded relative to the part. A scene of separate
  // bodies with half a metre of air between them (a pendulum: stand, arms,
  // bobs) reported 714% undrawable, because the air under the bobs is seven
  // times the metal in the whole scene. A column can now only ever be charged
  // the material it actually contains, so the total cannot outgrow the part.
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
  // The same columns also give the part's volume as this analysis sees it, and
  // that is the right denominator for the share: a grid fine enough to resolve a
  // 50 mm bracket still smears a 4 mm capsule across whole cells, so dividing a
  // column-measured numerator by the exact mesh volume can put the ratio over
  // one on thin work. Numerator and denominator measured the same way cannot.
  let columnVolumeMm3 = 0;
  for (let k = 0; k < hit.length; k++) if (hit[k]) columnVolumeMm3 += thickness[k] * cellArea;
  const drawBasisMm3 = columnVolumeMm3 > 1e-9 ? columnVolumeMm3 : partVolumeMm3;

  /** Material that will not draw with a parting plane `p` mm above the base, mm³. */
  const trappedAt = (p: number): number => {
    let trapped = 0;
    for (let k = 0; k < hit.length; k++) {
      if (!hit[k]) continue;
      const mat = thickness[k];
      if (mat <= 0) continue;
      if (bottom[k] > p || top[k] < p) {
        // Every millimetre of metal in this column is on the wrong side of the
        // plane with nothing under (or over) it holding the sand up: all of it
        // is re-entrant to whichever half would have to pull it.
        trapped += mat * cellArea;
      } else if (top[k] - bottom[k] - mat > 1e-6) {
        // The plane passes through the column, but so does a void, so the metal
        // comes in two or more spans and only the one touching the plane draws.
        // The column sampler hands back totals rather than the spans themselves,
        // so which share that is cannot be known from here; half is the honest
        // middle of it, and the warning it triggers is the point rather than the
        // exact figure.
        trapped += mat * 0.5 * cellArea;
      }
    }
    return trapped;
  };

  // 'auto' used to mean "at the base", which is only right for a flat-backed
  // part. Anything mirror-symmetric about its own mid-height — a ring band, a
  // lens, a barrel — has its whole lower half re-entrant to an upward pull from
  // the base, and reads as several percent undrawable when in fact it parts
  // perfectly at mid-height. So try a handful of heights and keep the best.
  // Thirteen levels is plenty: the trapped-volume curve is piecewise linear in
  // the plane height, so the minimum sits at or very near one of them, and the
  // scan costs one pass over an already-sampled grid.
  let parting: number;
  if (opts.partingFromBaseMm === 'auto') {
    parting = 0;
    let bestTrapped = trappedAt(0);
    // Only move off the base for a real improvement: a flat-backed pattern is
    // the easiest thing to ram and to print, so it wins every near-tie.
    const worthMoving = Math.max(1e-9, drawBasisMm3 * 1e-6);
    for (let i = 1; i <= 12; i++) {
      const p = (partH * i) / 12;
      const t = trappedAt(p);
      if (t < bestTrapped - worthMoving) {
        bestTrapped = t;
        parting = p;
      }
    }
  } else {
    parting = Math.max(0, opts.partingFromBaseMm);
  }
  const trapped = trappedAt(parting);
  // Clamped as a backstop, not as the fix. A share of a part cannot be negative
  // or above everything there is, so if some future sampling quirk says it is,
  // the user should see a saturated 100% rather than a number that tells them
  // the analysis is broken.
  const undrawablePercent =
    drawBasisMm3 > 0 ? Math.min(100, Math.max(0, (100 * trapped) / drawBasisMm3)) : 0;
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
  // plane into a gate on the part, and a riser on top. A starting rig to adjust,
  // not a solved feed system — but sized from this casting rather than from a
  // table written for a foundry pouring twenty-kilo sand jobs. The old rules
  // had an 8 mm floor on the sprue and a 10 mm floor on the riser, which on a
  // five-gram ring meant more metal in the gating than in three castings, and
  // an 8 mm scar on a 5 mm band.

  // The head the metal falls through: the top of the sprue above the parting
  // plane. Everything below is driven by it, so it is worked out first.
  const sprueTop = Math.max(gPartH, 20) + 15;
  const riserTop = Math.max(gPartH, 20) + 10;

  // Sprue choke, from the fill rate rather than a floor. Continuity at the
  // choke: mass / (density · time) = area · velocity, with the velocity from
  // Torricelli under the pouring head and a discharge coefficient of 0.7 for a
  // printed, near-parallel channel. Fill time follows the usual t = k·√m shape,
  // calibrated so a kilo of aluminium fills in about six seconds — the middle
  // of hobby practice — and floored at a third of a second, below which nobody
  // can pour accurately anyway. The metal through the choke is the casting plus
  // whatever the feeders hold, hence the 1.3.
  const chokeMassG = Math.max(castWeightG, 1e-6) * 1.3;
  const fillTimeS = Math.min(15, Math.max(0.35, 0.19 * Math.sqrt(chokeMassG)));
  const velocityMmS = Math.sqrt(2 * 9810 * sprueTop);
  const chokeAreaMm2 = chokeMassG / ((metal.densityGcm3 / 1000) * 0.7 * fillTimeS * velocityMmS);
  // Two sanity rails on that number. Below about 2.5 mm a channel in sand or
  // plaster freezes before it has filled and is fragile in the printed pattern,
  // so that is the floor. At the top, 25 mm as before, and never wider than the
  // section the casting itself offers the metal — volume over the longest plan
  // dimension is a fair stand-in for that feed cross-section — because a sprue
  // fatter than the part it feeds is just a scar to saw off.
  const feedSectionMm2 = partVolumeMm3 / Math.max(partW, partD, 1e-6);
  const sprueDia =
    opts.sprueDiaMm > 0
      ? opts.sprueDiaMm
      : Math.max(
          2.5,
          Math.min(25, Math.sqrt((4 * feedSectionMm2 * 1.5) / Math.PI), Math.sqrt((4 * chokeAreaMm2) / Math.PI))
        );

  // Riser, by Chvorinov rather than by plan size. A feeder has to still be
  // liquid when the casting has frozen, so its modulus (volume over cooling
  // surface) must beat the casting's by the usual 20% margin. Solving that for
  // a cylinder of the height this rig actually prints gives a closed form, and
  // the riser must additionally hold the shrinkage it is there to feed — about
  // the metal's contraction, at the ~14% yield a plain cylindrical riser
  // manages. The bigger of the two wins.
  const partAreaMm2 = triSoupArea(part);
  const castModulusMm = partAreaMm2 > 0 ? partVolumeMm3 / partAreaMm2 : 0;
  const reqModulusMm = castModulusMm * 1.2;
  const modulusDia =
    riserTop > 2 * reqModulusMm ? (4 * riserTop * reqModulusMm) / (riserTop - 2 * reqModulusMm) : Infinity;
  const feedVolMm3 = (partVolumeMm3 * metal.shrinkPercent) / 100 / 0.14;
  const volumeDia = Math.sqrt((4 * feedVolMm3) / (Math.PI * riserTop));
  const autoRiserDia = Math.min(40, Math.max(modulusDia, volumeDia));
  // And the part may simply not want a riser. A casting whose modulus is under
  // a millimetre — a plate thinner than about 2 mm, a jewellery band — freezes
  // in a second or two and is fed perfectly well back through its own gate and
  // sprue; likewise a riser that works out under 5 mm across holds no useful
  // reserve and would freeze first, doing nothing but adding a stub to cut off.
  // An explicitly requested diameter is always honoured.
  const riserWanted =
    opts.addRiser && (opts.riserDiaMm > 0 || (castModulusMm >= 1.0 && autoRiserDia >= 5 && Number.isFinite(autoRiserDia)));
  const riserDia = opts.riserDiaMm > 0 ? opts.riserDiaMm : autoRiserDia;
  if (opts.addRiser && !riserWanted) {
    warnings.push(
      `No riser: at a modulus of ${castModulusMm.toFixed(2)} mm this casting freezes fast enough to feed ` +
        `back through its own gate, and a feeder small enough to suit it would freeze first.`
    );
  }

  // Runner and gate scale with the choke, not with a fixed 6 mm. An
  // unpressurised rig wants the runner a little roomier than the choke so the
  // metal slows and any dross rises; 1.5x the choke area, square section, is the
  // conventional starting point, with 2 mm as the thinnest thing worth printing.
  const runnerH = Math.max(2, Math.sqrt(1.5 * (Math.PI * sprueDia * sprueDia) / 4));
  // The sprue stands off the part by about its own diameter — far enough that
  // the sand between them holds, close enough that a small part is not fed down
  // a long cold runner.
  const gap = Math.max(3, Math.min(8, sprueDia));
  const halfW = gPartW / 2;
  const sprueX = halfW + gap + sprueDia / 2;
  const gateLen = Math.min(5, Math.max(2, sprueDia));
  let gatingVolumeMm3 = 0;
  if (opts.addGating) {
    // Downsprue.
    appendCylinder(pat, sprueX, 0, 0, sprueTop, sprueDia / 2);
    gatingVolumeMm3 += (Math.PI * sprueDia * sprueDia * sprueTop) / 4;
    // Runner along the parting plane, from the sprue to the edge of the part.
    const runnerX0 = halfW - 2;
    appendBox(pat, runnerX0, sprueX, -runnerH / 2, runnerH / 2, 0, runnerH);
    gatingVolumeMm3 += Math.max(0, sprueX - runnerX0) * runnerH * runnerH;
    // A short gate stub where the runner meets the part.
    appendBox(pat, halfW + 1 - gateLen, halfW + 1, -runnerH / 2, runnerH / 2, 0, runnerH * 0.7);
    gatingVolumeMm3 += gateLen * runnerH * runnerH * 0.7;
    if (riserWanted) {
      // Riser on the far side, fed off the top of the part's bulk.
      const riserX = -halfW - gap - riserDia / 2;
      appendCylinder(pat, riserX, 0, 0, riserTop, riserDia / 2);
      gatingVolumeMm3 += (Math.PI * riserDia * riserDia * riserTop) / 4;
      const neckX1 = -halfW + 2;
      appendBox(pat, riserX, neckX1, -runnerH / 2, runnerH / 2, 0, runnerH);
      gatingVolumeMm3 += Math.max(0, neckX1 - riserX) * runnerH * runnerH;
    }
  } else {
    gatingVolumeMm3 = 0;
  }

  // What to melt. Not a multiplier: the metal that has to go in the crucible is
  // the metal that ends up in the mould — the cavity, which is the pattern's
  // size and so the part grown by the shrink allowance, plus every channel
  // printed above — with a tenth on top for the pouring basin, the skull left
  // in the crucible and the dribble that misses. A flat 1.6x got this badly
  // wrong on small parts, where the sprue alone outweighs the casting.
  const mouldVolumeMm3 = partVolumeMm3 * grow * grow * grow + gatingVolumeMm3;
  const mouldMetalG = (mouldVolumeMm3 / 1000) * metal.densityGcm3;
  const pourWeightG = mouldMetalG + Math.max(1, mouldMetalG * 0.1);

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
      gatingVolumeMm3,
      sprueDiaMm: opts.addGating ? sprueDia : 0,
      riserDiaMm: opts.addGating && riserWanted ? riserDia : 0,
      partingFromBaseMm: parting,
      pourC: metal.pourC,
      undrawablePercent,
    },
  };
}
