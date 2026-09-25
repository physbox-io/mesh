// Insetting a face: finding the flat face under the pointer, and the pocket or
// boss made from it.
//
// The I gesture on an ordinary body used to bore a scaled copy of the whole
// body through it along Z, so on a cube it always opened the top and bottom
// whichever face was pointed at. It now insets the face itself, and what it
// makes is a cut geom sized to that face — which is only right if the face is
// found exactly and the cut is turned to lie along the face's own edges.

import { describe, it, expect, beforeEach } from 'vitest';
import { flatFaceAt, cutGeometry, geomBounds, reconcileCuts, type FaceRegion } from '../src/utils/csg';
import { useStore } from '../src/store/useStore';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const body = (geoms: SceneGeom[]): SceneNode => ({
  id: 'part', name: 'part', type: 'body', pos: [0, 0, 0], children: [], joints: [], geoms,
} as unknown as SceneNode);

const slab = () => body([{ name: 'slab', type: 'box', size: [0.1, 0.2, 0.3] }]);

/** A cut sized to a fraction of a face, the way setFaceFeature makes one. */
const featureOn = (node: SceneNode, region: FaceRegion, fraction: number, extra: Partial<SceneGeom>): SceneGeom => {
  const geom = {
    name: 'f', type: region.shape,
    size: region.shape === 'box' ? [region.half[0] * fraction, region.half[1] * fraction, 0] : [region.half[0] * fraction, 0],
    cutAt: region.at, cutNormal: region.normal, cutTwist: region.twist, cutFace: true,
    ...extra,
  } as SceneGeom;
  node.geoms = [...node.geoms, geom];
  Object.assign(geom, cutGeometry(node, geom));
  return geom;
};

describe('the flat face under a ray', () => {
  it('finds a box face, its middle, and its outline', () => {
    const region = flatFaceAt(slab(), [5, 0.05, 0.05], [-1, 0, 0])!;
    expect(region.shape).toBe('box');
    expect(region.at.map((v) => +v.toFixed(9))).toEqual([0.1, 0, 0]);
    expect(region.normal.map((v) => +v.toFixed(9))).toEqual([1, 0, 0]);
    expect(region.half).toEqual([0.2, 0.3]);
  });

  it('turns the cut to lie along the face, not at an angle to it', () => {
    // Without the twist, a 0.4 × 0.6 face gets a cut whose long side runs the
    // wrong way — it spills off the face on one side and falls short on the
    // other. The cut's bounds have to sit inside the face on both.
    const node = slab();
    const region = flatFaceAt(node, [5, 0, 0], [-1, 0, 0])!;
    const cut = featureOn(node, region, 0.5, { csg: 'difference', cutDepth: 0.02 });
    const b = geomBounds(cut)!;
    expect(b.max[1]).toBeCloseTo(0.1, 6);
    expect(b.min[1]).toBeCloseTo(-0.1, 6);
    expect(b.max[2]).toBeCloseTo(0.15, 6);
    expect(b.min[2]).toBeCloseTo(-0.15, 6);
  });

  it('finds the flat end of a cylinder, and not its side', () => {
    const can = body([{ name: 'can', type: 'cylinder', size: [0.05, 0.1] }]);
    const top = flatFaceAt(can, [0.01, 0, 5], [0, 0, -1])!;
    expect(top.shape).toBe('cylinder');
    expect(top.half).toEqual([0.05]);
    expect(top.at[2]).toBeCloseTo(0.1, 9);
    expect(flatFaceAt(can, [5, 0, 0], [-1, 0, 0])).toBeNull();
  });

  it('has nothing to say about a sphere', () => {
    expect(flatFaceAt(body([{ name: 'ball', type: 'sphere', size: [0.1] }]), [0, 0, 5], [0, 0, -1])).toBeNull();
  });

  it('reads the right face of a turned box', () => {
    // A quarter turn about Z: the box's own X now faces world Y.
    const turned = body([{ name: 't', type: 'box', size: [0.1, 0.2, 0.3], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }]);
    const region = flatFaceAt(turned, [0, 5, 0], [0, -1, 0])!;
    expect(region.normal[1]).toBeCloseTo(1, 9);
    expect(region.half).toEqual([0.2, 0.3]);
  });
});

describe('flat regions of a mesh', () => {
  // A 0.2 cube, wound outward, each face two triangles.
  const cubeMesh = (): SceneGeom => {
    const v: number[] = [];
    for (const x of [-0.1, 0.1]) for (const y of [-0.1, 0.1]) for (const z of [-0.1, 0.1]) v.push(x, y, z);
    const i = (x: number, y: number, z: number) => x * 4 + y * 2 + z;
    const quad = (a: number, b: number, c: number, d: number) => [a, b, c, a, c, d];
    const faces = [
      ...quad(i(1, 0, 0), i(1, 1, 0), i(1, 1, 1), i(1, 0, 1)), // +X
      ...quad(i(0, 0, 0), i(0, 0, 1), i(0, 1, 1), i(0, 1, 0)), // −X
      ...quad(i(0, 1, 0), i(0, 1, 1), i(1, 1, 1), i(1, 1, 0)), // +Y
      ...quad(i(0, 0, 0), i(1, 0, 0), i(1, 0, 1), i(0, 0, 1)), // −Y
      ...quad(i(0, 0, 1), i(1, 0, 1), i(1, 1, 1), i(0, 1, 1)), // +Z
      ...quad(i(0, 0, 0), i(0, 1, 0), i(1, 1, 0), i(1, 0, 0)), // −Z
    ];
    return { name: 'm', type: 'mesh', dynamic: true, renderVertices: v, faces } as unknown as SceneGeom;
  };

  it('grows a face across the triangles that share its plane', () => {
    const region = flatFaceAt(body([cubeMesh()]), [0.03, -0.02, 5], [0, 0, -1])!;
    expect(region.shape).toBe('box');
    expect(region.at.map((v) => +v.toFixed(9))).toEqual([0, 0, 0.1]);
    expect(region.half.map((v) => +v.toFixed(9))).toEqual([0.1, 0.1]);
  });

  it('refuses a flat face that no box or disk fits', () => {
    // An L of three squares: flat, but a rectangle over it would spill off it.
    const v = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 0, 2, 0, 1, 2, 0];
    const faces = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 3, 4, 7, 3, 7, 6];
    const ell = body([{ name: 'l', type: 'mesh', dynamic: true, renderVertices: v, faces } as unknown as SceneGeom]);
    expect(flatFaceAt(ell, [0.5, 0.5, 5], [0, 0, -1])).toBeNull();
  });
});

describe('a boss', () => {
  it('stands out of the face by its height, and sinks into it a little', () => {
    const node = slab();
    const region = flatFaceAt(node, [0, 0, 5], [0, 0, -1])!;
    const boss = featureOn(node, region, 0.5, { csg: 'union', cutDepth: 0.05 });
    const b = geomBounds(boss)!;
    expect(b.max[2]).toBeCloseTo(0.35, 6);
    expect(b.min[2]).toBeLessThan(0.3);
  });

  it('does not grow each time the part is reconciled', () => {
    // A boss is material, so a probe down its own line meets its own top. If
    // it were measured from there it would climb by its height every time.
    const node = slab();
    const region = flatFaceAt(node, [0, 0, 5], [0, 0, -1])!;
    const boss = featureOn(node, region, 0.5, { csg: 'union', cutDepth: 0.05 });
    // The first pass may trim the overshoot, which is sized off the part and
    // the part now includes the boss. Its top does not move, then or after.
    reconcileCuts(node);
    const before = [...boss.pos!];
    expect(geomBounds(boss)!.max[2]).toBeCloseTo(0.35, 6);
    reconcileCuts(node);
    reconcileCuts(node);
    expect(boss.pos).toEqual(before);
  });

  it('follows the face when the part grows', () => {
    const node = slab();
    const region = flatFaceAt(node, [0, 0, 5], [0, 0, -1])!;
    const boss = featureOn(node, region, 0.5, { csg: 'union', cutDepth: 0.05 });
    node.geoms[0].size = [0.1, 0.2, 0.4];
    reconcileCuts(node);
    expect(geomBounds(boss)!.max[2]).toBeCloseTo(0.45, 6);
  });
});

describe('setFaceFeature', () => {
  beforeEach(() => {
    // The store schedules a recompile on window; there is none under Vitest.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({ sceneGraph: { nodes: [slab()] } as unknown as SceneGraph, model: null, data: null });
  });
  const part = () => useStore.getState().sceneGraph.nodes[0];

  it('adds a pocket, then turns the same feature into a boss', () => {
    const region = flatFaceAt(part(), [0, 0, 5], [0, 0, -1])!;
    const index = useStore.getState().setFaceFeature('part', region, { half: [0.05, 0.1], depth: -0.02 });
    expect(index).toBe(1);
    let feature = part().geoms[index];
    expect(feature).toMatchObject({ csg: 'difference', cutFace: true, cutDepth: 0.02 });
    expect(part().csgEnabled).toBe(true);

    const again = useStore.getState().setFaceFeature('part', region, { half: [0.05, 0.1], depth: 0.03 }, index);
    expect(again).toBe(index);
    expect(part().geoms).toHaveLength(2);
    feature = part().geoms[index];
    expect(feature).toMatchObject({ csg: 'union', cutDepth: 0.03 });
    expect(geomBounds(feature)!.max[2]).toBeCloseTo(0.33, 6);
  });

  it('goes right through when asked, and does nothing at no depth', () => {
    const region = flatFaceAt(part(), [0, 0, 5], [0, 0, -1])!;
    expect(useStore.getState().setFaceFeature('part', region, { half: [0.05, 0.1], depth: 0 })).toBe(-1);
    const index = useStore.getState().setFaceFeature('part', region, { half: [0.05, 0.1], depth: -1, through: true });
    expect(part().geoms[index]).toMatchObject({ csg: 'difference', cutDepth: 0 });
  });
});
