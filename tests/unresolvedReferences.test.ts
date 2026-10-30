// A typo in pulleyWheelId, coupleTargetId or any target id was dropped by the
// store and the reply said ok:true. The MCP replies now name each reference
// that resolves to nothing the model can use.

import { describe, it, expect } from 'vitest';
import { unresolvedReferences, unresolvedReferenceWarnings } from '../src/utils/unresolvedReferences';
import type { SceneNode } from '../src/types/scene';

const body = (id: string, extra: Partial<SceneNode> = {}, jointed = true): SceneNode => ({
  id, name: `${id} body`, type: 'body', pos: [0, 0, 0], children: [], geoms: [],
  joints: jointed ? [{ name: `${id}_j`, type: 'hinge', axis: [0, 0, 1] }] : [],
  ...extra,
} as unknown as SceneNode);

describe('references that resolve to nothing', () => {
  it('names a typo in each kind of target', () => {
    const nodes = [
      body('wheel'), body('left'), body('right'),
      body('rope', { isPulleyRope: true, pulleyWheelId: 'whel', leftTargetId: 'left', rightTargetId: 'rigth' } as Partial<SceneNode>, false),
      body('a', { coupleTargetId: 'bb', weldTargetId: 'post' } as Partial<SceneNode>),
    ];
    const refs = unresolvedReferences(nodes);
    expect(refs.map((r) => `${r.bodyId}.${r.field}=${r.target}:${r.reason}`)).toEqual([
      'rope.rightTargetId=rigth:missing',
      'rope.pulleyWheelId=whel:missing',
      'a.weldTargetId=post:missing',
      'a.coupleTargetId=bb:missing',
    ]);
    expect(unresolvedReferenceWarnings(refs)[1]).toBe("pulleyWheelId 'whel' on rope body names no body in the scene, so it was dropped and does nothing. Check the id (physics_get_scene_summary lists them).");
  });

  it('names a coupling to a body with no joint, or by its name, which mjcf.ts cannot couple', () => {
    const nodes = [body('a', { coupleTargetId: 'b' } as Partial<SceneNode>), body('b', {}, false), body('c', { coupleTargetId: 'a body' } as Partial<SceneNode>)];
    expect(unresolvedReferences(nodes).map((r) => `${r.bodyId}:${r.reason}`)).toEqual(['a:noJoint', 'c:byName']);
  });

  it('says nothing about references that resolve, and checks only the bodies asked about', () => {
    const ok = [body('a', { coupleTargetId: 'b', weldTargetId: 'b body' } as Partial<SceneNode>), body('b')];
    expect(unresolvedReferences(ok)).toEqual([]);
    const bad = [body('x', { weldTargetId: 'nope' } as Partial<SceneNode>), body('y', { weldTargetId: 'gone' } as Partial<SceneNode>)];
    expect(unresolvedReferences(bad, new Set(['y'])).map((r) => r.bodyId)).toEqual(['y']);
  });
});
