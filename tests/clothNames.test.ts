import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clothModel } from '../src/utils/cloth/clothModel';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';

describe('a garment that names what it does not have', () => {
  it('says which name matched nothing, and what it has instead', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const skirt = garmentNode('skirt', 'skirt', { garment: 'skirt', fullness: [{ along: 'top', kind: 'knife', ratio: 1.5 }], pockets: [{ panel: 'frnt' }], trims: [{ kind: 'stud', along: 'hemm' }] }, form);
    skirt.cloth!.arrange = [{ piece: 'nope', turn: 90 }];
    const w = clothModel(skirt, new THREE.Matrix4(), [form, skirt]).warnings ?? [];
    expect(w.find((s) => s.startsWith("trims[0].along 'hemm'"))).toMatch(/its lines: .*hem/);
    expect(w.find((s) => s.startsWith("fullness[0].along 'top'"))).toMatch(/an edge, not a seam/);
    expect(w.find((s) => s.startsWith("pockets[0].panel 'frnt'"))).toMatch(/its panels: .*front/);
    expect(w.find((s) => s.startsWith("arrange[0].piece 'nope'"))).toBeDefined();
  }, 120000);

  it('says nothing when every name is found', () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const jacket = garmentNode('jacket', 'jacket', { garment: 'jacket' }, form);
    expect(clothModel(jacket, new THREE.Matrix4(), [form, jacket]).warnings).toBeUndefined();
  }, 120000);
});
