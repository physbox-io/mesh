// Insetting a face: finding the flat face under the pointer, and the pocket or
// boss made from it.
//
// The I gesture on an ordinary body used to bore a scaled copy of the whole
// body through it along Z, so on a cube it always opened the top and bottom
// whichever face was pointed at. It now insets the face itself, and what it
// makes is a cut geom sized to that face — which is only right if the face is
// found exactly and the cut is turned to lie along the face's own edges.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  flatFaceAt, cutGeometry, geomBounds, reconcileCuts, insetPolygon, prismMesh, hasBooleanOps, type FaceRegion,
} from '../src/utils/csg';
import { boxLattice, serializeCage, toSceneGeom, extrudeFace, faceNormal } from '../src/utils/latticeMesh';
import { scaleNodeTree } from '../src/utils/scaleNode';
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

  it('follows a flat face that no box or disk fits', () => {
    // An L of three squares: a rectangle over it would spill off it, so it is
    // its own outline — six corners, the ones where triangles merely met along
    // a straight edge dropped.
    const v = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 0, 2, 0, 1, 2, 0];
    const faces = [0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 3, 4, 7, 3, 7, 6];
    const ell = body([{ name: 'l', type: 'mesh', dynamic: true, renderVertices: v, faces } as unknown as SceneGeom]);
    const region = flatFaceAt(ell, [0.5, 0.5, 5], [0, 0, -1])!;
    expect(region.shape).toBe('polygon');
    expect(region.outline).toHaveLength(6);
    expect(region.closed).toBe(false);
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
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.05, depth: -0.02 });
    expect(index).toBe(1);
    let feature = part().geoms[index];
    expect(feature).toMatchObject({ csg: 'difference', cutFace: true, cutDepth: 0.02 });
    expect(part().csgEnabled).toBe(true);

    const again = useStore.getState().setFaceFeature('part', region, { border: 0.05, depth: 0.03 }, index);
    expect(again).toBe(index);
    expect(part().geoms).toHaveLength(2);
    feature = part().geoms[index];
    expect(feature).toMatchObject({ csg: 'union', cutDepth: 0.03 });
    expect(geomBounds(feature)!.max[2]).toBeCloseTo(0.33, 6);
  });

  it('goes right through when asked, and does nothing at no depth', () => {
    const region = flatFaceAt(part(), [0, 0, 5], [0, 0, -1])!;
    expect(useStore.getState().setFaceFeature('part', region, { border: 0.05, depth: 0 })).toBe(-1);
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.05, depth: -1, through: true });
    expect(part().geoms[index]).toMatchObject({ csg: 'difference', cutDepth: 0 });
  });
});

// Any flat face, not only rectangles and disks: a lattice face drawn as a
// trapezoid used to fall through to boring the whole body.
describe('a face of any outline', () => {
  const trapezoid = [[0, 0], [0.4, 0], [0.3, 0.2], [0.1, 0.2]];
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  });
  const prismBody = () => {
    const { positions, faces } = prismMesh(trapezoid, 0, 0.1);
    return body([{ name: 'p', type: 'mesh', dynamic: true, renderVertices: positions, faces } as unknown as SceneGeom]);
  };

  it('insets by the same distance from every edge', () => {
    const inner = insetPolygon(trapezoid, 0.02)!;
    // Each new edge is 0.02 in from the old one: measure a corner of it
    // against the old edge's line.
    for (let i = 0; i < 4; i++) {
      const [a, b] = [trapezoid[i], trapezoid[(i + 1) % 4]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const p = inner[i];
      const dist = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len;
      expect(dist).toBeCloseTo(0.02, 9);
    }
    expect(insetPolygon(trapezoid, 0.5)).toBeNull();
  });

  it('finds the trapezoid as its own outline', () => {
    const region = flatFaceAt(prismBody(), [0.2, 0.1, 5], [0, 0, -1])!;
    expect(region.shape).toBe('polygon');
    expect(region.outline).toHaveLength(4);
    expect(region.closed).toBe(true);
    expect(region.at[2]).toBeCloseTo(0.1, 9);
    expect(region.maxBorder).toBeGreaterThan(0.05);
    expect(region.maxBorder).toBeLessThan(0.1);
  });

  it('sinks a pocket of that outline, and stands a boss of it', () => {
    useStore.setState({ sceneGraph: { nodes: [{ ...prismBody(), id: 'part' }] } as unknown as SceneGraph, model: null, data: null });
    const part = () => useStore.getState().sceneGraph.nodes[0];
    const region = flatFaceAt(part(), [0.2, 0.1, 5], [0, 0, -1])!;
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.02, depth: -0.04 });
    const pocket = part().geoms[index];
    expect(pocket).toMatchObject({ type: 'mesh', csg: 'difference', cutFace: true });
    expect(pocket.cutOutline).toHaveLength(4);
    const b = geomBounds(pocket)!;
    expect(b.min[2]).toBeCloseTo(0.06, 6);
    expect(b.max[2]).toBeGreaterThan(0.1);

    useStore.getState().setFaceFeature('part', region, { border: 0.02, depth: 0.03 }, index);
    const boss = part().geoms[index];
    expect(boss.csg).toBe('union');
    expect(geomBounds(boss)!.max[2]).toBeCloseTo(0.13, 6);
  });

  it('sinks nothing into an open surface, but stands a boss on one', () => {
    // A lone face: what a single lattice quad is when it is not part of a solid.
    const sheet = {
      name: 's', type: 'mesh', dynamic: true,
      renderVertices: [0, 0, 0, 0.2, 0, 0, 0.2, 0.2, 0, 0, 0.2, 0], faces: [0, 1, 2, 0, 2, 3],
    } as unknown as SceneGeom;
    useStore.setState({ sceneGraph: { nodes: [{ ...body([sheet]), id: 'part' }] } as unknown as SceneGraph, model: null, data: null });
    const region = flatFaceAt(useStore.getState().sceneGraph.nodes[0], [0.1, 0.1, 5], [0, 0, -1])!;
    expect(region.closed).toBe(false);
    expect(useStore.getState().setFaceFeature('part', region, { border: 0.02, depth: -0.01 })).toBe(-1);
    expect(useStore.getState().setFaceFeature('part', region, { border: 0.02, depth: 0.01 })).toBe(1);
  });
});

// The rough edges found in a scene made by hand with these tools.
describe('keeping a feature where it was put', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  });
  const part = () => useStore.getState().sceneGraph.nodes[0];
  const load = (node: SceneNode) =>
    useStore.setState({ sceneGraph: { nodes: [node] } as unknown as SceneGraph, model: null, data: null });

  it('stays on its spot when a lattice edit re-centres the body', () => {
    // A 40 mm lattice cube, pocketed in its +X face. Extruding +Y by 20 mm
    // re-centres the body 10 mm along Y — sideways to the pocket. The cage
    // walked back; the pocket's anchor used to stay put, and it slid 10 mm off
    // the middle of the cube's face.
    const lattice = boxLattice(0.0001, 200);
    const mesh = toSceneGeom(lattice, 0, 0);
    load({
      id: 'part', name: 'part', type: 'body', pos: [0, 0, 0.1], joints: [], children: [],
      isLattice: true, latticeCage: serializeCage(lattice), latticeSubdiv: 0, latticeOrigin: mesh.origin,
      geoms: [{
        name: 'part_mesh', type: 'mesh', size: [1], mass: 1, dynamic: true, latticeGeom: true,
        vertices: mesh.vertices, renderVertices: mesh.renderVertices, faces: mesh.faces,
      }],
    } as unknown as SceneNode);
    const region = flatFaceAt(part(), [5, 0, 0], [-1, 0, 0])!;
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.005, depth: -0.01 });

    const plusY = lattice.faces.findIndex((_, f) => (faceNormal(lattice, f)?.[1] ?? 0) > 0.99);
    extrudeFace(lattice, plusY, 200);
    useStore.getState().applyLattice('part', serializeCage(lattice), 0);

    const cube = part().geoms.find((g) => g.latticeGeom)!;
    const ys = (cube.renderVertices as number[]).filter((_, i) => i % 3 === 1);
    const pocket = geomBounds(part().geoms[index])!;
    // The cube part of the shape is its first 40 mm from −Y.
    expect((pocket.min[1] + pocket.max[1]) / 2).toBeCloseTo(Math.min(...ys) + 0.02, 6);
  });

  it('folds a stray offset back into a prism that already drifted', () => {
    const trapezoid = [[0, 0], [0.4, 0], [0.3, 0.2], [0.1, 0.2]];
    const { positions, faces } = prismMesh(trapezoid, 0, 0.1);
    load({ ...body([{ name: 'p', type: 'mesh', dynamic: true, renderVertices: positions, faces } as unknown as SceneGeom]), id: 'part' });
    const region = flatFaceAt(part(), [0.2, 0.1, 5], [0, 0, -1])!;
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.02, depth: 0.03 });
    const right = geomBounds(part().geoms[index])!;
    // What the old walk-back left: the anchor 10 mm off in Y, and a pos
    // making up for it.
    const node = part();
    const boss = node.geoms[index];
    boss.cutAt = [boss.cutAt![0], boss.cutAt![1] + 0.01, boss.cutAt![2]];
    boss.pos = [0, -0.01, 0];
    reconcileCuts(node);
    expect(boss.pos).toEqual([0, 0, 0]);
    const now = geomBounds(boss)!;
    for (let a = 0; a < 3; a++) {
      expect(now.min[a]).toBeCloseTo(right.min[a], 6);
      expect(now.max[a]).toBeCloseTo(right.max[a], 6);
    }
  });

  it('compiles a body whose only feature is a boss', () => {
    // Uncompiled, a boss was a separate shape weighed by its own volume.
    const node = slab();
    const region = flatFaceAt(node, [0, 0, 5], [0, 0, -1])!;
    featureOn(node, region, 0.5, { csg: 'union', cutDepth: 0.05 });
    expect(hasBooleanOps(node)).toBe(true);
  });

  it('scales with the body, and stays scaled when the part is next rebuilt', () => {
    load({ ...slab(), id: 'part' });
    const region = flatFaceAt(part(), [5, 0, 0], [-1, 0, 0])!;
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.05, depth: -0.04 });
    scaleNodeTree('part', 2, 1, 1);
    const pocket = () => geomBounds(part().geoms[index])!;
    // On the +X face, now at 0.2; 80 mm deep, since X doubled; across the
    // face unchanged.
    expect(pocket().min[0]).toBeCloseTo(0.2 - 0.08, 6);
    expect(pocket().max[1]).toBeCloseTo(0.15, 6);
    expect(pocket().max[2]).toBeCloseTo(0.25, 6);
    reconcileCuts(part());
    expect(pocket().min[0]).toBeCloseTo(0.12, 6);
  });

  it('takes a new border from the sidebar, against its own face', () => {
    load({ ...slab(), id: 'part' });
    const region = flatFaceAt(part(), [0, 0, 5], [0, 0, -1])!;
    const index = useStore.getState().setFaceFeature('part', region, { border: 0.02, depth: -0.05 });
    useStore.getState().setFaceFeatureBorder('part', index, 50);
    const feature = part().geoms[index];
    expect(feature.cutBorder).toBeCloseTo(0.05, 9);
    expect(feature.size).toEqual([0.05, 0.15, expect.any(Number)]);
    // Wider than the face: refused, and the feature is left as it was.
    useStore.getState().setFaceFeatureBorder('part', index, 500);
    expect(part().geoms[index].cutBorder).toBeCloseTo(0.05, 9);
  });
});
