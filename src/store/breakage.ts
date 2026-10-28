// ---------------------------------------------------------------------------
// Breakage during a run: shatter, dents, broken welds
//
// None of it is in the scene graph. The store keeps what broke, and the model
// is built from the graph with the pieces swapped in (applyShatterPieces).
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode } from '../types/scene';
import { dentDepth, dentSpread, pierceVerdict } from '../utils/breakThresholds';
import { deformedGeometry, dentKey, useDentStore } from './dentStore';
import type { Imprint } from '../utils/dentMesh';
import { estimateBodyMass } from '../utils/deformMaterials';
import { wallThicknessAt } from '../utils/wallThickness';
import { replaceNodeWith } from './sceneClone';
import type { PhysicsState } from './useStore';
import { store } from './storeRef';

/** A surface whose damage has been made real, ready to compile. */
export interface DeformedGeometry {
  vertices: number[];
  renderVertices: number[];
  faces: number[];
}

/**
 * Forget everything that has broken, dented or sheared in this run.
 *
 * None of it is in the scene graph, so a build after this emits exactly the
 * scene that was authored. Reset and loading a preset both start here.
 */
export const clearBreakage = (set: (patch: Partial<PhysicsState>) => void) => {
  useDentStore.getState().clear();
  breakageEpoch++;
  fracturing.clear();
  set({
    brokenConstraints: [], lastBreak: null,
    shatteredBodies: {}, visibleShatteredBodies: {}, lastShatter: null,
    deformedGeoms: {},
  });
};

/*
 * Bodies being cut in the fracture worker, and how many shards each has been
 * promised. A body that is still being cut is hit again several times before
 * its pieces land; without this every one of those blows would cut it again.
 * The pieces count towards the shard budget from the moment they are asked for.
 */
export const fracturing = new Map<string, number>();

/** Bumped whenever breakage is cleared, so a cut that lands after a reset is dropped. */
export let breakageEpoch = 0;

export const anyNode = (nodes: SceneNode[], test: (n: SceneNode) => boolean): boolean =>
  nodes.some((n) => test(n) || anyNode(n.children || [], test));

/**
 * Rebuild at once for the first break, and coalesce whatever follows.
 *
 * A cascade — a vase into a dozen pieces, several of which land together and
 * come apart again — produces a burst of breaks, and a model rebuild for each
 * would be hitching for a result identical to rebuilding once. So at most one
 * rebuild is in flight: a break that arrives while one is building is picked
 * up by a single follow-up as soon as it lands, because the substitutions are
 * already in the store by then.
 *
 * This used to be a fixed 120 ms timer. It was the wrong shape twice over. The
 * first break waited out the window for nothing, and the timer is only as good
 * as the main thread: while a struck scene is rendering and handling impacts
 * it fired 280 to 320 ms late (measured). All that while the old model went
 * on simulating the vase intact, so it was seen flying off whole before it
 * burst. The pieces are re-based onto where the body really is when the build
 * lands (see rebaseShard), so the delay no longer teleports anything, but it
 * still reads as a late break.
 *
 * A short gap after each build keeps a steady trickle of damage (an edge being
 * worn away, see commitDamage) from rebuilding back to back and starving the
 * simulation.
 */
const SHATTER_REBUILD_MIN_GAP_MS = 100;
let shatterRebuildInFlight = false;
let shatterRebuildQueued = false;
let shatterRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let shatterRebuildLastEnd = -Infinity;

const runShatterRebuild = (run: () => Promise<void> | void) => {
  shatterRebuildTimer = null;
  shatterRebuildInFlight = true;
  shatterRebuildQueued = false;
  // A microtask, not now: breaks delivered in the same task go in together.
  Promise.resolve().then(run).finally(() => {
    shatterRebuildInFlight = false;
    shatterRebuildLastEnd = performance.now();
    if (shatterRebuildQueued) scheduleShatterRebuild(run);
  });
};

export const scheduleShatterRebuild = (run: () => Promise<void> | void) => {
  if (shatterRebuildInFlight || shatterRebuildTimer !== null) {
    shatterRebuildQueued = true;
    return;
  }
  const wait = shatterRebuildLastEnd + SHATTER_REBUILD_MIN_GAP_MS - performance.now();
  if (wait > 0) shatterRebuildTimer = setTimeout(() => runShatterRebuild(run), wait);
  else runShatterRebuild(run);
};

/**
 * The scene as it currently IS: the document, with every shattered body swapped
 * for its pieces.
 *
 * Derived on demand rather than stored, so an edit to the document — moving a
 * body, resizing one, adding one — flows through while the wreckage is still on
 * screen. Returns the document itself, by reference, when nothing is broken, so
 * the ordinary case costs a property lookup.
 */
export const applyShatterPieces = (
  graph: SceneGraph,
  pieces: Record<string, SceneNode[]>,
  deformed: Record<string, DeformedGeometry> = {},
): SceneGraph => {
  const ids = Object.keys(pieces);
  const deformedKeys = Object.keys(deformed);
  if (ids.length === 0 && deformedKeys.length === 0) return graph;

  let nodes = graph.nodes;
  for (const id of ids) {
    nodes = detachReferencesTo(replaceNodeWith(nodes, id, pieces[id]), id);
  }
  if (deformedKeys.length > 0) nodes = applyDeformed(nodes, deformed);
  return { ...graph, nodes };
};

/**
 * Swap in the deformed geometry for any surface that asked for it to be real.
 *
 * The node is also switched to `decompose`, and that is not an optimisation to
 * be skipped for small damage: MuJoCo collides a mesh as its CONVEX HULL, and
 * every kind of damage here is a concavity. A hull fills a hole straight back
 * in, and it ignores a crater completely — so committing the deformed vertices
 * without decomposing gives a plate that looks worn and collides exactly as it
 * did when new, which is the appearance of the feature with none of it.
 *
 * Decomposing is therefore what `deformCollision` really costs, and it is why
 * it is a choice rather than the default: V-HACD runs over the surface again
 * every time the surface changes.
 */
const applyDeformed = (
  nodes: SceneNode[],
  deformed: Record<string, DeformedGeometry>,
): SceneNode[] => {
  if (!nodes || nodes.length === 0) return nodes;
  let anyChanged = false;
  const out = nodes.map((n) => {
    const children = applyDeformed(n.children || [], deformed);
    let geoms = n.geoms;
    let damaged = false;
    if (n.geoms?.length) {
      const next = n.geoms.map((g) => {
        const d = deformed[`${n.id}/${g.name}`];
        if (!d) return g;
        damaged = true;
        return { ...g, type: 'mesh' as const, vertices: d.vertices, renderVertices: d.renderVertices, faces: d.faces };
      });
      if (damaged) geoms = next;
    }
    // Untouched nodes come back BY REFERENCE. The whole scene is walked on
    // every build, and a fresh object for each undamaged body would make every
    // memo and every identity check downstream miss — including the renderer's.
    if (!damaged && children === (n.children || children)) return n;
    anyChanged = true;
    return { ...n, geoms, children, ...(damaged ? { collision: 'decompose' as const } : {}) };
  });
  return anyChanged ? out : nodes;
};

/** The same, as a selector over the store's own fields. */
export const effectiveSceneGraph = applyShatterPieces;

/**
 * Cut every constraint that pointed at a body which no longer exists.
 *
 * A weld names its target by id, and `mjcf.ts` writes that id straight into
 * `<weld body2="...">`. Shatter a vase with handles welded to it and the
 * handles are left naming a body that is now fourteen shards — MuJoCo rejects
 * the model outright and the whole scene stops compiling, which looks like the
 * shatter having crashed rather than like a dangling reference.
 *
 * Physically it is the right answer anyway: whatever the handle was fixed to
 * has stopped being a thing, so the handle comes off.
 */
export const detachReferencesTo = (nodes: SceneNode[], goneId: string): SceneNode[] =>
  (nodes || []).map((n) => {
    const children = detachReferencesTo(n.children || [], goneId);
    const severed =
      n.weldTargetId === goneId || n.connectTargetId === goneId || n.coupleTargetId === goneId;
    if (!severed && children === n.children) return n;
    const next: SceneNode = { ...n, children };
    if (next.weldTargetId === goneId) { delete next.weldTargetId; delete next.weldRigid; }
    if (next.connectTargetId === goneId) { delete next.connectTargetId; delete next.connectAnchor; delete next.connectAnchorLocal; }
    if (next.coupleTargetId === goneId) { delete next.coupleTargetId; delete next.coupleRatio; }
    return next;
  });

/**
 * Move every weld and connect that named `fromId` onto `toId`.
 *
 * Combine folds a body into another and removes it, and what was fixed to it
 * is fixed to the merged part now — the shape it was welded to is still there,
 * it just belongs to a different body. Left alone the weld names a body that
 * no longer exists and MuJoCo refuses the whole model. A weld that would now
 * join `toId` to itself is cut, and a gear coupling is cut rather than moved,
 * since it names the old body's joint, not its shape.
 */
export const retargetReferences = (nodes: SceneNode[], fromId: string, toId: string): SceneNode[] => {
  const move = (list: SceneNode[]): SceneNode[] => (list || []).map((n) => {
    const children = move(n.children || []);
    const moves = (n.weldTargetId === fromId || n.connectTargetId === fromId) && n.id !== toId;
    if (!moves && children === n.children) return n;
    const next: SceneNode = { ...n, children };
    if (n.id !== toId) {
      if (next.weldTargetId === fromId) next.weldTargetId = toId;
      if (next.connectTargetId === fromId) next.connectTargetId = toId;
    }
    return next;
  });
  // Whatever still names it is the target's own weld to it, or a coupling.
  return detachReferencesTo(move(nodes), fromId);
};

/**
 * How thick this body is where it was hit, in metres; null when it has no
 * closed mesh to measure. `localPoint` is in the body frame, which is the frame
 * renderVertices are in (Z-up, centroid at the origin).
 */
export const wallAtImpact = (node: SceneNode, localPoint: ArrayLike<number>): number | null => {
  const geom = (node.geoms || []).find((g) => (g.renderVertices ?? g.vertices) && g.faces);
  const verts = geom && (geom.renderVertices ?? geom.vertices);
  if (!geom || !verts || !geom.faces) return null;
  return wallThicknessAt(verts, geom.faces, [localPoint[0], localPoint[1], localPoint[2]]);
};

/**
 * What a body weighs, so its pieces can be given shares of it.
 *
 * A stated mass where there is one, otherwise volume times density — so a body
 * given a material weighs the same in pieces as it did whole. Falls back to a
 * kilogram rather than to nothing: shards with no mass at all are ignored by
 * the solver and simply hang in the air.
 */
export const bodyMassOf = (node: SceneNode): number => {
  const total = estimateBodyMass(node);
  return total > 0 ? total : 1;
};

/**
 * A dent radius for a geom that did not name one: a sixth of the longest side.
 *
 * Scale-relative, because the same absolute radius that craters a 60 mm plate
 * would be invisible on a 2 m one.
 */
const dentBounds = (verts: ArrayLike<number>): [number, number, number] => {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < verts.length; i += 3) {
    if (verts[i] < minX) minX = verts[i]; if (verts[i] > maxX) maxX = verts[i];
    if (verts[i + 1] < minY) minY = verts[i + 1]; if (verts[i + 1] > maxY) maxY = verts[i + 1];
    if (verts[i + 2] < minZ) minZ = verts[i + 2]; if (verts[i + 2] > maxZ) maxZ = verts[i + 2];
  }
  return [maxX - minX, maxY - minY, maxZ - minZ];
};

const defaultDentRadius = (verts: ArrayLike<number>): number => {
  const span = Math.max(...dentBounds(verts));
  return Number.isFinite(span) && span > 0 ? span / 6 : 0.02;
};

/**
 * The widest a mark in this surface can sensibly be: half its middle dimension.
 *
 * Needed because the crater's width comes from the STRIKER, and a striker is
 * not always the smaller of the two. A rubber cylinder landing on a steel plate
 * dents itself, and the thing that dented it is the plate — whose imprint is
 * wider than the whole cylinder, so every vertex of it would be displaced by
 * very nearly the same amount. That is not a squashed cylinder, it is a
 * cylinder that has moved.
 *
 * The MIDDLE dimension rather than the smallest, because the smallest is a
 * sheet's thickness and would cap a plate's crater at a couple of millimetres;
 * and rather than the largest, which for a long thin thing is its length.
 */
const maxDentRadius = (verts: ArrayLike<number>): number => {
  const dims = dentBounds(verts).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (dims.length === 0) return 0.02;
  return dims[Math.min(1, dims.length - 1)] / 2;
};

/**
 * Make the damage to one surface real to the solver, if it asked for that.
 *
 * Reads back whatever the surface has accumulated — one crater or a hundred
 * small ones along an edge — rather than the single blow that just landed, so
 * wear builds up the way it looks like it does. The rebuild is coalesced,
 * because an edge being worn away is a steady trickle of impacts and each one
 * would otherwise compile the scene again.
 */
const commitDamage = (nodeId: string, geomName: string): void => {
  const geometry = deformedGeometry(dentKey(nodeId, geomName));
  if (!geometry) return;
  store().setState({
    deformedGeoms: {
      ...store().getState().deformedGeoms,
      [dentKey(nodeId, geomName)]: geometry,
    },
  });
  scheduleShatterRebuild(() => store().getState().recompile(undefined, undefined, false, true, false, true));
};

/**
 * Push a crater into every dentable surface of a body.
 *
 * A no-op on anything without a yield, which is every geom by default — so a
 * scene that never asked for this pays a property lookup per collision.
 */
export const dentBody = (
  node: SceneNode,
  point: number[],
  normal: number[],
  impulseNs: number,
  /** What hit it, so the crater is that shape and that width. */
  striker?: Imprint | null,
): void => {
  for (const geom of node.geoms || []) {
    const source = geom.renderVertices ?? geom.vertices;
    if (!source || !geom.faces) continue;

    // Piercing and denting are alternatives, not stages: there is nothing left
    // to crease where the material has gone.
    if (pierceVerdict(impulseNs, geom)) {
      useDentStore.getState().pierce(
        dentKey(node.id, geom.name),
        source, geom.faces,
        [point[0], point[1], point[2]],
        [normal[0], normal[1], normal[2]],
        Math.min(maxDentRadius(source), striker?.radius ?? geom.dentRadius ?? defaultDentRadius(source)),
      );
      if (geom.deformCollision) commitDamage(node.id, geom.name);
      continue;
    }

    const depth = dentDepth(impulseNs, geom);
    if (depth <= 0) continue;
    /*
     * The striker's own width decides the crater's, when it is known: a 38 mm
     * slug leaves a 38 mm mark, and scaling the slug scales the mark without
     * anybody editing a number. `dentRadius` on the struck geom is the fallback
     * for a blow with no identifiable striker — landing on the floor, say.
     */
    const cap = maxDentRadius(source);
    const base = Math.min(cap, striker?.radius ?? geom.dentRadius ?? defaultDentRadius(source));
    useDentStore.getState().dent(
      dentKey(node.id, geom.name),
      source, geom.faces,
      [point[0], point[1], point[2]],
      [normal[0], normal[1], normal[2]],
      depth,
      // Wider as well as deeper the harder it was hit — see dentSpread — but
      // never wider than the surface it is in.
      Math.min(cap, base * dentSpread(impulseNs, geom)),
      striker?.profile ?? 'dish',
    );
    if (geom.deformCollision) commitDamage(node.id, geom.name);
  }
};
