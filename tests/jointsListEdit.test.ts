// updateNodeJointsList puts its change in the store at once.
//
// It used to hand the new scene to recompile alone, and a build installs its
// scene only if the store has not moved on meanwhile. physics_create_sculpt
// with a parent takes the hinge addComponent gives a child off, then resizes
// and renames the body, and those edits dropped the jointless scene: the sculpt
// was left on a hinge its docs say it does not have.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import type { SceneGraph } from '../src/types/scene';

describe('updateNodeJointsList', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const graph = {
      nodes: [{
        id: 'hub', name: 'hub', type: 'body', pos: [0, 0, 0.5], joints: [],
        geoms: [{ name: 'hub_box', type: 'box', size: [0.02, 0.02, 0.02] }],
        children: [{
          id: 'clay', name: 'clay', type: 'body', pos: [0.05, 0, 0],
          joints: [{ name: 'clay_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }],
          geoms: [{ name: 'clay_box', type: 'box', size: [0.01, 0.01, 0.01] }],
          children: [],
        }],
      }],
    } as unknown as SceneGraph;
    useStore.setState({ sceneGraph: graph, model: null, data: null, undoStack: [] });
  });

  it('survives an edit made straight after it', () => {
    useStore.getState().updateNodeJointsList('clay', []);
    expect(useStore.getState().sceneGraph.nodes[0].children[0].joints).toEqual([]);
    useStore.getState().renameNode('clay', 'Clay');
    const clay = useStore.getState().sceneGraph.nodes[0].children[0];
    expect(clay.name).toBe('Clay');
    expect(clay.joints).toEqual([]);
  });
});
