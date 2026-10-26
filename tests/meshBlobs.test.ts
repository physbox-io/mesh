import { describe, it, expect, vi, beforeEach } from 'vitest';

const asked: { sha256: string; size: number }[][] = [];
vi.mock('../src/utils/apiClient', () => ({
  requestBlobUploads: async (blobs: { sha256: string; size: number }[]) => {
    asked.push(blobs);
    return { present: [], uploads: blobs.map((b) => ({ sha256: b.sha256, url: `https://bucket/${b.sha256}`, headers: {} })) };
  },
}));

import { externalizeMeshes, resolveMeshBlobs, externalizableChars, forgetUploadedBlobs } from '../src/utils/meshBlobs';
import { packMeshArrays, unpackMeshArrays } from '../src/utils/meshPacking';

/** The bucket, behind fetch. */
const bucket = new Map<string, Uint8Array>();
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (init?.method === 'PUT') {
    bucket.set(url, new Uint8Array(init.body as ArrayBuffer));
    return new Response(null, { status: 200 });
  }
  const got = bucket.get(url);
  return got ? new Response(got as unknown as BodyInit) : new Response(null, { status: 404 });
});

function scene(count: number) {
  const vertices = Array.from({ length: count * 3 }, (_, i) => Math.sin(i) * 0.05);
  const faces = Array.from({ length: count * 6 }, (_, i) => (i * 7919) % count);
  return { name: 'Candle', nodes: [{ id: 'm', geoms: [{ type: 'mesh', vertices, faces }, { type: 'box', size: [1, 1, 1] }] }] };
}

describe('meshBlobs', () => {
  beforeEach(() => {
    asked.length = 0;
    bucket.clear();
    forgetUploadedBlobs();
  });

  it('moves big meshes out by hash and puts them back exactly', async () => {
    const s = scene(70_000);
    const packed = packMeshArrays(s);
    const sent = await externalizeMeshes(packed);
    const text = JSON.stringify(sent);
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain('"$blob"');
    expect(bucket.size).toBe(2);
    const g = packed.nodes[0].geoms[0] as unknown as { vertices: { b64: string }; faces: { b64: string } };
    expect(externalizableChars(packed)).toBe(g.vertices.b64.length + g.faces.b64.length);

    const urls = Object.fromEntries([...bucket.keys()].map((u) => [u.split('/').pop()!, u]));
    const back = unpackMeshArrays(await resolveMeshBlobs(JSON.parse(text), urls));
    expect(back.nodes[0].geoms[0].faces).toEqual(s.nodes[0].geoms[0].faces);
    expect(back.nodes[0].geoms[0].vertices).toEqual(s.nodes[0].geoms[0].vertices.map(Math.fround));
    expect(back.nodes[0].geoms[1]).toEqual(s.nodes[0].geoms[1]);
  });

  it('does not ask about a mesh it has already uploaded', async () => {
    const packed = packMeshArrays(scene(70_000));
    await externalizeMeshes(packed);
    await externalizeMeshes(packed);
    expect(asked).toHaveLength(1);
  });

  it('leaves a small scene alone and makes no request', async () => {
    const packed = packMeshArrays(scene(200));
    expect(await externalizeMeshes(packed)).toBe(packed);
    expect(asked).toHaveLength(0);
  });

  it('says so in words when a mesh cannot be fetched', async () => {
    const sent = await externalizeMeshes(packMeshArrays(scene(70_000)));
    const resolved = await resolveMeshBlobs(JSON.parse(JSON.stringify(sent)), {});
    expect(() => unpackMeshArrays(resolved)).toThrow(/kept in your account and could not be fetched/);
  });

  it('refuses bytes that do not hash to their name', async () => {
    const sent = await externalizeMeshes(packMeshArrays(scene(70_000)));
    const urls = Object.fromEntries([...bucket.keys()].map((u) => [u.split('/').pop()!, u]));
    for (const k of bucket.keys()) bucket.set(k, new Uint8Array([1, 2, 3]));
    const resolved = await resolveMeshBlobs(JSON.parse(JSON.stringify(sent)), urls);
    expect(() => unpackMeshArrays(resolved)).toThrow(/could not be fetched/);
  });
});
