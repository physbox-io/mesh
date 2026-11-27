import type { SceneNode } from '../types/scene';

/** Vacuum permeability mu_0 in T*m/A (N/A^2). */
export const MU_0 = 4 * Math.PI * 1e-7;

/** mu_0 / (4 * pi) = 1e-7 N/A^2. */
const MU_0_OVER_4PI = 1e-7;

/** Default remanence B_r for N42 neodymium magnets (Tesla). */
export const DEFAULT_BR_TESLA = 1.30;

/** Fallback magnet dimensions [diameterMm, thicknessMm] when size cannot be parsed. */
export const DEFAULT_MAGNET_SIZE_MM: readonly [number, number] = [8, 3];

export type Vec3 = [number, number, number];

export interface MagnetBody {
  bodyId: number;
  weldId: number;
  /** Rigid-body mass of the welded assembly (kg), used for CFL-safe force/damping bounds. */
  massKg?: number;
  radiusM: number;
  thicknessM: number;
  /** Magnetic dipole moment magnitude in A*m^2 (N42 B_r = 1.30 T). */
  momentAm2: number;
  /** +1 = North along local +Z, -1 = North along local -Z. */
  polarity: 1 | -1;
}

export interface DipoleInteraction {
  f1: Vec3;
  f2: Vec3;
  tau1: Vec3;
  tau2: Vec3;
}

/**
 * Parse a magnet size string like "8×3", "8x3", or "10 × 2.5" into
 * [diameterMm, thicknessMm]. Returns null if the string does not match.
 */
export function parseMagnetSizeMm(size: string): [number, number] | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*$/.exec(size);
  if (!match) return null;
  const diameter = Number(match[1]);
  const thickness = Number(match[2]);
  if (!Number.isFinite(diameter) || !Number.isFinite(thickness) || diameter <= 0 || thickness <= 0) {
    return null;
  }
  return [diameter, thickness];
}

/**
 * Compute the magnetic dipole moment magnitude (in A*m^2) of an axially
 * magnetized cylindrical disc magnet with diameter `diameterMm`, thickness
 * `thicknessMm`, and remanence `brTesla` (default 1.30 T for N42).
 *
 *   V = pi * (d / 2)^2 * h
 *   m = (B_r / mu_0) * V
 */
export function magnetMomentAm2(
  diameterMm: number,
  thicknessMm: number,
  brTesla = DEFAULT_BR_TESLA,
): number {
  const radiusM = (diameterMm * 0.5) * 1e-3;
  const heightM = thicknessMm * 1e-3;
  const volumeM3 = Math.PI * radiusM * radiusM * heightM;
  return (brTesla / MU_0) * volumeM3;
}

function lookupBodyId(
  bodyIdCache: Map<string, number> | Record<string, number>,
  node: SceneNode,
): number | undefined {
  if (bodyIdCache instanceof Map) {
    return (node.name ? bodyIdCache.get(node.name) : undefined) ?? bodyIdCache.get(node.id);
  }
  const byName = node.name ? bodyIdCache[node.name] : undefined;
  return byName !== undefined ? byName : bodyIdCache[node.id];
}

/**
 * Recursively walk `nodes` and collect all magnet hardware parts that have a
 * resolved MuJoCo body ID.
 */
export function collectMagnetBodies(
  nodes: readonly SceneNode[],
  bodyIdCache: Map<string, number> | Record<string, number>,
  model: { body_weldid?: Int32Array | number[]; body_subtreemass?: Float64Array | number[]; body_mass?: Float64Array | number[] } | null,
): MagnetBody[] {
  const result: MagnetBody[] = [];

  const walk = (list: readonly SceneNode[] | undefined) => {
    if (!list) return;
    for (const node of list) {
      const hp = node.hardwarePart as
        | { kind?: string; size?: string; polarity?: number }
        | undefined;
      if (hp && hp.kind === 'magnet') {
        const bodyId = lookupBodyId(bodyIdCache, node);
        if (bodyId !== undefined && bodyId >= 0) {
          const [diameterMm, thicknessMm] =
            (hp.size ? parseMagnetSizeMm(hp.size) : null) ?? DEFAULT_MAGNET_SIZE_MM;
          const weldId =
            model?.body_weldid && bodyId < model.body_weldid.length
              ? model.body_weldid[bodyId]
              : bodyId;
          const polarity: 1 | -1 = hp.polarity === -1 ? -1 : 1;
          const massKg =
            model?.body_subtreemass && weldId > 0 && weldId < model.body_subtreemass.length
              ? model.body_subtreemass[weldId]
              : model?.body_mass && bodyId < model.body_mass.length
                ? model.body_mass[bodyId]
                : undefined;
          result.push({
            bodyId,
            weldId,
            ...(massKg && massKg > 0 ? { massKg } : {}),
            radiusM: (diameterMm * 0.5) * 1e-3,
            thicknessM: thicknessMm * 1e-3,
            momentAm2: magnetMomentAm2(diameterMm, thicknessMm),
            polarity,
          });
        }
      }
      if (node.children && node.children.length > 0) {
        walk(node.children);
      }
    }
  };

  walk(nodes);
  return result;
}

/**
 * Compute softened 3D magnetic dipole-dipole force and alignment torques
 * between two cylindrical magnets at world positions `p1`, `p2` with dipole
 * moment vectors `m1`, `m2` (A*m^2), radii `r1`, `r2` (m), and thicknesses
 * `t1`, `t2` (m).
 *
 * Returns `null` if the magnets are beyond the interaction cutoff or coincident.
 */
export function computeDipoleInteraction(
  p1: ArrayLike<number>,
  m1: ArrayLike<number>,
  r1: number,
  t1: number,
  p2: ArrayLike<number>,
  m2: ArrayLike<number>,
  r2: number,
  t2: number,
  brTesla = DEFAULT_BR_TESLA,
): DipoleInteraction | null {
  void t1;
  void t2;

  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const rz = p2[2] - p1[2];
  const r2Sq = rx * rx + ry * ry + rz * rz;
  const r = Math.sqrt(r2Sq);

  const cutoff = Math.max(0.15, 12 * (r1 + r2));
  if (r > cutoff || r < 1e-9) return null;

  // Unit separation vector r_hat = (p2 - p1) / |p2 - p1|.
  // Using r_hat inside the angular bracket preserves exact attractive/repulsive
  // signs and torque direction even inside the softening radius r_soft.
  const invR = 1 / r;
  const ux = rx * invR;
  const uy = ry * invR;
  const uz = rz * invR;

  const rSoft = 0.85 * (r1 + r2);
  const rEffSq = r2Sq + rSoft * rSoft;
  const rEff = Math.sqrt(rEffSq);
  const rEff3 = rEffSq * rEff;
  const rEff4 = rEffSq * rEffSq;

  const m1x = m1[0], m1y = m1[1], m1z = m1[2];
  const m2x = m2[0], m2y = m2[1], m2z = m2[2];

  const m1DotU = m1x * ux + m1y * uy + m1z * uz;
  const m2DotU = m2x * ux + m2y * uy + m2z * uz;
  const m1DotM2 = m1x * m2x + m1y * m2y + m1z * m2z;

  // Exact dipole-dipole force on body 2 due to body 1 with softened 1/r_eff^4 decay:
  // F_12 = (3 * mu_0 / (4 * pi * r_eff^4)) * [
  //   (m1 . u) m2 + (m2 . u) m1 + (m1 . m2) u - 5 (m1 . u)(m2 . u) u
  // ]
  const fScale = (3 * MU_0_OVER_4PI) / rEff4;
  const uCoeff = m1DotM2 - 5 * m1DotU * m2DotU;
  let f2x = fScale * (m1DotU * m2x + m2DotU * m1x + uCoeff * ux);
  let f2y = fScale * (m1DotU * m2y + m2DotU * m1y + uCoeff * uy);
  let f2z = fScale * (m1DotU * m2z + m2DotU * m1z + uCoeff * uz);

  // Physical saturation cap so deep interpenetration never explodes the solver.
  const minR = Math.min(r1, r2);
  const fMax = Math.min(8, ((brTesla * brTesla) / (2 * MU_0)) * Math.PI * minR * minR * 0.15);
  const fMag = Math.hypot(f2x, f2y, f2z);
  if (fMag > fMax && fMag > 0) {
    const clamp = fMax / fMag;
    f2x *= clamp;
    f2y *= clamp;
    f2z *= clamp;
  }

  // Magnetic field at body 2 from body 1:
  // B1 = (mu_0 / (4 * pi * r_eff^3)) * [3 (m1 . u) u - m1]
  const bScale = MU_0_OVER_4PI / rEff3;
  const b1x = bScale * (3 * m1DotU * ux - m1x);
  const b1y = bScale * (3 * m1DotU * uy - m1y);
  const b1z = bScale * (3 * m1DotU * uz - m1z);

  // tau2 = m2 x B1
  let tau2x = m2y * b1z - m2z * b1y;
  let tau2y = m2z * b1x - m2x * b1z;
  let tau2z = m2x * b1y - m2y * b1x;

  // Magnetic field at body 1 from body 2 (note (-u) . m2 * (-u) = (u . m2) * u):
  // B2 = (mu_0 / (4 * pi * r_eff^3)) * [3 (m2 . u) u - m2]
  const b2x = bScale * (3 * m2DotU * ux - m2x);
  const b2y = bScale * (3 * m2DotU * uy - m2y);
  const b2z = bScale * (3 * m2DotU * uz - m2z);

  // tau1 = m1 x B2
  let tau1x = m1y * b2z - m1z * b2y;
  let tau1y = m1z * b2x - m1x * b2z;
  let tau1z = m1x * b2y - m1y * b2x;

  // Keep dipole alignment torque bounded so tiny free magnets align smoothly
  // without spinning up into contact solver instability.
  const tauMax = Math.min(fMax * Math.max(r1, r2) * 0.04, 0.0008);
  const tau1Mag = Math.hypot(tau1x, tau1y, tau1z);
  if (tau1Mag > tauMax && tau1Mag > 0) {
    const clamp = tauMax / tau1Mag;
    tau1x *= clamp;
    tau1y *= clamp;
    tau1z *= clamp;
  }
  const tau2Mag = Math.hypot(tau2x, tau2y, tau2z);
  if (tau2Mag > tauMax && tau2Mag > 0) {
    const clamp = tauMax / tau2Mag;
    tau2x *= clamp;
    tau2y *= clamp;
    tau2z *= clamp;
  }

  return {
    f1: [-f2x, -f2y, -f2z],
    f2: [f2x, f2y, f2z],
    tau1: [tau1x, tau1y, tau1z],
    tau2: [tau2x, tau2y, tau2z],
  };
}

/**
 * Apply pairwise 3D dipole-dipole forces and alignment torques to
 * `data.xfrc_applied` for all magnet bodies in the scene.
 *
 * Returns immediately with zero overhead when fewer than 2 magnets exist.
 */
export function applyMagnetForces(
  magnets: readonly MagnetBody[],
  data: {
    xpos: Float64Array | number[];
    xmat: Float64Array | number[];
    xfrc_applied: Float64Array | number[];
    cvel?: Float64Array | number[];
  },
): void {
  const n = magnets.length;
  if (n < 2) return;

  const { xpos, xmat, xfrc_applied, cvel } = data;
  const p1: Vec3 = [0, 0, 0];
  const p2: Vec3 = [0, 0, 0];
  const m1: Vec3 = [0, 0, 0];
  const m2: Vec3 = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const a = magnets[i];
    const b1 = a.bodyId;
    const p1Off = b1 * 3;
    const m1Off = b1 * 9;
    p1[0] = xpos[p1Off];
    p1[1] = xpos[p1Off + 1];
    p1[2] = xpos[p1Off + 2];

    // Local +Z axis in world coordinates is the 3rd column of row-major xmat:
    // indices +2, +5, +8.
    const s1 = a.momentAm2 * a.polarity;
    m1[0] = xmat[m1Off + 2] * s1;
    m1[1] = xmat[m1Off + 5] * s1;
    m1[2] = xmat[m1Off + 8] * s1;

    for (let j = i + 1; j < n; j++) {
      const b = magnets[j];
      if (a.weldId === b.weldId) continue;

      const b2 = b.bodyId;
      const p2Off = b2 * 3;
      const m2Off = b2 * 9;
      p2[0] = xpos[p2Off];
      p2[1] = xpos[p2Off + 1];
      p2[2] = xpos[p2Off + 2];

      const s2 = b.momentAm2 * b.polarity;
      m2[0] = xmat[m2Off + 2] * s2;
      m2[1] = xmat[m2Off + 5] * s2;
      m2[2] = xmat[m2Off + 8] * s2;

      const res = computeDipoleInteraction(
        p1,
        m1,
        a.radiusM,
        a.thicknessM,
        p2,
        m2,
        b.radiusM,
        b.thicknessM,
      );
      if (!res) continue;

      const f1Off = b1 * 6;
      const f2Off = b2 * 6;

      // Keep per-step acceleration realistic and explicit-Euler-stable even for
      // tiny free 1-2 g disc magnets (static bodies have weldId === 0 so they
      // don't constrain the moving partner's mass).
      let f1x = res.f1[0], f1y = res.f1[1], f1z = res.f1[2];
      let f2x = res.f2[0], f2y = res.f2[1], f2z = res.f2[2];
      let t1x = res.tau1[0], t1y = res.tau1[1], t1z = res.tau1[2];
      let t2x = res.tau2[0], t2y = res.tau2[1], t2z = res.tau2[2];

      const m1Dyn = a.weldId > 0 && a.massKg ? a.massKg : Infinity;
      const m2Dyn = b.weldId > 0 && b.massKg ? b.massKg : Infinity;
      const minDynMass = Math.min(m1Dyn, m2Dyn);
      if (Number.isFinite(minDynMass) && minDynMass > 0) {
        // Cap acceleration at 55 m/s^2 (~5.5 g) so tiny free discs snap crisply
        // and settle dead-still without bouncing or chattering on the floor.
        const maxPairF = 55 * minDynMass;
        const fMag = Math.hypot(f2x, f2y, f2z);
        if (fMag > maxPairF && fMag > 0) {
          const s = maxPairF / fMag;
          f1x *= s; f1y *= s; f1z *= s;
          f2x *= s; f2y *= s; f2z *= s;
        }
        const rRef = Math.max(a.radiusM, b.radiusM);
        const maxPairTau = 0.012 * maxPairF * rRef;
        const t1Mag = Math.hypot(t1x, t1y, t1z);
        if (t1Mag > maxPairTau && t1Mag > 0) {
          const s = maxPairTau / t1Mag;
          t1x *= s; t1y *= s; t1z *= s;
        }
        const t2Mag = Math.hypot(t2x, t2y, t2z);
        if (t2Mag > maxPairTau && t2Mag > 0) {
          const s = maxPairTau / t2Mag;
          t2x *= s; t2y *= s; t2z *= s;
        }
      }

      // Eddy-current / near-field relative-velocity linear & angular damping,
      // scaled by each body's mass and disc inertia (I ~ 0.25 * m * r^2) so
      // c * dt / m <= 0.05 and c_ang * dt / I <= 0.072 (unconditionally stable
      // for explicit Euler at 1 ms while draining snap jitter in ~15 ms).
      let dfx = 0, dfy = 0, dfz = 0;
      let dt1x = 0, dt1y = 0, dt1z = 0;
      let dt2x = 0, dt2y = 0, dt2z = 0;
      if (cvel && cvel.length >= (Math.max(b1, b2) + 1) * 6 && Number.isFinite(minDynMass)) {
        const cLin = Math.min(0.4, 50 * minDynMass);
        const rvx = cvel[f2Off + 3] - cvel[f1Off + 3];
        const rvy = cvel[f2Off + 4] - cvel[f1Off + 4];
        const rvz = cvel[f2Off + 5] - cvel[f1Off + 5];
        dfx = -cLin * rvx;
        dfy = -cLin * rvy;
        dfz = -cLin * rvz;

        if (Number.isFinite(m1Dyn)) {
          const cAng1 = 18 * m1Dyn * a.radiusM * a.radiusM;
          dt1x = -cAng1 * cvel[f1Off];
          dt1y = -cAng1 * cvel[f1Off + 1];
          dt1z = -cAng1 * cvel[f1Off + 2];
        }
        if (Number.isFinite(m2Dyn)) {
          const cAng2 = 18 * m2Dyn * b.radiusM * b.radiusM;
          dt2x = -cAng2 * cvel[f2Off];
          dt2y = -cAng2 * cvel[f2Off + 1];
          dt2z = -cAng2 * cvel[f2Off + 2];
        }
      }

      xfrc_applied[f1Off] += f1x - dfx;
      xfrc_applied[f1Off + 1] += f1y - dfy;
      xfrc_applied[f1Off + 2] += f1z - dfz;
      xfrc_applied[f1Off + 3] += t1x + dt1x;
      xfrc_applied[f1Off + 4] += t1y + dt1y;
      xfrc_applied[f1Off + 5] += t1z + dt1z;

      xfrc_applied[f2Off] += f2x + dfx;
      xfrc_applied[f2Off + 1] += f2y + dfy;
      xfrc_applied[f2Off + 2] += f2z + dfz;
      xfrc_applied[f2Off + 3] += t2x + dt2x;
      xfrc_applied[f2Off + 4] += t2y + dt2y;
      xfrc_applied[f2Off + 5] += t2z + dt2z;
    }
  }
}
