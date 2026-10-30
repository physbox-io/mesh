// Contact memory for many convex pieces (utils/contactArena.ts).
//
// Four nesting paraboloid bowls at 512 pieces each ran MuJoCo out of its
// default 15 MiB arena at their first touch — "mj_stackAlloc: out of
// memory" — and the simulation stopped. Settled, the arena fills and
// MuJoCo quietly drops contacts instead. The pieces here are each bowl cut
// exactly into 64 sectors by 8 profile bands round a single piece on the
// axis (513), built straight from the profile so the test does not spend a
// minute in V-HACD.

import load_mujoco from '@mujoco/mujoco';
import { describe, expect, it } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import { contactArenaBytes, DEFAULT_ARENA } from '../src/utils/contactArena';
import { colliderTemplateOf, convexHullOf, hullsToColliderGeoms, type Hull } from '../src/utils/csg';
import type { SceneNode } from '../src/types/scene';
import { paraboloidBowl, zupToYupFlat } from './helpers/meshes';

const A = 10, T = 0.004, R0 = 0.0005, N = 32, SEG = 64;
const RIMS = [0.055, 0.045, 0.035, 0.025];

/** One piece round the axis, then `sectors` x bands of `band` profile steps. */
function bowlPieces(h: number, sectors: number, band: number): Hull[] {
  const R = Math.sqrt(h / A);
  const at = (k: number, j: number, inner: boolean) => {
    const r = R0 + ((R - R0) * k) / N, th = (2 * Math.PI * j) / SEG;
    return [r * Math.cos(th), r * Math.sin(th), A * r * r + (inner ? T : 0)];
  };
  const hull = (ks: number[], js: number[]) => {
    const pts = ks.flatMap(k => js.flatMap(j => [at(k, j, false), at(k, j, true)]));
    const hl = convexHullOf(pts)!;
    return { ...hl, volume: Math.abs(hl.volume) };
  };
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const out = [hull([0, 1], range(0, SEG - 1))];
  const per = SEG / sectors;
  for (let k = 1; k < N; k += band) {
    for (let s = 0; s < sectors; s++) out.push(hull(range(k, Math.min(N, k + band)), range(s * per, (s + 1) * per)));
  }
  return out;
}

function bowls(sectors: number): SceneNode[] {
  return RIMS.map((h, i) => {
    const m = paraboloidBowl(h);
    const src = { name: `bowl${i}_m`, type: 'mesh' as const, size: [1], dynamic: true, density: 1200, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces };
    const hulls = bowlPieces(h, sectors, 4);
    const pieces = hullsToColliderGeoms(hulls, `bowl${i}`, colliderTemplateOf(src, [0.3, 0.6, 0.9, 1]), 1200 * hulls.reduce((v, p) => v + p.volume, 0))
      .map(g => ({ ...g, colliderOf: src.name }));
    // Set down nested, 0.2 mm above where each rests: every piece touches.
    return {
      id: `bowl${i}`, name: `bowl${i}`, type: 'body', pos: [0, 0, 0.004 * i + 0.0002], children: [],
      joints: [{ name: `bowl${i}_free`, type: 'free' }], geoms: [src, ...pieces],
      collisionHash: 'test', collisionDecomposed: true,
    } as SceneNode;
  });
}

describe('contact memory for convex pieces', () => {
  it('leaves the default alone for four free bodies at the 64-piece default', () => {
    expect(contactArenaBytes(bowls(16).map(b => ({ ...b, geoms: b.geoms!.slice(0, 65) })))).toBeNull();
    expect(compileToMJCF({ nodes: bowls(8) } as never, -9.81, 1, 0, 0, 0, 0)).not.toMatch(/<size memory/);
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
