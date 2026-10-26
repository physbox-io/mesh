// Names are whatever someone typed. These compile awkward ones in real MuJoCo:
// characters that mean something in XML, two joints sharing a name, and the
// two names the compiler writes itself (`world`, `floor`).

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { withUniqueNames } from '../src/utils/uniqueNames';
import type { SceneGraph, SceneNode } from '../src/types/scene';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => {
  mj = await load_mujoco();
});

const arm = (id: string, name: string, geomName: string, z: number): SceneNode => ({
  id, name, type: 'body', pos: [0, 0, z],
  geoms: [{ name: geomName, type: 'box', size: [0.02, 0.01, 0.01], mass: 0.1 }],
  joints: [{ name: 'hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], actuator: { type: 'motor' } }],
  children: [],
} as unknown as SceneNode);

const compile = (scene: SceneGraph) => mj.MjModel.from_xml_string(compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0));
const id = (model: unknown, kind: 'mjOBJ_BODY' | 'mjOBJ_GEOM' | 'mjOBJ_JOINT', name: string) =>
  mj.mj_name2id(model as never, mj.mjtObj[kind].value, name);

describe('names in the compiled model', () => {
  it('keeps names with XML characters exactly as typed', () => {
    const model = compile({ nodes: [arm('a', 'Lid & "base" <1>', '6" pipe', 0.2)] } as SceneGraph);
    expect(id(model, 'mjOBJ_BODY', 'Lid & "base" <1>')).toBeGreaterThan(0);
    expect(id(model, 'mjOBJ_GEOM', '6" pipe')).toBeGreaterThan(0);
    model.delete();
  });

  it('numbers a clashing joint name, as the store will keep it', () => {
    const scene = { nodes: [arm('a', 'left', 'left_g', 0.2), arm('b', 'right', 'right_g', 0.4)] } as SceneGraph;
    const kept = withUniqueNames(scene).nodes.map((n) => n.joints![0].name);
    expect(kept).toEqual(['hinge', 'hinge_2']);
    // The scene handed in is not written to.
    expect(scene.nodes[1].joints![0].name).toBe('hinge');
    const model = compile(scene);
    expect(id(model, 'mjOBJ_JOINT', 'hinge')).toBeGreaterThanOrEqual(0);
    expect(id(model, 'mjOBJ_JOINT', 'hinge_2')).toBeGreaterThanOrEqual(0);
    expect(model.nu).toBe(2);
    model.delete();
  });

  it('renames a body called world and a geom called floor', () => {
    const scene = { nodes: [arm('a', 'world', 'floor', 0.2)] } as SceneGraph;
    const out = withUniqueNames(scene).nodes[0];
    expect([out.name, out.geoms[0].name]).toEqual(['world_2', 'floor_2']);
    const model = compile(scene);
    expect(id(model, 'mjOBJ_BODY', 'world_2')).toBeGreaterThan(0);
    expect(id(model, 'mjOBJ_GEOM', 'floor')).toBe(0);
    model.delete();
  });
});
