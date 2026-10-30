import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { fillBodyDefaults } from '../src/hooks/useMCPBridge';
import { compileToMJCF } from '../src/utils/mjcf';

const fill = (b: Record<string, unknown>) => () => fillBodyDefaults(b as never);

describe('bodies from an agent are checked before MuJoCo sees them', () => {
  it('names a geom type that is not one, and what to use', () => {
    expect(fill({ name: 'a', geoms: [{ type: 'cube', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/Body 'a' geom 'a_geom_0' has type "cube", which is not a geom type\. Use one of box, sphere/);
  });

  it('still takes the shapes that become meshes', () => {
    expect(fill({ name: 'c', geoms: [{ type: 'cone', size: [0.02, 0.05] }] })).not.toThrow();
  });

  it('names a coordinate that is not a number', () => {
    expect(fill({ name: 'a', pos: [0, 0, 'x'], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/Body 'a': pos\[2\] is "x", not a finite number/);
    expect(fill({ name: 'a', pos: [0, 0, null], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/pos\[2\] is null/);
    expect(fill({ name: 'a', pos: [0, 0], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }))
      .toThrow(/pos has 2 numbers, not 3/);
    expect(fill({ name: 'a', geoms: [{ type: 'box', size: [0.01, NaN, 0.01] }] }))
      .toThrow(/Geom "a_geom_0" on body "a": size\[1\] is NaN/);
    expect(fill({ name: 'a', geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }], joints: [{ type: 'hinge', axis: [0, 'y', 0] }] }))
      .toThrow(/joint 'a_joint_0': axis\[1\]/);
  });

  it('refuses a moving body too small to weigh, in millimetres', () => {
    expect(fill({ name: 'grain', geoms: [{ type: 'sphere', size: [0.00005] }] }))
      .toThrow(/Body 'grain' is 0\.1 mm across at most, too small/);
  });

  it('lets a small body that does not move, or a 2 mm one that does, through', () => {
    expect(fill({ name: 'pin', static: true, geoms: [{ type: 'sphere', size: [0.0001] }] })).not.toThrow();
    expect(fill({ name: 'bead', geoms: [{ type: 'sphere', size: [0.001] }] })).not.toThrow();
    expect(fill({ name: 'fleck', geoms: [{ type: 'sphere', size: [0.0001] }] })).not.toThrow();
  });

  it('compiles a 0.2 mm moving part, which lands and rests, and leaves bigger scenes alone', async () => {
    const body = (half: number) => [{
      id: 'b', name: 'b', type: 'body', pos: [0, 0, 0.05], joints: [{ name: 'f', type: 'free' }],
      geoms: [{ name: 'g', type: 'box', size: [half, half, half] }], children: [],
    }];
    expect(compileToMJCF({ nodes: body(0.0005) } as never, -9.81, 1, 0, 0, 0, 0)).not.toMatch(/<compiler/);
    const xml = compileToMJCF({ nodes: body(0.0001) } as never, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<compiler boundinertia="1e-14" \/>/);
    const mj = await load_mujoco();
    const model = mj.MjModel.from_xml_string(xml);
    const data = new mj.MjData(model);
    try {
      for (let k = 0; k < 2000; k++) mj.mj_step(model, data);
      // On the floor, half a size up, give or take MuJoCo's soft contact
      expect(data.qpos[2]).toBeGreaterThan(0.00005);
      expect(data.qpos[2]).toBeLessThan(0.00015);
      expect(Math.abs(data.qvel[2])).toBeLessThan(0.01);
    } finally {
      data.delete();
      model.delete();
    }
  });

  it('checks nested bodies too', () => {
    expect(fill({ name: 'frame', geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }], children: [{ name: 'arm', pos: [0, NaN, 0] }] }))
      .toThrow(/Body 'arm': pos\[1\] is NaN/);
  });
});
