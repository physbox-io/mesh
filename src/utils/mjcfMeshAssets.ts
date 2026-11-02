import type { SceneGeom, SceneNode } from '../types/scene';
import { analyzeMesh } from './meshIntegrity';
import { checkMeshInertia } from './meshInertiaCheck';
import { encodeMsh, mshFileName, type MeshFileSink } from './meshVfs';
import { PairMemo } from './arrayMemo';
import { flatMesh } from './mjcfFlatMesh';
import { xmlAttr } from './xmlAttr';

/*
 * Per-mesh work kept across rebuilds. Every build used to re-encode every mesh
 * to .msh bytes and hash them — only to arrive at a file name the worker
 * already held — and run a full integrity analysis for its inertia attribute,
 * for every mesh in the scene, on every edit however small. Keyed on the
 * arrays themselves; see utils/arrayMemo. The bytes are not kept: they are
 * transferred to the worker, which detaches them.
 */
const meshFileNames = new PairMemo<string>();
const meshInertiaAttrs = new PairMemo<string>();

/** Every mesh geom MuJoCo can hull, in scene order: the ones that need an asset. */
export function collectMeshAssets(nodes: SceneNode[]): SceneGeom[] {
  const out: SceneGeom[] = [];
  const walk = (list: SceneNode[]) => {
    if (!list) return;
    for (const node of list) {
      for (const g of node.geoms || []) {
        // MuJoCo refuses a mesh asset it cannot hull — empty, flat, or a line
        // — so those are left out; buildGeom emits a box or a speck instead.
        if (g.type === 'mesh' && g.vertices?.length && g.faces?.length && !flatMesh(g.vertices)) {
          out.push(g);
        }
      }
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

// Vertices stored in Three.js Y-up space (X=right, Y=up, Z=depth).
// MuJoCo is Z-up: rotate (x,y,z) -> (x,-z,y), which keeps the winding (a
// plain Y/Z swap would mirror it).
const toMjcfVerts = (verts: number[]) => {
  const out: number[] = [];
  for (let i = 0; i < verts.length; i += 3) {
    out.push(verts[i], -verts[i + 2], verts[i + 1]);
  }
  return out;
};

/*
 * How heavy a mesh is, and where its weight sits.
 *
 * MuJoCo's default for a mesh is `inertia="legacy"`: mass and inertia come
 * from the mesh's CONVEX HULL, not from the mesh. For a box, a bracket or a
 * building that is the same answer either way. For anything that encloses
 * mostly air it is not: the oak tree preset is a few cubic metres of timber
 * inside a hull the size of its crown, so the hull gave it a mass of 274
 * TONNES and a centre of mass 3.7m up, in mid-air between the branches. Make
 * it movable and it behaved like a top-heavy dome of water rather than like
 * a tree — a 3 m/s nudge toppled it.
 *
 * `inertia="exact"` integrates the real volume instead, which is what makes
 * a tree weigh what a tree weighs and a building weigh what a building
 * weighs, without either of them having to say so. It is only valid on a
 * closed mesh, though, and on an inside-out one it would come out negative,
 * so it is asked for only where the mesh has been checked and earns it;
 * everything else keeps the hull behaviour it has always had.
 */
const meshInertia = (g: SceneGeom): string => {
  // A derived collider is a convex hull by construction — closed, wound
  // outward, positive volume — so the exact integral and the hull agree and
  // the answer is known without computing it. Worth short-circuiting: this
  // runs per mesh per rebuild, and a decomposed body has up to 24 of them.
  if (g.csgDerived === 'collider') return ' inertia="exact"';
  const verts = g.renderVertices || g.vertices!;
  return meshInertiaAttrs.get(verts, g.faces!, () => {
    const integrity = analyzeMesh(verts, g.faces!);
    // Closed and wound outward is not enough: a surface folded through
    // itself is both, and its exact inertia can come out non-positive,
    // which MuJoCo refuses for the whole scene. Such a mesh keeps the hull.
    return integrity && integrity.closed && integrity.consistentlyWound && integrity.volume > 0
      && checkMeshInertia(verts, g.faces!).ok
      ? ' inertia="exact"'
      : '';
  });
};

/*
 * A convex piece goes to MuJoCo as its points alone, and MuJoCo hulls them.
 * Its faces are V-HACD's (or our hull's after rounding), and one piece in
 * a painted cat came back with two faces wound against each other: MuJoCo
 * refused the mesh for "inconsistent orientation", and with it every build
 * of the scene until the body was decomposed again. A hull MuJoCo makes
 * for itself cannot be wound wrong, and it hulls every mesh for contact
 * anyway.
 */
const NO_FACES: number[] = [];

const meshAsset = (g: SceneGeom, sink: MeshFileSink | undefined): string => {
  const hull = g.maxHullVert !== undefined ? ` maxhullvert="${g.maxHullVert}"` : '';
  const faces = g.csgDerived === 'collider' ? NO_FACES : g.faces!;
  if (sink) {
    const encoded: { bytes?: Uint8Array } = {};
    const file = meshFileNames.get(g.vertices!, faces, () => {
      encoded.bytes = encodeMsh(toMjcfVerts(g.vertices!), faces);
      return mshFileName(encoded.bytes);
    });
    if (sink.useFile(file, !!g.stableMesh)) {
      // Encoded only if the worker does not have it already.
      if (!sink.holds?.(file)) sink.files.set(file, encoded.bytes ?? encodeMsh(toMjcfVerts(g.vertices!), faces));
      return `    <mesh name="${xmlAttr(g.name)}"${meshInertia(g)}${hull} file="${file}" />`;
    }
  }
  const verts = toMjcfVerts(g.vertices!);
  const face = faces.length ? ` face="${faces.join(' ')}"` : '';
  return `    <mesh name="${xmlAttr(g.name)}"${meshInertia(g)}${hull} vertex="${verts.join(' ')}"${face} />`;
};

/**
 * The `<asset>` block for these meshes (empty when there are none), each as
 * inline vertex text or, where the sink says so, as a binary file in the
 * worker's VFS (utils/meshVfs.ts).
 */
export function meshAssetsXml(meshes: SceneGeom[], sink: MeshFileSink | undefined): string {
  sink?.begin();
  return meshes.length > 0
    ? `\n  <asset>\n${meshes.map((g) => meshAsset(g, sink)).join('\n')}\n  </asset>`
    : '';
}
