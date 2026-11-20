// ---------------------------------------------------------------------------
// References an MCP caller wrote that point at nothing.
//
// A weld, pin, coupling or pulley rope names the body at its other end by id.
// One that names no body is dropped (utils/danglingReferences.ts), which is
// right for a body that has since been deleted and silent for a typo: a
// pulleyWheelId of 'whel' built a rope with no wheel, ok:true. A coupling or a
// rope also needs a jointed body at each end, found by id alone (mjcf.ts's
// jointedNodes), and was skipped just as quietly without one. This finds both
// in what a caller sent, before the store drops them, so the reply can say so.
// Pure: no store, no DOM.
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';
import { ACOUSTIC_REFERENCES, REFERENCE_FIELDS } from './danglingReferences';

type ReferenceField = keyof typeof REFERENCE_FIELDS;
const FIELDS = Object.keys(REFERENCE_FIELDS) as ReferenceField[];

/** The fields mjcf.ts resolves to the target's first joint, by id only. */
const NEEDS_JOINT = new Set<ReferenceField>(['coupleTargetId', 'leftTargetId', 'rightTargetId', 'pulleyWheelId']);

export interface UnresolvedReference {
  bodyId: string;
  bodyName: string;
  /** A body-reference field, a cloth reference, or an acoustic one such as `acousticString.resonatorNodeId` or `windInstrument.valveJoints[0].jointName`. */
  field: ReferenceField | string;
  target: string;
  /**
   * missing: no body by that id or name; byName: a name where an id is needed; noJoint: nothing to couple;
   * missingJoint: an instrument names a joint no body in its subtree has;
   * notBodyForm / notCloth: wrong target kind for cloth.
   */
  reason: 'missing' | 'byName' | 'noJoint' | 'missingJoint' | 'notBodyForm' | 'notCloth';
}

const walk = (nodes: SceneNode[], fn: (n: SceneNode) => void) => {
  for (const n of nodes || []) { fn(n); walk(n.children || [], fn); }
};

/** The joint names a body's wind instrument or resonator tube refers to. */
function namedJoints(n: SceneNode): { field: string; target: string }[] {
  const out: { field: string; target: string }[] = [];
  (n.windInstrument?.toneholeJoints || []).forEach((t, i) => {
    if (typeof t?.jointName === 'string') out.push({ field: `windInstrument.toneholeJoints[${i}].jointName`, target: t.jointName });
  });
  (n.windInstrument?.valveJoints || []).forEach((v, i) => {
    if (typeof v?.jointName === 'string') out.push({ field: `windInstrument.valveJoints[${i}].jointName`, target: v.jointName });
  });
  const vane = n.resonatorTube?.vaneJointName;
  if (typeof vane === 'string') out.push({ field: 'resonatorTube.vaneJointName', target: vane });
  return out;
}

/**
 * Every reference in `nodes` that resolves to nothing the model can use.
 * `only`, when given, limits the check to those bodies' own fields (the rest
 * of the scene still counts as targets).
 */
export function unresolvedReferences(nodes: SceneNode[], only?: Set<string>): UnresolvedReference[] {
  const byId = new Map<string, SceneNode>();
  const names = new Set<string>();
  const rigidNames = new Set<string>();
  const forms = new Set<string>();
  const cloths = new Set<string>();
  const prefixes: string[] = [];
  walk(nodes, (n) => {
    if (n.id) byId.set(n.id, n);
    if (n.name) names.add(n.name);
    if (n.cloth) {
      if (n.id) cloths.add(n.id);
      cloths.add(n.name || n.id);
    } else if (!n.isPulleyRope) {
      if (n.id) rigidNames.add(n.id);
      if (n.name) rigidNames.add(n.name);
      if (n.bodyForm) {
        if (n.id) forms.add(n.id);
        forms.add(n.name || n.id);
      }
      if (n.isComposite) prefixes.push(`${n.compositePrefix || `${n.name}_`}B_`);
    }
  });
  const anyKnown = (s: string) => byId.has(s) || names.has(s);
  const out: UnresolvedReference[] = [];
  walk(nodes, (n) => {
    if (only && !only.has(n.id)) return;
    if (n.cloth) {
      const fit = n.cloth.garment?.fitTo;
      if (typeof fit === 'string' && !forms.has(fit)) {
        out.push({
          bodyId: n.id,
          bodyName: n.name ?? n.id,
          field: 'cloth.garment.fitTo',
          target: fit,
          reason: anyKnown(fit) ? 'notBodyForm' : 'missing',
        });
      }
      (n.cloth.ties || []).forEach((t, i) => {
        if (typeof t.to === 'string' && !rigidNames.has(t.to) && !prefixes.some((p) => t.to!.startsWith(p))) {
          out.push({
            bodyId: n.id,
            bodyName: n.name ?? n.id,
            field: `cloth.ties[${i}].to`,
            target: t.to,
            reason: 'missing',
          });
        }
        if (typeof t.toCloth === 'string' && !cloths.has(t.toCloth)) {
          out.push({
            bodyId: n.id,
            bodyName: n.name ?? n.id,
            field: `cloth.ties[${i}].toCloth`,
            target: t.toCloth,
            reason: anyKnown(t.toCloth) ? 'notCloth' : 'missing',
          });
        }
      });
    }
    // Acoustic hosts: a soundbox, a shell, a bar. Dropped when nothing has the id.
    for (const ref of ACOUSTIC_REFERENCES) {
      const target = ref.read(n);
      if (typeof target !== 'string') continue;
      if (!rigidNames.has(target) && !prefixes.some((p) => target.startsWith(p))) {
        out.push({ bodyId: n.id, bodyName: n.name ?? n.id, field: ref.field, target, reason: 'missing' });
      }
    }
    // Joints an instrument names by string must exist on it or under it.
    const named = namedJoints(n);
    if (named.length) {
      const have = new Set<string>();
      walk([n], (m) => { if (!m.isPulleyRope) for (const j of m.joints || []) if (j.name) have.add(j.name); });
      for (const { field, target } of named) {
        if (!have.has(target)) out.push({ bodyId: n.id, bodyName: n.name ?? n.id, field, target, reason: 'missingJoint' });
      }
    }
    for (const field of FIELDS) {
      const target = n[field];
      if (typeof target !== 'string') continue;
      const at = { bodyId: n.id, bodyName: n.name ?? n.id, field, target };
      const node = byId.get(target);
      if ((!node || node.cloth) && !rigidNames.has(target) && !prefixes.some((p) => target.startsWith(p))) {
        out.push({ ...at, reason: 'missing' });
      } else if (NEEDS_JOINT.has(field) && !node) {
        out.push({ ...at, reason: 'byName' });
      } else if (NEEDS_JOINT.has(field) && node && !node.joints?.length) {
        out.push({ ...at, reason: 'noJoint' });
      }
    }
    // A coupling is between this body's first joint and the target's.
    if (typeof n.coupleTargetId === 'string' && !n.joints?.length) {
      out.push({ bodyId: n.id, bodyName: n.name ?? n.id, field: 'coupleTargetId', target: n.id, reason: 'noJoint' });
    }
  });
  return out;
}

/** One sentence each, for a reply. */
export function unresolvedReferenceWarnings(refs: UnresolvedReference[]): string[] {
  return refs.map((r) => {
    const where = `${r.field} '${r.target}' on ${r.bodyName}`;
    if (r.reason === 'missingJoint') return `${where} names no joint on that body or the bodies under it, so it does nothing. Check the joint's name.`;
    if (r.reason === 'notBodyForm') return `${where} names a body that is not a body form, so the garment was released from it.`;
    if (r.reason === 'notCloth') return `${where} names a body that is not cloth, so the tie was dropped.`;
    if (r.reason === 'missing') return `${where} names no body in the scene, so it was dropped and does nothing. Check the id (physics_get_scene_summary lists them).`;
    if (r.reason === 'byName') return `${where} is a body's name; ${r.field} needs its id, so nothing is coupled.`;
    return `${where}: ${r.target === r.bodyId ? r.bodyName : `'${r.target}'`} has no joint, so nothing is coupled. Give it a hinge or slide.`;
  });
}
