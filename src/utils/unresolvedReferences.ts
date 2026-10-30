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
import { REFERENCE_FIELDS } from './danglingReferences';

type ReferenceField = keyof typeof REFERENCE_FIELDS;
const FIELDS = Object.keys(REFERENCE_FIELDS) as ReferenceField[];

/** The fields mjcf.ts resolves to the target's first joint, by id only. */
const NEEDS_JOINT = new Set<ReferenceField>(['coupleTargetId', 'leftTargetId', 'rightTargetId', 'pulleyWheelId']);

export interface UnresolvedReference {
  bodyId: string;
  bodyName: string;
  field: ReferenceField;
  target: string;
  /** missing: no body by that id or name; byName: a name where an id is needed; noJoint: nothing to couple. */
  reason: 'missing' | 'byName' | 'noJoint';
}

const walk = (nodes: SceneNode[], fn: (n: SceneNode) => void) => {
  for (const n of nodes || []) { fn(n); walk(n.children || [], fn); }
};

/**
 * Every reference in `nodes` that resolves to nothing the model can use.
 * `only`, when given, limits the check to those bodies' own fields (the rest
 * of the scene still counts as targets).
 */
export function unresolvedReferences(nodes: SceneNode[], only?: Set<string>): UnresolvedReference[] {
  const byId = new Map<string, SceneNode>();
  const names = new Set<string>();
  const prefixes: string[] = [];
  walk(nodes, (n) => {
    if (n.id) byId.set(n.id, n);
    if (n.name) names.add(n.name);
    if (n.isComposite) prefixes.push(`${n.compositePrefix || `${n.name}_`}B_`);
  });
  const out: UnresolvedReference[] = [];
  walk(nodes, (n) => {
    if (only && !only.has(n.id)) return;
    for (const field of FIELDS) {
      const target = n[field];
      if (typeof target !== 'string') continue;
      const at = { bodyId: n.id, bodyName: n.name ?? n.id, field, target };
      const node = byId.get(target);
      if (!node && !names.has(target) && !prefixes.some((p) => target.startsWith(p))) {
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
    if (r.reason === 'missing') return `${where} names no body in the scene, so it was dropped and does nothing. Check the id (physics_get_scene_summary lists them).`;
    if (r.reason === 'byName') return `${where} is a body's name; ${r.field} needs its id, so nothing is coupled.`;
    return `${where}: ${r.target === r.bodyId ? r.bodyName : `'${r.target}'`} has no joint, so nothing is coupled. Give it a hinge or slide.`;
  });
}
