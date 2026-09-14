import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribeToPresetNotices, announcePresetSave, type PresetNotice } from '../src/utils/presetNotices';
import type { PresetSaveResult } from '../src/utils/presetStorage';

const result = (over: Partial<PresetSaveResult> = {}): PresetSaveResult => ({
  ok: true, savedTo: 'local', quotaExceeded: false, bytes: 10, storeBytes: 10,
  largest: [], signedIn: false, pro: false, message: 'Saved.', remedies: [],
  cloudPending: null, ...over,
});

describe('preset save notices', () => {
  let seen: PresetNotice[];
  let stop: () => void;

  beforeEach(() => {
    seen = [];
    stop?.();
    stop = subscribeToPresetNotices((n) => seen.push(n));
  });

  it('delivers the save to whatever is listening, with the name unprefixed', () => {
    announcePresetSave('user:my_scene', { nodes: [] }, result());
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('my_scene');
    expect(seen[0].result.ok).toBe(true);
  });

  it('gives every notice a new id, so saving the same name twice shows twice', () => {
    announcePresetSave('a', { nodes: [] }, result());
    announcePresetSave('a', { nodes: [] }, result());
    expect(seen[0].id).not.toBe(seen[1].id);
  });

  it('carries the pending upload through, so the toast can finish its sentence', async () => {
    const pending = Promise.resolve(true);
    announcePresetSave('a', { nodes: [] }, result({ cloudPending: pending }));
    await expect(seen[0].cloudPending).resolves.toBe(true);
  });

  it('carries the preset itself, which is what the download offer needs', () => {
    announcePresetSave('a', { nodes: [{ id: 'keepme' }] } as never, result({ ok: false, savedTo: 'nowhere' }));
    expect((seen[0].preset.nodes as { id: string }[])[0].id).toBe('keepme');
  });

  it('a listener that throws does not stop the save being announced to the others', () => {
    const later: PresetNotice[] = [];
    const stopBad = subscribeToPresetNotices(() => { throw new Error('boom'); });
    const stopGood = subscribeToPresetNotices((n) => later.push(n));
    expect(() => announcePresetSave('a', { nodes: [] }, result())).not.toThrow();
    expect(later).toHaveLength(1);
    stopBad(); stopGood();
  });

  it('stops delivering once unsubscribed', () => {
    const fn = vi.fn();
    const off = subscribeToPresetNotices(fn);
    off();
    announcePresetSave('a', { nodes: [] }, result());
    expect(fn).not.toHaveBeenCalled();
  });
});
