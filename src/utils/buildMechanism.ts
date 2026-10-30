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
  type CamSpec,
  type FourBarSpec,
  type Gt2BeltDriveSpec,
  type InvoluteGearSpec,
  type InvoluteRackSpec,
  type LeadscrewDriveSpec,
} from './mechanismParts';
import { nodeLocalQuat, quatMultiply, quatRotateVec, type QuatWXYZ } from './sceneTree';
import { adjustedFields, type MechanismAdjustment } from './mechanismAdjustments';

export const MECHANISM_FAMILIES = ['gear', 'gear_pair', 'rack_pinion', 'gt2_belt', 'leadscrew', 'cam_follower', 'four_bar'] as const;
export type MechanismFamilyName = (typeof MECHANISM_FAMILIES)[number];

/* eslint-disable @typescript-eslint/no-explicit-any */
export type MechanismRequest = Record<string, any> & {
  family?: string;
  origin?: number[];
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
    : adjustedFields(req, { [flatTeeth]: m.teeth, moduleMm: m.moduleMm });

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
  const actuate = req.actuate !== false;
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
      const driver = gearSpec(req.driver, { moduleMm: num(req.moduleMm) ?? 1.5, teeth: num(req.driverTeeth) ?? 16 });
      const driven = gearSpec(req.driven, { moduleMm: driver.moduleMm, teeth: num(req.drivenTeeth) ?? 32 });
      const pair = buildMeshingGearPair(driver, driven, {
        ...(origin ? { origin } : {}),
        ...(num(req.meshAngleDeg) !== undefined ? { meshAngleDeg: num(req.meshAngleDeg) } : {}),
        actuateDriver: actuate && !arborId,
      });
      metrics = { centerDistanceMm: pair.centerDistanceMm, ratio: pair.gearRatio, coupleRatio: pair.coupleRatio, contactRatio: pair.contactRatio };
      adjusted = [...gearAdjusted(req, 'driver', 'driverTeeth', pair.driverMetrics), ...gearAdjusted(req, 'driven', 'drivenTeeth', pair.drivenMetrics)];
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
      const pinion = gearSpec(req.pinion, { moduleMm: num(req.moduleMm) ?? 1.5, teeth: num(req.pinionTeeth) ?? 16 });
      const rack: InvoluteRackSpec = req.rack && typeof req.rack === 'object' ? req.rack : { moduleMm: pinion.moduleMm, teeth: num(req.rackTeeth) ?? 20 };
      const rp = buildRackAndPinionPair(pinion, rack, { ...(origin ? { origin } : {}), actuatePinion: actuate });
      created = rp.nodes;
      metrics = { coupleRatio: rp.coupleRatio, pitchRadiusMm: rp.pitchRadiusMm };
      adjusted = gearAdjusted(req, 'pinion', 'pinionTeeth', rp.pinionMetrics);
      break;
    }
    case 'gt2_belt': {
      const belt = buildGt2BeltDrive({ ...(req as Gt2BeltDriveSpec), ...(origin ? { origin } : {}), actuateDriver: actuate });
      created = belt.nodes;
      metrics = { beltLengthMm: belt.beltLengthMm, beltTeeth: belt.beltTeethRounded, coupleRatio: belt.coupleRatio };
      adjusted = adjustedFields(req, { driverTeeth: belt.driverMetrics.teeth, drivenTeeth: belt.drivenMetrics.teeth, beltWidthMm: belt.driverMetrics.beltWidthMm });
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
      break;
    }
    case 'four_bar': {
      const fb = buildFourBarLinkage(req as FourBarSpec, { ...(origin ? { origin } : {}), actuateCrank: actuate });
      created = fb.nodes;
      metrics = { ...fb.metrics };
      break;
    }
  }

  if (typeof req.idPrefix === 'string' && req.idPrefix) {
    applyIdPrefix(onArbor ? [onArbor, ...created] : created, req.idPrefix.replace(/[^A-Za-z0-9_-]/g, '_'));
  }
  applyActuation(created, req);
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
    nodes = withNode(nodes, arborId, (n) => ({
      ...n,
      geoms: [...(n.geoms || []), ...gearGeomsOnArbor(gear, offset)],
      // Its gears are coupled by their round colliders' radii, not one tooth form.
      allowCoupling: n.allowCoupling ?? true,
    }));
  }
  const addedIds: string[] = [];
  walk(created, (n) => addedIds.push(n.id));
  if (arborId && !contains(nodes, arborId)) return { error: `No body '${arborId}' to build onto.` };
  return { family, nodes, addedIds, ...(arborId ? { arborId } : {}), metrics, adjusted };
}
