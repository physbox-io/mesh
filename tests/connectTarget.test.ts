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

// danglingReferences keeps a reference that names a body rather than its id,
// and a weld already fell back to the name. A connect did not, and pinned the
// body to the world.
describe('a weld or a connect that names its target', () => {
  it('finds the body by name, and anchors the weld at the welded part', () => {
    const scene = { nodes: [
      body('post_id', { name: 'Post' }),
      body('arm_id', { name: 'Arm', pos: [0.1, 0, 0.1], joints: [{ name: 'arm_free', type: 'free' }], connectTargetId: 'Post', connectAnchor: [0, 0, 0.1] }),
      body('knob_id', { name: 'Knob', pos: [0.2, 0, 0.1], joints: [{ name: 'knob_free', type: 'free' }], weldTargetId: 'Arm' }),
    ] } as SceneGraph;
    const xml = compileToMJCF(scene);
    expect(xml).toMatch(/<connect [^>]*body1="Arm" body2="Post"/);
    expect(xml).toMatch(/<weld [^>]*body1="Knob" body2="Arm" anchor="0.100000 0.000000 0.000000"/);
    expect(xml).toContain('<exclude body1="Arm" body2="Post" />');
  });

  it('is not fooled by a name an object inherits', () => {
    const scene = { nodes: [
      body('c1', { name: 'constructor' }),
      body('u', { joints: [{ name: 'u_free', type: 'free' }], connectTargetId: 'constructor', connectAnchor: [0, 0, 0.1] }),
    ] } as SceneGraph;
    const xml = compileToMJCF(scene);
    expect(xml).toMatch(/<connect [^>]*body1="u" body2="constructor"/);
    expect(xml).not.toContain('function');
  });
});
