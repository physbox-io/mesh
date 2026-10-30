// ---------------------------------------------------------------------------
// What many MCP commands share: finding bodies, waiting for them, trimming
// the mesh arrays out of a reply, and the worker's status
// ---------------------------------------------------------------------------

import { useStore, type PhysicsState } from '../../store/useStore';
import type { NoteCard } from '../../utils/noteCards';
import type { SavedCopilotMessage } from '../../utils/userPresets';
import type { SceneNode } from '../../types/scene';
import { recompilesInFlight } from '../../store/simulationActions';
import { lastWorkerFrame, modelBuiltFrom } from '../../store/modelProvenance';
import { lastScriptStatus } from '../../store/scriptStatus';
import { describeWorker } from '../../utils/workerStatus';

export interface PhysicsWindow extends Window {
  _physics_setNoteCards?: (cards: NoteCard[]) => void;
  _physics_getNoteCards?: () => NoteCard[];
  _physics_setCopilotMessages?: (msgs: SavedCopilotMessage[]) => void;
  _physics_getCopilotMessages?: () => SavedCopilotMessage[];
  _physics_gl?: { domElement: HTMLCanvasElement; render: (scene: unknown, camera: unknown) => void };
  _physics_scene?: unknown;
  _physics_camera?: unknown;
  _physics_composer?: { render: () => void };
}

/**
 * The worker's side of the story for physics_get_state and physics_play. Pass
 * isPlaying false where a stall cannot have shown yet (just after starting).
 */
export function workerStatusNow(
  store: Pick<PhysicsState, 'sceneGraph' | 'model' | 'isPlaying'>,
  isPlaying = store.isPlaying,
) {
  const built = modelBuiltFrom();
  return describeWorker({
    graph: store.sceneGraph,
    hasModel: !!store.model,
    builtFrom: built.graph,
    builtAt: built.at,
    frame: lastWorkerFrame(),
    isPlaying,
    compiling: recompilesInFlight > 0,
    hidden: typeof document !== 'undefined' && document.hidden,
    now: Date.now(),
    scripts: lastScriptStatus(),
  });
}

/** How many bodies a scene tree holds, at any depth. */
export function countBodies(nodes: SceneNode[] | undefined): number {
  return (nodes || []).reduce((n, b) => n + 1 + countBodies(b.children), 0);
}

/** Every id in a scene tree, at any depth. */
export function collectNodeIds(nodes: SceneNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes || []) {
    into.add(node.id);
    collectNodeIds(node.children || [], into);
  }
  return into;
}

/**
 * Wait for a node that was not in `before` to appear anywhere in the scene.
 *
 * The store's add path ends in a debounced recompile rather than a synchronous
 * write, and there is no promise to await, so the arrival has to be observed.
 * Polling rather than subscribing keeps this to a few lines and costs nothing:
 * the wait is milliseconds in practice.
 */
export async function waitForNewNode(before: Set<string>, timeoutMs: number): Promise<SceneNode | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nodes = useStore.getState().sceneGraph.nodes;
    const found = findNewNode(nodes, before);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function findNewNode(nodes: SceneNode[], before: Set<string>): SceneNode | null {
  for (const node of nodes || []) {
    if (!before.has(node.id)) return node;
    const child = findNewNode(node.children || [], before);
    if (child) return child;
  }
  return null;
}

/**
 * A message with the fields one command's schema documents named at their
 * types. Everything else stays `unknown`, which is how it arrives: a message is
 * parsed JSON.
 *
 * This says what a command expects once, at the top of its case, instead of at
 * every use of every field. It asserts rather than checks, deliberately — each
 * handler already validates what it needs, and re-checking here would turn a
 * malformed field into a missing one, which is a different answer from the one
 * a caller gets today.
 */
export type Msg<T> = Record<string, unknown> & T;

/**
 * `at` as the list of points it stands for: one point, or a list of them.
 *
 * Only decides which of those two shapes was sent; whether the points are
 * points at all is the caller's own check, immediately below every use.
 */
export const pointList = (v: unknown): number[][] =>
  (Array.isArray(v) && Array.isArray(v[0]) ? v : [v]) as number[][];

/**
 * Where a new body asked to go under `parent` (an id or a name) lands: the
 * parent's real id, and whether it or anything above it has a joint. Throws
 * when there is no such body, rather than quietly adding at the top level.
 */
export const resolveParent = (nodes: SceneNode[], parent: unknown): { id: string; moves: boolean } | null => {
  if (parent === undefined || parent === null || parent === '') return null;
  if (typeof parent !== 'string') throw new Error('parent must be the id or name of an existing body');
  const walk = (list: SceneNode[], aboveMoves: boolean): { id: string; moves: boolean } | null => {
    for (const n of list || []) {
      const moves = aboveMoves || (n.joints?.length ?? 0) > 0 || n.isComposite === true;
      if (n.id === parent || n.name === parent) return { id: n.id, moves };
      const found = walk(n.children || [], moves);
      if (found) return found;
    }
    return null;
  };
  const found = walk(nodes, false);
  if (!found) throw new Error(`No body '${parent}' to put the new one under`);
  return found;
};

/** The scene with `child` appended to the children of `parentId`, copied along the path. */
export const withChild = (nodes: SceneNode[], parentId: string, child: SceneNode): SceneNode[] =>
  nodes.map((n) => n.id === parentId
    ? { ...n, children: [...(n.children || []), child] }
    : n.children?.length ? { ...n, children: withChild(n.children, parentId, child) } : n);

export const findNodeInScene = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const node of nodes || []) {
    if (node.id === id || node.name === id) return node;
    const child = findNodeInScene(node.children || [], id);
    if (child) return child;
  }
  return null;
};

// Lives with the other pure reply shapers, so it can be tested without the store.
export { stripMeshArrays } from '../../utils/objectReply';

// Shared by BUILD_SCENE and UPDATE_SCENE: fills in the fields compileToMJCF's
// buildNode() unconditionally calls .forEach on (joints, geoms, children).
// UPDATE_SCENE used to skip this and pass nodes straight through, so any
// hand-authored node missing one of those fields (e.g. a leaf body with no
// `children` at all) crashed recompile with a bare "Cannot read properties
// of undefined (reading 'forEach')" and no indication of which field or node
// was at fault.
// A mesh geom on a jointed body has to be dynamic:true or it renders from
// vertices baked once into world space and never reads data.xpos/data.xmat
// again — the body simulates and drags correctly, it just looks frozen in
// place on screen. That is exactly the trap californiaRelief.ts and
// megaBustStudio.ts fell into by hand-authoring mesh geoms without it, so an
// agent supplying a mesh geom on a jointed body gets it defaulted here rather
// than needing to know the field exists. renderVertices is auto-derived from
// vertices (Y-up -> MuJoCo Z-up: (x,y,z)->(x,-z,y)) when the caller hasn't
// supplied one, for the same reason: it's a pure function of vertices, not a
// real second thing to author.
export const toRenderVertices = (vertices: number[]): number[] => {
  const out = new Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = vertices[i];
    out[i + 1] = -vertices[i + 2];
    out[i + 2] = vertices[i + 1];
  }
  return out;
};

/**
 * How long physics_run_headless waits for convex pieces still being worked
 * out, queued or running. The bridge gives a whole command 60 s and the run
 * needs some of that; 45 s covers a four-body marble run (~40 s of pieces one
 * body after another), and a scene with more says so and can be run again.
 */
export const HEADLESS_WAIT_FOR_COLLIDERS_MS = 45_000;

// Bounding-box diagonal above this (in MuJoCo meters) on a freshly-compiled
// SCAD mesh almost always means the source forgot the required
// scale([0.001,0.001,0.001]) wrapper and compiled at millimeter scale by
// mistake (a 183x132x11mm part is ~0.2m across; the same part un-scaled
// is ~183m across) rather than an intentionally huge object.
export const SUSPICIOUSLY_LARGE_DIAGONAL_M = 20;

/**
 * This tab's name, for the hub's session list.
 *
 * sessionStorage, not localStorage: it is per-tab and dies with the tab, which
 * is exactly the lifetime wanted. It also survives a reload, so reloading the
 * page a person had selected does not silently hand the agent a different tab.
 *
 * The label is what a person reads in `list_sessions` when they have three of
 * these open and have to say which one to drive, so it carries the port and a
 * short id rather than just a uuid.
 */
/**
 * Bytes as base64, for handing a produced file back over the bridge.
 *
 * Chunked because String.fromCharCode is applied to the array and a megabyte of
 * arguments overflows the call stack. The MCP server writes these to disk and
 * never returns them to the agent, so size here costs transfer, not context.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The produced files, with or without the bytes.
 *
 * An agent asking what a part weighs and how long it takes to cut does not want
 * a megabyte of G-code, and when the MCP server has nowhere to put a file it
 * does not want it either. So the caller says whether it is going to keep them,
 * and when it is not the bytes are never encoded, never sent, and never sit in
 * a socket buffer — only the name and the size it would have been.
 */
export function describeFiles(files: { name: string; bytes: Uint8Array }[], include: boolean) {
  return files.map(f => include
    ? { name: f.name, bytes: f.bytes.byteLength, base64: bytesToBase64(f.bytes) }
    : { name: f.name, bytes: f.bytes.byteLength });
}
