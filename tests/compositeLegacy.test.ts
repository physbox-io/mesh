// MuJoCo 3.17 dropped the 'cloth' and 'grid' composites, so a body that still
// asked for one failed the whole scene's compile. Saved legacy scenes also carry
// 2D `compositeCount` ('9 9 1'), multi-component `compositeSize`, and 'sphere'
// geoms; they now collapse cleanly to a 1D capsule cable.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types/scene';

type Mj = { MjModel: { from_xml_string(xml: string): { nbody: number; delete(): void } } };
let mj: Mj;
beforeAll(async () => { mj = (await load_mujoco()) as unknown as Mj; }, 60_000);

const scene = (compositeType: string, extra: Partial<SceneNode> = {}): SceneGraph => ({
  nodes: [{
    id: 'c', name: 'c', pos: [0, 0, 1], isComposite: true,
    compositeType: compositeType as SceneNode['compositeType'],
    compositeCount: '6 1 1', compositeSize: '0.5',
    geoms: [{ name: 'g', type: 'capsule', size: [0.01] }],
    ...extra,
  } as SceneNode],
} as SceneGraph);

describe('legacy composite types', () => {
  for (const t of ['cable', 'rope', 'cloth', 'grid']) {
    it(`a 1D '${t}' composite compiles`, () => {
      const m = mj.MjModel.from_xml_string(compileToMJCF(scene(t)));
      expect(m.nbody).toBeGreaterThan(5);
      m.delete();
    });
  }

  it('compiles a saved 2D cloth composite with count "9 9 1", multi-number size, 2D curve, and sphere geom', () => {
    const xml = compileToMJCF(scene('cloth', {
      compositeCount: '9 9 1',
      compositeSize: '0.6 0.6 0.05',
      compositeCurve: 's s 0',
      geoms: [{ name: 'g', type: 'sphere', size: [0.01, 0.02, 0.03] }],
    }));
    expect(xml).toContain('type="cable"');
    expect(xml).toContain('count="9 1 1"');
    expect(xml).toContain('size="0.6"');
    expect(xml).toContain('<geom type="capsule" size="0.01"');
    const m = mj.MjModel.from_xml_string(xml);
    expect(m.nbody).toBeGreaterThanOrEqual(9);
    m.delete();
  });

  it('compiles a saved 2D grid or cable with multi-dimensional count and sphere geom', () => {
    for (const t of ['grid', 'cable']) {
      const xml = compileToMJCF(scene(t, {
        compositeCount: '8 8 1',
        compositeSize: '0.4 0.4',
        geoms: [{ name: 'g', type: 'sphere', size: [0.015] }],
      }));
      const m = mj.MjModel.from_xml_string(xml);
      expect(m.nbody).toBeGreaterThanOrEqual(8);
      m.delete();
    }
  });
});
