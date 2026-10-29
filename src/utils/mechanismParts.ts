// ---------------------------------------------------------------------------
// Manufacturable Mechanism & Transmission Synthesis
//
// Builds watertight, 3D-printable / CNC-machinable transmission geometry
// parameterized by real engineering standards (ISO metric module m, pressure
// angle α, profile shift x, backlash, shaft bores, GT2-2mm pitch, T8 lead,
// cam profiles, and Grashof 4-bar linkages) while configuring MuJoCo joints
// (`hinge` / `slide`), kinematic equality couplings (`coupleTargetId` /
// `coupleRatio`), and closed-loop constraints (`connectTargetId` / `connectAnchor`).
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { prismMesh } from './csg';
import { motorArmature } from './motionParts';
import {
  ALUMINIUM,
} from './extrusionParts';
import {
  BLACK_OXIDE,
  BRIGHT,
  NITRILE,
  STEEL,
  boxGeom,
  cylinderGeom,
  mm,
  visual,
} from './hardwareGeometry';

export const STANDARD_MODULES_MM = [0.5, 0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0] as const;
export type StandardModuleMm = (typeof STANDARD_MODULES_MM)[number];

export type GearBoreKind = 'none' | 'round' | 'd_shaft' | 'hex' | 'bearing_608';

export type MechanismFamily =
  | 'gear_pair'
  | 'rack_pinion'
  | 'gt2_belt'
  | 'leadscrew'
  | 'cam_follower'
  | 'four_bar';

export const PLA_DENSITY = 1240; // kg/m³
export const BRASS_DENSITY = 8500; // kg/m³

export const GEAR_BLUE: [number, number, number, number] = [0.26, 0.52, 0.82, 1];
export const GEAR_AMBER: [number, number, number, number] = [0.88, 0.56, 0.22, 1];
export const RACK_SLATE: [number, number, number, number] = [0.42, 0.48, 0.56, 1];
export const BRASS_RGBA: [number, number, number, number] = [0.82, 0.68, 0.28, 1];
export const CAM_EMERALD: [number, number, number, number] = [0.24, 0.68, 0.52, 1];
export const LINK_CORAL: [number, number, number, number] = [0.86, 0.38, 0.34, 1];

// ---------------------------------------------------------------------------
// Shared geometry helpers
// ---------------------------------------------------------------------------

/** Twice the signed area of a 2D polygon: positive for anticlockwise, negative for clockwise. */
export function signedPolygonArea2(loop: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/** Rotates a 2D point loop around the origin by `angleRad` radians. */
export function rotateLoop2D(loop: [number, number][], angleRad: number): [number, number][] {
  if (Math.abs(angleRad) < 1e-12) return loop.map(([x, y]) => [x, y]);
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return loop.map(([x, y]) => [
    +(x * c - y * s).toFixed(6),
    +(x * s + y * c).toFixed(6),
  ]);
}

/** Checks whether any non-adjacent segments of a closed 2D loop intersect. */
export function hasSelfIntersection(loop: [number, number][]): boolean {
  const n = loop.length;
  if (n < 4) return false;
  const orient = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

  for (let i = 0; i < n; i++) {
    const a1 = loop[i];
    const a2 = loop[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = loop[j];
      const b2 = loop[(j + 1) % n];
      const d1 = orient(b1, b2, a1);
      const d2 = orient(b1, b2, a2);
      const d3 = orient(a1, a2, b1);
      const d4 = orient(a1, a2, b2);
      if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
          ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) {
        return true;
      }
    }
  }
  return false;
}

/** Converts Z-up positions + faces from `prismMesh` into a dynamic `SceneGeom`. */
export function extrudedMeshGeom(
  name: string,
  positions: number[],
  faces: number[],
  rgba: number[],
  extra: Partial<SceneGeom> = {},
): SceneGeom {
  const renderVertices = positions.map((v) => +v.toFixed(7));
  const vertices: number[] = new Array(renderVertices.length);
  for (let i = 0; i < renderVertices.length; i += 3) {
    vertices[i] = renderVertices[i];
    vertices[i + 1] = renderVertices[i + 2];
    vertices[i + 2] = -renderVertices[i + 1];
  }
  return {
    name,
    type: 'mesh',
    size: [1],
    rgba: [...rgba],
    renderVertices,
    vertices,
    faces,
    dynamic: true,
    ...extra,
  };
}

/**
 * Generates a clockwise inner bore polygon in mm, centered at (0, 0). A bore
 * that does not fit inside `maxRadiusMm` is refused, never shrunk to fit: a
 * 608 seat cut at 16.8 mm takes no bearing, and a part that looks right but
 * will not assemble is worse than no part.
 */
export function buildBoreLoop(
  boreKind: GearBoreKind,
  boreDiameterMm: number,
  maxRadiusMm: number,
): [number, number][] | null {
  if (boreKind === 'none') return null;
  const rawDiameter = boreKind === 'bearing_608' ? 22.0 : Math.max(1.0, boreDiameterMm || 5.0);
  const radius = rawDiameter / 2;
  // A hex bore's size is across its flats; its corners reach further out.
  const reach = boreKind === 'hex' ? radius / Math.cos(Math.PI / 6) : radius;
  if (reach > maxRadiusMm) {
    const room = boreKind === 'hex' ? 2 * maxRadiusMm * Math.cos(Math.PI / 6) : 2 * maxRadiusMm;
    const what = boreKind === 'bearing_608' ? 'A 608 bearing seat (⌀22 mm)'
      : boreKind === 'hex' ? `A ${rawDiameter} mm hex bore` : `A ⌀${rawDiameter} mm bore`;
    throw new Error(`${what} does not fit this part: it has room for ${boreKind === 'hex' ? `${room.toFixed(1)} mm across flats` : `⌀${room.toFixed(1)} mm`} at most. Use more teeth or a bigger size, or a smaller bore.`);
  }

  if (boreKind === 'hex') {
    // Hex bore where `radius * 2` is the across-flats distance.
    const cornerR = reach;
    const pts: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      // Clockwise order
      const a = -(i / 6) * Math.PI * 2;
      pts.push([+(cornerR * Math.cos(a)).toFixed(6), +(cornerR * Math.sin(a)).toFixed(6)]);
    }
    return pts;
  }

  const segments = boreKind === 'bearing_608' ? 48 : 32;
  const flatX = boreKind === 'd_shaft' ? radius * 0.8 : Infinity;
  const pts: [number, number][] = [];
  for (let i = 0; i < segments; i++) {
    // Clockwise loop for prismMesh hole
    const a = -(i / segments) * Math.PI * 2;
    const x = Math.min(flatX, radius * Math.cos(a));
    const y = radius * Math.sin(a);
    pts.push([+x.toFixed(6), +y.toFixed(6)]);
  }
  return pts;
}

const makeId = (prefix: string, customId?: string) =>
  customId || `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

// ---------------------------------------------------------------------------
// 1. True Involute Spur Gears
// ---------------------------------------------------------------------------

export interface InvoluteGearSpec {
  moduleMm?: number;
  teeth?: number;
  pressureAngleDeg?: number;
  thicknessMm?: number;
  backlashMm?: number;
  profileShift?: number;
  boreKind?: GearBoreKind;
  boreDiameterMm?: number;
  rgba?: [number, number, number, number];
  density?: number;
  samplesPerFlank?: number;
}

export interface InvoluteGearMetrics {
  moduleMm: number;
  teeth: number;
  pressureAngleDeg: number;
  pressureAngleRad: number;
  profileShift: number;
  pitchDiameterMm: number;
  pitchRadiusMm: number;
  baseRadiusMm: number;
  addendumMm: number;
  dedendumMm: number;
  addendumRadiusMm: number;
  rootRadiusMm: number;
  circularPitchMm: number;
  basePitchMm: number;
  toothThicknessMm: number;
  backlashMm: number;
  thicknessMm: number;
  boreKind: GearBoreKind;
  boreDiameterMm: number;
  contactRatio: number;
}

export interface InvoluteGearProfile {
  outline: [number, number][];
  bore: [number, number][] | null;
  metrics: InvoluteGearMetrics;
}

/** Involute function inv(α) = tan(α) - α. */
export function involuteAngle(alphaRad: number): number {
  return Math.tan(alphaRad) - alphaRad;
}

/**
 * Computes standard ISO metric involute spur gear geometry and meshing metrics.
 * Automatically applies profile shift when `teeth < 17` (unless `profileShift`
 * is explicitly provided) to prevent involute root undercutting.
 */
export function involuteGearMetrics(
  spec: InvoluteGearSpec = {},
  partnerSpec?: InvoluteGearSpec,
): InvoluteGearMetrics {
  const moduleMm = Math.max(0.2, spec.moduleMm ?? 1.5);
  const teeth = Math.max(6, Math.round(spec.teeth ?? 20));
  const pressureAngleDeg = Math.max(12, Math.min(35, spec.pressureAngleDeg ?? 20));
  const alpha = (pressureAngleDeg * Math.PI) / 180;
  const sinAlpha = Math.sin(alpha);
  const cosAlpha = Math.cos(alpha);
  const tanAlpha = Math.tan(alpha);

  // Minimum profile shift to avoid undercutting below z = 17 (at α = 20°):
  // x_min = max(0, 1 - z * sin²(α) / 2)
  const autoShift = teeth < 17 ? Math.max(0, +(1 - (teeth * sinAlpha * sinAlpha) / 2).toFixed(4)) : 0;
  const profileShift = spec.profileShift !== undefined ? spec.profileShift : autoShift;

  const pitchDiameterMm = moduleMm * teeth;
  const pitchRadiusMm = pitchDiameterMm / 2;
  const baseRadiusMm = pitchRadiusMm * cosAlpha;

  const addendumMm = moduleMm * (1 + profileShift);
  const dedendumMm = Math.max(0.2 * moduleMm, moduleMm * (1.25 - profileShift));
  const addendumRadiusMm = pitchRadiusMm + addendumMm;
  const rootRadiusMm = Math.max(moduleMm * 0.8, pitchRadiusMm - dedendumMm);

  const circularPitchMm = Math.PI * moduleMm;
  const basePitchMm = circularPitchMm * cosAlpha;
  const backlashMm = Math.max(0, spec.backlashMm ?? 0.1);
  const toothThicknessMm = Math.max(
    0.2 * moduleMm,
    circularPitchMm / 2 + 2 * profileShift * moduleMm * tanAlpha - backlashMm,
  );
  const thicknessMm = Math.max(1, spec.thicknessMm ?? 8);
  const boreKind: GearBoreKind = spec.boreKind ?? 'round';
  const boreDiameterMm = boreKind === 'bearing_608' ? 22.0 : Math.max(0, spec.boreDiameterMm ?? 5.0);

  // Transverse contact ratio ε_α against partnerSpec (or identical gear if omitted)
  const z2 = Math.max(6, Math.round(partnerSpec?.teeth ?? teeth));
  const x2 = partnerSpec?.profileShift !== undefined
    ? partnerSpec.profileShift
    : z2 < 17
      ? Math.max(0, +(1 - (z2 * sinAlpha * sinAlpha) / 2).toFixed(4))
      : 0;
  const rp2 = (moduleMm * z2) / 2;
  const rb2 = rp2 * cosAlpha;
  const ra2 = rp2 + moduleMm * (1 + x2);
  const centerDist = pitchRadiusMm + rp2 + moduleMm * (profileShift + x2);
  const pathOfContact =
    Math.sqrt(Math.max(0, addendumRadiusMm ** 2 - baseRadiusMm ** 2)) +
    Math.sqrt(Math.max(0, ra2 ** 2 - rb2 ** 2)) -
    centerDist * sinAlpha;
  const contactRatio = +(Math.max(0, pathOfContact / basePitchMm)).toFixed(4);

  return {
    moduleMm,
    teeth,
    pressureAngleDeg,
    pressureAngleRad: alpha,
    profileShift,
    pitchDiameterMm,
    pitchRadiusMm,
    baseRadiusMm,
    addendumMm,
    dedendumMm,
    addendumRadiusMm,
    rootRadiusMm,
    circularPitchMm,
    basePitchMm,
    toothThicknessMm,
    backlashMm,
    thicknessMm,
    boreKind,
    boreDiameterMm,
    contactRatio,
  };
}

/**
 * Generates an anticlockwise 2D involute gear tooth outline and clockwise bore
 * loop in millimetres. Uses the exact parametric involute curve from
 * `max(r_f, r_b)` to `r_a` mirrored across each tooth centreline, with
 * pointed-tip and root-clearance clamping so low tooth counts never self-intersect.
 */
export function buildInvoluteGearProfile(spec: InvoluteGearSpec = {}): InvoluteGearProfile {
  const metrics = involuteGearMetrics(spec);
  const {
    teeth: z,
    pressureAngleRad: alpha,
    pitchRadiusMm: rp,
    baseRadiusMm: rb,
    addendumRadiusMm: ra,
    rootRadiusMm: rf,
    toothThicknessMm: sp,
    boreKind,
    boreDiameterMm,
  } = metrics;

  const samples = Math.max(5, Math.min(24, Math.round(spec.samplesPerFlank ?? 9)));
  const invAlphaP = involuteAngle(alpha);
  // Half angular tooth thickness at pitch circle: Δθ_p / 2
  const halfAnglePitch = sp / (2 * rp);
  // Half angular tooth thickness at base circle: ψ_b = ψ_p + inv(α_p)
  const psiBase = halfAnglePitch + invAlphaP;

  // Maximum angular half-width so adjacent teeth cannot cross at the root
  const pitchAngle = (2 * Math.PI) / z;
  const maxHalfAngle = pitchAngle * 0.46;

  // Roll angle φ(r) = sqrt((r / r_b)^2 - 1) and inv(α(r)) = φ(r) - atan(φ(r))
  const halfAngleAtRadius = (r: number): number => {
    if (r <= rb) return Math.min(maxHalfAngle, psiBase);
    const phi = Math.sqrt(Math.max(0, (r / rb) * (r / rb) - 1));
    const invR = phi - Math.atan(phi);
    return Math.min(maxHalfAngle, psiBase - invR);
  };

  // Find actual tip radius where tooth top-land retains at least a small positive width
  const minTipHalfAngle = 0.03 / z;
  let rTip = ra;
  if (halfAngleAtRadius(rTip) < minTipHalfAngle) {
    let lo = Math.max(rf, rb);
    let hi = ra;
    for (let it = 0; it < 24; it++) {
      const mid = 0.5 * (lo + hi);
      if (halfAngleAtRadius(mid) >= minTipHalfAngle) lo = mid;
      else hi = mid;
    }
    rTip = lo;
  }

  const rStart = Math.max(rf, rb);
  const outline: [number, number][] = [];

  // Parametric involute point in the tooth's local frame (tooth symmetric about +X axis):
  // Standard involute from base circle:
  //   x_inv(φ) = r_b * (cos φ + φ sin φ)
  //   y_inv(φ) = r_b * (sin φ - φ cos φ)
  // Rotated by ±psiBase to form the right (-y) and left (+y) flanks of the tooth.
  const involuteFlankPoint = (r: number, side: -1 | 1, toothCenterAngle: number): [number, number] => {
    const phi = r > rb ? Math.sqrt(Math.max(0, (r / rb) * (r / rb) - 1)) : 0;
    // Unrotated involute in polar form has radius r and angle inv(α(r)) = φ - atan(φ)
    const psi = Math.max(minTipHalfAngle * 0.5, Math.min(maxHalfAngle, psiBase - (phi - Math.atan(phi))));
    const theta = toothCenterAngle + side * psi;
    return [+(r * Math.cos(theta)).toFixed(6), +(r * Math.sin(theta)).toFixed(6)];
  };

  const psiStart = halfAngleAtRadius(rStart);

  for (let k = 0; k < z; k++) {
    const centerAngle = k * pitchAngle;

    // 1. Root transition on right (leading) side if root circle lies below base circle
    if (rf < rStart - 1e-4) {
      const thetaRootRight = centerAngle - psiStart;
      outline.push([
        +(rf * Math.cos(thetaRootRight)).toFixed(6),
        +(rf * Math.sin(thetaRootRight)).toFixed(6),
      ]);
    }

    // 2. Right involute flank climbing from rStart to rTip
    for (let i = 0; i <= samples; i++) {
      const r = rStart + (i / samples) * (rTip - rStart);
      outline.push(involuteFlankPoint(r, -1, centerAngle));
    }

    // 3. Top land midpoint on addendum circle
    if (halfAngleAtRadius(rTip) > minTipHalfAngle * 1.5) {
      outline.push([
        +(rTip * Math.cos(centerAngle)).toFixed(6),
        +(rTip * Math.sin(centerAngle)).toFixed(6),
      ]);
    }

    // 4. Left involute flank descending from rTip to rStart
    for (let i = samples; i >= 0; i--) {
      const r = rStart + (i / samples) * (rTip - rStart);
      outline.push(involuteFlankPoint(r, 1, centerAngle));
    }

    // 5. Root transition on left (trailing) side if root circle lies below base circle
    if (rf < rStart - 1e-4) {
      const thetaRootLeft = centerAngle + psiStart;
      outline.push([
        +(rf * Math.cos(thetaRootLeft)).toFixed(6),
        +(rf * Math.sin(thetaRootLeft)).toFixed(6),
      ]);
    }

    // 6. Smooth root arc along rf to the next tooth's root start
    const rootSpanStart = centerAngle + psiStart;
    const rootSpanEnd = (k + 1) * pitchAngle - psiStart;
    if (rootSpanEnd - rootSpanStart > 1e-4) {
      for (const frac of [0.33, 0.67]) {
        const a = rootSpanStart + frac * (rootSpanEnd - rootSpanStart);
        outline.push([+(rf * Math.cos(a)).toFixed(6), +(rf * Math.sin(a)).toFixed(6)]);
      }
    }
  }

  const bore = buildBoreLoop(boreKind, boreDiameterMm, rf * 0.82);
  return { outline, bore, metrics };
}

export interface GearNodeOptions {
  id?: string;
  name?: string;
  pos?: [number, number, number];
  euler?: [number, number, number];
  angleRad?: number;
  actuated?: boolean;
  velocityRadPerSec?: number;
  torqueLimitNm?: number;
  coupleTargetId?: string;
  coupleRatio?: number;
}

/**
 * Builds a complete `SceneNode` for an involute spur gear with:
 * - Watertight extruded `prismMesh` visual geometry (with bore cutout)
 * - Lightweight cylinder collision envelope for fast MuJoCo physics
 * - Hinge joint along local +Z (`[0, 0, 1]`) and `node.teeth` metadata
 */
export function buildInvoluteGearNode(
  spec: InvoluteGearSpec = {},
  options: GearNodeOptions = {},
): SceneNode {
  const profile = buildInvoluteGearProfile(spec);
  const { metrics } = profile;
  const id = makeId('gear', options.id);
  const name = options.name || `M${metrics.moduleMm} ${metrics.teeth}T Gear`;
  const rgba = spec.rgba ?? GEAR_BLUE;
  const density = spec.density ?? PLA_DENSITY;

  const rotatedOutline = rotateLoop2D(profile.outline, options.angleRad ?? 0);
  const rotatedBore = profile.bore ? rotateLoop2D(profile.bore, options.angleRad ?? 0) : null;

  const outlineM = rotatedOutline.map(([x, y]) => [mm(x), mm(y)]);
  const holesM = rotatedBore ? [rotatedBore.map(([x, y]) => [mm(x), mm(y)])] : [];
  const halfThickM = mm(metrics.thicknessMm / 2);

  const prism = prismMesh(outlineM, -halfThickM, halfThickM, holesM);
  const areaMm2 =
    Math.abs(signedPolygonArea2(rotatedOutline)) / 2 -
    (rotatedBore ? Math.abs(signedPolygonArea2(rotatedBore)) / 2 : 0);
  const volumeM3 = Math.max(1e-9, (areaMm2 * metrics.thicknessMm) * 1e-9);
  const massKg = +(volumeM3 * density).toFixed(6);

  const meshGeom = visual(
    extrudedMeshGeom(`${id}_mesh`, prism.positions, prism.faces, rgba),
  );
  const colliderGeom: SceneGeom = {
    ...cylinderGeom(`${id}_col`, mm(metrics.pitchRadiusMm), mm(metrics.thicknessMm), 0, rgba, {
      role: 'collision',
      mass: massKg,
      contype: 0,
      conaffinity: 0,
    }),
  };

  const joint: SceneJoint = {
    name: `${id}_hinge`,
    type: 'hinge',
    axis: [0, 0, 1],
    pos: [0, 0, 0],
    damping: 0.002,
    ...(options.actuated
      ? {
          armature: motorArmature(2.0),
          actuator: {
            type: 'velocity',
            kv: 2.0,
            ctrlValue: options.velocityRadPerSec ?? 3.0,
            forceLimit: options.torqueLimitNm ?? 1.5,
          },
        }
      : {}),
  };

  return {
    id,
    name,
    type: 'body',
    pos: options.pos ? [...options.pos] : [0, 0, mm(metrics.addendumRadiusMm + 5)],
    ...(options.euler ? { euler: [...options.euler] } : {}),
    teeth: metrics.teeth,
    toothForm: {
      kind: 'involute',
      teeth: metrics.teeth,
      moduleMm: metrics.moduleMm,
      pressureAngleDeg: metrics.pressureAngleDeg,
      profileShift: metrics.profileShift,
      pitchDiameterMm: metrics.pitchDiameterMm,
      tipDiameterMm: 2 * metrics.addendumRadiusMm,
      rootDiameterMm: 2 * metrics.rootRadiusMm,
      backlashMm: metrics.backlashMm,
    },
    geoms: [meshGeom, colliderGeom],
    joints: [joint],
    children: [],
    allowCoupling: true,
    ...(options.coupleTargetId ? { coupleTargetId: options.coupleTargetId } : {}),
    ...(options.coupleRatio !== undefined ? { coupleRatio: options.coupleRatio } : {}),
  };
}

export interface MeshingGearPairOptions {
  driverId?: string;
  drivenId?: string;
  driverName?: string;
  drivenName?: string;
  origin?: [number, number, number];
  meshAngleDeg?: number;
  actuateDriver?: boolean;
  driverVelocityRadPerSec?: number;
}

export interface MeshingGearPairResult {
  driverNode: SceneNode;
  drivenNode: SceneNode;
  nodes: [SceneNode, SceneNode];
  centerDistanceMm: number;
  centerDistanceM: number;
  gearRatio: number;
  coupleRatio: number;
  contactRatio: number;
  driverMetrics: InvoluteGearMetrics;
  drivenMetrics: InvoluteGearMetrics;
}

/**
 * Synthesizes a meshing driver + driven involute spur gear pair:
 * - Forces matching module and pressure angle between driver and driven
 * - Positions the driven gear at the exact center distance
 *   `a = m * (z1 + z2) / 2 + m * (x1 + x2)`
 * - Clocks the driven gear so its teeth interleave with the driver's teeth
 * - Configures `drivenNode.coupleTargetId = driverNode.id` and
 *   `drivenNode.coupleRatio = -(z1 / z2)`
 */
export function buildMeshingGearPair(
  driverSpec: InvoluteGearSpec = {},
  drivenSpec: InvoluteGearSpec = {},
  options: MeshingGearPairOptions = {},
): MeshingGearPairResult {
  const sharedModule = driverSpec.moduleMm ?? drivenSpec.moduleMm ?? 1.5;
  const sharedPressureAngle = driverSpec.pressureAngleDeg ?? drivenSpec.pressureAngleDeg ?? 20;
  const sharedThickness = driverSpec.thicknessMm ?? drivenSpec.thicknessMm ?? 8;

  const normDriver: InvoluteGearSpec = {
    rgba: GEAR_BLUE,
    ...driverSpec,
    moduleMm: sharedModule,
    pressureAngleDeg: sharedPressureAngle,
    thicknessMm: driverSpec.thicknessMm ?? sharedThickness,
  };
  const normDriven: InvoluteGearSpec = {
    rgba: GEAR_AMBER,
    ...drivenSpec,
    moduleMm: sharedModule,
    pressureAngleDeg: sharedPressureAngle,
    thicknessMm: drivenSpec.thicknessMm ?? sharedThickness,
  };

  const driverMetrics = involuteGearMetrics(normDriver, normDriven);
  const drivenMetrics = involuteGearMetrics(normDriven, normDriver);

  const z1 = driverMetrics.teeth;
  const z2 = drivenMetrics.teeth;
  const centerDistanceMm = +(
    sharedModule * ((z1 + z2) / 2 + driverMetrics.profileShift + drivenMetrics.profileShift)
  ).toFixed(6);
  const centerDistanceM = mm(centerDistanceMm);

  const meshAngleRad = ((options.meshAngleDeg ?? 0) * Math.PI) / 180;
  const defaultZ = mm(Math.max(driverMetrics.addendumRadiusMm, drivenMetrics.addendumRadiusMm) + 10);
  const origin: [number, number, number] = options.origin
    ? [...options.origin]
    : [0, 0, defaultZ];

  const drivenPos: [number, number, number] = [
    +(origin[0] + centerDistanceM * Math.cos(meshAngleRad)).toFixed(7),
    +(origin[1] + centerDistanceM * Math.sin(meshAngleRad)).toFixed(7),
    origin[2],
  ];

  // Clock the driven gear so a space of gear 2 faces the tooth of gear 1 along meshAngleRad:
  // At angle meshAngleRad on gear 1, phase is z1 * meshAngleRad.
  // On gear 2 at angle (meshAngleRad + π), tooth phase must be shifted by π / z2.
  const drivenClockRad =
    meshAngleRad + Math.PI + Math.PI / z2 - (z1 / z2) * meshAngleRad;

  const coupleRatio = +(-(z1 / z2)).toFixed(7);
  const gearRatio = +(z2 / z1).toFixed(6);

  const driverNode = buildInvoluteGearNode(normDriver, {
    id: options.driverId,
    name: options.driverName || `Driver Gear (${z1}T)`,
    pos: origin,
    actuated: options.actuateDriver ?? true,
    velocityRadPerSec: options.driverVelocityRadPerSec ?? 3.0,
  });

  const drivenNode = buildInvoluteGearNode(normDriven, {
    id: options.drivenId,
    name: options.drivenName || `Driven Gear (${z2}T)`,
    pos: drivenPos,
    angleRad: drivenClockRad,
    coupleTargetId: driverNode.id,
    coupleRatio,
  });

  return {
    driverNode,
    drivenNode,
    nodes: [driverNode, drivenNode],
    centerDistanceMm,
    centerDistanceM,
    gearRatio,
    coupleRatio,
    contactRatio: driverMetrics.contactRatio,
    driverMetrics,
    drivenMetrics,
  };
}

// ---------------------------------------------------------------------------
// 2. Involute Rack & Pinion
// ---------------------------------------------------------------------------

export interface InvoluteRackSpec {
  moduleMm?: number;
  teeth?: number;
  pressureAngleDeg?: number;
  thicknessMm?: number;
  baseHeightMm?: number;
  backlashMm?: number;
  rgba?: [number, number, number, number];
  density?: number;
}

export interface InvoluteRackMetrics {
  moduleMm: number;
  teeth: number;
  pressureAngleDeg: number;
  pressureAngleRad: number;
  circularPitchMm: number;
  totalLengthMm: number;
  addendumMm: number;
  dedendumMm: number;
  baseHeightMm: number;
  totalHeightMm: number;
  thicknessMm: number;
  backlashMm: number;
}

export interface InvoluteRackProfile {
  outline: [number, number][];
  metrics: InvoluteRackMetrics;
}

export function involuteRackMetrics(spec: InvoluteRackSpec = {}): InvoluteRackMetrics {
  const moduleMm = Math.max(0.2, spec.moduleMm ?? 1.5);
  const teeth = Math.max(2, Math.round(spec.teeth ?? 12));
  const pressureAngleDeg = Math.max(12, Math.min(35, spec.pressureAngleDeg ?? 20));
  const pressureAngleRad = (pressureAngleDeg * Math.PI) / 180;
  const circularPitchMm = Math.PI * moduleMm;
  const totalLengthMm = teeth * circularPitchMm;
  const addendumMm = moduleMm;
  const dedendumMm = 1.25 * moduleMm;
  const baseHeightMm = Math.max(2, spec.baseHeightMm ?? 6);
  const totalHeightMm = baseHeightMm + dedendumMm + addendumMm;
  const thicknessMm = Math.max(1, spec.thicknessMm ?? 8);
  const backlashMm = Math.max(0, spec.backlashMm ?? 0.1);

  return {
    moduleMm,
    teeth,
    pressureAngleDeg,
    pressureAngleRad,
    circularPitchMm,
    totalLengthMm,
    addendumMm,
    dedendumMm,
    baseHeightMm,
    totalHeightMm,
    thicknessMm,
    backlashMm,
  };
}

/**
 * Generates an anticlockwise 2D linear rack outline in mm in the XY plane.
 * The pitch line lies along `y = 0`, teeth point up (`+Y`) to `y = +addendumMm`,
 * root line is at `y = -dedendumMm`, and the backing bar bottom sits at
 * `y = -(dedendumMm + baseHeightMm)`.
 * Centered along X on `[-totalLengthMm / 2, +totalLengthMm / 2]`.
 */
export function buildInvoluteRackProfile(spec: InvoluteRackSpec = {}): InvoluteRackProfile {
  const metrics = involuteRackMetrics(spec);
  const {
    teeth: nTeeth,
    pressureAngleRad: alpha,
    circularPitchMm: p,
    totalLengthMm: L,
    addendumMm: ha,
    dedendumMm: hf,
    baseHeightMm: hb,
    backlashMm,
  } = metrics;

  const tanAlpha = Math.tan(alpha);
  // Tooth thickness at pitch line y = 0:
  const toothPitchWidth = Math.max(0.2 * p, p / 2 - backlashMm);
  const halfPitchWidth = toothPitchWidth / 2;
  const halfTipWidth = Math.max(0.05 * p, halfPitchWidth - ha * tanAlpha);
  const halfRootWidth = Math.min(0.47 * p, halfPitchWidth + hf * tanAlpha);

  const yBottom = -(hf + hb);
  const yRoot = -hf;
  const yTip = ha;
  const xLeft = -L / 2;
  const xRight = L / 2;

  // Build anticlockwise loop:
  // Bottom-left -> Bottom-right -> right-end root -> teeth from right to left -> left-end root
  const topTeethLeftToRight: [number, number][] = [];
  topTeethLeftToRight.push([+xLeft.toFixed(6), +yRoot.toFixed(6)]);
  for (let i = 0; i < nTeeth; i++) {
    const cx = xLeft + (i + 0.5) * p;
    topTeethLeftToRight.push(
      [+(cx - halfRootWidth).toFixed(6), +yRoot.toFixed(6)],
      [+(cx - halfTipWidth).toFixed(6), +yTip.toFixed(6)],
      [+(cx + halfTipWidth).toFixed(6), +yTip.toFixed(6)],
      [+(cx + halfRootWidth).toFixed(6), +yRoot.toFixed(6)],
    );
  }
  topTeethLeftToRight.push([+xRight.toFixed(6), +yRoot.toFixed(6)]);

  const outline: [number, number][] = [
    [+xLeft.toFixed(6), +yBottom.toFixed(6)],
    [+xRight.toFixed(6), +yBottom.toFixed(6)],
    ...topTeethLeftToRight.reverse(),
  ];

  return { outline, metrics };
}

export interface RackNodeOptions {
  id?: string;
  name?: string;
  pos?: [number, number, number];
  slideAxis?: [number, number, number];
  coupleTargetId?: string;
  coupleRatio?: number;
}

export function buildInvoluteRackNode(
  spec: InvoluteRackSpec = {},
  options: RackNodeOptions = {},
): SceneNode {
  const { outline, metrics } = buildInvoluteRackProfile(spec);
  const id = makeId('rack', options.id);
  const name = options.name || `M${metrics.moduleMm} ${metrics.teeth}T Rack`;
  const rgba = spec.rgba ?? RACK_SLATE;
  const density = spec.density ?? PLA_DENSITY;

  const outlineM = outline.map(([x, y]) => [mm(x), mm(y)]);
  const halfThickM = mm(metrics.thicknessMm / 2);
  const prism = prismMesh(outlineM, -halfThickM, halfThickM);

  const areaMm2 = Math.abs(signedPolygonArea2(outline)) / 2;
  const volumeM3 = Math.max(1e-9, areaMm2 * metrics.thicknessMm * 1e-9);
  const massKg = +(volumeM3 * density).toFixed(6);

  const yMidMm = (metrics.addendumMm - (metrics.dedendumMm + metrics.baseHeightMm)) / 2;
  const meshGeom = visual(
    extrudedMeshGeom(`${id}_mesh`, prism.positions, prism.faces, rgba),
  );
  const colliderGeom: SceneGeom = {
    ...boxGeom(
      `${id}_col`,
      [mm(metrics.totalLengthMm / 2), mm(metrics.totalHeightMm / 2), halfThickM],
      [0, mm(yMidMm), 0],
      rgba,
      density,
      { role: 'collision', mass: massKg, contype: 0, conaffinity: 0 },
    ),
  };

  const maxSlideM = mm(metrics.totalLengthMm * 0.42);
  const joint: SceneJoint = {
    name: `${id}_slide`,
    type: 'slide',
    axis: options.slideAxis ?? [1, 0, 0],
    pos: [0, 0, 0],
    damping: 0.05,
    limited: true,
    range: [-maxSlideM, maxSlideM],
  };

  return {
    id,
    name,
    type: 'body',
    pos: options.pos ? [...options.pos] : [0, 0, mm(metrics.thicknessMm / 2 + 5)],
    toothForm: {
      kind: 'rack',
      teeth: metrics.teeth,
      moduleMm: metrics.moduleMm,
      pressureAngleDeg: metrics.pressureAngleDeg,
      pitchMm: metrics.circularPitchMm,
      lengthMm: metrics.totalLengthMm,
      backlashMm: metrics.backlashMm,
    },
    geoms: [meshGeom, colliderGeom],
    joints: [joint],
    children: [],
    allowCoupling: true,
    ...(options.coupleTargetId ? { coupleTargetId: options.coupleTargetId } : {}),
    ...(options.coupleRatio !== undefined ? { coupleRatio: options.coupleRatio } : {}),
  };
}

export interface RackAndPinionOptions {
  pinionId?: string;
  rackId?: string;
  origin?: [number, number, number];
  actuatePinion?: boolean;
  pinionVelocityRadPerSec?: number;
}

export interface RackAndPinionResult {
  pinionNode: SceneNode;
  rackNode: SceneNode;
  nodes: [SceneNode, SceneNode];
  pitchRadiusMm: number;
  pitchRadiusM: number;
  linearTravelPerRevMm: number;
  coupleRatio: number;
  pinionMetrics: InvoluteGearMetrics;
  rackMetrics: InvoluteRackMetrics;
}

/**
 * Synthesizes a meshing involute pinion + linear rack pair:
 * - Places the pinion at `origin` and the rack below it at `y = origin[1] - rp`,
 *   so the pinion's bottom pitch point (`-Y`) is tangent to the rack's `y = 0` pitch line
 * - Clocks the pinion so its tooth fits cleanly into the rack's central tooth valley
 * - Sets `rackNode.coupleTargetId = pinionNode.id` and `rackNode.coupleRatio = +pitchRadiusMeters`
 */
export function buildRackAndPinionPair(
  pinionSpec: InvoluteGearSpec = {},
  rackSpec: InvoluteRackSpec = {},
  options: RackAndPinionOptions = {},
): RackAndPinionResult {
  const sharedModule = pinionSpec.moduleMm ?? rackSpec.moduleMm ?? 1.5;
  const sharedPressureAngle = pinionSpec.pressureAngleDeg ?? rackSpec.pressureAngleDeg ?? 20;
  const sharedThickness = pinionSpec.thicknessMm ?? rackSpec.thicknessMm ?? 8;

  const normPinion: InvoluteGearSpec = {
    rgba: GEAR_BLUE,
    ...pinionSpec,
    moduleMm: sharedModule,
    pressureAngleDeg: sharedPressureAngle,
    thicknessMm: pinionSpec.thicknessMm ?? sharedThickness,
  };
  const normRack: InvoluteRackSpec = {
    rgba: RACK_SLATE,
    ...rackSpec,
    moduleMm: sharedModule,
    pressureAngleDeg: sharedPressureAngle,
    thicknessMm: rackSpec.thicknessMm ?? sharedThickness,
  };

  const pinionMetrics = involuteGearMetrics(normPinion);
  const rackMetrics = involuteRackMetrics(normRack);

  const pitchOffsetMm = pinionMetrics.pitchRadiusMm + sharedModule * pinionMetrics.profileShift;
  const pitchRadiusM = mm(pinionMetrics.pitchRadiusMm);
  const defaultZ = mm(sharedThickness / 2 + 10);
  const pinionPos: [number, number, number] = options.origin
    ? [...options.origin]
    : [0, mm(pitchOffsetMm + rackMetrics.dedendumMm + rackMetrics.baseHeightMm), defaultZ];
  const rackPos: [number, number, number] = [
    pinionPos[0],
    +(pinionPos[1] - mm(pitchOffsetMm)).toFixed(7),
    pinionPos[2],
  ];

  // Clock pinion so a tooth points straight down (-Y, angle -π/2) when rack has
  // an even number of teeth (valley at x = 0) or a valley points down when rack teeth is odd.
  const rackHasToothAtCenter = rackMetrics.teeth % 2 === 1;
  const pinionClockRad = rackHasToothAtCenter
    ? -Math.PI / 2 + Math.PI / pinionMetrics.teeth
    : -Math.PI / 2;

  const coupleRatio = +pitchRadiusM.toFixed(7);

  const pinionNode = buildInvoluteGearNode(normPinion, {
    id: options.pinionId || makeId('pinion'),
    name: `Pinion (${pinionMetrics.teeth}T M${sharedModule})`,
    pos: pinionPos,
    angleRad: pinionClockRad,
    actuated: options.actuatePinion ?? true,
    velocityRadPerSec: options.pinionVelocityRadPerSec ?? 2.0,
  });

  const rackNode = buildInvoluteRackNode(normRack, {
    id: options.rackId || makeId('rack'),
    name: `Rack (${rackMetrics.teeth}T M${sharedModule})`,
    pos: rackPos,
    coupleTargetId: pinionNode.id,
    coupleRatio,
  });

  return {
    pinionNode,
    rackNode,
    nodes: [pinionNode, rackNode],
    pitchRadiusMm: pinionMetrics.pitchRadiusMm,
    pitchRadiusM,
    linearTravelPerRevMm: +(pinionMetrics.circularPitchMm * pinionMetrics.teeth).toFixed(4),
    coupleRatio,
    pinionMetrics,
    rackMetrics,
  };
}

// ---------------------------------------------------------------------------
// 3. GT2 Timing Pulleys & Belt Drives + T8 Leadscrews
// ---------------------------------------------------------------------------

export const GT2_PITCH_MM = 2.0;
export const GT2_BELT_PLD_MM = 0.254; // Pitch line differential for GT2-2mm belt
export const GT2_TOOTH_DEPTH_MM = 0.75;

export interface Gt2PulleySpec {
  teeth?: number;
  beltWidthMm?: number;
  boreKind?: GearBoreKind;
  boreDiameterMm?: number;
  flangeThicknessMm?: number;
  rgba?: [number, number, number, number];
}

export interface Gt2PulleyMetrics {
  teeth: number;
  pitchMm: number;
  pitchDiameterMm: number;
  pitchRadiusMm: number;
  outerDiameterMm: number;
  outerRadiusMm: number;
  rootRadiusMm: number;
  flangeRadiusMm: number;
  beltWidthMm: number;
  totalHeightMm: number;
  boreKind: GearBoreKind;
  boreDiameterMm: number;
}

export function gt2PulleyMetrics(spec: Gt2PulleySpec = {}): Gt2PulleyMetrics {
  const teeth = Math.max(12, Math.min(120, Math.round(spec.teeth ?? 20)));
  const pitchDiameterMm = +((teeth * GT2_PITCH_MM) / Math.PI).toFixed(5);
  const pitchRadiusMm = pitchDiameterMm / 2;
  const outerDiameterMm = +(pitchDiameterMm - 2 * GT2_BELT_PLD_MM).toFixed(5);
  const outerRadiusMm = outerDiameterMm / 2;
  const rootRadiusMm = Math.max(1.5, outerRadiusMm - GT2_TOOTH_DEPTH_MM);
  const flangeRadiusMm = outerRadiusMm + 1.8;
  const beltWidthMm = Math.max(4, spec.beltWidthMm ?? 6);
  const flangeThicknessMm = Math.max(0.8, spec.flangeThicknessMm ?? 1.2);
  const totalHeightMm = beltWidthMm + 2 * flangeThicknessMm + 0.6;
  const boreKind: GearBoreKind = spec.boreKind ?? 'round';
  const boreDiameterMm = boreKind === 'bearing_608' ? 22.0 : Math.max(3, spec.boreDiameterMm ?? 5.0);

  return {
    teeth,
    pitchMm: GT2_PITCH_MM,
    pitchDiameterMm,
    pitchRadiusMm,
    outerDiameterMm,
    outerRadiusMm,
    rootRadiusMm,
    flangeRadiusMm,
    beltWidthMm,
    totalHeightMm,
    boreKind,
    boreDiameterMm,
  };
}

/**
 * Generates the anticlockwise 2D GT2-2mm timing pulley toothed cross-section
 * and clockwise shaft bore in mm.
 */
export function buildGt2PulleyProfile(spec: Gt2PulleySpec = {}): {
  outline: [number, number][];
  bore: [number, number][] | null;
  metrics: Gt2PulleyMetrics;
} {
  const metrics = gt2PulleyMetrics(spec);
  const { teeth: z, outerRadiusMm: ro, rootRadiusMm: rf, boreKind, boreDiameterMm } = metrics;
  const pitchAngle = (2 * Math.PI) / z;
  // GT2 profile has rounded circular gullets occupying ~55% of the angular pitch
  const gulletHalfAngle = pitchAngle * 0.28;
  const samples = 6;
  const outline: [number, number][] = [];

  for (let k = 0; k < z; k++) {
    const center = k * pitchAngle;
    // Rounded gullet centered at `center`
    for (let i = 0; i <= samples; i++) {
      const u = (i / samples) * 2 - 1; // -1 .. +1
      const a = center + u * gulletHalfAngle;
      // Smooth cosine/circular pocket profile from ro down to rf and back to ro
      const depthFrac = Math.cos((u * Math.PI) / 2);
      const r = ro - (ro - rf) * depthFrac;
      outline.push([+(r * Math.cos(a)).toFixed(6), +(r * Math.sin(a)).toFixed(6)]);
    }
    // Outer crest land between gullet k and gullet k + 1
    const landMid = center + pitchAngle * 0.5;
    outline.push([+(ro * Math.cos(landMid)).toFixed(6), +(ro * Math.sin(landMid)).toFixed(6)]);
  }

  const bore = buildBoreLoop(boreKind, boreDiameterMm, rf * 0.8);
  return { outline, bore, metrics };
}

/**
 * Builds a GT2 timing pulley `SceneNode` with extruded toothed body, top and
 * bottom belt-retaining flanges, bore cutout, and hinge joint.
 */
export function buildGt2PulleyNode(
  spec: Gt2PulleySpec = {},
  options: GearNodeOptions = {},
): SceneNode {
  const { outline, bore, metrics } = buildGt2PulleyProfile(spec);
  const id = makeId('gt2_pulley', options.id);
  const name = options.name || `GT2 ${metrics.teeth}T Pulley`;
  const rgba = spec.rgba ?? BRIGHT;

  const outlineM = outline.map(([x, y]) => [mm(x), mm(y)]);
  const holesM = bore ? [bore.map(([x, y]) => [mm(x), mm(y)])] : [];
  const halfTrackM = mm((metrics.beltWidthMm + 0.6) / 2);
  const flangeThickMm = (metrics.totalHeightMm - (metrics.beltWidthMm + 0.6)) / 2;

  const toothedPrism = prismMesh(outlineM, -halfTrackM, halfTrackM, holesM);

  // Top & bottom flanges extruded with the same bore
  const flangeLoop = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2;
    return [mm(metrics.flangeRadiusMm * Math.cos(a)), mm(metrics.flangeRadiusMm * Math.sin(a))];
  });
  const topFlange = prismMesh(flangeLoop, halfTrackM, halfTrackM + mm(flangeThickMm), holesM);
  const botFlange = prismMesh(flangeLoop, -halfTrackM - mm(flangeThickMm), -halfTrackM, holesM);

  const volumeM3 =
    Math.PI * (mm(metrics.pitchRadiusMm) ** 2 - mm(metrics.boreDiameterMm / 2) ** 2) * mm(metrics.totalHeightMm);
  const massKg = +(Math.max(0.002, volumeM3 * ALUMINIUM)).toFixed(6);

  const geoms: SceneGeom[] = [
    visual(extrudedMeshGeom(`${id}_teeth`, toothedPrism.positions, toothedPrism.faces, rgba)),
    visual(extrudedMeshGeom(`${id}_flange_top`, topFlange.positions, topFlange.faces, rgba)),
    visual(extrudedMeshGeom(`${id}_flange_bot`, botFlange.positions, botFlange.faces, rgba)),
    cylinderGeom(`${id}_col`, mm(metrics.pitchRadiusMm), mm(metrics.totalHeightMm), 0, rgba, {
      role: 'collision',
      mass: massKg,
      contype: 0,
      conaffinity: 0,
    }),
  ];

  const joint: SceneJoint = {
    name: `${id}_hinge`,
    type: 'hinge',
    axis: [0, 0, 1],
    pos: [0, 0, 0],
    damping: 0.001,
    ...(options.actuated
      ? {
          armature: motorArmature(1.5),
          actuator: {
            type: 'velocity',
            kv: 1.5,
            ctrlValue: options.velocityRadPerSec ?? 4.0,
            forceLimit: options.torqueLimitNm ?? 1.2,
          },
        }
      : {}),
  };

  return {
    id,
    name,
    type: 'body',
    pos: options.pos ? [...options.pos] : [0, 0, mm(metrics.flangeRadiusMm + 5)],
    teeth: metrics.teeth,
    toothForm: {
      kind: 'gt2',
      teeth: metrics.teeth,
      pitchMm: metrics.pitchMm,
      pitchDiameterMm: metrics.pitchDiameterMm,
      outsideDiameterMm: metrics.outerDiameterMm,
    },
    pulleyRadius: mm(metrics.pitchRadiusMm),
    geoms,
    joints: [joint],
    children: [],
    allowCoupling: true,
    ...(options.coupleTargetId ? { coupleTargetId: options.coupleTargetId } : {}),
    ...(options.coupleRatio !== undefined ? { coupleRatio: options.coupleRatio } : {}),
  };
}

export interface Gt2BeltDriveSpec {
  driverTeeth?: number;
  drivenTeeth?: number;
  centerDistanceMm?: number;
  beltWidthMm?: number;
  boreDiameterMm?: number;
  origin?: [number, number, number];
  actuateDriver?: boolean;
  driverVelocityRadPerSec?: number;
}

export interface Gt2BeltDriveResult {
  driverNode: SceneNode;
  drivenNode: SceneNode;
  beltNode: SceneNode;
  nodes: [SceneNode, SceneNode, SceneNode];
  centerDistanceMm: number;
  beltLengthMm: number;
  beltTeethRounded: number;
  reductionRatio: number;
  coupleRatio: number;
  driverMetrics: Gt2PulleyMetrics;
  drivenMetrics: Gt2PulleyMetrics;
}

/**
 * Builds a complete GT2 timing belt drive (driver pulley, driven pulley,
 * closed-loop belt visual body, and positive-ratio equality coupling).
 * Computes exact closed-loop belt length:
 *   `L ≈ 2C + π/2 * (d1 + d2) + (d2 - d1)^2 / (4C)`
 */
export function buildGt2BeltDrive(spec: Gt2BeltDriveSpec = {}): Gt2BeltDriveResult {
  const driverTeeth = Math.max(12, Math.round(spec.driverTeeth ?? 20));
  const drivenTeeth = Math.max(12, Math.round(spec.drivenTeeth ?? 40));
  const beltWidthMm = Math.max(4, spec.beltWidthMm ?? 6);
  const boreDiameterMm = spec.boreDiameterMm ?? 5.0;

  const driverMetrics = gt2PulleyMetrics({ teeth: driverTeeth, beltWidthMm, boreDiameterMm });
  const drivenMetrics = gt2PulleyMetrics({ teeth: drivenTeeth, beltWidthMm, boreDiameterMm });

  const minCenterMm = driverMetrics.flangeRadiusMm + drivenMetrics.flangeRadiusMm + 6;
  const centerDistanceMm = Math.max(minCenterMm, spec.centerDistanceMm ?? 60);

  const d1 = driverMetrics.pitchDiameterMm;
  const d2 = drivenMetrics.pitchDiameterMm;
  const beltLengthMm = +(
    2 * centerDistanceMm +
    (Math.PI / 2) * (d1 + d2) +
    ((d2 - d1) * (d2 - d1)) / (4 * centerDistanceMm)
  ).toFixed(3);
  const beltTeethRounded = Math.round(beltLengthMm / GT2_PITCH_MM);

  const reductionRatio = +(drivenTeeth / driverTeeth).toFixed(6);
  // Belt drive turns both pulleys in the SAME direction (+z1 / z2):
  const coupleRatio = +(driverTeeth / drivenTeeth).toFixed(7);

  const defaultZ = mm(Math.max(driverMetrics.flangeRadiusMm, drivenMetrics.flangeRadiusMm) + 10);
  const origin: [number, number, number] = spec.origin ? [...spec.origin] : [0, 0, defaultZ];
  const drivenPos: [number, number, number] = [
    +(origin[0] + mm(centerDistanceMm)).toFixed(7),
    origin[1],
    origin[2],
  ];

  const driverNode = buildGt2PulleyNode(
    { teeth: driverTeeth, beltWidthMm, boreDiameterMm, rgba: BRIGHT },
    {
      name: `GT2 Driver (${driverTeeth}T)`,
      pos: origin,
      actuated: spec.actuateDriver ?? true,
      velocityRadPerSec: spec.driverVelocityRadPerSec ?? 4.0,
    },
  );

  const drivenNode = buildGt2PulleyNode(
    { teeth: drivenTeeth, beltWidthMm, boreDiameterMm, rgba: BRIGHT },
    {
      name: `GT2 Driven (${drivenTeeth}T)`,
      pos: drivenPos,
      coupleTargetId: driverNode.id,
      coupleRatio,
    },
  );

  // Build watertight closed-loop timing belt stadium shell between the two pulleys
  const r1 = driverMetrics.pitchRadiusMm;
  const r2 = drivenMetrics.pitchRadiusMm;
  const beltThickMm = 1.38;
  const C = centerDistanceMm;
  const sinBeta = Math.max(-0.95, Math.min(0.95, (r2 - r1) / C));
  const beta = Math.asin(sinBeta);

  const buildBeltLoop = (offsetMm: number, clockwise: boolean): [number, number][] => {
    const ra = Math.max(1, r1 + offsetMm);
    const rb = Math.max(1, r2 + offsetMm);
    const pts: [number, number][] = [];
    const arcSteps = 20;
    // Right pulley arc (at x = C) from -(π/2 - β) to +(π/2 - β)
    const startR = -Math.PI / 2 + beta;
    const endR = Math.PI / 2 - beta;
    for (let i = 0; i <= arcSteps; i++) {
      const a = startR + (i / arcSteps) * (endR - startR);
      pts.push([+(C + rb * Math.cos(a)).toFixed(6), +(rb * Math.sin(a)).toFixed(6)]);
    }
    // Left pulley arc (at x = 0) from (π/2 - β) to (3π/2 + β)
    const startL = Math.PI / 2 - beta;
    const endL = (3 * Math.PI) / 2 + beta;
    for (let i = 0; i <= arcSteps; i++) {
      const a = startL + (i / arcSteps) * (endL - startL);
      pts.push([+(ra * Math.cos(a)).toFixed(6), +(ra * Math.sin(a)).toFixed(6)]);
    }
    return clockwise ? pts.reverse() : pts;
  };

  const beltOuter = buildBeltLoop(beltThickMm / 2, false).map(([x, y]) => [mm(x), mm(y)]);
  const beltInner = buildBeltLoop(-beltThickMm / 2, true).map(([x, y]) => [mm(x), mm(y)]);
  const halfBeltW = mm(beltWidthMm / 2);
  const beltPrism = prismMesh(beltOuter, -halfBeltW, halfBeltW, [beltInner]);
  const beltId = makeId('gt2_belt');

  const beltNode: SceneNode = {
    id: beltId,
    name: `GT2 Belt (${beltTeethRounded}T / ${beltLengthMm.toFixed(0)} mm)`,
    type: 'body',
    pos: [...origin],
    geoms: [
      visual(extrudedMeshGeom(`${beltId}_loop`, beltPrism.positions, beltPrism.faces, NITRILE)),
    ],
    joints: [],
    children: [],
  };

  return {
    driverNode,
    drivenNode,
    beltNode,
    nodes: [driverNode, drivenNode, beltNode],
    centerDistanceMm,
    beltLengthMm,
    beltTeethRounded,
    reductionRatio,
    coupleRatio,
    driverMetrics,
    drivenMetrics,
  };
}

// --- T8 Leadscrew + Brass Nut Carriage ---

export interface LeadscrewDriveSpec {
  lengthMm?: number;
  leadMm?: 2 | 4 | 8 | number;
  pitchMm?: number;
  diameterMm?: number;
  origin?: [number, number, number];
  actuateScrew?: boolean;
  screwVelocityRadPerSec?: number;
}

export interface LeadscrewDriveResult {
  /** The screw, on its hinge: a child of the mount. */
  leadscrewNode: SceneNode;
  /** The nut, on its slide: a child of the mount beside the screw, so it does not turn with it. */
  nutNode: SceneNode;
  /** The mount, holding both: what goes into the scene. */
  mountNode: SceneNode;
  nodes: [SceneNode];
  lengthMm: number;
  leadMm: number;
  pitchMm: number;
  starts: number;
  diameterMm: number;
  coupleRatio: number;
  travelRangeMm: [number, number];
}

/**
 * Synthesizes a T8 trapezoidal leadscrew on a hinge joint and a brass flanged
 * nut on a slide joint, side by side in a fixed mount, the nut coupled to the
 * screw by `coupleRatio = (leadMm / 1000) / (2 * Math.PI)`. Anything fixed to
 * the nut travels without turning.
 */
export function buildLeadscrewDrive(spec: LeadscrewDriveSpec = {}): LeadscrewDriveResult {
  const lengthMm = Math.max(40, spec.lengthMm ?? 200);
  const pitchMm = Math.max(1, spec.pitchMm ?? 2);
  const leadMm = Math.max(1, spec.leadMm ?? 8);
  const starts = Math.max(1, Math.round(leadMm / pitchMm));
  const diameterMm = Math.max(4, spec.diameterMm ?? 8);

  const screwId = makeId('leadscrew');
  const nutId = `${screwId}_nut`;
  // MuJoCo slide meters per hinge radian: (lead_m) / (2π)
  const coupleRatio = +((leadMm / 1000) / (2 * Math.PI)).toFixed(8);

  const nutHeightMm = 15;
  const maxTravelHalfMm = Math.max(5, (lengthMm - nutHeightMm - 10) / 2);
  const travelRangeMm: [number, number] = [-maxTravelHalfMm, maxTravelHalfMm];

  // Build flanged brass T8 nut profile (22 mm flange with 4x Ø3.5 mm mounting holes)
  const flangeR = 11;
  const barrelR = 5.1;
  const boreR = diameterMm / 2 + 0.1;
  const flangeLoop = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2;
    return [mm(flangeR * Math.cos(a)), mm(flangeR * Math.sin(a))];
  });
  const boreHole = buildBoreLoop('round', boreR * 2, flangeR - 1)!.map(([x, y]) => [mm(x), mm(y)]);
  const boltHoles = [0, 1, 2, 3].map((k) => {
    const angle = (k * Math.PI) / 2;
    const cx = 8 * Math.cos(angle);
    const cy = 8 * Math.sin(angle);
    return Array.from({ length: 16 }, (_, i) => {
      const a = -(i / 16) * Math.PI * 2;
      return [mm(cx + 1.75 * Math.cos(a)), mm(cy + 1.75 * Math.sin(a))];
    });
  });

  const flangePrism = prismMesh(flangeLoop, -mm(1.75), mm(1.75), [boreHole, ...boltHoles]);
  const barrelLoop = Array.from({ length: 28 }, (_, i) => {
    const a = (i / 28) * Math.PI * 2;
    return [mm(barrelR * Math.cos(a)), mm(barrelR * Math.sin(a))];
  });
  const barrelPrism = prismMesh(barrelLoop, -mm(nutHeightMm / 2), mm(nutHeightMm / 2), [boreHole]);

  const nutNode: SceneNode = {
    id: nutId,
    name: `T${diameterMm}×${leadMm} Brass Nut`,
    type: 'body',
    pos: [0, 0, 0],
    geoms: [
      visual(extrudedMeshGeom(`${nutId}_flange`, flangePrism.positions, flangePrism.faces, BRASS_RGBA)),
      visual(extrudedMeshGeom(`${nutId}_barrel`, barrelPrism.positions, barrelPrism.faces, BRASS_RGBA)),
      cylinderGeom(`${nutId}_col`, mm(flangeR), mm(nutHeightMm), 0, BRASS_RGBA, {
        role: 'collision',
        mass: 0.022,
        contype: 0,
        conaffinity: 0,
      }),
    ],
    joints: [
      {
        name: `${nutId}_slide`,
        type: 'slide',
        axis: [0, 0, 1],
        pos: [0, 0, 0],
        damping: 0.08,
        limited: true,
        hardStop: true,
        range: [mm(travelRangeMm[0]), mm(travelRangeMm[1])],
      },
    ],
    coupleTargetId: screwId,
    coupleRatio,
    children: [],
  };

  // Build watertight visual leadscrew mesh + collision cylinder
  const screwRadiusM = mm(diameterMm / 2);
  const halfLenM = mm(lengthMm / 2);
  const screwMass = +(Math.PI * screwRadiusM * screwRadiusM * mm(lengthMm) * STEEL).toFixed(6);
  const screwLoop = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    // Slight multi-start thread crest/root undulation around the circumference
    const rMm = (diameterMm / 2) - 0.25 * (1 - Math.cos(starts * a));
    return [mm(rMm * Math.cos(a)), mm(rMm * Math.sin(a))];
  });
  const screwPrism = prismMesh(screwLoop, -halfLenM, halfLenM);

  const origin: [number, number, number] = spec.origin
    ? [...spec.origin]
    : [0, 0, mm(lengthMm / 2 + 10)];

  const leadscrewNode: SceneNode = {
    id: screwId,
    name: `T${diameterMm}×${leadMm} Leadscrew (${lengthMm} mm)`,
    type: 'body',
    pos: origin,
    geoms: [
      visual(extrudedMeshGeom(`${screwId}_mesh`, screwPrism.positions, screwPrism.faces, BRIGHT)),
      {
        ...cylinderGeom(`${screwId}_rod`, screwRadiusM, mm(lengthMm), 0, BRIGHT, {
          role: 'collision',
          mass: screwMass,
          contype: 0,
          conaffinity: 0,
        }),
        thread: { pitch: mm(pitchMm) },
      },
    ],
    joints: [
      {
        name: `${screwId}_hinge`,
        type: 'hinge',
        axis: [0, 0, 1],
        pos: [0, 0, 0],
        damping: 0.001,
        ...(spec.actuateScrew ?? true
          ? {
              armature: motorArmature(1.5),
              actuator: {
                type: 'velocity',
                kv: 1.5,
                ctrlValue: spec.screwVelocityRadPerSec ?? 12.0,
                forceLimit: 1.2,
              },
            }
          : {}),
      },
    ],
    children: [],
    allowCoupling: true,
  };

  // The screw and the nut both hang off a fixed mount, so the nut slides in a
  // frame that does not turn. As the screw's child it inherited the screw's
  // rotation: a carriage on the nut spun at the screw's speed.
  const supportHalf = [mm(11), mm(11), mm(4)];
  const mountNode: SceneNode = {
    id: `${screwId}_mount`,
    name: `T${diameterMm}×${leadMm} Leadscrew mount`,
    type: 'body',
    pos: origin,
    geoms: [-1, 1].map((end) => boxGeom(
      `${screwId}_support_${end < 0 ? 'lo' : 'hi'}`,
      supportHalf,
      [0, 0, end * (halfLenM + supportHalf[2])],
      RACK_SLATE,
      ALUMINIUM,
      { contype: 0, conaffinity: 0 },
    )),
    joints: [],
    children: [{ ...leadscrewNode, pos: [0, 0, 0] }, nutNode],
  };
  const screwInMount = mountNode.children[0];

  return {
    leadscrewNode: screwInMount,
    nutNode,
    mountNode,
    nodes: [mountNode],
    lengthMm,
    leadMm,
    pitchMm,
    starts,
    diameterMm,
    coupleRatio,
    travelRangeMm,
  };
}

// ---------------------------------------------------------------------------
// 4A. Cam & Follower Synthesis
// ---------------------------------------------------------------------------

export type CamProfileKind = 'eccentric' | 'snail' | 'heart' | 'harmonic';

export interface CamSpec {
  kind?: CamProfileKind;
  baseRadiusMm?: number;
  liftMm?: number;
  thicknessMm?: number;
  boreKind?: GearBoreKind;
  boreDiameterMm?: number;
  samples?: number;
  origin?: [number, number, number];
  actuateCam?: boolean;
  camVelocityRadPerSec?: number;
}

export interface CamProfileResult {
  kind: CamProfileKind;
  outline: [number, number][];
  bore: [number, number][] | null;
  baseRadiusMm: number;
  liftMm: number;
  maxRadiusMm: number;
  minRadiusMm: number;
  thicknessMm: number;
  /** Follower displacement s(θ) in mm over one revolution. */
  displacementAtAngle: (thetaRad: number) => number;
}

/**
 * Generates an anticlockwise 2D cam profile in mm for:
 * - `'eccentric'`: circular disc of radius `baseRadiusMm + liftMm / 2` offset by `liftMm / 2`
 * - `'snail'`: linear rise over 330° with a smooth 30° return ramp (drop cam)
 * - `'heart'`: symmetric constant-velocity rise (0..180°) and fall (180..360°)
 * - `'harmonic'`: dwell (0..60°), harmonic rise (60..180°), dwell (180..240°), harmonic fall (240..360°)
 */
export function buildCamProfile(spec: CamSpec = {}): CamProfileResult {
  const kind: CamProfileKind = spec.kind ?? 'heart';
  const baseRadiusMm = Math.max(8, spec.baseRadiusMm ?? 18);
  const liftMm = Math.max(1, spec.liftMm ?? 10);
  const thicknessMm = Math.max(2, spec.thicknessMm ?? 8);
  const samples = Math.max(36, Math.min(240, Math.round(spec.samples ?? 96)));
  const boreKind: GearBoreKind = spec.boreKind ?? 'round';
  const boreDiameterMm = spec.boreDiameterMm ?? 5.0;

  const displacementAtAngle = (thetaRad: number): number => {
    const t = (((thetaRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI); // 0..1
    switch (kind) {
      case 'eccentric': {
        // Smooth sinusoidal lift from 0 to liftMm
        return (liftMm / 2) * (1 - Math.cos(t * 2 * Math.PI));
      }
      case 'snail': {
        // Linear rise from 0 to 11/12 turn, smooth cosine drop over the final 1/12 turn
        const riseEnd = 11 / 12;
        if (t <= riseEnd) return liftMm * (t / riseEnd);
        const u = (t - riseEnd) / (1 - riseEnd);
        return liftMm * 0.5 * (1 + Math.cos(u * Math.PI));
      }
      case 'heart': {
        // Constant velocity symmetric rise and fall
        return t <= 0.5 ? liftMm * (t * 2) : liftMm * (2 - t * 2);
      }
      case 'harmonic': {
        // 0..1/6 low dwell, 1/6..3/6 cosine rise, 3/6..4/6 high dwell, 4/6..1 cosine fall
        if (t < 1 / 6) return 0;
        if (t < 3 / 6) {
          const u = (t - 1 / 6) / (2 / 6);
          return liftMm * 0.5 * (1 - Math.cos(u * Math.PI));
        }
        if (t < 4 / 6) return liftMm;
        const u = (t - 4 / 6) / (2 / 6);
        return liftMm * 0.5 * (1 + Math.cos(u * Math.PI));
      }
    }
  };

  const outline: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * 2 * Math.PI;
    const r = baseRadiusMm + displacementAtAngle(a);
    outline.push([+(r * Math.cos(a)).toFixed(6), +(r * Math.sin(a)).toFixed(6)]);
  }

  const bore = buildBoreLoop(boreKind, boreDiameterMm, baseRadiusMm * 0.75);
  return {
    kind,
    outline,
    bore,
    baseRadiusMm,
    liftMm,
    maxRadiusMm: baseRadiusMm + liftMm,
    minRadiusMm: baseRadiusMm,
    thicknessMm,
    displacementAtAngle,
  };
}

export interface CamMechanismResult {
  camNode: SceneNode;
  followerNode: SceneNode;
  nodes: [SceneNode, SceneNode];
  profile: CamProfileResult;
  coupleRatio: number;
}

/**
 * Builds a cam body on a hinge joint and a linear follower stem on a slide
 * joint positioned along +Y, coupled via `coupleTargetId` and `coupleRatio`.
 */
export function buildCamMechanism(spec: CamSpec = {}): CamMechanismResult {
  const profile = buildCamProfile(spec);
  const camId = makeId('cam');
  const followerId = `${camId}_follower`;

  const outlineM = profile.outline.map(([x, y]) => [mm(x), mm(y)]);
  const holesM = profile.bore ? [profile.bore.map(([x, y]) => [mm(x), mm(y)])] : [];
  const halfThickM = mm(profile.thicknessMm / 2);
  const prism = prismMesh(outlineM, -halfThickM, halfThickM, holesM);

  const areaMm2 = Math.abs(signedPolygonArea2(profile.outline)) / 2;
  const massKg = +(Math.max(0.005, areaMm2 * profile.thicknessMm * 1e-9 * PLA_DENSITY)).toFixed(6);

  const defaultZ = mm(profile.maxRadiusMm + 10);
  const origin: [number, number, number] = spec.origin ? [...spec.origin] : [0, 0, defaultZ];

  const camNode: SceneNode = {
    id: camId,
    name: `${profile.kind[0].toUpperCase() + profile.kind.slice(1)} Cam (${profile.liftMm} mm lift)`,
    type: 'body',
    pos: origin,
    geoms: [
      visual(extrudedMeshGeom(`${camId}_mesh`, prism.positions, prism.faces, CAM_EMERALD)),
      cylinderGeom(`${camId}_col`, mm(profile.baseRadiusMm + profile.liftMm / 2), mm(profile.thicknessMm), 0, CAM_EMERALD, {
        role: 'collision',
        mass: massKg,
        contype: 0,
        conaffinity: 0,
      }),
    ],
    joints: [
      {
        name: `${camId}_hinge`,
        type: 'hinge',
        axis: [0, 0, 1],
        pos: [0, 0, 0],
        damping: 0.002,
        ...(spec.actuateCam ?? true
          ? {
              armature: motorArmature(2.0),
              actuator: {
                type: 'velocity',
                kv: 2.0,
                ctrlValue: spec.camVelocityRadPerSec ?? 2.5,
                forceLimit: 1.5,
              },
            }
          : {}),
      },
    ],
    children: [],
    allowCoupling: true,
  };

  // Follower stem + rounded roller tip riding on the +Y side of the cam
  const stemLengthMm = Math.max(30, profile.liftMm * 3);
  const rollerRadiusMm = 4;
  const stemHalfWidthMm = 2.5;
  const followerStartYMm = profile.baseRadiusMm + rollerRadiusMm;
  const coupleRatio = +((profile.liftMm / 1000) / Math.PI).toFixed(7);

  // Build anticlockwise 2D follower silhouette in XY (roller arc at bottom + stem up +Y)
  const followerOutline: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    // Bottom semicircle of roller from π to 2π
    const a = Math.PI + (i / 16) * Math.PI;
    followerOutline.push([
      +(rollerRadiusMm * Math.cos(a)).toFixed(6),
      +(rollerRadiusMm * Math.sin(a)).toFixed(6),
    ]);
  }
  followerOutline.push(
    [stemHalfWidthMm, rollerRadiusMm],
    [stemHalfWidthMm, rollerRadiusMm + stemLengthMm],
    [-stemHalfWidthMm, rollerRadiusMm + stemLengthMm],
    [-stemHalfWidthMm, rollerRadiusMm],
  );
  const followerPrism = prismMesh(
    followerOutline.map(([x, y]) => [mm(x), mm(y)]),
    -mm(profile.thicknessMm * 0.4),
    mm(profile.thicknessMm * 0.4),
  );

  const followerNode: SceneNode = {
    id: followerId,
    name: `Cam Follower (${profile.liftMm} mm stroke)`,
    type: 'body',
    pos: [origin[0], +(origin[1] + mm(followerStartYMm)).toFixed(7), origin[2]],
    geoms: [
      visual(extrudedMeshGeom(`${followerId}_mesh`, followerPrism.positions, followerPrism.faces, BRIGHT)),
      boxGeom(
        `${followerId}_stem`,
        [mm(rollerRadiusMm), mm((stemLengthMm + rollerRadiusMm) / 2), mm(profile.thicknessMm * 0.4)],
        [0, mm(stemLengthMm / 2), 0],
        BLACK_OXIDE,
        STEEL,
        { role: 'collision', contype: 0, conaffinity: 0 },
      ),
    ],
    joints: [
      {
        name: `${followerId}_slide`,
        type: 'slide',
        axis: [0, 1, 0],
        pos: [0, 0, 0],
        damping: 0.05,
        limited: true,
        range: [0, mm(profile.liftMm * 1.5)],
      },
    ],
    coupleTargetId: camId,
    coupleRatio,
    children: [],
  };

  return {
    camNode,
    followerNode,
    nodes: [camNode, followerNode],
    profile,
    coupleRatio,
  };
}

// ---------------------------------------------------------------------------
// 4B. Planar Grashof 4-Bar Linkage Synthesis
// ---------------------------------------------------------------------------

export type FourBarClassification =
  | 'crank_rocker'
  | 'double_crank'
  | 'double_rocker'
  | 'change_point'
  | 'non_grashof'
  | 'invalid';

export interface FourBarSpec {
  /** Fixed ground frame distance d (mm). */
  groundMm?: number;
  /** Input crank length a (mm). */
  crankMm?: number;
  /** Floating coupler length b (mm). */
  couplerMm?: number;
  /** Output rocker length c (mm). */
  rockerMm?: number;
  /** Initial input crank angle in degrees (default 60°). */
  crankAngleDeg?: number;
  /** Link bar width in mm (default 10). */
  linkWidthMm?: number;
  /** Link bar thickness in mm (default 5). */
  thicknessMm?: number;
  /** Pin hole diameter in mm (default 4). */
  pinDiameterMm?: number;
}

export interface FourBarMetrics {
  groundMm: number;
  crankMm: number;
  couplerMm: number;
  rockerMm: number;
  shortestMm: number;
  longestMm: number;
  grashofMarginMm: number;
  isGrashof: boolean;
  classification: FourBarClassification;
  transmissionAngleMinDeg: number;
  transmissionAngleMaxDeg: number;
  validAssembly: boolean;
  jointsXYMm: {
    A: [number, number];
    B: [number, number];
    C: [number, number];
    D: [number, number];
  };
}

/**
 * Evaluates Grashof's law (`s + l <= p + q`), classifies the 4-bar inversion,
 * computes transmission angle bounds `[γ_min, γ_max]`, and solves the closed
 * loop joint positions `(A, B, C, D)` at `crankAngleDeg`.
 */
export function fourBarMetrics(spec: FourBarSpec = {}): FourBarMetrics {
  const d = Math.max(5, spec.groundMm ?? 80);
  const a = Math.max(5, spec.crankMm ?? 30);
  const b = Math.max(5, spec.couplerMm ?? 75);
  const c = Math.max(5, spec.rockerMm ?? 55);

  const lengths = [d, a, b, c].slice().sort((x, y) => x - y);
  const s = lengths[0];
  const p = lengths[1];
  const q = lengths[2];
  const l = lengths[3];

  // Triangle inequality check: longest link must be strictly shorter than sum of other three
  const canAssemble = l < s + p + q - 1e-4;
  const grashofMarginMm = +(p + q - (s + l)).toFixed(4);
  const isGrashof = canAssemble && grashofMarginMm >= -1e-6;

  let classification: FourBarClassification;
  if (!canAssemble) {
    classification = 'invalid';
  } else if (Math.abs(grashofMarginMm) <= 1e-4) {
    classification = 'change_point';
  } else if (grashofMarginMm > 0) {
    if (a === s) classification = 'crank_rocker';
    else if (d === s) classification = 'double_crank';
    else classification = 'double_rocker';
  } else {
    classification = 'non_grashof';
  }

  // Transmission angle γ between coupler (b) and rocker (c) when crank (a) is collinear with ground (d):
  const clampCos = (v: number) => Math.max(-1, Math.min(1, v));
  const dMin = Math.max(Math.abs(b - c), Math.abs(d - a));
  const dMax = Math.min(b + c, d + a);
  const gamma1 = (Math.acos(clampCos((b * b + c * c - dMin * dMin) / (2 * b * c))) * 180) / Math.PI;
  const gamma2 = (Math.acos(clampCos((b * b + c * c - dMax * dMax) / (2 * b * c))) * 180) / Math.PI;
  const transmissionAngleMinDeg = +Math.min(gamma1, gamma2).toFixed(2);
  const transmissionAngleMaxDeg = +Math.max(gamma1, gamma2).toFixed(2);

  // Solve closed-loop pin positions:
  // A = (0, 0), D = (d, 0), B = (a cos θ, a sin θ)
  // C is the upper intersection of circle(B, b) and circle(D, c)
  const A: [number, number] = [0, 0];
  const D: [number, number] = [d, 0];
  let theta = ((spec.crankAngleDeg ?? 60) * Math.PI) / 180;
  let B: [number, number] = [a * Math.cos(theta), a * Math.sin(theta)];
  let distBD = Math.hypot(D[0] - B[0], D[1] - B[1]);

  // If the requested crank angle doesn't reach for a non-Grashof linkage, pick a reachable angle
  if (canAssemble && (distBD > b + c - 1e-3 || distBD < Math.abs(b - c) + 1e-3)) {
    const targetBD = 0.5 * (Math.max(Math.abs(b - c), Math.abs(d - a)) + Math.min(b + c, d + a));
    const cosTheta = clampCos((a * a + d * d - targetBD * targetBD) / (2 * a * d));
    theta = Math.acos(cosTheta);
    B = [a * Math.cos(theta), a * Math.sin(theta)];
    distBD = Math.hypot(D[0] - B[0], D[1] - B[1]);
  }

  let C: [number, number] = [d * 0.6, Math.min(b, c) * 0.8];
  const validAssembly =
    canAssemble && distBD <= b + c + 1e-4 && distBD >= Math.abs(b - c) - 1e-4 && distBD > 1e-6;

  if (validAssembly) {
    const ex = (D[0] - B[0]) / distBD;
    const ey = (D[1] - B[1]) / distBD;
    const xProj = (b * b - c * c + distBD * distBD) / (2 * distBD);
    const h = Math.sqrt(Math.max(0, b * b - xProj * xProj));
    // Open configuration (above ground line)
    C = [
      +(B[0] + xProj * ex - h * ey).toFixed(5),
      +(B[1] + xProj * ey + h * ex).toFixed(5),
    ];
    B = [+B[0].toFixed(5), +B[1].toFixed(5)];
  }

  return {
    groundMm: d,
    crankMm: a,
    couplerMm: b,
    rockerMm: c,
    shortestMm: s,
    longestMm: l,
    grashofMarginMm,
    isGrashof,
    classification,
    transmissionAngleMinDeg,
    transmissionAngleMaxDeg,
    validAssembly,
    jointsXYMm: { A, B, C, D },
  };
}

/**
 * Generates a 2D stadium/capsule link bar outline in mm from `(0, 0)` to `(lengthMm, 0)`
 * with two clockwise pin holes at `(0, 0)` and `(lengthMm, 0)`.
 */
export function buildLinkBarProfile(
  lengthMm: number,
  widthMm: number = 10,
  pinDiameterMm: number = 4,
): { outline: [number, number][]; holes: [number, number][][] } {
  const r = Math.max(2, widthMm / 2);
  const L = Math.max(r * 2.2, lengthMm);
  const steps = 16;
  const outline: [number, number][] = [];

  // Right semicircle around (L, 0) from -π/2 to +π/2
  for (let i = 0; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * Math.PI;
    outline.push([+(L + r * Math.cos(a)).toFixed(6), +(r * Math.sin(a)).toFixed(6)]);
  }
  // Left semicircle around (0, 0) from +π/2 to +3π/2
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI / 2 + (i / steps) * Math.PI;
    outline.push([+(r * Math.cos(a)).toFixed(6), +(r * Math.sin(a)).toFixed(6)]);
  }

  const pinR = Math.min(r * 0.65, Math.max(1, pinDiameterMm / 2));
  const makePinHole = (cx: number): [number, number][] =>
    Array.from({ length: 20 }, (_, i) => {
      const a = -(i / 20) * Math.PI * 2; // clockwise
      return [+(cx + pinR * Math.cos(a)).toFixed(6), +(pinR * Math.sin(a)).toFixed(6)];
    });

  return { outline, holes: [makePinHole(0), makePinHole(L)] };
}

export interface FourBarOptions {
  origin?: [number, number, number];
  actuateCrank?: boolean;
  crankVelocityRadPerSec?: number;
}

export interface FourBarResult {
  groundNode: SceneNode;
  crankNode: SceneNode;
  couplerNode: SceneNode;
  rockerNode: SceneNode;
  /** The top-level bodies: ground, crank (carrying the coupler) and rocker. */
  nodes: [SceneNode, SceneNode, SceneNode];
  metrics: FourBarMetrics;
}

/**
 * Builds a planar 4-bar linkage (`ground`, `crank`, `coupler`, `rocker`) with
 * rounded-end stadium link bars, pin holes, Z-axis hinge joints, and loop
 * closure on joint C via `couplerNode.connectTargetId = rockerNode.id` and
 * `couplerNode.connectAnchor`.
 */
export function buildFourBarLinkage(
  spec: FourBarSpec = {},
  options: FourBarOptions = {},
): FourBarResult {
  const metrics = fourBarMetrics(spec);
  const widthMm = Math.max(6, spec.linkWidthMm ?? 10);
  const thicknessMm = Math.max(3, spec.thicknessMm ?? 5);
  const pinDiameterMm = Math.max(2, spec.pinDiameterMm ?? 4);
  const { A, B, C, D } = metrics.jointsXYMm;

  const origin: [number, number, number] = options.origin
    ? [...options.origin]
    : [mm(-metrics.groundMm / 2), 0, mm(thicknessMm * 2 + 10)];

  const makeLinkBody = (
    prefix: string,
    name: string,
    startXY: [number, number],
    endXY: [number, number],
    zOffsetLayers: number,
    rgba: [number, number, number, number],
    jointSpec: SceneJoint | null,
  ): SceneNode => {
    const id = makeId(prefix);
    const dx = endXY[0] - startXY[0];
    const dy = endXY[1] - startXY[1];
    const lenMm = Math.hypot(dx, dy);
    const angleRad = Math.atan2(dy, dx);

    const { outline, holes } = buildLinkBarProfile(lenMm, widthMm, pinDiameterMm);
    const rotOutline = rotateLoop2D(outline, angleRad).map(([x, y]) => [mm(x), mm(y)]);
    const rotHoles = holes.map((h) => rotateLoop2D(h, angleRad).map(([x, y]) => [mm(x), mm(y)]));
    const halfThickM = mm(thicknessMm / 2);
    const prism = prismMesh(rotOutline, -halfThickM, halfThickM, rotHoles);

    const areaMm2 = Math.abs(signedPolygonArea2(outline)) / 2;
    const massKg = +(Math.max(0.005, areaMm2 * thicknessMm * 1e-9 * PLA_DENSITY)).toFixed(6);

    const pos: [number, number, number] = [
      +(origin[0] + mm(startXY[0])).toFixed(7),
      +(origin[1] + mm(startXY[1])).toFixed(7),
      +(origin[2] + zOffsetLayers * mm(thicknessMm + 0.4)).toFixed(7),
    ];

    const midX = mm((dx / 2));
    const midY = mm((dy / 2));

    return {
      id,
      name,
      type: 'body',
      pos,
      geoms: [
        visual(extrudedMeshGeom(`${id}_mesh`, prism.positions, prism.faces, rgba)),
        boxGeom(
          `${id}_col`,
          [mm(lenMm / 2), mm(widthMm / 2), halfThickM],
          [midX, midY, 0],
          rgba,
          PLA_DENSITY,
          {
            role: 'collision',
            euler: [0, 0, +((angleRad * 180) / Math.PI).toFixed(4)],
            mass: massKg,
            contype: 0,
            conaffinity: 0,
          },
        ),
      ],
      joints: jointSpec ? [jointSpec] : [],
      children: [],
    };
  };

  const groundNode = makeLinkBody(
    'fourbar_ground',
    `4-Bar Ground (${metrics.groundMm} mm)`,
    A,
    D,
    0,
    RACK_SLATE,
    null,
  );

  const crankId = makeId('fourbar_crank');
  const crankNode = makeLinkBody(
    crankId,
    `4-Bar Crank (${metrics.crankMm} mm)`,
    A,
    B,
    1,
    GEAR_BLUE,
    {
      name: `${crankId}_hinge`,
      type: 'hinge',
      axis: [0, 0, 1],
      pos: [0, 0, 0],
      damping: 0.002,
      ...(options.actuateCrank ?? true
        ? {
            armature: motorArmature(2.5),
            actuator: {
              type: 'velocity',
              kv: 2.5,
              ctrlValue: options.crankVelocityRadPerSec ?? 2.5,
              forceLimit: 2.0,
            },
          }
        : {}),
    },
  );
  crankNode.id = crankId;

  const couplerId = makeId('fourbar_coupler');
  const couplerNode = makeLinkBody(
    couplerId,
    `4-Bar Coupler (${metrics.couplerMm} mm)`,
    B,
    C,
    2,
    LINK_CORAL,
    {
      name: `${couplerId}_hinge`,
      type: 'hinge',
      axis: [0, 0, 1],
      pos: [0, 0, 0],
      damping: 0.001,
    },
  );
  couplerNode.id = couplerId;
  // Hung off the crank, so its hinge at B rides on the crank's end. Built as a
  // top-level body it was hinged to the world at B, and the loop pulled apart
  // as soon as the crank turned. Positions are in the parent's frame, and no
  // link body is turned (the bars are turned in their geometry).
  couplerNode.pos = couplerNode.pos.map((v, i) => +(v - crankNode.pos[i]).toFixed(7)) as [number, number, number];
  crankNode.children = [couplerNode];

  const rockerId = makeId('fourbar_rocker');
  const rockerNode = makeLinkBody(
    rockerId,
    `4-Bar Rocker (${metrics.rockerMm} mm)`,
    D,
    C,
    1,
    GEAR_AMBER,
    {
      name: `${rockerId}_hinge`,
      type: 'hinge',
      axis: [0, 0, 1],
      pos: [0, 0, 0],
      damping: 0.002,
    },
  );
  rockerNode.id = rockerId;

  // Close the 4-bar loop at pin C using MuJoCo's <connect> equality constraint
  const pinCWorld: [number, number, number] = [
    +(origin[0] + mm(C[0])).toFixed(7),
    +(origin[1] + mm(C[1])).toFixed(7),
    +(origin[2] + mm(thicknessMm + 0.4)).toFixed(7),
  ];
  couplerNode.connectTargetId = rockerNode.id;
  couplerNode.connectAnchor = pinCWorld;

  return {
    groundNode,
    crankNode,
    couplerNode,
    rockerNode,
    nodes: [groundNode, crankNode, rockerNode],
    metrics,
  };
}
