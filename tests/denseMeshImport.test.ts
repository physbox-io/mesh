// A 1.4M-triangle STL imported, replied ok, and then ran the physics engine out
// of memory: one model of it took the wasm heap to 1.85 GB of 2, so the first
// rebuild or headless run (each holds a second model) aborted. A dense part now
// collides as a simplified copy and keeps every triangle for drawing; see
// utils/denseMesh.ts.
import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import {
  COLLIDER_TRIANGLE_BUDGET, DENSE_MESH_TRIANGLES, colliderCopyOf, headlessMeshBudgetError,
} from '../src/utils/denseMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { parseSTL } from '../src/utils/stlParser';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph } from '../src/types/scene';

/** A closed torus, Z-up, wound outward, of 2·nu·nv triangles. */
function torus(nu: number, nv: number, R = 0.05, r = 0.02) {
  const vertices: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = (i / nu) * 2 * Math.PI;
      const w = (j / nv) * 2 * Math.PI;
      vertices.push((R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r * Math.sin(w));
    }
  }
  const id = (i: number, j: number) => (i % nu) * nv + (j % nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      faces.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  }
  if (analyzeMesh(vertices, faces)!.volume < 0) {
    for (let k = 0; k < faces.length; k += 3) [faces[k + 1], faces[k + 2]] = [faces[k + 2], faces[k + 1]];
  }
  return { vertices, faces };
}

/** The torus as a binary STL, in millimetres as CAD writes it. */
function binaryStl({ vertices, faces }: { vertices: number[]; faces: number[] }): ArrayBuffer {
  const n = faces.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const o = 84 + 50 * t + 12;
    for (let c = 0; c < 3; c++) {
      const v = faces[t * 3 + c];
      for (let k = 0; k < 3; k++) dv.setFloat32(o + c * 12 + k * 4, vertices[v * 3 + k] * 1000, true);
    }
  }
  return buf;
}

const toYUp = (v: number[]) => v.flatMap((_, i) => (i % 3 ? [] : [v[i], v[i + 2], -v[i + 1]]));

describe('dense mesh import', () => {
  // 216,000 triangles: over the threshold, small enough to keep the test quick.
  const dense = torus(400, 270);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mj: any;
  beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

  it('leaves a mesh under the threshold to collide as itself', async () => {
    const small = torus(100, 50);
    expect(small.faces.length / 3).toBeLessThan(DENSE_MESH_TRIANGLES);
    expect(await colliderCopyOf(small.vertices, small.faces)).toBeNull();
  });

  it('simplifies a dense mesh to the budget, still closed, wound outward and the same size', async () => {
    expect(dense.faces.length / 3).toBeGreaterThan(DENSE_MESH_TRIANGLES);
    const copy = (await colliderCopyOf(dense.vertices, dense.faces))!;
    expect(copy.triangles).toBe(dense.faces.length / 3);
    expect(copy.colliderTriangles).toBeLessThanOrEqual(COLLIDER_TRIANGLE_BUDGET);
    expect(copy.colliderTriangles).toBeGreaterThan(COLLIDER_TRIANGLE_BUDGET * 0.8);
    const before = analyzeMesh(dense.vertices, dense.faces)!;
    const after = analyzeMesh(copy.colliderVertices, copy.colliderFaces)!;
    expect(after.closed).toBe(true);
    expect(after.consistentlyWound).toBe(true);
    expect(after.volume / before.volume).toBeGreaterThan(0.98);
    expect(after.volume / before.volume).toBeLessThan(1.02);
  });

  it('parses a dense STL with no OpenSCAD polyhedron to run out of memory compiling', () => {
    const parsed = parseSTL(binaryStl(dense), { name: 'ring' });
    expect(parsed.dense).toBe(true);
    expect(parsed.triangleCount).toBe(dense.faces.length / 3);
    expect(parsed.scadRaw).toBe('');
    expect(parsed.scadParametric).toBe('');
    // A torus is no primitive, so its CSG would be a polyhedron as well.
    expect(parsed.scadCsg).toBe('');
    expect(parsed.faces.length).toBe(dense.faces.length);
  });

  it('builds a dense dynamic part from its collision copy alone, and the engine takes it', async () => {
    const copy = (await colliderCopyOf(dense.vertices, dense.faces))!;
    const scene: SceneGraph = {
      nodes: [{
        id: 'ring', name: 'ring', pos: [0, 0, 0.2], joints: [{ name: 'ring_free', type: 'free' }], children: [],
        geoms: [{
          name: 'ring_geom', type: 'mesh', size: [1], dynamic: true,
          renderVertices: dense.vertices, vertices: toYUp(dense.vertices), faces: dense.faces,
          colliderVertices: copy.colliderVertices, colliderFaces: copy.colliderFaces,
          denseColliderOf: copy.source,
        }],
      }],
    };
    const stats = { meshTriangles: 0 };
    const xml = compileToMJCF(scene, -9.81, 0.5, 0, 0, 0, 0, { stats });
    expect(stats.meshTriangles).toBe(copy.colliderTriangles);
    expect(xml).not.toMatch(/name="ring_geom"/);
    expect(headlessMeshBudgetError(stats.meshTriangles)).toBeNull();
    // Without the mark (a Split for Print section has a collider source too)
    // the drawn mesh stays in the model as it always did.
    const unmarked = { nodes: [{ ...scene.nodes[0], geoms: [{ ...scene.nodes[0].geoms[0], denseColliderOf: undefined }] }] };
    expect(compileToMJCF(unmarked, -9.81, 0.5, 0, 0, 0, 0)).toMatch(/name="ring_geom"[^>]*contype="0" conaffinity="0"/);
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    try {
      expect(m.nmeshface).toBe(copy.colliderTriangles);
      for (let k = 0; k < 50; k++) mj.mj_step(m, d);
      expect(Number.isFinite(d.qpos[2])).toBe(true);
    } finally {
      d.delete();
      m.delete();
    }
  }, 60_000);

  it('refuses a headless run whose model cannot sit beside the live one, and says why', () => {
    expect(headlessMeshBudgetError(COLLIDER_TRIANGLE_BUDGET)).toBeNull();
    const error = headlessMeshBudgetError(1_400_000);
    expect(error).toMatch(/1,400,000 mesh triangles/);
    expect(error).toMatch(/second copy/);
  });
});
