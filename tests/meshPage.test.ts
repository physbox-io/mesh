import { describe, it, expect } from 'vitest';
import { meshPage } from '../src/utils/meshPage';
import type { SceneNode } from '../src/types/scene';

const box = (id: string, pos: number[], children: SceneNode[] = []): SceneNode => ({
  id, name: id, type: 'body', pos, joints: [], children,
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01] }],
} as SceneNode);

describe('mesh pages', () => {
  const nodes = [box('parent', [1, 0, 0], [box('child', [0, 0, 0.5])])];

  it('pages a geom\'s triangles in world metres, with the next offset', () => {
    const first = meshPage(nodes, 'child', { limit: 5 });
    if ('error' in first) throw new Error(first.error);
    expect(first.geom).toBe('child_g');
    expect(first.triangleCount).toBe(12);
    expect(first.triangles).toHaveLength(5);
    expect(first.nextOffset).toBe(5);
    // Placed by the parent's pose as well as its own.
    for (const t of first.triangles) {
      for (let k = 0; k < 9; k += 3) {
        expect(Math.abs(t[k] - 1)).toBeCloseTo(0.01, 6);
        expect(Math.abs(t[k + 2] - 0.5)).toBeCloseTo(0.01, 6);
      }
    }
    const last = meshPage(nodes, 'child', { offset: 10, limit: 5 });
    if ('error' in last) throw new Error(last.error);
    expect(last.triangles).toHaveLength(2);
    expect(last.nextOffset).toBeNull();
  });

  it('names the geoms when the one asked for is not there', () => {
    const r = meshPage(nodes, 'parent', { geom: 'nope' });
    expect('error' in r && r.error).toContain('parent_g');
    expect('error' in meshPage(nodes, 'missing', {})).toBe(true);
  });
});
