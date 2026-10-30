// ---------------------------------------------------------------------------
// Which joints the scene couples together, and at what ratio.
//
// Explicit couplings (coupleTargetId), meshing gears found by proximity
// (utils/gearMeshing.ts), a pinion on its rack, and pulley ropes. mjcf.ts
// emits each as a rigid fixed tendon (utils/jointCoupling.ts); this only
// decides what is coupled to what. Pure: no store, no XML beyond the legacy
// rope equalities.
// ---------------------------------------------------------------------------

import type { SceneJoint, SceneNode } from '../types/scene';
import { nodeLocalQuat, quatMultiply, quatRotateVec, type QuatWXYZ } from './sceneTree';
import { gearBody, meshingGears, type GearBody } from './gearMeshing';
import { isRackBody, meshingRacks, rackBody, type RackBody } from './rackMeshing';

/** A body's rest pose, world frame, and its first geom's size. */
export interface WorldPose { pos: [number, number, number]; quat: QuatWXYZ; size: number[] }

/** q(joint1) = ratio · q(joint2). */
export interface PlannedCoupling { name: string; joint1: string; joint2: string; ratio: number | string }

export interface CouplingPlan {
  couplings: PlannedCoupling[];
  /** `<equality>` lines that are not couplings of two joints by a tendon. */
  equalities: string[];
  /** A coupling asked for and left out, by name and why. */
  warnings: string[];
}

/** Every body's rest pose, world frame, by id. */
export function restPoses(nodes: SceneNode[]): Record<string, WorldPose> {
  const out: Record<string, WorldPose> = {};
  const walk = (list: SceneNode[], parentPos: [number, number, number], parentQuat: QuatWXYZ) => {
    for (const node of list || []) {
      const r = quatRotateVec(parentQuat, node.pos);
      const pos: [number, number, number] = [parentPos[0] + r[0], parentPos[1] + r[1], parentPos[2] + r[2]];
      const quat = quatMultiply(parentQuat, nodeLocalQuat(node));
      const mainGeom = (node.geoms || [])[0];
      out[node.id] = { pos, quat, size: mainGeom ? mainGeom.size : [0.1, 0.1, 0.1] };
      walk(node.children, pos, quat);
    }
  };
  walk(nodes, [0, 0, 0], [1, 0, 0, 0]);
  return out;
}

/**
 * The joint a coupling drives: the body's first hinge or slide. A free joint
 * is six numbers, and a coupling to it drove only the first, its X: a body
 * built with no joint (so given a free one) was flung sideways at 4.9 m/s by
 * the slide coupled to it.
 */
const couplable = (j: SceneJoint) => j.type === 'hinge' || j.type === 'slide';
export const couplingJoint = (node: SceneNode): SceneJoint | undefined => (node.joints || []).find(couplable);

const jointsSaid = (node: SceneNode) => {
  const types = [...new Set((node.joints || []).map((j) => j.type ?? 'hinge'))];
  return types.length ? `only a ${types.join(' and a ')} joint` : 'no joint';
};

/**
 * A cut gear's pitch radius in metres, from the tooth form it was cut to. Its
 * first geom is a mesh, whose size is a placeholder [1], so reading the radius
 * from that coupled every pair of generated gears within 2.4 m of each other.
 */
const pitchRadius = (node: SceneNode): number | undefined => {
  const t = node.toothForm;
  return t && t.kind !== 'rack' ? t.pitchDiameterMm / 2000 : undefined;
};

/** What a scene's couplings leave out, by body: for an MCP reply. */
export const couplingWarnings = (nodes: SceneNode[]): string[] => planCouplings(nodes, restPoses(nodes), (s) => s).warnings;

export function planCouplings(nodes: SceneNode[], world: Record<string, WorldPose>, xmlAttr: (s: string) => string): CouplingPlan {
  const couplings: PlannedCoupling[] = [];
  const equalities: string[] = [];
  const warnings: string[] = [];
  const pinions: GearBody[] = [];
  const racks: RackBody[] = [];
  const gearJointNodes: GearBody[] = [];
  const jointedNodes: Record<string, string> = {};
  const explicitCouplingNodes: SceneNode[] = [];
  const pulleyRopesList: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();

  const traverse = (list: SceneNode[]) => {
    for (const node of list || []) {
      byId.set(node.id, node);
      const cj = couplingJoint(node);
      if (cj) jointedNodes[node.id] = cj.name;
      if (node.coupleTargetId) explicitCouplingNodes.push(node);
      if (node.isPulleyRope) pulleyRopesList.push(node);
      const couplingAllowed = node.allowCoupling !== false;
      const pose = world[node.id] ?? { pos: [0, 0, 0], quat: [1, 0, 0, 0] as QuatWXYZ, size: [] };
      for (const j of node.joints || []) {
        if (couplingAllowed && j.type === 'hinge') {
          const g = gearBody(node, j, pose, pitchRadius(node));
          if (node.id.includes('gear')) gearJointNodes.push(g);
          // Any hinged wheel can drive a rack; a rack has to say it is one.
          if (!g.guessed) pinions.push(g);
        }
        if (couplingAllowed && j.type === 'slide' && isRackBody(node) && j === couplingJoint(node)) racks.push(rackBody(node, j, pose));
      }
      traverse(node.children);
    }
  };
  traverse(nodes);

  // 0. Explicit joint couplings
  let couplingIndex = 1;
  const explicitlyCoupledJointPairs = new Set<string>();
  for (const node of explicitCouplingNodes) {
    const joint1 = jointedNodes[node.id];
    const joint2 = jointedNodes[node.coupleTargetId!];
    const target = byId.get(node.coupleTargetId!);
    if (target && (!joint1 || !joint2)) {
      const lacking = joint1 ? target : node;
      warnings.push(`Body '${node.id}' is coupled to '${target.id}' (coupleTargetId), but '${lacking.id}' has ${jointsSaid(lacking)}, and a coupling ties one hinge or slide to another: it was left out. Give '${lacking.id}' a hinge or slide joint (a body built with no joints gets a free one).`);
    }
    if (joint1 && joint2) {
      const ratio = node.coupleRatio !== undefined ? node.coupleRatio : -1.0;
      explicitlyCoupledJointPairs.add([joint1, joint2].sort().join('::'));
      // Stiff, as teeth in mesh are: at the default 0.02 s a 20 g rack pushing
      // a 5 g block fell 5% behind its pinion. See utils/jointCoupling.ts.
      couplings.push({ name: `explicit_coupling_${couplingIndex++}`, joint1, joint2, ratio });
    }
  }

  // Joints already tied together by explicit couplings, directly or along a
  // chain: the proximity rules below leave those alone.
  const chainOf = new Map<string, string>();
  const root = (j: string): string => {
    let r = j;
    while (chainOf.has(r) && chainOf.get(r) !== r) r = chainOf.get(r)!;
    return r;
  };
  for (const e of couplings) chainOf.set(root(e.joint1), root(e.joint2));
  const sameChain = (a: string, b: string) => root(a) === root(b);

  // 1. Gears fallback dynamic proximity coupling: parallel axes, wheels in
  //    the same plane, centres a pitch-circle sum apart. See utils/gearMeshing.ts.
  const coupledPairs = new Set<string>();
  for (const { a, b, ratio } of meshingGears(gearJointNodes, sameChain)) {
    const pairKey = [a.jointName, b.jointName].sort().join('::');
    if (coupledPairs.has(pairKey) || explicitlyCoupledJointPairs.has(pairKey)) continue;
    coupledPairs.add(pairKey);
    couplings.push({ name: `gear_coupling_${coupledPairs.size}`, joint1: a.jointName, joint2: b.jointName, ratio: ratio.toFixed(6) });
  }

  // 2. A rack on its pinion, by where they are: see utils/rackMeshing.ts.
  let pinionRackCouplingCount = 0;
  const racked = new Set<string>();
  for (const { pinion, rack, turnsPerMetre } of meshingRacks(pinions, racks, sameChain)) {
    const pairKey = [pinion.jointName, rack.jointName].sort().join('::');
    racked.add(rack.nodeId);
    if (coupledPairs.has(pairKey) || explicitlyCoupledJointPairs.has(pairKey)) continue;
    coupledPairs.add(pairKey);
    pinionRackCouplingCount++;
    // θ = x / (r·k): the pinion's angle per metre of rack, signed by the side
    // the rack is on. It once emitted r itself, the relationship the other
    // way round, which asked a rack to travel 1/r^2 = 156x too far.
    const name = pinionRackCouplingCount === 1 ? 'pinion_rack_coupling' : `pinion_rack_coupling_${pinionRackCouplingCount}`;
    couplings.push({ name, joint1: pinion.jointName, joint2: rack.jointName, ratio: +turnsPerMetre.toPrecision(9) });
  }
  // A rack nothing drives is said by name, unless a coupling already ties it.
  const tied = new Set(couplings.flatMap((c) => [c.joint1, c.joint2]));
  for (const rack of racks) {
    if (racked.has(rack.nodeId) || tied.has(rack.jointName)) continue;
    warnings.push(`Body '${rack.nodeId}' is a rack, but no hinged wheel meshes with it, so nothing turns it: a wheel meshes when its hinge axis is square to the slide, it lies in the rack's plane over the rack's length, and the rack's face toward it is about one pitch radius (the wheel's radius) from its axis. Couple it explicitly with coupleTargetId to drive it from elsewhere.`);
  }

  // 3. Pulley Rope Joint Couplings
  let ropeCouplingIndex = 1;
  for (const rope of pulleyRopesList) {
    const { pulleyWheelId, leftTargetId, rightTargetId } = rope;
    if (leftTargetId && rightTargetId) {
      const leftJoint = jointedNodes[leftTargetId];
      const rightJoint = jointedNodes[rightTargetId];
      if (leftJoint && rightJoint) {
        // Linear coupling between weights: ratio is -1.0 (as one goes down, other goes up)
        equalities.push(`    <joint name="rope_coupling_linear_${ropeCouplingIndex}" joint1="${xmlAttr(leftJoint)}" joint2="${xmlAttr(rightJoint)}" polycoef="0 -1 0 0 0" />`);
        // Couple pulley wheel Hinge rotation with the Left weight slide joint
        const wheelJoint = pulleyWheelId ? jointedNodes[pulleyWheelId] : undefined;
        if (wheelJoint) {
          const radius = byId.get(pulleyWheelId!)?.pulleyRadius || 0.08;
          // Rope kinematics: the weight travels the arc the rim turns through,
          // x = r * theta. joint1 is the WEIGHT's slide and joint2 the wheel's
          // hinge, so the coefficient is the radius, not its reciprocal.
          equalities.push(`    <joint name="rope_coupling_angular_${ropeCouplingIndex}" joint1="${xmlAttr(leftJoint)}" joint2="${xmlAttr(wheelJoint)}" polycoef="0 ${radius} 0 0 0" />`);
        }
      }
    }
    ropeCouplingIndex++;
  }

  return { couplings, equalities, warnings };
}
