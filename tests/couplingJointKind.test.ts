// A coupling ties one hinge or slide to another. Coupled to a body built with
// no joint (so given a free one), a slide used to drive that free joint's
// first number, its X: the body was flung sideways at 4.9 m/s, and the run
// said every constraint held.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { couplingWarnings } from '../src/utils/sceneCouplings';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { reportHeadless } from '../src/utils/headlessReport';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const scene = (): SceneNode[] => [
  { id: 'load', name: 'load', pos: [0, 0, 0.5], joints: [{ name: 'load_slide', type: 'slide', axis: [0, 0, 1] }], geoms: [{ type: 'box', size: [0.02, 0.02, 0.02], mass: 1 }], coupleTargetId: 'effort', coupleRatio: -0.5 },
  { id: 'effort', name: 'effort', pos: [0.2, 0, 0.5], geoms: [{ type: 'sphere', size: [0.02], mass: 0.1 }] },
].map((b) => fillBodyDefaults(b as any));

describe('couplings tie hinges and slides only', () => {
  it('leaves out a coupling to a free joint, and says so by name', () => {
    const nodes = scene();
    expect(nodes[1].joints[0].type).toBe('free');
    const xml = compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0);
    expect(xml).not.toContain('explicit_coupling');
    const w = couplingWarnings(nodes);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'effort' has only a free joint");
    expect(w[0]).toContain("'load'");
  });

  it('the free body falls straight down instead of being flung along X', () => {
    const nodes = scene();
    const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
    const d = new mj.MjData(m);
    try {
      for (let i = 0; i < 200; i++) mj.mj_step(m, d);
      const b = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'effort');
      // Was 4.9 m/s in X.
      expect(Math.abs(d.cvel[b * 6 + 3])).toBeLessThan(1e-3);
      expect(Math.abs(d.xpos[b * 3] - 0.2)).toBeLessThan(1e-4);
    } finally { d.delete(); m.delete(); }
  });

  it("couples a body's first hinge or slide, past a joint of another kind", () => {
    const nodes = scene();
    nodes[1].joints = [{ name: 'effort_ball', type: 'ball' }, { name: 'effort_slide', type: 'slide', axis: [0, 0, 1] }];
    const xml = compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0);
    expect(xml).toMatch(/<fixed name="explicit_coupling_1"><joint joint="load_slide" coef="1" \/><joint joint="effort_slide" coef="0.5" \/>/);
    expect(couplingWarnings(nodes)).toEqual([]);
  });

  it('a headless reply carries the warning and does not call the constraints held', () => {
    const nodes = scene();
    const frame = { t: 0, bodies: {}, joints: {}, contacts: [] } as any;
    const reply = reportHeadless(
      { ok: true, trajectory: [frame, { ...frame, t: 0.1 }], constraintReport: { constraints: [], limits: [], warnings: [] } },
      { nodes }, undefined,
    );
    expect(reply.warnings.some((w) => w.includes('coupleTargetId'))).toBe(true);
    expect(reply.final?.constraintsHeld).toBe(false);
  });
});
