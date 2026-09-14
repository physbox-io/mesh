import { describe, it, expect } from 'vitest';
import { buildOakTree, oakTreePreset } from '../src/presets/oakTree';

describe('oak tree', () => {
  it('has plausible proportions for an open-grown oak', () => {
    const { wood, leaf } = buildOakTree();
    const bounds = (p: number[]) => {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[i + a]); max[a] = Math.max(max[a], p[i + a]);
      }
      return { min, max };
    };
    const w = bounds(wood.positions), l = bounds(leaf.positions);
    const height = Math.max(w.max[2], l.max[2]);
    const spreadX = Math.max(w.max[0], l.max[0]) - Math.min(w.min[0], l.min[0]);
    const spreadY = Math.max(w.max[1], l.max[1]) - Math.min(w.min[1], l.min[1]);
    console.log(JSON.stringify({
      height: +height.toFixed(2),
      spreadX: +spreadX.toFixed(2),
      spreadY: +spreadY.toFixed(2),
      crownToTrunk: +(Math.max(spreadX, spreadY) / 0.40).toFixed(1),
      woodVerts: wood.positions.length / 3, woodTris: wood.faces.length / 3,
      leafVerts: leaf.positions.length / 3, leafTris: leaf.faces.length / 3,
      lowestLeaf: +l.min[2].toFixed(2),
    }, null, 1));
    expect(height).toBeGreaterThan(3.5);
    expect(Math.max(spreadX, spreadY)).toBeGreaterThan(height * 0.85);
    expect(l.min[2]).toBeGreaterThan(1.2);
  });

  it('is deterministic', () => {
    expect(buildOakTree(7).wood.positions.length).toBe(buildOakTree(7).wood.positions.length);
    expect(buildOakTree(7).wood.positions[100]).toBe(buildOakTree(7).wood.positions[100]);
  });

  it('emits two geoms with matching vertex and face arrays', () => {
    const g = oakTreePreset.nodes[0].geoms!;
    expect(g).toHaveLength(2);
    for (const geom of g) {
      expect(geom.vertices!.length % 3).toBe(0);
      expect(geom.faces!.length % 3).toBe(0);
      expect(geom.renderVertices!.length).toBe(geom.vertices!.length);
      const maxIndex = Math.max(...geom.faces!);
      expect(maxIndex).toBeLessThan(geom.vertices!.length / 3);
    }
  });
});

/**
 * Edge use, degeneracy and signed volume — everything a slicer cares about.
 *
 * The first version of this tree drew every sub-segment as its own uncapped
 * cylinder, so the wood alone had 8,028 boundary edges and the foliage was open
 * at both poles of every clump. It rendered perfectly and would have printed as
 * a soup of open tubes, which is exactly the failure these assertions exist to
 * stop coming back.
 */
function integrity(positions: number[], faces: number[]) {
  const edges = new Map<string, number>();
  let degenerate = 0;
  let volume = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const t = [faces[i], faces[i + 1], faces[i + 2]];
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) { degenerate++; continue; }
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const [a, b, c] = t.map(v => v * 3);
    volume += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  let boundary = 0, nonManifold = 0;
  for (const n of edges.values()) { if (n === 1) boundary++; else if (n > 2) nonManifold++; }
  return { boundary, nonManifold, degenerate, volume };
}

describe('oak tree — printable', () => {
  it('every shell is closed, with no degenerate triangles', () => {
    const { wood, leaf } = buildOakTree();
    for (const mesh of [wood, leaf]) {
      const r = integrity(mesh.positions, mesh.faces);
      expect(r.boundary).toBe(0);
      expect(r.nonManifold).toBe(0);
      expect(r.degenerate).toBe(0);
    }
  });

  it('is wound outward, so a slicer sees solid rather than void', () => {
    const { wood, leaf } = buildOakTree();
    expect(integrity(wood.positions, wood.faces).volume).toBeGreaterThan(0);
    expect(integrity(leaf.positions, leaf.faces).volume).toBeGreaterThan(0);
  });

  it('leaves no foliage clump floating clear of the twig it hangs on', () => {
    const { foliage } = buildOakTree();
    expect(foliage.length).toBeGreaterThan(50);
    for (const f of foliage) {
      const d = Math.hypot(f.centre[0] - f.tip[0], f.centre[1] - f.tip[1], f.centre[2] - f.tip[2]);
      // Strictly inside, not merely touching: a clump whose surface grazes the
      // twig is still an island once the slicer has thickened nothing.
      expect(d).toBeLessThan(f.radius * 0.75);
    }
  });
});
