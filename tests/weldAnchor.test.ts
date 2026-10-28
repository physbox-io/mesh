import { describe, it, expect } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types';

// MuJoCo holds a weld at its anchor, which defaults to body2's origin. Held
// there, a small part far from that origin swings round it: a 20 g knob welded
// to a drawer fell 165 mm in two seconds. The weld is now held at the part.
const body = (id: string, pos: number[], size: number[], mass: number, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos, quat: [1, 0, 0, 0], children: [],
  joints: [{ name: `${id}_free`, type: 'free' }],
  geoms: [{ name: `${id}_g`, type: 'box', size, mass, rgba: [0.5, 0.5, 0.5, 1] }],
  ...extra,
});

/** How far body `id` drops in two seconds, in mm. */
async function drop(scene: SceneGraph, id: string): Promise<number> {
  const mujoco = await load_mujoco();
  const model = mujoco.MjModel.from_xml_string(compileToMJCF(scene));
  const data = new mujoco.MjData(model);
  try {
    mujoco.mj_forward(model, data);
    const b = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, id);
    const z0 = data.xpos[b * 3 + 2];
    for (let i = 0; i < 2 / model.opt.timestep; i++) mujoco.mj_step(model, data);
    return (z0 - data.xpos[b * 3 + 2]) * 1000;
  } finally {
    data.delete();
    model.delete();
  }
}

describe('a weld holds the part where it is', () => {
  it('keeps a small knob on the front of a drawer', async () => {
    const scene = { nodes: [
      body('drawer', [0, -0.01, 0.05], [0.15, 0.15, 0.05], 1),
      body('knob', [0, -0.175, 0.05], [0.008, 0.007, 0.008], 0.02, { weldTargetId: 'drawer' }),
    ] } as SceneGraph;
    expect(compileToMJCF(scene)).toMatch(/<weld [^>]*body1="knob" body2="drawer" anchor="0\.000000 -0\.165000 0\.000000"/);
    expect(await drop(scene, 'knob')).toBeLessThan(2);
  }, 60000);
});
