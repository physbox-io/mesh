import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { findFeatureEdges } from '../src/utils/featureEdges';
import {
  bakeDraftInto,
  draftBodyGeoms,
  draftTriangles,
  edgeOnPlane,
  eachBody,
  indexedSignedVolume,
  planEdgeRounds,
  shapeSignature,
  snapshotShape,
  unprepScene,
} from '../src/utils/castPrep';
import type { CastPrep, SceneGraph, SceneNode } from '../src/types/scene';

/** A three geometry as the flat positions + faces the edge finder takes. */
function soup(geometry: THREE.BufferGeometry): { positions: number[]; faces: number[] } {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = Array.from(g.attributes.position.array as ArrayLike<number>);
  return { positions, faces: positions.map((_, i) => i).filter((i) => i < positions.length / 3) };
}

/** A body holding one 20 mm cube whose base sits on z = 0 (or `baseZ`). */
function cubeNode(id = 'cube', baseZ = 0, parent?: Partial<SceneNode>): SceneNode {
  return {
    id, name: id, type: 'body', pos: [0, 0, baseZ + 0.01],
    geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01], rgba: [0.2, 0.4, 0.6, 1], mass: 0.5 }],
    children: [],
    ...parent,
  } as SceneNode;
}

function bounds(positions: number[], test: (z: number) => boolean) {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (!test(positions[i + 2])) continue;
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
  }
  return { minX, maxX };
}

/** Angle of each non-flat face from vertical, degrees. */
function wallTilts(positions: number[], faces: number[]): number[] {
  const out: number[] = [];
  for (let f = 0; f < faces.length; f += 3) {
    const a = new THREE.Vector3().fromArray(positions, faces[f] * 3);
    const b = new THREE.Vector3().fromArray(positions, faces[f + 1] * 3);
    const c = new THREE.Vector3().fromArray(positions, faces[f + 2] * 3);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    if (Math.abs(n.z) > 0.5) continue;
    out.push((Math.asin(Math.abs(n.z)) * 180) / Math.PI);
  }
  return out;
}

function cubeTris(): number[] {
  const g = new THREE.BoxGeometry(0.02, 0.02, 0.02).translate(0, 0, 0.01).toNonIndexed();
  return Array.from(g.attributes.position.array as ArrayLike<number>);
}

describe('draftTriangles', () => {
  const tan2 = Math.tan((2 * Math.PI) / 180);

  it('adds material: the base grows by H·tanθ a side, the top stays nominal', () => {
    const { positions, faces } = draftTriangles(cubeTris(), { deg: 2, mode: 'add', partingZ: 0 });
    const base = bounds(positions, (z) => z < 1e-9);
    const top = bounds(positions, (z) => z > 0.02 - 1e-9);
    expect(base.maxX).toBeCloseTo(0.01 + 0.02 * tan2, 9);
    expect(base.minX).toBeCloseTo(-0.01 - 0.02 * tan2, 9);
    expect(top.maxX).toBeCloseTo(0.01, 9);
    for (const t of wallTilts(positions, faces)) expect(t).toBeCloseTo(2, 1);
    expect(indexedSignedVolume(positions, faces)).toBeGreaterThan(0);
  });

  it('removes material: the parting face stays nominal, the top shrinks', () => {
    const { positions } = draftTriangles(cubeTris(), { deg: 2, mode: 'remove', partingZ: 0 });
    expect(bounds(positions, (z) => z < 1e-9).maxX).toBeCloseTo(0.01, 9);
    expect(bounds(positions, (z) => z > 0.02 - 1e-9).maxX).toBeCloseTo(0.01 - 0.02 * tan2, 9);
  });

  it('tapers both ways from a mid-height parting plane', () => {
    const { positions } = draftTriangles(cubeTris(), { deg: 2, mode: 'add', partingZ: 0.01 });
    const top = bounds(positions, (z) => z > 0.02 - 1e-9).maxX;
    const bottom = bounds(positions, (z) => z < 1e-9).maxX;
    expect(top).toBeCloseTo(0.01, 9);
    expect(bottom).toBeCloseTo(0.01, 9);
    // Nothing on the plane itself, but a box has no vertex there; the faces
    // still lean, so the widest point is where the plane cuts them.
  });

  it('closes a pocket in toward its floor', () => {
    // A 20 mm square ring: an outer box with a 10 mm square hole through it.
    const shape = new THREE.Shape();
    shape.moveTo(-0.01, -0.01); shape.lineTo(0.01, -0.01); shape.lineTo(0.01, 0.01); shape.lineTo(-0.01, 0.01); shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-0.005, -0.005); hole.lineTo(-0.005, 0.005); hole.lineTo(0.005, 0.005); hole.lineTo(0.005, -0.005); hole.closePath();
    shape.holes.push(hole);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false }).toNonIndexed();
    const tris = Array.from(g.attributes.position.array as ArrayLike<number>);
    const { positions, faces } = draftTriangles(tris, { deg: 2, mode: 'add', partingZ: 0 });
    // The hole's wall at the base has moved in, toward the axis.
    let innerBase = Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i + 2] > 1e-9) continue;
      const r = Math.max(Math.abs(positions[i]), Math.abs(positions[i + 1]));
      innerBase = Math.min(innerBase, r);
    }
    expect(innerBase).toBeCloseTo(0.005 - 0.02 * Math.tan((2 * Math.PI) / 180), 6);
    expect(indexedSignedVolume(positions, faces)).toBeGreaterThan(0);
  });
});

describe('baking draft into a scene', () => {
  const params = { deg: 2, mode: 'add' as const, partingZ: 0 };

  function prepped(scene: SceneGraph): CastPrep {
    const originals: CastPrep['originals'] = {};
    for (const { node } of eachBody(scene)) originals[node.id] = { shape: snapshotShape(node), signature: shapeSignature(node) };
    return { draftDeg: 2, draftMode: 'add', partingZ: 0, edges: null, originals, skipped: [], sharpEdges: 0 };
  }

  it('writes each body a mesh in its own frame, keeping colour and mass', () => {
    const node = cubeNode();
    const [world] = eachBody({ nodes: [node] }).map((b) => b.world);
    const geoms = draftBodyGeoms(node, world, params)!;
    expect(geoms).toHaveLength(1);
    expect(geoms[0].type).toBe('mesh');
    expect(geoms[0].rgba).toEqual([0.2, 0.4, 0.6, 1]);
    expect(geoms[0].mass).toBe(0.5);
    // Body-local: the cube's centre is the body origin, so local z runs ±10 mm.
    const z = geoms[0].renderVertices!.filter((_, i) => i % 3 === 2);
    expect(Math.min(...z)).toBeCloseTo(-0.01, 9);
    expect(Math.max(...z)).toBeCloseTo(0.01, 9);
    expect(indexedSignedVolume(geoms[0].renderVertices!, geoms[0].faces!)).toBeGreaterThan(0);
  });

  it('drafts a decomposed boolean from its generated mesh, and gives it back its weight', () => {
    // As csg.ts leaves a boolean whose colliders were split out: the drawn mesh
    // is marked visual and weightless, and the colliders carry the rest.
    const tris = cubeTris();
    const verts = tris.map((v, i) => (i % 3 === 2 ? v - 0.01 : v));
    const node = {
      id: 'b', name: 'b', type: 'body', pos: [0, 0, 0.01], children: [], csgEnabled: true, csgMass: 0.7,
      geoms: [
        { name: 'src', type: 'box', size: [0.01, 0.01, 0.01] },
        { name: 'b_csg', type: 'mesh', size: [1], role: 'visual', mass: 0, csgDerived: 'visual',
          renderVertices: verts, vertices: [], faces: verts.map((_, i) => i).filter((i) => i < verts.length / 3) },
        { name: 'b_col0', type: 'box', size: [0.01, 0.01, 0.01], role: 'collision', csgDerived: 'collider' },
      ],
    } as unknown as SceneNode;
    const [world] = eachBody({ nodes: [node] }).map((b) => b.world);
    const geoms = draftBodyGeoms(node, world, params)!;
    expect(geoms).toHaveLength(1);
    expect(geoms[0].role).toBeUndefined();
    expect(geoms[0].csgDerived).toBeUndefined();
    expect(geoms[0].mass).toBe(0.7);
  });

  it('respects a child body\'s world transform', () => {
    const child = cubeNode('child', 0);
    child.pos = [0, 0, 0.03];
    const parent = cubeNode('parent', 0, { children: [child] });
    const scene: SceneGraph = { nodes: [parent] };
    const prep = prepped(scene);
    bakeDraftInto(scene, prep, params);
    // The child is placed 30 mm above its parent's centre (z = 0.01), so it
    // spans z = 0.03 to 0.05 in the world.
    const g = scene.nodes[0].children[0].geoms[0];
    const v = g.renderVertices!;
    let baseMax = -Infinity;
    for (let i = 0; i < v.length; i += 3) if (v[i + 2] < -0.01 + 1e-9) baseMax = Math.max(baseMax, v[i]);
    // H for the child is 0.05 above the plane, its base is at h = 0.03.
    expect(baseMax).toBeCloseTo(0.01 + (0.05 - 0.03) * Math.tan((2 * Math.PI) / 180), 9);
  });

  it('round-trips: switching off restores what was there', () => {
    const scene: SceneGraph = { nodes: [cubeNode('a'), cubeNode('b')] };
    const before = JSON.parse(JSON.stringify(scene.nodes));
    scene.castPrep = prepped(scene);
    bakeDraftInto(scene, scene.castPrep, params);
    expect(scene.nodes[0].geoms[0].type).toBe('mesh');
    const { restored, kept } = unprepScene(scene);
    expect(restored).toEqual(['a', 'b']);
    expect(kept).toEqual([]);
    expect(scene.castPrep).toBeUndefined();
    expect(JSON.parse(JSON.stringify(scene.nodes))).toEqual(before);
  });

  it('keeps a body that was edited after prep, and names it', () => {
    const scene: SceneGraph = { nodes: [cubeNode('a'), cubeNode('b')] };
    scene.castPrep = prepped(scene);
    bakeDraftInto(scene, scene.castPrep, params);
    scene.nodes[1].geoms[0] = { ...scene.nodes[1].geoms[0], faces: scene.nodes[1].geoms[0].faces!.slice(3) };
    const { restored, kept } = unprepScene(scene);
    expect(restored).toEqual(['a']);
    expect(kept).toEqual([{ id: 'b', name: 'b' }]);
    expect(scene.nodes[1].geoms[0].type).toBe('mesh');
  });

  it('drops the generator so a baked wedge is not regenerated', () => {
    const node = cubeNode('w', 0, { isWedge: true, edgeRounds: [] } as Partial<SceneNode>);
    const scene: SceneGraph = { nodes: [node] };
    scene.castPrep = prepped(scene);
    bakeDraftInto(scene, scene.castPrep, params);
    expect(scene.nodes[0].isWedge).toBeUndefined();
    expect(scene.nodes[0].edgeRounds).toBeUndefined();
    unprepScene(scene);
    expect(scene.nodes[0].isWedge).toBe(true);
  });
});

describe('planEdgeRounds', () => {
  /** An L-shaped prism 30 × 30 × 20 mm, 10 mm thick legs. */
  function lEdges() {
    const l = new THREE.Shape();
    l.moveTo(0, 0); l.lineTo(0.03, 0); l.lineTo(0.03, 0.01); l.lineTo(0.01, 0.01); l.lineTo(0.01, 0.03); l.lineTo(0, 0.03); l.closePath();
    const { positions, faces } = soup(new THREE.ExtrudeGeometry(l, { depth: 0.02, bevelEnabled: false }));
    return findFeatureEdges(positions, faces).edges;
  }

  it('chamfers outside edges and fillets the inside corner', () => {
    const plan = planEdgeRounds(lEdges(), 0.01, 1);
    const chamfered = plan.features.filter((f) => f.mode === 'chamfer').flatMap((f) => f.edges);
    const filleted = plan.features.filter((f) => f.mode === 'fillet').flatMap((f) => f.edges);
    expect(chamfered).toHaveLength(17);
    expect(chamfered.every((e) => e.convex)).toBe(true);
    expect(filleted).toHaveLength(1);
    expect(filleted[0].convex).toBe(false);
    expect(plan.chamfer).toBeCloseTo(0.001, 9);
    expect(plan.fillet).toBeCloseTo(0.0015, 9);
    expect(plan.sharp).toBe(0);
  });

  it('caps each edge at what fits on it, without capping the rest', () => {
    // 8 mm is more than the 10 mm legs' 5 mm halves allow, but the 30 mm faces take more.
    const plan = planEdgeRounds(lEdges(), 0.01, 8);
    const sizes = new Set(plan.features.map((f) => f.size));
    expect(sizes.size).toBeGreaterThan(1);
    for (const f of plan.features) expect(f.size).toBeLessThanOrEqual(0.008 * 1.5 + 1e-9);
  });

  it('counts edges too small to break as sharp', () => {
    const plan = planEdgeRounds(lEdges(), 0.01, 0.2);
    expect(plan.features).toHaveLength(0);
    expect(plan.sharp).toBe(18);
  });

  it('leaves edges the body already rounds alone, and keeps those roundings', () => {
    const edges = lEdges();
    const existing = [{ mode: 'fillet' as const, size: 0.002, edges: [edges[0].edge] }];
    const plan = planEdgeRounds(edges, 0.01, 1, existing);
    expect(plan.features[0]).toBe(existing[0]);
    expect(plan.broken).toBe(17);
  });

  it('leaves the parting face\'s edges sharp when told to', () => {
    const edges = lEdges();
    const world = new THREE.Matrix4();
    const plan = planEdgeRounds(edges, 0.01, 1, [], (e) => e.edge.convex && edgeOnPlane(e, world, 0));
    // The L's base outline is six edges.
    expect(plan.broken).toBe(12);
  });
});
