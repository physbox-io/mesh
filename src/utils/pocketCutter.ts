/**
 * A smooth pocket or dish, as a closed mesh to subtract.
 *
 * Woodworkers cut recesses all the time — a catch-all tray, a phone ledge, a
 * coin dish — and the only round cutter was a sphere, which at a normal facet
 * count comes out visibly stepped on a shallow 112 mm dish. This builds the
 * cutter from its outline, depth and floor directly, as dense as it needs to
 * be: concentric rings stepping in from the rim, each an inset of the outline,
 * dropping by the floor profile.
 *
 * The cutter's own frame: the rim on z = 0, the pocket going down into -z, and
 * a collar standing `overshootMm` above the rim so the subtraction never ends
 * flush with the surface it cuts. Millimetres in, millimetres out.
 */

export interface PocketSpec {
  /** 'rect' is a rounded rectangle; 'ellipse' with equal sides is a circle. */
  outline: 'rect' | 'ellipse';
  widthMm: number;
  lengthMm: number;
  depthMm: number;
  /** Plan-view corner radius of a rect. Ignored for an ellipse. */
  cornerRadiusMm?: number;
  /**
   * 'flat' is a flat floor meeting the wall in a fillet of `floorRadiusMm`
   * (default a quarter of the depth); 'bowl' is a smooth dish whose floor
   * flattens out towards the middle.
   */
  floor?: 'flat' | 'bowl';
  floorRadiusMm?: number;
}

export interface PocketMesh {
  /** Flat [x, y, z, ...], cutter frame, mm. */
  verts: number[];
  faces: number[];
}

const AROUND = 160;
const RINGS = 40;
/** A plan-view corner never sharper than this, so no ring collapses onto its corners. */
const MIN_CORNER_MM = 0.4;

/** The outline inset by `s`, sampled by outward normal angle so every ring lines up with the next. */
function ring(spec: PocketSpec, s: number): [number, number][] {
  const hw = spec.widthMm / 2 - s;
  const hl = spec.lengthMm / 2 - s;
  const pts: [number, number][] = [];
  for (let j = 0; j < AROUND; j++) {
    const phi = (2 * Math.PI * j) / AROUND;
    const c = Math.cos(phi), sn = Math.sin(phi);
    if (spec.outline === 'ellipse') {
      const a = Math.max(hw, 1e-3), b = Math.max(hl, 1e-3);
      const k = Math.sqrt(a * a * c * c + b * b * sn * sn);
      pts.push([(a * a * c) / k, (b * b * sn) / k]);
    } else {
      const r = Math.min(Math.max((spec.cornerRadiusMm ?? 0) - s, MIN_CORNER_MM), hw, hl);
      pts.push([Math.sign(c || 1) * (hw - r) + r * c, Math.sign(sn || 1) * (hl - r) + r * sn]);
    }
  }
  return pts;
}

/** How far down the floor is at distance `s` in from the rim, for an inset that runs out at `sMax`. */
function floorZ(spec: PocketSpec, s: number, sMax: number): number {
  const d = spec.depthMm;
  if (spec.floor === 'bowl') {
    const t = Math.min(1, s / sMax);
    return -d * (1 - (1 - t) * (1 - t));
  }
  const r = Math.min(spec.floorRadiusMm ?? d / 4, d, sMax);
  if (s >= r) return -d;
  return -(d - r) - Math.sqrt(Math.max(0, r * r - (r - s) * (r - s)));
}

export function pocketMesh(spec: PocketSpec, overshootMm = 1): PocketMesh {
  const sMax = Math.min(spec.widthMm, spec.lengthMm) / 2;
  // Stop a whisker short of the middle so the last ring is still a ring.
  const sEnd = sMax * 0.98;
  const flat = spec.floor !== 'bowl';
  const filletR = Math.min(spec.floorRadiusMm ?? spec.depthMm / 4, spec.depthMm, sMax);

  // Rings from the top of the collar down to the innermost floor ring.
  const rings: { pts: [number, number][]; z: number }[] = [];
  rings.push({ pts: ring(spec, 0), z: overshootMm });
  rings.push({ pts: ring(spec, 0), z: 0 });
  // A flat pocket's wall runs straight down to where the fillet starts.
  if (flat && spec.depthMm - filletR > 1e-6) rings.push({ pts: ring(spec, 0), z: -(spec.depthMm - filletR) });
  for (let i = 1; i <= RINGS; i++) {
    // Rings bunched towards the rim, where the floor curves fastest; for a
    // flat floor, all of them inside the fillet, plus a couple across the flat.
    const t = i / RINGS;
    const s = flat ? (i < RINGS ? filletR * (1 - Math.cos((t * Math.PI) / 2)) : sEnd) : sEnd * (1 - Math.cos((t * Math.PI) / 2));
    if (s <= 0 || (rings.length > 0 && s >= sEnd && i < RINGS)) continue;
    rings.push({ pts: ring(spec, s), z: floorZ(spec, s, sMax) });
  }

  const verts: number[] = [];
  const faces: number[] = [];
  for (const r of rings) for (const [x, y] of r.pts) verts.push(x, y, r.z);
  const at = (ri: number, j: number) => ri * AROUND + (j % AROUND);
  // Walls between consecutive rings, wound so their normals face out of the cutter.
  for (let ri = 0; ri + 1 < rings.length; ri++) {
    for (let j = 0; j < AROUND; j++) {
      const a = at(ri, j), b = at(ri, j + 1), c = at(ri + 1, j + 1), d = at(ri + 1, j);
      faces.push(a, d, b, b, d, c);
    }
  }
  // Caps: the collar top facing up, the innermost floor ring facing down.
  const top = verts.length / 3;
  verts.push(0, 0, overshootMm);
  for (let j = 0; j < AROUND; j++) faces.push(top, at(0, j), at(0, j + 1));
  const last = rings.length - 1;
  const bottom = verts.length / 3;
  verts.push(0, 0, rings[last].z);
  for (let j = 0; j < AROUND; j++) faces.push(bottom, at(last, j + 1), at(last, j));
  return { verts, faces };
}
