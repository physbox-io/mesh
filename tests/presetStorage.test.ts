import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

/**
 * A localStorage that can be told to run out of room, which is the whole point
 * of the thing under test and cannot be provoked any other way.
 */
class FakeStorage {
  private map = new Map<string, string>();
  limit = Infinity;
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  setItem(k: string, v: string) {
    const others = [...this.map.entries()].filter(([key]) => key !== k)
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

const store = new FakeStorage();
vi.stubGlobal('localStorage', store);

const cloud = { saveCloudPreset: vi.fn(), removeCloudPreset: vi.fn() };
vi.mock('../src/utils/cloudSync', () => ({
  saveCloudPreset: (...a: unknown[]) => cloud.saveCloudPreset(...a),
  removeCloudPreset: (...a: unknown[]) => cloud.removeCloudPreset(...a),
}));

const account = { token: null as string | null, pro: false, presets: [] as { name: string; data: unknown }[] };
vi.mock('../src/utils/apiClient', () => ({
  getStoredAuthToken: () => account.token,
  isProAccount: () => account.pro,
  fetchCloudPresets: async () => account.presets,
}));

const bigScene = (mb: number) => ({
  nodes: [{ id: 'x', geoms: [{ name: 'm', vertices: new Array(Math.round(mb * 100_000)).fill(1.2345) }] }],
}) as never;

let savePreset: typeof import('../src/utils/presetStorage').savePreset;
let presetToFile: typeof import('../src/utils/presetStorage').presetToFile;
let presetStorageReport: typeof import('../src/utils/presetStorage').presetStorageReport;
let listPresetNamesEverywhere: typeof import('../src/utils/presetStorage').listPresetNamesEverywhere;
let readPresetAnywhere: typeof import('../src/utils/presetStorage').readPresetAnywhere;

beforeEach(async () => {
  store.clear();
  store.limit = Infinity;
  account.token = null; account.pro = false; account.presets = [];
  cloud.saveCloudPreset.mockReset().mockResolvedValue(true);
  cloud.removeCloudPreset.mockReset().mockResolvedValue(undefined);
  vi.resetModules();
  const m = await import('../src/utils/presetStorage');
  savePreset = m.savePreset;
  presetToFile = m.presetToFile;
  presetStorageReport = m.presetStorageReport;
  listPresetNamesEverywhere = m.listPresetNamesEverywhere;
  readPresetAnywhere = m.readPresetAnywhere;
});

afterEach(() => { vi.restoreAllMocks(); });

describe('saving a preset when there is room', () => {
  it('saves locally and says so', async () => {
    const r = await savePreset('small', { nodes: [] } as never);
    expect(r.ok).toBe(true);
    expect(r.savedTo).toBe('local');
    expect(r.quotaExceeded).toBe(false);
    expect(r.remedies).toEqual([]);
  });

  it('hands back the upload so a toast can say when the account has it too', async () => {
    account.token = 'tok';
    let settle: (v: boolean) => void = () => {};
    cloud.saveCloudPreset.mockReturnValue(new Promise<boolean>(res => { settle = res; }));

    const r = await savePreset('later', { nodes: [] } as never);
    // The save is already acknowledged, before the network has answered.
    expect(r.ok).toBe(true);
    expect(r.savedTo).toBe('local');
    expect(r.cloudPending).toBeInstanceOf(Promise);

    settle(true);
    await expect(r.cloudPending).resolves.toBe(true);
  });

  it('does not pretend there is an upload when signed out', async () => {
    const r = await savePreset('offline', { nodes: [] } as never);
    expect(r.cloudPending).toBeNull();
    expect(cloud.saveCloudPreset).not.toHaveBeenCalled();
  });
});

describe('saving a preset when the browser is full', () => {
  it('does not fail silently: it reports the quota, the size and what is eating the room', async () => {
    await savePreset('hog', bigScene(1));
    store.limit = store.getItem('physics_user_presets')!.length + 200;

    const r = await savePreset('another', bigScene(1));

    expect(r.ok).toBe(false);
    expect(r.savedTo).toBe('nowhere');
    expect(r.quotaExceeded).toBe(true);
    expect(r.bytes).toBeGreaterThan(100_000);
    expect(r.largest[0].name).toBe('hog');
    expect(r.message).toMatch(/storage is full/i);
    expect(r.message).toMatch(/Nothing has been saved/);
  });

  it('recommends deleting the biggest presets first, and says how much that frees', async () => {
    await savePreset('tiny', { nodes: [] } as never);
    await savePreset('hog', bigScene(1));
    store.limit = store.getItem('physics_user_presets')!.length + 200;

    const r = await savePreset('another', bigScene(1));
    const del = r.remedies.find(x => x.kind === 'delete') as { kind: 'delete'; names: string[]; freesBytes: number };
    expect(del).toBeTruthy();
    expect(del.names[0]).toBe('hog');
    expect(del.freesBytes).toBeGreaterThan(100_000);
  });

  it('always offers the download, so the work cannot be lost', async () => {
    store.limit = 10;
    const r = await savePreset('unsaveable', bigScene(1));
    expect(r.remedies.some(x => x.kind === 'download')).toBe(true);
  });

  it('invites a signed-out user to sign in, and a free account to upgrade', async () => {
    store.limit = 10;

    const out = await savePreset('a', bigScene(1));
    expect(out.remedies.some(x => x.kind === 'signIn')).toBe(true);
    expect(out.remedies.some(x => x.kind === 'upgrade')).toBe(false);
    expect(out.message).toMatch(/Signing in/);

    account.token = 'tok';
    cloud.saveCloudPreset.mockResolvedValue(false); // account unreachable
    const free = await savePreset('b', bigScene(1));
    expect(free.remedies.some(x => x.kind === 'upgrade')).toBe(true);
    expect(free.message).toMatch(/PhysBox Pro/);
  });
});

describe('an account is not tied to this browser', () => {
  it('falls back to the account when the browser is full, rather than losing the save', async () => {
    account.token = 'tok';
    account.pro = true;
    store.limit = 10;

    const r = await savePreset('too_big_for_here', bigScene(1));

    expect(r.ok).toBe(true);
    expect(r.savedTo).toBe('cloud');
    expect(r.quotaExceeded).toBe(true);
    expect(cloud.saveCloudPreset).toHaveBeenCalledWith('too_big_for_here', expect.anything());
    expect(r.message).toMatch(/saved to your account/i);
  });

  it('lists and reads a preset that only exists in the account', async () => {
    account.token = 'tok';
    account.presets = [{ name: 'cloud_only', data: { nodes: [{ id: 'fromCloud' }] } }];

    expect(await listPresetNamesEverywhere()).toContain('cloud_only');
    const read = await readPresetAnywhere('user:cloud_only');
    expect((read as { nodes: { id: string }[] }).nodes[0].id).toBe('fromCloud');
  });

  it('prefers the local copy when a name exists in both', async () => {
    account.token = 'tok';
    account.presets = [{ name: 'both', data: { nodes: [{ id: 'cloud' }] } }];
    await savePreset('both', { nodes: [{ id: 'local' }] } as never);

    const read = await readPresetAnywhere('both');
    expect((read as { nodes: { id: string }[] }).nodes[0].id).toBe('local');
  });

  it('still lists what this browser has when the account cannot be reached', async () => {
    account.token = 'tok';
    await savePreset('here', { nodes: [] } as never);
    const api = await import('../src/utils/apiClient');
    vi.spyOn(api, 'fetchCloudPresets').mockRejectedValue(new Error('offline'));
    expect(await listPresetNamesEverywhere()).toEqual(['here']);
  });
});

describe('the download fallback and the usage report', () => {
  it('produces a sane filename and valid JSON', () => {
    const f = presetToFile('user:my scene/1', { nodes: [] } as never);
    expect(f.filename).toBe('my_scene_1.physbox.json');
    expect(JSON.parse(f.json)).toEqual({ nodes: [] });
  });

  it('reports what is in the store, largest first', async () => {
    await savePreset('tiny', { nodes: [] } as never);
    await savePreset('hog', bigScene(1));
    const report = presetStorageReport();
    expect(report.presets).toBe(2);
    expect(report.largest[0].name).toBe('hog');
    expect(report.total).toMatch(/MB|kB/);
  });
});
