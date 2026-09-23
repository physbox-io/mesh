/**
 * A sculpt stroke, from the store to the physics model and back.
 *
 * Every fault here was intermittent in the app — it depended on how soon Play
 * was pressed after a stroke, or on which of two builds finished first — which
 * is what made sculpting feel as though it sometimes worked and sometimes did
 * not. The store is driven headless against a fake worker client whose builds
 * can be held, released and failed on cue.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

interface BuildCall { xml: string; sceneGraph: unknown; preserveState: boolean }
const builds: BuildCall[] = [];
let buildBehaviour: (call: BuildCall) => Promise<unknown> = async () => ({ ok: true });

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build(xml: string, sceneGraph: unknown, preserveState: boolean) {
      const call = { xml, sceneGraph, preserveState };
      builds.push(call);
      return buildBehaviour(call);
    }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let resolveCsgGeoms: any;
let collidersAreStale: any;
let collisionHashOf: any;
let toSceneGeom: any;
let fromSceneGeom: any;
let applySculptStroke: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  ({ resolveCsgGeoms } = await import('../src/utils/csg'));
  ({ collidersAreStale, collisionHashOf } = await import('../src/utils/convexDecomposition'));
  ({ toSceneGeom, fromSceneGeom } = await import('../src/utils/sculptMesh'));
  ({ applySculptStroke } = await import('../src/utils/sculptCommands'));
});

const find = (id: string) => {
  const walk = (ns: any[]): any => {
    for (const n of ns || []) {
      if (n.id === id) return n;
      const c = walk(n.children);
      if (c) return c;
    }
    return null;
  };
  return walk(useStore.getState().sceneGraph.nodes);
};
const sculptGeomOf = (node: any) => resolveCsgGeoms(node, 'render').find((x: any) => x.type === 'mesh');
const newSculpt = (x: number) => {
  useStore.getState().addComponent('sculpt', [x, 0, 0.2]);
  return [...useStore.getState().sceneGraph.nodes].reverse().find((n: any) => n.isSculpt);
};

/** One stroke, committed the way SculptSurface commits it. */
function stroke(nodeId: string, at: number[]) {
  const sg = sculptGeomOf(find(nodeId));
  const mesh = fromSceneGeom(sg.renderVertices, sg.faces);
  applySculptStroke(mesh, { brush: 'inflate', at: [at], radius: 0.06, strength: 1 });
  const geom = toSceneGeom(mesh);
  useStore.getState().updateNodeGeom(nodeId, geom, 0);
  return geom;
}

/** Pretend a decomposition of the body's current mesh has landed. */
function installColliders(nodeId: string) {
  const piece = (i: number) => ({
    name: `${nodeId}_csg_col${i}`, type: 'mesh', size: [1], pos: [0, 0, 0], mass: 0.5,
    vertices: [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1], faces: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    role: 'collision', csgDerived: 'collider',
  });
  useStore.getState().applyNodeColliders(nodeId, {
    hash: collisionHashOf(find(nodeId)), geoms: [piece(0), piece(1)],
    verdict: { strategy: 'decompose', solidity: 0.5, triangles: 1, maxHulls: 8, reason: 'concave' },
    volume: 1, hullVolume: 2, mass: 1,
  }, true);
}

const colliderCount = (node: any) => node.geoms.filter((x: any) => x.csgDerived === 'collider').length;

describe('a decomposed body after a stroke', () => {
  it('stops colliding as the shape it had before the stroke', async () => {
    buildBehaviour = async () => ({ ok: true });
    const node = newSculpt(0);
    installColliders(node.id);
    expect(colliderCount(find(node.id))).toBe(2);

    stroke(node.id, [0, 0, 0.12]);
    const after = find(node.id);
    // The old pieces are off it, so it collides as its hull — which contains
    // the new mesh — until the new ones land, instead of as its old shape.
    expect(colliderCount(after)).toBe(0);
    expect(resolveCsgGeoms(after, 'physics').some((x: any) => x.csgDerived === 'collider')).toBe(false);
    // And it still reads as stale, so the decomposer still runs.
    expect(collidersAreStale(after)).toBe(true);
    await sleep(400);
  });

  it('does not keep the old pieces when the new mesh cannot be decomposed', async () => {
    const node = newSculpt(0.5);
    installColliders(node.id);
    stroke(node.id, [0, 0, 0.12]);
    // Put pieces back as though the stroke had kept them, then fail.
    installColliders(node.id);
    useStore.getState().setNodeCollisionError(node.id, 'boom', collisionHashOf(find(node.id)));
    expect(colliderCount(find(node.id))).toBe(0);
    await sleep(400);
  });

  it('ignores a decomposition of a mesh that has since changed', async () => {
    const node = newSculpt(1);
    stroke(node.id, [0, 0, 0.12]);
    const staleHash = collisionHashOf(find(node.id));
    stroke(node.id, [0.12, 0, 0]);
    useStore.getState().applyNodeColliders(node.id, {
      hash: staleHash, geoms: [], verdict: { strategy: 'hull', solidity: 1, triangles: 1, maxHulls: 0, reason: 'convex-enough' },
      volume: 1, hullVolume: 1, mass: 1,
    }, true);
    expect(find(node.id).collisionHash).not.toBe(staleHash);
    await sleep(400);
  });
});

describe('a failed build', () => {
  it('does not put an older stroke back into the document', async () => {
    buildBehaviour = async () => ({ ok: true });
    const node = newSculpt(1.5);
    await sleep(400);

    // Stroke 1's build is slow and then fails, the way it does when the worker
    // is recycled under it; stroke 2 is committed while it is in flight.
    let rejectFirst: (e: Error) => void = () => {};
    let first = true;
    buildBehaviour = () => {
      if (first) { first = false; return new Promise((_, rej) => { rejectFirst = rej; }); }
      return new Promise((res) => setTimeout(() => res({ ok: true }), 150));
    };
    stroke(node.id, [0, 0, 0.12]);
    await sleep(250);
    const g2 = stroke(node.id, [0.12, 0, 0]);
    await sleep(220);
    rejectFirst(new Error('The physics worker was recycled before this request completed.'));
    await sleep(20);
    expect(sculptGeomOf(find(node.id)).renderVertices).toBe(g2.renderVertices);
    await sleep(400);
    expect(sculptGeomOf(find(node.id)).renderVertices).toBe(g2.renderVertices);
  });
});

describe('a stroke resets the simulation', () => {
  it('even when a state-keeping rebuild overtakes it inside its debounce', async () => {
    buildBehaviour = async () => ({ ok: true });
    const node = newSculpt(2);
    await sleep(400);
    builds.length = 0;
    stroke(node.id, [0, 0, 0.12]);
    await sleep(110);
    useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false);
    await sleep(400);
    expect(builds.length).toBe(1);
    expect(builds[0].preserveState).toBe(false);
  });
});
