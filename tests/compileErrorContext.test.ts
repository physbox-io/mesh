// A MuJoCo compile error used to name "line 17" of XML nobody calling
// physics_build_scene has seen, or a made-up element like
// 'rope_coupling_linear_1'. It is said in the scene's bodies and joints now,
// with MuJoCo's own reason kept.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { explainCompileError } from '../src/utils/compileErrorContext';
import type { SceneGraph } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const box = (id: string, x: number, type: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, type: 'body', pos: [x, 0, 0.3], children: [],
  joints: [{ name: `${id}_j`, type, axis: [0, 0, 1] }],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01], mass: 0.05 }],
  ...extra,
}) as any;

/** What MuJoCo says about `graph`, raw and explained. */
const compile = (graph: SceneGraph) => {
  const xml = compileToMJCF(graph, -9.81, 1, 0, 0, 1.2, 0);
  try {
    mj.MjModel.from_xml_string(xml).delete();
    return null;
  } catch (e: any) {
    const raw = String(e?.message || e);
    return { raw, explained: explainCompileError(raw, xml) };
  }
};

describe('a compile error, in the scene\'s names', () => {
  it('places a bad joint type on its body and names the field', () => {
    const r = compile({ nodes: [box('lever', 0, 'hinged')] })!;
    expect(r.raw).toMatch(/line \d+/);
    expect(r.explained).toBe("MuJoCo could not build the scene: invalid keyword: 'hinged', in joint 'lever_j' on body 'lever' (its type is 'hinged').");
  });

  // A rope with a free end is left out with a warning now (utils/pulleyRope.ts),
  // so MuJoCo never sees a bad rope coupling; its message is fed in by hand.
  it('says what a generated rope coupling is and which joints it ties', () => {
    const graph = { nodes: [
      box('wheel', 0, 'hinge'), box('left', 0.1, 'slide'), box('right', -0.1, 'slide'),
      { ...box('rope', 0, 'hinge'), joints: [], isPulleyRope: true, pulleyWheelId: 'wheel', leftTargetId: 'left', rightTargetId: 'right' },
    ] } as SceneGraph;
    const xml = compileToMJCF(graph, -9.81, 1, 0, 0, 1.2, 0);
    const line = xml.split('\n').findIndex((l) => l.includes("'rope_coupling_linear_1'") || l.includes('"rope_coupling_linear_1"')) + 1;
    expect(line).toBeGreaterThan(0);
    const explained = explainCompileError(`Error: only HINGE and SLIDE joint allowed in constraint\nElement name 'rope_coupling_linear_1', id 0, line ${line}`, xml);
    expect(explained).toMatch(/only HINGE and SLIDE joint allowed in constraint, in a pulley rope's coupling .*between slide joint 'left_j' on body 'left' and slide joint 'right_j' on body 'right'\.$/);
    expect(explained).not.toMatch(/line \d+/);
  });

  it('leaves a message with no location, or no XML, as it was', () => {
    expect(explainCompileError('Unknown physics worker build error', '<mujoco/>')).toBe('Unknown physics worker build error');
    expect(explainCompileError("XML Error: x\nElement 'joint', line 3", undefined)).toBe("XML Error: x\nElement 'joint', line 3");
  });
});
