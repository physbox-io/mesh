/**
 * No cloth through cloth: none made as a scene runs (continuous collision,
 * clothCcd), and none where it is first shown (its cloth built and sewn)
 * but where a builder still models pieces through each other (STARTS_CROSSED). A piece through its own garment,
 * one garment through another, a fold through itself: each is an edge of one
 * sheet through a triangle of another (clothUntangle's findCrossings), and a
 * crossing once made is kept by contact, which holds each point on its side.
 *
 * Every preset with cloth, as it ships.
 */
import { describe, expect, it } from 'vitest';
import { clothRun } from './clothSimHarness';
import { PRESETS } from '../src/presets/presetScenes';
import { findCrossings, untangleMesh } from '../src/utils/cloth/clothUntangle';
import type { SceneNode } from '../src/types';

const hasCloth = (nodes: SceneNode[]): boolean => nodes.some((n) => !!(n as { cloth?: unknown }).cloth || hasCloth(n.children ?? []));
const CLOTH_PRESETS = Object.entries(PRESETS).filter(([, p]) => hasCloth(p.scene.nodes)).map(([k]) => k);

/** Seconds run after the build. */
const RUN = 1;
/**
 * Crossings a scene may still start with, where a builder models pieces
 * through each other (collars stand through fall and through the collar
 * under them, lapped fronts, pleats folded through themselves, a sleeve
 * through its armhole) and untangling at the build does not undo it all.
 * A ratchet: lower these as builders are fixed; every other preset starts
 * with none. The untangling runs for a set time, so a little over today's.
 */
/**
 * Through, not touching: both ends of the edge further than this either side
 * of the triangle, metres (the thinnest cloth here is 0.5 mm). Two points
 * tacked flat onto one triangle hold their edge in its plane, and rounding
 * reads it through it.
 */
const THROUGH = 2e-4;

const STARTS_CROSSED: Record<string, number> = {
  urban_collection: 280,
  shirt_and_jacket_on_form: 6,
  boned_gown_on_form: 200,
  gathers_and_pleats_on_form: 60,
};

describe('cloth never passes through cloth', () => {
  it('there are cloth presets to check', () => expect(CLOTH_PRESETS.length).toBeGreaterThan(5));
  for (const name of CLOTH_PRESETS) {
    it(name, async () => {
      const r = await clothRun(structuredClone(PRESETS[name].scene.nodes) as SceneNode[]);
      const sim = r.sim as unknown as { n: number; x: Float64Array; tris: Int32Array; stitches: Int32Array };
      const group = new Array<string>(sim.n);
      let base = 0;
      for (const m of r.models) { for (const g of m.groups) for (const i of g.particles) group[base + i] = g.name; base += m.invMass.length; }
      const mesh = untangleMesh(sim.n, sim.tris, sim.stitches);
      /** How far through: the nearer end of the edge from the triangle's plane. */
      const depth = (c: { a: number; b: number; t: number }) => {
        const X = sim.x, T = sim.tris, i0 = 3 * T[3 * c.t], i1 = 3 * T[3 * c.t + 1], i2 = 3 * T[3 * c.t + 2];
        const u = [X[i1] - X[i0], X[i1 + 1] - X[i0 + 1], X[i1 + 2] - X[i0 + 2]], v = [X[i2] - X[i0], X[i2 + 1] - X[i0 + 1], X[i2 + 2] - X[i0 + 2]];
        const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        const d = (q: number) => Math.abs((X[3 * q] - X[i0]) * nn[0] + (X[3 * q + 1] - X[i0 + 1]) * nn[1] + (X[3 * q + 2] - X[i0 + 2]) * nn[2]) / nl;
        return Math.min(d(c.a), d(c.b));
      };
      const where = () => {
        const pairs = new Map<string, number>();
        for (const c of findCrossings(sim.x, mesh)) { const k = [group[c.a], group[sim.tris[3 * c.t]]].sort().join(' x '); pairs.set(k, (pairs.get(k) ?? 0) + 1); }
        return Object.fromEntries([...pairs].sort((a, b) => b[1] - a[1]));
      };
      const count = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
      const first = where(), atStart = count(first);
      if (!(name in STARTS_CROSSED)) expect(first, 'as first shown').toEqual({});
      else expect(atStart, `as first shown: ${JSON.stringify(first)}`).toBeLessThanOrEqual(STARTS_CROSSED[name]);
      // The cloth at those crossings (their points, and two rings of triangles round them): it is through already, and may shift there.
      const at = new Uint8Array(sim.n);
      for (const c of findCrossings(sim.x, mesh)) { at[c.a] = at[c.b] = 1; for (let k = 0; k < 3; k++) at[sim.tris[3 * c.t + k]] = 1; }
      for (let ring = 0; ring < 2; ring++) {
        const next = at.slice();
        for (let t = 0; t < sim.tris.length; t += 3) if (at[sim.tris[t]] || at[sim.tris[t + 1]] || at[sim.tris[t + 2]]) next[sim.tris[t]] = next[sim.tris[t + 1]] = next[sim.tris[t + 2]] = 1;
        at.set(next);
      }
      r.run(RUN);
      // Running makes no crossing anywhere the cloth was not through already: nothing goes through.
      const fresh: Record<string, number> = {};
      for (const c of findCrossings(sim.x, mesh)) {
        if (at[c.a] || at[c.b] || at[sim.tris[3 * c.t]] || at[sim.tris[3 * c.t + 1]] || at[sim.tris[3 * c.t + 2]]) continue;
        if (depth(c) < THROUGH) continue;
        const k = [group[c.a], group[sim.tris[3 * c.t]]].sort().join(' x ');
        fresh[k] = (fresh[k] ?? 0) + 1;
      }
      expect(fresh, `new crossings after ${RUN} s`).toEqual({});
    }, 1_200_000);
  }
});
