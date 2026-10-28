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
 * becomes `name_2`, `name_3` … whichever is free first. A geom with no name
 * at all is given one the same way, starting from `<body>_geom`.
 *
 * Joints follow the same rule: MuJoCo refuses a model with two joints of one
 * name, and two bodies copied from one another each had a "hinge". So do two
 * names the compiler writes itself: the world body is `world` and the ground
 * plane is the geom `floor`, so a body or geom of the user's called that is
 * renamed as though something earlier had it.
 *
 * A composite (a rope, a cable) names the bodies it generates from its
 * prefix, `<name>_` unless one is given. A copy of a rope with a prefix of its
 * own kept it, so the two ropes' generated bodies clashed and the copy's end
 * weld held the original's end. A later clashing prefix becomes the body's
 * own (unique) name plus `_`, numbered further if even that is taken.
 */

const RESERVED_BODIES = ['world'];
const RESERVED_GEOMS = ['floor'];

type Rename = { name?: string; geoms?: Map<number, string>; joints?: Map<number, string>; prefix?: string };
type Renames = Map<SceneNode, Rename>;

function allNames(nodes: SceneNode[], bodies: Set<string>, geoms: Set<string>, joints: Set<string>) {
  for (const node of nodes) {
    if (!node.isPulleyRope) {
      bodies.add(node.name || node.id || 'body');
      for (const g of node.geoms || []) if (g.name) geoms.add(g.name);
      for (const j of node.joints || []) if (j.name) joints.add(j.name);
    }
    allNames(node.children || [], bodies, geoms, joints);
  }
}

function planRenames(nodes: SceneNode[]): Renames {
  const bodyNames = new Set<string>();
  const geomNames = new Set<string>();
  const jointNames = new Set<string>();
  allNames(nodes, bodyNames, geomNames, jointNames);
  const seenBodies = new Set<string>(RESERVED_BODIES);
  const seenGeoms = new Set<string>(RESERVED_GEOMS);
  const seenJoints = new Set<string>();
  const seenPrefixes = new Set<string>();
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
        const entry: Rename = {};
        if (seenBodies.has(bodyName)) {
          bodyName = free(bodyName, bodyNames, seenBodies);
          entry.name = bodyName;
        }
        seenBodies.add(bodyName);
        (node.geoms || []).forEach((g, i) => {
          // An unnamed geom is given `<body>_geom` (then `_geom_2` …). It
          // has to be written back, not just reserved: mjcf.ts emits
          // `geom.name` as it stands, and two unnamed mesh geoms used to
          // compile to two assets called "undefined".
          let gName = g.name || `${bodyName}_geom`;
          if (seenGeoms.has(gName)) gName = free(gName, geomNames, seenGeoms);
          if (gName !== g.name) (entry.geoms ??= new Map()).set(i, gName);
          seenGeoms.add(gName);
        });
        // An unnamed joint stays unnamed: MuJoCo takes any number of those.
        (node.joints || []).forEach((j, i) => {
          if (!j.name) return;
          let jName = j.name;
          if (seenJoints.has(jName)) jName = free(jName, jointNames, seenJoints);
          if (jName !== j.name) (entry.joints ??= new Map()).set(i, jName);
          seenJoints.add(jName);
        });
        if (node.isComposite) {
          let prefix = node.compositePrefix || `${bodyName}_`;
          if (seenPrefixes.has(prefix)) {
            let k = 2;
            prefix = `${bodyName}_`;
            while (seenPrefixes.has(prefix)) prefix = `${bodyName}_${k++}_`;
            entry.prefix = prefix;
          }
          seenPrefixes.add(prefix);
        }
        if (entry.name || entry.geoms || entry.joints || entry.prefix) renames.set(node, entry);
      }
      walk(node.children || []);
    }
  };
  walk(nodes);
  return renames;
}

/** Renames clashing bodies and geoms in place. For a copy that is the caller's to change. */
export function uniquifyNamesInPlace(nodes: SceneNode[]): void {
  for (const [node, { name, geoms, joints, prefix }] of planRenames(nodes)) {
    if (name) node.name = name;
    if (prefix) node.compositePrefix = prefix;
    if (geoms) for (const [i, gName] of geoms) node.geoms[i].name = gName;
    if (joints) node.joints = node.joints!.map((j, i) => (joints.has(i) ? { ...j, name: joints.get(i)! } : j));
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
        ...(r?.prefix ? { compositePrefix: r.prefix } : {}),
        ...(r?.geoms ? { geoms: node.geoms.map((g, i) => (r.geoms!.has(i) ? { ...g, name: r.geoms!.get(i)! } : g)) } : {}),
        ...(r?.joints ? { joints: node.joints!.map((j, i) => (r.joints!.has(i) ? { ...j, name: r.joints!.get(i)! } : j)) } : {}),
        ...(node.children ? { children } : {}),
      };
    });
    return changed ? out : list;
  };
  return { ...scene, nodes: rebuild(scene.nodes) };
}
