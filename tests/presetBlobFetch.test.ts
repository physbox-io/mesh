import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A preset fetched with a mesh missing must never be kept, least of all over a whole one. */

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
});

const account = vi.hoisted(() => ({ preset: null as unknown, rows: [] as unknown[] }));

vi.mock('../src/utils/apiClient', () => ({
  getStoredAuthToken: () => 'token',
  isProAccount: () => true,
  getStoredUser: () => ({ id: 'me' }),
  fetchCloudPreset: async () => account.preset,
  fetchCloudPresetList: async () => account.rows,
}));

const ref = { $packed: 'f32', n: 3, $blob: 'ab'.repeat(32), size: 12 };
const held = { nodes: [{ id: 'held', geoms: [{ name: 'm', vertices: [1, 2, 3] }] }], savedAt: 1000 } as never;

describe('a preset whose meshes could not be fetched', () => {
  beforeEach(() => {
    vi.resetModules();
    storage.clear();
    storage.set('physics_cloud_preset_ids', JSON.stringify({ p: { id: 'id', revision: 1, user: 'me' } }));
    account.rows = [{ id: 'id', name: 'p', revision: 2, savedAt: 2000 }];
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    account.preset = { data: { nodes: [{ id: 'later', geoms: [{ name: 'm', vertices: ref }] }], savedAt: 2000 }, blobUrls: {} };
  });

  it('leaves the copy held here alone, and tries again next time', async () => {
    const presets = await import('../src/utils/userPresets');
    const { presetSync } = await import('../src/utils/cloudSync');
    presets.writeLocalPreset('p', held);
    await presetSync.pull();

    expect(await presets.catchUpPreset('p')).toBe(false);
    expect(presets.readUserPreset('p')?.nodes?.[0].id).toBe('held');
  });

  it('is not kept when opened for the first time', async () => {
    const presets = await import('../src/utils/userPresets');
    const { presetSync } = await import('../src/utils/cloudSync');
    storage.set('physics_cloud_preset_ids', '{}');
    await presetSync.pull();

    expect(await presets.ensureUserPreset('p')).toBe(false);
    expect(presets.readUserPresets()).toEqual({});
  });

  it('is fetched again when a broken copy was kept before', async () => {
    const presets = await import('../src/utils/userPresets');
    storage.set('physics_user_presets', JSON.stringify({ p: { nodes: [{ id: 'broken', geoms: [{ name: 'm', vertices: ref }] }], savedAt: 2000 } }));
    account.preset = { data: { nodes: [{ id: 'whole', geoms: [{ name: 'm', vertices: [1, 2, 3] }] }], savedAt: 2000 } };

    expect(await presets.ensureUserPreset('p')).toBe(true);
    expect(presets.readUserPreset('p')?.nodes?.[0].id).toBe('whole');
  });
});
