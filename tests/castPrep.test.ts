import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import createOpenSCAD from '@lofcz/openscad-wasm';
import { findFeatureEdges } from '../src/utils/featureEdges';
import { relaxFacetedCurveSetbacks } from '../src/utils/edgeRoundBase';
import { csgProgram } from '../src/utils/csg';
import { indexScadTriangles } from '../src/utils/scadMesh';
import { analyzeMesh, meshShells, weldByPosition } from '../src/utils/meshIntegrity';
import { meshWatertightIssue, stripAddedCircleEdges } from '../src/utils/castPrepRunner';
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
import type { CastPrep, EdgeRoundFeature, SceneGraph, SceneNode } from '../src/types/scene';

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

  it('never flips an upward-facing fillet strip into an overhang when clamping adjacent vertices', () => {
    // A tall revolved boss sitting on a flange with a concave 3 mm fillet at its foot
    // and a tight horizontal ring vertex 0.6 mm past the fillet toe (forcing clamping).
    const pts = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(0.04, 0),
      new THREE.Vector2(0.04, 0.012),
      new THREE.Vector2(0.0356, 0.012), // tight ring 0.6 mm from fillet toe
      new THREE.Vector2(0.035, 0.012),
      new THREE.Vector2(0.0335, 0.0125),
      new THREE.Vector2(0.0325, 0.0135),
      new THREE.Vector2(0.032, 0.015),
      new THREE.Vector2(0.032, 0.060),
      new THREE.Vector2(0, 0.060),
    ];
    const g = new THREE.LatheGeometry(pts, 24).rotateX(Math.PI / 2).toNonIndexed();
    const tris = Array.from(g.attributes.position.array as ArrayLike<number>);
    const { positions, faces } = draftTriangles(tris, { deg: 2.5, mode: 'add', partingZ: 0 });
    expect(indexedSignedVolume(positions, faces)).toBeGreaterThan(0);
    // Every triangle strictly above the base plane must stay non-undercut (nz >= -sin(1°)).
    const maxNegNz = Math.sin((1 * Math.PI) / 180);
    for (let f = 0; f < faces.length; f += 3) {
      const a = new THREE.Vector3().fromArray(positions, faces[f] * 3);
      const b = new THREE.Vector3().fromArray(positions, faces[f + 1] * 3);
      const c = new THREE.Vector3().fromArray(positions, faces[f + 2] * 3);
      const cz = (a.z + b.z + c.z) / 3;
      if (cz <= 1e-4) continue;
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      expect(n.z).toBeGreaterThanOrEqual(-maxNegNz);
    }
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

  it('preserves custom density and physical material properties when baking a CSG mesh', () => {
    const tris = cubeTris();
    const verts = tris.map((v, i) => (i % 3 === 2 ? v - 0.01 : v));
    const node = {
      id: 'bronze_csg', name: 'bronze_csg', type: 'body', pos: [0, 0, 0.01], children: [], csgEnabled: true,
      geoms: [
        {
          name: 'src', type: 'box', size: [0.01, 0.01, 0.01],
          density: 8800, friction: [0.4, 0.01, 0.001], contype: 2, conaffinity: 3, margin: 0.001, gap: 0.0005,
        },
        { name: 'hole', type: 'cylinder', size: [0.003, 0.012], csg: 'difference', density: 1000 },
        {
          name: 'bronze_csg_csg', type: 'mesh', size: [1], role: 'visual', mass: 0, csgDerived: 'visual',
          renderVertices: verts, vertices: [], faces: verts.map((_, i) => i).filter((i) => i < verts.length / 3),
        },
        { name: 'bronze_csg_col0', type: 'box', size: [0.01, 0.01, 0.01], role: 'collision', csgDerived: 'collider' },
      ],
    } as unknown as SceneNode;
    const [world] = eachBody({ nodes: [node] }).map((b) => b.world);
    const geoms = draftBodyGeoms(node, world, params)!;
    expect(geoms).toHaveLength(1);
    expect(geoms[0].mass).toBeUndefined();
    expect(geoms[0].density).toBe(8800);
    expect(geoms[0].friction).toEqual([0.4, 0.01, 0.001]);
    expect(geoms[0].contype).toBe(2);
    expect(geoms[0].conaffinity).toBe(3);
    expect(geoms[0].margin).toBe(0.001);
    expect(geoms[0].gap).toBe(0.0005);
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

  it('drafts the untextured base solid, sets dynamic = true, and preserves surface textures', () => {
    const coin: SceneNode = {
      id: 'coin',
      name: 'coin',
      type: 'body',
      pos: [0, 0, 0.15],
      geoms: [{
        type: 'cylinder',
        size: [0.05, 0.01],
        textures: [{
          id: 'lotus',
          pattern: 'lotus_mandala',
          seedAt: [0, 0, 0.01],
          seedNormal: [0, 0, 1],
          scale: 0.05,
          depth: 0.003,
          angle: 0,
          invert: false,
          fadeMargin: 0.005,
          cellSize: 0.0004,
          creaseDeg: 35,
          maxTiltDeg: 60,
          aroundClaimed: true,
        }],
      }],
    };
    const scene: SceneGraph = { nodes: [coin] };
    scene.castPrep = prepped(scene);
    bakeDraftInto(scene, scene.castPrep, { deg: 2, mode: 'add', partingZ: 0.14 });
    const baked = scene.nodes[0].geoms[0];
    expect(baked.type).toBe('mesh');
    expect(baked.dynamic).toBe(true);
    // Base cylinder mesh is 192 faces (not 330,000+ textured faces).
    expect(baked.faces!.length / 3).toBeLessThan(500);
    expect(baked.textures).toHaveLength(1);
    expect(baked.textures![0].pattern).toBe('lotus_mandala');
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

  it('keeps clearance on narrow counterbore shelves so opposing roundings never leave a 0.01 mm sliver', () => {
    // Two concentric counterbore floor rims separated by 1.61 mm (maxSetback = 0.805 mm each).
    const outer = {
      id: 0, closed: true, surfaces: [0, 1] as [number, number], angleDeg: 90, maxSetback: 0.000805,
      top: false, bottom: false, vertical: false, points: [[0.00436, 0, 0] as [number, number, number]],
      edge: {
        kind: 'circle' as const, centre: [0, 0, 0], axis: [0, 0, 1], radius: 0.00436, ref: [1, 0, 0], segments: 32,
        n1: [0, 0, 1], n2: [-1, 0, 0], t1: [-1, 0, 0], t2: [0, 0, 1], convex: false,
      },
    };
    const inner = {
      id: 1, closed: true, surfaces: [0, 2] as [number, number], angleDeg: 90, maxSetback: 0.000805,
      top: false, bottom: false, vertical: false, points: [[0.00275, 0, 0] as [number, number, number]],
      edge: {
        kind: 'circle' as const, centre: [0, 0, 0], axis: [0, 0, 1], radius: 0.00275, ref: [1, 0, 0], segments: 32,
        n1: [0, 0, 1], n2: [-1, 0, 0], t1: [1, 0, 0], t2: [0, 0, -1], convex: true,
      },
    };
    const plan = planEdgeRounds([outer, inner], 0.01, 1);
    const totalSetback = plan.features.reduce((sum, f) => sum + f.size * f.edges.length, 0);
    // Remaining flat shelf must be well above the 0.01 mm STL weld grid (>= 0.2 mm).
    expect(0.00161 - totalSetback).toBeGreaterThanOrEqual(0.0002 - 1e-9);
  });
});

describe('cast prep watertightness with M5 counterbore holes', () => {
  let modPromise: Promise<WebAssembly.Module> | null = null;
  async function compileScadNode(scad: string) {
    if (!modPromise) {
      const wasm = fs.readFileSync('node_modules/@lofcz/openscad-wasm/openscad.wasm');
      modPromise = WebAssembly.compile(wasm);
    }
    const mod = await modPromise;
    const inst = await createOpenSCAD({
      noInitialRun: true,
      print: () => {},
      printErr: () => {},
      instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
        WebAssembly.instantiate(mod, imports).then((i) => done(i, mod));
        return {};
      },
    });
    inst.FS.writeFile('/in.scad', scad);
    inst.callMain(['/in.scad', '-o', '/out.stl', '--backend', 'Manifold', '--export-format', 'binstl']);
    const stl = inst.FS.readFile('/out.stl');
    const buf = stl.buffer.slice(stl.byteOffset, stl.byteOffset + stl.byteLength);
    const geom = new STLLoader().parse(buf);
    return indexScadTriangles(geom.attributes.position.array as Float32Array);
  }

  it('preserves watertightness (0 non-manifold edges) through edges=true + 3 deg sand draft on CSG parts with M5 counterbores', async () => {
    const parts: SceneNode[] = [
      // Flange plate with 4 tight M5 counterbores + central boss
      {
        id: 'flange', name: 'flange', type: 'body', pos: [0, 0, 0.005], csgEnabled: true, children: [],
        geoms: [
          { name: 'plate', type: 'box', size: [0.03, 0.03, 0.005], pos: [0, 0, 0] },
          { name: 'boss', type: 'cylinder', size: [0.012, 0.008], pos: [0, 0, 0.005], csg: 'union' },
          { name: 'bore', type: 'cylinder', size: [0.006, 0.02], pos: [0, 0, 0.005], csg: 'difference' },
          ...([-1, 1].flatMap((sx) => [-1, 1].map((sy) => [sx * 0.021, sy * 0.021]))).flatMap(([x, y], i) => [
            { name: `h${i}`, type: 'cylinder', size: [0.00275, 0.012], pos: [x, y, 0], csg: 'difference' },
            { name: `cb${i}`, type: 'cylinder', size: [0.00438, 0.0055], pos: [x, y, 0.005], csg: 'difference' },
          ]),
        ],
      } as unknown as SceneNode,
      // Gusseted L-bracket with M5 counterbore mounting holes
      {
        id: 'gusset_bracket', name: 'gusset_bracket', type: 'body', pos: [0, 0, 0.005], csgEnabled: true, children: [],
        geoms: [
          { name: 'base', type: 'box', size: [0.03, 0.02, 0.005], pos: [0, 0, 0] },
          { name: 'wall', type: 'box', size: [0.03, 0.005, 0.02], pos: [0, -0.015, 0.015] },
          { name: 'gusset', type: 'box', size: [0.004, 0.015, 0.015], pos: [0, -0.005, 0.015] },
          { name: 'h1', type: 'cylinder', size: [0.00275, 0.012], pos: [-0.018, 0.005, 0], csg: 'difference' },
          { name: 'cb1', type: 'cylinder', size: [0.00475, 0.0055], pos: [-0.018, 0.005, 0.005], csg: 'difference' },
          { name: 'h2', type: 'cylinder', size: [0.00275, 0.012], pos: [0.018, 0.005, 0], csg: 'difference' },
          { name: 'cb2', type: 'cylinder', size: [0.00475, 0.0055], pos: [0.018, 0.005, 0.005], csg: 'difference' },
        ],
      } as unknown as SceneNode,
    ];

    for (const node of parts) {
      const baseMesh = await compileScadNode(csgProgram(node, { rounds: false, always: true })!);
      const baseW = weldByPosition(baseMesh.renderVertices, baseMesh.faces);
      expect(analyzeMesh(baseW.positions, baseW.faces)?.closed).toBe(true);

      const found = findFeatureEdges(baseMesh.renderVertices, baseMesh.faces, { up: [0, 0, 1] });
      relaxFacetedCurveSetbacks(found, baseMesh.renderVertices, baseMesh.faces);
      const world = new THREE.Matrix4().makeTranslation(node.pos![0], node.pos![1], node.pos![2]);
      const plan = planEdgeRounds(found.edges, 0.01, 1, [], (e) => e.edge.convex && edgeOnPlane(e, world, 0));
      expect(plan.broken).toBeGreaterThan(0);

      const roundedMesh = await compileScadNode(csgProgram({ ...node, edgeRounds: plan.features })!);
      const roundedW = weldByPosition(roundedMesh.renderVertices, roundedMesh.faces);
      const roundedIntegrity = analyzeMesh(roundedW.positions, roundedW.faces)!;
      expect(roundedIntegrity.closed).toBe(true);
      expect(roundedIntegrity.nonManifoldEdges).toBe(0);
      expect(roundedIntegrity.boundaryEdges).toBe(0);

      // Apply 3 deg sand draft on top of the rounded mesh.
      const tris: number[] = [];
      const rv = roundedMesh.renderVertices;
      for (let i = 0; i < roundedMesh.faces.length; i++) {
        const vi = roundedMesh.faces[i] * 3;
        tris.push(rv[vi] + node.pos![0], rv[vi + 1] + node.pos![1], rv[vi + 2] + node.pos![2]);
      }
      const drafted = draftTriangles(tris, { deg: 3, mode: 'add', partingZ: 0 });
      const draftedW = weldByPosition(drafted.positions, drafted.faces);
      const draftedIntegrity = analyzeMesh(draftedW.positions, draftedW.faces)!;
      expect(draftedIntegrity.closed).toBe(true);
      expect(draftedIntegrity.nonManifoldEdges).toBe(0);
      expect(draftedIntegrity.boundaryEdges).toBe(0);
    }
  }, 30000);

  it('keeps M5 countersunk holes in a 13 mm base plate open (> 4 mm) and watertight when a 65 mm tall hook rises above the plate', async () => {
    // Round 2 dogfooding repro: 13 mm shield backplate (Z in [0, 13] mm) with
    // two Ø5.5 mm M5 countersunk holes plus a tall hook rising to Z = 65 mm.
    const holeX = [-0.025, 0.025];
    const plateNode = {
      id: 'shield_plate', name: 'shield_plate', type: 'body', pos: [0, 0, 0.0065], csgEnabled: true, children: [],
      geoms: [
        // 13 mm base plate: Z in [-0.0065, +0.0065] local -> [0, 13] mm world
        { name: 'plate', type: 'box', size: [0.05, 0.03, 0.0065], pos: [0, 0, 0] },
        // Tall hook rising to Z = 65 mm world (local Z from +0.0045 to +0.0585, overlapping 2 mm into plate)
        { name: 'hook', type: 'box', size: [0.01, 0.008, 0.027], pos: [0, -0.015, 0.0315], csg: 'union' },
        // Two Ø5.5 mm M5 through-holes (R = 2.75 mm) + 90° countersinks (Z in [6, 13] mm)
        ...holeX.flatMap((hx, i) => [
          { name: `hole_${i}`, type: 'cylinder', size: [0.00275, 0.016], pos: [hx, 0.008, 0], csg: 'difference' },
          { name: `csink_${i}`, type: 'cylinder', size: [0.005, 0.004], pos: [hx, 0.008, 0.0055], csg: 'difference' },
        ]),
      ],
    } as unknown as SceneNode;

    const baseMesh = await compileScadNode(csgProgram(plateNode, { rounds: false, always: true })!);
    const baseW = weldByPosition(baseMesh.renderVertices, baseMesh.faces);
    expect(analyzeMesh(baseW.positions, baseW.faces)?.closed).toBe(true);

    // Measure minimum radius around each hole centre (hx, 0.008) for vertices within 4 mm of the hole axis.
    const minHoleDiameterMm = (positions: ArrayLike<number>, hx: number, hy: number): number => {
      let minR = Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        const z = positions[i + 2];
        if (z < -1e-4 || z > 0.0131) continue;
        const r = Math.hypot(positions[i] - hx, positions[i + 1] - hy);
        if (r < 0.0042) minR = Math.min(minR, r);
      }
      return minR * 2000;
    };

    const toWorldTris = (rv: ArrayLike<number>, faces: ArrayLike<number>) => {
      const tris: number[] = [];
      for (let i = 0; i < faces.length; i++) {
        const vi = faces[i] * 3;
        tris.push(rv[vi] + plateNode.pos![0], rv[vi + 1] + plateNode.pos![1], rv[vi + 2] + plateNode.pos![2]);
      }
      return tris;
    };

    // Test 2° and 3° draft on the base mesh
    const baseTris = toWorldTris(baseMesh.renderVertices, baseMesh.faces);
    for (const deg of [2, 3]) {
      const drafted = draftTriangles(baseTris, { deg, mode: 'add', partingZ: 0 });
      const w = weldByPosition(drafted.positions, drafted.faces);
      const integrity = analyzeMesh(w.positions, w.faces)!;
      const shells = meshShells(w.positions, w.faces)!;
      expect(integrity.closed).toBe(true);
      expect(integrity.consistentlyWound).toBe(true);
      expect(integrity.boundaryEdges).toBe(0);
      expect(integrity.nonManifoldEdges).toBe(0);
      expect(integrity.degenerateTriangles).toBe(0);
      expect(integrity.volume).toBeGreaterThan(0);
      expect(shells.shells).toBe(1);
      expect(shells.pieces).toBe(1);
      expect(shells.voids).toBe(0);
      for (const hx of holeX) {
        expect(minHoleDiameterMm(drafted.positions, hx, 0.008)).toBeGreaterThan(4.0);
      }
    }

    // Also test full cast-prep pipeline: edges=true + 3° sand draft
    const found = findFeatureEdges(baseMesh.renderVertices, baseMesh.faces, { up: [0, 0, 1] });
    relaxFacetedCurveSetbacks(found, baseMesh.renderVertices, baseMesh.faces);
    const world = new THREE.Matrix4().makeTranslation(plateNode.pos![0], plateNode.pos![1], plateNode.pos![2]);
    const plan = planEdgeRounds(found.edges, 0.013, 1, [], (e) => e.edge.convex && edgeOnPlane(e, world, 0));
    expect(plan.broken).toBeGreaterThan(0);

    const roundedMesh = await compileScadNode(csgProgram({ ...plateNode, edgeRounds: plan.features })!);
    const roundedDrafted = draftTriangles(
      toWorldTris(roundedMesh.renderVertices, roundedMesh.faces),
      { deg: 3, mode: 'add', partingZ: 0 },
    );
    const rw = weldByPosition(roundedDrafted.positions, roundedDrafted.faces);
    const rIntegrity = analyzeMesh(rw.positions, rw.faces)!;
    const rShells = meshShells(rw.positions, rw.faces)!;
    expect(rIntegrity.closed).toBe(true);
    expect(rIntegrity.consistentlyWound).toBe(true);
    expect(rIntegrity.nonManifoldEdges).toBe(0);
    expect(rIntegrity.boundaryEdges).toBe(0);
    expect(rShells.shells).toBe(1);
    expect(rShells.pieces).toBe(1);
    for (const hx of holeX) {
      expect(minHoleDiameterMm(roundedDrafted.positions, hx, 0.008)).toBeGreaterThan(4.0);
    }
  }, 30000);

  it('prevents hole inversion even when local draft alone would exceed the hole radius', async () => {
    // Deep Ø4 mm hole (R = 2 mm) in a 50 mm tall block drafted at 5°:
    // 50 * tan(5°) = 4.37 mm > 2 mm radius. The orientation guard must prevent inversion.
    const deepBlock = {
      id: 'deep_hole', name: 'deep_hole', type: 'body', pos: [0, 0, 0.025], csgEnabled: true, children: [],
      geoms: [
        { name: 'block', type: 'box', size: [0.015, 0.015, 0.025], pos: [0, 0, 0] },
        { name: 'hole', type: 'cylinder', size: [0.002, 0.03], pos: [0, 0, 0], csg: 'difference' },
      ],
    } as unknown as SceneNode;
    const mesh = await compileScadNode(csgProgram(deepBlock, { rounds: false, always: true })!);
    const tris: number[] = [];
    for (let i = 0; i < mesh.faces.length; i++) {
      const vi = mesh.faces[i] * 3;
      tris.push(mesh.renderVertices[vi], mesh.renderVertices[vi + 1], mesh.renderVertices[vi + 2] + 0.025);
    }
    const drafted = draftTriangles(tris, { deg: 5, mode: 'add', partingZ: 0 });
    const w = weldByPosition(drafted.positions, drafted.faces);
    const integrity = analyzeMesh(w.positions, w.faces)!;
    const shells = meshShells(w.positions, w.faces)!;
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    expect(integrity.volume).toBeGreaterThan(0);
    expect(shells.shells).toBe(1);
    expect(shells.pieces).toBe(1);
    // Hole stays open (radius > 0)
    let minR = Infinity;
    for (let i = 0; i < drafted.positions.length; i += 3) {
      const r = Math.hypot(drafted.positions[i], drafted.positions[i + 1]);
      if (r < 0.004) minR = Math.min(minR, r);
    }
    expect(minR).toBeGreaterThan(0.0001);
  }, 30000);

  it('meshWatertightIssue detects open/non-manifold CSG meshes and stripAddedCircleEdges drops only newly added rims', () => {
    // Open tetrahedron (missing one face -> 3 boundary edges)
    const openNode = {
      id: 'open', name: 'open', type: 'body', pos: [0, 0, 0], csgEnabled: true, children: [],
      geoms: [{
        name: 'open_csg', type: 'mesh', csgDerived: 'visual', role: 'visual', size: [1],
        renderVertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
        faces: [0, 2, 1, 0, 1, 3, 1, 2, 3],
      }],
    } as unknown as SceneNode;
    expect(meshWatertightIssue(openNode)).toContain('boundary edges');

    // Closed tetrahedron
    const closedNode = {
      ...openNode,
      geoms: [{ ...openNode.geoms[0], faces: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3] }],
    } as unknown as SceneNode;
    expect(meshWatertightIssue(closedNode)).toBeNull();

    // stripAddedCircleEdges preserves pre-existing circle features and drops newly-added circles only.
    const existingCircle: EdgeRoundFeature = {
      mode: 'chamfer', size: 0.001,
      edges: [{ kind: 'circle', centre: [0, 0, 0], axis: [0, 0, 1], radius: 0.005, ref: [1, 0, 0], segments: 32, n1: [0, 0, 1], n2: [-1, 0, 0], t1: [1, 0, 0], t2: [0, 0, -1], convex: true }],
    };
    const addedMixed: EdgeRoundFeature = {
      mode: 'chamfer', size: 0.001,
      edges: [
        { kind: 'line', a: [0, 0, 0], b: [0.01, 0, 0], n1: [0, 0, 1], n2: [0, -1, 0], t1: [0, 1, 0], t2: [0, 0, -1], convex: true },
        { kind: 'circle', centre: [0.01, 0, 0], axis: [0, 0, 1], radius: 0.003, ref: [1, 0, 0], segments: 32, n1: [0, 0, 1], n2: [-1, 0, 0], t1: [1, 0, 0], t2: [0, 0, -1], convex: true },
      ],
    };
    const res = stripAddedCircleEdges([existingCircle, addedMixed], 1);
    expect(res.dropped).toBe(1);
    expect(res.features).toHaveLength(2);
    expect(res.features[0]).toBe(existingCircle);
    expect(res.features[1].edges).toHaveLength(1);
    expect(res.features[1].edges[0].kind).toBe('line');
  });
});
