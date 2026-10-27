// Breaking under load, beyond spaghetti and putty: the same mechanism on
// other materials, other sections and other joints, each against an answer
// worked out by hand.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { runWithBreaks } from './breakHarness';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildBreakModel } from '../src/utils/breakModel';
import { memberShape, sectionLimits } from '../src/utils/memberStrength';
import { deformMaterial, loadStrengthOf, resolveLoadStrength } from '../src/utils/deformMaterials';
import { faceJoinLimits, joinMaterial } from '../src/utils/joinMaterials';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

type V3 = [number, number, number];

const body = (id: string, pos: V3, geom: Omit<SceneGeom, 'name'>, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos, children: [],
  joints: [{ name: `${id}_free`, type: 'free' }],
  geoms: [{ name: `${id}_g`, ...geom } as SceneGeom],
  ...extra,
});
const fixed = (n: SceneNode): SceneNode => ({ ...n, joints: [] });
const blob = (id: string, pos: V3, r: number, material: string, kg?: number): SceneNode =>
  body(id, pos, { type: 'sphere', size: [r], ...(kg !== undefined ? { mass: kg } : { density: 1000 }) }, { joinMaterial: material });

describe('members of any material', () => {
  it('a glass bar on two supports snaps at mid-span at P = 4M/L', () => {
    const glass = deformMaterial('glass')!;
    const L = 0.1;
    // A 6 x 6 mm bar 150 mm long across supports 100 mm apart.
    const bar = body('bar', [0, 0, 0.053], { type: 'box', size: [0.075, 0.003, 0.003], density: glass.density }, { loadStrength: { ...glass.strength } });
    const limits = sectionLimits(memberShape(bar)!, glass.strength);
    const failKg = (4 * limits.bendingNm) / (L * 9.81);
    const scene = (kg: number): SceneGraph => ({
      nodes: [
        fixed(body('left', [-L / 2, 0, 0.025], { type: 'box', size: [0.005, 0.02, 0.025] })),
        fixed(body('right', [L / 2, 0, 0.025], { type: 'box', size: [0.005, 0.02, 0.025] })),
        bar,
        body('weight', [0, 0, 0.0565], { type: 'box', size: [0.004, 0.02, 0.0005], mass: kg }),
      ],
    });
    const holds = runWithBreaks(mj, scene(0.6 * failKg), 1);
    expect(holds.events).toEqual([]);
    holds.done();
    const snaps = runWithBreaks(mj, scene(1.5 * failKg), 1);
    expect(snaps.events[0]?.key).toBe('member:bar');
    expect(snaps.events[0]?.cause).toBe('bent');
    snaps.done();
  });

  it('a hardwood plank snaps at its root laid flat, and holds the same weight on edge', () => {
    const wood = deformMaterial('hardwood')!;
    const L = 0.2;
    // 20 x 4 mm, 30 mm into a block of epoxy that outholds it. `size` and
    // `quat` give the same plank in the world three ways: flat, on edge, and
    // on edge again but built in a body turned 90 degrees about its length,
    // so the moment has to be read in the body's own frame to come out right.
    const plank = (size: V3, quat?: number[]) =>
      body('plank', [L / 2, 0, 0.3], { type: 'box', size, ...(quat ? { quat } : {}), density: wood.density }, { loadStrength: { ...wood.strength } });
    const flat = plank([L / 2, 0.01, 0.002]);
    const weakNm = sectionLimits(memberShape(flat)!, wood.strength).bendingNm;
    const kg = (2 * weakNm) / (9.81 * L);
    const scene = (p: SceneNode): SceneGraph => ({
      nodes: [fixed(blob('block', [0, 0, 0.3], 0.03, 'epoxy')), p, blob('tip', [L, 0, 0.3], 0.004, 'epoxy', kg)],
    });
    const f = runWithBreaks(mj, scene(flat), 1);
    // Twice its limit at the root is its limit at mid-span: either may go first.
    expect(['join:block>plank', 'member:plank']).toContain(f.events[0]?.key);
    expect(f.events[0]?.cause).toBe('bent');
    expect(f.bodyPos('tip')[2]).toBeLessThan(0.1);
    f.done();
    for (const onEdge of [plank([L / 2, 0.002, 0.01]), plank([L / 2, 0.01, 0.002], [Math.SQRT1_2, Math.SQRT1_2, 0, 0])]) {
      const e = runWithBreaks(mj, scene(onEdge), 1);
      expect(e.events).toEqual([]);
      expect(e.bodyPos('tip')[2]).toBeGreaterThan(0.29);
      e.done();
    }
  });

  it('a steel bar bends and stays bent, where glass of the same size snaps', () => {
    const make = (id: string): SceneGraph => {
      const m = deformMaterial(id)!;
      const L = 0.2;
      const rod = body('rod', [L / 2, 0, 0.3], { type: 'cylinder', size: [0.002, L / 2], quat: [Math.SQRT1_2, 0, Math.SQRT1_2, 0], density: m.density }, { loadStrength: { ...m.strength } });
      const yieldNm = sectionLimits(memberShape(rod)!, m.strength).bendingNm;
      return { nodes: [fixed(blob('wall', [0, 0, 0.3], 0.03, 'epoxy')), rod, blob('tip', [L, 0, 0.3], 0.004, 'epoxy', (3 * yieldNm) / (9.81 * L))] };
    };
    const steel = runWithBreaks(mj, make('steel'), 2);
    expect(steel.events.map((e) => e.key)).toContain('member:rod');
    expect(steel.bodyPos('tip')[2]).toBeGreaterThan(0.1);
    steel.done();
    const glass = runWithBreaks(mj, make('glass'), 2);
    // Over its limit at the root and at mid-span alike: it snaps, whichever goes first.
    expect(['join:wall>rod', 'member:rod']).toContain(glass.events[0]?.key);
    expect(glass.bodyPos('tip')[2]).toBeLessThan(0.05);
    glass.done();
  });
});

describe('joints of any material', () => {
  it('a block pressed into a marshmallow holds a light weight and drops a heavy one', () => {
    const m = joinMaterial('marshmallow')!;
    const r = 0.01;
    const pullN = faceJoinLimits(m, r).pullN;
    const scene = (kg: number): SceneGraph => ({
      nodes: [
        fixed(blob('mallow', [0, 0, 0.3], r, 'marshmallow')),
        // Its top 3 mm inside the ball's bottom.
        body('block', [0, 0, 0.3 - r - 0.01 + 0.003], { type: 'box', size: [0.01, 0.01, 0.01], mass: kg }),
      ],
    });
    const holds = runWithBreaks(mj, scene((0.5 * pullN) / 9.81), 1);
    expect(holds.events).toEqual([]);
    expect(holds.bodyPos('block')[2]).toBeGreaterThan(0.25);
    holds.done();
    const drops = runWithBreaks(mj, scene((2 * pullN) / 9.81), 1);
    expect(drops.events[0]?.cause).toBe('pulled');
    expect(drops.bodyPos('block')[2]).toBeLessThan(0.05);
    drops.done();
  });

  it('a rod in putty swings on it like a pin, and pulls out when overloaded', () => {
    const putty = (tipKg: number): SceneGraph => ({
      nodes: [
        fixed(blob('lump', [0, 0, 0.4], 0.008, 'putty')),
        body('rod', [0.05, 0, 0.4], { type: 'cylinder', size: [0.0015, 0], fromto: [-0.05, 0, 0, 0.05, 0, 0], density: 700 }),
        blob('tip', [0.1, 0, 0.4], 0.003, 'epoxy', tipKg),
      ],
    });
    const swings = runWithBreaks(mj, putty(0.002), 3);
    // Swung down from level, on nothing but the pin, and still in the putty:
    // the tip is still the rod's length from it.
    const tip = swings.bodyPos('tip');
    expect(tip[2]).toBeLessThan(0.39);
    expect(Math.hypot(tip[0], tip[1], tip[2] - 0.4)).toBeCloseTo(0.1, 2);
    expect(swings.events).toEqual([]);
    swings.done();
    const pulls = runWithBreaks(mj, putty(0.5), 2);
    expect(pulls.events.some((e) => e.key === 'pin:lump>rod')).toBe(true);
    expect(pulls.bodyPos('tip')[2]).toBeLessThan(0.05);
    pulls.done();
  });
});

describe('frames from the Pipes dialog', () => {
  it('a box framed in spaghetti stands on its putty when braced, and folds when not', async () => {
    const { frameBodyInScene } = await import('../src/utils/pipeSkeleton');
    const cube: SceneGraph = { nodes: [fixed(body('b', [0, 0, 0.05], { type: 'box', size: [0.05, 0.05, 0.05] }))] };
    const run = (diagonals: boolean) => {
      const framed = frameBodyInScene(cube, 'b', { pipeStandardId: 'spaghetti', diagonals });
      // A 30 g weight on top, set down with a nudge sideways: a square of
      // pins balances under a load straight down until something pushes it.
      const top = Math.max(...framed.nodes.filter((n) => n.joinMaterial).map((n) => n.pos[2]));
      const scene: SceneGraph = { nodes: [...framed.nodes, body('w', [0, 0, top + 0.012], { type: 'box', size: [0.07, 0.07, 0.003], mass: 0.03 })] };
      const r = runWithBreaks(mj, scene, 2, {
        before: (model, data) => {
          const j = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'w_free');
          data.qvel[model.jnt_dofadr[j]] = 0.2;
        },
      });
      const sag = (top + 0.012 - r.bodyPos('w')[2]) * 1000;
      r.done();
      return sag;
    };
    expect(run(true)).toBeLessThan(3);
    expect(run(false)).toBeGreaterThan(20);
  });
});

describe('what compiles', () => {
  it('only free, slender members are split', () => {
    const st = deformMaterial('hardwood')!.strength;
    const stubby = body('stubby', [0, 0, 0.1], { type: 'box', size: [0.02, 0.02, 0.02] }, { loadStrength: st });
    const pinned = fixed(body('pinned', [0, 0.2, 0.1], { type: 'cylinder', size: [0.002, 0.05] }, { loadStrength: st }));
    const rod = body('rod', [0, 0.4, 0.1], { type: 'capsule', size: [0.002, 0.05] }, { loadStrength: st });
    const nodes = [stubby, pinned, rod].map((n) => ({ ...n, geoms: n.geoms.map((g) => ({ ...g })) }));
    const m = buildBreakModel(nodes);
    expect(m.numerics.map((n) => n.name)).toEqual(['member:rod']);
    expect(nodes.map((n) => n.name)).toEqual(['stubby', 'pinned', 'rod', 'rod~2']);
  });

  it('a putty blob stops turning; a glue blob does not', () => {
    const xml = compileToMJCF({
      nodes: [
        blob('p', [0, 0, 0.1], 0.005, 'putty'), body('a', [0.05, 0, 0.1], { type: 'cylinder', size: [0.001, 0.05], fromto: [-0.05, 0, 0, 0.05, 0, 0] }),
        blob('g', [0, 0.2, 0.1], 0.005, 'hotGlue'), body('b', [0.05, 0.2, 0.1], { type: 'cylinder', size: [0.001, 0.05], fromto: [-0.05, 0, 0, 0.05, 0, 0] }),
      ],
    } as SceneGraph);
    expect(xml).toMatch(/<body name="p"[^>]*><joint name="p_free_x" type="slide"/);
    expect(xml).toMatch(/<body name="g"[^>]*><freejoint name="g_free"/);
    expect(xml).toContain('<connect name="pin:p&gt;a"');
    expect(xml).toContain('<weld name="join:g&gt;b"');
    const model = mj.MjModel.from_xml_string(xml);
    model.delete();
  });

  it('reads loadStrength however it was written', () => {
    expect(resolveLoadStrength('steel', undefined)).toEqual({ value: deformMaterial('steel')!.strength });
    expect(resolveLoadStrength(true, 'glass')).toEqual({ value: deformMaterial('glass')!.strength });
    expect(resolveLoadStrength(false, 'glass')).toEqual({ value: undefined });
    expect('error' in resolveLoadStrength('plasticine', undefined)).toBe(true);
    expect('error' in resolveLoadStrength({ flexuralMPa: 10 }, undefined)).toBe(true);
    expect(loadStrengthOf({ loadStrength: 'pasta' } as unknown as SceneNode)).toEqual(deformMaterial('pasta')!.strength);
  });
});
