// physics_update_object with pos/euler moves a free body in the running
// simulation too, as the editor's own position fields do.
//
// A rebuild carries qpos across, and a free joint's pose IS its qpos, so the
// new pos reached the model's qpos0 but the body stayed put until Reset.

import { describe, it, expect } from 'vitest';
import { freeJointPose, touchesPose } from '../src/utils/livePose';
import type { SceneNode } from '../src/types/scene';

const body = (over: Partial<SceneNode>): SceneNode => ({
  id: 'b', name: 'b', type: 'body', pos: [0.1, 0.2, 0.3],
  joints: [{ name: 'b_free', type: 'free' }], geoms: [], children: [], ...over,
} as SceneNode);

describe('freeJointPose', () => {
  it('is the authored position and orientation as qpos', () => {
    const pose = freeJointPose(body({ euler: [0, 0, 90] }), true)!;
    expect(pose.joint).toBe('b_free');
    expect(pose.qpos.slice(0, 3)).toEqual([0.1, 0.2, 0.3]);
    expect(pose.qpos[3]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(pose.qpos[6]).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('prefers quat, as the compiler does', () => {
    const pose = freeJointPose(body({ quat: [0, 1, 0, 0], euler: [0, 0, 90] }), true)!;
    expect(pose.qpos.slice(3)).toEqual([0, 1, 0, 0]);
  });

  it('leaves bodies whose pose is not in qpos alone', () => {
    expect(freeJointPose(body({ joints: [{ name: 'h', type: 'hinge' }] }), true)).toBeNull();
    expect(freeJointPose(body({}), false)).toBeNull();
  });

  it('knows a pose edit when it sees one', () => {
    expect(touchesPose({ pos: [0, 0, 1] })).toBe(true);
    expect(touchesPose({ euler: [0, 0, 1] })).toBe(true);
    expect(touchesPose({ rgba: [1, 0, 0, 1] })).toBe(false);
  });
});
