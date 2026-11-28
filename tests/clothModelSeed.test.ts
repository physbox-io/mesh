// Cloth modelled off the physics worker (clothModelClient's pool) is handed
// to it by the key it looks models up by (clothInputs' `exact`): a build
// given a scene's models models nothing itself.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

const calls = { n: 0 };
vi.mock('../src/utils/cloth/clothModel', async (orig) => {
  const m = await orig<typeof import('../src/utils/cloth/clothModel')>();
  return { ...m, clothModel: (...a: Parameters<typeof m.clothModel>) => { calls.n++; return m.clothModel(...a); } };
});

import { clothModel } from '../src/utils/cloth/clothModel';
import { clothInputs } from '../src/utils/cloth/clothInputs';
import { buildClothWorld, seedClothModels } from '../src/utils/cloth/clothWorld';
import { clothModelsToSend } from '../src/utils/cloth/clothModelClient';
import { sheetNode } from '../src/utils/cloth/clothSheet';
import { compileToMJCF } from '../src/utils/mjcf';
import { withoutMeshData } from '../src/store/physicsWorkerClient';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { mujocoReady } from './clothSimHarness';

describe('cloth models made elsewhere', () => {
  it('a build given its models by their key does not model them again', async () => {
    const table = { id: 'table', name: 'table', pos: [0, 0, 0.4], geoms: [{ name: 'table_g', type: 'box', size: [0.3, 0.2, 0.4] }], joints: [], children: [] } as unknown as SceneNode;
    const sheet = { ...sheetNode([table], table), name: 'cover', id: 'cover' } as SceneNode;
    const graph = withoutMeshData({ nodes: [table, sheet] } as SceneGraph);
    const inputs = clothInputs(graph.nodes);
    expect(inputs).toHaveLength(1);
    // Made as the pool makes it: from a copy of the frame's elements.
    const made = clothModel(inputs[0].node, new THREE.Matrix4().fromArray(Array.from(inputs[0].world.elements)), graph.nodes);
    seedClothModels([[inputs[0].exact, structuredClone(made)]]);
    const mj = await mujocoReady();
    const model = mj.MjModel.from_xml_string(compileToMJCF(graph));
    const data = new mj.MjData(model);
    mj.mj_forward(model, data);
    calls.n = 0;
    const world = buildClothWorld(mj, model, data, structuredClone(graph), null, false)!;
    expect(calls.n).toBe(0);
    expect(Array.from(world.models[0].x0)).toEqual(Array.from(made.x0));
  }, 120_000);

  it('nothing is sent when nothing was modelled here (under Node, no pool)', () => {
    const sent = new Set<string>();
    expect(clothModelsToSend({ nodes: [] } as SceneGraph, sent)).toEqual([]);
  });
});
