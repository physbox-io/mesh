// Cloth on nothing: a garment whose dress form is deleted keeps its cut and
// falls to the floor (it used to name a form that was gone, and the scene
// would not build); a plain sheet laid over a body drapes on it; a sheet's
// corners tied to posts are wound in to them, as a shade sail's are.

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode, releaseGarments } from '../src/utils/cloth/clothNodes';
import { holdCorner, resizePiece, sheetNode } from '../src/utils/cloth/clothSheet';
import { buildClothWorld } from '../src/utils/cloth/clothWorld';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { clothRun, mujocoReady } from './clothSimHarness';

const zRange = (x: Float64Array) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < x.length; i += 3) { lo = Math.min(lo, x[i]); hi = Math.max(hi, x[i]); }
  return [lo, hi];
};

const box = (id: string, pos: number[], half: number[]): SceneNode => ({
  id, name: id, pos, geoms: [{ name: `${id}_g`, type: 'box', size: half, rgba: [0.6, 0.6, 0.6, 1] }], joints: [], children: [],
} as unknown as SceneNode);

describe('cloth on nothing', () => {
  it('a garment whose form is deleted keeps its cut and falls to the floor', async () => {
    const form = bodyFormNode('form', 'form');
    const shirt = garmentNode('tshirt', 'tshirt', { garment: 'tshirt' }, form);
    const [released] = releaseGarments([shirt], [form]);
    expect(released.cloth!.garment!.fitTo).toBeUndefined();
    expect(released.cloth!.garment!.form).toEqual(form.bodyForm);
    const r = await clothRun([released]);
    const [, top0] = zRange(r.sim.x);
    expect(top0).toBeGreaterThan(1.2); // starts as worn, at the chest
    r.run(2.5);
    const [lo, hi] = zRange(r.sim.x);
    expect(lo).toBeGreaterThan(-0.01);
    expect(hi).toBeLessThan(0.35);
  }, 120_000);

  it('deleting the form while it plays carries the cloth on from where it is', async () => {
    const mj = await mujocoReady();
    const form = bodyFormNode('form', 'form');
    const shirt = garmentNode('tshirt', 'tshirt', { garment: 'tshirt' }, form);
    const build = (nodes: SceneNode[], previous: ReturnType<typeof buildClothWorld>) => {
      const graph = { nodes } as SceneGraph;
      const model = mj.MjModel.from_xml_string(compileToMJCF(graph));
      const data = new mj.MjData(model);
      mj.mj_forward(model, data);
      return buildClothWorld(mj, model, data, graph, previous, true);
    };
    const on = build([form, shirt], null)!;
    on.advance(0.002, { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.225 });
    const off = build(releaseGarments([shirt], [form]), on)!;
    expect(off.sim.time).toBeCloseTo(on.sim.time, 9);
    expect(Array.from(off.sim.x)).toEqual(Array.from(on.sim.x));
  }, 120_000);

  it('a sheet laid over a box drapes on it', async () => {
    const table = box('table', [0, 0, 0.4], [0.3, 0.2, 0.4]);
    const sheet = sheetNode([table], table);
    expect(sheet.pos![2]).toBeCloseTo(0.9, 6);
    const r = await clothRun([table, sheet]);
    r.run(2.5);
    const [lo, hi] = zRange(r.sim.x);
    expect(hi).toBeGreaterThan(0.79); // on the top
    expect(hi).toBeLessThan(0.83);
    expect(lo).toBeLessThan(0.7); // hanging over the sides
  }, 120_000);

  it('a sheet tied by its corners to posts is wound in to them', async () => {
    const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y], i) => ({
      id: `post${i}`, name: `post${i}`, pos: [x, y, 1.25],
      geoms: [{ name: `post${i}_g`, type: 'cylinder', size: [0.04, 1.25] }], joints: [], children: [],
    } as unknown as SceneNode));
    let sheet = sheetNode(posts, null, [0, 0]);
    sheet.pos = [0, 0, 2.6];
    sheet.cloth!.material = 'shadeCloth';
    sheet.cloth!.spacing = 0.12;
    sheet.cloth!.pieces = [resizePiece(sheet.cloth!.pieces![0], 1.92, 1.92)];
    const all = () => [...posts, sheet];
    ['south', 'east', 'north', 'west'].forEach((edge, i) => {
      sheet = { ...sheet, cloth: { ...sheet.cloth!, ties: holdCorner(all(), sheet, 'sheet', edge, { to: `post${i}` }) } };
    });
    expect(sheet.cloth!.ties!.map((t) => t.anchor![2])).toEqual([1.25, 1.25, 1.25, 1.25]);
    const r = await clothRun(all());
    r.run(3);
    // Each corner at the top of its post, the sail between them held up off the ground.
    const m = r.models[0];
    for (const tie of m.ties) {
      const i = 3 * tie.particle, post = posts.find((p) => p.name === tie.body)!;
      expect(Math.hypot(r.sim.x[i] - post.pos![0], r.sim.x[i + 1] - post.pos![1], r.sim.x[i + 2] - 2.5)).toBeLessThan(0.08);
    }
    expect(zRange(r.sim.x)[0]).toBeGreaterThan(1.5);
  }, 120_000);
});
