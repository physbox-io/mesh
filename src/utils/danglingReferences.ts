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

interface Present { names: Set<string>; prefixes: string[] }

/**
 * Every id and name a reference may resolve to. mjcf.ts looks an id up and
 * falls back to using it as a body name, so a name counts as present too, and
 * so does any body a composite (a rope, a cable) generates under its prefix.
 */
function present(nodes: SceneNode[]): Present {
  const out: Present = { names: new Set(), prefixes: [] };
  const walk = (list: SceneNode[]) => {
    for (const n of list || []) {
      if (n.id) out.names.add(n.id);
      if (n.name) out.names.add(n.name);
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

function clear(node: SceneNode, fields: ReferenceField[]): void {
  for (const f of fields) {
    delete node[f];
    for (const extra of REFERENCE_FIELDS[f]) delete (node as unknown as Record<string, unknown>)[extra];
  }
}

/** Clears dangling references in place. For a copy that is the caller's to change. */
export function dropDanglingReferencesInPlace(nodes: SceneNode[]): void {
  const live = present(nodes);
  const walk = (list: SceneNode[]) => {
    for (const n of list || []) {
      clear(n, dangling(n, live));
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
      if (!gone.length && children === node.children) return node;
      changed = true;
      const next: SceneNode = { ...node, ...(node.children ? { children } : {}) };
      clear(next, gone);
      return next;
    });
    return changed ? out : list;
  };
  const nodes = rebuild(scene.nodes);
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}
