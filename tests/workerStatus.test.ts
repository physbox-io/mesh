import { describe, it, expect } from 'vitest';
import { describeWorker, type WorkerStatusInput } from '../src/utils/workerStatus';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const box = (id: string, size = 0.01): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0.1], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [size, size, size] }],
} as SceneNode);

const scene = (nodes: SceneNode[]) => ({ nodes } as SceneGraph);

const base = (over: Partial<WorkerStatusInput>): WorkerStatusInput => {
  const graph = scene([box('a')]);
  return {
    graph, hasModel: true, builtFrom: graph, builtAt: 1000,
    frame: { at: 9900, simTime: 1.5 }, isPlaying: true, compiling: false, hidden: false, now: 10000,
    ...over,
  };
};

describe('describeWorker', () => {
  it('is built and live when the model came from this scene and frames are arriving', () => {
    const s = describeWorker(base({}));
    expect(s).toMatchObject({ sceneBuilt: true, staleBodies: 0, stalled: false, lastFrameAgoMs: 100, simTime: 1.5, lastBuildAgoMs: 9000 });
    expect(s.note).toBeUndefined();
  });

  it('is not built when nothing ever built a model, however isLoaded reads', () => {
    const s = describeWorker(base({ hasModel: false, builtFrom: null, frame: null, isPlaying: false }));
    expect(s.sceneBuilt).toBe(false);
    expect(s.note).toMatch(/never built/);
  });

  it('is not built after an edit that has not compiled, and says when a compile is on its way', () => {
    const built = scene([box('a')]);
    const edited = scene([box('a', 0.02), box('b')]);
    expect(describeWorker(base({ graph: edited, builtFrom: built, isPlaying: false })).staleBodies).toBe(2);
    expect(describeWorker(base({ graph: edited, builtFrom: built, isPlaying: false, compiling: true })).note).toMatch(/in flight/);
  });

  it('calls a playing worker that has gone quiet stalled, but not in a background tab', () => {
    expect(describeWorker(base({ frame: { at: 5000, simTime: 1 } })).stalled).toBe(true);
    expect(describeWorker(base({ frame: null })).stalled).toBe(true);
    expect(describeWorker(base({ frame: { at: 5000, simTime: 1 }, hidden: true })).stalled).toBe(false);
    expect(describeWorker(base({ frame: { at: 5000, simTime: 1 }, isPlaying: false })).stalled).toBe(false);
  });
});
