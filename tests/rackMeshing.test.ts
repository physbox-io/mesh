// A rack is coupled to a pinion by where it is, not by what it is called.
// Every slide whose id contained 'rack' (or 'bracket', or 'track') used to
// be coupled to any 'pinion' within 0.5 m at x = +r·θ: a bracket sliding in
// Z 360 mm away moved with the pinion, and racks above and below it moved the
// same way.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { couplingWarnings } from '../src/utils/sceneCouplings';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const R = 0.02;
const bar = (id: string, pos: number[], axis: number[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos, children: [],
  joints: [{ name: `${id}_slide`, type: 'slide', axis }],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.1, 0.01, 0.01], mass: 0.02 }],
  ...extra,
});

const scene = (): SceneNode[] => [
  {
    id: 'drive', name: 'drive', type: 'body', pos: [0, 0, 0.2], children: [],
    joints: [{ name: 'drive_hinge', type: 'hinge', axis: [0, 1, 0], actuator: { type: 'velocity', kv: 0.05, ctrlValue: 1 } }],
    geoms: [{ name: 'drive_g', type: 'cylinder', size: [R, 0.005], euler: [90, 0, 0], mass: 0.01 }],
  },
  // Face 20 mm from the axis, the wheel's radius: above and below it.
  bar('upper', [0, 0, 0.23], [1, 0, 0], { isRack: true }),
  bar('lower', [0, 0, 0.17], [1, 0, 0], { isRack: true }),
  // Marked a rack, but 360 mm off and sliding in Z.
  bar('bracket', [0.36, 0, 0.2], [0, 0, 1], { isRack: true }),
  // Called a rack and in the right place, but not marked one.
  bar('rack_plain', [0, 0.1, 0.23], [1, 0, 0]),
];

const ratios = (xml: string) => Object.fromEntries(
  [...xml.matchAll(/<fixed name="pinion_rack_coupling[^"]*"><joint joint="([^"]+)" coef="1" \/><joint joint="([^"]+)" coef="([^"]+)" \/>/g)]
    .map(([, , rack, coef]) => [rack, -Number(coef)]),
);

describe('rack and pinion proximity coupling', () => {
  it('couples the racks that touch the wheel at its radius, signed by side, and nothing else', () => {
    const xml = compileToMJCF({ nodes: scene() }, 0, 1, 0, 0, 0);
    const r = ratios(xml);
    expect(Object.keys(r).sort()).toEqual(['lower_slide', 'upper_slide']);
    // θ = x / (r·k): +50 rad/m above the axis, -50 below.
    expect(r.upper_slide).toBeCloseTo(1 / R, 6);
    expect(r.lower_slide).toBeCloseTo(-1 / R, 6);
  });

  it('drives the upper rack +r·θ and the lower -r·θ; the bracket stays put', () => {
    const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: scene() }, 0, 1, 0, 0, 0));
    const d = new mj.MjData(m);
    try {
      d.ctrl[0] = 1;
      for (let i = 0; i < 500; i++) mj.mj_step(m, d);
      const q = (n: string) => d.qpos[m.jnt_qposadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, n)]] as number;
      const theta = q('drive_hinge');
      expect(theta).toBeGreaterThan(0.1);
      expect(q('upper_slide')).toBeCloseTo(R * theta, 5);
      expect(q('lower_slide')).toBeCloseTo(-R * theta, 5);
      expect(Math.abs(q('bracket_slide'))).toBeLessThan(1e-6);
      expect(Math.abs(q('rack_plain_slide'))).toBeLessThan(1e-6);
    } finally { d.delete(); m.delete(); }
  });

  it('names a marked rack that no wheel meshes with', () => {
    const w = couplingWarnings(scene());
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'bracket' is a rack");
  });

  it('a wheel off the pitch radius is not coupled', () => {
    const nodes = scene();
    nodes[1].pos = [0, 0, 0.24]; // face 30 mm from the axis: 50% off
    expect(Object.keys(ratios(compileToMJCF({ nodes }, 0, 1, 0, 0, 0)))).toEqual(['lower_slide']);
  });

  it("the rack and pinion preset keeps its one explicit coupling and no warning", () => {
    const sceneGraph = PRESETS.rack_pinion.scene;
    const xml = compileToMJCF(sceneGraph, -9.81, 1, 0, 0, 0);
    expect(xml.match(/<fixed name="[^"]*coupling[^"]*"/g)).toEqual(['<fixed name="explicit_coupling_1"']);
    expect(couplingWarnings(sceneGraph.nodes)).toEqual([]);
  });
});
