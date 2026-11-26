// Keeps every boolean-modifier body's generated mesh in step with its
// primitives.
//
// A CSG body stores a hash of the inputs its derived geoms were built from
// (node.csgHash). Any edit that changes the boolean — a size slider, moving the
// negative shape, switching collision mode — changes the hash, and this is what
// notices and recompiles. Debounced a little, so a dragging slider settles
// before its boolean is evaluated — a short wait now that the engine is
// Manifold and a typical cut evaluates in tens of milliseconds.
//
// The same walk also builds nodes carrying raw OpenSCAD source that have never
// been compiled — a preset or an MCP-created body arrives with `scad` text and
// an empty mesh, and without this it renders as nothing until someone happens to
// press Compile. Only a *missing* mesh triggers it; editing the source still
// applies on the Compile button, as before.
//
// The same walk is exported for headless/MCP flows, which need to AWAIT the
// compile rather than let an effect catch up later.

import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { recompilesInFlight } from '../store/simulationActions';
import { csgHashOf, evaluateNodeCsg, hasBooleanOps } from '../utils/csg';
import { collidersAreStale, collisionHashOf, decomposeNodeColliders, type HfieldNodeContext } from '../utils/convexDecomposition';
import { authoredQuat } from '../utils/bodyOrientation';
import { isNodeRotationBaked } from '../utils/sceneTree';
import type { SceneGraph, SceneNode } from '../types/scene';
import { bodyEdges, bodyUp } from '../utils/edgeRoundBase';
import { keepFoundEdges } from '../utils/edgeRound';
import { findNodeById } from '../utils/sceneTree';
import { describeLoadFailure } from '../utils/staleBuild';
import { bodyFormKey, finishBodyFormGeoms, needsBodyFormBuild } from '../utils/cloth/bodyFormEdit';

const COMPILE_DEBOUNCE_MS = 100;

function collectStale(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (node.csgEnabled && hasBooleanOps(node) && csgHashOf(node) !== node.csgHash) out.push(node);
    collectStale(node.children || [], out);
  }
  return out;
}

// Source that failed to compile, so a broken body isn't retried on every scene
// change. Keyed by the source itself: editing it arms the retry again.
const failedScad = new Set<string>();
const scadInFlight = new Map<string, { scad: string; done: Promise<boolean> }>();

function runScadBuild(nodeId: string, scad: string): Promise<boolean> {
  const existing = scadInFlight.get(nodeId);
  if (existing && existing.scad === scad) return existing.done;
  const done: Promise<boolean> = (async () => {
    const { compileSCAD } = await import('../utils/openscad');
    try {
      const compiled = await compileSCAD(scad);
      if (!compiled.faces || compiled.faces.length === 0) {
        failedScad.add(scad);
        console.error(`OpenSCAD compilation produced empty geometry for ${nodeId}.`);
        return false;
      }
      const now = findNodeById(useStore.getState().sceneGraph.nodes, nodeId);
      if (now && now.scad === scad && needsScadBuild(now)) {
        useStore.getState().updateNodeScad(nodeId, scad, compiled, true);
        return true;
      }
      return false;
    } catch (err) {
      failedScad.add(scad);
      console.error(`OpenSCAD compilation failed for ${nodeId}:`, err);
      return false;
    }
  })().finally(() => {
    if (scadInFlight.get(nodeId)?.done === done) scadInFlight.delete(nodeId);
  });
  scadInFlight.set(nodeId, { scad, done });
  return done;
}

/**
 * True for a body carrying OpenSCAD source that has never been built into a
 * mesh. Deliberately not a content hash: editing the source still applies on the
 * Compile button, and only an absent mesh triggers an automatic build.
 */
export function needsScadBuild(node: SceneNode): boolean {
  const scad = node.scad;
  if (scad === undefined || scad.trim() === '') return false;
  const mesh = (node.geoms || []).find((g) => g.type === 'mesh');
  return !mesh || !mesh.faces || mesh.faces.length === 0;
}

/**
 * Bodies whose convex colliders no longer match their mesh.
 *
 * Skips csgEnabled nodes deliberately: a boolean body's colliders are produced
 * by evaluateNodeCsg, in the same pass that builds its mesh. Two producers
 * writing colliders to one node would fight over them every compile.
 *
 * Also skips dress forms unless convex decomposition was explicitly requested
 * (`collision === 'decompose'`): cloth collides against exact form SDFs, so
 * decomposing 40 form meshes into ~600 convex pieces wasted seconds of WASM CPU.
 */
const shouldDecomposeBodyForm = (node: SceneNode) => !node.bodyForm || node.collision === 'decompose';

function collectStaleColliders(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (!node.csgEnabled && shouldDecomposeBodyForm(node) && collidersAreStale(node)) out.push(node);
    collectStaleColliders(node.children || [], out);
  }
  return out;
}

/**
 * Brickwork bodies with no bricks yet: a preset or an MCP-built body arrives
 * as its source (SceneNode.brickwork) and is laid here, in the brickwork
 * worker. Keyed by the source, as SCAD is: a failure is not retried until the
 * source changes.
 */
const failedBrickwork = new Set<string>();
const brickworkKey = (node: SceneNode) => JSON.stringify(node.brickwork);
export function needsBrickworkBuild(node: SceneNode): boolean {
  return !!node.brickwork && !(node.geoms?.length) && !failedBrickwork.has(brickworkKey(node));
}
function collectUnbuiltBrickwork(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (needsBrickworkBuild(node)) out.push(node);
    collectUnbuiltBrickwork(node.children || [], out);
  }
  return out;
}

/**
 * Body forms whose geoms were built from other measurements (a slider moved,
 * an MCP update, a body arriving as measurements alone). Built in the body
 * form worker; the old geoms stay until the new ones land, so a garment on
 * the form is not dropped meanwhile. Coalesced to at most one in-flight worker
 * build per node id (re-running on completion if measurements moved on while
 * it ran), and installed via `applyBodyFormGeoms` so background builds never
 * dirty clean scenes or clobber `redoStack` after Undo.
 */
const failedBodyForms = new Set<string>();
const bodyFormsInFlight = new Map<string, { key: string; done: Promise<void> }>();
const bodyFormJob = (id: string, key: string) => `${id}|${key}`;

function collectStaleBodyForms(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (needsBodyFormBuild(node)) {
      const key = bodyFormKey(node);
      const running = bodyFormsInFlight.get(node.id);
      if (!failedBodyForms.has(bodyFormJob(node.id, key)) && (!running || running.key !== key)) {
        out.push(node);
      }
    }
    collectStaleBodyForms(node.children || [], out);
  }
  return out;
}

function runBodyFormBuild(nodeId: string, skipRecompile = false): Promise<void> {
  const existing = bodyFormsInFlight.get(nodeId);
  if (existing) return existing.done;
  const entry: { key: string; done: Promise<void> } = { key: '', done: Promise.resolve() };
  entry.done = (async () => {
    const { buildBodyFormOffThread } = await import('../utils/cloth/bodyFormClient');
    while (true) {
      const cur = findNodeById(useStore.getState().sceneGraph.nodes, nodeId);
      if (!cur || !cur.bodyForm || !needsBodyFormBuild(cur)) break;
      const key = bodyFormKey(cur);
      const job = bodyFormJob(nodeId, key);
      if (failedBodyForms.has(job)) break;
      entry.key = key;
      try {
        const geoms = await buildBodyFormOffThread(cur.bodyForm, cur.name || cur.id, nodeId);
        const now = findNodeById(useStore.getState().sceneGraph.nodes, nodeId);
        if (now && now.bodyForm && bodyFormKey(now) === key) {
          useStore.getState().applyBodyFormGeoms(nodeId, finishBodyFormGeoms(geoms, now.bodyForm.skinTone), key, skipRecompile);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/supersed|abort|cancel/i.test(msg)) {
          const now = findNodeById(useStore.getState().sceneGraph.nodes, nodeId);
          if (now && bodyFormKey(now) === key) failedBodyForms.add(job);
          console.error(`Building the body form failed for ${nodeId}:`, err);
        }
        break;
      }
    }
  })().finally(() => {
    if (bodyFormsInFlight.get(nodeId) === entry) bodyFormsInFlight.delete(nodeId);
  });
  bodyFormsInFlight.set(nodeId, entry);
  return entry.done;
}

async function buildBodyForms(stale: SceneNode[], skipRecompile = false): Promise<void> {
  if (stale.length === 0) return;
  const uniqueIds = [...new Set(stale.map((n) => n.id))];
  await Promise.all(uniqueIds.map((id) => runBodyFormBuild(id, skipRecompile)));
}

function collectUnbuiltScad(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (needsScadBuild(node) && !failedScad.has(node.scad!)) out.push(node);
    collectUnbuiltScad(node.children || [], out);
  }
  return out;
}

/**
 * Decompositions running now, by body id, with the collisionHash each is for.
 *
 * A pass used to decompose every stale body whether or not another pass was
 * already on it. The first body to land changed the scene, the effect
 * scheduled a second pass, and every body still being decomposed was still
 * stale, so it was decomposed again — and whichever run finished LAST was
 * installed, because both carried the right hash. Four nesting bowls ran with
 * pieces named bowl1_csg_col55 and then settled at 15 pieces with their
 * cavities filled: the second run's finer retry had timed out in the queue.
 */
const collidersInFlight = new Map<string, { hash: string; done: Promise<void> }>();

/** Ids of the bodies whose convex pieces are being worked out right now. */
export function collidersBeingDecomposed(): string[] {
  return [...collidersInFlight.keys()];
}

/**
 * Names of the bodies whose convex pieces are not in yet: stale (queued) or
 * in flight. In flight as well, because a body whose pieces are being worked
 * out again joins the run already going and is not stale twice.
 */
export function pendingColliderBodies(): string[] {
  const out: string[] = [];
  const running = new Set(collidersInFlight.keys());
  const walk = (nodes: SceneNode[] = []) => nodes.forEach(n => {
    if ((!n.csgEnabled && shouldDecomposeBodyForm(n) && collidersAreStale(n)) || running.has(n.id)) out.push(n.name);
    walk(n.children);
  });
  walk(useStore.getState().sceneGraph.nodes);
  return out;
}

/**
 * Whether any of these bodies, as they stood before their decomposition, has or
 * had convex pieces. Most meshes turn out convex enough to need none: that
 * outcome is a note on the node, nothing the compiler reads, and rebuilding for
 * it replaced the model with an identical one, seconds after a scene appeared.
 */
function colliderPiecesChanged(before: SceneNode[]): boolean {
  const hasPieces = (n: SceneNode | null | undefined) => !!n?.geoms?.some((g) => g.csgDerived === 'collider');
  const nodes = useStore.getState().sceneGraph.nodes;
  return before.some((n) => hasPieces(n) || hasPieces(findNodeById(nodes, n.id)));
}

/** Computes static/world-pose context for a node from the scene tree. */
function hfieldContextFor(nodes: SceneNode[], targetId: string): HfieldNodeContext | undefined {
  const mulQuat = (a: readonly number[], b: readonly number[]): [number, number, number, number] => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
  const rotVec = (q: readonly number[], v: readonly number[]): [number, number, number] => {
    const [w, x, y, z] = q;
    const vx = v[0] ?? 0, vy = v[1] ?? 0, vz = v[2] ?? 0;
    const cx = y * vz - z * vy, cy = z * vx - x * vz, cz = x * vy - y * vx;
    const dx = y * cz - z * cy, dy = z * cx - x * cz, dz = x * cy - y * cx;
    return [vx + 2 * (w * cx + dx), vy + 2 * (w * cy + dy), vz + 2 * (w * cz + dz)];
  };
  const walk = (
    list: SceneNode[],
    ancestorMoving: boolean,
    parentPos: [number, number, number],
    parentQuat: [number, number, number, number],
  ): HfieldNodeContext | undefined => {
    for (const n of list || []) {
      const moving = ancestorMoving || (n.joints?.length ?? 0) > 0;
      const offset = rotVec(parentQuat, n.pos ?? [0, 0, 0]);
      const worldPos: [number, number, number] = [
        parentPos[0] + offset[0],
        parentPos[1] + offset[1],
        parentPos[2] + offset[2],
      ];
      const localQuat = isNodeRotationBaked(n) ? ([1, 0, 0, 0] as const) : authoredQuat(n);
      const worldQuat = mulQuat(parentQuat, localQuat);
      if (n.id === targetId) return { isStatic: !moving, worldPos, worldQuat };
      const found = walk(n.children || [], moving, worldPos, worldQuat);
      if (found) return found;
    }
    return undefined;
  };
  return walk(nodes, false, [0, 0, 0], [1, 0, 0, 0]);
}

/** One decomposition per body and hash: a second ask joins the first. */
function decomposeColliders(node: SceneNode): Promise<void> {
  const hash = collisionHashOf(node);
  const running = collidersInFlight.get(node.id);
  if (running && running.hash === hash) return running.done;
  const ctx = hfieldContextFor(useStore.getState().sceneGraph.nodes, node.id);
  const done: Promise<void> = (async () => {
    try {
      const result = await decomposeNodeColliders(node, ctx);
      if (result) useStore.getState().applyNodeColliders(node.id, result, true);
    } catch (err) {
      const message = await describeLoadFailure(err instanceof Error ? err.message : String(err));
      console.error(`Convex decomposition failed for ${node.id}:`, err);
      useStore.getState().setNodeCollisionError(node.id, message, hash);
    }
  })().finally(() => {
    if (collidersInFlight.get(node.id)?.done === done) collidersInFlight.delete(node.id);
  });
  collidersInFlight.set(node.id, { hash, done });
  return done;
}

/**
 * Recompiles every boolean body whose mesh is out of date. Reads the scene from
 * the store at call time (not from a captured copy) so it can't install geoms
 * derived from primitives the user has since changed.
 *
 * Returns the number of bodies compiled. Errors are recorded on the node
 * (csgError) rather than thrown — one broken shape shouldn't stop the others.
 *
 * `colliderWaitMs` is for a caller with a deadline of its own: past it, the
 * pass returns without the convex pieces still being worked out, and they
 * install, and rebuild the model, when they land.
 */
export async function compileCsgNodes(
  skipFinalRecompile = false,
  /**
   * colliders false: build booleans and SCAD, and leave convex decomposition
   * to the background compiler (scheduleCsgCompile). V-HACD on a concave part
   * takes seconds and its worker runs one job at a time, so a caller that only
   * added a body waited on every stale body in the scene: the fourth
   * physics_create_lattice of a burst timed out at 60 s with its body made.
   */
  opts: { colliders?: boolean; colliderWaitMs?: number } = {},
): Promise<number> {
  const colliders = opts.colliders ?? true;
  const scene = useStore.getState().sceneGraph;
  const initialStale = collectStale(scene.nodes);
  const unbuilt = collectUnbuiltScad(scene.nodes);
  const unlaid = collectUnbuiltBrickwork(scene.nodes);
  const staleForms = collectStaleBodyForms(scene.nodes);
  await buildBodyForms(staleForms, true);
  let meshesChanged = staleForms.length > 0;
  if (initialStale.length === 0 && unbuilt.length === 0 && unlaid.length === 0 && (!colliders || collectStaleColliders(useStore.getState().sceneGraph.nodes).length === 0)) {
    if (!colliders && collectStaleColliders(useStore.getState().sceneGraph.nodes).length > 0) scheduleCsgCompile();
    if (!skipFinalRecompile && meshesChanged) {
      await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false);
    }
    return staleForms.length;
  }
  if (unlaid.length > 0) {
    const { layBrickworkSourceOffThread } = await import('../utils/brickworkClient');
    await Promise.all(unlaid.map(async (node) => {
      try {
        const geoms = await layBrickworkSourceOffThread(node.brickwork!, node.id);
        // Laid from the source it still has: if that changed meanwhile, the next pass lays the new one.
        const now = findNodeById(useStore.getState().sceneGraph.nodes, node.id);
        if (now && brickworkKey(now) === brickworkKey(node) && !now.geoms?.length) {
          useStore.getState().updateNode(node.id, { geoms }, true);
          meshesChanged = true;
        }
      } catch (err) {
        failedBrickwork.add(brickworkKey(node));
        console.error(`Laying the bricks failed for ${node.id}:`, err);
      }
    }));
  }

  if (unbuilt.length > 0) {
    const builtFlags = await Promise.all(unbuilt.map((node) => runScadBuild(node.id, node.scad!)));
    if (builtFlags.some(Boolean)) meshesChanged = true;
  }

  // Re-collect stale boolean bodies after SCAD/brickwork/bodyForm geoms have
  // landed, so a node with both unbuilt `scad` and `csgEnabled` evaluates its
  // boolean against the freshly installed base mesh rather than an empty node.
  const stale = collectStale(useStore.getState().sceneGraph.nodes);

  await Promise.all(stale.map(async staleNode => {
    let node = staleNode;
    const hash = csgHashOf(node);
    try {
      // Roundings are stored as the edges they were put on. When the shape
      // under them changes in a way nothing mapped — an OpenSCAD source edited,
      // a hole moved — some of those edges are simply not there any more, and
      // rounding them anyway would cut where an edge used to be. So they are
      // checked against the part as it now is, and the lost ones dropped.
      if (node.edgeRounds?.length) {
        const nodes = useStore.getState().sceneGraph.nodes;
        const found = await bodyEdges(node, bodyUp(nodes, node.id));
        const { features, lost } = keepFoundEdges(node.edgeRounds, found.edges.map((c) => c.edge));
        if (lost > 0) {
          useStore.getState().dropLostEdgeRounds(node.id, features, lost);
          meshesChanged = true;
          node = findNodeById(useStore.getState().sceneGraph.nodes, node.id) ?? node;
          if (csgHashOf(node) === node.csgHash) return;
        }
      }
      const result = await evaluateNodeCsg(node);
      // skipRecompile: one build at the end, so several boolean bodies in a
      // scene can't race overlapping MJCF/WASM builds against each other.
      if (result) {
        const beforeGraph = useStore.getState().sceneGraph;
        useStore.getState().applyNodeCsg(node.id, result, true);
        if (useStore.getState().sceneGraph !== beforeGraph) meshesChanged = true;
      }
    } catch (err) {
      const message = await describeLoadFailure(err instanceof Error ? err.message : String(err));
      console.error(`CSG evaluation failed for ${node.id}:`, err);
      useStore.getState().setNodeCsgError(node.id, message, hash);
    }
  }));

  // Re-read the scene rather than reuse the copy above: a boolean body's mesh
  // was just installed by applyNodeCsg, and a body whose mesh changed in this
  // same pass has to be decomposed from what it is NOW, not from what it was.
  const allStaleColliders = collectStaleColliders(useStore.getState().sceneGraph.nodes);
  const staleColliders = colliders ? allStaleColliders : [];
  if (!colliders && allStaleColliders.length > 0) scheduleCsgCompile();
  const decomposed = Promise.all(staleColliders.map(decomposeColliders));
  if (opts.colliderWaitMs === undefined) {
    await decomposed;
  } else {
    let late = true;
    await Promise.race([
      decomposed.then(() => { late = false; }),
      new Promise((r) => setTimeout(r, opts.colliderWaitMs)),
    ]);
    if (late) {
      decomposed
        .then(() => { if (colliderPiecesChanged(staleColliders)) return useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false); })
        .catch((err) => console.error('Rebuilding after late convex pieces failed:', err));
    }
  }

  if (!skipFinalRecompile && (meshesChanged || colliderPiecesChanged(staleColliders))) {
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false);
  }
  return stale.length + unbuilt.length + unlaid.length + staleForms.length + staleColliders.length;
}

/**
 * One queued run at a time, and a new scene change does not push it back.
 *
 * This used to be a plain debounce: every scene change cleared the timer and
 * started it again. A scene that is written more often than the debounce —
 * anything that rewrites the graph on a stream of events — then never let it
 * fire, and a boolean edit (or an undo, which restores a stale boolean mesh
 * and leaves the rebuild to this) never built. A run reads the scene when it
 * FIRES, so one run picks up every change queued behind it, and anything
 * still stale when it finishes is caught by the next scene change.
 */
let queuedRun: ReturnType<typeof setTimeout> | null = null;

export function scheduleCsgCompile(): void {
  if (queuedRun) return;
  queuedRun = setTimeout(() => {
    queuedRun = null;
    compileCsgNodes().catch((err) => console.error('Automatic boolean compile failed:', err));
  }, COMPILE_DEBOUNCE_MS);
}

export function useCsgAutoCompile() {
  const sceneGraph = useStore(state => state.sceneGraph);

  useEffect(() => {
    if (collectStale(sceneGraph.nodes).length === 0 &&
        collectUnbuiltScad(sceneGraph.nodes).length === 0 &&
        collectUnbuiltBrickwork(sceneGraph.nodes).length === 0 &&
        (recompilesInFlight > 0 || collectStaleBodyForms(sceneGraph.nodes).length === 0) &&
        collectStaleColliders(sceneGraph.nodes).length === 0) return;
    scheduleCsgCompile();
  }, [sceneGraph]);
}

/**
 * Resolves stale or lazy (`geoms: []`) dress forms on a clone of `scene` off the
 * main thread before `recompile` compiles MJCF and settles cloth, without writing
 * `sceneGraph` early so the viewport never shows a re-posed mannequin detached
 * from its still-compiling garment.
 */
export async function resolveBodyFormsForBuild(scene: SceneGraph): Promise<SceneGraph> {
  const stale: SceneNode[] = [];
  const walk = (nodes: SceneNode[] | undefined) => {
    for (const n of nodes || []) {
      if (needsBodyFormBuild(n)) stale.push(n);
      walk(n.children);
    }
  };
  walk(scene.nodes);
  if (stale.length === 0) return scene;
  const { buildBodyFormOffThread } = await import('../utils/cloth/bodyFormClient');
  const builtById = new Map<string, { geoms: SceneNode['geoms']; key: string }>();
  await Promise.all(stale.map(async (node) => {
    const key = bodyFormKey(node);
    const job = bodyFormJob(node.id, key);
    if (failedBodyForms.has(job)) return;
    try {
      const raw = await buildBodyFormOffThread(node.bodyForm!, node.name || node.id, node.id);
      builtById.set(node.id, { geoms: finishBodyFormGeoms(raw, node.bodyForm!.skinTone), key });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/supersed|abort|cancel/i.test(msg)) {
        failedBodyForms.add(job);
        console.error(`Building the body form failed for ${node.id}:`, err);
      }
    }
  }));
  if (builtById.size === 0) return scene;
  const cloneNodes = (nodes: SceneNode[]): SceneNode[] =>
    nodes.map((n) => {
      const hit = builtById.get(n.id);
      const children = n.children?.length ? cloneNodes(n.children) : n.children;
      if (!hit && children === n.children) return n;
      return {
        ...n,
        ...(hit ? { geoms: hit.geoms, bodyFormBuilt: hit.key } : {}),
        children,
      };
    });
  return { ...scene, nodes: cloneNodes(scene.nodes) };
}
