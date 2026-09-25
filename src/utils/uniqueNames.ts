import type { SceneGraph, SceneNode } from '../types/scene';

/*
 * Body and geom names must be unique in the compiled model, and the viewport
 * finds each MuJoCo body and geom by the scene graph's name for it. mjcf.ts
 * used to fix a clash by giving the compiled copy a random suffix, which left
 * the graph still holding the clash: the second body's geom looked up the
 * first one's name and was drawn at the first body's transform, and React saw
 * two children with one key.
 *
 * So the rule is one deterministic function, run by both the store (on every
 * scene it keeps) and the compiler (on every scene it builds). Given the same
 * scene they pick the same names, whichever copy each is holding. The first
 * body or geom to use a name keeps it, in depth-first order; each later one
 * becomes `name_2`, `name_3` … whichever is free first.
 */

type Renames = Map<SceneNode, { name?: string; geoms?: Map<number, string> }>;

function allNames(nodes: SceneNode[], bodies: Set<string>, geoms: Set<string>) {
  for (const node of nodes) {
    if (!node.isPulleyRope) {
      bodies.add(node.name || node.id || 'body');
      for (const g of node.geoms || []) if (g.name) geoms.add(g.name);
    }
    allNames(node.children || [], bodies, geoms);
  }
}

function planRenames(nodes: SceneNode[]): Renames {
  const bodyNames = new Set<string>();
  const geomNames = new Set<string>();
  allNames(nodes, bodyNames, geomNames);
  const seenBodies = new Set<string>();
  const seenGeoms = new Set<string>();
  const free = (name: string, taken: Set<string>, seen: Set<string>) => {
    let k = 2;
    while (taken.has(`${name}_${k}`) || seen.has(`${name}_${k}`)) k++;
    return `${name}_${k}`;
  };
  const renames: Renames = new Map();
  const walk = (list: SceneNode[]) => {
    for (const node of list) {
      // A pulley rope is not a body of its own in the model; mjcf.ts skips it too.
      if (!node.isPulleyRope) {
        let bodyName = node.name || node.id || 'body';
        const entry: { name?: string; geoms?: Map<number, string> } = {};
        if (seenBodies.has(bodyName)) {
          bodyName = free(bodyName, bodyNames, seenBodies);
          entry.name = bodyName;
        }
        seenBodies.add(bodyName);
        (node.geoms || []).forEach((g, i) => {
          // An unnamed geom is emitted as `<body>_geom`, so it claims that name.
          let gName = g.name || `${bodyName}_geom`;
          if (seenGeoms.has(gName)) {
            gName = free(gName, geomNames, seenGeoms);
            (entry.geoms ??= new Map()).set(i, gName);
          }
          seenGeoms.add(gName);
        });
        if (entry.name || entry.geoms) renames.set(node, entry);
      }
      walk(node.children || []);
    }
  };
  walk(nodes);
  return renames;
}

/** Renames clashing bodies and geoms in place. For a copy that is the caller's to change. */
export function uniquifyNamesInPlace(nodes: SceneNode[]): void {
  for (const [node, { name, geoms }] of planRenames(nodes)) {
    if (name) node.name = name;
    if (geoms) for (const [i, gName] of geoms) node.geoms[i].name = gName;
  }
}

/**
 * The scene with its clashes renamed. The same object when there are none, and
 * otherwise new objects only along the path to each renamed body, so nothing
 * that may be shared with an earlier state is written to.
 */
export function withUniqueNames(scene: SceneGraph): SceneGraph {
  const renames = planRenames(scene.nodes);
  if (renames.size === 0) return scene;
  const rebuild = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((node) => {
      const children = node.children ? rebuild(node.children) : node.children;
      const r = renames.get(node);
      if (!r && children === node.children) return node;
      changed = true;
      return {
        ...node,
        ...(r?.name ? { name: r.name } : {}),
        ...(r?.geoms ? { geoms: node.geoms.map((g, i) => (r.geoms!.has(i) ? { ...g, name: r.geoms!.get(i)! } : g)) } : {}),
        ...(node.children ? { children } : {}),
      };
    });
    return changed ? out : list;
  };
  return { ...scene, nodes: rebuild(scene.nodes) };
}
