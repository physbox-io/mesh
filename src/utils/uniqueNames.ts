import type { SceneGraph, SceneNode } from '../types/scene';
import { bodyFormKey } from './cloth/bodyFormEdit';

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
 *
 * Body ids follow the same rule too. The store, the MCP (get_object, the
 * scene summary, a headless run's report) and every constraint target find a
 * body by id, so two bodies with one id were one body to all of them: the
 * summary and get_object answered for whichever came first, and a headless
 * trajectory mixed the two. Every body has an id, pulley ropes included.
 */

const RESERVED_BODIES = ['world'];
const RESERVED_GEOMS = ['floor'];

type Rename = { id?: string; name?: string; geoms?: Map<number, string>; joints?: Map<number, string>; prefix?: string };
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

/** Anything shaped like a body tree: a SceneNode, or a raw MCP body descriptor. */
type IdTree = { children?: IdTree[] };

/**
 * New ids for the later of any clash, by the name rule: the first body (depth
 * first) keeps an id, each later one becomes `id_2`, `id_3` … whichever is
 * free first. `idOf` says what a body's id is (for a raw descriptor, its id or
 * else its name, as fillBodyDefaults decides); a body with none is left be.
 */
export function planIdRenames<T extends IdTree>(nodes: T[], idOf: (n: T) => string | undefined): Map<T, string> {
  const all = new Set<string>();
  const collect = (list: T[] | undefined) => {
    for (const n of list ?? []) {
      const id = idOf(n);
      if (id) all.add(id);
      collect(n.children as T[] | undefined);
    }
  };
  collect(nodes);
  const seen = new Set<string>();
  const out = new Map<T, string>();
  const walk = (list: T[] | undefined) => {
    for (const n of list ?? []) {
      let id = idOf(n);
      if (id) {
        if (seen.has(id)) {
          let k = 2;
          while (all.has(`${id}_${k}`) || seen.has(`${id}_${k}`)) k++;
          id = `${id}_${k}`;
          out.set(n, id);
        }
        seen.add(id);
      }
      walk(n.children as T[] | undefined);
    }
  };
  walk(nodes);
  return out;
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
  for (const [node, id] of planIdRenames(nodes, (n) => n.id)) {
    const entry = renames.get(node) ?? {};
    entry.id = id;
    renames.set(node, entry);
  }
  return renames;
}

interface ClothTargetMaps {
  forms: Map<string, string>;
  cloths: Map<string, string>;
  bodies: Map<string, string>;
}

function buildClothTargetMaps(nodes: SceneNode[], renames: Renames): ClothTargetMaps {
  const finalNames = new Set<string>();
  const scan = (list: SceneNode[]) => {
    for (const n of list || []) {
      if (!n.isPulleyRope) {
        const r = renames.get(n);
        finalNames.add(r?.name ?? (n.name || r?.id || n.id || 'body'));
      }
      scan(n.children || []);
    }
  };
  scan(nodes);
  const forms = new Map<string, string>();
  const cloths = new Map<string, string>();
  const bodies = new Map<string, string>();
  const register = (map: Map<string, string>, id: string | undefined, targetName: string) => {
    if (!id) return;
    if (id === targetName || !finalNames.has(id)) map.set(id, targetName);
  };
  const populate = (list: SceneNode[]) => {
    for (const n of list || []) {
      const r = renames.get(n);
      const nextId = r?.id ?? n.id;
      const finalName = r?.name ?? (n.name || nextId || 'body');
      if (n.cloth) {
        register(cloths, n.id, finalName);
        register(cloths, nextId, finalName);
      } else if (!n.isPulleyRope) {
        register(bodies, n.id, finalName);
        register(bodies, nextId, finalName);
        if (n.bodyForm) {
          register(forms, n.id, finalName);
          register(forms, nextId, finalName);
        }
      }
      populate(n.children || []);
    }
  };
  populate(nodes);
  return { forms, cloths, bodies };
}

/**
 * Rewrites cloth target references (`fitTo`, `ties[].to`, `ties[].toCloth`)
 * held by id (from duplicate/paste or MCP) to the target's final unique name,
 * and keeps `bodyFormBuilt` aligned when a clean dress form is renamed so a
 * duplicate does not re-run 40 SurfaceNets builds.
 */
function clothNameRewrites(
  node: SceneNode,
  renames: Renames,
  maps: ClothTargetMaps,
): Pick<SceneNode, 'cloth' | 'bodyFormBuilt'> | null {
  let cloth = node.cloth;
  let clothChanged = false;
  if (cloth) {
    const fit = cloth.garment?.fitTo;
    if (typeof fit === 'string' && maps.forms.has(fit) && maps.forms.get(fit) !== fit) {
      cloth = { ...cloth, garment: { ...cloth.garment!, fitTo: maps.forms.get(fit)! } };
      clothChanged = true;
    }
    if (cloth.ties?.length) {
      let tiesChanged = false;
      const ties = cloth.ties.map((t) => {
        const nextTo = typeof t.to === 'string' && maps.bodies.has(t.to) ? maps.bodies.get(t.to)! : t.to;
        const nextCloth = typeof t.toCloth === 'string' && maps.cloths.has(t.toCloth) ? maps.cloths.get(t.toCloth)! : t.toCloth;
        if (nextTo === t.to && nextCloth === t.toCloth) return t;
        tiesChanged = true;
        return {
          ...t,
          ...(nextTo !== undefined ? { to: nextTo } : {}),
          ...(nextCloth !== undefined ? { toCloth: nextCloth } : {}),
        };
      });
      if (tiesChanged) {
        cloth = { ...cloth, ties };
        clothChanged = true;
      }
    }
  }
  const r = renames.get(node);
  const nextFormBuilt =
    node.bodyForm && node.bodyFormBuilt && (r?.name || r?.id) && node.bodyFormBuilt === bodyFormKey(node)
      ? bodyFormKey({ bodyForm: node.bodyForm })
      : undefined;
  const formBuiltChanged = nextFormBuilt !== undefined && nextFormBuilt !== node.bodyFormBuilt;
  if (!clothChanged && !formBuiltChanged) return null;
  return {
    ...(clothChanged ? { cloth } : {}),
    ...(formBuiltChanged ? { bodyFormBuilt: nextFormBuilt } : {}),
  };
}

/**
 * The joint names an instrument or tube refers to, rewritten for the joints
 * that were renamed in its own subtree. A tonehole key, a brass valve or a
 * vibraphone vane names its MuJoCo joint by string, so a copy whose joint
 * became `key_2` has to follow it, or the wind solver finds the ORIGINAL's
 * joint (or none). Scoped per subtree: a joint renamed elsewhere in the scene
 * is not this instrument's. Null when nothing it names was renamed.
 */
function acousticJointRewrites(
  node: SceneNode, renames: Renames,
): Pick<SceneNode, 'windInstrument' | 'resonatorTube'> | null {
  const wind = node.windInstrument;
  const tube = node.resonatorTube;
  if (!wind?.toneholeJoints?.length && !wind?.valveJoints?.length && !tube?.vaneJointName) return null;
  const kept = new Set<string>();
  const to = new Map<string, string>();
  const walk = (n: SceneNode) => {
    if (!n.isPulleyRope) {
      (n.joints || []).forEach((j, i) => {
        if (!j.name) return;
        const renamed = renames.get(n)?.joints?.get(i);
        if (renamed) { if (!to.has(j.name)) to.set(j.name, renamed); } else kept.add(j.name);
      });
    }
    for (const c of n.children || []) walk(c);
  };
  walk(node);
  for (const k of kept) to.delete(k);
  if (to.size === 0) return null;
  const out: Pick<SceneNode, 'windInstrument' | 'resonatorTube'> = {};
  if (wind) {
    const rename = <T extends { jointName: string }>(list: T[] | undefined) =>
      list?.some((e) => to.has(e.jointName)) ? list.map((e) => (to.has(e.jointName) ? { ...e, jointName: to.get(e.jointName)! } : e)) : list;
    const toneholeJoints = rename(wind.toneholeJoints);
    const valveJoints = rename(wind.valveJoints);
    if (toneholeJoints !== wind.toneholeJoints || valveJoints !== wind.valveJoints) {
      out.windInstrument = {
        ...wind,
        ...(toneholeJoints ? { toneholeJoints } : {}),
        ...(valveJoints ? { valveJoints } : {}),
      };
    }
  }
  if (tube?.vaneJointName && to.has(tube.vaneJointName)) {
    out.resonatorTube = { ...tube, vaneJointName: to.get(tube.vaneJointName)! };
  }
  return out.windInstrument || out.resonatorTube ? out : null;
}

/** Renames clashing bodies and geoms in place. For a copy that is the caller's to change. */
export function uniquifyNamesInPlace(nodes: SceneNode[]): void {
  const renames = planRenames(nodes);
  const maps = buildClothTargetMaps(nodes, renames);
  // Read against the joints as they were, before any of them is renamed.
  const acoustic: [SceneNode, NonNullable<ReturnType<typeof acousticJointRewrites>>][] = [];
  const clothUpdates: [SceneNode, NonNullable<ReturnType<typeof clothNameRewrites>>][] = [];
  const consider = (list: SceneNode[]) => {
    for (const n of list || []) {
      const rw = renames.size ? acousticJointRewrites(n, renames) : null;
      if (rw) acoustic.push([n, rw]);
      const cw = clothNameRewrites(n, renames, maps);
      if (cw) clothUpdates.push([n, cw]);
      consider(n.children || []);
    }
  };
  consider(nodes);
  for (const [node, rw] of acoustic) Object.assign(node, rw);
  for (const [node, cw] of clothUpdates) Object.assign(node, cw);
  for (const [node, { id, name, geoms, joints, prefix }] of renames) {
    if (id) node.id = id;
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
  const maps = buildClothTargetMaps(scene.nodes, renames);
  const rebuild = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((node) => {
      const children = node.children ? rebuild(node.children) : node.children;
      const r = renames.get(node);
      const rw = renames.size ? acousticJointRewrites(node, renames) : null;
      const cw = clothNameRewrites(node, renames, maps);
      if (!r && !rw && !cw && children === node.children) return node;
      changed = true;
      return {
        ...node,
        ...rw,
        ...cw,
        ...(r?.id ? { id: r.id } : {}),
        ...(r?.name ? { name: r.name } : {}),
        ...(r?.prefix ? { compositePrefix: r.prefix } : {}),
        ...(r?.geoms ? { geoms: node.geoms.map((g, i) => (r.geoms!.has(i) ? { ...g, name: r.geoms!.get(i)! } : g)) } : {}),
        ...(r?.joints ? { joints: node.joints!.map((j, i) => (r.joints!.has(i) ? { ...j, name: r.joints!.get(i)! } : j)) } : {}),
        ...(node.children ? { children } : {}),
      };
    });
    return changed ? out : list;
  };
  const nodes = rebuild(scene.nodes);
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}

/** A raw body descriptor's id, as fillBodyDefaults will decide it. */
type RawBody = { id?: string; name?: string; children?: RawBody[] };

/**
 * Raw MCP bodies with every clashing id made unique, before they become
 * nodes. Done here rather than left to the store, because the bodies' cuts,
 * patterns and SCAD are queued by id while they are filled in, and two
 * bodies queued under one id get each other's. Returns the bodies (the same
 * array when nothing clashes) and what was renamed, for the reply.
 */
export function withUniqueRawIds<T extends RawBody>(bodies: T[]): { bodies: T[]; renamed: { from: string; to: string }[] } {
  const plan = planIdRenames(bodies as RawBody[], (b) => b.id ?? b.name);
  const renamed: { from: string; to: string }[] = [];
  if (plan.size === 0) return { bodies, renamed };
  const rebuild = (list: RawBody[]): RawBody[] => {
    let changed = false;
    const out = list.map((b) => {
      const id = plan.get(b);
      if (id) renamed.push({ from: (b.id ?? b.name)!, to: id });
      const children = Array.isArray(b.children) ? rebuild(b.children) : b.children;
      if (!id && children === b.children) return b;
      changed = true;
      return { ...b, ...(id ? { id } : {}), ...(b.children ? { children } : {}) };
    });
    return changed ? out : list;
  };
  const out = rebuild(bodies) as T[];
  return { bodies: out, renamed };
}
