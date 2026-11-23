import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decodeShareFragment,
  gzip,
  toBase64Url,
  MAX_DECOMPRESSED_SHARE_BYTES,
} from '../src/utils/shareLink';
import { packMeshArrays, unpackMeshArrays, MAX_PACKED_ELEMENTS } from '../src/utils/meshPacking';
import { PhysBoxApiError } from '../src/utils/apiClient';
import { shouldClearShareTokenOnError } from '../src/hooks/useShareScene';
import { validateSceneNodes } from '../src/hooks/useSceneIo';
import { previewStockForThumb } from '../src/components/files/PatternThumb';
import { SURFACE_PATTERNS, buildPatternPlank } from '../src/utils/surfacePatterns';

class FakeStorage {
  map = new Map<string, string>();
  limit = Infinity;
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  setItem(k: string, v: string) {
    const others = [...this.map.entries()]
      .filter(([key]) => key !== k)
      .reduce((n, [key, val]) => n + key.length + val.length, 0);
    if (others + k.length + v.length > this.limit) {
      const err = new Error('quota') as Error & { name: string; code: number };
      err.name = 'QuotaExceededError';
      err.code = 22;
      throw err;
    }
    this.map.set(k, v);
  }
}

describe('#20: meshPacking & shareLink & importSceneJson validation', () => {
  it('rejects negative, non-integer, and oversized packed lengths without allocating', () => {
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f32', n: -1, b64: '' } })).toThrow(/Invalid packed mesh length/);
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f32', n: 1.5, b64: '' } })).toThrow(/Invalid packed mesh length/);
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f32', n: MAX_PACKED_ELEMENTS + 1, b64: '' } })).toThrow(/Invalid packed mesh length/);
  });

  it('rejects f32 payloads with mismatched byte lengths or NaN/Infinity values', () => {
    // 2 floats expected (8 bytes) but only 4 bytes supplied
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f32', n: 2, b64: btoa('\0\0\0\0') } })).toThrow(/Corrupt packed float array/);

    // Encode NaN and Infinity as little-endian float32
    const nanBuf = new ArrayBuffer(4);
    new DataView(nanBuf).setFloat32(0, Number.NaN, true);
    const nanB64 = btoa(String.fromCharCode(...new Uint8Array(nanBuf)));
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f32', n: 1, b64: nanB64 } })).toThrow(/non-finite/);

    const infBuf = new ArrayBuffer(4);
    new DataView(infBuf).setFloat32(0, Number.POSITIVE_INFINITY, true);
    const infB64 = btoa(String.fromCharCode(...new Uint8Array(infBuf)));
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f32', n: 1, b64: infB64 } })).toThrow(/non-finite/);
  });

  it('rejects truncated or overlong idx varint buffers instead of looping past EOF', () => {
    // Single continuation byte 0x80 with no terminator
    const truncated = btoa(String.fromCharCode(0x80));
    expect(() => unpackMeshArrays({ faces: { $packed: 'idx', n: 1, b64: truncated } })).toThrow(/unexpected end of data/);

    // 7 continuation bytes -> exceeds varint max length
    const tooLong = btoa(String.fromCharCode(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01));
    expect(() => unpackMeshArrays({ faces: { $packed: 'idx', n: 1, b64: tooLong } })).toThrow(/varint exceeds maximum length/);
  });

  it('blocks gzip bombs exceeding MAX_DECOMPRESSED_SHARE_BYTES in decodeShareFragment', async () => {
    // 33 MiB of spaces compresses to ~34 KB of gzip but exceeds the 32 MiB decompressed cap
    const bombText = ' '.repeat(MAX_DECOMPRESSED_SHARE_BYTES + 1024 * 1024);
    const gz = await gzip(bombText);
    expect(gz).not.toBeNull();
    const frag = new URLSearchParams({ v: '1', gz: '1', scene: toBase64Url(gz!) }).toString();
    await expect(decodeShareFragment(frag)).rejects.toThrow(/damaged/);
  });

  it('validates scene.name type and node objects in decodeShareFragment', async () => {
    const rawFrag = (obj: unknown) =>
      new URLSearchParams({
        v: '1',
        gz: '0',
        scene: toBase64Url(new TextEncoder().encode(JSON.stringify(obj))),
      }).toString();

    const fragBadName = rawFrag({ name: { bad: true }, nodes: [{ name: 'a', geoms: [] }] });
    await expect(decodeShareFragment(fragBadName)).rejects.toThrow(/damaged/);

    const fragNullNode = rawFrag({ name: 'ok', nodes: [null] });
    await expect(decodeShareFragment(fragNullNode)).rejects.toThrow(/damaged/);

    const fragNoName = rawFrag({ nodes: [{ name: 'a', geoms: [] }] });
    const decoded = await decodeShareFragment(fragNoName);
    expect(decoded?.name).toBe('Shared scene');
  });

  it('validates scene nodes recursively in validateSceneNodes', () => {
    expect(validateSceneNodes(null)).toMatch(/no "nodes" array/);
    expect(validateSceneNodes([null])).toMatch(/not an object/);
    expect(validateSceneNodes([{ id: '', geoms: [], children: [] }])).toMatch(/missing a valid "id"/);
    expect(validateSceneNodes([{ id: 'n1', geoms: [null], children: [] }])).toMatch(/invalid "geoms"/);
    expect(validateSceneNodes([{ id: 'n1', geoms: [], children: 'bad' }])).toMatch(/invalid "children"/);
    expect(validateSceneNodes([{ id: 'n1', geoms: [], children: [null] }])).toMatch(/not an object/);
    expect(
      validateSceneNodes([
        {
          id: 'root',
          name: 'root',
          pos: [0, 0, 0],
          geoms: [{ name: 'g', type: 'box', size: [1, 1, 1] }],
          joints: [],
          children: [{ id: 'child', name: 'child', pos: [0, 0, 0], geoms: [], joints: [], children: [] }],
        },
      ]),
    ).toBeNull();
  });
});

describe('#6, #19, #47: PresetSync deferred delete tombstone, fetch races, keepBoth cloudOnly, and blobsMissing', () => {
  const storage = new FakeStorage();

  beforeEach(() => {
    storage.clear();
    storage.limit = Infinity;
    vi.resetModules();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../src/utils/apiClient');
    vi.doUnmock('../src/utils/meshBlobs');
  });

  it('#6: clears deleted tombstone in deferFetch and fetchLatest so newer cloud rev is never deleted', async () => {
    let remoteRow = { id: 'p1', name: 'tray', revision: 1, savedAt: 1000, deleted: false, data: { savedAt: 1000, body: 'v1' } };
    const deletedIds: string[] = [];

    vi.doMock('../src/utils/apiClient', () => ({
      getStoredUser: () => ({ id: 'u1' }),
      fetchCloudPresetList: async () => [{ id: remoteRow.id, name: remoteRow.name, revision: remoteRow.revision, savedAt: remoteRow.savedAt, deleted: remoteRow.deleted }],
      fetchCloudPreset: async (id: string) => (id === remoteRow.id ? { data: remoteRow.data, revision: remoteRow.revision } : null),
      deleteCloudPreset: async (id: string) => { deletedIds.push(id); remoteRow.deleted = true; return true; },
      syncCloudPreset: async () => ({ id: 'p1', revision: remoteRow.revision + 1 }),
    }));

    const { PresetSync } = await import('../src/utils/presetSync');
    const sync = new PresetSync('physics', 'bases_tombstone');
    const held: Record<string, { savedAt?: number }> = {};
    const cloudOnly = new Map<string, unknown>();

    sync.connect({
      held: () => held,
      has: (n) => Object.hasOwn(held, n) || cloudOnly.has(n),
      read: async (n) => held[n] ?? null,
      write: (n, d) => { held[n] = d as { savedAt?: number }; return true; },
      remove: (n) => { delete held[n]; cloudOnly.delete(n); },
      deferFetch: (n) => { cloudOnly.set(n, null); return { changed: true }; },
      changed: () => {},
    });

    // Device B knew rev 1, deleted it offline (tombstone written with revision: 1, deleted: true)
    storage.setItem('bases_tombstone', JSON.stringify({ tray: { id: 'p1', revision: 1, user: 'u1', deleted: true } }));

    // Device A saved rev 2 in the cloud
    remoteRow = { id: 'p1', name: 'tray', revision: 2, savedAt: 2000, deleted: false, data: { savedAt: 2000, body: 'v2' } };

    // Device B pulls with deferFetch: must clear deleted tombstone
    await sync.pull();
    const afterPull = JSON.parse(storage.getItem('bases_tombstone')!);
    expect(afterPull.tray.deleted).toBeUndefined();

    // Device B opens 'tray' -> fetchLatest brings revision to 2, still without deleted tombstone
    const data = await sync.fetchLatest('tray');
    expect((data as { body: string }).body).toBe('v2');
    const afterFetch = JSON.parse(storage.getItem('bases_tombstone')!);
    expect(afterFetch.tray.revision).toBe(2);
    expect(afterFetch.tray.deleted).toBeUndefined();

    // Next pull must NOT delete Device A's rev 2 from the cloud
    await sync.pull();
    expect(deletedIds).toEqual([]);
    expect(remoteRow.deleted).toBe(false);
  });

  it('#19: fetchLatest does not clobber concurrent local noteSaved() or remove()', async () => {
    let resolveFetch!: (v: unknown) => void;
    vi.doMock('../src/utils/apiClient', () => ({
      getStoredUser: () => ({ id: 'u1' }),
      fetchCloudPresetList: async () => [],
      fetchCloudPreset: () => new Promise((r) => { resolveFetch = r; }),
      deleteCloudPreset: async () => false,
      syncCloudPreset: async () => null,
    }));

    const { PresetSync } = await import('../src/utils/presetSync');
    const sync = new PresetSync('physics', 'bases_race');
    sync.connect({
      held: () => ({}),
      read: async () => null,
      write: () => true,
      remove: () => {},
      changed: () => {},
    });
    storage.setItem('bases_race', JSON.stringify({ tray: { id: 'p1', revision: 1, user: 'u1' } }));

    const pending = sync.fetchLatest('tray');
    // Wait one microtask so inTurn invokes fetchCloudPreset
    await Promise.resolve();
    // Concurrent local save happens while fetchRow is in flight
    sync.noteSaved('tray');
    resolveFetch({ data: { savedAt: 500, body: 'stale' }, revision: 2 });

    expect(await pending).toBeNull();
    expect(sync.isUnsynced('tray')).toBe(true);
    expect(JSON.parse(storage.getItem('bases_race')!).tray.unsynced).toBe(true);
  });

  it('#47: keepBoth checks store.has() so conflict copy avoids cloudOnly names', async () => {
    vi.doMock('../src/utils/apiClient', () => ({
      getStoredUser: () => ({ id: 'u1' }),
      fetchCloudPresetList: async () => [],
      fetchCloudPreset: async () => ({ data: { savedAt: 2000, body: 'theirs' }, revision: 2 }),
      deleteCloudPreset: async () => true,
      syncCloudPreset: async (_app: string, name: string, _data: unknown, _id?: string, baseRev?: number) => {
        if (name === 'tray' && baseRev === 1) return { conflict: { id: 'p1', revision: 2 } };
        return { id: `id_${name}`, revision: (baseRev ?? 0) + 1 };
      },
    }));

    const { PresetSync } = await import('../src/utils/presetSync');
    const sync = new PresetSync('physics', 'bases_conflict');
    const held: Record<string, { savedAt?: number; body?: string }> = { tray: { savedAt: 3000, body: 'mine' } };
    const cloudOnlyNames = new Set(['tray (other device)']);

    sync.connect({
      held: () => held,
      has: (name) => Object.hasOwn(held, name) || cloudOnlyNames.has(name),
      read: async (n) => held[n] ?? null,
      write: (n, d) => { held[n] = d as { savedAt?: number; body?: string }; return true; },
      remove: (n) => { delete held[n]; },
      changed: () => {},
    });

    storage.setItem('bases_conflict', JSON.stringify({ tray: { id: 'p1', revision: 1, user: 'u1', unsynced: true } }));
    expect(await sync.upload('tray', held.tray)).toBe(true);
    // Should skip "tray (other device)" because it's in cloudOnly and pick "(other device 2)"
    expect(held['tray (other device)']).toBeUndefined();
    expect(held['tray (other device 2)']?.body).toBe('theirs');
  });

  it('#47: saveCloudPreset only forgets uploaded blobs and retries on blobs_missing, not offline or 413', async () => {
    let outcome: unknown = null;
    const syncCalls: unknown[] = [];
    const forgetMock = vi.fn();

    vi.doMock('../src/utils/apiClient', () => ({
      getStoredUser: () => ({ id: 'u1' }),
      fetchCloudParameters: async () => ({}),
      fetchCloudPresetList: async () => [],
      fetchCloudPreset: async () => null,
      deleteCloudPreset: async () => false,
      syncCloudPreset: async (...args: unknown[]) => {
        syncCalls.push(args);
        if (typeof outcome === 'function') return (outcome as () => unknown)();
        return outcome;
      },
    }));
    vi.doMock('../src/utils/meshBlobs', () => ({
      externalizeMeshes: async <T,>(d: T) => d,
      forgetUploadedBlobs: forgetMock,
      hasBlobRefs: () => false,
      resolveMeshBlobs: async <T,>(d: T) => d,
    }));

    const { saveCloudPreset } = await import('../src/utils/cloudSync');

    // Offline (null): must NOT wipe uploaded blob cache or retry
    outcome = null;
    expect(await saveCloudPreset('offline_scene', { nodes: [] })).toBe(false);
    expect(forgetMock).not.toHaveBeenCalled();
    expect(syncCalls).toHaveLength(1);

    // 413 refused: must NOT wipe uploaded blob cache or retry
    syncCalls.length = 0;
    outcome = { refused: true };
    expect(await saveCloudPreset('huge_scene', { nodes: [] })).toBe(false);
    expect(forgetMock).not.toHaveBeenCalled();
    expect(syncCalls).toHaveLength(1);

    // blobs_missing: MUST forget uploaded blobs and retry once
    syncCalls.length = 0;
    let attempt = 0;
    outcome = () => (++attempt === 1 ? { blobsMissing: true } : { id: 'p9', revision: 1 });
    expect(await saveCloudPreset('blob_scene', { nodes: [] })).toBe(true);
    expect(forgetMock).toHaveBeenCalledTimes(1);
    expect(syncCalls).toHaveLength(2);
  });
});

describe('#8, #19 (catchUpPreset), #66 (ensureUserPreset cloudOnly fallback)', () => {
  const storage = new FakeStorage();

  beforeEach(() => {
    storage.clear();
    storage.limit = Infinity;
    vi.resetModules();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../src/utils/cloudSync');
    vi.doUnmock('../src/utils/apiClient');
  });

  it('#8: renameScene normalizes user: prefix so renaming foo -> user:foo never deletes foo and user:bar never overwrites bar', async () => {
    vi.doMock('../src/utils/cloudSync', () => ({
      saveCloudPreset: vi.fn(async () => true),
      removeCloudPreset: vi.fn(async () => undefined),
      fetchCloudPresetData: vi.fn(async () => null),
      presetForAccount: async <T,>(d: T) => d,
      presetFromAccount: async <T,>(d: T) => d,
      presetSync: { connect: () => {}, isUnsynced: () => false },
    }));
    vi.doMock('../src/utils/apiClient', () => ({
      getStoredAuthToken: () => null,
      isProAccount: () => false,
    }));

    const userPresets = await import('../src/utils/userPresets');
    const { renameScene } = await import('../src/utils/sceneFiles');

    expect(userPresets.normalizePresetName('  user:foo  ')).toBe('foo');
    expect(userPresets.normalizePresetName('user:user:foo')).toBe('foo');
    expect(userPresets.normalizePresetName('user:')).toBe('');

    userPresets.writeLocalPreset('foo', { nodes: [{ id: 'a' }] } as never);
    userPresets.writeLocalPreset('bar', { nodes: [{ id: 'b' }] } as never);

    // Renaming foo -> user:foo must be a no-op and keep foo intact
    const sameRes = await renameScene('foo', 'user:foo');
    expect(sameRes).toEqual({ ok: true, name: 'foo' });
    expect(userPresets.readUserPreset('foo')?.nodes?.[0].id).toBe('a');

    // Renaming foo -> user:bar must fail collision check and keep bar intact
    const collideRes = await renameScene('foo', 'user:bar');
    expect(collideRes.ok).toBe(false);
    expect(userPresets.readUserPreset('bar')?.nodes?.[0].id).toBe('b');
    expect(userPresets.readUserPreset('foo')?.nodes?.[0].id).toBe('a');
  });

  it('#19: catchUpPreset aborts if local preset becomes unsynced while cloud fetch is in flight', async () => {
    let unsynced = false;
    let resolveFetch!: (v: unknown) => void;
    let connectedStore: import('../src/utils/presetSync').PresetStore | null = null;

    vi.doMock('../src/utils/cloudSync', () => ({
      saveCloudPreset: vi.fn(async () => true),
      removeCloudPreset: vi.fn(async () => undefined),
      fetchCloudPresetData: () => new Promise((r) => { resolveFetch = r; }),
      presetForAccount: async <T,>(d: T) => d,
      presetFromAccount: async <T,>(d: T) => d,
      presetSync: {
        connect: (s: import('../src/utils/presetSync').PresetStore) => { connectedStore = s; },
        isUnsynced: () => unsynced,
      },
    }));

    const userPresets = await import('../src/utils/userPresets');
    userPresets.writeLocalPreset('tray', { nodes: [{ id: 'local_v1' }], savedAt: 1000 } as never);
    connectedStore!.deferFetch!('tray', { id: 'p1', name: 'tray', revision: 2, savedAt: 2000 }, { id: 'p1', revision: 1 });

    const catching = userPresets.catchUpPreset('tray');
    // User saves locally while fetch is in flight
    userPresets.writeLocalPreset('tray', { nodes: [{ id: 'local_v2' }], savedAt: 3000 } as never);
    unsynced = true;
    resolveFetch({ nodes: [{ id: 'cloud_v2' }], savedAt: 2000 });

    expect(await catching).toBe(false);
    expect(userPresets.readUserPreset('tray')?.nodes?.[0].id).toBe('local_v2');
  });

  it('#66: ensureUserPreset falls back to cloudOnly (holdFromAccount) when re-fetching a local preset with $blob refs on full localStorage', async () => {
    const ref = { $packed: 'f32', n: 3, $blob: 'cd'.repeat(32), size: 12 };
    const fullPreset = {
      nodes: [{ id: 'whole', geoms: [{ name: 'm', vertices: new Array(10_000).fill(0.5) }] }],
      savedAt: 2000,
    };

    vi.doMock('../src/utils/cloudSync', () => ({
      saveCloudPreset: vi.fn(async () => true),
      removeCloudPreset: vi.fn(async () => undefined),
      fetchCloudPresetData: vi.fn(async () => fullPreset),
      presetForAccount: async <T,>(d: T) => d,
      presetFromAccount: async <T,>(d: T) => d,
      presetSync: { connect: () => {}, isUnsynced: () => false },
    }));

    const userPresets = await import('../src/utils/userPresets');
    storage.setItem(
      'physics_user_presets',
      JSON.stringify({ big: { nodes: [{ id: 'broken', geoms: [{ name: 'm', vertices: ref }] }], savedAt: 1000 } }),
    );
    // Cap storage so writing fullPreset to localStorage throws QuotaExceededError
    storage.limit = 500;

    expect(await userPresets.ensureUserPreset('big')).toBe(true);
    expect(userPresets.cloudOnlyPresetNames()).toEqual(['big']);
    expect(userPresets.readUserPreset('big')?.nodes?.[0].id).toBe('whole');
  });
});

describe('#23: resolveMeshBlobs catches network/CORS fetch errors cleanly', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves $blob refs intact instead of throwing on fetch rejection or arrayBuffer rejection', async () => {
    const { resolveMeshBlobs, hasBlobRefs } = await import('../src/utils/meshBlobs');
    const doc = {
      nodes: [{ id: 'a', geoms: [{ name: 'g', vertices: { $packed: 'f32', n: 3, $blob: 'aa'.repeat(32), size: 12 } }] }],
    };

    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const res1 = await resolveMeshBlobs(doc, { ['aa'.repeat(32)]: 'https://bucket/blob' });
    expect(hasBlobRefs(res1)).toBe(true);

    vi.stubGlobal('fetch', async () => ({ ok: true, arrayBuffer: async () => { throw new Error('aborted'); } }));
    const res2 = await resolveMeshBlobs(doc, { ['aa'.repeat(32)]: 'https://bucket/blob' });
    expect(hasBlobRefs(res2)).toBe(true);
  });
});

describe('#24, #45, #65 & restored cloud draft wiring: cloudDocuments & apiClient', () => {
  const storage = new FakeStorage();

  beforeEach(() => {
    storage.clear();
    storage.limit = Infinity;
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal('localStorage', storage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock('../src/utils/apiClient');
  });

  it('#45: clearStoredAuth removes physics_cloud_document_id and physics_cloud_draft', async () => {
    storage.setItem('physics_cloud_document_id', 'doc_user_a');
    storage.setItem('physics_cloud_draft', JSON.stringify({ documentId: 'doc_user_a', name: 'Secret', at: Date.now() }));
    storage.setItem('physbox_user_avatar', 'https://example.com/a.png');

    const { clearStoredAuth } = await import('../src/utils/apiClient');
    clearStoredAuth();

    expect(storage.getItem('physics_cloud_document_id')).toBeNull();
    expect(storage.getItem('physics_cloud_draft')).toBeNull();
    expect(storage.getItem('physbox_user_avatar')).toBeNull();
  });

  it('#24: saveExplicit primes remote revision on an existing stored document so baseRevision is sent', async () => {
    storage.setItem('physics_cloud_document_id', 'doc_existing');
    const fetchMock = vi.fn(async (id: string) => ({ id, appId: 'physics', name: 'Existing', revision: 7, sizeBytes: 10, createdAt: '', updatedAt: '', data: { nodes: [] } }));
    const putMock = vi.fn(async (input: { baseRevision?: number }) => ({ id: 'doc_existing', revision: (input.baseRevision ?? 0) + 1 }));

    vi.doMock('../src/utils/apiClient', () => ({
      isProAccount: () => true,
      isProRequired: () => false,
      getStoredAuthToken: () => 'tok',
      putCloudDocument: putMock,
      fetchCloudDocument: fetchMock,
      deleteCloudDocument: async () => true,
    }));

    const { cloudAutosave } = await import('../src/utils/cloudDocuments');
    await cloudAutosave.saveExplicit('MyScene', { nodes: [{ id: 'a' }] }, 'Saved as “MyScene”');

    expect(fetchMock).toHaveBeenCalledWith('doc_existing');
    expect(putMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc_existing', baseRevision: 7 }));
  });

  it('restored cloudDraft coverage: connects document, skips untouched docs, writes unsaved drafts, and restores them', async () => {
    const savedDocs = new Map<string, { revision: number; data: unknown }>();
    const putMock = vi.fn(async (input: { id: string; data: unknown; baseRevision?: number }) => {
      const nextRev = (savedDocs.get(input.id)?.revision ?? 0) + 1;
      savedDocs.set(input.id, { revision: nextRev, data: input.data });
      return { id: input.id, revision: nextRev };
    });
    const fetchMock = vi.fn(async (id: string) => {
      const found = savedDocs.get(id);
      if (!found) throw new PhysBoxApiError('not found', 404);
      return { id, appId: 'physics', name: 'Draft', revision: found.revision, sizeBytes: 100, createdAt: '', updatedAt: '', data: found.data };
    });

    vi.doMock('../src/utils/apiClient', () => ({
      isProAccount: () => true,
      isProRequired: () => false,
      getStoredAuthToken: () => 'tok',
      putCloudDocument: putMock,
      fetchCloudDocument: fetchMock,
      deleteCloudDocument: async () => true,
    }));

    const { cloudAutosave } = await import('../src/utils/cloudDocuments');
    let unsaved = false;
    cloudAutosave.connectDocument(() => unsaved, () => {});

    // Untouched scene: must not write to the cloud
    cloudAutosave.schedule('Untitled scene', () => ({ nodes: [{ id: 'clean' }] }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(putMock).not.toHaveBeenCalled();

    // Edited scene: writes draft and records physics_cloud_draft in localStorage
    unsaved = true;
    const packedDraft = packMeshArrays({ nodes: [{ id: 'edited', geoms: [] }], noteCards: [{ id: 'n1', markdown: 'hi', minimized: false, x: 0, y: 0 }] });
    cloudAutosave.schedule('MyTray', () => packedDraft);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(putMock).toHaveBeenCalledTimes(1);
    const storedDraft = JSON.parse(storage.getItem('physics_cloud_draft')!);
    expect(storedDraft.name).toBe('MyTray');
    expect(savedDocs.has(storedDraft.documentId)).toBe(true);

    // Simulate reload in a fresh module instance: draft is offered and restoreDraft applies it
    vi.resetModules();
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.doMock('../src/utils/apiClient', () => ({
      isProAccount: () => true,
      isProRequired: () => false,
      getStoredAuthToken: () => 'tok',
      putCloudDocument: putMock,
      fetchCloudDocument: fetchMock,
      deleteCloudDocument: async () => true,
    }));
    const { cloudAutosave: reloaded } = await import('../src/utils/cloudDocuments');
    const restored: { data: unknown; name: string }[] = [];
    reloaded.connectDocument(() => false, (data, name) => { restored.push({ data, name }); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reloaded.getStatus().draft?.name).toBe('MyTray');

    expect(await reloaded.restoreDraft()).toBe(true);
    expect(restored).toHaveLength(1);
    expect(restored[0].name).toBe('MyTray');
    expect((restored[0].data as { nodes: { id: string }[] }).nodes[0].id).toBe('edited');
    expect(reloaded.getStatus().draft).toBeNull();
  });
});

describe('#21: applyLoadedSceneToStore hardens JSON import and cloud draft restore', () => {
  it('bypasses Cast-Prep edit guard, strips thumbnail/savedAt, promotes jointed meshes, resets environment & breakage, and force-resets physics', async () => {
    const { useStore } = await import('../src/store/useStore');
    const { applyLoadedSceneToStore } = await import('../src/hooks/useSceneIo');
    const { DEFAULT_ENVIRONMENT } = await import('../src/store/sceneEnvironment');

    const recompileSpy = vi.fn(async () => {});
    const originalRecompile = useStore.getState().recompile;

    // Arm Cast-Prep on current scene and pollute transient state & environment
    useStore.setState({
      sceneGraph: {
        name: 'Old',
        castPrep: { draftDeg: 3, pullAxis: '+z', splitZ: 0 },
        nodes: [{ id: 'old', name: 'old', pos: [0, 0, 0], geoms: [], joints: [], children: [] }],
      } as never,
      activePreset: 'user:old_preset',
      selectedNodeId: 'old',
      hiddenNodeIds: ['old'],
      gravityZ: -1.62,
      windX: 5,
      measureMode: 'distance',
      castPrepGuardOpen: false,
      brokenConstraints: ['w1'],
      recompile: recompileSpy,
    });

    try {
      const imported = {
        name: 'Imported',
        thumbnail: 'data:image/jpeg;base64,AAA',
        savedAt: 123456,
        noteCards: [{ id: 'c1', markdown: 'note', minimized: false, x: 1, y: 2 }],
        copilotMessages: [{ id: 'm1', role: 'user', content: 'hello' }],
        nodes: [
          {
            id: 'arm',
            name: 'arm',
            pos: [0, 0, 0.2],
            joints: [{ name: 'j1', type: 'free' }],
            geoms: [
              {
                name: 'arm_mesh',
                type: 'mesh',
                size: [1, 1, 1],
                vertices: [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0],
                faces: [0, 1, 2],
              },
            ],
            children: [],
          },
        ],
      };

      const { notes, chat } = applyLoadedSceneToStore(imported);
      const state = useStore.getState();

      expect(state.castPrepGuardOpen).toBe(false);
      expect(state.castPrepBlocked).toBe(0);
      expect(state.sceneGraph.name).toBe('Imported');
      expect('thumbnail' in (state.sceneGraph as unknown as Record<string, unknown>)).toBe(false);
      expect('savedAt' in (state.sceneGraph as unknown as Record<string, unknown>)).toBe(false);
      expect(state.sceneGraph.nodes[0].geoms[0].dynamic).toBe(true);
      expect(state.gravityZ).toBe(DEFAULT_ENVIRONMENT.gravityZ);
      expect(state.windX).toBe(DEFAULT_ENVIRONMENT.windX);
      expect(state.selectedNodeId).toBeNull();
      expect(state.hiddenNodeIds).toEqual([]);
      expect(state.measureMode).toBeNull();
      expect(state.brokenConstraints).toEqual([]);
      expect(state.activePreset).toBeUndefined();
      expect(recompileSpy).toHaveBeenCalledWith(state.sceneGraph, null, true, true);
      expect(notes).toHaveLength(1);
      expect(chat).toHaveLength(1);
    } finally {
      useStore.setState({ recompile: originalRecompile });
    }
  });
});

describe('#46, #60, #63: share token error classification, deferred URL revoke, and thin stock PatternThumb', () => {
  it('#46: only clears ?share= token on permanent 404/410/400/payload errors, not offline or 5xx', () => {
    expect(shouldClearShareTokenOnError(new PhysBoxApiError('Not found', 404))).toBe(true);
    expect(shouldClearShareTokenOnError(new PhysBoxApiError('Gone', 410))).toBe(true);
    expect(shouldClearShareTokenOnError(new PhysBoxApiError('Bad request', 400))).toBe(true);
    expect(shouldClearShareTokenOnError(new Error('That link is a Volt document'))).toBe(true);
    expect(shouldClearShareTokenOnError(new Error('That shared scene could not be read'))).toBe(true);

    expect(shouldClearShareTokenOnError(new PhysBoxApiError('Server error', 500))).toBe(false);
    expect(shouldClearShareTokenOnError(new PhysBoxApiError('Unavailable', 503))).toBe(false);
    expect(shouldClearShareTokenOnError(new PhysBoxApiError('Rate limited', 429))).toBe(false);
    expect(shouldClearShareTokenOnError(new TypeError('Failed to fetch'))).toBe(false);
    expect(shouldClearShareTokenOnError(new Error('Network offline'))).toBe(false);
  });

  it('#63: previewStockForThumb clamps thin laser stock (<= 3 mm) so buildPatternPlank never throws', () => {
    const thinStock = { widthMm: 150, depthMm: 100, thicknessMm: 3 };
    const wood = SURFACE_PATTERNS.find((p) => !p.throughCut && !p.figure && !p.prepare)!;
    const { stock, depthMm } = previewStockForThumb(wood, thinStock);
    expect(stock.thicknessMm).toBeGreaterThan(3);
    expect(depthMm).toBeGreaterThan(0);
    expect(() => buildPatternPlank(wood, { ...wood.defaults }, stock, depthMm, 24)).not.toThrow();
  });

  it('#60: downloadSceneRescue defers URL.revokeObjectURL via setTimeout', async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    const click = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click }) });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: revoke });
    try {
      const { downloadSceneRescue } = await import('../src/utils/rescueScene');
      downloadSceneRescue({ nodes: [] }, undefined);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(revoke).toHaveBeenCalledWith('blob:test');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('#7, #22, #44, #48, #64, #65: UI & hook source invariants', () => {
  const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

  it('#7 & #46: useShareScene holds quota fallback in cloudOnly, clears URL after open, guards handleShare & skips fragment when token present', () => {
    const src = read('src/hooks/useShareScene.tsx');
    expect(src).toContain('rememberCloudOnlyPreset(name, preset)');
    expect(src).toContain('normalizePresetName(');
    expect(src).toContain('shareSeqRef');
    expect(src).toContain('shouldClearShareTokenOnError');
    expect(src.indexOf('loadUserPresetWithCard(`user:${name}`)')).toBeLessThan(src.indexOf('clearShareFragment()'));
  });

  it('#22, #24, #65: usePresetActions guards loadSeqRef, runs saveExplicit only on result.ok, and checks modelBuiltFrom on live store graph', () => {
    const src = read('src/hooks/usePresetActions.ts');
    expect(src).toContain('loadSeqRef');
    expect(src).toContain('modelBuiltFrom().graph === liveGraph');
    expect(src).toContain('normalizePresetName(name)');
    const okBlock = src.slice(src.indexOf('if (result.ok)'), src.indexOf('} catch (e)'));
    expect(okBlock).toContain('cloudAutosave.saveExplicit');
  });

  it('#44: useSceneDocument flushes pending undo before markClean, and SceneBrowser/PresetPicker markUnsaved on active preset delete', () => {
    expect(read('src/hooks/useSceneDocument.ts')).toContain('useStore.getState().flushPendingUndo()');
    expect(read('src/components/files/SceneBrowser.tsx')).toContain('presets.markUnsaved()');
    expect(read('src/components/header/PresetPicker.tsx')).toContain('presets.markUnsaved()');
  });

  it('#48 & #64: SavedSceneList removes onDoubleClick & guards renameBusy; SceneBrowser & SavePresetModal wire dialog a11y', () => {
    const listSrc = read('src/components/files/SavedSceneList.tsx');
    expect(listSrc).not.toContain('onDoubleClick');
    expect(listSrc).toContain('renameBusy');

    const browserSrc = read('src/components/files/SceneBrowser.tsx');
    expect(browserSrc).toContain('if (!q) return;');
    expect(browserSrc).toContain('useStore.getState().activePreset === `user:${from}`');
    expect(browserSrc).toContain('role="dialog"');
    expect(browserSrc).toContain('aria-modal="true"');
    expect(browserSrc).toContain('useDialogA11y');

    const modalSrc = read('src/components/SavePresetModal.tsx');
    expect(modalSrc).toContain('role="dialog"');
    expect(modalSrc).toContain('aria-modal="true"');
    expect(modalSrc).toContain('useDialogA11y');
    expect(modalSrc).toContain('useEscapeToClose');
  });
});
