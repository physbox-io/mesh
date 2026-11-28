// A garment recoloured (itself, a trim, a pocket) is modelled from the shell
// it was modelled from already: the same model as one made from scratch,
// colours and all, in a fraction of the time.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import type { SceneNode } from '../src/types/scene';

describe('garment shell cache', () => {
  it('a recolour hits it and makes the same model as a cold one', async () => {
    const form = bodyFormNode('form', 'form');
    const shirt = garmentNode('tshirt', 'tshirt', { garment: 'tshirt', trims: [{ kind: 'stitch', along: 'hem', offset: 0.01, rgba: [0.2, 0.2, 0.2, 1] }], pockets: [{ panel: 'front', at: [0.5, 0.5] }] }, form);
    const g = shirt.cloth!.garment!;
    const red: SceneNode = { ...shirt, cloth: { ...shirt.cloth!, garment: { ...g, rgba: [0.9, 0.1, 0.1, 1], trims: g.trims!.map((t) => ({ ...t, rgba: [0.1, 0.9, 0.1, 1] })), pockets: g.pockets!.map((p) => ({ ...p, rgba: [0.1, 0.1, 0.9, 1] })) } } };
    const world = () => new THREE.Matrix4();
    const warm = await import('../src/utils/cloth/clothModel');
    warm.clothModel(shirt, world(), [form, shirt]);
    let t = performance.now();
    const hit = warm.clothModel(red, world(), [form, red]);
    const hitMs = performance.now() - t;
    vi.resetModules();
    const cold = await import('../src/utils/cloth/clothModel');
    t = performance.now();
    const fresh = cold.clothModel(red, world(), [form, red]);
    const coldMs = performance.now() - t;
    expect(JSON.stringify(hit)).toBe(JSON.stringify(fresh));
    expect(hitMs).toBeLessThan(coldMs / 2);
  }, 300_000);
});
