import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/*
 * The rack store reads storage when the module loads, so storage has to exist
 * before the import: hoisted, as vi.mock is.
 */
const storage = vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as unknown as { __hadLocalStorage: boolean }).__hadLocalStorage = 'localStorage' in globalThis;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
  return map;
});

const api = vi.hoisted(() => ({
  syncCloudParameters: vi.fn().mockResolvedValue(true),
  fetchCloudParameters: vi.fn(),
  fetchCloudPresetList: vi.fn().mockResolvedValue([]),
  fetchCloudPreset: vi.fn(),
  syncCloudPreset: vi.fn(),
  deleteCloudPreset: vi.fn(),
}));
vi.mock('../src/utils/apiClient', () => api);

import { TOOL_RACK_PARAMETER, TOOL_RACK_STORAGE_KEY, defaultToolRack } from '@physbox-io/machining';
import { rackToolLabel, rackToolsFor, settleToolRack, toolRackStore } from '../src/utils/toolRack';
import { pullCloudState } from '../src/utils/cloudSync';

/** Lets the lazy `import('./apiClient')` in the store's push resolve. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const fromAccount = (savedAt: number) => ({
  savedAt,
  tools: [
    { uid: 'from-etch', toolNumber: 1, name: '2 mm flat end mill', shape: 'flat', diameterMm: 2, available: true },
  ],
});

// Not left behind for a file that checks how code behaves with no storage.
afterAll(() => {
  if (!(globalThis as unknown as { __hadLocalStorage: boolean }).__hadLocalStorage) {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  }
});

describe('the shared tool rack, in Mesh', () => {
  beforeEach(() => {
    storage.clear();
    toolRackStore.reload();
    api.syncCloudParameters.mockClear();
  });

  it('starts as the starting rack, and an edit is stored and sent to the account under global', async () => {
    expect(toolRackStore.get().tools.length).toBe(defaultToolRack().tools.length);

    const tools = [{ ...defaultToolRack().tools[0], diameterMm: 3 }];
    toolRackStore.set(tools);
    await flush();

    expect(JSON.parse(storage.get(TOOL_RACK_STORAGE_KEY)!).tools[0].diameterMm).toBe(3);
    // `global`, not `physics`: the row Etch and Volt read.
    expect(api.syncCloudParameters).toHaveBeenCalledWith('global', {
      [TOOL_RACK_PARAMETER]: expect.objectContaining({ tools }),
    });
  });

  it('takes a newer rack from the account, and sends an older one ours', async () => {
    expect(settleToolRack(fromAccount(Date.now() + 1000))).toBe(true);
    expect(toolRackStore.get().tools[0].uid).toBe('from-etch');

    toolRackStore.set([{ ...defaultToolRack().tools[0] }]);
    await flush();
    api.syncCloudParameters.mockClear();
    expect(settleToolRack(fromAccount(1))).toBe(false);
    await flush();
    expect(api.syncCloudParameters).toHaveBeenCalledWith('global', expect.anything());
  });

  it('is settled by the sign-in pull, from the global row', async () => {
    api.fetchCloudParameters.mockImplementation(async (scope: string) =>
      scope === 'global' ? { [TOOL_RACK_PARAMETER]: fromAccount(Date.now() + 1000) } : {}
    );
    const result = await pullCloudState();
    expect(result.parameters).toBe(1);
    expect(toolRackStore.get().tools[0].uid).toBe('from-etch');
  });

  it('offers only bits in the drawer, of a shape the field can use', () => {
    const rack = defaultToolRack();
    rack.tools[0].available = false; // T1, the 3.175 mm flat, retired
    const flats = rackToolsFor(rack, ['flat']);
    expect(flats.every((t) => t.shape === 'flat' && t.available)).toBe(true);
    expect(flats.some((t) => t.toolNumber === 1)).toBe(false);
    expect(rackToolsFor(rack, ['ball']).map((t) => t.toolNumber)).toEqual([5]);
  });

  it('labels a bit by T number, without saying its size twice', () => {
    const [t1] = defaultToolRack().tools;
    expect(rackToolLabel(t1)).toBe('T1 · 3.175 mm (1/8") flat end mill');
    const vbit = defaultToolRack().tools.find((t) => t.toolNumber === 3)!;
    expect(rackToolLabel(vbit)).toBe('T3 · 0.2 mm 60° V-bit');
  });
});
