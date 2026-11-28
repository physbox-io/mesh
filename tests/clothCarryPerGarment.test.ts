// Editing one garment of several carries the others over as they were: only
// the edited one is modelled, sewn and settled again (one garment's edit used
// to re-sew a scene of seven from their modelled starts, 27 s on
// urban_collection). What is worn over the edited garment is let move as it
// settles, so an inner garment made bigger pushes the outer one out rather
// than coming through it.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { sheetNode } from '../src/utils/cloth/clothSheet';
import { buildClothWorld, type ClothWorld } from '../src/utils/cloth/clothWorld';
import { compileToMJCF } from '../src/utils/mjcf';
import { setSettleBudgetMs, setUntangleBudgetMs } from '../src/utils/cloth/xpbd';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { mujocoReady } from './clothSimHarness';
import { clothCrossings } from './clothIntersections';

setSettleBudgetMs(Infinity);
setUntangleBudgetMs(Infinity);

const ENV = { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.225 };

/* eslint-disable @typescript-eslint/no-explicit-any */
async function builder() {
  const mj = await mujocoReady();
  return (nodes: SceneNode[], previous: ClothWorld | null, carry: boolean) => {
    const graph = { nodes } as SceneGraph;
    const model = mj.MjModel.from_xml_string(compileToMJCF(graph));
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    return buildClothWorld(mj, model, data, graph, previous, carry)!;
  };
}

/** One cloth's particles, by name. */
const slice = (w: ClothWorld, name: string) => {
  const pieces = (w.sim as any).pieces as { model: { name: string; x0: Float64Array }; base: number }[];
  const pc = pieces.find((p) => p.model.name === name)!;
  return w.sim.x.slice(3 * pc.base, 3 * pc.base + pc.model.x0.length);
};
const meanGap = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]);
  return s / (a.length / 3);
};
const crossings = (w: ClothWorld) => {
  const sim = w.sim as any;
  const owner = new Int32Array(sim.n);
  (sim.pieces as { model: { x0: Float64Array }; base: number }[]).forEach((p, k) => owner.fill(k, p.base, p.base + p.model.x0.length / 3));
  return clothCrossings(sim.x, sim.tris, sim.stitches, (i) => String(owner[i])).length;
};

describe('carry per garment', () => {
  const form = bodyFormNode('form', 'form');
  const skirt = garmentNode('skirt', 'skirt', { garment: 'skirt' }, form);
  skirt.cloth!.layer = 0;
  const shirt = garmentNode('tshirt', 'tshirt', { garment: 'tshirt' }, form);
  shirt.cloth!.layer = 1;
  // A table to the side with a cloth on it: near nothing that changes, so not in the settle at all.
  const table = { id: 'table', name: 'table', pos: [1.5, 0, 0.4], geoms: [{ name: 'table_g', type: 'box', size: [0.3, 0.2, 0.4], rgba: [0.6, 0.6, 0.6, 1] }], joints: [], children: [] } as unknown as SceneNode;
  const cover = sheetNode([table], table);
  const eased = (n: SceneNode, by: number): SceneNode => ({ ...n, cloth: { ...n.cloth!, garment: { ...n.cloth!.garment!, ease: (n.cloth!.garment!.ease ?? 0.03) + by } } });

  it('an outer garment edited: the inner is carried as it was, the outer settles as a fresh build would', async () => {
    const build = await builder();
    const first = build([form, skirt, shirt, table, cover], null, false);
    const skirtBefore = slice(first, 'skirt'), coverBefore = slice(first, cover.name!);
    const nodes = [form, skirt, eased(shirt, 0.02), table, cover];
    const carried = build(nodes, first, true);
    // Held still, or left out: exactly where it was.
    expect(Array.from(slice(carried, 'skirt'))).toEqual(Array.from(skirtBefore));
    expect(Array.from(slice(carried, cover.name!))).toEqual(Array.from(coverBefore));
    const fresh = build(nodes, null, false);
    expect(meanGap(slice(carried, 'tshirt'), slice(fresh, 'tshirt'))).toBeLessThan(0.005);
    expect(crossings(carried)).toBeLessThanOrEqual(crossings(fresh) + 2);
  }, 300_000);

  it('an inner garment edited: what is worn over it moves out, nothing comes through', async () => {
    const build = await builder();
    const first = build([form, skirt, shirt], null, false);
    const nodes = [form, eased(skirt, 0.04), shirt];
    const carried = build(nodes, first, true);
    const fresh = build(nodes, null, false);
    expect(meanGap(slice(carried, 'skirt'), slice(fresh, 'skirt'))).toBeLessThan(0.005);
    expect(meanGap(slice(carried, 'tshirt'), slice(fresh, 'tshirt'))).toBeLessThan(0.005);
    expect(crossings(carried)).toBeLessThanOrEqual(crossings(fresh) + 2);
  }, 300_000);

  it('carried mid-run: the clock goes on, and the edited garment is sewn from where it is', async () => {
    const build = await builder();
    const first = build([form, skirt, shirt], null, false);
    for (let k = 0; k < 100; k++) first.advance(0.002, ENV);
    const t = first.sim.time;
    const carried = build([form, skirt, eased(shirt, 0.02)], first, true);
    expect(carried.sim.time).toBeCloseTo(t, 9);
    // No snap as it starts: nothing moves on the first steps more than it does on a fresh build's.
    const fresh = build([form, skirt, eased(shirt, 0.02)], null, false);
    const moved = (w: ClothWorld) => {
      const was = Float64Array.from(w.sim.x);
      for (let k = 0; k < 50; k++) w.advance(0.002, ENV);
      let most = 0;
      for (let i = 0; i < was.length; i += 3) most = Math.max(most, Math.hypot(w.sim.x[i] - was[i], w.sim.x[i + 1] - was[i + 1], w.sim.x[i + 2] - was[i + 2]));
      return most;
    };
    expect(moved(carried)).toBeLessThanOrEqual(moved(fresh));
  }, 300_000);
});
