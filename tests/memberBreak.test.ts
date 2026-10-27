// Members that break under load, and joints that let go, in real MuJoCo.
//
// Each case is a textbook one whose answer is known in advance: a column
// buckles at its Euler load, a cantilever snaps at its root at M = m g L, a
// ductile rod bends and stays bent where friction balances its weight.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { runWithBreaks } from './breakHarness';
import { puttyBlob, strand } from '../src/presets/spaghetti';
import { sectionLimits, memberShape } from '../src/utils/memberStrength';
import { deformMaterial } from '../src/utils/deformMaterials';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

type V3 = [number, number, number];

/** A blob of `material`, fixed in place when `fixed`, weighing `kg` when given. */
function blob(id: string, p: V3, r: number, material: string, opts: { fixed?: boolean; kg?: number } = {}): SceneNode {
  const n = puttyBlob(id, p, r);
  n.joinMaterial = material;
  if (opts.fixed) n.joints = [];
  if (opts.kg !== undefined) n.geoms[0] = { ...n.geoms[0], mass: opts.kg, density: undefined };
  return n;
}

const PASTA = deformMaterial('pasta')!.strength;

describe('members under load', () => {
  it('a pasta column carries its load below the Euler load and buckles above it', () => {
    const L = 0.1;
    const column = (kg: number): SceneGraph => ({
      nodes: [
        blob('base', [0, 0, 0.02], 0.006, 'epoxy', { fixed: true }),
        strand('col', [0, 0, 0.02], [0, 0, 0.02 + L]),
        blob('top', [0, 0, 0.02 + L], 0.006, 'epoxy', { kg }),
      ],
    });
    const limits = sectionLimits(memberShape(strand('x', [0, 0, 0], [0, 0, L]))!, PASTA);
    expect(limits.bucklingN).toBeGreaterThan(1.5);
    expect(limits.bucklingN).toBeLessThan(2.5);

    const light = runWithBreaks(mj, column((0.6 * limits.bucklingN) / 9.81), 1);
    // Pressed together reads positive: this is what COMPRESSION_SIGN is for.
    expect(light.peakPush['member:col']).toBeGreaterThan(0.5 * limits.bucklingN);
    expect(light.events).toEqual([]);
    light.done();

    const heavy = runWithBreaks(mj, column((1.4 * limits.bucklingN) / 9.81), 1);
    expect(heavy.events.map((e) => [e.key, e.cause])).toContainEqual(['member:col', 'buckled']);
    heavy.done();
  });

  it('a pasta cantilever snaps at its root, at m g L', () => {
    const L = 0.1;
    const limits = sectionLimits(memberShape(strand('x', [0, 0, 0], [L, 0, 0]))!, PASTA);
    const cantilever = (kg: number): SceneGraph => ({
      nodes: [
        blob('wall', [0, 0, 0.2], 0.008, 'hotGlue', { fixed: true }),
        strand('arm', [0, 0, 0.2], [L, 0, 0.2]),
        blob('tip', [L, 0, 0.2], 0.004, 'hotGlue', { kg }),
      ],
    });
    const failKg = limits.bendingNm / (9.81 * L);

    const holds = runWithBreaks(mj, cantilever(0.6 * failKg), 1);
    expect(holds.events).toEqual([]);
    holds.done();

    const snaps = runWithBreaks(mj, cantilever(1.5 * failKg), 1);
    const first = snaps.events[0];
    expect(first?.key).toBe('join:wall>arm');
    expect(first?.cause).toBe('bent');
    snaps.done();
  });

  it('an aluminium rod bends and stays bent instead of breaking', () => {
    const L = 0.2;
    const rod = strand('rod', [0, 0, 0.3], [L, 0, 0.3]);
    rod.geoms[0] = { ...rod.geoms[0], size: [0.0015, 0], density: 2700 };
    rod.loadStrength = { ...deformMaterial('softMetal')!.strength };
    rod.deformMaterial = 'softMetal';
    const yieldNm = sectionLimits(memberShape(rod)!, rod.loadStrength).bendingNm;
    // Enough at the tip to bend the middle (moment there m g L/2), with the
    // root held by a blob of epoxy big enough not to be the weak point.
    const kg = (2.5 * yieldNm) / (9.81 * L);
    const scene: SceneGraph = {
      nodes: [
        blob('wall', [0, 0, 0.3], 0.02, 'epoxy', { fixed: true }),
        rod,
        blob('tip', [L, 0, 0.3], 0.004, 'epoxy', { kg }),
      ],
    };
    const r = runWithBreaks(mj, scene, 2);
    expect(r.events.map((e) => e.key)).toContain('member:rod');
    const tipA = r.bodyPos('tip');
    // Bent down, but still held: not on the floor, and no longer moving.
    expect(tipA[2]).toBeLessThan(0.29);
    expect(tipA[2]).toBeGreaterThan(0.12);
    const more = runWithBreaks(mj, scene, 3);
    expect(Math.abs(more.bodyPos('tip')[2] - tipA[2])).toBeLessThan(0.01);
    r.done(); more.done();
  });
});
