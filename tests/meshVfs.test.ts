// Meshes handed to MuJoCo as VFS files rather than inline text.
//
// The file route exists only to make rebuilds cheap, so the one thing it must
// never do is build a different model. These compile the same scene both ways
// and compare what MuJoCo made of it, then pin down the ledger's rule for
// which meshes are worth a file: only one that has come through a build
// unchanged, because putting a file into the VFS costs more than parsing it.

import { describe, it, expect, afterAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { MeshFileLedger, encodeMsh, mshFileName } from '../src/utils/meshVfs';
import { shatterPreset } from '../src/presets/shatter';
import type { SceneGraph, SceneGeom, SceneNode } from '../src/types/scene';

const compile = (scene: SceneGraph, opts: Parameters<typeof compileToMJCF>[7] = {}) =>
  compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0, opts);

const meshNames = (xml: string) => [...xml.matchAll(/<mesh name="([^"]+)"/g)].map((m) => m[1]);
const fileMeshes = (xml: string) => [...xml.matchAll(/<mesh name="([^"]+)"[^>]*file="/g)].map((m) => m[1]);

describe('compileToMJCF without a sink', () => {
  it('writes every mesh inline, with no file, hull cap or sleep flag', () => {
    const xml = compile(shatterPreset);
    expect(meshNames(xml).length).toBeGreaterThan(0);
    expect(fileMeshes(xml)).toEqual([]);
    expect(xml).not.toContain('maxhullvert');
    expect(xml).not.toContain('sleep');
  });

  it('adds the sleep flag only when asked', () => {
    expect(compile(shatterPreset, { sleep: true })).toContain('<flag sleep="enable" /></option>');
  });
});

describe('the same scene as files', () => {
  let mj: Awaited<ReturnType<typeof load_mujoco>>;
  const held: { delete(): void }[] = [];
  afterAll(() => { for (const h of held.reverse()) h.delete(); });

  it('builds a model MuJoCo cannot tell from the inline one', async () => {
    mj = await load_mujoco();
    const ledger = new MeshFileLedger();
    // Twice: a mesh only earns a file on the second build that contains it.
    compile(shatterPreset, { meshFiles: ledger });
    const first = ledger.take();
    expect(first.add).toEqual([]);
    const xml = compile(shatterPreset, { meshFiles: ledger });
    const { add } = ledger.take();
    expect(fileMeshes(xml)).toEqual(meshNames(xml));
    // One file per distinct mesh: the preset's two weights share a shape, and
    // so share a file.
    const files = new Set([...xml.matchAll(/file="([^"]+)"/g)].map((m) => m[1]));
    expect(add.map((f) => f.name).sort()).toEqual([...files].sort());

    const vfs = new mj.MjVFS();
    held.push(vfs);
    for (const f of add) vfs.addBuffer(f.name, f.bytes);
    const asFiles = mj.MjModel.from_xml_string(xml, vfs);
    const inline = mj.MjModel.from_xml_string(compile(shatterPreset));
    held.push(inline, asFiles);

    expect(asFiles.nmesh).toBe(inline.nmesh);
    expect(asFiles.nmeshvert).toBe(inline.nmeshvert);
    expect(asFiles.nmeshface).toBe(inline.nmeshface);
    for (let b = 0; b < inline.nbody; b++) {
      // float32 in the file against full doubles in the text: the same body
      // to well under a part in a million.
      expect(asFiles.body_mass[b]).toBeCloseTo(inline.body_mass[b], 6);
      for (let k = 0; k < 3; k++) {
        expect(asFiles.body_inertia[b * 3 + k]).toBeCloseTo(inline.body_inertia[b * 3 + k], 8);
      }
    }
  }, 60_000);
});

describe('file names', () => {
  const tri = () => ({ v: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], f: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] });

  it('names the same mesh the same way every time', () => {
    const { v, f } = tri();
    expect(mshFileName(encodeMsh(v, f))).toBe(mshFileName(encodeMsh([...v], [...f])));
  });

  it('gives a mesh a new name when any vertex moves', () => {
    const { v, f } = tri();
    const moved = [...v];
    moved[4] += 1e-4;
    expect(mshFileName(encodeMsh(moved, f))).not.toBe(mshFileName(encodeMsh(v, f)));
  });
});

describe('which meshes become files', () => {
  const body = (id: string, verts: number[], stable = false): SceneNode => ({
    id, name: id, type: 'body', pos: [0, 0, 0.5], children: [],
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [{
      name: `${id}_geom`, type: 'mesh', size: [1], dynamic: true,
      vertices: verts, faces: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3], stableMesh: stable || undefined,
    } as SceneGeom],
  });
  const tet = (s: number) => [0, 0, 0, s, 0, 0, 0, s, 0, 0, 0, s];
  const build = (ledger: MeshFileLedger, nodes: SceneNode[]) => {
    const xml = compile({ nodes }, { meshFiles: ledger });
    return { xml, ...ledger.take() };
  };

  it('inlines a mesh on its first build and files it on the next', () => {
    const ledger = new MeshFileLedger();
    const a = build(ledger, [body('a', tet(0.1))]);
    expect(fileMeshes(a.xml)).toEqual([]);
    const b = build(ledger, [body('a', tet(0.1))]);
    expect(fileMeshes(b.xml)).toEqual(['a_geom']);
    expect(b.add.length).toBe(1);
    // Once the worker has it, it is never sent again.
    const c = build(ledger, [body('a', tet(0.1))]);
    expect(fileMeshes(c.xml)).toEqual(['a_geom']);
    expect(c.add).toEqual([]);
  });

  it('keeps a mesh that changes every build inline, where it is cheapest', () => {
    const ledger = new MeshFileLedger();
    for (let i = 1; i <= 4; i++) {
      const r = build(ledger, [body('sculpt', tet(0.1 + i * 0.01))]);
      expect(fileMeshes(r.xml)).toEqual([]);
      expect(r.add).toEqual([]);
    }
  });

  it('files a mesh marked stable on its very first build', () => {
    const ledger = new MeshFileLedger();
    const r = build(ledger, [body('shard', tet(0.05), true)]);
    expect(fileMeshes(r.xml)).toEqual(['shard_geom']);
    expect(r.add.length).toBe(1);
  });

  it('drops files the scene no longer uses only once the worker is over budget', () => {
    const ledger = new MeshFileLedger(1); // every file is over a one-byte budget
    build(ledger, [body('a', tet(0.1), true)]);
    const r = build(ledger, [body('b', tet(0.2), true)]);
    expect(r.drop.length).toBe(1);
    // ...and a dropped file is sent again if it comes back.
    const back = build(ledger, [body('a', tet(0.1), true)]);
    expect(back.add.length).toBe(1);
  });

  it('names and sends a mesh the same way when its arrays are reused across builds', () => {
    // The store hands the compiler the same arrays until a mesh really changes,
    // and the compiler keeps per-mesh work against them (see utils/arrayMemo).
    // A remembered mesh must still produce exactly the XML and files a fresh
    // copy of it would.
    const shared = body('a', tet(0.1));
    const ledger = new MeshFileLedger();
    const first = build(ledger, [shared]);
    const second = build(ledger, [shared]);
    expect(fileMeshes(second.xml)).toEqual(['a_geom']);
    expect(second.add.length).toBe(1);
    expect(second.add[0].bytes.byteLength).toBeGreaterThan(16);
    expect(second.add[0].name).toBe(mshFileName(encodeMsh(
      // Three.js Y-up to MuJoCo Z-up, as the compiler writes it.
      tet(0.1).flatMap((_, i, v) => (i % 3 === 0 ? [v[i], -v[i + 2], v[i + 1]] : [])),
      shared.geoms[0].faces!,
    )));

    const fresh = new MeshFileLedger();
    build(fresh, [body('a', tet(0.1))]);
    expect(build(fresh, [body('a', tet(0.1))]).xml).toBe(second.xml);
    expect(first.xml).toBe(compile({ nodes: [body('a', tet(0.1))] }, { meshFiles: new MeshFileLedger() }));
  });

  it('gives a mesh a new file when it gets new arrays', () => {
    const ledger = new MeshFileLedger();
    const a = body('a', tet(0.1), true);
    const one = build(ledger, [a]);
    a.geoms[0] = { ...a.geoms[0], vertices: tet(0.2) };
    const two = build(ledger, [a]);
    expect(two.add.length).toBe(1);
    expect(two.add[0].name).not.toBe(one.add[0].name);
  });

  it('forgets a compile that never reached the worker', () => {
    const ledger = new MeshFileLedger();
    compile({ nodes: [body('a', tet(0.1), true)] }, { meshFiles: ledger });
    // A compile that threw, or was superseded, before its build: the next
    // compile starts clean rather than sending the abandoned one's files.
    const r = build(ledger, [body('b', tet(0.2), true)]);
    const named = [...r.xml.matchAll(/file="([^"]+)"/g)].map((m) => m[1]);
    expect(r.add.map((f) => f.name)).toEqual(named);
  });
});
