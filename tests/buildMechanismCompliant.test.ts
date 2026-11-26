import { describe, it, expect, beforeAll, vi } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import {
  buildMechanism,
  MECHANISM_FAMILIES,
  type MechanismBuild,
} from '../src/utils/buildMechanism';
import type { SceneNode } from '../src/types/scene';

vi.mock('../src/hooks/mcp/settleScene', () => ({
  settleScene: vi.fn(async () => ({ ok: true })),
}));

import { partBuildCommands } from '../src/hooks/mcp/partBuildCommands';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => {
  mj = await load_mujoco();
}, 60_000);

const ok = (r: MechanismBuild | { error: string }): MechanismBuild => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('buildMechanism compliant flexure families', () => {
  it('registers compliant_gripper, parallel_flexure, and cantilever_pawl in MECHANISM_FAMILIES', () => {
    expect(MECHANISM_FAMILIES).toContain('compliant_gripper');
    expect(MECHANISM_FAMILIES).toContain('parallel_flexure');
    expect(MECHANISM_FAMILIES).toContain('cantilever_pawl');
  });

  it('builds compliant_gripper with 6 flexures, expected metrics, and compiles cleanly in MuJoCo', () => {
    const built = ok(
      buildMechanism(
        {
          family: 'compliant_gripper',
          filament: 'petg',
          jawOpeningMm: 24,
          beamThicknessMm: 1.0,
          beamLengthMm: 24,
          beamWidthMm: 10,
          beamsPerJaw: 3,
          strokeMm: 2.0,
          origin: [0.05, 0.02, 0.01],
          idPrefix: 'grip6',
        },
        [],
      ),
    );

    expect(built.family).toBe('compliant_gripper');
    expect(built.addedIds).toEqual(['grip6_base', 'grip6_jaw_left', 'grip6_jaw_right']);
    expect(built.nodes).toHaveLength(1);
    expect(built.nodes[0].pos).toEqual([0.05, 0.02, 0.01]);

    expect(built.metrics.totalFlexureCount).toBe(6);
    expect(typeof built.metrics.pinchForceAtStrokeN).toBe('number');
    expect(built.metrics.pinchForceAtStrokeN as number).toBeGreaterThan(0);
    expect(typeof built.metrics.parasiticShiftMm).toBe('number');
    expect(built.metrics.parasiticShiftMm as number).toBeGreaterThan(0);
    expect(built.metrics.evaluation).toBeDefined();
    expect(Array.isArray(built.metrics.warnings)).toBe(true);
    expect((built.metrics.warnings as string[]).length).toBe(0);

    // Rebuilding with same idPrefix replaces in place
    const rebuilt = ok(
      buildMechanism(
        {
          family: 'compliant_gripper',
          origin: [0.1, 0, 0.02],
          idPrefix: 'grip6',
        },
        built.nodes,
      ),
    );
    expect(rebuilt.nodes).toHaveLength(1);
    expect(rebuilt.nodes[0].pos).toEqual([0.1, 0, 0.02]);

    // Compiles to valid MJCF and steps stably in MuJoCo
    const xml = compileToMJCF({ nodes: built.nodes }, -9.81, 1, 0, 0, 0);
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    try {
      for (let i = 0; i < 100; i++) mj.mj_step(m, d);
      expect(Number.isFinite(d.qpos[0])).toBe(true);
      expect(Number.isFinite(d.qpos[1])).toBe(true);
    } finally {
      d.delete();
      m.delete();
    }
  });

  it('builds parallel_flexure stage with N beams, parasitic shift, and compiles cleanly in MuJoCo', () => {
    const built = ok(
      buildMechanism(
        {
          family: 'parallel_flexure',
          filament: 'petg',
          thicknessMm: 0.8,
          lengthMm: 24,
          widthMm: 10,
          numBeams: 3,
          deflectionMm: 3.0,
          origin: [0, 0.04, 0.01],
          idPrefix: 'pstage',
        },
        [],
      ),
    );

    expect(built.family).toBe('parallel_flexure');
    expect(built.addedIds).toEqual(['pstage_base', 'pstage_stage']);
    expect(built.nodes[0].pos).toEqual([0, 0.04, 0.01]);
    expect(built.metrics.totalFlexureCount).toBe(3);
    expect(built.metrics.parasiticShiftMm).toBeCloseTo(0.225, 3);
    expect(built.metrics.restoringForceN as number).toBeGreaterThan(0);
    expect(built.metrics.evaluation).toBeDefined();
    expect(Array.isArray(built.metrics.warnings)).toBe(true);

    const xml = compileToMJCF({ nodes: built.nodes }, -9.81, 1, 0, 0, 0);
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    try {
      for (let i = 0; i < 100; i++) mj.mj_step(m, d);
      expect(Number.isFinite(d.qpos[0])).toBe(true);
    } finally {
      d.delete();
      m.delete();
    }
  });

  it('builds cantilever_pawl with Howell PRBM metrics and compiles cleanly in MuJoCo', () => {
    const built = ok(
      buildMechanism(
        {
          family: 'cantilever_pawl',
          filament: 'petg',
          thicknessMm: 1.0,
          lengthMm: 20,
          widthMm: 8,
          deflectionMm: 2.0,
          rampAngleDeg: 30,
          catchHeightMm: 2.5,
          origin: [0.02, 0, 0.015],
          idPrefix: 'pawl1',
        },
        [],
      ),
    );

    expect(built.family).toBe('cantilever_pawl');
    expect(built.addedIds).toEqual(['pawl1_base', 'pawl1_arm']);
    expect(built.nodes[0].pos).toEqual([0.02, 0, 0.015]);
    expect(built.metrics.totalFlexureCount).toBe(1);
    expect(built.metrics.tipForceN as number).toBeGreaterThan(0);
    expect(built.metrics.engageForceN as number).toBeGreaterThan(0);
    expect(built.metrics.evaluation).toBeDefined();
    expect(Array.isArray(built.metrics.warnings)).toBe(true);

    const xml = compileToMJCF({ nodes: built.nodes }, -9.81, 1, 0, 0, 0);
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    try {
      for (let i = 0; i < 100; i++) mj.mj_step(m, d);
      expect(Number.isFinite(d.qpos[0])).toBe(true);
    } finally {
      d.delete();
      m.delete();
    }
  });

  it('supports monolithicPrint: true to emit a flattened printable solid body', () => {
    const mono = ok(
      buildMechanism(
        {
          family: 'compliant_gripper',
          beamsPerJaw: 3,
          monolithicPrint: true,
          idPrefix: 'mono_grip',
        },
        [],
      ),
    );
    expect(mono.nodes).toHaveLength(1);
    expect(mono.nodes[0].children).toEqual([]);
    expect(mono.nodes[0].joints).toEqual([]);
    expect(mono.nodes[0].geoms.length).toBe(13);
    const promotedLeaves = mono.nodes[0].geoms.filter((g) => g.name.includes('flexure_parallel_'));
    expect(promotedLeaves).toHaveLength(6);
    expect(promotedLeaves.every((g) => g.role === undefined && g.bend === undefined)).toBe(true);
  });

  it('surfaces engineering warnings in both metrics.warnings and top-level BUILD_MECHANISM response', async () => {
    const ctx: any = {
      store: { sceneGraph: { nodes: [] as SceneNode[] } },
    };
    const res = (await partBuildCommands.BUILD_MECHANISM(
      {
        family: 'compliant_gripper',
        filament: 'pla',
        idPrefix: 'pla_grip',
      },
      ctx,
    )) as Record<string, any>;

    expect(res.ok).toBe(true);
    expect(res.family).toBe('compliant_gripper');
    expect(res.addedIds).toEqual(['pla_grip_base', 'pla_grip_jaw_left', 'pla_grip_jaw_right']);
    expect(res.metrics.totalFlexureCount).toBe(6);
    expect(res.metrics.pinchForceAtStrokeN).toBeGreaterThan(0);
    expect(res.metrics.parasiticShiftMm).toBeGreaterThan(0);
    expect(res.metrics.warnings.some((w: string) => w.includes('PLA'))).toBe(true);
    expect(res.warnings.some((w: string) => w.includes('PLA'))).toBe(true);
  });
});
