// Bought hardware in real MuJoCo: a shaft in a seated bearing turns while the
// housing stays put, and a screw holds the part it reaches into — the two
// things these parts are in the scene to do.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { hardwarePartNode, seatPart, seatFor, screwFit, fasten } from '../src/utils/hardwareParts';
import { hardwareCutGeoms, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const plate = (id: string, thickMm: number, z: number, free: boolean): SceneNode => ({
  id, name: id, pos: [0, 0, z], csgEnabled: true, children: [],
  joints: free ? [{ name: `${id}_free`, type: 'free' }] : [],
  geoms: [{ name: `${id}_b`, type: 'box', size: [0.02, 0.02, thickMm / 2000], mass: 0.05 } as SceneGeom],
} as SceneNode);

function cut(node: SceneNode, spec: Omit<HardwareCutSpec, 'group'>): string {
  for (const piece of hardwareCutGeoms({ ...spec, group: 'g1' }, node.id)) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return 'g1';
}

function run(scene: SceneGraph, seconds: number, before?: (model: any, data: any) => void) {
  const model = mj.MjModel.from_xml_string(compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0));
  const data = new mj.MjData(model);
  before?.(model, data);
  const steps = Math.round(seconds / model.opt.timestep);
  for (let i = 0; i < steps; i++) mj.mj_step(model, data);
  return { model, data, done: () => { data.delete(); model.delete(); } };
}

const bodyPos = (model: any, data: any, name: string) => {
  const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, name);
  return [data.xpos[id * 3], data.xpos[id * 3 + 1], data.xpos[id * 3 + 2]];
};

describe('hardware in MuJoCo', () => {
  it('turns a shaft in a seated bearing while the housing stays where it is', () => {
    const housing = plate('housing', 12, 0.05, false);
    const group = cut(housing, { kind: 'bearing', size: '608', at: [0, 0, 0.006], normal: [0, 0, 1] });
    const bearing = hardwarePartNode({ kind: 'bearing', size: '608' }, 'brg');
    housing.children.push(bearing);
    seatPart(bearing, housing, group);
    const shaft = hardwarePartNode({ kind: 'shaft', size: '8', lengthMm: 40, seat: 'bore' }, 'shaft');
    shaft.joints = [];
    for (const g of shaft.geoms) { g.contype = 0; g.conaffinity = 0; }
    bearing.children[0].children.push(shaft);

    const spin = 20; // rad/s
    const r = run({ nodes: [housing] } as SceneGraph, 1, (model, data) => {
      const j = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'brg_spin');
      data.qvel[model.jnt_dofadr[j]] = spin;
    });
    const j = mj.mj_name2id(r.model, mj.mjtObj.mjOBJ_JOINT.value, 'brg_spin');
    const angle = r.data.qpos[r.model.jnt_qposadr[j]];
    const still = r.data.qvel[r.model.jnt_dofadr[j]];
    // Coasting, as a bearing does: most of a second's worth of turns, and
    // still turning at the end of it.
    expect(angle).toBeGreaterThan(0.8 * spin);
    expect(still).toBeGreaterThan(0.5 * spin);
    const h = bodyPos(r.model, r.data, 'housing');
    expect(h[2]).toBeCloseTo(0.05, 6);
    r.done();
  }, 60_000);

  it('holds a hanging plate up by the screw through it, and drops it without one', () => {
    const build = (withScrew: boolean) => {
      // The lid is fixed in space; the base hangs under it on nothing but the screw.
      const lid = plate('lid', 8, 0.2, false);
      const base = plate('base', 20, 0.186, true);
      const hole = { name: 'base_hole', type: 'cylinder', size: [0.0016, 0], csg: 'difference', cutAt: [0, 0, 0.01], cutNormal: [0, 0, 1], cutDepth: 0 } as SceneGeom;
      base.geoms.push(hole);
      Object.assign(hole, cutGeometry(base, hole));
      if (withScrew) {
        const group = cut(lid, { kind: 'counterbore', size: 'M3', at: [0, 0, 0.004], normal: [0, 0, 1] });
        const screw = hardwarePartNode({ kind: 'screw', size: 'M3' }, 'screw');
        lid.children.push(screw);
        seatPart(screw, lid, group);
        const scene = { nodes: [lid, base] } as SceneGraph;
        const fit = screwFit(scene, lid, screw, seatFor(lid, group, 'screw')!.gripM!);
        expect(fit.target?.id).toBe('base');
        expect(fasten(screw, lid, fit.target!)).toBe(true);
      }
      return { nodes: [lid, base] } as SceneGraph;
    };
    for (const withScrew of [true, false]) {
      const r = run(build(withScrew), 0.5);
      const z = bodyPos(r.model, r.data, 'base')[2];
      if (withScrew) expect(z).toBeGreaterThan(0.186 - 0.001);
      else expect(z).toBeLessThan(0.186 - 0.05);
      r.done();
    }
  }, 60_000);
});
