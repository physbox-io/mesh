import type { SceneNode, SceneJoint } from '../types/scene';
import { quatRotateVecInv, type QuatWXYZ } from './sceneTree';
import type { buildBreakModel } from './breakModel';
import { RIGID_COUPLING, jointCouplingXml } from './jointCoupling';
import { planCouplings, restPoses } from './sceneCouplings';
import { estimateJointInertia, relocateCoupledFriction, type CouplingEdge } from './coupledFriction';
import { UNSLIPPING_CLUTCH, clutchDriverJointName, clutchTendonXml, isClutchedMotor } from './motorClutch';
import { xmlAttr } from './xmlAttr';

interface Weld { bodyName: string; bodyId?: string; targetId: string; rigid?: boolean }
/*
 * Crumple zones, as locks.
 *
 * A joint with a crumple torque is welded to whatever it hangs off, so it
 * does not move at all until the lock is released — at which point it is an
 * ordinary damped hinge with a limited range. Emitting it as a weld rather
 * than as a stiff spring is what makes it PERMANENT: a spring pulls the part
 * back, and a crumpled one should stay crumpled.
 */
interface CrumpleLock { jointName: string; bodyName: string; bodyId: string; parentName: string; parentId?: string }
interface Connect { bodyId: string; bodyName: string; targetId: string; anchor: number[] }

/** What the scene asks to be held, driven or joined, gathered in one walk. */
function gather(nodes: SceneNode[]) {
  const actuators: SceneJoint[] = [];
  const welds: Weld[] = [];
  const crumpleLocks: CrumpleLock[] = [];
  const connects: Connect[] = [];
  const byId = new Map<string, SceneNode>();
  const byName = new Map<string, SceneNode>();
  const jointsByName = new Map<string, { node: SceneNode; joint: SceneJoint }>();
  const walk = (list: SceneNode[], parentName?: string, parentId?: string) => {
    if (!list) return;
    for (const node of list) {
      byId.set(node.id, node);
      byName.set(node.name, node);
      for (const j of node.joints || []) {
        jointsByName.set(j.name, { node, joint: j });
        if (j.crumpleTorqueNm !== undefined && j.type !== 'free') {
          crumpleLocks.push({ jointName: j.name, bodyName: node.name, bodyId: node.id, parentName: parentName ?? '', parentId });
        }
      }
      if (node.weldTargetId) {
        welds.push({ bodyName: node.name, bodyId: node.id, targetId: node.weldTargetId, ...(node.weldRigid ? { rigid: true } : {}) });
      }
      if (node.isComposite && node.weldLastToId) {
        welds.push({ bodyName: (node.compositePrefix || `${node.name}_`) + 'B_last', targetId: node.weldLastToId });
      }
      if (node.connectTargetId && node.connectAnchor) {
        connects.push({ bodyId: node.id, bodyName: node.name, targetId: node.connectTargetId, anchor: node.connectAnchor });
      }
      for (const j of node.joints || []) if (j.actuator) actuators.push(j);
      walk(node.children, node.name, node.id);
    }
  };
  walk(nodes);
  /**
   * The body a weld or a pin names at its other end: by id, or failing that by
   * name, which danglingReferences accepts as present too. A Map, not an
   * object: `'constructor' in {}` is true, and a body of that name came out
   * as body2="function Object() { [native code] }".
   */
  const bodyOf = (target: string): SceneNode | undefined => byId.get(target) ?? byName.get(target);
  return { actuators, welds, crumpleLocks, connects, bodyOf, jointsByName };
}

/**
 * A velocity servo far stiffer than the joint it drives (kv*dt over the
 * joint's inertia), on a body held in a closed loop by a pin or a weld, or
 * on a coupled joint, is driven through a clutch that never slips. The
 * implicit integrator treats that gain as inertia the constraint solver
 * does not know about, and the constraint tore open: a 50 g scissor-lift
 * slider held by a kv 20000 servo folded the lift flat, and a 10 g pinion
 * at kv 1 (kv*dt/I = 2000) swung the 50 g gear it drives between -773 and
 * +741 rad/s in its first 12 ms. Through the clutch the solver sees it.
 * Rewrites `actuators` and the owning nodes' joint lists in place.
 */
function clutchStiffServos(
  actuators: SceneJoint[],
  looped: Set<string>,
  coupledJoints: Set<string>,
  jointsByName: Map<string, { node: SceneNode }>,
) {
  for (let i = 0; i < actuators.length; i++) {
    const j = actuators[i];
    const owner = jointsByName.get(j.name)?.node;
    if (!owner || !(looped.has(owner.id) || coupledJoints.has(j.name)) || j.actuator?.type !== 'velocity' || j.actuator.forceLimit !== undefined) continue;
    if (j.type !== 'hinge' && j.type !== 'slide') continue;
    if ((j.actuator.kv ?? 1) * 0.001 <= estimateJointInertia(owner, j)) continue;
    const held: SceneJoint = { ...j, actuator: { ...j.actuator, forceLimit: UNSLIPPING_CLUTCH } };
    actuators[i] = held;
    owner.joints = owner.joints.map((x) => (x.name === j.name ? held : x));
  }
}

const actuatorXml = (j: SceneJoint): string => {
  const act = j.actuator!;
  const clutched = isClutchedMotor(j);
  let attrs = `name="${xmlAttr(j.name)}_actuator" joint="${xmlAttr(clutched ? clutchDriverJointName(j.name) : j.name)}"`;
  if (act.kv !== undefined && act.type === 'velocity') attrs += ` kv="${act.kv}"`;
  if (act.gear !== undefined) attrs += ` gear="${act.gear}"`;
  // A motor's ctrl is its torque. Unlimited, so a linked Volt's stall
  // torque arrives whole rather than clipped to a range nobody set.
  if (act.type === 'motor') attrs += ` ctrllimited="false"`;
  // What the motor can actually put out: a stepper's holding torque. Only
  // when set, so every actuator that had none compiles as it did.
  // A clutched motor's limit is its clutch's friction, not a clamp.
  if (act.forceLimit !== undefined && !clutched) attrs += ` forcelimited="true" forcerange="${-act.forceLimit} ${act.forceLimit}"`;
  return `    <${act.type} ${attrs} />`;
};

/**
 * Everything outside the bodies themselves: `<actuator>`, `<tendon>`,
 * `<equality>` and `<contact>`, each empty when there is nothing to say.
 *
 * Writes into the nodes' joint lists — a stiff servo gets its clutch, and dry
 * friction on a coupled joint moves to where the chain feels it — so it must
 * run on the compile's own copy, and before the bodies are emitted.
 */
export function constraintsXml(nodes: SceneNode[], breaks: ReturnType<typeof buildBreakModel>) {
  const { actuators, welds, crumpleLocks, connects, bodyOf, jointsByName } = gather(nodes);
  // Every body's rest pose, world frame.
  const poses = restPoses(nodes);
  // What is coupled to what: explicit couplings, meshing gears, racks, ropes.
  const plan = planCouplings(nodes, poses);

  const looped = new Set<string>();
  for (const c of connects) { looped.add(c.bodyId); looped.add(bodyOf(c.targetId)?.id ?? c.targetId); }
  for (const w of welds) { if (w.bodyId) looped.add(w.bodyId); looped.add(bodyOf(w.targetId)?.id ?? w.targetId); }
  clutchStiffServos(actuators, looped, new Set(plan.couplings.flatMap((c) => [c.joint1, c.joint2])), jointsByName);

  let equalities = '';
  // Fixed tendons: motor clutches, and the couplings below.
  const tendonLines: string[] = actuators.filter(isClutchedMotor).map((j) => clutchTendonXml(j, xmlAttr));
  const couplingEdges: CouplingEdge[] = [];
  for (const c of plan.couplings) {
    const xml = jointCouplingXml(c.name, c.joint1, c.joint2, c.ratio, xmlAttr);
    couplingEdges.push({ joint1: c.joint1, joint2: c.joint2, ratio: Number(c.ratio) });
    tendonLines.push(xml.tendon);
    equalities += `\n${xml.equality}`;
  }

  /** A weld's anchor at body1's origin, in body2's frame (the world's when there is no body2). */
  const weldAnchor = (bodyId: string, targetId?: string): string => {
    const part = poses[bodyId];
    const target = targetId ? poses[targetId] : { pos: [0, 0, 0], quat: [1, 0, 0, 0] as QuatWXYZ };
    if (!part || !target) return '';
    const local = quatRotateVecInv(target.quat, [
      part.pos[0] - target.pos[0],
      part.pos[1] - target.pos[1],
      part.pos[2] - target.pos[2],
    ]);
    return ` anchor="${local.map(v => v.toFixed(6)).join(' ')}"`;
  };

  // Crumple locks. Named after the joint rather than numbered, so the worker
  // can map a released lock straight back to the joint it froze. Held at the
  // locked body, for the reason given at the welds below.
  for (const lock of crumpleLocks) {
    const target = lock.parentName ? ` body2="${xmlAttr(lock.parentName)}"` : '';
    equalities += `\n    <weld name="crumple_lock_${xmlAttr(lock.jointName)}" body1="${xmlAttr(lock.bodyName)}"${target}${weldAnchor(lock.bodyId, lock.parentId)} />`;
  }

  // Closed-loop welds.
  welds.forEach((w, i) => {
    // Not a body in the scene: a body a rope generates (`<prefix>B_last`).
    const target = bodyOf(w.targetId);
    // A bolted joint: stiff, where the default weld lets a 3 kg drawer sag
    // millimetres onto what is under it. Only when asked for.
    const stiff = w.rigid ? ' solref="0.004 1" solimp="0.99 0.999 0.0002 0.5 2"' : '';
    // Held at the welded part, not at the target's origin. MuJoCo's default
    // anchor is body2's origin, and a weld held there lets a small part far
    // from it swing round it: a 20 g knob welded to a drawer fell 165 mm in
    // two seconds. The anchor is in body2's frame.
    const anchor = w.bodyId && target ? weldAnchor(w.bodyId, target.id) : '';
    equalities += `\n    <weld name="weld_constraint_${i + 1}" body1="${xmlAttr(w.bodyName)}" body2="${xmlAttr(target?.name || w.targetId)}"${anchor}${stiff} />`;
  });

  // Closed-loop pins.
  connects.forEach((c, i) => {
    // Named whenever it is a body in the scene. Only targets with joints of
    // their own used to be, so a pin on a crank's child (a crank pin with no
    // joint, carried round by the crank's) was pinned to the world instead.
    // A fixed body2 is the same as the world to MuJoCo, so naming it costs
    // nothing.
    const target = bodyOf(c.targetId);
    const body2 = target ? ` body2="${xmlAttr(target.name || c.targetId)}"` : '';
    // Held rigid, as a pin is: at MuJoCo's default impedance a pin was only as
    // stiff as the lighter body it held, so a scissor lift's pins opened 7 mm
    // under its 2 kg platform with a 1 kg slider, and it folded flat with a
    // 50 g one. tests/rigidPins.test.ts.
    // MuJoCo's <connect> anchor is always specified in body1's local frame,
    // whether body2 is named or omitted (worldbody).
    const body1 = poses[c.bodyId];
    const body1Pos = body1 ? body1.pos : [0, 0, 0];
    const body1Quat: QuatWXYZ = body1 ? body1.quat : [1, 0, 0, 0];
    const localAnchor = quatRotateVecInv(body1Quat, [
      c.anchor[0] - body1Pos[0],
      c.anchor[1] - body1Pos[1],
      c.anchor[2] - body1Pos[2],
    ]);
    equalities += `\n    <connect name="connect_constraint_${i + 1}" body1="${xmlAttr(c.bodyName)}"${body2} anchor="${localAnchor.map(v => v.toFixed(6)).join(' ')}" ${RIGID_COUPLING} />`;
  });

  for (const line of breaks.equality) equalities += `\n    ${line}`;

  // Bodies already joined by a coupling or a pin do not also collide: a
  // gear's collider and its mate's touch at the pitch circle, a nut's wraps
  // its screw, a pinned link overlaps its neighbour at the pin. MuJoCo skips a
  // parent and child by itself; these are the joins across the tree.
  const excludes: [string, string][] = [...breaks.excludes];
  const linkedKeys = new Set<string>();
  const link = (a?: string, b?: string) => {
    if (!a || !b || a === b) return;
    const key = [a, b].sort().join('\u0000');
    if (linkedKeys.has(key)) return;
    linkedKeys.add(key);
    excludes.push([a, b]);
  };
  for (const c of plan.couplings) if (!c.keepContact) link(jointsByName.get(c.joint1)?.node.name, jointsByName.get(c.joint2)?.node.name);
  for (const c of connects) link(c.bodyName, bodyOf(c.targetId)?.name);

  // Dry friction on a coupled joint goes where the chain feels it. The nodes
  // are this compile's copies, so their joint lists can be replaced.
  for (const [jointName, frictionloss] of relocateCoupledFriction(couplingEdges, jointsByName)) {
    const owner = jointsByName.get(jointName)!.node;
    owner.joints = owner.joints.map((j) => (j.name === jointName ? { ...j, frictionloss } : j));
  }

  let contact = '';
  if (excludes.length) {
    contact += `\n  <contact>${excludes.map(([p, q]) => `\n    <exclude body1="${xmlAttr(p)}" body2="${xmlAttr(q)}" />`).join('')}\n  </contact>`;
  }
  if (breaks.numerics.length) {
    contact += `\n  <custom>${breaks.numerics.map((n) => `\n    <numeric name="${xmlAttr(n.name)}" data="${n.data.map((v) => +v.toPrecision(6)).join(' ')}" />`).join('')}\n  </custom>`;
  }

  return {
    actuator: actuators.length > 0 ? `  <actuator>\n${actuators.map(actuatorXml).join('\n')}\n  </actuator>` : '',
    tendon: tendonLines.length ? `\n  <tendon>\n${tendonLines.join('\n')}\n  </tendon>` : '',
    equality: equalities ? `\n  <equality>${equalities}\n  </equality>` : '',
    /** `<contact>` exclusions and the break limits' `<custom>` numerics, which go last. */
    contact,
  };
}
