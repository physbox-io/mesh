// ---------------------------------------------------------------------------
// Which joints the scene couples together, and at what ratio.
//
// Explicit couplings (coupleTargetId), meshing gears found by proximity
// (utils/gearMeshing.ts), a pinion on its rack, and pulley ropes. mjcf.ts
// emits each as a rigid fixed tendon (utils/jointCoupling.ts); this only
// decides what is coupled to what. Pure: no store, no XML beyond the legacy
// rope equalities.
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';
import type { QuatWXYZ } from './sceneTree';
import { gearBody, meshingGears, type GearBody } from './gearMeshing';

/** A body's rest pose, world frame, and its first geom's size. */
export interface WorldPose { pos: [number, number, number]; quat: QuatWXYZ; size: number[] }

/** q(joint1) = ratio · q(joint2). */
export interface PlannedCoupling { name: string; joint1: string; joint2: string; ratio: number | string }

export interface CouplingPlan {
  couplings: PlannedCoupling[];
  /** `<equality>` lines that are not couplings of two joints by a tendon. */
  equalities: string[];
}

/**
 * A cut gear's pitch radius in metres, from the tooth form it was cut to. Its
 * first geom is a mesh, whose size is a placeholder [1], so reading the radius
 * from that coupled every pair of generated gears within 2.4 m of each other.
 */
const pitchRadius = (node: SceneNode): number | undefined => {
  const t = node.toothForm;
  return t && t.kind !== 'rack' ? t.pitchDiameterMm / 2000 : undefined;
};

export function planCouplings(nodes: SceneNode[], world: Record<string, WorldPose>, xmlAttr: (s: string) => string): CouplingPlan {
  const couplings: PlannedCoupling[] = [];
  const equalities: string[] = [];
  const pinionNodes: { jointName: string; nodeId: string; pos: [number, number, number]; radius: number }[] = [];
  const rackNodes: { jointName: string; nodeId: string; pos: [number, number, number] }[] = [];
  const gearJointNodes: GearBody[] = [];
  const jointedNodes: Record<string, string> = {};
  const explicitCouplingNodes: SceneNode[] = [];
  const pulleyRopesList: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();

  const traverse = (list: SceneNode[]) => {
    for (const node of list || []) {
      byId.set(node.id, node);
      if (node.joints && node.joints.length > 0) jointedNodes[node.id] = node.joints[0].name;
      if (node.coupleTargetId) explicitCouplingNodes.push(node);
      if (node.isPulleyRope) pulleyRopesList.push(node);
      const couplingAllowed = node.allowCoupling !== false;
      for (const j of node.joints || []) {
        if (couplingAllowed && node.id.includes('gear') && j.type === 'hinge') {
          const wData = world[node.id] ?? { pos: [0, 0, 0], quat: [1, 0, 0, 0] as QuatWXYZ, size: [] };
          gearJointNodes.push(gearBody(node, j, wData, pitchRadius(node)));
        }
        if (couplingAllowed && node.id.includes('pinion') && j.type === 'hinge') {
          const wData = world[node.id];
          pinionNodes.push({
            jointName: j.name,
            nodeId: node.id,
            pos: wData ? wData.pos : [0, 0, 0],
            radius: pitchRadius(node) ?? (wData ? wData.size[0] : 0.08),
          });
        }
        if (couplingAllowed && node.id.includes('rack') && j.type === 'slide') {
          const wData = world[node.id];
          rackNodes.push({ jointName: j.name, nodeId: node.id, pos: wData ? wData.pos : [0, 0, 0] });
        }
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

  // 2. Pinion and Rack fallback proximity coupling
  let pinionRackCouplingCount = 0;
  for (const p of pinionNodes) {
    for (const r of rackNodes) {
      const dx = p.pos[0] - r.pos[0];
      const dy = p.pos[1] - r.pos[1];
      const dz = p.pos[2] - r.pos[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Only couple if their centers are within 0.5 meters of each other
      if (dist <= 0.5) {
        const pairKey = [p.jointName, r.jointName].sort().join('::');
        if (!coupledPairs.has(pairKey) && !explicitlyCoupledJointPairs.has(pairKey) && !sameChain(p.jointName, r.jointName)) {
          coupledPairs.add(pairKey);
          pinionRackCouplingCount++;
          const pinionRadius = p.radius;
          // The coupling gives the PINION ANGLE as a function of the rack's
          // displacement: theta = x / r. It used to emit r itself, which is the
          // relationship the other way round — with r = 0.08 that asked the rack
          // to travel 1/r^2 = 156x too far, so it slammed into its own limit and
          // the whole mechanism bound up instead of driving.
          const turnsPerMetre = pinionRadius > 1e-6 ? 1 / pinionRadius : 12.5;
          const name = pinionRackCouplingCount === 1 ? 'pinion_rack_coupling' : `pinion_rack_coupling_${pinionRackCouplingCount}`;
          couplings.push({ name, joint1: p.jointName, joint2: r.jointName, ratio: turnsPerMetre });
        }
      }
    }
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

  return { couplings, equalities };
}
