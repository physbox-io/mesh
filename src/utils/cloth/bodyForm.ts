/**
 * A dress form from tape measurements: the torso a stack of elliptical
 * slices, each sized so its circumference is what a tape would read there,
 * with capsules for the neck, shoulders, arms and legs. Convex primitives
 * only, so it collides as drawn. Stands on the floor at its body's origin,
 * facing -Y (the front of a garment is at -Y), MuJoCo Z-up, metres.
 *
 * Proportions not given by a measurement (where the waist is, how deep a
 * chest is for its width) are the usual fractions of height.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom } from '../../types/scene';

export const DEFAULT_BODY_FORM: BodyFormMeasurements = {
  height: 1.75,
  chest: 1.0,
  waist: 0.84,
  hip: 1.0,
  neck: 0.38,
  shoulderWidth: 0.44,
  armLength: 0.6,
  upperArm: 0.3,
  armAngle: 45,
  legs: true,
};

/** Limits the inspector and MCP clamp to, metres (degrees for the arm). */
export const BODY_FORM_LIMITS: Record<Exclude<keyof BodyFormMeasurements, 'legs'>, [number, number]> = {
  height: [0.9, 2.2],
  chest: [0.5, 1.6],
  waist: [0.4, 1.6],
  hip: [0.5, 1.7],
  neck: [0.25, 0.55],
  shoulderWidth: [0.25, 0.6],
  armLength: [0.35, 0.85],
  upperArm: [0.15, 0.5],
  armAngle: [10, 90],
};

export function clampBodyForm(m: Partial<BodyFormMeasurements>): BodyFormMeasurements {
  const out = { ...DEFAULT_BODY_FORM, ...m };
  for (const [k, [lo, hi]] of Object.entries(BODY_FORM_LIMITS) as [keyof typeof BODY_FORM_LIMITS, [number, number]][]) {
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_BODY_FORM[k];
  }
  out.legs = out.legs !== false;
  return out;
}

/** Semi-axis across for an ellipse of circumference `c` whose depth is `k` times its width (Ramanujan). */
export function ellipseHalfWidth(c: number, k: number): number {
  return c / (Math.PI * (3 * (1 + k) - Math.sqrt((3 + k) * (1 + 3 * k))));
}

/** Where things are on a form, for drafting garments onto it. Body frame. */
export interface BodyLandmarks {
  /** Height of the shoulder line (top of the shoulders, at the neck: HPS). */
  hpsZ: number;
  shoulderZ: number;
  bustZ: number;
  waistZ: number;
  hipZ: number;
  crotchZ: number;
  /** Half-depth of the chest, front to back. */
  chestDepth: number;
  /** Half-width of the hips. */
  hipHalf: number;
  hipDepth: number;
  neckRadius: number;
  /** Shoulder point, +x side. */
  shoulderPoint: number[];
  /** Unit direction down the +x arm. */
  armDir: number[];
  armRadius: number;
  armLength: number;
}

export function bodyLandmarks(m: BodyFormMeasurements): BodyLandmarks {
  const H = m.height;
  const shoulderZ = 0.815 * H;
  const shoulderR = 0.045 * (H / 1.75);
  const th = (m.armAngle * Math.PI) / 180;
  const chestHalf = ellipseHalfWidth(m.chest, 0.7);
  const hipHalf = ellipseHalfWidth(m.hip, 0.72);
  return {
    hpsZ: shoulderZ + shoulderR,
    shoulderZ,
    bustZ: 0.72 * H,
    waistZ: 0.62 * H,
    hipZ: 0.53 * H,
    crotchZ: 0.47 * H,
    chestDepth: 0.7 * chestHalf,
    hipHalf,
    hipDepth: 0.72 * hipHalf,
    neckRadius: m.neck / (2 * Math.PI),
    shoulderPoint: [m.shoulderWidth / 2, 0, shoulderZ],
    armDir: [Math.cos(th), 0, -Math.sin(th)],
    armRadius: m.upperArm / (2 * Math.PI),
    armLength: m.armLength,
  };
}

const r4 = (x: number) => +x.toFixed(4);

/** The form's geoms, named `<prefix>_<part>`. */
export function bodyFormGeoms(m: BodyFormMeasurements, prefix: string): SceneGeom[] {
  const L = bodyLandmarks(m);
  const H = m.height, s = H / 1.75;
  const rgba = [0.93, 0.89, 0.82, 1];
  const geoms: SceneGeom[] = [];
  const add = (name: string, g: Omit<SceneGeom, 'name' | 'rgba'>) => geoms.push({ name: `${prefix}_${name}`, rgba, ...g } as SceneGeom);

  // The torso: tape measurements at a few heights ([height, circumference,
  // depth over width], top to bottom), eased between with a cosine and cut
  // into many thin overlapping slices. Seven fat ones read as a stack of rings.
  const keys: [number, number, number][] = [
    [L.shoulderZ - 0.05 * s, m.chest * 0.93, 0.6],
    [L.bustZ, m.chest, 0.7],
    [L.waistZ, m.waist, 0.74],
    [L.hipZ, m.hip, 0.72],
    [L.crotchZ + 0.03 * s, m.hip * 0.94, 0.7],
  ];
  const top = keys[0][0], bottom = keys[keys.length - 1][0];
  const N = 9, step = (top - bottom) / (N - 1);
  const at = (z: number): [number, number] => {
    for (let i = 0; i < keys.length - 1; i++) {
      const [z0, c0, k0] = keys[i], [z1, c1, k1] = keys[i + 1];
      if (z <= z0 + 1e-9 && z >= z1 - 1e-9) {
        const t = (1 - Math.cos((Math.PI * (z0 - z)) / (z0 - z1))) / 2;
        return [c0 + (c1 - c0) * t, k0 + (k1 - k0) * t];
      }
    }
    return [keys[keys.length - 1][1], keys[keys.length - 1][2]];
  };
  for (let i = 0; i < N; i++) {
    const z = top - i * step;
    const [c, k] = at(z);
    const a = ellipseHalfWidth(c, k);
    // The end slices taller, to round off the top of the chest and the seat.
    const half = i === 0 || i === N - 1 ? step * 1.3 : step * 0.9;
    add(`torso${i}`, { type: 'ellipsoid', size: [r4(a), r4(a * k), r4(half)], pos: [0, 0, r4(z)] });
  }

  const shoulderR = 0.045 * s;
  const sx = m.shoulderWidth / 2 - shoulderR * 0.6;
  add('shoulders', { type: 'capsule', size: [r4(shoulderR)], fromto: [-sx, 0, r4(L.shoulderZ), sx, 0, r4(L.shoulderZ)] });
  add('neck', { type: 'capsule', size: [r4(L.neckRadius)], fromto: [0, 0, r4(L.shoulderZ), 0, 0, r4(0.875 * H)] });
  add('head', { type: 'ellipsoid', size: [r4(0.075 * s), r4(0.095 * s), r4(0.115 * s)], pos: [0, 0, r4(H - 0.115 * s)] });

  for (const side of [1, -1]) {
    const tag = side > 0 ? 'L' : 'R'; // the wearer's left is +x, facing -y
    const o = [side * sx, 0, L.shoulderZ];
    const d = [side * L.armDir[0], 0, L.armDir[2]];
    const elbow = o.map((v, k) => v + d[k] * m.armLength * 0.47);
    const wrist = o.map((v, k) => v + d[k] * m.armLength);
    add(`upperArm${tag}`, { type: 'capsule', size: [r4(L.armRadius)], fromto: [...o, ...elbow].map(r4) });
    add(`forearm${tag}`, { type: 'capsule', size: [r4(L.armRadius * 0.8)], fromto: [...elbow, ...wrist].map(r4) });
  }

  if (m.legs) {
    const thighR = (m.hip * 0.58) / (2 * Math.PI), calfR = thighR * 0.62;
    const kneeZ = 0.285 * H, ankleZ = 0.05 * H;
    for (const side of [1, -1]) {
      const tag = side > 0 ? 'L' : 'R';
      const x = side * L.hipHalf * 0.48;
      add(`thigh${tag}`, { type: 'capsule', size: [r4(thighR)], fromto: [x, 0, r4(L.crotchZ + 0.04 * s), r4(x * 0.85), 0, r4(kneeZ)] });
      add(`calf${tag}`, { type: 'capsule', size: [r4(calfR)], fromto: [r4(x * 0.85), 0, r4(kneeZ), r4(x * 0.8), 0, r4(ankleZ)] });
      add(`foot${tag}`, { type: 'box', size: [r4(0.045 * s), r4(0.12 * s), r4(0.03 * s)], pos: [r4(x * 0.8), r4(-0.06 * s), r4(0.03 * s)] });
    }
  } else {
    // A dress form's stand.
    add('pole', { type: 'cylinder', size: [0.015, r4((L.crotchZ + 0.03 * s) / 2)], pos: [0, 0, r4((L.crotchZ + 0.03 * s) / 2)] });
    add('base', { type: 'cylinder', size: [0.22, 0.015], pos: [0, 0, 0.015] });
  }
  return geoms;
}
