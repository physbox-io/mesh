// MuJoCo 3.17 dropped the 'cloth' and 'grid' composites, so a body that still
// asked for one failed the whole scene's compile. They now load as a cable.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types/scene';

type Mj = { MjModel: { from_xml_string(xml: string): { nbody: number; delete(): void } } };
let mj: Mj;
beforeAll(async () => { mj = (await load_mujoco()) as unknown as Mj; }, 60_000);

const scene = (compositeType: string): SceneGraph => ({
  nodes: [{
    id: 'c', name: 'c', pos: [0, 0, 1], isComposite: true,
    compositeType: compositeType as SceneNode['compositeType'],
    compositeCount: '6 1 1', compositeSize: '0.5',
    geoms: [{ name: 'g', type: 'capsule', size: [0.01] }],
  } as SceneNode],
} as SceneGraph);

describe('legacy composite types', () => {
  for (const t of ['cable', 'rope', 'cloth', 'grid']) {
    it(`a '${t}' composite compiles`, () => {
      const m = mj.MjModel.from_xml_string(compileToMJCF(scene(t)));
      expect(m.nbody).toBeGreaterThan(5);
      m.delete();
    });
  }
});
