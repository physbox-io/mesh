// ---------------------------------------------------------------------------
// Timber & Joinery Breakdown — Phase 2 & 2.5: Joinery & Stopped Edge Profiles
// ---------------------------------------------------------------------------
//
// Given the extracted TimberMembers from `timberBreakdown.ts`, detects every
// structural joint between members and synthesizes real 3D Manifold geometry:
//   - Mortise & Tenon joints (with anti-racking shoulders, 45° corner-tenon
//     mitering when two rails meet in the same leg at the same height, 1.5 mm
//     glue-relief depth, and dogbone / rounded-tenon corner fit).
//   - Twin-dowel joints or Dado/housing slots.
//   - Tabletop Z-clip expansion kerf slots on the inside of apron rails (so a
//     solid-wood tabletop can expand and contract seasonally without splitting).
//   - Edge-glue alignment dowel holes between split tabletop planks.
//   - Stopped Edge Roundovers & Chamfers that automatically stop clear of every
//     mortise and shoulder landing pad so joints seat dead flush.
// ---------------------------------------------------------------------------

import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import {
  directionPhrase,
  extractTimberMembers,
  manifoldToMeshMm,
  meshMmToManifold,
  type TimberMember,
} from './timberBreakdown';
import type { FeatureCollider, JoineryFeature, SplitSection } from './printSplit';
import type { Vec3 } from './printPlate';

const MM = 1000;

export type TimberJointMode = 'mortise_tenon' | 'dowel' | 'dado' | 'butt';
export type TenonCornerFit = 'dogbone' | 'round_tenon' | 'chisel_square';
export type TimberEdgeProfile = 'square' | 'roundover' | 'chamfer';

export interface TimberJoineryOptions {
  jointMode?: TimberJointMode;
  tenonCornerFit?: TenonCornerFit;
  /** End mill diameter used for CNC mortises/dogbones, mm. Default 6.35 (1/4") or 6 mm. */
  cutterDiaMm?: number;
  /** Shoulder setback around a tenon for anti-racking stability, mm. Default 5 mm. */
  shoulderMm?: number;
  /** Target tenon length into the leg, mm (auto-clamped to leg thickness & corner miters). Default 22 mm. */
  tenonLengthMm?: number;
  /** Diametral / side clearance between tenon and mortise, mm. Default 0.15 mm. */
  clearanceMm?: number;
  /** Extra glue-relief depth at the bottom of blind mortises, mm. Default 1.5 mm. */
  glueReliefMm?: number;
  /** Whether to cut 4 mm Z-clip expansion slots on the inside top of aprons under a tabletop. Default true. */
  tabletopClips?: boolean;
  /** Edge softening profile on exposed leg/rail/top edges. Default 'roundover'. */
  edgeProfile?: TimberEdgeProfile;
  /** Radius (or chamfer setback) for edge profile, mm. Default 4 mm. */
  edgeRadiusMm?: number;
  /** Distance from any mortise or joint shoulder where edge roundovers stop, mm. Default 12 mm. */
  stopMarginMm?: number;
  /** Maximum single-board width before splitting wide panels into edge-glued planks, mm. Default 200 mm. */
  maxBoardWidthMm?: number;
  /** Whether straight tenons are cut on the bandsaw ('bandsaw') or milled on the CNC ('cnc'). Default 'bandsaw'. */
  tenonCutMethod?: 'bandsaw' | 'cnc';
}

export const DEFAULT_TIMBER_JOINERY_OPTIONS: Required<TimberJoineryOptions> = {
  jointMode: 'mortise_tenon',
  tenonCornerFit: 'dogbone',
  cutterDiaMm: 6,
  shoulderMm: 5,
  tenonLengthMm: 22,
  clearanceMm: 0.15,
  glueReliefMm: 1.5,
  tabletopClips: true,
  edgeProfile: 'roundover',
  edgeRadiusMm: 4,
  stopMarginMm: 12,
  maxBoardWidthMm: 200,
  tenonCutMethod: 'bandsaw',
};

export interface MortiseSpec {
  id: string;
  jointId: string;
  /** Host member ID (e.g. 'Leg_FL') and index. */
  hostMemberId: string;
  hostMemberIndex: number;
  /** Mating member ID (e.g. 'Apron_Front'). */
  matingMemberId: string;
  /** Center of the mortise mouth on the host's face, in root body frame, mm. */
  centerMm: Vec3;
  /** Unit normal pointing INTO the host material (direction the CNC bit plunges). */
  inwardNormal: Vec3;
  /** Outward face normal of the host face where the mortise opens. */
  faceNormal: Vec3;
  /** Local U (width along leg length) and V (thickness across leg face) axes of the mortise mouth. */
  uAxis: Vec3;
  vAxis: Vec3;
  /** Mortise dimensions [widthAlongUMm, thicknessAlongVMm, depthMm] including clearance & glue relief. */
  widthMm: number;
  thicknessMm: number;
  depthMm: number;
  /** Distance from the top end of the host member along its length axis, mm. */
  distFromTopEndMm: number;
  /** Distance from the host member's reference edge across the face, mm. */
  distFromRefEdgeMm: number;
  cornerFit: TenonCornerFit;
  dogboneDiaMm?: number;
  /** Corner fillet radius for 'round_tenon' (and CNC bit corner radius before chiseling for 'chisel_square'), mm. */
  cornerRadiusMm?: number;
}

export interface TenonMiterPlane {
  normal: Vec3;
  pivotMm: Vec3;
}

export interface TenonSpec {
  id: string;
  jointId: string;
  /** Rail member ID and index. */
  railMemberId: string;
  railMemberIndex: number;
  /** Mating leg/post member ID. */
  matingMemberId: string;
  /** Which end of the rail ('start' = negative length axis, 'end' = positive length axis). */
  railEnd: 'start' | 'end';
  /** Center of the shoulder plane on the rail end, root body frame, mm. */
  shoulderCenterMm: Vec3;
  /** Direction the tenon protrudes outward from the shoulder, unit vector. */
  outwardDir: Vec3;
  /** Local U (tenon height/width) and V (tenon thickness) axes. */
  uAxis: Vec3;
  vAxis: Vec3;
  /** Nominal tenon width (height), thickness, and protruding length, mm. */
  widthMm: number;
  thicknessMm: number;
  lengthMm: number;
  /** Shoulder setback on top/bottom and cheek sides, mm. */
  shoulderTopBotMm: number;
  shoulderCheekMm: number;
  /** Shoulder angle relative to square (0° for 90° joints; >0° for angled chair/splayed legs). */
  shoulderAngleDeg: number;
  /** True if the tip is mitred at 45° inside the leg to clear perpendicular corner/center-post tenons. */
  miteredTip: boolean;
  /** Direction the primary 45° miter cuts across if `miteredTip` is true. */
  miterNormal?: Vec3;
  /** 3D intersection of the perpendicular mortise axes inside the leg if `miteredTip` is true. */
  miterPivotMm?: Vec3;
  /** All miter clip planes on this tenon tip (supports 2-way corner, 3-way T-leg, and 4-way center post). */
  miterPlanes?: TenonMiterPlane[];
  cutMethod: 'bandsaw' | 'cnc';
}

export interface ZClipSlotSpec {
  id: string;
  hostMemberId: string;
  hostMemberIndex: number;
  centerMm: Vec3;
  inwardNormal: Vec3;
  lengthAxis: Vec3;
  slotLengthMm: number;
  slotWidthMm: number;
  slotDepthMm: number;
  distFromTopEdgeMm: number;
}

export interface StoppedEdgeZone {
  /** Span along the member's length axis (measured from top/end 0..L) where the roundover is active. */
  fromMm: number;
  toMm: number;
  profile: TimberEdgeProfile;
  radiusMm: number;
}

export interface SynthesizedJoint {
  id: string;
  kind: 'mortise_tenon' | 'dowel' | 'dado' | 'butt' | 'plank_dowel' | 'z_clip';
  memberAIndex: number;
  memberBIndex: number;
  memberAId: string;
  memberBId: string;
  /** Contact center in root body frame, mm. */
  centerMm: Vec3;
  /** Normal pointing from member A (tenon/rail) into member B (mortise/leg). */
  normalAToB: Vec3;
  mortise?: MortiseSpec;
  tenon?: TenonSpec;
  dowelCentersMm?: Vec3[];
  dowelDiaMm?: number;
  dowelLengthMm?: number;
  notes: string[];
}

export interface MemberJoineryPart {
  member: TimberMember;
  /** Shoulder-to-shoulder length for rails, or finished length for legs/panels, mm. */
  shoulderToShoulderMm: number;
  /** Total finished blank length including any protruding tenons on both ends, mm. */
  totalFinishedLengthMm: number;
  /** Finished cross-section [widthMm, thicknessMm]. */
  crossSectionMm: [number, number];
  mortises: MortiseSpec[];
  tenons: TenonSpec[];
  zClipSlots: ZClipSlotSpec[];
  stoppedEdgeZones: StoppedEdgeZone[];
  /** SplitSection compatible with `splitBodyForPrint` and `AssemblyPreview`. */
  section: SplitSection;
}

export interface TimberBreakdownResult {
  ok: true;
  options: Required<TimberJoineryOptions>;
  parts: MemberJoineryPart[];
  joints: SynthesizedJoint[];
  /** Sections in `SplitSection` format for 3D preview, MuJoCo test, and scene apply. */
  sections: SplitSection[];
  warnings: string[];
}

export type TimberBreakdownOutcome =
  | TimberBreakdownResult
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Vector & Frame Helpers
// ---------------------------------------------------------------------------

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const unit = (v: ArrayLike<number>): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const add3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];

const sub3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

const scale3 = (v: ArrayLike<number>, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

const neg3 = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

/** Column-major 4x4 matrix from local frame (u, v, w) and origin `at` in mm. */
function frameMat4(u: Vec3, v: Vec3, w: Vec3, at: Vec3): Mat4 {
  return [
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    w[0], w[1], w[2], 0,
    at[0], at[1], at[2], 1,
  ];
}

/** Build an oriented rectangular box Manifold centered at `centerMm` with half-extents `half` along (u, v, w). */
function orientedBoxManifold(
  wasm: ManifoldToplevel,
  centerMm: Vec3,
  u: Vec3,
  v: Vec3,
  w: Vec3,
  sizeMm: [number, number, number],
): Manifold {
  const box = wasm.Manifold.cube(sizeMm, true);
  const moved = box.transform(frameMat4(u, v, w, centerMm));
  box.delete();
  return moved;
}

/** Build an oriented cylinder Manifold centered at `centerMm` with axis `w`, length `lenMm`, and radius `rMm`. */
function orientedCylinderManifold(
  wasm: ManifoldToplevel,
  centerMm: Vec3,
  u: Vec3,
  v: Vec3,
  w: Vec3,
  lenMm: number,
  rMm: number,
  segments = 28,
): Manifold {
  const cyl = wasm.Manifold.cylinder(lenMm, rMm, rMm, segments, true);
  const moved = cyl.transform(frameMat4(u, v, w, centerMm));
  cyl.delete();
  return moved;
}

/** MuJoCo quaternion [w, x, y, z] from orthonormal columns (u, v, n). */
function quatFromAxes(u: Vec3, v: Vec3, n: Vec3): [number, number, number, number] {
  const m00 = u[0], m01 = v[0], m02 = n[0];
  const m10 = u[1], m11 = v[1], m12 = n[1];
  const m20 = u[2], m21 = v[2], m22 = n[2];
  const tr = m00 + m11 + m22;
  let qw: number, qx: number, qy: number, qz: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const l = Math.hypot(qw, qx, qy, qz) || 1;
  return [qw / l, qx / l, qy / l, qz / l];
}

/** Orthonormal tangent axes (u, v) for a given unit normal `n`. */
function planeBasis(n: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(n[2]) < 0.85 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(ref, n));
  const v = unit(cross(n, u));
  return { u, v };
}

/** Unified corner fillet radius for `round_tenon` across 3D joinery, CNC G-code, and simulation. */
export function roundTenonCornerRadiusMm(widthMm: number, thicknessMm: number, cutterDiaMm: number): number {
  return Math.min(widthMm * 0.5, thicknessMm * 0.5, Math.max(2, cutterDiaMm * 0.5));
}

/** How far an end's angled shoulder toe or tenon tip extends past `shoulderCenterMm` along `member.axes[0]`. */
export function endAllowanceAlongAxisMm(m: TimberMember, t: TenonSpec | undefined): number {
  if (!t) return 0;
  const a0 = m.axes[0];
  const cosA = Math.max(0.25, Math.abs(dot(a0, t.outwardDir)));
  const bevelToe =
    (0.5 * m.dimsMm[1] * Math.abs(dot(m.axes[1], t.outwardDir)) +
      0.5 * m.dimsMm[2] * Math.abs(dot(m.axes[2], t.outwardDir))) /
    cosA;
  const tenonReach =
    t.lengthMm * Math.abs(dot(t.outwardDir, a0)) +
    0.5 * t.widthMm * Math.abs(dot(t.uAxis, a0)) +
    0.5 * t.thicknessMm * Math.abs(dot(t.vAxis, a0));
  return Math.max(bevelToe, tenonReach);
}

/** Build an exact 4-corner rounded-rectangle prism Manifold of outer size `[w, t, depth]` and corner radius `r`. */
export function roundedRectPrismManifold(
  wasm: ManifoldToplevel,
  center: Vec3,
  u: Vec3,
  v: Vec3,
  n: Vec3,
  w: number,
  t: number,
  depth: number,
  rawRadiusMm: number,
): Manifold {
  const r = Math.max(0, Math.min(w * 0.5, t * 0.5, rawRadiusMm));
  if (r <= 1e-3) {
    return orientedBoxManifold(wasm, center, u, v, n, [w, t, depth]);
  }
  const su = Math.max(0, w - 2 * r);
  const sv = Math.max(0, t - 2 * r);
  const pieces: Manifold[] = [];
  if (sv > 1e-4) {
    pieces.push(orientedBoxManifold(wasm, center, u, v, n, [w, sv, depth]));
  }
  if (su > 1e-4) {
    pieces.push(orientedBoxManifold(wasm, center, u, v, n, [su, t, depth]));
  }
  const duList = su > 1e-4 ? [-1, 1] : [0];
  const dvList = sv > 1e-4 ? [-1, 1] : [0];
  for (const du of duList) {
    for (const dv of dvList) {
      const cPos = add3(center, add3(scale3(u, du * su * 0.5), scale3(v, dv * sv * 0.5)));
      pieces.push(orientedCylinderManifold(wasm, cPos, u, v, n, depth, r, 24));
    }
  }
  if (pieces.length === 1) return pieces[0];
  const out = wasm.Manifold.union(pieces);
  for (const p of pieces) p.delete();
  return out;
}

/**
 * Build a mortise cutter Manifold (including optional 4-corner dogbones or
 * 4-corner rounded fillets) centered at `spec.centerMm` and plunging along `spec.inwardNormal`.
 */
function buildMortiseCutter(wasm: ManifoldToplevel, spec: MortiseSpec, cutterDiaMm: number): Manifold {
  const SINK_OUTWARD_MM = 0.8;
  const totalDepth = spec.depthMm + SINK_OUTWARD_MM;
  const center = add3(
    spec.centerMm,
    scale3(spec.inwardNormal, (spec.depthMm - SINK_OUTWARD_MM) * 0.5),
  );
  const w = spec.widthMm;
  const t = spec.thicknessMm;
  const { uAxis: u, vAxis: v, inwardNormal: n } = spec;

  if (spec.cornerFit === 'round_tenon') {
    const r = spec.cornerRadiusMm ?? roundTenonCornerRadiusMm(w, t, cutterDiaMm);
    return roundedRectPrismManifold(wasm, center, u, v, n, w, t, totalDepth, r);
  }

  const baseBox = orientedBoxManifold(wasm, center, u, v, n, [w, t, totalDepth]);
  if (spec.cornerFit !== 'dogbone' || !spec.dogboneDiaMm || spec.dogboneDiaMm <= 0) {
    return baseBox;
  }

  // 4 dogbone cylinders along the corner bisectors so a square bandsawn tenon
  // drops straight in with zero hand-chiseling, while the rail's shoulder
  // completely covers the dogbones!
  const rBit = spec.dogboneDiaMm * 0.5;
  // Center of each dogbone is inset by rBit / sqrt(2) from the corner so the
  // circle's perimeter passes right through the sharp corner (w/2, t/2).
  const inset = rBit * Math.SQRT1_2;
  const du = Math.max(0, w * 0.5 - inset);
  const dv = Math.max(0, t * 0.5 - inset);
  const parts: Manifold[] = [baseBox];
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const cornerPos = add3(center, add3(scale3(u, su * du), scale3(v, sv * dv)));
      parts.push(orientedCylinderManifold(wasm, cornerPos, u, v, n, totalDepth, rBit, 20));
    }
  }
  const unioned = wasm.Manifold.union(parts);
  for (const p of parts) p.delete();
  return unioned;
}

/**
 * Build a tenon boss Manifold protruding from `spec.shoulderCenterMm` along `spec.outwardDir`.
 * Sunk `sinkMm` back into the rail's end so the boolean union is watertight, and
 * optionally mitred along all `miterPlanes` at its tip when rails meet in a corner or center leg.
 */
export function buildTenonBoss(
  wasm: ManifoldToplevel,
  spec: TenonSpec,
  cornerFit: TenonCornerFit,
  cutterDiaMm: number,
  clearanceMm = 0.15,
  sinkMm = 1.5,
): Manifold {
  const totalLen = spec.lengthMm + sinkMm;
  const center = add3(
    spec.shoulderCenterMm,
    scale3(spec.outwardDir, (spec.lengthMm - sinkMm) * 0.5),
  );
  const w = spec.widthMm;
  const t = spec.thicknessMm;
  const { uAxis: u, vAxis: v, outwardDir: n } = spec;

  let boss: Manifold;
  if (cornerFit === 'round_tenon') {
    const r = roundTenonCornerRadiusMm(w, t, cutterDiaMm);
    boss = roundedRectPrismManifold(wasm, center, u, v, n, w, t, totalLen, r);
  } else {
    boss = orientedBoxManifold(wasm, center, u, v, n, [w, t, totalLen]);
  }

  // Slice miter clip planes off the tip of the tenon when 2, 3, or 4 rails meet
  // inside the same leg/post so the tenons never collide in 3D!
  const planes: TenonMiterPlane[] =
    spec.miterPlanes && spec.miterPlanes.length > 0
      ? spec.miterPlanes
      : spec.miteredTip && spec.miterNormal
        ? [
            {
              normal: spec.miterNormal,
              pivotMm:
                spec.miterPivotMm ??
                add3(
                  spec.shoulderCenterMm,
                  scale3(spec.outwardDir, spec.lengthMm - spec.thicknessMm * 0.35 * Math.SQRT2),
                ),
            },
          ]
        : [];
  const halfGap = Math.max(0.15, clearanceMm);
  for (const mp of planes) {
    const planeOffset = dot(mp.normal, mp.pivotMm) - halfGap;
    const [, kept] = boss.splitByPlane(mp.normal, planeOffset);
    boss.delete();
    boss = kept;
  }

  return boss;
}

/**
 * Apply stopped roundovers or chamfers along the longitudinal edges of a member,
 * keeping all joint/mortise zones square within `stopMarginMm`.
 */
function applyStoppedEdgeProfiles(
  wasm: ManifoldToplevel,
  solid: Manifold,
  member: TimberMember,
  allMembers: TimberMember[],
  mortises: MortiseSpec[],
  tenons: TenonSpec[],
  profile: TimberEdgeProfile,
  radiusMm: number,
  stopMarginMm: number,
): { manifold: Manifold; zones: StoppedEdgeZone[] } {
  if (profile === 'square' || radiusMm <= 0.2) {
    return { manifold: solid, zones: [] };
  }

  const [L, W, T] = member.dimsMm;
  const [aL, aW, aT] = member.axes;
  const r = Math.min(radiusMm, Math.min(W, T) * 0.28);
  if (r < 0.5 || L < 2 * stopMarginMm + 15) {
    return { manifold: solid, zones: [] };
  }

  // Project all mortises and tenon shoulders onto the member's length coordinate [0, L]
  // where 0 is the top/positive end (+aL) and L is the bottom/negative end (-aL).
  const topEndCoord = dot(member.centerMm, aL) + L * 0.5;
  const blockedIntervals: [number, number][] = [];

  for (const m of mortises) {
    const dFromTop = topEndCoord - dot(m.centerMm, aL);
    const halfSpan = m.widthMm * 0.5 + stopMarginMm;
    blockedIntervals.push([Math.max(0, dFromTop - halfSpan), Math.min(L, dFromTop + halfSpan)]);
  }
  for (const t of tenons) {
    const dFromTop = topEndCoord - dot(t.shoulderCenterMm, aL);
    blockedIntervals.push([Math.max(0, dFromTop - stopMarginMm), Math.min(L, dFromTop + stopMarginMm)]);
  }
  // Keep 8 mm at the very top/bottom ends of a leg crisp where it meets the floor or tabletop
  if (member.role === 'leg') {
    blockedIntervals.push([0, Math.min(L, stopMarginMm)]);
    blockedIntervals.push([Math.max(0, L - 8), L]);
  } else if (member.role === 'rail') {
    blockedIntervals.push([0, Math.min(L, stopMarginMm)]);
    blockedIntervals.push([Math.max(0, L - stopMarginMm), L]);
  }

  // Merge overlapping blocked intervals and invert to get active stopped-edge zones in [0, L]
  blockedIntervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const iv of blockedIntervals) {
    const last = merged[merged.length - 1];
    if (!last || iv[0] > last[1] + 1) merged.push([iv[0], iv[1]]);
    else last[1] = Math.max(last[1], iv[1]);
  }

  const zones: StoppedEdgeZone[] = [];
  let cursor = 0;
  for (const [b0, b1] of merged) {
    if (b0 - cursor >= 18) {
      zones.push({
        fromMm: Math.round(cursor),
        toMm: Math.round(b0),
        profile,
        radiusMm: r,
      });
    }
    cursor = Math.max(cursor, b1);
  }
  if (L - cursor >= 18) {
    zones.push({
      fromMm: Math.round(cursor),
      toMm: Math.round(L),
      profile,
      radiusMm: r,
    });
  }

  if (!zones.length) {
    return { manifold: solid, zones: [] };
  }

  // Subtract 45° chamfer wedges (or multi-facet roundover cutters) along the
  // longitudinal corners of the member over each active stopped zone, skipping
  // any interior glue-seam edge where two side-by-side panels meet!
  const cutters: Manifold[] = [];
  for (const zone of zones) {
    const spanLen = zone.toMm - zone.fromMm;
    if (spanLen < 10) continue;
    const midDistFromTop = 0.5 * (zone.fromMm + zone.toMm);
    const zoneCenter = add3(member.centerMm, scale3(aL, L * 0.5 - midDistFromTop));

    for (const sw of [-1, 1]) {
      if (member.role === 'panel') {
        const sideDir = scale3(aW, sw);
        const abutsAdjacentPanel = allMembers.some((other) => {
          if (other.index === member.index || other.role !== 'panel') return false;
          const diff = sub3(other.centerMm, member.centerMm);
          if (Math.abs(dot(diff, aT)) > (T + other.dimsMm[2]) * 0.5 + 5) return false;
          if (Math.abs(dot(diff, aL)) > (L + other.dimsMm[0]) * 0.5) return false;
          const distAlongSide = dot(diff, sideDir);
          const expectedDist = (W + other.dimsMm[1]) * 0.5;
          return Math.abs(distAlongSide - expectedDist) <= 12;
        });
        if (abutsAdjacentPanel) continue;
      }

      for (const st of [-1, 1]) {
        const cornerCenter = add3(
          zoneCenter,
          add3(scale3(aW, sw * W * 0.5), scale3(aT, st * T * 0.5)),
        );
        const bisector = unit(add3(scale3(aW, sw), scale3(aT, st)));
        const tangent = unit(cross(aL, bisector));
        // For chamfer, a box rotated 45° whose inner face sits `r / sqrt(2)` inside the corner
        const depth = profile === 'chamfer' ? r * Math.SQRT1_2 : r * (Math.SQRT2 - 1);
        const boxDepth = r * 2;
        const cutterCenter = add3(cornerCenter, scale3(bisector, boxDepth * 0.5 - depth));
        cutters.push(
          orientedBoxManifold(wasm, cutterCenter, tangent, bisector, aL, [r * 2.2, boxDepth, spanLen]),
        );
      }
    }
  }

  if (!cutters.length) {
    return { manifold: solid, zones };
  }
  const allCutters = wasm.Manifold.union(cutters);
  for (const c of cutters) c.delete();
  const rounded = solid.subtract(allCutters);
  allCutters.delete();
  solid.delete();
  return { manifold: rounded, zones };
}

/**
 * Main entry point: extract structural timber members from `soupsMetres` and
 * synthesize all mortise-and-tenon / dowel / dado / Z-clip joints and stopped
 * edge profiles.
 */
export function synthesizeTimberJoinery(
  wasm: ManifoldToplevel,
  soupsMetres: ArrayLike<number>[],
  rawOptions: TimberJoineryOptions = {},
  hintNames?: (string | undefined)[],
): TimberBreakdownOutcome {
  const options: Required<TimberJoineryOptions> = {
    ...DEFAULT_TIMBER_JOINERY_OPTIONS,
    ...Object.fromEntries(Object.entries(rawOptions).filter(([, v]) => v !== undefined)),
  };

  const extracted = extractTimberMembers(wasm, soupsMetres, {
    maxBoardWidthMm: options.maxBoardWidthMm,
    splitWidePanels: true,
    hintNames,
  });
  if (!extracted.ok) return extracted;

  const { members, warnings } = extracted;
  const solids: Manifold[] = members.map((m) => {
    const raw = meshMmToManifold(wasm, m.positionsMm, m.faces);
    const obbVol = m.dimsMm[0] * m.dimsMm[1] * m.dimsMm[2];
    const fillRatio = m.volumeMm3 / Math.max(1e-6, obbVol);
    // If a non-tapered rectangular timber bar already had mortise pockets or
    // tenon shoulder rabbets cut into it (fill ratio 84%..99.8%, above the π/4 ≈ 78.5%
    // fill ratio of a circular disc/cylinder), start from its clean OBB blank so
    // re-synthesizing joinery with new options doesn't double-cut.
    if (!m.isTapered && fillRatio > 0.84 && fillRatio < 0.9999) {
      raw.delete();
      return orientedBoxManifold(wasm, m.centerMm, m.axes[0], m.axes[1], m.axes[2], m.dimsMm);
    }
    return raw;
  });
  const plainSolids: Manifold[] = members.map((m) => {
    const raw = meshMmToManifold(wasm, m.positionsMm, m.faces);
    const obbVol = m.dimsMm[0] * m.dimsMm[1] * m.dimsMm[2];
    const fillRatio = m.volumeMm3 / Math.max(1e-6, obbVol);
    if (!m.isTapered && fillRatio > 0.84 && fillRatio < 0.9999) {
      raw.delete();
      return orientedBoxManifold(wasm, m.centerMm, m.axes[0], m.axes[1], m.axes[2], m.dimsMm);
    }
    return raw;
  });

  const mortisesByMember: MortiseSpec[][] = members.map(() => []);
  const tenonsByMember: TenonSpec[][] = members.map(() => []);
  const zClipsByMember: ZClipSlotSpec[][] = members.map(() => []);
  const featuresByMember: JoineryFeature[][] = members.map(() => []);
  const collidersByMember: FeatureCollider[][] = members.map(() => []);
  const explodeByMember: Vec3[] = members.map(() => [0, 0, 0]);
  const joints: SynthesizedJoint[] = [];

  // Track shoulder-to-shoulder adjustments when overlapping members are trimmed flush
  // (positive = trimmed back; negative = bridged across a small end-gap).
  const lengthTrimMm: [number, number][] = members.map(() => [0, 0]);

  try {
    // -------------------------------------------------------------------------
    // 0. Trim Legs & Rails that Overlap into Tabletop / Shelf Panels, and
    //    Resolve Any Residual Panel-to-Panel Overlaps
    // -------------------------------------------------------------------------
    for (let pIdx = 0; pIdx < members.length; pIdx++) {
      if (members[pIdx].role !== 'panel') continue;
      const pIsHoriz = Math.abs(members[pIdx].axes[2][2]) >= 0.5;
      for (let mIdx = 0; mIdx < members.length; mIdx++) {
        if (mIdx === pIdx) continue;
        if (members[mIdx].role === 'panel') {
          const mIsVert = Math.abs(members[mIdx].axes[2][2]) < 0.5;
          // If `pIdx` is an interior horizontal shelf and `mIdx` is a taller vertical side wall
          // extending past `pIdx` both above and below, let the vertical side wall trim the shelf
          // (not the shelf slicing through the side wall!).
          if (
            pIsHoriz &&
            mIsVert &&
            members[mIdx].bboxMm.max[2] > members[pIdx].bboxMm.max[2] + 5 &&
            members[mIdx].bboxMm.min[2] < members[pIdx].bboxMm.min[2] - 5
          ) {
            continue;
          }
          const pIsVert = !pIsHoriz;
          const mIsHoriz = Math.abs(members[mIdx].axes[2][2]) >= 0.5;
          const pWallsM =
            pIsVert &&
            mIsHoriz &&
            members[pIdx].bboxMm.max[2] > members[mIdx].bboxMm.max[2] + 5 &&
            members[pIdx].bboxMm.min[2] < members[mIdx].bboxMm.min[2] - 5;
          if (!pWallsM && mIdx < pIdx) continue;
        }
        const inter = solids[mIdx].intersect(plainSolids[pIdx]);
        const vol = inter.volume();
        inter.delete();
        if (vol > 1) {
          const trimmed = solids[mIdx].subtract(plainSolids[pIdx]);
          if (trimmed.volume() > solids[mIdx].volume() * 0.4) {
            solids[mIdx].delete();
            solids[mIdx] = trimmed;
            const trimmedPlain = plainSolids[mIdx].subtract(plainSolids[pIdx]);
            plainSolids[mIdx].delete();
            plainSolids[mIdx] = trimmedPlain;

            const mesh = trimmedPlain.getMesh();
            const p = mesh.numProp;
            const nVerts = mesh.vertProperties.length / p;
            if (nVerts > 0) {
              const cOld = members[mIdx].centerMm;
              let nextCenter: Vec3 = [cOld[0], cOld[1], cOld[2]];
              for (const axisIdx of [0, 1, 2] as const) {
                const aTrim = members[mIdx].axes[axisIdx];
                let minProj = Infinity;
                let maxProj = -Infinity;
                for (let v = 0; v < nVerts; v++) {
                  const vx = mesh.vertProperties[v * p] - cOld[0];
                  const vy = mesh.vertProperties[v * p + 1] - cOld[1];
                  const vz = mesh.vertProperties[v * p + 2] - cOld[2];
                  const proj = vx * aTrim[0] + vy * aTrim[1] + vz * aTrim[2];
                  if (proj < minProj) minProj = proj;
                  if (proj > maxProj) maxProj = proj;
                }
                const newSpan = maxProj - minProj;
                const midShift = 0.5 * (minProj + maxProj);
                members[mIdx].dimsMm[axisIdx] = +newSpan.toFixed(2);
                nextCenter = add3(nextCenter, scale3(aTrim, midShift));
              }
              members[mIdx].centerMm = nextCenter;
            }
          } else {
            trimmed.delete();
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 1. Detect Rail-to-Leg, Rail-to-Rail, Brace, and Panel Dado/Dowel Contacts
    // -------------------------------------------------------------------------
    const PROBE_EXPAND_MM = 2.5;
    const MAX_END_GAP_MM = 5.0;
    let jointCounter = 1;

    const probeHostForEnd = (
      selfIdx: number,
      endCenter: Vec3,
      endOutward: Vec3,
      wid: number,
      thk: number,
      axW: Vec3,
      axT: Vec3,
      selfRole: TimberMember['role'],
      selfAxes0Z: number,
    ): { bestHostIdx: number; bestOverlapVol: number } => {
      const probeCenter = add3(endCenter, scale3(endOutward, PROBE_EXPAND_MM * 0.5));
      const probeBox = orientedBoxManifold(
        wasm,
        probeCenter,
        axW,
        axT,
        endOutward,
        [Math.max(2, wid - 0.5), Math.max(2, thk - 0.5), PROBE_EXPAND_MM * 2 + 4],
      );
      let bestHostIdx = -1;
      let bestOverlapVol = 0;
      for (let j = 0; j < members.length; j++) {
        if (selfIdx === j) continue;
        const mB = members[j];
        // A horizontal rail does not end-frame into a horizontal tabletop panel
        if (selfRole === 'rail' && Math.abs(selfAxes0Z) < 0.25 && mB.role === 'panel' && Math.abs(mB.axes[2][2]) > 0.7) {
          continue;
        }
        const inter = probeBox.intersect(plainSolids[j]);
        const vol = inter.volume();
        inter.delete();
        if (vol > bestOverlapVol && vol > 15) {
          bestOverlapVol = vol;
          bestHostIdx = j;
        }
      }
      probeBox.delete();
      return { bestHostIdx, bestOverlapVol };
    };

    for (let i = 0; i < members.length; i++) {
      const mA = members[i];
      const canPanelFrame =
        mA.role === 'panel' &&
        !mA.plankInfo &&
        (options.jointMode === 'dado' || options.jointMode === 'dowel');
      if (mA.role !== 'rail' && !canPanelFrame) continue;

      // For a panel (e.g. a bookcase shelf deeper than it is wide), check if its
      // housing contacts lie on ±axes[1] instead of ±axes[0]; if so, align axes[0]
      // with the spanning axis between the side panels.
      if (canPanelFrame) {
        const [l0, w0, t0] = mA.dimsMm;
        const [a0, a1, a2] = mA.axes;
        const hitsAxis0 = ([-1, 1] as const).filter((s) => {
          const out = scale3(a0, s);
          const ec = add3(mA.centerMm, scale3(a0, s * l0 * 0.5));
          const { bestHostIdx } = probeHostForEnd(i, ec, out, w0, t0, a1, a2, mA.role, a0[2]);
          if (bestHostIdx < 0) return false;
          const mB = members[bestHostIdx];
          return mB.role === 'panel' && Math.abs(dot(mB.axes[2], out)) > 0.85;
        }).length;
        if (hitsAxis0 === 0) {
          const hitsAxis1 = ([-1, 1] as const).filter((s) => {
            const out = scale3(a1, s);
            const ec = add3(mA.centerMm, scale3(a1, s * w0 * 0.5));
            const { bestHostIdx } = probeHostForEnd(i, ec, out, l0, t0, a0, a2, mA.role, a1[2]);
            if (bestHostIdx < 0) return false;
            const mB = members[bestHostIdx];
            return mB.role === 'panel' && Math.abs(dot(mB.axes[2], out)) > 0.85;
          }).length;
          if (hitsAxis1 > 0) {
            const nextA0 = a1;
            const nextA1 = a0;
            const nextA2 = unit(cross(nextA0, nextA1));
            mA.axes = [nextA0, nextA1, nextA2];
            mA.dimsMm = [w0, l0, t0];
            const refDir: Vec3 = Math.abs(nextA1[2]) > 0.7 ? [0, 0, 1] : [0, -1, 0];
            const f2Normal: Vec3 = dot(nextA1, refDir) >= 0 ? nextA1 : neg3(nextA1);
            mA.face2 = { normal: f2Normal, label: `${directionPhrase(f2Normal)} Jointed Edge` };
          }
        }
      }

      const [lenA, widA, thkA] = mA.dimsMm;
      const [axisLA, axisWA, axisTA] = mA.axes;

      // Test both ends of `mA` ('start' at -axisLA, 'end' at +axisLA)
      for (const endKind of ['start', 'end'] as const) {
        const endSign = endKind === 'end' ? 1 : -1;
        const endOutward: Vec3 = scale3(axisLA, endSign);
        const endCenter: Vec3 = add3(mA.centerMm, scale3(axisLA, endSign * (lenA * 0.5)));

        const { bestHostIdx } = probeHostForEnd(
          i,
          endCenter,
          endOutward,
          widA,
          thkA,
          axisWA,
          axisTA,
          mA.role,
          axisLA[2],
        );

        if (bestHostIdx < 0) continue;
        const mB = members[bestHostIdx];

        // Determine the host face normal on `mB` that faces `mA`
        const [, widB, thkB] = mB.dimsMm;
        const [, axisWB, axisTB] = mB.axes;
        const candNormals: { n: Vec3; depthAvail: number; faceSpread: number; spreadAxis: Vec3 }[] = [
          { n: axisWB, depthAvail: widB, faceSpread: thkB, spreadAxis: axisTB },
          { n: neg3(axisWB), depthAvail: widB, faceSpread: thkB, spreadAxis: axisTB },
          { n: axisTB, depthAvail: thkB, faceSpread: widB, spreadAxis: axisWB },
          { n: neg3(axisTB), depthAvail: thkB, faceSpread: widB, spreadAxis: axisWB },
        ];
        candNormals.sort((a, b) => dot(b.n, endOutward) - dot(a.n, endOutward));
        // `inwardNormal` points from the rail end INTO the host `mB`
        const chosenHost = candNormals[0];
        const inwardNormal = chosenHost.n;
        const hostFaceNormal = neg3(inwardNormal);

        // Compute the shoulder plane offset where `mB`'s face sits
        const distCenterBToFace = chosenHost.depthAvail * 0.5;
        const facePlaneOffset = dot(mB.centerMm, hostFaceNormal) + distCenterBToFace;
        const endDotFace = dot(endCenter, hostFaceNormal);
        const denom = dot(endOutward, hostFaceNormal);
        if (Math.abs(denom) < 0.35) continue;
        const tAlong = (facePlaneOffset - endDotFace) / denom;
        if (tAlong > MAX_END_GAP_MM) {
          warnings.push(
            `${mA.id} (${endKind} end) stands ${tAlong.toFixed(1)} mm short of ${mB.id} (> ${MAX_END_GAP_MM} mm gap tolerance); joint skipped.`,
          );
          continue;
        }
        const shoulderCenterMm: Vec3 = add3(endCenter, scale3(endOutward, tAlong));

        // Local mortise/tenon axes on the joint face:
        //   uAxis = along rail/shelf width
        //   vAxis = across rail/shelf thickness
        const uAxis = unit(
          sub3(axisWA, scale3(inwardNormal, dot(axisWA, inwardNormal))),
        );
        const vAxis = unit(cross(inwardNormal, uAxis));

        // Host face available spans along uAxis and vAxis
        const hostSpanU = mB.axes.reduce((s, a, idx) => s + Math.abs(dot(a, uAxis)) * mB.dimsMm[idx], 0);
        const hostSpanV = mB.axes.reduce((s, a, idx) => s + Math.abs(dot(a, vAxis)) * mB.dimsMm[idx], 0);

        // Panel-to-panel dadoes/dowels only form when the host face is broad enough to house the panel
        if (mA.role === 'panel' && (hostSpanU < widA * 0.75 || hostSpanV < thkA + 4)) {
          continue;
        }

        // Trim any overlap of `mA` inside `mB` so the shoulder seats cleanly on `mB`'s outer face
        const rawOverlap = solids[i].intersect(plainSolids[bestHostIdx]);
        const overlapVol = rawOverlap.volume();
        rawOverlap.delete();
        if (overlapVol > 1) {
          const trimmed = solids[i].subtract(plainSolids[bestHostIdx]);
          if (trimmed.volume() > solids[i].volume() * 0.4) {
            solids[i].delete();
            solids[i] = trimmed;
            const trimmedPlain = plainSolids[i].subtract(plainSolids[bestHostIdx]);
            plainSolids[i].delete();
            plainSolids[i] = trimmedPlain;
          } else {
            trimmed.delete();
          }
        }

        // Bridge small positive end-gaps (0 < tAlong <= MAX_END_GAP_MM) or angled-shoulder
        // bevel wedges so the rail/brace body meets the shoulder plane cleanly as 1 solid
        const bevelExtra =
          (0.5 * widA * Math.abs(dot(axisWA, hostFaceNormal)) +
            0.5 * thkA * Math.abs(dot(axisTA, hostFaceNormal))) /
          Math.abs(denom);
        if (tAlong > 0.05 || bevelExtra > 0.15) {
          const backReach = Math.max(2.5, bevelExtra + 2.0);
          const fwdReach = Math.max(0, tAlong) + bevelExtra + 1.0;
          const extLen = backReach + fwdReach;
          const extCenter = add3(endCenter, scale3(endOutward, (fwdReach - backReach) * 0.5));
          const extRaw = orientedBoxManifold(wasm, extCenter, axisWA, axisTA, endOutward, [widA, thkA, extLen]);
          const [frontDiscard, clipped] = extRaw.splitByPlane(
            inwardNormal,
            dot(inwardNormal, shoulderCenterMm),
          );
          frontDiscard.delete();
          extRaw.delete();
          let cleanExt = clipped;
          for (let k = 0; k < members.length; k++) {
            if (k === i) continue;
            const testInter = cleanExt.intersect(plainSolids[k]);
            const iv = testInter.volume();
            testInter.delete();
            if (iv > 1e-2) {
              const subbed = cleanExt.subtract(plainSolids[k]);
              cleanExt.delete();
              cleanExt = subbed;
            }
          }
          if (cleanExt.volume() > 1e-2) {
            const nextSolid = solids[i].add(cleanExt);
            solids[i].delete();
            solids[i] = nextSolid;
            const nextPlain = plainSolids[i].add(cleanExt);
            plainSolids[i].delete();
            plainSolids[i] = nextPlain;
          }
          cleanExt.delete();
        }

        // Signed length adjustment along endOutward (+ when trimmed back, - when bridged forward).
        // Clamp positive trims to at most 45% of the member length per end so curved/non-rectilinear
        // parts cannot yield negative shoulder-to-shoulder lengths or negative stock usage.
        const rawTrim = dot(sub3(endCenter, shoulderCenterMm), endOutward);
        const signedTrim = Math.min(rawTrim, mA.dimsMm[0] * 0.45);
        if (Math.abs(signedTrim) > 0.05) {
          lengthTrimMm[i][endKind === 'start' ? 0 : 1] = signedTrim;
        }

        // Shoulder angle between the rail's axis and the leg's face normal
        const cosAngle = Math.min(1, Math.max(-1, Math.abs(dot(endOutward, inwardNormal))));
        const shoulderAngleDeg = +(Math.acos(cosAngle) * (180 / Math.PI)).toFixed(1);

        // Size the tenon / dado tongue and mortise / dado housing:
        const minCutter = Math.max(4, options.cutterDiaMm);
        // Never allow tenon/tongue thickness or width to exceed the rail or host face
        // (which previously happened when cutterDiaMm was larger than thin stock,
        // producing negative cheek shoulders and protruding tenons).
        const maxTenonThk = Math.min(thkA, Math.max(2, Math.min(thkA - 2, hostSpanV - 4)));
        const maxTenonWid = Math.min(widA, Math.max(4, Math.min(widA - 2, hostSpanU - 4)));
        let nominalTenonThk: number;
        let nominalTenonWid: number;
        let maxSafeDepth: number;

        if (options.jointMode === 'dado') {
          const dadoStopMm = mA.role === 'panel' ? Math.max(8, options.shoulderMm) : options.shoulderMm;
          const cheekShoulderMm = Math.max(2, Math.min(options.shoulderMm * 0.5, thkA * 0.15));
          nominalTenonThk = Math.min(
            maxTenonThk,
            Math.max(
              Math.min(minCutter, maxTenonThk),
              Math.min(thkA - 2 * cheekShoulderMm, hostSpanV - 6),
            ),
          );
          nominalTenonWid = Math.min(
            maxTenonWid,
            Math.max(
              Math.min(minCutter + 2, maxTenonWid),
              Math.min(widA - 2 * dadoStopMm, hostSpanU - 2 * dadoStopMm),
            ),
          );
          maxSafeDepth =
            chosenHost.depthAvail <= 26
              ? Math.max(5, +(chosenHost.depthAvail * 0.5 - options.glueReliefMm).toFixed(2))
              : Math.max(8, chosenHost.depthAvail * 0.68 - 3);
        } else {
          const rawThk = Math.max(
            minCutter,
            Math.min(
              thkA - 2 * Math.max(2, options.shoulderMm * 0.6),
              Math.round((thkA * 0.4) * 2) / 2,
            ),
          );
          const rawWid = Math.max(minCutter + 2, widA - 2 * options.shoulderMm);
          nominalTenonThk = Math.min(
            maxTenonThk,
            rawThk,
            Math.max(Math.min(minCutter, maxTenonThk), hostSpanV - 2 * Math.max(2.5, options.shoulderMm * 0.5)),
          );
          nominalTenonWid = Math.min(
            maxTenonWid,
            rawWid,
            Math.max(Math.min(minCutter, maxTenonWid), hostSpanU - 2 * Math.max(3, options.shoulderMm)),
          );
          maxSafeDepth =
            chosenHost.depthAvail <= 24
              ? Math.max(5, +(chosenHost.depthAvail * 0.5 - options.glueReliefMm).toFixed(2))
              : Math.max(10, chosenHost.depthAvail * 0.68 - 3);
        }
        const nominalTenonLen = Math.min(options.tenonLengthMm, maxSafeDepth);

        const jointId = `J${jointCounter++}`;
        const groupIdx = joints.length;

        if (options.jointMode === 'butt') {
          explodeByMember[i] = add3(explodeByMember[i], hostFaceNormal);
          joints.push({
            id: jointId,
            kind: 'butt',
            memberAIndex: i,
            memberBIndex: bestHostIdx,
            memberAId: mA.id,
            memberBId: mB.id,
            centerMm: shoulderCenterMm,
            normalAToB: inwardNormal,
            notes: [`Butt glue joint between ${mA.id} and ${mB.id}.`],
          });
          continue;
        }

        if (options.jointMode === 'dowel') {
          // Twin dowels so the rail cannot twist/rack; nominalTenonLen is the per-side engagement depth
          const dowelDia = Math.min(8, Math.max(6, Math.round(thkA * 0.35)));
          const dowelLen = Math.max(16, Math.round(nominalTenonLen * 2));
          const spacing = Math.max(dowelDia + 6, nominalTenonWid * 0.5);
          const centers: Vec3[] = widA >= dowelDia * 2.5 + 8
            ? [
                add3(shoulderCenterMm, scale3(uAxis, -spacing * 0.5)),
                add3(shoulderCenterMm, scale3(uAxis, spacing * 0.5)),
              ]
            : [shoulderCenterMm];

          const holeR = (dowelDia + options.clearanceMm) * 0.5;
          const holeDepth = dowelLen * 0.5 + 1.0;
          for (const c of centers) {
            const cLeg = add3(c, scale3(inwardNormal, holeDepth * 0.5 - 0.5));
            const boreLeg = orientedCylinderManifold(wasm, cLeg, uAxis, vAxis, inwardNormal, holeDepth + 1, holeR, 24);
            const nextLeg = solids[bestHostIdx].subtract(boreLeg);
            boreLeg.delete();
            solids[bestHostIdx].delete();
            solids[bestHostIdx] = nextLeg;

            const cRail = add3(c, scale3(hostFaceNormal, holeDepth * 0.5 - 0.5));
            const boreRail = orientedCylinderManifold(wasm, cRail, uAxis, vAxis, hostFaceNormal, holeDepth + 1, holeR, 24);
            const nextRail = solids[i].subtract(boreRail);
            boreRail.delete();
            solids[i].delete();
            solids[i] = nextRail;
          }

          explodeByMember[i] = add3(explodeByMember[i], hostFaceNormal);
          joints.push({
            id: jointId,
            kind: 'dowel',
            memberAIndex: i,
            memberBIndex: bestHostIdx,
            memberAId: mA.id,
            memberBId: mB.id,
            centerMm: shoulderCenterMm,
            normalAToB: inwardNormal,
            dowelCentersMm: centers,
            dowelDiaMm: dowelDia,
            dowelLengthMm: dowelLen,
            notes: [
              `${centers.length}× Ø${dowelDia}×${dowelLen} mm hardwood dowels between ${mA.id} and ${mB.id}.`,
            ],
          });
          continue;
        }

        // Preliminary distance from host's plain top end (recomputed against finalized totalFinishedLengthMm tip in Step 2c)
        const hostTopCoord = dot(mB.centerMm, mB.axes[0]) + mB.dimsMm[0] * 0.5;
        const distFromTopEndMm = +(hostTopCoord - dot(shoulderCenterMm, mB.axes[0])).toFixed(2);
        const mWidth = +(nominalTenonWid + options.clearanceMm).toFixed(2);
        const mThick = +(nominalTenonThk + options.clearanceMm).toFixed(2);
        const lateralOffset = dot(sub3(shoulderCenterMm, mB.centerMm), chosenHost.spreadAxis);
        const distFromRefEdgeMm = +Math.max(
          mThick * 0.5,
          Math.min(chosenHost.faceSpread - mThick * 0.5, chosenHost.faceSpread * 0.5 + lateralOffset),
        ).toFixed(2);

        const mortiseSpec: MortiseSpec = {
          id: `M_${mB.id}_${mA.id}`,
          jointId,
          hostMemberId: mB.id,
          hostMemberIndex: bestHostIdx,
          matingMemberId: mA.id,
          centerMm: shoulderCenterMm,
          inwardNormal,
          faceNormal: hostFaceNormal,
          uAxis,
          vAxis,
          widthMm: mWidth,
          thicknessMm: mThick,
          depthMm: +(nominalTenonLen + options.glueReliefMm).toFixed(2),
          distFromTopEndMm,
          distFromRefEdgeMm,
          cornerFit: options.tenonCornerFit,
          dogboneDiaMm: options.tenonCornerFit === 'dogbone' ? options.cutterDiaMm : undefined,
          cornerRadiusMm:
            options.tenonCornerFit === 'round_tenon'
              ? +roundTenonCornerRadiusMm(mWidth, mThick, options.cutterDiaMm).toFixed(3)
              : options.tenonCornerFit === 'chisel_square'
                ? +(options.cutterDiaMm * 0.5).toFixed(3)
                : undefined,
        };

        const tenonSpec: TenonSpec = {
          id: `T_${mA.id}_${endKind}`,
          jointId,
          railMemberId: mA.id,
          railMemberIndex: i,
          matingMemberId: mB.id,
          railEnd: endKind,
          shoulderCenterMm,
          outwardDir: inwardNormal,
          uAxis,
          vAxis,
          widthMm: +nominalTenonWid.toFixed(2),
          thicknessMm: +nominalTenonThk.toFixed(2),
          lengthMm: +nominalTenonLen.toFixed(2),
          shoulderTopBotMm: +Math.max(0, (widA - nominalTenonWid) * 0.5).toFixed(2),
          shoulderCheekMm: +Math.max(0, (thkA - nominalTenonThk) * 0.5).toFixed(2),
          shoulderAngleDeg,
          miteredTip: false,
          miterPlanes: [],
          cutMethod: shoulderAngleDeg > 1.5 ? 'cnc' : options.tenonCutMethod,
        };

        mortisesByMember[bestHostIdx].push(mortiseSpec);
        tenonsByMember[i].push(tenonSpec);
        explodeByMember[i] = add3(explodeByMember[i], hostFaceNormal);

        const jointNotes: string[] =
          options.tenonCornerFit === 'chisel_square'
            ? [`Square the 4 mortise corners in ${mB.id} with a bench chisel after CNC milling.`]
            : [];
        if (options.cutterDiaMm > mortiseSpec.thicknessMm + 1e-6 || options.cutterDiaMm > mortiseSpec.widthMm + 1e-6) {
          const minPocketMm = Math.min(mortiseSpec.thicknessMm, mortiseSpec.widthMm);
          const bitWarning = `CNC bit Ø${options.cutterDiaMm} mm is wider than ${options.jointMode === 'dado' ? 'dado' : 'mortise'} ${mortiseSpec.id} (${minPocketMm} mm) — switch to a ≤${Math.max(1, Math.floor(minPocketMm * 2) / 2)} mm bit or cut by hand.`;
          warnings.push(bitWarning);
          jointNotes.push(bitWarning);
        }

        joints.push({
          id: jointId,
          kind: options.jointMode === 'dado' ? 'dado' : 'mortise_tenon',
          memberAIndex: i,
          memberBIndex: bestHostIdx,
          memberAId: mA.id,
          memberBId: mB.id,
          centerMm: shoulderCenterMm,
          normalAToB: inwardNormal,
          mortise: mortiseSpec,
          tenon: tenonSpec,
          notes: jointNotes,
        });
        void groupIdx;
      }
    }

    // -------------------------------------------------------------------------
    // 2. Resolve Opposite-Face & Multi-Way Corner Tenon Collisions inside Hosts
    // -------------------------------------------------------------------------
    for (let legIdx = 0; legIdx < members.length; legIdx++) {
      const legMortises = mortisesByMember[legIdx];
      if (legMortises.length < 2) continue;
      const aHost = members[legIdx].axes[0];

      // 2a. Opposite-face coaxial tenons (`dot < -0.85`): shorten both depths so
      //     opposite tenons (and blind mortise floors) never collide inside a center post/panel!
      for (let a = 0; a < legMortises.length; a++) {
        for (let b = a + 1; b < legMortises.length; b++) {
          const m1 = legMortises[a];
          const m2 = legMortises[b];
          if (dot(m1.inwardNormal, m2.inwardNormal) >= -0.85) continue;

          const diff = sub3(m2.centerMm, m1.centerMm);
          const half2U =
            0.5 *
            (Math.abs(dot(m2.uAxis, m1.uAxis)) * m2.widthMm +
              Math.abs(dot(m2.vAxis, m1.uAxis)) * m2.thicknessMm);
          const half2V =
            0.5 *
            (Math.abs(dot(m2.uAxis, m1.vAxis)) * m2.widthMm +
              Math.abs(dot(m2.vAxis, m1.vAxis)) * m2.thicknessMm);
          if (
            Math.abs(dot(diff, m1.uAxis)) >= 0.5 * m1.widthMm + half2U ||
            Math.abs(dot(diff, m1.vAxis)) >= 0.5 * m1.thicknessMm + half2V
          ) {
            continue;
          }

          const faceToFaceDist = Math.abs(dot(diff, m1.inwardNormal));
          if (faceToFaceDist <= 4) continue;

          const j1 = joints.find((j) => j.id === m1.jointId);
          const j2 = joints.find((j) => j.id === m2.jointId);
          if (!j1?.tenon || !j2?.tenon) continue;

          const minClearBetweenTenons = Math.max(1.0, 2 * options.clearanceMm);
          if (
            j1.tenon.lengthMm + j2.tenon.lengthMm > faceToFaceDist - minClearBetweenTenons ||
            m1.depthMm + m2.depthMm > faceToFaceDist - 0.6
          ) {
            const reliefEach = Math.min(options.glueReliefMm, Math.max(0.4, faceToFaceDist * 0.08));
            const maxHalfTenon = Math.max(
              4,
              +((faceToFaceDist - minClearBetweenTenons) * 0.5 - reliefEach).toFixed(2),
            );
            j1.tenon.lengthMm = Math.min(j1.tenon.lengthMm, maxHalfTenon);
            j2.tenon.lengthMm = Math.min(j2.tenon.lengthMm, maxHalfTenon);
            m1.depthMm = +(j1.tenon.lengthMm + reliefEach).toFixed(2);
            m2.depthMm = +(j2.tenon.lengthMm + reliefEach).toFixed(2);
            j1.notes.push(
              `Shortened tenon to ${j1.tenon.lengthMm} mm inside ${members[legIdx].id} to clear opposite ${j2.memberAId}.`,
            );
            j2.notes.push(
              `Shortened tenon to ${j2.tenon.lengthMm} mm inside ${members[legIdx].id} to clear opposite ${j1.memberAId}.`,
            );
          }
        }
      }

      // 2b. Adjacent / perpendicular tenons (`|dot| <= 0.85`): slice 45° separating
      //     miter planes on all meeting pairs (supports 2-way corner, 3-way T-leg, and 4-way center post!).
      for (let a = 0; a < legMortises.length; a++) {
        for (let b = a + 1; b < legMortises.length; b++) {
          const m1 = legMortises[a];
          const m2 = legMortises[b];
          const d = dot(m1.inwardNormal, m2.inwardNormal);
          if (Math.abs(d) > 0.85) continue;

          // Check whether their spans along the host's primary axis overlap
          const span1 =
            Math.abs(dot(m1.uAxis, aHost)) * m1.widthMm +
            Math.abs(dot(m1.vAxis, aHost)) * m1.thicknessMm;
          const span2 =
            Math.abs(dot(m2.uAxis, aHost)) * m2.widthMm +
            Math.abs(dot(m2.vAxis, aHost)) * m2.thicknessMm;
          if (Math.abs(dot(sub3(m1.centerMm, m2.centerMm), aHost)) > 0.5 * (span1 + span2)) {
            continue;
          }

          const denom = 1 - d * d;
          if (denom < 1e-4) continue;
          const w0 = sub3(m1.centerMm, m2.centerMm);
          const s1 = (d * dot(w0, m2.inwardNormal) - dot(w0, m1.inwardNormal)) / denom;
          const s2 = (dot(w0, m2.inwardNormal) - d * dot(w0, m1.inwardNormal)) / denom;

          const j1 = joints.find((j) => j.id === m1.jointId);
          const j2 = joints.find((j) => j.id === m2.jointId);
          if (!j1?.tenon || !j2?.tenon) continue;

          const half2Along1 =
            0.5 *
            (Math.abs(dot(m2.uAxis, m1.inwardNormal)) * m2.widthMm +
              Math.abs(dot(m2.vAxis, m1.inwardNormal)) * m2.thicknessMm);
          const half1Along2 =
            0.5 *
            (Math.abs(dot(m1.uAxis, m2.inwardNormal)) * m1.widthMm +
              Math.abs(dot(m1.vAxis, m2.inwardNormal)) * m1.thicknessMm);
          if (
            !(
              s1 > 0 &&
              s2 > 0 &&
              m1.depthMm > s1 - half2Along1 &&
              m2.depthMm > s2 - half1Along2
            )
          ) {
            continue;
          }

          const miterPivotMm = scale3(
            add3(
              add3(m1.centerMm, scale3(m1.inwardNormal, s1)),
              add3(m2.centerMm, scale3(m2.inwardNormal, s2)),
            ),
            0.5,
          );
          const nSep1 = unit(sub3(m1.inwardNormal, m2.inwardNormal));
          const nSep2 = neg3(nSep1);

          j1.tenon.miteredTip = true;
          j1.tenon.miterNormal = nSep1;
          j1.tenon.miterPivotMm = miterPivotMm;
          j1.tenon.miterPlanes = [...(j1.tenon.miterPlanes ?? []), { normal: nSep1, pivotMm: miterPivotMm }];

          j2.tenon.miteredTip = true;
          j2.tenon.miterNormal = nSep2;
          j2.tenon.miterPivotMm = miterPivotMm;
          j2.tenon.miterPlanes = [...(j2.tenon.miterPlanes ?? []), { normal: nSep2, pivotMm: miterPivotMm }];

          j1.notes.push(
            `45° mitered tenon tip inside ${members[legIdx].id} so ${j1.memberAId} and ${j2.memberAId} meet without colliding.`,
          );
          j2.notes.push(
            `45° mitered tenon tip inside ${members[legIdx].id} so ${j2.memberAId} and ${j1.memberAId} meet without colliding.`,
          );
        }
      }
    }

    // 2c. Finalize `distFromTopEndMm` on every mortise using the host's physical
    //     +axes[0] finished blank tip (including any 'end' tenon/tongue and trim),
    //     so setup sheets, Z-clip slots, G-code Y0 stops, and simulation share one datum!
    for (let hostIdx = 0; hostIdx < members.length; hostIdx++) {
      const mHost = members[hostIdx];
      const a0 = mHost.axes[0];
      const posShoulder = dot(mHost.centerMm, a0) + mHost.dimsMm[0] * 0.5 - lengthTrimMm[hostIdx][1];
      const endTenon = tenonsByMember[hostIdx].find((t) => t.railEnd === 'end');
      const topTipCoord = posShoulder + endAllowanceAlongAxisMm(mHost, endTenon);
      for (const mSpec of mortisesByMember[hostIdx]) {
        mSpec.distFromTopEndMm = +(topTipCoord - dot(mSpec.centerMm, a0)).toFixed(2);
      }
    }

    // -------------------------------------------------------------------------
    // 3. Apply Mortise Subtractions & Tenon Boss Unions + Exact Colliders
    // -------------------------------------------------------------------------
    joints.forEach((joint, ji) => {
      if (!joint.mortise || !joint.tenon) return;
      const mSpec = joint.mortise;
      const tSpec = joint.tenon;

      // Subtract mortise from host leg
      const mCutter = buildMortiseCutter(wasm, mSpec, options.cutterDiaMm);
      const nextHost = solids[mSpec.hostMemberIndex].subtract(mCutter);
      mCutter.delete();
      solids[mSpec.hostMemberIndex].delete();
      solids[mSpec.hostMemberIndex] = nextHost;

      // Add tenon boss to rail end
      const tBoss = buildTenonBoss(wasm, tSpec, options.tenonCornerFit, options.cutterDiaMm, options.clearanceMm);
      const nextRail = solids[tSpec.railMemberIndex].add(tBoss);
      tBoss.delete();
      solids[tSpec.railMemberIndex].delete();
      solids[tSpec.railMemberIndex] = nextRail;

      // Record JoineryFeatures and print-fidelity FeatureColliders (in metres)
      const rEquivM = Math.min(tSpec.widthMm, tSpec.thicknessMm) * 0.5 / MM;
      featuresByMember[mSpec.hostMemberIndex].push({
        kind: 'bore',
        at: scale3(mSpec.centerMm, 1 / MM),
        axis: mSpec.inwardNormal,
        radius: rEquivM,
        depth: mSpec.depthMm / MM,
        joint: ji,
      });
      featuresByMember[tSpec.railMemberIndex].push({
        kind: 'peg',
        at: scale3(tSpec.shoulderCenterMm, 1 / MM),
        axis: tSpec.outwardDir,
        radius: rEquivM,
        depth: tSpec.lengthMm / MM,
        joint: ji,
      });

      const tenonPosMm = add3(tSpec.shoulderCenterMm, scale3(tSpec.outwardDir, tSpec.lengthMm * 0.5));
      collidersByMember[tSpec.railMemberIndex].push({
        role: 'pin',
        group: ji,
        shape: 'box',
        pos: scale3(tenonPosMm, 1 / MM),
        quat: quatFromAxes(tSpec.uAxis, tSpec.vAxis, tSpec.outwardDir),
        half: [
          (tSpec.widthMm * 0.5) / MM,
          (tSpec.thicknessMm * 0.5) / MM,
          (tSpec.lengthMm * 0.5) / MM,
        ],
      });

      // 4 socket wall colliders around the mortise so MuJoCo tests anti-racking twist!
      const wallThkMm = 2.0;
      const wallHalfZ = (mSpec.depthMm * 0.5) / MM;
      const mortiseMidMm = add3(mSpec.centerMm, scale3(mSpec.inwardNormal, mSpec.depthMm * 0.5));
      const qSocket = quatFromAxes(mSpec.uAxis, mSpec.vAxis, mSpec.inwardNormal);
      for (const su of [-1, 1]) {
        const wallCenter = add3(mortiseMidMm, scale3(mSpec.uAxis, su * (mSpec.widthMm * 0.5 + wallThkMm * 0.5)));
        collidersByMember[mSpec.hostMemberIndex].push({
          role: 'socket',
          group: ji,
          shape: 'box',
          pos: scale3(wallCenter, 1 / MM),
          quat: qSocket,
          half: [(wallThkMm * 0.5) / MM, (mSpec.thicknessMm * 0.5 + wallThkMm) / MM, wallHalfZ],
        });
      }
      for (const sv of [-1, 1]) {
        const wallCenter = add3(mortiseMidMm, scale3(mSpec.vAxis, sv * (mSpec.thicknessMm * 0.5 + wallThkMm * 0.5)));
        collidersByMember[mSpec.hostMemberIndex].push({
          role: 'socket',
          group: ji,
          shape: 'box',
          pos: scale3(wallCenter, 1 / MM),
          quat: qSocket,
          half: [(mSpec.widthMm * 0.5) / MM, (wallThkMm * 0.5) / MM, wallHalfZ],
        });
      }
    });

    // -------------------------------------------------------------------------
    // 4. Plank-to-Plank Alignment Dowels for Split Panels / Tabletops / Seats
    // -------------------------------------------------------------------------
    const plankGroups = new Map<string, TimberMember[]>();
    if (options.jointMode !== 'butt') {
      for (const m of members) {
        if (!m.plankInfo) continue;
        const gKey =
          m.plankInfo.groupId !== undefined
            ? `g:${m.plankInfo.groupId}`
            : `n:${m.plankInfo.parentName}`;
        const list = plankGroups.get(gKey);
        if (list) list.push(m);
        else plankGroups.set(gKey, [m]);
      }
    }
    for (const grp of plankGroups.values()) {
      grp.sort((a, b) => a.plankInfo!.index - b.plankInfo!.index);
      for (let p = 0; p + 1 < grp.length; p++) {
        const pA = grp[p];
        const pB = grp[p + 1];
        if (pB.plankInfo!.index !== pA.plankInfo!.index + 1) continue;
        const seamNormal = unit(sub3(pB.centerMm, pA.centerMm));
        const seamCoord = 0.5 * (
          dot(pA.centerMm, seamNormal) + pA.dimsMm[1] * 0.5 +
          dot(pB.centerMm, seamNormal) - pB.dimsMm[1] * 0.5
        );
        const midAB: Vec3 = [
          0.5 * (pA.centerMm[0] + pB.centerMm[0]),
          0.5 * (pA.centerMm[1] + pB.centerMm[1]),
          0.5 * (pA.centerMm[2] + pB.centerMm[2]),
        ];
        const seamCenter = add3(
          midAB,
          scale3(seamNormal, seamCoord - dot(midAB, seamNormal)),
        );
        const grainAxis = pA.axes[0];
        const plankLen = Math.min(pA.dimsMm[0], pB.dimsMm[0]);
        const dowelDia = Math.min(8, Math.max(6, Math.round(pA.dimsMm[2] * 0.35)));
        const dowelLen = 30;
        const holeR = (dowelDia + options.clearanceMm) * 0.5;
        const holeDepth = dowelLen * 0.5 + 1;
        const offsets = [-plankLen * 0.3, 0, plankLen * 0.3];
        const centers = offsets.map((off) => add3(seamCenter, scale3(grainAxis, off)));
        const { u, v } = planeBasis(seamNormal);

        for (const c of centers) {
          const bA = orientedCylinderManifold(wasm, c, u, v, seamNormal, holeDepth * 2, holeR, 20);
          const nextA = solids[pA.index].subtract(bA);
          const nextB = solids[pB.index].subtract(bA);
          bA.delete();
          solids[pA.index].delete();
          solids[pB.index].delete();
          solids[pA.index] = nextA;
          solids[pB.index] = nextB;
        }

        joints.push({
          id: `J${jointCounter++}`,
          kind: 'plank_dowel',
          memberAIndex: pA.index,
          memberBIndex: pB.index,
          memberAId: pA.id,
          memberBId: pB.id,
          centerMm: seamCenter,
          normalAToB: seamNormal,
          dowelCentersMm: centers,
          dowelDiaMm: dowelDia,
          dowelLengthMm: dowelLen,
          notes: [
            `3× Ø${dowelDia}×${dowelLen} mm alignment dowels along edge-glue seam between ${pA.id} and ${pB.id}.`,
          ],
        });
      }
    }

    // -------------------------------------------------------------------------
    // 5. Tabletop Z-Clip Expansion Slots on Inside of Apron Rails
    //    (Only for leg-and-apron tabletop frames, never enclosed chests/cases.)
    // -------------------------------------------------------------------------
    const legCount = members.filter((m) => m.role === 'leg').length;
    const vertPanelCount = members.filter(
      (m) => m.role === 'panel' && Math.abs(m.axes[2][2]) < 0.5,
    ).length;
    const isEnclosedCase = vertPanelCount >= 3 || (vertPanelCount >= 2 && legCount < 2);
    const minAllZ = Math.min(...members.map((m) => m.bboxMm.min[2]));
    const maxAllZ = Math.max(...members.map((m) => m.bboxMm.max[2]));
    const totalH = Math.max(1, maxAllZ - minAllZ);
    const hasTopPanel = members.some(
      (m) =>
        m.role === 'panel' &&
        Math.abs(m.axes[2][2]) >= 0.7 &&
        (m.centerMm[2] - minAllZ) / totalH >= 0.6,
    );
    if (
      options.tabletopClips &&
      !isEnclosedCase &&
      legCount >= 1 &&
      hasTopPanel &&
      options.jointMode !== 'dowel' &&
      options.jointMode !== 'butt'
    ) {
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (m.role !== 'rail' || !m.id.startsWith('Apron_') || Math.abs(m.axes[0][2]) >= 0.15) continue;
        // Inside face is opposite to Face 1 (Outer Show Face)
        const inwardToTable = m.face1.normal; // plunging from inner face toward outer face
        const innerFaceNormal = neg3(m.face1.normal);
        const topDir: Vec3 = [0, 0, 1];
        const slotWidthMm = +Math.max(4, options.cutterDiaMm).toFixed(2);
        const distFromTopEdgeMm = Math.max(10, Math.ceil(slotWidthMm * 0.5 + 7));
        const slotDepthMm = Math.min(8, m.dimsMm[2] * 0.45);
        const effSpanMm = Math.max(30, m.dimsMm[0] - lengthTrimMm[i][0] - lengthTrimMm[i][1]);
        const slotLengthMm = Math.min(50, Math.max(28, effSpanMm * 0.25));
        const shoulderMidMm = add3(
          m.centerMm,
          scale3(m.axes[0], 0.5 * (lengthTrimMm[i][0] - lengthTrimMm[i][1])),
        );

        const slotCenter = add3(
          shoulderMidMm,
          add3(
            scale3(innerFaceNormal, m.dimsMm[2] * 0.5 - slotDepthMm * 0.5),
            scale3(topDir, m.dimsMm[1] * 0.5 - distFromTopEdgeMm),
          ),
        );
        const slotCutter = orientedBoxManifold(
          wasm,
          slotCenter,
          m.axes[0],
          topDir,
          inwardToTable,
          [slotLengthMm, slotWidthMm, slotDepthMm + 1],
        );
        const nextSolid = solids[i].subtract(slotCutter);
        slotCutter.delete();
        solids[i].delete();
        solids[i] = nextSolid;

        zClipsByMember[i].push({
          id: `ZClip_${m.id}`,
          hostMemberId: m.id,
          hostMemberIndex: i,
          centerMm: slotCenter,
          inwardNormal: inwardToTable,
          lengthAxis: m.axes[0],
          slotLengthMm: +slotLengthMm.toFixed(1),
          slotWidthMm,
          slotDepthMm: +slotDepthMm.toFixed(1),
          distFromTopEdgeMm,
        });
      }
    }

    // -------------------------------------------------------------------------
    // 6. Apply Stopped Edge Roundovers & Chamfers (Phase 2.5)
    // -------------------------------------------------------------------------
    const stoppedZonesByMember: StoppedEdgeZone[][] = members.map(() => []);
    for (let i = 0; i < members.length; i++) {
      const res = applyStoppedEdgeProfiles(
        wasm,
        solids[i],
        members[i],
        members,
        mortisesByMember[i],
        tenonsByMember[i],
        options.edgeProfile,
        options.edgeRadiusMm,
        options.stopMarginMm,
      );
      solids[i] = res.manifold;
      stoppedZonesByMember[i] = res.zones;
    }

    // -------------------------------------------------------------------------
    // 7. Package MemberJoineryParts & SplitSections for Preview / Scene Apply
    // -------------------------------------------------------------------------
    const parts: MemberJoineryPart[] = [];
    const sections: SplitSection[] = [];

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const finalMesh = manifoldToMeshMm(solids[i]);
      const plainMesh = manifoldToMeshMm(plainSolids[i]);
      const positionsM = new Float32Array(finalMesh.positionsMm.length);
      for (let k = 0; k < finalMesh.positionsMm.length; k++) {
        positionsM[k] = finalMesh.positionsMm[k] / MM;
      }
      const plainPositionsM = new Float32Array(plainMesh.positionsMm.length);
      for (let k = 0; k < plainMesh.positionsMm.length; k++) {
        plainPositionsM[k] = plainMesh.positionsMm[k] / MM;
      }

      // Compute explode vector:
      //   - Tabletop / panels lift upward (+Z)
      //   - Legs push outward radially from assembly center
      //   - Rails push outward along their face normal
      let explodeVec: Vec3 = explodeByMember[i];
      if (m.role === 'panel') {
        if (Math.abs(m.axes[2][2]) < 0.5) {
          explodeVec = m.face1.normal;
        } else {
          const pIdx = m.plankInfo ? m.plankInfo.index - 0.5 * (m.plankInfo.total + 1) : 0;
          explodeVec = [pIdx * 0.25, 0, 1.2];
        }
      } else if (m.role === 'leg') {
        explodeVec = unit([
          m.face1.normal[0] + m.face2.normal[0],
          m.face1.normal[1] + m.face2.normal[1],
          0,
        ]);
      } else if (Math.hypot(explodeVec[0], explodeVec[1], explodeVec[2]) < 1e-3) {
        explodeVec = m.face1.normal;
      } else {
        explodeVec = unit(explodeVec);
      }

      const tenons = tenonsByMember[i];
      const startTenon = tenons.find((t) => t.railEnd === 'start');
      const endTenon = tenons.find((t) => t.railEnd === 'end');
      const extraTenonLen =
        endAllowanceAlongAxisMm(m, startTenon) + endAllowanceAlongAxisMm(m, endTenon);
      const shoulderToShoulderMm = +Math.max(1, m.dimsMm[0] - lengthTrimMm[i][0] - lengthTrimMm[i][1]).toFixed(2);
      const totalFinishedLengthMm = +Math.max(1, shoulderToShoulderMm + extraTenonLen).toFixed(2);

      const hull = plainSolids[i].hull();
      const solidity = Math.min(1, plainMesh.volumeMm3 / Math.max(1e-6, hull.volume()));
      hull.delete();

      const section: SplitSection = {
        positions: positionsM,
        faces: finalMesh.faces,
        plainPositions: plainPositionsM,
        plainFaces: plainMesh.faces,
        up: m.face1.normal,
        spin: 0,
        supportMm2: 0,
        sizeMm: [totalFinishedLengthMm, m.dimsMm[1], m.dimsMm[2]],
        fits: true,
        volumeMm3: finalMesh.volumeMm3,
        features: featuresByMember[i],
        colliders: collidersByMember[i],
        solidity,
        convexPieces: [{ positions: plainPositionsM, faces: plainMesh.faces }],
        explode: explodeVec,
      };

      sections.push(section);
      parts.push({
        member: m,
        shoulderToShoulderMm,
        totalFinishedLengthMm,
        crossSectionMm: [m.dimsMm[1], m.dimsMm[2]],
        mortises: mortisesByMember[i],
        tenons,
        zClipSlots: zClipsByMember[i],
        stoppedEdgeZones: stoppedZonesByMember[i],
        section,
      });
    }

    return {
      ok: true,
      options,
      parts,
      joints,
      sections,
      warnings,
    };
  } finally {
    for (const s of solids) s.delete();
    for (const s of plainSolids) s.delete();
  }
}
