// A rope is a logical node, not a body. build_scene gave a geom-less rope a
// default free joint and a 0.25 m box, which the compiler dropped and the
// scene summary still showed.

import { describe, it, expect } from 'vitest';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { compileToMJCF } from '../src/utils/mjcf';

describe('a rope node from build_scene', () => {
  const rope = fillBodyDefaults({
    id: 'rope', name: 'rope', isPulleyRope: true, pulleyWheelId: 'wheel', leftTargetId: 'a', rightTargetId: 'b',
  } as never);

  it('gets no free joint and no default box', () => {
    expect(rope.joints).toEqual([]);
    expect(rope.geoms).toEqual([]);
  });

  it('keeps what the caller did write', () => {
    expect(rope.isPulleyRope).toBe(true);
    expect(rope.pulleyWheelId).toBe('wheel');
  });

  it('emits nothing into the model', () => {
    expect(compileToMJCF({ nodes: [rope] })).not.toContain('name="rope"');
  });

  it('leaves an ordinary geom-less body its defaults', () => {
    const body = fillBodyDefaults({ id: 'b' } as never);
    expect(body.joints.map((j) => j.type)).toEqual(['free']);
    expect(body.geoms).toHaveLength(1);
  });
});
