import { describe, expect, it } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { copyBodies, pasteBodies } from '../src/utils/duplicateNodes';
import { cloneSceneGraph } from '../src/store/useStore';

const box = (id: string, pos: number[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos, joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.02, 0.02, 0.02] }],
  ...extra,
});
const cloneNodes = (nodes: SceneNode[]) => cloneSceneGraph({ nodes } as SceneGraph).nodes;

describe('duplicating bodies', () => {
  it('places a copy one width along X, with fresh ids and inner references remapped', () => {
    const inner = box('arm', [0, 0, 0.05], { weldTargetId: 'frame' });
    const sibling = box('pin', [0, 0, 0.1], { weldTargetId: 'arm' });
    const root = box('frame', [0.1, 0, 0], { children: [inner, sibling] });
    const outside = box('table', [0, 0, 0]);
    const scene: SceneGraph = { nodes: [root, outside] } as SceneGraph;

    const board = copyBodies(scene, ['frame'], cloneNodes)!;
    expect(board.step).toBeCloseTo(0.04 + 0.01, 6);
    const ids = pasteBodies(scene, board, 1, cloneNodes);
    expect(scene.nodes).toHaveLength(3);
    const copy = scene.nodes[2];
    expect(ids).toEqual([copy.id]);
    expect(copy.id).not.toBe('frame');
    expect(copy.pos[0]).toBeCloseTo(0.15, 6);
    const [arm2, pin2] = copy.children;
    expect(arm2.id).not.toBe('arm');
    expect(arm2.weldTargetId).toBe(copy.id);
    expect(pin2.weldTargetId).toBe(arm2.id);
    // The original is untouched.
    expect(root.children[1].weldTargetId).toBe('arm');
  });

  it('keeps a reference out of the copy, and goes back under the parent', () => {
    const bracket = box('bracket', [0.02, 0, 0], { weldTargetId: 'table' });
    const frame = box('frame', [0, 0, 0], { euler: [0, 0, 90], children: [bracket] });
    const scene: SceneGraph = { nodes: [frame, box('table', [1, 0, 0])] } as SceneGraph;
    const board = copyBodies(scene, ['bracket'], cloneNodes)!;
    pasteBodies(scene, board, 2, cloneNodes);
    const [orig, copy] = scene.nodes[0].children;
    expect(copy.weldTargetId).toBe('table');
    // Two steps along world X; in a parent turned 90° about Z that is local −Y.
    expect(copy.pos[0]).toBeCloseTo(orig.pos[0], 6);
    expect(copy.pos[1]).toBeCloseTo(-2 * board.step, 6);
  });

  it('cuts a pin or a coupling out of the copy, so it does not drive the original', () => {
    // A crank's rod pinned to a slider, and a gear coupled to another: copied,
    // they drove the original slider and gear, two mechanisms fighting over one.
    const rod = box('rod', [0.02, 0, 0], { connectTargetId: 'slider', connectAnchor: [0.04, 0, 0], connectAnchorLocal: [0.02, 0, 0] });
    const gear = box('gear', [0, 0.05, 0], { coupleTargetId: 'other_gear', coupleRatio: -2 });
    const scene: SceneGraph = { nodes: [rod, gear, box('slider', [0.2, 0, 0]), box('other_gear', [0, 0.1, 0])] } as SceneGraph;
    const board = copyBodies(scene, ['rod', 'gear'], cloneNodes)!;
    pasteBodies(scene, board, 1, cloneNodes);
    const [rod2, gear2] = scene.nodes.slice(4);
    expect(rod2.connectTargetId).toBeUndefined();
    expect(rod2.connectAnchor).toBeUndefined();
    expect(rod2.connectAnchorLocal).toBeUndefined();
    expect(gear2.coupleTargetId).toBeUndefined();
    expect(gear2.coupleRatio).toBeUndefined();
    // The originals keep theirs.
    expect(rod.connectTargetId).toBe('slider');
  });

  it('pastes at the top level, at its world pose, when the parent has gone', () => {
    const frame = box('frame', [0.5, 0, 0], { children: [box('bracket', [0.02, 0, 0])] });
    const board = copyBodies({ nodes: [frame] } as SceneGraph, ['bracket'], cloneNodes)!;
    const other: SceneGraph = { nodes: [] } as unknown as SceneGraph;
    pasteBodies(other, board, 1, cloneNodes);
    expect(other.nodes).toHaveLength(1);
    expect(other.nodes[0].pos[0]).toBeCloseTo(0.52 + board.step, 6);
  });

  it('copies a selected body once when its parent is selected too', () => {
    const scene: SceneGraph = { nodes: [box('frame', [0, 0, 0], { children: [box('arm', [0, 0, 0.05])] })] } as SceneGraph;
    const board = copyBodies(scene, ['arm', 'frame'], cloneNodes)!;
    expect(board.nodes.map((n) => n.name)).toEqual(['frame']);
  });
});

describe('pasting where the view is', () => {
  it('moves top-level copies over the view centre, keeping height, clear of what is there', () => {
    const scene: SceneGraph = { nodes: [box('a', [0, 0, 0.3]), box('b', [1, 1, 0.02])] } as SceneGraph;
    const board = copyBodies(scene, ['a'], cloneNodes)!;
    pasteBodies(scene, board, 1, cloneNodes, [1, 1, 0]);
    const copy = scene.nodes[2];
    // Over b, so stepped just past it: b reaches x = 1.02, the copy's half-width is 0.02.
    expect(copy.pos[0]).toBeCloseTo(1.02 + 0.01 + 0.02, 6);
    expect(copy.pos[1]).toBeCloseTo(1, 6);
    expect(copy.pos[2]).toBeCloseTo(0.3, 6);
  });
});

describe('placing a new body', () => {
  it('stands it on the floor at the point asked for, beside anything there', async () => {
    const { restingPos, besideOffset } = await import('../src/utils/spawnPlacement');
    const fresh = box('new', [0, 0, 0]);
    expect(restingPos(fresh, [], [0.3, 0.1, 0.5])).toEqual([0.3, 0.1, 0.02]);
    const there = box('old', [0.3, 0.1, 0.02]);
    expect(restingPos(fresh, [there], [0.3, 0.1, 0])[0]).toBeCloseTo(0.32 + 0.01 + 0.02, 6);
    expect(besideOffset(there, fresh)).toBeCloseTo(0.02 + 0.01 + 0.02, 6);
  });
});
