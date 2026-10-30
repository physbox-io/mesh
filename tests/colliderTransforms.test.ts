// A mesh's collider source (colliderVertices: a Split for Print section's plain
// copy, a dense import's simplified one) has to go where the drawn mesh goes.
// A rescaled section used to keep colliding at its old size; a rescaled dense
// part was rebuilt from scratch for a transform that is plain linear algebra.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { splitForPrint, type SplitResult } from '../src/utils/printSplit';
import { useStore } from '../src/store/useStore';
import { scaleNodeTree } from '../src/utils/scaleNode';
import { scaleMeshGeoms } from '../src/store/meshGeomTransforms';
import { compileToMJCF } from '../src/utils/mjcf';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { colliderCopyOf, meshFingerprint } from '../src/utils/denseMesh';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); }, 30_000);

/** An axis-aligned box as a triangle soup, metres, wound outward. Sizes in mm. */
function box(sx: number, sy: number, sz: number): Float64Array {
  const [x1, y1, z1] = [sx / 1000, sy / 1000, sz / 1000];
  const c = [[0, 0, 0], [x1, 0, 0], [x1, y1, 0], [0, y1, 0], [0, 0, z1], [x1, 0, z1], [x1, y1, z1], [0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return Float64Array.from(out);
}

function bounds(v: number[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[i + k]); max[k] = Math.max(max[k], v[i + k]); }
  }
  return { min, max };
}

const expectSameBounds = (a: number[], b: number[], digits = 6) => {
  const p = bounds(a), q = bounds(b);
  for (let k = 0; k < 3; k++) {
    expect(p.min[k]).toBeCloseTo(q.min[k], digits);
    expect(p.max[k]).toBeCloseTo(q.max[k], digits);
  }
};

describe('a Split for Print section rescaled', () => {
  let ids: string[];
  const section = (id: string) => useStore.getState().sceneGraph.nodes.find((n) => n.id === id)!;
  const mesh = (id: string) => section(id).geoms.find((g) => g.colliderVertices)!;

  beforeEach(() => {
    // The store schedules a recompile on window; there is none under Vitest.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const r = splitForPrint(wasm, [box(300, 100, 100)], {
      bed: { widthMm: 200, depthMm: 200, heightMm: 200 },
      joinery: { kind: 'dowel', diameterMm: 8, lengthMm: 30, clearanceMm: 0.2 },
    }) as SplitResult & { ok: true };
    expect(r.ok).toBe(true);
    const part: SceneNode = {
      id: 'part', name: 'part', pos: [0, 0, 0.1], joints: [{ name: 'part_free', type: 'free' }], children: [],
      geoms: [{ name: 'part_mesh', type: 'mesh', size: [1], dynamic: true, renderVertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], faces: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] } as SceneGeom],
    };
    useStore.setState({ sceneGraph: { nodes: [part] } as SceneGraph, model: null, data: null });
    ids = useStore.getState().splitBodyForPrint('part', r.sections);
    expect(ids.length).toBe(2);
  });

  it('scales the collider with the drawn mesh, and the bores with both', () => {
    const id = ids[0];
    const before = mesh(id);
    const plainVolume = analyzeMesh(before.colliderVertices!, before.colliderFaces!)!.volume;
    const sockets = (n: SceneNode) => n.geoms.filter((g) => g.contactClass === 'socket').map((g) => g.pos ?? [0, 0, 0]);
    const socketsBefore = sockets(section(id));
    expect(socketsBefore.length).toBeGreaterThan(0);
    const unit = (p: number[], b: ReturnType<typeof bounds>) => p.map((c, k) => (c - b.min[k]) / (b.max[k] - b.min[k]));
    const where = socketsBefore.map((p) => unit(p, bounds(before.colliderVertices!)));

    scaleNodeTree(id, 2, 1, 1.5);

    const after = mesh(id);
    // The drilled mesh and its plain copy share their outline, before and after.
    expectSameBounds(after.colliderVertices!, after.renderVertices!);
    const b = bounds(after.colliderVertices!);
    expect(b.max[0] - b.min[0]).toBeCloseTo(2 * (bounds(before.colliderVertices!).max[0] - bounds(before.colliderVertices!).min[0]), 6);
    // Still the plain section, closed and wound outward, three times the volume.
    const plain = analyzeMesh(after.colliderVertices!, after.colliderFaces!)!;
    expect(plain.closed && plain.consistentlyWound).toBe(true);
    expect(plain.volume / plainVolume).toBeCloseTo(3, 6);
    expect(after.colliderVertices!.length).toBe(before.colliderVertices!.length);
    // The bores sit where they did on the collider, so pins still meet holes.
    sockets(section(id)).forEach((p, i) => {
      unit(p, b).forEach((c, k) => expect(c).toBeCloseTo(where[i][k], 6));
    });

    // The holes are still not the hull's to fill: the drilled mesh draws, the
    // plain copy collides, and the bores collide as their own sockets.
    const xml = compileToMJCF({ ...useStore.getState().sceneGraph, simFidelity: 'print' } as SceneGraph);
    const name = after.name;
    expect(xml).toMatch(new RegExp(`name="${name}"[^>]*contype="0" conaffinity="0"`));
    expect(xml).toMatch(new RegExp(`<geom name="${name}_collider"`));
    expect(xml).not.toMatch(new RegExp(`<geom name="${name}_collider"[^>]*contype="0"`));
  });

  it('keeps the collider wound outward through a mirror', () => {
    const g = structuredClone(mesh(ids[0]));
    scaleMeshGeoms({ geoms: [g] }, -1, 1, 1);
    const plain = analyzeMesh(g.colliderVertices!, g.colliderFaces!)!;
    expect(plain.consistentlyWound).toBe(true);
    expect(plain.volume).toBeGreaterThan(0);
  });
});

describe('a dense part rescaled', () => {
  it('carries its copy through the scale and re-marks it, with no rebuild', async () => {
    // A closed torus of 216,000 triangles, Z-up.
    const nu = 400, nv = 270, R = 0.05, r = 0.02;
    const vertices: number[] = [];
    const faces: number[] = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const u = (i / nu) * 2 * Math.PI, w = (j / nv) * 2 * Math.PI;
        vertices.push((R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r * Math.sin(w));
      }
    }
    const id = (i: number, j: number) => (i % nu) * nv + (j % nv);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) faces.push(id(i, j), id(i + 1, j + 1), id(i + 1, j), id(i, j), id(i, j + 1), id(i + 1, j + 1));
    }
    const copy = (await colliderCopyOf(vertices, faces))!;
    const g = {
      name: 'ring_geom', type: 'mesh', size: [1], dynamic: true, renderVertices: vertices, faces,
      colliderVertices: copy.colliderVertices, colliderFaces: copy.colliderFaces, denseColliderOf: copy.source,
    } as SceneGeom;
    const copied = g.colliderVertices;
    scaleMeshGeoms({ geoms: [g] }, 2, 1, 1);
    // Within a millimetre: the copy is a simplification of the surface.
    expectSameBounds(g.colliderVertices!, g.renderVertices!, 3);
    expect(g.colliderVertices).not.toBe(copied);
    expect(g.colliderFaces!.length).toBe(copy.colliderFaces.length);
    // Marked as made from the scaled mesh, so the store has nothing to rebuild.
    expect(g.denseColliderOf).toBe(meshFingerprint(g.renderVertices!, faces));

    // Turned in the store, which bakes the turn into the vertices: the copy
    // turns with it, twice over from the same base, and is not rebuilt.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const ring: SceneNode = { id: 'ring', name: 'ring', pos: [0, 0, 0.2], joints: [{ name: 'ring_free', type: 'free' }], children: [], geoms: [g] };
    useStore.setState({ sceneGraph: { nodes: [ring] } as SceneGraph, model: null, data: null });
    const turned = () => useStore.getState().sceneGraph.nodes[0].geoms[0];
    useStore.getState().updateNodeRotation('ring', 0, 45, true);
    useStore.getState().updateNodeRotation('ring', 0, 90, true);
    const t = turned();
    expect(t.colliderFaces).toBe(g.colliderFaces);
    expectSameBounds(t.colliderVertices!, t.renderVertices!, 3);
    // 90 about X stands the 0.28 x 0.14 x 0.04 ring on edge: 0.04 in Y, 0.14 in Z.
    const tb = bounds(t.colliderVertices!);
    expect(tb.max[0] - tb.min[0]).toBeCloseTo(0.28, 3);
    expect(tb.max[1] - tb.min[1]).toBeCloseTo(0.04, 3);
    expect(tb.max[2] - tb.min[2]).toBeCloseTo(0.14, 3);
    expect(t.denseColliderOf).toBe(meshFingerprint(t.renderVertices!, faces));
  });
});
