// Four paraboloid bowls dropped into each other, with colliders that are
// right (helpers/bowls.ts: cut exactly from the profile, ~0.1 mm proud).
//
// The scene that started this — bowls dropped 24 mm apart, each 3 mm further
// over, colliding as 64 V-HACD pieces — settled at bases of 3/14/39/26 mm
// against 0/4/8/12, tilted, one 23 mm off the axis. Three things stack up,
// and only one is the colliders:
//
// * Soft contact. The scene default (solref 0.02 s) lets a bowl landing at
//   ~1 m/s sink about v·τ = 20 mm into the one below, through a 4 mm wall. On
//   exact pieces, dropped coaxially, the stack came out INVERTED: the smallest
//   bowl on the floor at 0, the largest on top at 12.4 mm. At solref 0.005 the
//   same drop settles at 0/4.2/8.4/12.5 mm, level.
// * The 64-piece cap for free bodies leaves these bowls' pieces 0.9 to 2.3 mm
//   proud: nested 0.5 mm apart and stiff, they settle 0/6.8/13.4/19.1 mm —
//   ~2.4 mm high a level. 513 exact pieces fit, but step at 18 to 36 ms per
//   millisecond step against 2 to 3 ms at 64 (contactArena.ts).
// * The 3 mm offsets: identical paraboloids nest with no clearance, so one
//   set down off the axis touches at its rim and friction holds it there —
//   on exact pieces, stiff, 5 to 10 mm off axis and ~1 mm high a level.
//
// MuJoCo's multiccd flag changed nothing: identical to a tenth of a mm.

import { afterAll, describe, expect, it } from 'vitest';
import { nestingBowls } from './helpers/bowls';
import { simulate, type Sim } from './helpers/simulate';

const sims: Sim[] = [];
afterAll(() => { for (const s of sims) s.dispose(); });

/** Each bowl's base height, mm, after `seconds`. */
async function settle(solref: number[] | undefined, seconds: number): Promise<number[]> {
  const nodes = nestingBowls(32, i => [0, 0, 0.002 + 0.024 * i], solref ? { solref } : {});
  const sim = await simulate({ nodes } as never);
  sims.push(sim);
  sim.run(seconds);
  return nodes.map(n => sim.bodyPos(n.name)[2] * 1000);
}

describe('nesting bowls dropped on each other', () => {
  it('settle nested 4 mm apart with stiff contact', async () => {
    const z = await settle([0.005, 1], 1.5);
    // 32 sectors by 8 bands: each stands up to ~0.6 mm high on the one below.
    z.forEach((v, i) => expect(Math.abs(v - 4 * i)).toBeLessThan(0.2 + 0.6 * i));
  }, 120_000);

  it('fall through each other at the scene default, which is not the colliders', async () => {
    const z = await settle(undefined, 1.5);
    // Not stacked in order: some smaller bowl ended below a larger one.
    expect(z.some((v, i) => i > 0 && v < z[i - 1])).toBe(true);
  }, 120_000);
});
