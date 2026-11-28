import { describe, expect, it } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { buildClothWorld } from '../src/utils/cloth/clothWorld';
import { compileToMJCF } from '../src/utils/mjcf';
import { withoutMeshData } from '../src/store/physicsWorkerClient';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { mujocoReady } from './clothSimHarness';

describe('a garment with its own colour keeps its shading when carried over a rebuild', () => {
  it('backs stay darker than fronts, carried and recoloured', async () => {
    const mj = await mujocoReady();
    const form = bodyFormNode('form', 'form', {});
    const dress = garmentNode('dress', 'dress', { garment: 'dress', rgba: [0.6, 0.4, 0.2, 1], pockets: [{ panel: 'front', at: [0.5, 0.4], width: 0.1, height: 0.1 }] }, form);
    dress.cloth!.spacing = 0.05;
    const graph = { nodes: [form, dress] } as SceneGraph;
    const model = mj.MjModel.from_xml_string(compileToMJCF(graph));
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    const w1 = buildClothWorld(mj, model, data, withoutMeshData(graph), null, false)!;
    const colours = (w: typeof w1) => new Map(w.sim.renderLayout().map((g) => [g.name.split('__')[1], g.rgba]));
    const c1 = colours(w1);
    expect(c1.get('back')![0]).toBeCloseTo(0.6 * 0.85, 6);
    // Carried over a rebuild (nothing about it changed): as it was.
    const w2 = buildClothWorld(mj, model, data, withoutMeshData(graph), w1, true)!;
    expect(colours(w2)).toEqual(c1);
    // Recoloured: each piece its own shade of the new colour.
    const recoloured = { nodes: [form, { ...dress, cloth: { ...dress.cloth!, garment: { ...dress.cloth!.garment!, rgba: [0.2, 0.4, 0.8, 1] } } } as SceneNode] } as SceneGraph;
    const w3 = buildClothWorld(mj, model, data, withoutMeshData(recoloured), w2, true)!;
    const c3 = colours(w3);
    expect(c3.get('front')).toEqual([0.2, 0.4, 0.8, 1]);
    expect(c3.get('back')![2]).toBeCloseTo(0.8 * 0.85, 6);
    // A pocket a shade darker than its garment, the same shade of the new colour.
    const k = c1.get('pocket_front')![0] / 0.6;
    expect(c3.get('pocket_front')![2]).toBeCloseTo(0.8 * k, 6);
    expect(Array.from(w3.sim.x)).toEqual(Array.from(w2.sim.x));
    data.delete(); model.delete();
  }, 300000);
});
