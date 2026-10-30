// A coupling is a fixed tendon (utils/jointCoupling.ts), and a headless run
// read its residual as metres between no bodies: a gear pair 12.7 rad out of
// step came back "pulled 12726.95 mm apart" with "between  was" in the text.
// Its error is in its first joint's units, and its joints and bodies are named.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { createConstraintMonitor } from '../src/utils/constraintResiduals';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const wheel = (id: string, x: number, extra: Record<string, unknown> = {}) => ({
  id, name: id, type: 'body', pos: [x, 0, 0.3], children: [],
  joints: [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1] }],
  geoms: [{ name: `${id}_g`, type: 'cylinder', size: [0.02, 0.005], mass: 0.05 }],
  ...extra,
}) as any;

const slider = (id: string, x: number) => ({
  id, name: id, type: 'body', pos: [x, 0.2, 0.3], children: [],
  joints: [{ name: `${id}_slide`, type: 'slide', axis: [1, 0, 0] }],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01], mass: 0.05 }],
}) as any;

const run = (graph: SceneGraph, push: (model: any, data: any) => void) => {
  const model = mj.MjModel.from_xml_string(compileToMJCF(graph, 0, 1, 0, 0, 1.2, 0));
  const data = new mj.MjData(model);
  try {
    const monitor = createConstraintMonitor(mj, model);
    for (let i = 0; i < 600; i++) {
      push(model, data);
      mj.mj_step(model, data);
      monitor.sample(data);
    }
    return monitor.report(data);
  } finally {
    data.delete();
    model.delete();
  }
};

/** Twist every hinge the same way, hard, which a -1 coupling forbids. */
const twistAll = (model: any, data: any) => {
  data.qfrc_applied.fill(0);
  for (let j = 0; j < model.njnt; j++) data.qfrc_applied[model.jnt_dofadr[j]] = 1000;
};

describe('a coupling a headless run saw slip', () => {
  it('is measured in degrees between hinges, and names its joints and bodies', () => {
    const r = run({ nodes: [wheel('drive', 0, { coupleTargetId: 'driven' }), wheel('driven', 0.5)] }, twistAll);
    const c = r.constraints.find((x) => x.name.startsWith('explicit_coupling'))!;
    expect(c.kind).toBe('tendon');
    expect(c.joints).toEqual(['drive_hinge', 'driven_hinge']);
    expect(c.bodies).toEqual(['drive', 'driven']);
    expect(c.worstDeg!).toBeGreaterThan(1);
    expect(c.worstMm).toBeUndefined();
    const w = r.warnings.find((x) => x.includes(c.name))!;
    expect(w).toMatch(/Coupling explicit_coupling_1 \(joint drive_hinge on drive -> joint driven_hinge on driven\) slipped [\d.]+° out of step/);
    expect(w).not.toMatch(/ mm|between {2}/);
  });

  it('is measured in millimetres when its first joint slides', () => {
    const r = run({ nodes: [{ ...slider('rack', 0), coupleTargetId: 'pinion', coupleRatio: 0.01 }, wheel('pinion', 0.5)] }, (model, data) => {
      data.qfrc_applied.fill(0);
      data.qfrc_applied[model.jnt_dofadr[0]] = 200;
    });
    const c = r.constraints.find((x) => x.name.startsWith('explicit_coupling'))!;
    expect(c.bodies).toEqual(['rack', 'pinion']);
    expect(c.worstDeg).toBeUndefined();
    expect(typeof c.worstMm).toBe('number');
  });
});
