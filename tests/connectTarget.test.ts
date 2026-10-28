import { describe, it, expect } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types';

const body = (id: string, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos: [0, 0, 0.1], quat: [1, 0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01], rgba: [0.5, 0.5, 0.5, 1] }],
  ...extra,
});

// A connect only named its target when the target had a joint of its own, so a
// rod pinned to a crank pin (no joint; carried round by the crank's) was
// pinned to a fixed point in the world instead.
describe('a connect to a body with no joint of its own', () => {
  it('names the body, which may be carried by its parent', () => {
    const scene = { nodes: [
      body('crank', {
        joints: [{ name: 'crank_hinge', type: 'hinge', axis: [0, 0, 1] }],
        children: [body('crankpin', { pos: [0.03, 0, 0] })],
      }),
      body('rod', { pos: [0.03, 0, 0.12], joints: [{ name: 'rod_free', type: 'free' }], connectTargetId: 'crankpin', connectAnchor: [0.03, 0, 0.11] }),
    ] } as SceneGraph;
    expect(compileToMJCF(scene)).toMatch(/<connect [^>]*body1="rod" body2="crankpin"/);
  });
});
