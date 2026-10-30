// Contact memory for many convex pieces (utils/contactArena.ts).
//
// Four nesting paraboloid bowls at 512 pieces each ran MuJoCo out of its
// default 15 MiB arena at their first touch — "mj_stackAlloc: out of
// memory" — and the simulation stopped. Settled, the arena fills and
// MuJoCo quietly drops contacts instead. The pieces here are each bowl cut
// exactly, 64 sectors by 8 bands and one round the axis (helpers/bowls.ts).

import load_mujoco from '@mujoco/mujoco';
import { describe, expect, it } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import { contactArenaBytes, DEFAULT_ARENA } from '../src/utils/contactArena';
import { nestingBowls } from './helpers/bowls';

const bowls = (sectors: number) => nestingBowls(sectors, i => [0, 0, 0.004 * i + 0.0002]);

describe('contact memory for convex pieces', () => {
  it('leaves the default alone for one free body at the 64-piece default', () => {
    const one = bowls(8).slice(0, 1);
    expect(contactArenaBytes(one)).toBeNull();
    expect(compileToMJCF({ nodes: one } as never, -9.81, 1, 0, 0, 0, 0)).not.toMatch(/<size memory/);
    // And a static part is never counted, however many pieces.
    expect(contactArenaBytes(bowls(64).map(b => ({ ...b, joints: [] })))).toBeNull();
  });

  it('asks for more for four bowls of 513 set down nested, and has room for every contact', async () => {
    const nodes = bowls(64);
    expect(contactArenaBytes(nodes)).toBeGreaterThan(DEFAULT_ARENA);
    const xml = compileToMJCF({ nodes } as never, -9.81, 1, 0, 0, 0, 0);
    expect(xml).toMatch(/<size memory="\d+M" \/>/);
    const mj = await load_mujoco();
    const run = (x: string) => {
      const model = mj.MjModel.from_xml_string(x);
      const data = new mj.MjData(model);
      try {
        for (let k = 0; k < 100; k++) mj.mj_step(model, data);
        return { arena: model.narena, used: data.maxuse_arena, contacts: data.ncon };
      } finally {
        data.delete();
        model.delete();
      }
    };
    // Without it the arena fills to the last byte and MuJoCo drops contacts
    // (19,560 kept); a drop rather than a settle ends at "mj_stackAlloc: out
    // of memory" in the solver, and the simulation stops.
    const small = run(xml.replace(/ *<size memory="\d+M" \/>\n/, ''));
    expect(small.arena).toBe(DEFAULT_ARENA);
    expect(small.arena - small.used).toBeLessThan(1024);
    const big = run(xml);
    expect(big.used).toBeGreaterThan(DEFAULT_ARENA);
    expect(big.used).toBeLessThan(big.arena);
  }, 120_000);
});
