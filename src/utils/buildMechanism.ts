// ---------------------------------------------------------------------------
// physics_build_mechanism: one family of mechanismParts, built into a scene.
//
// The bridge used to call each builder with nothing but its own spec, so
// every gear pair landed on the default spot and pairs stacked on each other,
// nothing could be told where to go or how hard to drive, and there was no
// way to put two gears on one arbor. Here every family takes the same
// options, applied to whatever the family built:
//
// - origin [x, y, z] (m): where it is built (the driver's hinge, the screw's
//   middle, the four-bar's ground pivot: what each builder's `origin` is).
// - idPrefix: ids made from it instead of random ones, so a mechanism can be
//   built again in place and its parts named in later calls.
// - actuate (default true), speed (rad/s, or m/s on a slide), torqueLimitNm
//   (N·m, or N): the drive's motor.
// - arborId (+ axialOffsetMm): put the gear (family 'gear') or the pair's
//   driver (family 'gear_pair') onto an existing hinged body, which then
//   carries both gears on its one hinge: a compound arbor. A pair's driven
//   gear is placed beside it in the arbor's frame and coupled to the arbor.
//
// Pure: takes the scene's top-level nodes and hands back the next ones.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode } from '../types/scene';
import {
  buildCamMechanism,
  buildFourBarLinkage,
  buildGt2BeltDrive,
  buildInvoluteGearNode,
  buildLeadscrewDrive,
  buildMeshingGearPair,
  buildRackAndPinionPair,
  fourBarMetrics,
  type CamSpec,
  type FourBarSpec,
  type GearBoreKind,
  type Gt2BeltDriveSpec,
  type InvoluteGearSpec,
  type InvoluteRackSpec,
  type LeadscrewDriveSpec,
} from './mechanismParts';
import { nodeLocalQuat, quatMultiply, quatRotateVec, type QuatWXYZ } from './sceneTree';
import { adjustedFields, type MechanismAdjustment } from './mechanismAdjustments';
import {
  buildCantileverPawl,
  buildCompliantGripper,
  buildMonolithicPrintNodes,
  buildParallelFlexureStage,
  type CantileverPawlBuildInput,
  type CompliantGripperInput,
  type ParallelFlexureStageBuildInput,
} from './flexure';

export const MECHANISM_FAMILIES = [
  'gear',
  'gear_pair',
  'rack_pinion',
  'gt2_belt',
  'leadscrew',
  'cam_follower',
  'four_bar',
  'compliant_gripper',
  'parallel_flexure',
  'cantilever_pawl',
] as const;
export type MechanismFamilyName = (typeof MECHANISM_FAMILIES)[number];

export const COMPLIANT_MECHANISM_FAMILIES = ['compliant_gripper', 'parallel_flexure', 'cantilever_pawl'] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type MechanismRequest = Record<string, any> & {
  family?: string;
  origin?: number[];
  axis?: [number, number, number];
  idPrefix?: string;
  actuate?: boolean;
  speed?: number;
  torqueLimitNm?: number;
  arborId?: string;
  axialOffsetMm?: number;
};

export interface MechanismBuild {
  family: MechanismFamilyName;
  /** The scene's top-level nodes after the build. */
  nodes: SceneNode[];
  /** Every body the build added, children included. */
  addedIds: string[];
  /** A body the build put a gear onto, if any. */
  arborId?: string;
  metrics: Record<string, unknown>;
  /** Every requested figure the builder changed; see utils/mechanismAdjustments.ts. */
  adjusted: MechanismAdjustment[];
}

/** The figures of a gear a request can name, as the builder made it. */
const gearUsed = (m: { teeth: number; moduleMm: number; pressureAngleDeg: number; backlashMm: number; thicknessMm?: number }) => ({
  teeth: m.teeth, moduleMm: m.moduleMm, pressureAngleDeg: m.pressureAngleDeg, backlashMm: m.backlashMm, thicknessMm: m.thicknessMm,
});

/** A gear given as its own spec object, or as the request's flat fields. */
const gearAdjusted = (req: MechanismRequest, key: string, flatTeeth: string, m: Parameters<typeof gearUsed>[0]) =>
  req[key] && typeof req[key] === 'object'
    ? adjustedFields(req[key], gearUsed(m), `${key}.`)
    : adjustedFields(req, {
        [flatTeeth]: m.teeth,
        moduleMm: m.moduleMm,
        pressureAngleDeg: m.pressureAngleDeg,
        backlashMm: m.backlashMm,
        thicknessMm: m.thicknessMm,
      });

/** Deduplicates adjustment records by field name, keeping the first occurrence. */
function dedupeAdjustments(list: MechanismAdjustment[]): MechanismAdjustment[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    if (seen.has(a.field)) return false;
    seen.add(a.field);
    return true;
  });
}

/** Shortest-arc quaternion rotating +Z ([0,0,1]) to normalized `axis`, or null if zero-length. */
function axisRotationQuat(axis: [number, number, number]): QuatWXYZ | null {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len < 1e-9) return null;
  const nx = axis[0] / len;
  const ny = axis[1] / len;
  const nz = axis[2] / len;
  if (nz > 1 - 1e-9) return [1, 0, 0, 0];
  if (nz < -1 + 1e-9) return [0, 1, 0, 0];
  const w = 1 + nz;
  const x = -ny;
  const y = nx;
  const qLen = Math.hypot(w, x, y);
  return [+(w / qLen).toFixed(7), +(x / qLen).toFixed(7), +(y / qLen).toFixed(7), 0];
}

/** Rotates a mechanism's root bodies (and any world-space connect anchors) around `pivot` by `q`. */
function applyAxisRotation(nodes: SceneNode[], q: QuatWXYZ, pivot: [number, number, number]) {
  if (q[0] === 1 && q[1] === 0 && q[2] === 0 && q[3] === 0) return;
  const rotatePoint = (p: readonly number[]): [number, number, number] => {
    const r = quatRotateVec(q, [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]]);
    return [+(pivot[0] + r[0]).toFixed(7), +(pivot[1] + r[1]).toFixed(7), +(pivot[2] + r[2]).toFixed(7)];
  };
  for (const n of nodes) {
    n.pos = rotatePoint(n.pos ?? [0, 0, 0]);
    const nextQ = quatMultiply(q, nodeLocalQuat(n));
    n.quat = nextQ.map((v) => +v.toFixed(7)) as QuatWXYZ;
    delete n.euler;
  }
  walk(nodes, (n) => {
    if (n.connectAnchor && n.connectAnchor.length >= 3) {
      n.connectAnchor = rotatePoint(n.connectAnchor);
    }
  });
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const vec3 = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === 'number') ? [v[0], v[1], v[2]] : undefined;

const walk = (nodes: SceneNode[], fn: (n: SceneNode) => void) => {
  for (const n of nodes) { fn(n); walk(n.children || [], fn); }
};

/** The scene's world pose of a body, from the document's tree. */
function worldPose(nodes: SceneNode[], id: string, pos: number[] = [0, 0, 0], quat: QuatWXYZ = [1, 0, 0, 0]): { pos: [number, number, number]; quat: QuatWXYZ } | null {
  for (const n of nodes) {
    const p = quatRotateVec(quat, n.pos ?? [0, 0, 0]);
    const at: [number, number, number] = [pos[0] + p[0], pos[1] + p[1], pos[2] + p[2]];
    const q = quatMultiply(quat, nodeLocalQuat(n));
    if (n.id === id) return { pos: at, quat: q };
    const found = worldPose(n.children || [], id, at, q);
    if (found) return found;
  }
  return null;
}

/** The nodes with the body `id` replaced by `fn(copy of it)`, copying only the path to it. */
function withNode(nodes: SceneNode[], id: string, fn: (n: SceneNode) => SceneNode): SceneNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn({ ...n });
    const children = n.children?.length ? withNode(n.children, id, fn) : n.children;
    return children === n.children ? n : { ...n, children };
  });
}

const contains = (nodes: SceneNode[], id: string): boolean => {
  let found = false;
  walk(nodes, (n) => { if (n.id === id) found = true; });
  return found;
};

/** A gear's geoms moved onto an arbor, `offset` along the arbor's own +Z. */
function gearGeomsOnArbor(gear: SceneNode, offset: number): SceneGeom[] {
  return gear.geoms.map((g) => ({ ...g, pos: [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, +((g.pos?.[2] ?? 0) + offset).toFixed(7)] }));
}

/** The words the builders make ids of, which are never the random part. */
const ID_WORDS = new Set(['gear', 'pinion', 'rack', 'gt2', 'pulley', 'belt', 'leadscrew', 'nut', 'mount', 'cam', 'follower', 'fourbar', 'ground', 'crank', 'coupler', 'rocker', 'driver', 'driven']);

/** Replaces the random part of every id (and the names made from them) with `prefix`, keeping them unique. */
function applyIdPrefix(nodes: SceneNode[], prefix: string) {
  const tokens = new Map<string, string>();
  const used = new Set<string>();
  walk(nodes, (n) => {
    // makeId's random part: the 7-character segment that is not a word of the id.
    const parts = n.id.split('_');
    const at = parts.findIndex((p) => p.length === 7 && /^[a-z0-9]+$/.test(p) && !ID_WORDS.has(p));
    if (at < 1 || tokens.has(parts[at])) return;
    const head = parts.slice(0, at).join('_');
    let to = prefix;
    let k = 2;
    while (used.has(`${head}_${to}`)) to = `${prefix}_${k++}`;
    used.add(`${head}_${to}`);
    tokens.set(parts[at], to);
  });
  const swap = (s: string | undefined) => {
    if (!s) return s;
    let out = s;
    for (const [token, to] of tokens) out = out.split(token).join(to);
    return out;
  };
  walk(nodes, (n) => {
    n.id = swap(n.id)!;
    if (n.coupleTargetId) n.coupleTargetId = swap(n.coupleTargetId);
    if (n.connectTargetId) n.connectTargetId = swap(n.connectTargetId);
    if (n.weldTargetId) n.weldTargetId = swap(n.weldTargetId);
    n.joints = (n.joints || []).map((j) => ({ ...j, name: swap(j.name)! }));
    n.geoms = (n.geoms || []).map((g) => ({ ...g, name: swap(g.name)! }));
  });
}

/** The drive's motor as asked: none, or at this speed and torque. */
function applyActuation(nodes: SceneNode[], req: MechanismRequest) {
  const speed = num(req.speed);
  const torque = num(req.torqueLimitNm);
  walk(nodes, (n) => {
    n.joints = (n.joints || []).map((j) => {
      if (!j.actuator) return j;
      if (req.actuate === false) { const { actuator: _a, ...rest } = j; return rest; }
      return {
        ...j,
        actuator: {
          ...j.actuator,
          ...(speed !== undefined ? { ctrlValue: speed } : {}),
          ...(torque !== undefined ? { forceLimit: torque } : {}),
        },
      };
    });
  });
}

export function buildMechanism(req: MechanismRequest, scene: SceneNode[]): MechanismBuild | { error: string } {
  const family = (typeof req.family === 'string' ? req.family : 'gear_pair') as MechanismFamilyName;
  if (!MECHANISM_FAMILIES.includes(family)) return { error: `Unknown mechanism family '${family}'. One of: ${MECHANISM_FAMILIES.join(', ')}.` };
  const origin = vec3(req.origin);
  const axisVec = vec3(req.axis);
  const axisQuat = axisVec ? axisRotationQuat(axisVec) : null;
  if (axisVec && !axisQuat) return { error: 'axis must be a non-zero 3D vector.' };
  const actuate = req.actuate !== false;
  const idPrefix = typeof req.idPrefix === 'string' && req.idPrefix
    ? req.idPrefix.replace(/[^A-Za-z0-9_-]/g, '_')
    : undefined;
  const isCompliant = (COMPLIANT_MECHANISM_FAMILIES as readonly string[]).includes(family);
  const arborId = typeof req.arborId === 'string' ? req.arborId : undefined;
  const offset = (num(req.axialOffsetMm) ?? 0) / 1000;
  const arbor = arborId ? worldPose(scene, arborId) : null;
  if (arborId && !arbor) return { error: `No body '${arborId}' to build onto.` };
  if (arborId && family !== 'gear' && family !== 'gear_pair') return { error: `arborId takes a gear or a gear pair's driver; '${family}' builds its own bodies.` };

  let created: SceneNode[] = [];
  let metrics: Record<string, unknown> = {};
  let onArbor: SceneNode | null = null;
  let adjusted: MechanismAdjustment[] = [];

  const gearSpec = (v: unknown, fallback: InvoluteGearSpec): InvoluteGearSpec => (v && typeof v === 'object' ? v as InvoluteGearSpec : fallback);
  const flatGearFields = (): Partial<InvoluteGearSpec> => ({
    ...(num(req.backlashMm) !== undefined ? { backlashMm: num(req.backlashMm) } : {}),
    ...(num(req.thicknessMm) !== undefined ? { thicknessMm: num(req.thicknessMm) } : {}),
    ...(num(req.pressureAngleDeg) !== undefined ? { pressureAngleDeg: num(req.pressureAngleDeg) } : {}),
    ...(typeof req.boreKind === 'string' ? { boreKind: req.boreKind as GearBoreKind } : {}),
    ...(num(req.boreDiameterMm) !== undefined ? { boreDiameterMm: num(req.boreDiameterMm) } : {}),
  });
  const flatRackFields = (): Partial<InvoluteRackSpec> => ({
    ...(num(req.backlashMm) !== undefined ? { backlashMm: num(req.backlashMm) } : {}),
    ...(num(req.thicknessMm) !== undefined ? { thicknessMm: num(req.thicknessMm) } : {}),
    ...(num(req.pressureAngleDeg) !== undefined ? { pressureAngleDeg: num(req.pressureAngleDeg) } : {}),
    ...(num(req.baseHeightMm) !== undefined ? { baseHeightMm: num(req.baseHeightMm) } : {}),
  });

  switch (family) {
    case 'gear': {
      const node = buildInvoluteGearNode(req as InvoluteGearSpec, {
        ...(origin ? { pos: origin } : {}),
        actuated: actuate && !arborId,
      });
      if (arborId) onArbor = node;
      else created = [node];
      metrics = { pitchDiameterMm: node.toothForm && 'pitchDiameterMm' in node.toothForm ? node.toothForm.pitchDiameterMm : undefined };
      if (node.toothForm?.kind === 'involute') adjusted = adjustedFields(req, gearUsed(node.toothForm));
      break;
    }
    case 'gear_pair': {
      const sharedFlat = flatGearFields();
      const driver = gearSpec(req.driver, { ...sharedFlat, moduleMm: num(req.moduleMm) ?? 1.5, teeth: num(req.driverTeeth) ?? 16 });
      const driven = gearSpec(req.driven, { ...sharedFlat, moduleMm: driver.moduleMm, teeth: num(req.drivenTeeth) ?? 32 });
      const pair = buildMeshingGearPair(driver, driven, {
        ...(origin ? { origin } : {}),
        ...(num(req.meshAngleDeg) !== undefined ? { meshAngleDeg: num(req.meshAngleDeg) } : {}),
        actuateDriver: actuate && !arborId,
      });
      metrics = { centerDistanceMm: pair.centerDistanceMm, ratio: pair.gearRatio, coupleRatio: pair.coupleRatio, contactRatio: pair.contactRatio };
      adjusted = dedupeAdjustments([
        ...gearAdjusted(req, 'driver', 'driverTeeth', pair.driverMetrics),
        ...gearAdjusted(req, 'driven', 'drivenTeeth', pair.drivenMetrics),
      ]);
      if (arborId && arbor) {
        // The driven gear beside the arbor, in the arbor's frame and plane.
        const rel = [0, 1, 2].map((k) => pair.drivenNode.pos[k] - pair.driverNode.pos[k]);
        const shifted = quatRotateVec(arbor.quat, [rel[0], rel[1], rel[2] + offset]);
        pair.drivenNode.pos = arbor.pos.map((v, k) => +(v + shifted[k]).toFixed(7)) as [number, number, number];
        pair.drivenNode.quat = [...arbor.quat];
        delete pair.drivenNode.euler;
        pair.drivenNode.coupleTargetId = arborId;
        onArbor = pair.driverNode;
        created = [pair.drivenNode];
      } else {
        created = pair.nodes;
      }
      break;
    }
    case 'rack_pinion': {
      const pinion = gearSpec(req.pinion, { ...flatGearFields(), moduleMm: num(req.moduleMm) ?? 1.5, teeth: num(req.pinionTeeth) ?? 16 });
      const rack: InvoluteRackSpec = req.rack && typeof req.rack === 'object'
        ? req.rack
        : { ...flatRackFields(), moduleMm: pinion.moduleMm, teeth: num(req.rackTeeth) ?? 20 };
      const rp = buildRackAndPinionPair(pinion, rack, { ...(origin ? { origin } : {}), actuatePinion: actuate });
      created = rp.nodes;
      metrics = { coupleRatio: rp.coupleRatio, pitchRadiusMm: rp.pitchRadiusMm };
      const rackAdj = req.rack && typeof req.rack === 'object'
        ? adjustedFields(req.rack, {
            teeth: rp.rackMetrics.teeth,
            moduleMm: rp.rackMetrics.moduleMm,
            pressureAngleDeg: rp.rackMetrics.pressureAngleDeg,
            backlashMm: rp.rackMetrics.backlashMm,
            thicknessMm: rp.rackMetrics.thicknessMm,
            baseHeightMm: rp.rackMetrics.baseHeightMm,
          }, 'rack.')
        : adjustedFields(req, {
            rackTeeth: rp.rackMetrics.teeth,
            baseHeightMm: rp.rackMetrics.baseHeightMm,
            backlashMm: rp.rackMetrics.backlashMm,
            thicknessMm: rp.rackMetrics.thicknessMm,
            pressureAngleDeg: rp.rackMetrics.pressureAngleDeg,
          });
      adjusted = dedupeAdjustments([...gearAdjusted(req, 'pinion', 'pinionTeeth', rp.pinionMetrics), ...rackAdj]);
      break;
    }
    case 'gt2_belt': {
      const belt = buildGt2BeltDrive({ ...(req as Gt2BeltDriveSpec), ...(origin ? { origin } : {}), actuateDriver: actuate });
      created = belt.nodes;
      metrics = {
        centerDistanceMm: belt.centerDistanceMm,
        reductionRatio: belt.reductionRatio,
        beltLengthMm: belt.beltLengthMm,
        beltTeeth: belt.beltTeethRounded,
        coupleRatio: belt.coupleRatio,
      };
      adjusted = adjustedFields(req, {
        driverTeeth: belt.driverMetrics.teeth,
        drivenTeeth: belt.drivenMetrics.teeth,
        beltWidthMm: belt.driverMetrics.beltWidthMm,
        centerDistanceMm: belt.centerDistanceMm,
      });
      break;
    }
    case 'leadscrew': {
      const ls = buildLeadscrewDrive({ ...(req as LeadscrewDriveSpec), ...(origin ? { origin } : {}), actuateScrew: actuate });
      created = ls.nodes;
      metrics = { coupleRatio: ls.coupleRatio, travelRangeMm: ls.travelRangeMm, screwId: ls.leadscrewNode.id, nutId: ls.nutNode.id };
      adjusted = adjustedFields(req, { lengthMm: ls.lengthMm, leadMm: ls.leadMm, pitchMm: ls.pitchMm, diameterMm: ls.diameterMm });
      break;
    }
    case 'cam_follower': {
      const cam = buildCamMechanism({ ...(req as CamSpec), ...(origin ? { origin } : {}), actuateCam: actuate });
      created = cam.nodes;
      metrics = { maxRadiusMm: cam.profile.maxRadiusMm, minRadiusMm: cam.profile.minRadiusMm, followerPreloadN: cam.followerPreloadN };
      adjusted = adjustedFields(req, {
        baseRadiusMm: cam.profile.baseRadiusMm,
        liftMm: cam.profile.liftMm,
        thicknessMm: cam.profile.thicknessMm,
        samples: cam.profile.outline.length,
      });
      break;
    }
    case 'four_bar': {
      const preMetrics = fourBarMetrics(req as FourBarSpec);
      if (!preMetrics.validAssembly) {
        return {
          error: `Invalid 4-bar linkage: links (ground=${preMetrics.groundMm} mm, crank=${preMetrics.crankMm} mm, coupler=${preMetrics.couplerMm} mm, rocker=${preMetrics.rockerMm} mm) cannot assemble (longest link ${preMetrics.longestMm} mm must be shorter than the sum of the other three).`,
        };
      }
      const fb = buildFourBarLinkage(req as FourBarSpec, { ...(origin ? { origin } : {}), actuateCrank: actuate });
      created = fb.nodes;
      metrics = { ...fb.metrics };
      adjusted = adjustedFields(req, {
        groundMm: fb.metrics.groundMm,
        crankMm: fb.metrics.crankMm,
        couplerMm: fb.metrics.couplerMm,
        rockerMm: fb.metrics.rockerMm,
        linkWidthMm: fb.linkWidthMm,
        thicknessMm: fb.thicknessMm,
        pinDiameterMm: fb.pinDiameterMm,
      });
      break;
    }
    case 'compliant_gripper': {
      const gripperInput: CompliantGripperInput = {
        ...(typeof req.filament === 'string' ? { filament: req.filament } : {}),
        ...(num(req.jawOpeningMm) !== undefined ? { jawOpeningMm: num(req.jawOpeningMm) } : {}),
        ...(num(req.jawLengthMm) !== undefined ? { jawLengthMm: num(req.jawLengthMm) } : {}),
        ...(num(req.jawThicknessMm) !== undefined ? { jawThicknessMm: num(req.jawThicknessMm) } : {}),
        ...((num(req.beamThicknessMm) ?? num(req.thicknessMm)) !== undefined
          ? { beamThicknessMm: num(req.beamThicknessMm) ?? num(req.thicknessMm) }
          : {}),
        ...((num(req.beamLengthMm) ?? num(req.lengthMm)) !== undefined
          ? { beamLengthMm: num(req.beamLengthMm) ?? num(req.lengthMm) }
          : {}),
        ...((num(req.beamWidthMm) ?? num(req.widthMm)) !== undefined
          ? { beamWidthMm: num(req.beamWidthMm) ?? num(req.widthMm) }
          : {}),
        ...(num(req.beamsPerJaw) !== undefined ? { beamsPerJaw: num(req.beamsPerJaw) } : {}),
        ...(num(req.beamSpacingMm) !== undefined ? { beamSpacingMm: num(req.beamSpacingMm) } : {}),
        ...(num(req.strokeMm) !== undefined ? { strokeMm: num(req.strokeMm) } : {}),
        ...(origin ? { origin } : {}),
        ...(idPrefix ? { idPrefix } : {}),
      };
      const gripper = buildCompliantGripper(gripperInput);
      created = req.monolithicPrint === true ? buildMonolithicPrintNodes(gripper.nodes) : gripper.nodes;
      metrics = {
        evaluation: gripper.evaluation,
        totalFlexureCount: gripper.totalFlexureCount,
        pinchForceAtStrokeN: gripper.pinchForceAtStrokeN,
        parasiticShiftMm: gripper.parasiticShiftMm,
        warnings: gripper.warnings,
      };
      break;
    }
    case 'parallel_flexure': {
      const stageInput: ParallelFlexureStageBuildInput = {
        ...(typeof req.filament === 'string' ? { filament: req.filament } : {}),
        ...(num(req.thicknessMm) !== undefined ? { thicknessMm: num(req.thicknessMm) } : {}),
        ...(num(req.lengthMm) !== undefined ? { lengthMm: num(req.lengthMm) } : {}),
        ...(num(req.widthMm) !== undefined ? { widthMm: num(req.widthMm) } : {}),
        ...(num(req.numBeams) !== undefined ? { numBeams: num(req.numBeams) } : {}),
        ...(num(req.beamSpacingMm) !== undefined ? { beamSpacingMm: num(req.beamSpacingMm) } : {}),
        ...(num(req.deflectionMm) !== undefined ? { deflectionMm: num(req.deflectionMm) } : {}),
        ...(num(req.stageDepthMm) !== undefined ? { stageDepthMm: num(req.stageDepthMm) } : {}),
        ...(origin ? { origin } : {}),
        ...(idPrefix ? { idPrefix } : {}),
      };
      const stage = buildParallelFlexureStage(stageInput);
      created = req.monolithicPrint === true ? buildMonolithicPrintNodes(stage.nodes) : stage.nodes;
      metrics = {
        evaluation: stage.evaluation,
        totalFlexureCount: stage.evaluation.numBeams,
        parasiticShiftMm: stage.evaluation.parasiticShiftMm,
        restoringForceN: stage.evaluation.restoringForceN,
        warnings: stage.evaluation.warnings,
      };
      break;
    }
    case 'cantilever_pawl': {
      const pawlInput: CantileverPawlBuildInput = {
        ...(typeof req.filament === 'string' ? { filament: req.filament } : {}),
        ...(num(req.thicknessMm) !== undefined ? { thicknessMm: num(req.thicknessMm) } : {}),
        ...(num(req.lengthMm) !== undefined ? { lengthMm: num(req.lengthMm) } : {}),
        ...(num(req.widthMm) !== undefined ? { widthMm: num(req.widthMm) } : {}),
        ...(num(req.deflectionMm) !== undefined ? { deflectionMm: num(req.deflectionMm) } : {}),
        ...(num(req.rampAngleDeg) !== undefined ? { rampAngleDeg: num(req.rampAngleDeg) } : {}),
        ...(num(req.frictionCoeff) !== undefined ? { frictionCoeff: num(req.frictionCoeff) } : {}),
        ...(num(req.catchHeightMm) !== undefined ? { catchHeightMm: num(req.catchHeightMm) } : {}),
        ...(origin ? { origin } : {}),
        ...(idPrefix ? { idPrefix } : {}),
      };
      const pawl = buildCantileverPawl(pawlInput);
      created = req.monolithicPrint === true ? buildMonolithicPrintNodes(pawl.nodes) : pawl.nodes;
      metrics = {
        evaluation: pawl.evaluation,
        totalFlexureCount: 1,
        tipForceN: pawl.evaluation.tipForceN,
        engageForceN: pawl.evaluation.engageForceN,
        warnings: pawl.evaluation.warnings,
      };
      break;
    }
  }

  if (idPrefix && !isCompliant) {
    applyIdPrefix(onArbor ? [onArbor, ...created] : created, idPrefix);
  }
  if (isCompliant && req.actuate === true) {
    walk(created, (n) => {
      n.joints = (n.joints || []).map((j) => (
        j.type === 'hinge' || j.type === 'slide'
          ? {
              ...j,
              actuator: {
                type: 'motor' as const,
                ctrlValue: num(req.speed) ?? 0,
                forceLimit: num(req.torqueLimitNm) ?? 10,
              },
            }
          : j
      ));
    });
  }
  applyActuation(created, req);
  if (axisQuat && !arborId && created.length > 0) {
    const pivot: [number, number, number] = origin ?? [
      created[0].pos?.[0] ?? 0,
      created[0].pos?.[1] ?? 0,
      created[0].pos?.[2] ?? 0,
    ];
    applyAxisRotation(created, axisQuat, pivot);
  }
  if ('screwId' in metrics) {
    // Ids may have been renamed above.
    const ls = created[0]?.children ?? [];
    metrics.screwId = ls[0]?.id;
    metrics.nutId = ls[1]?.id;
  }

  const createdIds = new Set(created.map((n) => n.id));
  let nodes = [...scene.filter((n) => !createdIds.has(n.id)), ...created];
  if (onArbor && arborId) {
    const gear = onArbor;
    const addedGeoms = gearGeomsOnArbor(gear, offset);
    const addedNames = new Set(addedGeoms.map((g) => g.name));
    nodes = withNode(nodes, arborId, (n) => ({
      ...n,
      geoms: [...(n.geoms || []).filter((g) => !addedNames.has(g.name)), ...addedGeoms],
      // Its gears are coupled by their round colliders' radii, not one tooth form.
      allowCoupling: n.allowCoupling ?? true,
    }));
  }
  const addedIds: string[] = [];
  walk(created, (n) => addedIds.push(n.id));
  if (arborId && !contains(nodes, arborId)) return { error: `No body '${arborId}' to build onto.` };
  return { family, nodes, addedIds, ...(arborId ? { arborId } : {}), metrics, adjusted };
}
