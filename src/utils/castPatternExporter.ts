// ---------------------------------------------------------------------------
// Casting — the pattern, not the part
// ---------------------------------------------------------------------------
//
// The other exports hand you the part. This one hands you the *pattern*: the
// printed positive that ends up as a cavity with metal in it. Two routes to
// that cavity, and the pattern differs between them:
//
//   - Green sand. The pattern is rammed in sand and pulled back out, so it is
//     reusable, it has to draw, and the gating is rammed in alongside it.
//   - Lost PLA. The pattern is invested in plaster and burnt out, so it is
//     consumed, it never has to draw — undercuts are free — and the gating has
//     to be fused to it, because there is nothing else holding it in place.
//
// A pattern is not the part. Three things separate them:
//
//   - It is scaled up by the metal's shrink allowance, because metal contracts
//     as it freezes, so a pattern the size of the part casts a part that is
//     too small.
//   - It carries the gating: a sprue to pour down, a runner along the parting
//     line, a gate into the cavity, and a riser to feed the shrinkage. Printed
//     as one piece with the part, ramming sand around it forms the channels.
//   - In sand, it has to *draw* from the ram, so anything that overhangs the
//     pull direction locks it in. That is the same analysis the mill uses to
//     find what it cannot reach, run here to find what will not pull. In lost
//     PLA nothing pulls, so the same number stops being a defect and becomes
//     the reason to have chosen burnout: it is reported either way, and only
//     the sand route treats it as a problem.
//
// The pattern is meant to be 3D printed, so the printer imposes no shape limit;
// in sand the only geometry rule is that it draws. Everything here is
// millimetres, and for sand the pull is straight up (+Z) from a flat parting
// plane, which suits the flat-backed, convex-ish patterns that route is for.
// Undercuts are reported, not fixed: adding draft is a modelling job, and the
// walkthrough says how much to add.

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

/**
 * Which of the two routes the pattern is being printed for. They share the
 * shrink allowance, the weight arithmetic and the sprue sizing, and differ in
 * everything the pattern is shaped for.
 */
export type CastMethod = 'sand' | 'lost-pla';

export const CAST_METHODS: { id: CastMethod; label: string; blurb: string }[] = [
  {
    id: 'sand',
    label: 'Green Sand',
    blurb: 'Ram sand around a reusable printed pattern, pull it out, pour into the hollow.',
  },
  {
    id: 'lost-pla',
    label: 'Lost PLA',
    blurb: 'Invest the printed pattern in plaster, burn it out, pour into the space it left.',
  },
];

export function castMetal(id: string): CastMetal {
  return CAST_METALS.find((m) => m.id === id) ?? CAST_METALS[0];
}

export interface CastOptions {
  /** Sand (draw the pattern back out) or lost PLA (burn the pattern out). */
  method: CastMethod;
  /** Which metal, which sets shrink, density and the pour-temperature note. */
  metalId: string;
  /**
   * Parting plane height in mm, measured from the part's base, or 'auto' to
   * search a few heights and take whichever leaves the least material trapped.
   */
  partingFromBaseMm: number | 'auto';
  /**
   * Print the feed system as part of the pattern: in sand the sprue, runner,
   * gate and riser that ramming forms into channels; in lost PLA the sprue,
   * pouring cup and vents fused to the pattern, which burn out with it.
   */
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
  method: 'sand',
  metalId: 'aluminium',
  partingFromBaseMm: 'auto',
  addGating: true,
  sprueDiaMm: 0,
  riserDiaMm: 0,
  addRiser: true,
  recommendedDraftDeg: 2,
};

export interface CastSummary {
  method: CastMethod;
  methodLabel: string;
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
  /**
   * Where the metal enters the casting, in pattern coordinates (plan, mm from
   * the pattern's centre). In sand that is the point on the parting plane the
   * runner gates into; in lost PLA it is where the sprue is fused on. It is on
   * metal by construction — it is read off the sampled columns — which is the
   * whole reason it is reported: a gate that ends in mid-air is the failure
   * this went looking for.
   */
  gateAtMm: { x: number; y: number };
  partingFromBaseMm: number;
  pourC: number;
  /**
   * Share of the part's volume that overhangs a straight upward pull. In sand
   * that material will not draw and the casting is in trouble; in lost PLA
   * nothing is pulled, so the same figure is just a note on what the burnout
   * route is buying. 0 for a flat-backed convex part.
   */
  undrawablePercent: number;
  /**
   * Lost PLA only: the flask to invest in, and the investment to mix for it.
   * The flask is sized to leave a hand's width of plaster around the pattern —
   * 12 mm at the sides and under the base, which is the usual minimum before
   * the shell starts blowing out — and the mix is what fills it around the
   * pattern at the standard 100:40 powder-to-water ratio.
   */
  flaskDiaMm: number;
  flaskHeightMm: number;
  investmentPowderG: number;
  investmentWaterG: number;
  /** Lost PLA only: roughly what the pattern costs in filament, grams. */
  patternPlasticG: number;
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

/** A vertical truncated cone (axis along Z), for the pouring cup. */
function appendCone(out: number[], cx: number, cy: number, z0: number, z1: number, r0: number, r1: number, seg = 24): void {
  const top = [cx, cy, z1];
  const bot = [cx, cy, z0];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI;
    const a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p0 = [cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0), z0];
    const p1 = [cx + r0 * Math.cos(a1), cy + r0 * Math.sin(a1), z0];
    const q0 = [cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0), z1];
    const q1 = [cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1), z1];
    pushTri(out, bot, p1, p0);
    pushTri(out, top, q0, q1);
    pushTri(out, p0, p1, q1);
    pushTri(out, p0, q1, q0);
  }
}

/** A rectangular beam of width `w` running from (ax, ay) to (bx, by), between two heights. */
function appendBeam(out: number[], ax: number, ay: number, bx: number, by: number, w: number, z0: number, z1: number): void {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const nx = (-dy / len) * (w / 2), ny = (dx / len) * (w / 2);
  const p = [
    [ax + nx, ay + ny, z0], [bx + nx, by + ny, z0], [bx - nx, by - ny, z0], [ax - nx, ay - ny, z0],
    [ax + nx, ay + ny, z1], [bx + nx, by + ny, z1], [bx - nx, by - ny, z1], [ax - nx, ay - ny, z1],
  ];
  const face = (a: number, b: number, c: number, d: number) => {
    pushTri(out, p[a], p[b], p[c]);
    pushTri(out, p[a], p[c], p[d]);
  };
  face(0, 3, 2, 1); face(4, 5, 6, 7);
  face(0, 1, 5, 4); face(2, 3, 7, 6);
  face(1, 2, 6, 5); face(3, 0, 4, 7);
}

/**
 * The body in the scene that freezes last, and where it sits in plan.
 *
 * Feeding is a question of *modulus* — volume over cooling surface — not of
 * volume, and not of how far out something reaches. A slender post can hold
 * several times the metal of a ball and still freeze first, because it has the
 * surface to lose it through; the ball is what pulls a sink as it solidifies,
 * and the ball is therefore where a feeder belongs. Picking the extreme corner
 * of the bounding box instead put the rig wherever the part happened to reach
 * furthest, which is nothing to do with what needs feeding.
 *
 * Bodies come from the scene's own solids, which are closed primitives, so
 * volume and area per body are both exact. The plan centroid is area-weighted
 * over the body's triangles — good enough to aim a sprue at, and it does not
 * care whether the body is convex.
 */
function heaviestSection(part: Float64Array, solidIds: number[]): { x: number; y: number; modulusMm: number; baseZ: number; topZ: number } | null {
  const vol = new Map<number, number>();
  const area = new Map<number, number>();
  const wx = new Map<number, number>();
  const wy = new Map<number, number>();
  const lo = new Map<number, number>();
  const hi = new Map<number, number>();
  const add = (m: Map<number, number>, id: number, v: number) => m.set(id, (m.get(id) ?? 0) + v);
  for (let i = 0, t = 0; i < part.length; i += 9, t++) {
    const id = solidIds[t] ?? 0;
    const ax = part[i], ay = part[i + 1], az = part[i + 2];
    const bx = part[i + 3], by = part[i + 4], bz = part[i + 5];
    const cx = part[i + 6], cy = part[i + 7], cz = part[i + 8];
    add(vol, id, (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    add(area, id, a);
    add(wx, id, (a * (ax + bx + cx)) / 3);
    add(wy, id, (a * (ay + by + cy)) / 3);
    lo.set(id, Math.min(lo.get(id) ?? Infinity, az, bz, cz));
    hi.set(id, Math.max(hi.get(id) ?? -Infinity, az, bz, cz));
  }
  let best: { x: number; y: number; modulusMm: number; baseZ: number; topZ: number } | null = null;
  for (const [id, a] of area) {
    const v = Math.abs(vol.get(id) ?? 0);
    if (v <= 0 || a <= 0) continue;
    const m = v / a;
    if (!best || m > best.modulusMm) {
      best = { x: (wx.get(id) ?? 0) / a, y: (wy.get(id) ?? 0) / a, modulusMm: m, baseZ: lo.get(id) ?? 0, topZ: hi.get(id) ?? 0 };
    }
  }
  return best;
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
 * Turns a scene into a casting pattern, ready to print — rammable in green sand
 * or investable for burnout, depending on `method`.
 */
export function generateCastPattern(scene: SceneGraph, userOptions?: Partial<CastOptions>): CastResult {
  const opts: CastOptions = { ...DEFAULT_CAST_OPTIONS, ...userOptions };
  const metal = castMetal(opts.metalId);
  const lostPla = opts.method === 'lost-pla';
  const methodLabel = CAST_METHODS.find((m) => m.id === opts.method)?.label ?? CAST_METHODS[0].label;
  const warnings: string[] = [];

  const fail = (error: string): CastResult => ({
    success: false,
    error,
    warnings,
    patternStl: new Uint8Array(84),
    summary: {
      method: opts.method,
      methodLabel,
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
      gateAtMm: { x: 0, y: 0 },
      partingFromBaseMm: 0,
      pourC: metal.pourC,
      undrawablePercent: 0,
      flaskDiaMm: 0,
      flaskHeightMm: 0,
      investmentPowderG: 0,
      investmentWaterG: 0,
      patternPlasticG: 0,
    },
  });

  const { tris: sceneTris, solidIds, skipped, warnings: sceneWarnings } = collectSceneTriangles(scene);
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
  if (undrawablePercent > 1 && !lostPla) {
    warnings.push(
      `About ${undrawablePercent.toFixed(0)}% of the part overhangs the upward pull, so the pattern ` +
        `will not draw cleanly from the sand there. Add ${opts.recommendedDraftDeg}° draft to the walls, ` +
        `move the parting plane, or switch to Lost PLA and burn the pattern out instead of pulling it.`
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
  // surface) must beat the casting's by the usual 20% margin.
  //
  // Its height comes from its own diameter, not from the part's. Tying it to
  // the height of the bounding box is what made a riser on a tall, skeletal
  // scene — a pendulum, a bracket on a post — into a 30 mm column six hundred
  // millimetres tall holding more aluminium than the casting it was feeding.
  // The top of a column that tall has frozen long before the metal at its base
  // is needed, so all that extra height feeds nothing; the standard proportion
  // is H = 1.5 D, and at that proportion a side riser fed from its base has
  // modulus 0.214 D, so the modulus condition is simply D ≥ 4.67 × the modulus
  // required. The riser must also hold the shrinkage it is there to feed —
  // about the metal's contraction, at the ~14% yield a plain cylindrical riser
  // manages — which at the same proportion is a cube root. The bigger wins.
  const partAreaMm2 = triSoupArea(part);
  const castModulusMm = partAreaMm2 > 0 ? partVolumeMm3 / partAreaMm2 : 0;
  const reqModulusMm = castModulusMm * 1.2;
  const modulusDia = reqModulusMm / 0.2143;
  const feedVolMm3 = (partVolumeMm3 * metal.shrinkPercent) / 100 / 0.14;
  const volumeDia = Math.cbrt(feedVolMm3 / (0.375 * Math.PI));
  const autoRiserDia = Math.min(40, Math.max(modulusDia, volumeDia));
  // And the part may simply not want a riser. A casting whose modulus is under
  // a millimetre — a plate thinner than about 2 mm, a jewellery band — freezes
  // in a second or two and is fed perfectly well back through its own gate and
  // sprue; likewise a riser that works out under 5 mm across holds no useful
  // reserve and would freeze first, doing nothing but adding a stub to cut off.
  // An explicitly requested diameter is always honoured.
  // A riser standing off to one side is a sand thing: it needs a flask with
  // room beside the pattern and sand that will hold a second tall column. In
  // burnout the pouring cup is the feeder — it sits directly over the sprue,
  // full of metal, and stays liquid longest — so the riser is simply not part
  // of that rig, and asking for one is quietly ignored rather than printed.
  const riserWanted =
    !lostPla &&
    opts.addRiser &&
    (opts.riserDiaMm > 0 || (castModulusMm >= 1.0 && autoRiserDia >= 5 && Number.isFinite(autoRiserDia)));
  const riserDia = opts.riserDiaMm > 0 ? opts.riserDiaMm : autoRiserDia;
  if (opts.addRiser && !riserWanted && !lostPla) {
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

  // Where the rig goes, in plan. Two rules, in part coordinates and grown at
  // the end, both of them about the metal rather than about the bounding box:
  //
  //   - The riser goes as close as it can get to the section that freezes last,
  //     because that is the section that pulls a sink. Not the biggest body —
  //     modulus, so a 20 mm ball beats a 20 mm post that holds four times the
  //     metal — and not the furthest-out corner of the box, which is what this
  //     used to use and is simply unrelated to feeding.
  //   - The gate goes at the far end of the casting from the riser, so the
  //     metal runs the length of the mould towards the feeder and arrives at it
  //     last and hottest.
  //
  // Both have to sit where the parting plane actually cuts metal, because a
  // runner is a channel rammed along that plane and a gate has to open into a
  // cavity that exists there. That is what the old rule got wrong in the other
  // direction: at half the pattern's width, on a sparse scene, there is nothing
  // to gate into but air, and the rig came out as a sprue to nothing.
  const colX = (i: number) => bounds2d.minX + (i * (bounds2d.maxX - bounds2d.minX)) / (cols - 1);
  const colY = (j: number) => bounds2d.minY + (j * (bounds2d.maxY - bounds2d.minY)) / (rows - 1);
  const heavy = heaviestSection(part, solidIds);

  /** Columns the parting plane passes through material in, as plan points. */
  const onPlane: { x: number; y: number }[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (!hit[k] || thickness[k] <= 0) continue;
      if (bottom[k] > parting + 1e-6 || top[k] < parting - 1e-6) continue;
      onPlane.push({ x: colX(i), y: colY(j) });
    }
  }
  const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  let riserPt = { x: -partW / 2, y: 0 };
  let gatePt = { x: partW / 2, y: 0 };
  if (onPlane.length > 0) {
    const aim = heavy ?? { x: 0, y: 0 };
    riserPt = onPlane.reduce((best, p) => (dist2(p, aim) < dist2(best, aim) ? p : best), onPlane[0]);
    // The far end, and then the middle of that end. Taking the single furthest
    // point puts the gate on a corner, which is the thinnest, first-frozen
    // scrap of the section it is trying to fill. So the axis is the line from
    // the feeder through the middle of the metal on the plane — the length of
    // the casting, as it were — and the gate is the point furthest along it
    // with the least sideways offset, which is the middle of the far end.
    const mid = onPlane.reduce((a, p) => ({ x: a.x + p.x / onPlane.length, y: a.y + p.y / onPlane.length }), { x: 0, y: 0 });
    let axX = mid.x - riserPt.x, axY = mid.y - riserPt.y;
    if (Math.hypot(axX, axY) < 1e-6) {
      // The feeder is already in the middle of it: fall back to the furthest
      // point to fix a direction at all.
      const far0 = onPlane.reduce((best, p) => (dist2(p, riserPt) > dist2(best, riserPt) ? p : best), onPlane[0]);
      axX = far0.x - riserPt.x; axY = far0.y - riserPt.y;
    }
    const axLen0 = Math.hypot(axX, axY) || 1;
    const ax = axX / axLen0, ay = axY / axLen0;
    const along = (p: { x: number; y: number }) => (p.x - riserPt.x) * ax + (p.y - riserPt.y) * ay;
    const lateral = (p: { x: number; y: number }) => Math.abs(-(p.x - riserPt.x) * ay + (p.y - riserPt.y) * ax);
    const reach = onPlane.reduce((m, p) => Math.max(m, along(p)), -Infinity);
    const farEnd = onPlane.filter((p) => along(p) >= reach - Math.max(res, 2));
    gatePt = farEnd.reduce((best, p) => (lateral(p) < lateral(best) ? p : best), farEnd[0]);
  }
  // Nothing on the plane at all — a scene of bodies floating clear of it. The
  // box edges stand in, and the draw warning is already saying the louder thing.

  /**
   * Walks out from a point on the metal in a direction until the plan outline
   * is behind it, and then a clearance further. That is where a sprue or a
   * riser can stand: beside the casting, with sand between, rather than merged
   * into the side of it.
   */
  const standOff = (from: { x: number; y: number }, dx: number, dy: number, clearance: number) => {
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const step = Math.max(res, 0.5);
    const maxT = Math.hypot(bounds2d.maxX - bounds2d.minX, bounds2d.maxY - bounds2d.minY);
    let exit = 0;
    for (let t = 0; t <= maxT; t += step) {
      const x = from.x + ux * t, y = from.y + uy * t;
      const i = Math.round(((x - bounds2d.minX) * (cols - 1)) / (bounds2d.maxX - bounds2d.minX));
      const j = Math.round(((y - bounds2d.minY) * (rows - 1)) / (bounds2d.maxY - bounds2d.minY));
      if (i < 0 || j < 0 || i >= cols || j >= rows) break;
      if (hit[j * cols + i] && thickness[j * cols + i] > 0) exit = t;
    }
    return { x: from.x + ux * (exit + clearance), y: from.y + uy * (exit + clearance) };
  };

  // Out along the gate-to-riser line, each away from the other, so the rig lies
  // along the length of the casting instead of across whichever axis is X.
  let awayX = gatePt.x - riserPt.x, awayY = gatePt.y - riserPt.y;
  if (Math.hypot(awayX, awayY) < 1e-6) { awayX = 1; awayY = 0; }
  const sprueAt = standOff(gatePt, awayX, awayY, gap + sprueDia / 2);
  const gateAtPart = gatePt;
  const riserStandAt = standOff(riserPt, -awayX, -awayY, gap + riserDia / 2);

  // The plane in pattern coordinates: `parting` is measured on the part, and
  // everything printed has been grown away from it by the shrink allowance.
  const partingZ = parting * grow;
  const gateLen = Math.min(5, Math.max(2, sprueDia));
  let gatingVolumeMm3 = 0;
  // The top of the printed rig, whatever the route: the flask has to swallow it.
  let rigTopZ = gPartH;
  // Where the metal goes in, filled by whichever branch builds the rig.
  const gateAt = { x: 0, y: 0 };
  if (opts.addGating && !lostPla) {
    // Everything below is laid out along the gate-to-riser line rather than
    // along X, so the rig follows the casting whichever way it lies.
    const gateG = { x: gateAtPart.x * grow, y: gateAtPart.y * grow };
    const sprueG = { x: sprueAt.x * grow, y: sprueAt.y * grow };
    gateAt.x = gateG.x; gateAt.y = gateG.y;
    // Downsprue, from the parting plane it pours into up to the top of the
    // cope. Below the plane it would only be a blind stub in the drag.
    appendCylinder(pat, sprueG.x, sprueG.y, partingZ, sprueTop, sprueDia / 2);
    gatingVolumeMm3 += (Math.PI * sprueDia * sprueDia * Math.max(0, sprueTop - partingZ)) / 4;
    rigTopZ = Math.max(rigTopZ, sprueTop);
    // Runner along the parting plane, from the sprue to the gate — which is on
    // metal, because it was chosen from the columns the plane cuts.
    const runLen = Math.hypot(sprueG.x - gateG.x, sprueG.y - gateG.y);
    appendBeam(pat, gateG.x, gateG.y, sprueG.x, sprueG.y, runnerH, partingZ, partingZ + runnerH);
    gatingVolumeMm3 += runLen * runnerH * runnerH;
    // A short gate stub, thinner than the runner so it freezes first and the
    // runner cannot suck back out of the casting, reaching into the metal.
    const backX = (gateG.x - sprueG.x) / (runLen || 1), backY = (gateG.y - sprueG.y) / (runLen || 1);
    appendBeam(pat, gateG.x, gateG.y, gateG.x + backX * gateLen, gateG.y + backY * gateLen, runnerH, partingZ, partingZ + runnerH * 0.7);
    gatingVolumeMm3 += gateLen * runnerH * runnerH * 0.7;
    if (riserWanted) {
      // Riser on the far side: a side feeder standing on the parting plane and
      // joined to the casting by a neck along it, 1.5 diameters tall rather
      // than as tall as the part happens to be. Feeding is a question of
      // modulus, not of height — a column taller than this has frozen at the
      // top before its metal is called for.
      const riserG = { x: riserStandAt.x * grow, y: riserStandAt.y * grow };
      const neckG = { x: riserPt.x * grow, y: riserPt.y * grow };
      const riserH = riserDia * 1.5;
      appendCylinder(pat, riserG.x, riserG.y, partingZ, partingZ + riserH, riserDia / 2);
      gatingVolumeMm3 += (Math.PI * riserDia * riserDia * riserH) / 4;
      rigTopZ = Math.max(rigTopZ, partingZ + riserH);
      const neckLen = Math.hypot(neckG.x - riserG.x, neckG.y - riserG.y);
      appendBeam(pat, riserG.x, riserG.y, neckG.x, neckG.y, runnerH, partingZ, partingZ + runnerH);
      gatingVolumeMm3 += neckLen * runnerH * runnerH;
    }
  } else if (opts.addGating && lostPla) {
    // Burnout gating is a different shape of thing, because nothing rams it and
    // nothing pulls it: it has to be fused to the pattern, it has to be where
    // the molten PLA can run out of it, and it doubles as the feeder, since a
    // flask has no room for a riser standing off to one side.
    //
    //   - The sprue lands on the section that freezes last — the heaviest lump
    //     by modulus, the ball on the end rather than the long thin arm that
    //     carries it. The cup above it is the only feeder this rig has, so it
    //     has to be over the metal that will pull a sink, and a sprue put
    //     anywhere else feeds the casting through the very section that freezes
    //     first. (It used to go on the highest point, which is the same place
    //     only by luck.) It attaches at the top of that column, so it rises
    //     through air rather than back down into the pattern.
    //   - The cup on top is a cone, which is both the pouring basin and the
    //     head of metal that feeds the shrinkage as the casting freezes.
    //   - Vents rise from the far high points. Investment is not permeable the
    //     way sand is, so without them the air in a blind pocket stops the
    //     metal dead, and the burnout gas has nowhere to leave from either.
    const sprueR = sprueDia / 2;
    // The heavy section's plan centroid, snapped to the nearest column that
    // actually has metal under it — a centroid can fall down a hole, and a
    // sprue has to land on something. In part coordinates, grown to the pattern
    // when it is drawn.
    let attX = 0, attY = 0, attTop = partH;
    const aimAt = heavy ?? { x: 0, y: 0 };
    let bestScore = -Infinity;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (!hit[k] || thickness[k] <= 0) continue;
        const x = bounds2d.minX + (i * (bounds2d.maxX - bounds2d.minX)) / (cols - 1);
        const y = bounds2d.minY + (j * (bounds2d.maxY - bounds2d.minY)) / (rows - 1);
        // Nearest to the heavy section, with a nudge towards the thicker of two
        // equally close columns so the sprue sits on the bulk of it rather than
        // on the skin at its edge.
        const score = -Math.hypot(x - aimAt.x, y - aimAt.y) + 0.1 * thickness[k];
        if (score > bestScore) { bestScore = score; attX = x; attY = y; attTop = top[k]; }
      }
    }
    gateAt.x = attX * grow; gateAt.y = attY * grow;
    const sprueZ0 = Math.max(0, attTop * grow - 2); // buried 2 mm, so it fuses
    // The cup has to finish above everything, not just above whatever the sprue
    // happens to stand on: it is the top of the flask and the thing the metal
    // is poured into. A sprue rooted on a low heavy section still rises clear
    // of the tallest part of the pattern first.
    const sprueZ1 = Math.max(attTop * grow, gPartH) + Math.max(12, sprueDia * 2);
    appendCylinder(pat, attX * grow, attY * grow, sprueZ0, sprueZ1, sprueR);
    gatingVolumeMm3 += Math.PI * sprueR * sprueR * Math.max(0, sprueZ1 - sprueZ0);
    // Pouring cup: a cone opening out to three sprue diameters, deep enough to
    // hold a head of metal over the sprue rather than just catch the stream.
    const cupH = Math.max(8, sprueDia * 1.6);
    const cupR = Math.max(sprueR * 3, 9);
    appendCone(pat, attX * grow, attY * grow, sprueZ1, sprueZ1 + cupH, sprueR, cupR);
    gatingVolumeMm3 += (Math.PI * cupH * (sprueR * sprueR + sprueR * cupR + cupR * cupR)) / 3;
    rigTopZ = Math.max(rigTopZ, sprueZ1 + cupH);
    // Vents, from the high points furthest from the sprue, up to the cup rim.
    const ventDia = Math.max(2, Math.min(4, sprueDia * 0.35));
    const minVentSpacing = Math.max(8, span * 0.25 * grow);
    // Vents still come off the high points — that is where the air collects,
    // whatever the sprue is doing.
    const vents: { x: number; y: number; z: number }[] = [];
    const ordered: number[] = [];
    for (let k = 0; k < hit.length; k++) if (hit[k]) ordered.push(k);
    ordered.sort((a, b) => top[b] - top[a]);
    for (const k of ordered) {
      if (vents.length >= 2) break;
      const i = k % cols, j = Math.floor(k / cols);
      const x = (bounds2d.minX + (i * (bounds2d.maxX - bounds2d.minX)) / (cols - 1)) * grow;
      const y = (bounds2d.minY + (j * (bounds2d.maxY - bounds2d.minY)) / (rows - 1)) * grow;
      if (Math.hypot(x - attX * grow, y - attY * grow) < minVentSpacing) continue;
      if (vents.some((v) => Math.hypot(x - v.x, y - v.y) < minVentSpacing)) continue;
      vents.push({ x, y, z: top[k] * grow });
    }
    for (const v of vents) {
      const z0 = Math.max(0, v.z - 1.5);
      appendCylinder(pat, v.x, v.y, z0, rigTopZ, ventDia / 2, 16);
      gatingVolumeMm3 += (Math.PI * ventDia * ventDia * Math.max(0, rigTopZ - z0)) / 4;
    }
    if (vents.length === 0) {
      warnings.push(
        'No room for a vent clear of the sprue on a pattern this small, so the sprue and cup have to ' +
          'let the air out on their own. Pour slowly and keep the cup full.'
      );
    }
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

  // Two sanity checks on the rig as a whole, because every number above is
  // locally reasonable and the result can still be something nobody would pour.
  // A tall, skeletal scene — a pendulum on a post, a bracket on a column — has
  // a bounding box the sprue has to top, and the channels then hold more metal
  // than the casting does. That is worth saying out loud rather than leaving
  // for someone to notice in the pattern preview.
  const castingMetalG = ((partVolumeMm3 * grow * grow * grow) / 1000) * metal.densityGcm3;
  const gatingMetalG = (gatingVolumeMm3 / 1000) * metal.densityGcm3;
  if (opts.addGating && gatingMetalG > castingMetalG) {
    warnings.push(
      `The gating holds more metal than the casting does — ${Math.round(gatingMetalG)} g of channel to ` +
        `${Math.round(castingMetalG)} g of part. The rig has to span the whole ${Math.round(gPartH)} mm ` +
        'height of the pattern, so a tall, mostly-empty scene pays for it in sprue. Cast it in pieces, ' +
        'or lay it down so it is wide rather than tall.'
    );
  }

  // --- The flask and the mix it takes, for burnout ---------------------------
  // Only meaningful for lost PLA, where the pattern is buried rather than
  // rammed. A round flask with 12 mm of investment at the sides and under the
  // base: less than that and the shell cracks off the moment steam tries to get
  // out. The cup is meant to finish flush with the top of the flask, so the
  // flask is exactly as tall as the rig plus that base clearance. Set
  // plaster-silica investment runs about 1.75 g/cm³, mixed 100 parts powder to
  // 40 parts water by weight, so the mass that fills the flask around the
  // pattern divides straight into the two numbers to weigh out.
  const INVESTMENT_WALL_MM = 12;
  const INVESTMENT_DENSITY_GCM3 = 1.75;
  let flaskDiaMm = 0, flaskHeightMm = 0, investmentPowderG = 0, investmentWaterG = 0, patternPlasticG = 0;
  if (lostPla) {
    const rigSpan = Math.hypot(gPartW, gPartD);
    flaskDiaMm = rigSpan + 2 * INVESTMENT_WALL_MM;
    flaskHeightMm = rigTopZ + INVESTMENT_WALL_MM;
    const flaskVolMm3 = (Math.PI * flaskDiaMm * flaskDiaMm * flaskHeightMm) / 4;
    const patternVolMm3 = partVolumeMm3 * grow * grow * grow + gatingVolumeMm3;
    const investmentVolCm3 = Math.max(0, flaskVolMm3 - patternVolMm3) / 1000;
    const investmentG = investmentVolCm3 * INVESTMENT_DENSITY_GCM3;
    investmentPowderG = investmentG / 1.4;
    investmentWaterG = investmentPowderG * 0.4;
    // Filament: PLA at 1.24 g/cm³, printed at about a third solid — the walls
    // and sparse infill this pattern wants, not a solid block, since every gram
    // of it has to burn away and leave nothing behind.
    patternPlasticG = (patternVolMm3 / 1000) * 1.24 * 0.33;
    if (patternVolMm3 > 120_000) {
      warnings.push(
        `That is a lot of plastic to burn out (${Math.round(patternVolMm3 / 1000)} cm³ of pattern). Print it ` +
          'hollow — two or three walls and about 10% infill — with a drain hole into the sprue, or the PLA ' +
          'expands as it softens and splits the investment before it ever gets a chance to burn.'
      );
    }
    if (Math.min(partW, partD, partH) < 2) {
      warnings.push(
        `The thinnest section here is about ${Math.min(partW, partD, partH).toFixed(1)} mm. Investment holds ` +
          'fine detail well, but a section under ~2 mm freezes before it fills unless the flask is poured hot ' +
          'and the metal is helped in with vacuum or a centrifuge.'
      );
    }
  }

  // And the rig has to fit in something real. A home foundry's flask is a
  // biscuit tin and a kiln is a bucket; both run out well before a 600 mm
  // pattern does, and the investment for a flask that size is weighed in tens
  // of kilos, so the size is stated with what it would actually take.
  if (lostPla && (flaskDiaMm > 200 || flaskHeightMm > 300)) {
    warnings.push(
      `That flask is ⌀${Math.round(flaskDiaMm)} × ${Math.round(flaskHeightMm)} mm and would take about ` +
        `${(investmentPowderG / 1000).toFixed(1)} kg of investment. Hobby flasks are rarely over 150 mm, and ` +
        'a kiln that will burn one out is rarer still. Cast it in pieces and join them.'
    );
  } else if (!lostPla && Math.max(gPartW, gPartD, rigTopZ) > 300) {
    warnings.push(
      `The rig is ${Math.round(gPartW)} × ${Math.round(gPartD)} × ${Math.round(rigTopZ)} mm, which needs a ` +
        'flask bigger than most home foundries have and a crucible to match. Cast it in pieces and join them.'
    );
  }

  const patternStl = trisToBinaryStl(pat);

  return {
    success: true,
    warnings,
    patternStl,
    summary: {
      method: opts.method,
      methodLabel,
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
      gateAtMm: opts.addGating ? { x: gateAt.x, y: gateAt.y } : { x: 0, y: 0 },
      partingFromBaseMm: lostPla ? 0 : parting,
      pourC: metal.pourC,
      undrawablePercent,
      flaskDiaMm,
      flaskHeightMm,
      investmentPowderG,
      investmentWaterG,
      patternPlasticG,
    },
  };
}
