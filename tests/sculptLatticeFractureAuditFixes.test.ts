/**
 * Regression tests for General Audit #2:
 * Sculpting, Lattice, Edge Rounding, Knife/Dent & Fracture / Mesh BVH.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { ManifoldToplevel } from 'manifold-3d';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setSound() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

import { buildFlatBvh, installMeshBvh, queryFlatBvhRay } from '../src/utils/meshBvh';
import { MeshBvhWorkerClient } from '../src/utils/meshBvhWorkerClient';
import type { MeshBvhRequest, MeshBvhResponse } from '../src/workers/meshBvhProtocol';
import { shatterSourceOf, yupToZup } from '../src/store/shatterCut';
import { buildShatterGraph, matToQuat, volumeCentroid, zupToYup } from '../src/utils/runtimeShatter';
import { fractureMesh, seedPoints, voronoiCells } from '../src/utils/fracture';
import { fractureSolid } from '../src/utils/fractureClip';
import {
  crossSection, edgeRoundSolids, edgeSolidScad, hasEdgeRounds, setbackOf, withRoundFeature,
} from '../src/utils/edgeRound';
import { dentKey, useDentStore } from '../src/store/dentStore';
import { icosphere, toSceneGeom } from '../src/utils/sculptMesh';
import { resizeSculptMesh, resizeSculptMeshAxes } from '../src/utils/sculptBases';
import { applySculptStroke, probeSurface } from '../src/utils/sculptCommands';
import { loadManifold, polygonPrismMap } from '../src/utils/sculptCut';
import {
  addFace, bevelFace, boxLattice, createLattice, DEFAULT_UNIT, faceCount, serializeCage,
  toSceneGeom as latticeToSceneGeom, vertexAt,
} from '../src/utils/latticeMesh';
import { runLatticeOps, commitLattice } from '../src/hooks/mcp/latticeState';
import { latticeCommands } from '../src/hooks/mcp/latticeCommands';
import { sculptCommands } from '../src/hooks/mcp/sculptCommands';
import { sculptGeomIndex, sculptHistory } from '../src/hooks/mcp/sculptState';
import type { RoundEdge, SceneGeom, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let wasm: ManifoldToplevel;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  wasm = await loadManifold();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. Mesh BVH & BVH Worker Client
// ---------------------------------------------------------------------------

describe('meshBvh axis-aligned slab & worker buffer hygiene', () => {
  it('queryFlatBvhRay hits triangles when an axis-aligned ray starts on an AABB boundary and culls behind', () => {
    // 20x20 grid (800 triangles > MIN_BVH_TRIANGLES) lying on z = 0 over [0, 1] x [0, 1].
    const geom = new THREE.PlaneGeometry(1, 1, 20, 20);
    geom.translate(0.5, 0.5, 0);
    const pos = geom.attributes.position.array as Float32Array;
    const idx = geom.index!.array as Uint16Array;
    const bvh = buildFlatBvh(pos, idx);
    expect(bvh.nodeCount).toBeGreaterThan(1);

    // Origin sits right on minX = 0 and minY = 0 with dx = 0, dy = 0 (used to trigger 0 * Infinity = NaN).
    const hitCandidates: number[] = [];
    queryFlatBvhRay(bvh, 0, 0, 5, 0, 0, -1, hitCandidates);
    expect(hitCandidates.length).toBeGreaterThan(0);

    // Same ray starting behind the plane (z = -5, pointing -Z) must cull every node (tmax < 0).
    const behindCandidates: number[] = [];
    queryFlatBvhRay(bvh, 0, 0, -5, 0, 0, -1, behindCandidates);
    expect(behindCandidates).toHaveLength(0);

    // Parallel ray outside the X slab must return nothing.
    const outsideCandidates: number[] = [];
    queryFlatBvhRay(bvh, -0.01, 0.5, 5, 0, 0, -1, outsideCandidates);
    expect(outsideCandidates).toHaveLength(0);

    // Degenerate zero-direction or NaN ray must return nothing cleanly.
    const nanCandidates: number[] = [];
    queryFlatBvhRay(bvh, NaN, 0, 5, 0, 0, -1, nanCandidates);
    queryFlatBvhRay(bvh, 0, 0, 5, 0, 0, 0, nanCandidates);
    expect(nanCandidates).toHaveLength(0);

    // End-to-end Three.js raycast along -Z at x = 0, y = 0.25 matches brute force.
    installMeshBvh();
    const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0.25, 2), new THREE.Vector3(0, 0, -1));
    const hits: THREE.Intersection[] = [];
    mesh.raycast(raycaster, hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].point.z).toBeCloseTo(0, 6);
  });

  it('MeshBvhWorkerClient restores transferred buffers on worker error and slices shared/subarray views', async () => {
    const prevWorker = g.Worker;
    let lastRequest: MeshBvhRequest | null = null;
    let lastTransfer: Transferable[] = [];
    class FakeFailingWorker {
      onmessage: ((evt: MessageEvent<MeshBvhResponse>) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      postMessage(req: MeshBvhRequest, transfer: Transferable[] = []) {
        lastRequest = req;
        lastTransfer = transfer;
        // Echo position & index back on failure, as meshBvhWorker.ts now does.
        const returnedPos = new Float32Array(req.position);
        const returnedIdx = req.index ? new Uint16Array(req.index) : null;
        queueMicrotask(() => {
          this.onmessage?.({
            data: { id: req.id, ok: false, error: 'synthetic failure', position: returnedPos, index: returnedIdx },
          } as MessageEvent<MeshBvhResponse>);
        });
      }
      terminate() {}
    }
    g.Worker = FakeFailingWorker;
    try {
      const client = new MeshBvhWorkerClient();

      // 1) Standalone buffers: restored onto geometry even on rejection.
      const geom1 = new THREE.BufferGeometry();
      const pos1 = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const idx1 = new Uint16Array([0, 1, 2]);
      geom1.setAttribute('position', new THREE.BufferAttribute(pos1, 3));
      geom1.setIndex(new THREE.BufferAttribute(idx1, 1));
      await expect(client.generate(geom1)).rejects.toThrow('synthetic failure');
      expect((geom1.attributes.position.array as Float32Array).length).toBe(9);
      expect((geom1.index!.array as Uint16Array).length).toBe(3);

      // 2) Subarray views sharing a single ArrayBuffer: sliced into distinct ArrayBuffers before transfer.
      const shared = new ArrayBuffer(64);
      const posView = new Float32Array(shared, 4, 9);
      posView.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const idxView = new Uint16Array(shared, 40, 3);
      idxView.set([0, 1, 2]);
      const geom2 = new THREE.BufferGeometry();
      geom2.setAttribute('position', new THREE.BufferAttribute(posView, 3));
      geom2.setIndex(new THREE.BufferAttribute(idxView, 1));
      await expect(client.generate(geom2)).rejects.toThrow('synthetic failure');
      expect(lastTransfer).toHaveLength(2);
      expect(lastTransfer[0]).not.toBe(lastTransfer[1]);
      expect(lastRequest!.position.byteOffset).toBe(0);
      expect(lastRequest!.index!.byteOffset).toBe(0);

      client.dispose();
    } finally {
      g.Worker = prevWorker;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Fracture, Runtime Shatter & Shatter Cut
// ---------------------------------------------------------------------------

describe('shatterSourceOf, runtimeShatter & fractureSolid edge cases', () => {
  it('shatterSourceOf picks compiled visual mesh on boolean bodies and ignores difference cutters / colliders', () => {
    const cutterVerts = [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0];
    const visualVerts = [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0, 0, 0.1];
    const faces = [0, 1, 2, 0, 2, 3];
    const csgNode: SceneNode = {
      id: 'part', name: 'part', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      csgEnabled: true,
      geoms: [
        { name: 'box', type: 'box', size: [0.1, 0.1, 0.1] },
        { name: 'pocket_cutter', type: 'mesh', size: [1], csg: 'difference', renderVertices: cutterVerts, faces: [0, 1, 2] },
        { name: 'col0', type: 'mesh', size: [1], csgDerived: 'collider', renderVertices: cutterVerts, faces: [0, 1, 2] },
        { name: 'compiled_visual', type: 'mesh', size: [1], csgDerived: 'visual', renderVertices: visualVerts, faces },
      ],
    };
    const src = shatterSourceOf(csgNode);
    expect(src?.geom.name).toBe('compiled_visual');
    expect(src?.verts).toBe(visualVerts);

    // A node with ONLY collider / difference geoms has no shatterable source mesh.
    const noOwnMesh: SceneNode = {
      ...csgNode,
      csgEnabled: false,
      geoms: [csgNode.geoms[1], csgNode.geoms[2]],
    };
    expect(shatterSourceOf(noOwnMesh)).toBeNull();
  });

  it('shatterSourceOf converts Y-up vertices to Z-up when renderVertices is absent', () => {
    const zup = [0.1, 0.2, 0.3, -0.4, 0.5, -0.6, 0.7, -0.8, 0.9];
    const yup = zupToYup(zup);
    expect(yupToZup(yup).map((v) => +v.toFixed(9))).toEqual(zup);

    const node: SceneNode = {
      id: 'imported', name: 'imported', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{ name: 'm', type: 'mesh', size: [1], vertices: yup, faces: [0, 1, 2] }],
    };
    const src = shatterSourceOf(node)!;
    expect(src.verts.map((v) => +v.toFixed(9))).toEqual(zup);
  });

  it('volumeCentroid falls back to vertex centroid on zero-volume shells and matToQuat survives drifted xmat', () => {
    // Double-sided zero-thickness sheet centred around (2.1, 3.1, 4) has zero enclosed volume.
    const flatVerts = [2, 3, 4, 2.3, 3, 4, 2, 3.3, 4];
    const { volume, centroid } = volumeCentroid(flatVerts, [0, 1, 2, 0, 2, 1]);
    expect(volume).toBe(0);
    expect(centroid[0]).toBeCloseTo(2.1, 6);
    expect(centroid[1]).toBeCloseTo(3.1, 6);
    expect(centroid[2]).toBeCloseTo(4, 6);

    // Slightly non-orthogonal xmat whose 1 + m[8] - m[0] - m[4] would go negative without clamping.
    const drifted = [-0.6, 0, 0, 0, -0.6, 0, 0, 0, -1.3];
    const q = matToQuat(drifted);
    expect(q.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...q)).toBeCloseTo(1, 6);

    const zeroQ = matToQuat([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(zeroQ.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...zeroQ)).toBeCloseTo(1, 6);

    // Off-origin zero-volume source does not teleport shards by -pos on break.
    const dummyCell = { verts: flatVerts, faces: [0, 1, 2], volume: 1e-5, centroid };
    const { shards } = buildShatterGraph(
      { id: 'shell', name: 'shell', type: 'body', pos: [0, 0, 1], joints: [], children: [], geoms: [] } as unknown as SceneNode,
      flatVerts, [0, 1, 2, 0, 2, 1], [dummyCell, dummyCell],
      { pos: [0, 0, 1], xmat: [1, 0, 0, 0, 1, 0, 0, 0, 1], vel: [0, 0, 0], angvel: [0, 0, 0] },
    );
    expect(shards[0].pos[0]).toBeCloseTo(0, 9);
    expect(shards[0].pos[1]).toBeCloseTo(0, 9);
    expect(shards[0].pos[2]).toBeCloseTo(1, 9);
  });

  it('fracture tolerates trailing non-multiple-of-3 vertex elements and out-of-bounds face indices', () => {
    const clean = [
      -0.1, -0.1, -0.1,  0.1, -0.1, -0.1,  0.1, 0.1, -0.1, -0.1, 0.1, -0.1,
      -0.1, -0.1,  0.1,  0.1, -0.1,  0.1,  0.1, 0.1,  0.1, -0.1, 0.1,  0.1,
    ];
    const ragged = [...clean, 999, 888]; // 26 numbers (2 trailing elements)
    const seeds = seedPoints(ragged, { pieces: 6, seed: 1 });
    expect(seeds).toHaveLength(6);
    expect(seeds.flat().every((v) => Number.isFinite(v) && Math.abs(v) <= 0.1 + 1e-9)).toBe(true);

    const cells = fractureMesh(ragged, [0, 1, 2, 99, 100, 101], { pieces: 4, seed: 2 });
    expect(cells.length).toBeGreaterThanOrEqual(2);
    expect(cells.every((c) => c.verts.every(Number.isFinite))).toBe(true);
    expect(voronoiCells([0, 0, 0, 1, 0, 0], [0, 1, 99], [[0, 0, 0], [1, 0, 0]])).toEqual([]);
  });

  it('fractureSolid cuts a paper-thin hollow box into hollow wall shards rather than solid hull bricks', () => {
    // 200 mm hollow box with 0.4 mm walls: solidity ~ 0.012, so random bbox seeds almost never land in the wall.
    const outer = wasm.Manifold.cube([0.2, 0.2, 0.2], true);
    const inner = wasm.Manifold.cube([0.1992, 0.1992, 0.1992], true);
    const shell = outer.subtract(inner);
    const trueVol = shell.volume();
    const m = shell.getMesh();
    const verts: number[] = [];
    for (let v = 0; v < m.numVert; v++) {
      verts.push(m.vertProperties[v * m.numProp], m.vertProperties[v * m.numProp + 1], m.vertProperties[v * m.numProp + 2]);
    }
    const faces = Array.from(m.triVerts);
    outer.delete(); inner.delete(); shell.delete();

    const shards = fractureSolid(wasm, verts, faces, { pieces: 6, seed: 7 });
    expect(shards.length).toBeGreaterThanOrEqual(2);
    const shardVol = shards.reduce((s, c) => s + c.volume, 0);
    // Shards weigh the thin wall (~0.000096 m³), NEVER the solid 0.2³ = 0.008 m³ hull!
    expect(shardVol).toBeCloseTo(trueVol, 5);
    expect(shardVol).toBeLessThan(0.008 * 0.05);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge Rounding & Dent Store
// ---------------------------------------------------------------------------

describe('edgeRound degenerate geometry & store session hygiene', () => {
  const baseEdge: RoundEdge = {
    kind: 'line',
    a: [-0.01, 0, 0], b: [0.01, 0, 0],
    n1: [0, 0, 1], n2: [0, 0, 1],
    t1: [0, 1, 0], t2: [0, -1, 0], // theta = PI (coplanar flat faces)
    convex: true,
  };

  it('produces finite cross-sections on 0° and 180° degenerate edges and non-negative rotate_extrude radii', () => {
    const flatPts = crossSection(baseEdge, 'fillet', 0.002, 6);
    expect(flatPts.flat().every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(setbackOf(baseEdge, 'fillet', 0.002))).toBe(true);

    const hairpin: RoundEdge = { ...baseEdge, t2: [0, 1, 0] }; // theta = 0
    const sharpPts = crossSection(hairpin, 'fillet', 0.002, 6);
    expect(sharpPts.flat().every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(setbackOf(hairpin, 'fillet', 0.002))).toBe(true);

    // Boss rim whose chamfer + overshoot would cross X < 0 without clamping.
    const rim: RoundEdge = {
      kind: 'circle', centre: [0, 0, 0.01], axis: [0, 0, 1], radius: 0.001, ref: [1, 0, 0], segments: 16,
      n1: [0, 0, 1], n2: [1, 0, 0], t1: [-1, 0, 0], t2: [0, 0, -1], convex: true,
    };
    const scad = edgeSolidScad(rim, 'chamfer', 0.0015, 16);
    const xs = [...scad.matchAll(/\[(-?[\d.e-]+),(-?[\d.e-]+)\]/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);

    // Non-finite sizes are rejected everywhere.
    expect(withRoundFeature([], { mode: 'fillet', size: Infinity, edges: [baseEdge] }, null)).toEqual([]);
    expect(withRoundFeature([], { mode: 'fillet', size: NaN, edges: [baseEdge] }, null)).toEqual([]);
    expect(edgeRoundSolids([{ mode: 'fillet', size: Infinity, edges: [baseEdge] }], 16)).toEqual({ cutters: [], fillers: [] });
    expect(hasEdgeRounds({ id: 'x', name: 'x', geoms: [], edgeRounds: [{ mode: 'fillet', size: Infinity, edges: [baseEdge] }] } as unknown as SceneNode)).toBe(false);
  });

  it('applyEdgeRound does not push a no-op undo entry and setEdgeRoundFeature rejects non-finite sizes', () => {
    const store = useStore.getState();
    store.addComponent('box', [0, 0, 0.1], null, { exact: true });
    const box = [...useStore.getState().sceneGraph.nodes].reverse().find((n: SceneNode) => n.geoms?.[0]?.type === 'box')!;
    useStore.getState().flushPendingUndo();
    const undoBefore = useStore.getState().undoStack.length;

    // Open and immediately Apply with nothing picked: zero undo entries added.
    useStore.getState().startEdgeRound(box.id);
    useStore.getState().updateEdgeRoundDraft({ size: NaN });
    expect(useStore.getState().edgeRoundSession.size).toBe(0);
    useStore.getState().applyEdgeRound();
    useStore.getState().flushPendingUndo();
    expect(useStore.getState().undoStack.length).toBe(undoBefore);

    // Add a real rounding, then ensure invalid setEdgeRoundFeature sizes are ignored.
    const validEdge: RoundEdge = {
      kind: 'line', a: [-0.05, -0.05, 0.05], b: [0.05, -0.05, 0.05],
      n1: [0, 0, 1], n2: [0, -1, 0], t1: [0, 1, 0], t2: [0, 0, -1], convex: true,
    };
    useStore.getState().roundEdges(box.id, { mode: 'chamfer', size: 0.002, edges: [validEdge] });
    useStore.getState().setEdgeRoundFeature(box.id, 0, { size: NaN });
    useStore.getState().setEdgeRoundFeature(box.id, 0, { size: -1 });
    useStore.getState().setEdgeRoundFeature(box.id, 0, { size: Infinity });
    const updated = useStore.getState().sceneGraph.nodes.find((n: SceneNode) => n.id === box.id)!;
    expect(updated.edgeRounds[0].size).toBe(0.002);
  });
});

describe('dentStore NaN guards and refused pierce integrity', () => {
  beforeEach(() => useDentStore.getState().clear());

  it('ignores non-finite or zero-normal blows and does not pull rim or increment holes on refused pierce', () => {
    const ball = icosphere(0.1, 2);
    const { renderVertices, faces } = toSceneGeom(ball);
    const key = dentKey('n', 'g');

    // Non-finite and zero-normal calls must be ignored cleanly.
    useDentStore.getState().dent(key, renderVertices, faces, [NaN, 0, 0], [0, 0, 1], 0.01, 0.05);
    useDentStore.getState().dent(key, renderVertices, faces, [0, 0, 0.1], [0, 0, 0], 0.01, 0.05);
    useDentStore.getState().pierce(key, renderVertices, faces, [0, 0, 0.1], [NaN, 0, 1], 0.05);
    useDentStore.getState().pierce(key, renderVertices, faces, [0, 0, 0.1], [0, 0, 0], 0.05);
    expect(useDentStore.getState().dents[key]).toBeUndefined();

    // Refused pierce (bore misses the mesh or swallows the entire mesh):
    // must NOT pull rim vertices and must record holes = 0.
    useDentStore.getState().pierce(key, renderVertices, faces, [0.22, 0, 0], [0, 0, 1], 0.1);
    const missed = useDentStore.getState().dents[key]!;
    expect(missed.holes).toBe(0);
    expect(missed.deepest).toBe(0);
    expect(Array.from(missed.mesh.positions.subarray(0, missed.mesh.vertexCount * 3))).toEqual(
      Array.from(Float32Array.from(renderVertices)),
    );

    useDentStore.getState().pierce(key, renderVertices, faces, [0, 0, 0], [0, 0, 1], 10);
    const whole = useDentStore.getState().dents[key]!;
    expect(whole.holes).toBe(0);
    expect(whole.mesh.faceCount).toBe(faces.length / 3);
  });
});

// ---------------------------------------------------------------------------
// 4. Sculpting, MCP Sculpt Commands & Undo Coalescing
// ---------------------------------------------------------------------------

describe('sculpt bases, stroke sanitization, MCP SET_SCULPT_BASE history & single-step undo', () => {
  it('resizeSculptMesh / resizeSculptMeshAxes survive NaN and refresh normals on non-uniform scale', () => {
    const m = icosphere(0.1, 2);
    resizeSculptMesh(m, NaN);
    expect(m.positions.subarray(0, m.vertexCount * 3).every(Number.isFinite)).toBe(true);

    // Flatten Z by 10x: vertex normals near 45° latitude must tilt strongly toward Z after recomputeNormals.
    resizeSculptMeshAxes(m, [0.2, 0.2, 0.02]);
    resizeSculptMeshAxes(m, [NaN as unknown as number, null, Infinity]);
    expect(m.positions.subarray(0, m.vertexCount * 3).every(Number.isFinite)).toBe(true);
    let midNz = 0, count = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[i * 3], y = m.positions[i * 3 + 1], z = m.positions[i * 3 + 2];
      if (Math.hypot(x, y) > 0.04 && z > 0.005) {
        midNz += m.normals[i * 3 + 2];
        count++;
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(midNz / count).toBeGreaterThan(0.85);
  });

  it('applySculptStroke, probeSurface & polygonPrismMap reject/sanitize NaN inputs without corrupting positions', () => {
    const m = icosphere(0.1, 2);
    const res = applySculptStroke(m, {
      brush: 'grab',
      at: [[NaN, 0, 0.1], [0, 0, 0.1]],
      radius: NaN,
      strength: Infinity,
      detail: NaN,
      depthMm: NaN,
      hardness: NaN,
      delta: [0.01, NaN, Infinity],
    });
    expect(res.applied).toBe(1);
    expect(res.missed).toHaveLength(1);
    expect(m.positions.subarray(0, m.vertexCount * 3).every(Number.isFinite)).toBe(true);

    const probed = probeSurface(m, [[NaN, 0, 0], [0, 0, 0.1]]);
    expect(probed[0].nearest).toBeNull();
    expect(probed[1].nearest).not.toBeNull();

    expect(polygonPrismMap(m, [[0, 0, 0], [NaN, 1, 0], [0, 1, 0]])).toBeNull();
    expect(polygonPrismMap(m, [[0, 0, 0], [1, 0, 0], [0, 1, 0]], [NaN, 0, 1])).toBeNull();
  });

  it('SET_SCULPT_BASE clears stale stroke history, prefers !csgDerived, and SCULPT coalesces into one undo entry', async () => {
    useStore.getState().addComponent('sculpt', [0, 0, 0.2], null, { exact: true });
    const node = [...useStore.getState().sceneGraph.nodes].reverse().find((n: SceneNode) => n.isSculpt)!;
    const id = node.id;
    sculptHistory.delete(id);
    useStore.getState().flushPendingUndo();
    const undoStart = useStore.getState().undoStack.length;

    // 1) Stroke on the 2562-vertex sphere base -> single store undo step!
    const sRes = await sculptCommands.SCULPT(
      { targetId: id, brush: 'draw', at: [[0, 0, 50]], radius: 30, strength: 0.8, dynamicTopology: false } as any,
      { store: useStore.getState() } as any,
    );
    expect(sRes.ok).toBe(true);
    expect(sRes.undoDepth).toBe(1);
    useStore.getState().flushPendingUndo();
    expect(useStore.getState().undoStack.length).toBe(undoStart + 1);

    // 2) Swap to the smaller cube base: must clear sculptHistory so UNDO_SCULPT cannot corrupt cube vertices!
    const baseRes = await sculptCommands.SET_SCULPT_BASE(
      { targetId: id, base: 'cube' } as any,
      { store: useStore.getState() } as any,
    );
    expect(baseRes.ok).toBe(true);
    expect(baseRes.undoDepth).toBe(0);
    expect(sculptHistory.get(id)).toBeUndefined();

    const undoRes = await sculptCommands.UNDO_SCULPT(
      { targetId: id } as any,
      { store: useStore.getState() } as any,
    );
    expect(undoRes.ok).toBe(false);

    // 3) sculptGeomIndex prefers !csgDerived even on isSculpt nodes.
    const idx = sculptGeomIndex({
      id: 's', name: 's', isSculpt: true, geoms: [
        { name: 'col', type: 'mesh', size: [1], csgDerived: 'collider' },
        { name: 'clay', type: 'mesh', size: [1], renderVertices: [0, 0, 0], faces: [0, 0, 0] },
      ],
    } as unknown as SceneNode);
    expect(idx).toBe(1);

    // 4) separateSculpt clears stale vertex paint on the first piece as well as sibling pieces.
    const painted = useStore.getState().sceneGraph.nodes.find((n: SceneNode) => n.id === id)!;
    painted.geoms[0].paint = [1, 0, 0, 1, 0, 0];
    const p1 = icosphere(0.03, 1);
    const p2 = icosphere(0.02, 1);
    const ids = useStore.getState().separateSculpt(id, [p1, p2]);
    expect(ids).toHaveLength(2);
    for (const pid of ids) {
      const pn = useStore.getState().sceneGraph.nodes.find((n: SceneNode) => n.id === pid)!;
      expect(pn.geoms[0].paint).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Lattice Bevel, Collider Cleanup & Atomic Separate Undo
// ---------------------------------------------------------------------------

describe('lattice bevelFace half-edge guard, collider cleanup & atomic separateLattice undo', () => {
  it('bevelFace refuses exact half-edge cuts (steps * 2 === edgeLength) without deleting the face', () => {
    const l = createLattice(DEFAULT_UNIT);
    // 20 mm x 20 mm square: edge length is 200 grid steps.
    const corners = [
      vertexAt(l, 0, 0, 0),
      vertexAt(l, 200, 0, 0),
      vertexAt(l, 200, 200, 0),
      vertexAt(l, 0, 200, 0),
    ];
    const f = addFace(l, corners);
    expect(faceCount(l)).toBe(1);
    expect(l.index.size).toBe(4);

    // Half-edge (100 steps = 10 mm) would collide at midpoints; must return false AND keep the face intact!
    expect(bevelFace(l, f, 100)).toBe(false);
    expect(bevelFace(l, f, NaN)).toBe(false);
    expect(faceCount(l)).toBe(1);
    expect(l.index.size).toBe(4);

    // Just under half-edge (99 steps) succeeds cleanly into an octagon.
    expect(bevelFace(l, f, 99)).toBe(true);
    expect(faceCount(l)).toBe(1);
    expect(l.index.size).toBe(8);
    expect(l.faces.find(Boolean)!.length).toBe(8);
  });

  it('applyLattice drops stale colliders and separateLattice records a single clean undo step', async () => {
    // Build a lattice body with two disjoint 10 mm cubes inside one cage.
    const l = createLattice(DEFAULT_UNIT);
    const box = (x0: number, x1: number) => [
      [[x0, 0, 0], [x0, 10, 0], [x1, 10, 0], [x1, 0, 0]],
      [[x0, 0, 10], [x1, 0, 10], [x1, 10, 10], [x0, 10, 10]],
      [[x0, 0, 0], [x1, 0, 0], [x1, 0, 10], [x0, 0, 10]],
      [[x0, 10, 0], [x0, 10, 10], [x1, 10, 10], [x1, 10, 0]],
      [[x0, 0, 0], [x0, 0, 10], [x0, 10, 10], [x0, 10, 0]],
      [[x1, 0, 0], [x1, 10, 0], [x1, 10, 10], [x1, 0, 10]],
    ];
    runLatticeOps(l, [{ op: 'faces', faces: [...box(0, 10), ...box(30, 40)] }], 0, 0, { fuse: false });
    const cage = serializeCage(l);
    const built = latticeToSceneGeom(l, 0, 0);

    const nodeId = 'lat_audit_two_parts';
    const node: SceneNode = {
      id: nodeId, name: nodeId, type: 'body', pos: [0, 0, 0.2],
      joints: [{ name: `${nodeId}_free`, type: 'free' }],
      isLattice: true, latticeCage: cage, latticeSubdiv: 0, latticeVersion: 1, latticeOrigin: built.origin,
      collisionDecomposed: true, tunedPitchHz: 440,
      geoms: [
        {
          name: `${nodeId}_mesh`, type: 'mesh', size: [1], dynamic: true, latticeGeom: true,
          vertices: built.vertices, renderVertices: built.renderVertices, faces: built.faces,
          paint: [1, 0, 0],
        },
        {
          name: `${nodeId}_col0`, type: 'mesh', size: [1], csgDerived: 'collider', role: 'collision',
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2],
        },
      ],
      children: [],
    };
    useStore.setState({ sceneGraph: { ...useStore.getState().sceneGraph, nodes: [node] } });
    useStore.getState().flushPendingUndo();

    // 1) applyLattice drops stale V-HACD collider geoms and stale tunedPitchHz.
    useStore.getState().applyLattice(nodeId, serializeCage(boxLattice(DEFAULT_UNIT, 50)), 0, true);
    const afterEdit = useStore.getState().sceneGraph.nodes.find((n: SceneNode) => n.id === nodeId)!;
    expect(afterEdit.geoms.some((gm: SceneGeom) => gm.csgDerived === 'collider')).toBe(false);
    expect(afterEdit.collisionDecomposed).toBeUndefined();
    expect(afterEdit.tunedPitchHz).toBeUndefined();

    // Restore two-piece cage, flush undo, then separateLattice: must be ONE undo step with non-empty meshes!
    useStore.getState().applyLattice(nodeId, cage, 0, true);
    useStore.getState().flushPendingUndo();
    const undoBeforeSeparate = useStore.getState().undoStack.length;

    useStore.getState().separateLattice(nodeId);
    useStore.getState().flushPendingUndo();
    const nodesAfterSep = useStore.getState().sceneGraph.nodes as SceneNode[];
    expect(nodesAfterSep).toHaveLength(2);
    expect(nodesAfterSep.every((n) => (n.geoms[0].vertices?.length ?? 0) > 0)).toBe(true);
    expect(useStore.getState().undoStack.length).toBe(undoBeforeSeparate + 1);

    // One undo restores the single two-piece body cleanly (never an empty-vertices intermediate state).
    useStore.getState().undo();
    const nodesAfterUndo = useStore.getState().sceneGraph.nodes as SceneNode[];
    expect(nodesAfterUndo).toHaveLength(1);
    expect(nodesAfterUndo[0].id).toBe(nodeId);
    expect(nodesAfterUndo[0].geoms[0].vertices!.length).toBe(built.vertices.length);

    // 3) LATTICE_SMOOTH & commitLattice coalesce undo and read latticeGeom triangle count.
    useStore.getState().flushPendingUndo();
    const undoBeforeCommit = useStore.getState().undoStack.length;
    commitLattice(nodesAfterUndo[0], boxLattice(DEFAULT_UNIT, 60));
    useStore.getState().flushPendingUndo();
    expect(useStore.getState().undoStack.length).toBe(undoBeforeCommit + 1);

    const smoothRes = await latticeCommands.LATTICE_SMOOTH(
      { targetId: nodeId, level: 1 } as any,
      { store: useStore.getState() } as any,
    );
    expect(smoothRes.ok).toBe(true);
    expect(smoothRes.meshTriangles).toBeGreaterThan(12);
  });
});
