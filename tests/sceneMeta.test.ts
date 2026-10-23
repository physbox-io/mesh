import { describe, it, expect, beforeEach } from 'vitest';
import { listRecent, recordRecent, renameRecent, forgetRecent } from '../src/utils/sceneMeta';

const store: Record<string, string> = {};
(globalThis as { localStorage?: Storage }).localStorage ??= {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: () => null,
  length: 0,
} as Storage;

describe('recent scenes', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the latest first, once each, and never Blank', () => {
    recordRecent('pendulum', 1);
    recordRecent('user:A', 2);
    recordRecent('pendulum', 3);
    recordRecent('empty', 4);
    expect(listRecent().map((r) => r.id)).toEqual(['pendulum', 'user:A']);
  });

  it('caps the list', () => {
    for (let i = 0; i < 20; i++) recordRecent(`user:s${i}`, i);
    expect(listRecent()).toHaveLength(12);
    expect(listRecent()[0].id).toBe('user:s19');
  });

  it('follows a rename and forgets a delete', () => {
    recordRecent('user:A', 1);
    recordRecent('user:B', 2);
    renameRecent('user:A', 'user:C');
    expect(listRecent().map((r) => r.id)).toEqual(['user:B', 'user:C']);
    forgetRecent('user:B');
    expect(listRecent().map((r) => r.id)).toEqual(['user:C']);
  });
});
