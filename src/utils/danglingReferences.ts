// ---------------------------------------------------------------------------
// References to bodies that are no longer there
//
// A weld, a connect, a coupling or a pulley rope names the body at its other
// end by id, and mjcf.ts writes that straight into the model. Any operation
// that takes a body out of the scene — split for print, the knife, a shatter
// with children, a paste of a copy whose target has since gone, a pipe frame
// that replaces its body — used to leave those names behind, and MuJoCo
// refused the whole model: "unknown element 'x' in equality constraint". A
// connect fared worse: with nothing to name it compiled against the world and
// pinned the body in mid-air with no error at all.
//
// So rather than every operation remembering to clean up, the store runs this
// on every scene it is given, and mjcf.ts on every scene it compiles. What was
// fixed to something that has stopped existing comes off, as on a delete.
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode } from '../types/scene';
import { clampBodyForm } from './cloth/bodyForm';

/** Each field on a node that holds another node's id, and what goes with it. */
export const REFERENCE_FIELDS = {
  weldTargetId: ['weldRigid'],
  connectTargetId: ['connectAnchor', 'connectAnchorLocal'],
  coupleTargetId: ['coupleRatio'],
  leftTargetId: [],
  rightTargetId: [],
  pulleyWheelId: [],
  weldLastToId: [],
} as const satisfies Record<string, readonly string[]>;

type ReferenceField = keyof typeof REFERENCE_FIELDS;
const FIELDS = Object.keys(REFERENCE_FIELDS) as ReferenceField[];

/**
 * The acoustic fields that name another body: a string's soundbox (on its spec
 * and on the node), a drumhead's shell and a resonator tube's coupled bar.
 * They sit apart from REFERENCE_FIELDS because most live inside a spec object
 * and clearing one must not write into a spec shared with an earlier state.
 */
export interface AcousticReference {
  field: string;
  read: (node: SceneNode) => string | undefined;
  /** Removes the reference from `node`, replacing the spec it sits in rather than editing it. */
  clear: (node: SceneNode) => void;
}

const omit = <T extends object, K extends keyof T>(spec: T, key: K): T => {
  const copy = { ...spec };
  delete copy[key];
  return copy;
};

export const ACOUSTIC_REFERENCES: readonly AcousticReference[] = [
  {
    field: 'resonatorNodeId',
    read: (n) => n.resonatorNodeId,
    clear: (n) => { delete n.resonatorNodeId; },
  },
  {
    field: 'acousticString.resonatorNodeId',
    read: (n) => n.acousticString?.resonatorNodeId,
    clear: (n) => { if (n.acousticString) n.acousticString = omit(n.acousticString, 'resonatorNodeId'); },
  },
  {
    field: 'acousticMembrane.shellNodeId',
    read: (n) => n.acousticMembrane?.shellNodeId,
    clear: (n) => { if (n.acousticMembrane) n.acousticMembrane = omit(n.acousticMembrane, 'shellNodeId'); },
  },
  {
    field: 'resonatorTube.coupledBarNodeId',
    read: (n) => n.resonatorTube?.coupledBarNodeId,
    clear: (n) => { if (n.resonatorTube) n.resonatorTube = omit(n.resonatorTube, 'coupledBarNodeId'); },
  },
];

interface Present { names: Set<string>; prefixes: string[]; forms: Set<string>; cloths: Set<string> }

/**
 * Every id and name a reference may resolve to. mjcf.ts looks an id up and
 * falls back to using it as a body name, so a name counts as present too, and
 * so does any body a composite (a rope, a cable) generates under its prefix.
 */
function present(nodes: SceneNode[]): Present {
  const out: Present = { names: new Set(), prefixes: [], forms: new Set(), cloths: new Set() };
  const walk = (list: SceneNode[]) => {
    for (const n of list || []) {
      // Neither a pulley rope nor a cloth piece is a body in the MuJoCo model,
      // so nothing rigid can be welded or pinned to it ("unknown element").
      // Cloth pieces still resolve `toCloth` ties, and what hangs under either
      // is still a body.
      if (n.isPulleyRope || n.cloth) {
        if (n.cloth) {
          if (n.id) out.cloths.add(n.id);
          out.cloths.add(n.name || n.id);
        }
        walk(n.children || []);
        continue;
      }
      if (n.id) out.names.add(n.id);
      if (n.name) out.names.add(n.name);
      if (n.bodyForm) {
        if (n.id) out.forms.add(n.id);
        out.forms.add(n.name || n.id);
      }
      // MuJoCo names a cable's bodies <prefix>B_first, B_1 … B_last.
      if (n.isComposite) out.prefixes.push(`${n.compositePrefix || `${n.name}_`}B_`);
      walk(n.children || []);
    }
  };
  walk(nodes);
  return out;
}

const isLive = (to: string, live: Present) =>
  live.names.has(to) || live.prefixes.some((p) => to.startsWith(p));

const dangling = (node: SceneNode, live: Present): ReferenceField[] =>
  FIELDS.filter((f) => typeof node[f] === 'string' && !isLive(node[f] as string, live));

const hasDanglingCloth = (node: SceneNode, live: Present): boolean => {
  const fit = node.cloth?.garment?.fitTo;
  if (typeof fit === 'string' && !live.forms.has(fit)) return true;
  const ties = node.cloth?.ties;
  return !!ties?.some(
    (t) =>
      (typeof t.to === 'string' && !isLive(t.to, live)) ||
      (typeof t.toCloth === 'string' && !live.cloths.has(t.toCloth)),
  );
};

/**
 * Releases a garment whose form is missing (giving it default measurements if
 * it carried none, so clothModel never throws), and drops ties whose target
 * body or cloth is missing rather than pinning them to thin air in world space.
 */
function clearCloth(node: SceneNode, live: Present): void {
  if (!node.cloth) return;
  let cloth = node.cloth;
  if (typeof cloth.garment?.fitTo === 'string' && !live.forms.has(cloth.garment.fitTo)) {
    const { fitTo: _fitTo, ...rest } = cloth.garment;
    cloth = { ...cloth, garment: { ...rest, form: rest.form ?? clampBodyForm({}) } };
  }
  if (cloth.ties?.length) {
    const kept = cloth.ties.filter(
      (t) =>
        (typeof t.to !== 'string' || isLive(t.to, live)) &&
        (typeof t.toCloth !== 'string' || live.cloths.has(t.toCloth)),
    );
    if (kept.length !== cloth.ties.length) {
      const next = { ...cloth };
      if (kept.length) next.ties = kept;
      else delete next.ties;
      cloth = next;
    }
  }
  node.cloth = cloth;
}

const danglingAcoustic = (node: SceneNode, live: Present): AcousticReference[] =>
  ACOUSTIC_REFERENCES.filter((r) => {
    const to = r.read(node);
    return typeof to === 'string' && !isLive(to, live);
  });

function clear(node: SceneNode, fields: ReferenceField[], acoustic: AcousticReference[] = []): void {
  for (const f of fields) {
    delete node[f];
    for (const extra of REFERENCE_FIELDS[f]) delete (node as unknown as Record<string, unknown>)[extra];
  }
  for (const r of acoustic) r.clear(node);
}

/** Clears dangling references in place. For a copy that is the caller's to change. */
export function dropDanglingReferencesInPlace(nodes: SceneNode[]): void {
  const live = present(nodes);
  const walk = (list: SceneNode[]) => {
    for (const n of list || []) {
      clear(n, dangling(n, live), danglingAcoustic(n, live));
      if (hasDanglingCloth(n, live)) clearCloth(n, live);
      walk(n.children || []);
    }
  };
  walk(nodes);
}

/**
 * The scene without dangling references. The same object when there are none,
 * and otherwise new objects only along the path to each changed body, so
 * nothing that may be shared with an earlier state is written to.
 */
export function withoutDanglingReferences(scene: SceneGraph): SceneGraph {
  if (!scene.nodes) return scene;
  const live = present(scene.nodes);
  const rebuild = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((node) => {
      const children = node.children ? rebuild(node.children) : node.children;
      const gone = dangling(node, live);
      const goneAcoustic = danglingAcoustic(node, live);
      const goneCloth = hasDanglingCloth(node, live);
      if (!gone.length && !goneAcoustic.length && !goneCloth && children === node.children) return node;
      changed = true;
      const next: SceneNode = { ...node, ...(node.children ? { children } : {}) };
      clear(next, gone, goneAcoustic);
      if (goneCloth) clearCloth(next, live);
      return next;
    });
    return changed ? out : list;
  };
  const nodes = rebuild(scene.nodes);
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}
