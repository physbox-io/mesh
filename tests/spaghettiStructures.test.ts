// The spaghetti presets in real MuJoCo, through the real compiler and the
// worker's break check: nothing in them is fixed, so whatever stands is the
// putty holding it, and whatever folds is the putty giving.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { runWithBreaks } from './breakHarness';
import { spaghettiBridgePreset, spaghettiTowersPreset } from '../src/presets/spaghetti';
import type { SceneGraph } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const startZ = (scene: SceneGraph, name: string) => scene.nodes.find((n) => n.name === name)!.pos[2];

describe('spaghetti structures', () => {
  it('the triangulated tower stands, and the square one folds', () => {
    const r = runWithBreaks(mj, spaghettiTowersPreset, 3);
    const drop = (n: string) => (startZ(spaghettiTowersPreset, n) - r.bodyPos(n)[2]) * 1000;
    console.log('tri top drop mm', drop('tri_n12').toFixed(2), 'sq top drop mm', drop('sq_n12').toFixed(2),
      'events', r.events.length, 'realtime', r.realtime.toFixed(2));
    expect(drop('tri_n12')).toBeLessThan(3);
    expect(drop('sq_n12')).toBeGreaterThan(30);
    r.done();
  }, 120_000);

  it('the bridge carries its weight', () => {
    const r = runWithBreaks(mj, spaghettiBridgePreset, 3);
    const drop = (startZ(spaghettiBridgePreset, 'br_load') - r.bodyPos('br_load')[2]) * 1000;
    console.log('load drop mm', drop.toFixed(2), 'events', r.events.length, r.events.slice(0, 4).map((e) => `${e.key}:${e.cause}`).join(' '), 'realtime', r.realtime.toFixed(2));
    expect(drop).toBeLessThan(5);
    r.done();
  }, 120_000);
});
