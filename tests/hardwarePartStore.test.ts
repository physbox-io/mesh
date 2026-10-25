/**
 * Bought hardware through the store: seated from a cut, resized through it,
 * taken out of every export, and letting go of what it fastened when deleted.
 * Driven headless against a fake worker client, as sculptCollisionFlow is.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let collectSceneTriangles: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  ({ collectSceneTriangles } = await import('../src/utils/contourSliceExporter'));
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

/** A plate `thickMm` thick, its top at z = top. */
function plate(id: string, thickMm: number, top: number) {
  const { sceneGraph } = useStore.getState();
  useStore.getState().updateScene({
    ...sceneGraph,
    nodes: [...sceneGraph.nodes, {
      id, name: id, pos: [0, 0, top - thickMm / 2000], joints: [{ name: `${id}_free`, type: 'free' }], children: [],
      geoms: [{ name: `${id}_b`, type: 'box', size: [0.02, 0.02, thickMm / 2000], mass: 0.05 }],
    }],
  });
}

describe('a bought part in the store', () => {
  it('seats in a cut, follows its size, and stays out of the exported part', () => {
    useStore.getState().updateScene({ nodes: [] });
    plate('housing', 12, 0.05);
    const group = useStore.getState().addHardwareCut('housing', 'bearing', { at: [0, 0, 0.006], normal: [0, 0, 1] });
    expect(group).toBeTruthy();
    const trisBefore = collectSceneTriangles(useStore.getState().sceneGraph).tris.length;

    const id = useStore.getState().seatHardwarePart('housing', group, 'bearing');
    expect(id).toBeTruthy();
    const housing = find('housing');
    expect(housing.children.map((c: any) => c.id)).toContain(id);
    expect(find(id).hardwarePart).toMatchObject({ kind: 'bearing', size: '608', seat: group });
    // Bought, not made: the export sees the housing alone.
    expect(collectSceneTriangles(useStore.getState().sceneGraph).tris.length).toBe(trisBefore);

    // The part's size is the cut's: changing either changes both.
    useStore.getState().setHardwarePart(id, { size: '625' });
    expect(find(id).hardwarePart.size).toBe('625');
    expect(find('housing').geoms.find((x: any) => x.hardware?.group === group).hardware.size).toBe('625');
    useStore.getState().setHardwareCut('housing', group, { size: '6001' });
    expect(find(id).hardwarePart.size).toBe('6001');
    expect(find(id).name).toBe('6001 bearing');
  });

  it('puts a shaft of its bore through a selected bearing', () => {
    useStore.getState().updateScene({ nodes: [] });
    plate('housing', 12, 0.05);
    const group = useStore.getState().addHardwareCut('housing', 'bearing', { at: [0, 0, 0.006], normal: [0, 0, 1] });
    const bearing = useStore.getState().seatHardwarePart('housing', group, 'bearing');
    const shaft = useStore.getState().addHardwarePart('shaft', [0, 0, 0], bearing);
    const inner = find(bearing).children.find((c: any) => c.hardwarePart?.piece === 'inner');
    expect(inner.children.map((c: any) => c.id)).toContain(shaft);
    expect(find(shaft).hardwarePart.size).toBe('8');
    expect(find(shaft).joints).toEqual([]);
  });

  it('fastens what it screws into, and lets go when it is deleted', () => {
    useStore.getState().updateScene({ nodes: [] });
    plate('lid', 8, 0.03);
    plate('base', 20, 0.022);
    useStore.getState().addBodyCut('base', 'cylinder', { at: [0, 0, 0.012], normal: [0, 0, 1] });
    const group = useStore.getState().addHardwareCut('lid', 'counterbore', { at: [0, 0, 0.004], normal: [0, 0, 1] });
    // Picking the lid and asking for a screw puts it in the empty counterbore.
    const screw = useStore.getState().addHardwarePart('screw', [0, 0, 0], 'lid');
    expect(find(screw).hardwarePart).toMatchObject({ seat: group, fastens: 'base' });
    expect(find('base').weldTargetId).toBe('lid');
    useStore.getState().deleteNodes([screw]);
    expect(find(screw)).toBeNull();
    expect(find('base').weldTargetId).toBeUndefined();
  });

  it('stands on its own, free and colliding, with nothing picked', () => {
    useStore.getState().updateScene({ nodes: [] });
    const id = useStore.getState().addHardwarePart('nut', [0.1, 0, 0], null);
    const nut = find(id);
    expect(nut.joints[0].type).toBe('free');
    expect(nut.geoms[0].contype).toBeUndefined();
    expect(nut.pos[0]).toBeCloseTo(0.1, 9);
  });
});
