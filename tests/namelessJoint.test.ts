// A joint written without a name. STL import used to write its free joint that
// way, and every build failed: the worker looked the joint up by an undefined
// name, and two such joints compiled to a repeated name="undefined".

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph } from '../src/types/scene';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => {
  mj = await load_mujoco();
});

const block = (id: string, x: number) => ({
  id, name: id, pos: [x, 0, 0.1],
  geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }],
  joints: [{ type: 'free' }],
  children: [],
});

describe('a nameless joint', () => {
  it('compiles without a name attribute, and two of them load', () => {
    const xml = compileToMJCF({ nodes: [block('a', 0), block('b', 0.05)] } as unknown as SceneGraph, -9.81, 1, 0, 0, 0, 0);
    expect(xml).not.toContain('name="undefined"');
    const model = mj.MjModel.from_xml_string(xml);
    expect(model.njnt).toBe(2);
    model.delete();
  });
});
