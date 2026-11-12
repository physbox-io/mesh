import { describe, expect, it } from 'vitest';
import { formsIn, newFormNode, newGarmentNode } from '../src/utils/cloth/clothStart';
import { needsBodyFormBuild } from '../src/utils/cloth/bodyFormEdit';
import { garmentSettings } from '../src/utils/cloth/garments';
import type { SceneNode } from '../src/types/scene';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';

describe('starting cloth work from nothing', () => {
  it('adds a form left for the worker to build, and garments on it one layer out each', () => {
    const nodes: SceneNode[] = [];
    const form = newFormNode(nodes, 'female');
    expect(form.name).toBe('form');
    expect(form.bodyForm?.figure).toBe('female');
    expect(form.geoms).toEqual([]);
    expect(needsBodyFormBuild(form)).toBe(true);
    nodes.push(form);
    const shirt = newGarmentNode(nodes, 'tshirt', form);
    expect(shirt.cloth?.garment?.fitTo).toBe('form');
    expect(shirt.cloth?.layer).toBe(0);
    expect(garmentSettings(shirt.cloth!.garment!).material).toBe('jersey');
    nodes.push(shirt);
    const jacket = newGarmentNode(nodes, 'jacket', form);
    expect(jacket.cloth?.layer).toBe(1);
    expect(jacket.name).toBe('jacket');
    nodes.push(jacket);
    expect(newGarmentNode(nodes, 'jacket', form).name).toBe('jacket_2');
    const second = newFormNode(nodes, 'male');
    expect(second.name).toBe('form_2');
    expect(second.pos[0]).toBeCloseTo(0.8);
    nodes.push(second);
    expect(formsIn(nodes).map((f) => f.name)).toEqual(['form', 'form_2']);
    expect(newGarmentNode(nodes, 'trousers', second).cloth?.layer).toBe(0);
  });

  it('MCP adds a dress form by its measurements alone: no default box or free joint, measurements clamped', () => {
    const node = fillBodyDefaults({ name: 'form', bodyForm: { figure: 'male', waist: 0.8 } } as never, null);
    expect(node.joints).toEqual([]);
    expect(node.geoms).toEqual([]);
    expect(node.bodyForm?.waist).toBe(0.8);
    expect(node.bodyForm?.height).toBeGreaterThan(1);
    expect(needsBodyFormBuild(node)).toBe(true);
  });
});
