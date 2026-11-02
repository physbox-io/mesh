import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { generateWedgeMeshData } from './geom';
import { resolveCsgGeoms } from './csg';
import { uniquifyNamesInPlace } from './uniqueNames';
import { applyBodyMass } from './bodyMass';
import { dropDanglingReferencesInPlace } from './danglingReferences';
import { buildBreakModel } from './breakModel';
import { withoutNulls } from './withoutNulls';
import { applyContactClasses } from './contactClasses';

const wedgeMeshCache = new Map<string, ReturnType<typeof generateWedgeMeshData>>();

const getCachedWedgeMeshData = (w: number, d: number, h: number) => {
  const key = `${w}:${d}:${h}`;
  let cached = wedgeMeshCache.get(key);
  if (!cached) {
    cached = generateWedgeMeshData(w, d, h);
    wedgeMeshCache.set(key, cached);
  }
  return cached;
};

// Copy only what the passes below write to: a node's name and geom list, and
// a geom's name (plus, for a wedge, its mesh fields, which are replaced rather
// than edited). Geoms are copied as well as nodes because resolveCsgGeoms
// hands back the original geom objects, and a rename would leak into the
// store. Vertex and face arrays are shared — nothing here writes into them,
// and deep-copying a shattered scene's worth of them cost every rebuild.
// A null field is read as unset (utils/withoutNulls.ts): `friction: null`
// reached `.join` and the scene never compiled again.
const cloneNodes = (nodes: SceneNode[]): SceneNode[] => nodes.map(n => ({
  ...withoutNulls(n),
  ...(n.geoms ? { geoms: n.geoms.map(g => ({ ...withoutNulls(g) })) } : {}),
  ...(n.joints ? { joints: n.joints.map(withoutNulls) } : {}),
  ...(n.children ? { children: cloneNodes(n.children) } : {}),
}));

/** Every node in the tree, parents before their children. */
const eachNode = (nodes: SceneNode[] | undefined, visit: (node: SceneNode) => void) => {
  if (!nodes) return;
  for (const node of nodes) {
    visit(node);
    eachNode(node.children, visit);
  }
};

/**
 * The scene as it will be emitted: a copy the compile may write into, its
 * bodies resolved to the geoms that really simulate, every name final, and the
 * breakable members split into welded halves.
 */
export function prepareScene(scene: SceneGraph): { nodes: SceneNode[]; breaks: ReturnType<typeof buildBreakModel> } {
  const nodes = cloneNodes(scene.nodes);
  // Before booleans are resolved, so names match what the store keeps.
  uniquifyNamesInPlace(nodes);

  // Resolve every body down to the geoms that actually simulate: a boolean's
  // negatives are dropped, and depending on the collision mode the colliders are
  // the source primitives, the generated convex sectors, or — for any body whose
  // mesh has been decomposed — its convex pieces. Runs before everything else so
  // name-uniqueness and mesh-asset collection only ever see geoms that will
  // really be emitted. A body with nothing derived is returned untouched.
  // Each body's own geom list, before it is resolved: a convex piece's source
  // mesh is dropped from what is emitted, and bodyMass needs to find it.
  const authoredGeoms = new Map<SceneNode, SceneGeom[]>();
  eachNode(nodes, (node) => {
    authoredGeoms.set(node, node.geoms || []);
    node.geoms = resolveCsgGeoms(node, 'physics');
  });

  applyContactClasses(nodes, scene.simFidelity === 'print');
  // A body's own mass or density, handed to the geoms that are emitted (see
  // utils/bodyMass): MJCF has nowhere to put it on the body itself.
  eachNode(nodes, (node) => {
    node.geoms = applyBodyMass(node, node.geoms || [], authoredGeoms.get(node) ?? node.geoms ?? []);
  });

  // The viewport finds each body and geom by its name, so a clash would bind
  // the lookups for both to whichever MuJoCo registered first. Renamed by the
  // same rule the store applies to the graph, so the two agree (see
  // utils/uniqueNames); this pass only finds anything new when a boolean's
  // generated geoms clash, since the graph pass ran on the scene handed in.
  uniquifyNamesInPlace(nodes);
  // A scene handed straight to the compiler has not been through the store,
  // and one constraint naming a missing body fails the whole model.
  dropDanglingReferencesInPlace(nodes);

  // Members that break under load become two welded halves, and join blobs
  // weld whatever reaches into them. After the names are final, since the
  // halves and the welds are named from them. See utils/breakModel.ts.
  const breaks = buildBreakModel(nodes);

  // Before mesh-asset collection: a wedge is rewritten into a mesh geom here,
  // and that mesh still needs to land in the <asset> block.
  eachNode(nodes, (node) => {
    if (!node.isWedge || !node.geoms?.length) return;
    // Collide as the solid triangular prism the user actually sees, not as a
    // thin plate along the slanted face. The top face lands in the same plane
    // either way, so ramps behave as before while the wedge now has real
    // volume to rest and tip on.
    const { vertices, faces, renderVertices } = getCachedWedgeMeshData(node.width || 2.0, node.depth || 1.0, node.height || 0.5);
    const g = node.geoms[0];
    g.type = 'mesh';
    g.vertices = vertices;
    g.faces = faces;
    g.renderVertices = renderVertices;
  });

  return { nodes, breaks };
}
