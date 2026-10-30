// Mass or density written on a body that has geoms.
//
// Reported: both were silently ignored. MJCF weighs a body as the sum of its
// geoms and has no body-level mass short of a full <inertial>, so the field
// sat in the graph unread and the body weighed its volume in water. The
// compiler now hands them to the geoms it emits (utils/bodyMass): density to
// every solid geom that states none, mass as the body's total, shared in
// proportion to what each geom would weigh.

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { applyBodyMass } from '../src/utils/bodyMass';
import type { SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** Two boxes, 1 L and 3 L, on a free body. */
const crate = (extra: Partial<SceneNode> = {}, geomExtra: Record<string, unknown>[] = [{}, {}]): SceneNode => ({
  id: 'crate', name: 'crate', pos: [0, 0, 0.5], children: [],
  joints: [{ name: 'crate_free', type: 'free' }],
  geoms: [
    { name: 'small', type: 'box', size: [0.05, 0.05, 0.05], pos: [-0.2, 0, 0], ...geomExtra[0] },
    { name: 'big', type: 'box', size: [0.15, 0.05, 0.05], pos: [0.2, 0, 0], ...geomExtra[1] },
  ],
  ...extra,
} as SceneNode);

const massOf = (nodes: SceneNode[], name: string): number => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const kg = m.body_mass[mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, name)] as number;
  m.delete();
  return kg;
};

describe('body-level mass and density', () => {
  it('a body mass is the body mass (was 4 kg of water)', () => {
    expect(massOf([crate()], 'crate')).toBeCloseTo(4, 6); // unchanged without one
    expect(massOf([crate({ mass: 2 })], 'crate')).toBeCloseTo(2, 6);
  });

  it('is shared by volume, so the centre of mass stays where the shape puts it', () => {
    const geoms = applyBodyMass(crate({ mass: 2 }));
    expect(geoms[0].mass).toBeCloseTo(0.5, 9);
    expect(geoms[1].mass).toBeCloseTo(1.5, 9);
  });

  it("keeps the geoms' own proportions where they state masses", () => {
    const geoms = applyBodyMass(crate({ mass: 3 }, [{ mass: 1 }, { density: 1000 }]));
    // 1 kg against 3 L of water: one to three, scaled to 3 kg.
    expect(geoms[0].mass).toBeCloseTo(0.75, 9);
    expect(geoms[1].mass).toBeCloseTo(2.25, 9);
  });

  it('a body density applies to every geom that states none', () => {
    expect(massOf([crate({ density: 500 })], 'crate')).toBeCloseTo(2, 6);
    // A geom with its own density keeps it.
    expect(massOf([crate({ density: 500 }, [{ density: 1000 }, {}])], 'crate')).toBeCloseTo(2.5, 6);
  });

  it('a visual geom stays weightless', () => {
    const n = crate({ mass: 2 });
    n.geoms.push({ name: 'shell', type: 'sphere', size: [0.5], role: 'visual' });
    expect(massOf([n], 'crate')).toBeCloseTo(2, 6);
    expect(applyBodyMass(n)[2].mass).toBeUndefined();
  });

  it('arrives over MCP: build_scene with mass on a body that lists geoms', () => {
    const node = fillBodyDefaults({
      name: 'crate', pos: [0, 0, 0.5], mass: 2,
      geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }, { type: 'box', size: [0.15, 0.05, 0.05], pos: [0.3, 0, 0] }],
    } as never);
    expect(massOf([node], 'crate')).toBeCloseTo(2, 6);
  });

  it('leaves a boolean body to csgMass', () => {
    const n = crate({ mass: 2, csgMass: 7 });
    expect(applyBodyMass(n)).toBe(n.geoms);
  });

  it('does not touch the graph it was given', () => {
    const n = crate({ mass: 2 });
    compileToMJCF({ nodes: [n] }, -9.81, 1, 0, 0, 0);
    expect(n.geoms[0].mass).toBeUndefined();
  });
});
