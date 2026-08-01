// The copilot output budget. Its whole job is to never hand the API a value it
// will reject, including when localStorage holds junk from an older build or a
// hand-edited value.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS,
  MAX_TOKENS_STORAGE_KEY, clampMaxTokens, readMaxTokens, writeMaxTokens,
} from '../src/utils/llmSettings';

let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
  };
});

describe('clampMaxTokens', () => {
  it('holds the documented range', () => {
    expect(MIN_MAX_TOKENS).toBe(2000);
    expect(MAX_MAX_TOKENS).toBe(100000);
    expect(DEFAULT_MAX_TOKENS).toBe(16384);
  });

  it('clamps out-of-range values to the bounds', () => {
    expect(clampMaxTokens(1)).toBe(MIN_MAX_TOKENS);
    expect(clampMaxTokens(999999)).toBe(MAX_MAX_TOKENS);
    expect(clampMaxTokens(-5)).toBe(MIN_MAX_TOKENS);
  });

  it('falls back to the default on any non-finite input', () => {
    // Including Infinity: a non-finite value only ever arrives from a
    // hand-edited store, so treat it as unusable rather than as "the maximum".
    expect(clampMaxTokens(NaN)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampMaxTokens(Infinity)).toBe(DEFAULT_MAX_TOKENS);
    expect(clampMaxTokens(-Infinity)).toBe(DEFAULT_MAX_TOKENS);
  });

  it('rounds fractional values', () => {
    expect(clampMaxTokens(20000.6)).toBe(20001);
  });
});

describe('readMaxTokens', () => {
  it('defaults when nothing is stored', () => {
    expect(readMaxTokens()).toBe(DEFAULT_MAX_TOKENS);
  });

  it('defaults on unparseable stored values', () => {
    store[MAX_TOKENS_STORAGE_KEY] = 'lots';
    expect(readMaxTokens()).toBe(DEFAULT_MAX_TOKENS);
    store[MAX_TOKENS_STORAGE_KEY] = '';
    expect(readMaxTokens()).toBe(DEFAULT_MAX_TOKENS);
  });

  it('clamps a stored value that is out of range', () => {
    store[MAX_TOKENS_STORAGE_KEY] = '500000';
    expect(readMaxTokens()).toBe(MAX_MAX_TOKENS);
  });

  it('round-trips a valid value', () => {
    expect(writeMaxTokens(32000)).toBe(32000);
    expect(readMaxTokens()).toBe(32000);
  });

  it('persists the clamped value, not the raw one', () => {
    expect(writeMaxTokens(1)).toBe(MIN_MAX_TOKENS);
    expect(store[MAX_TOKENS_STORAGE_KEY]).toBe(String(MIN_MAX_TOKENS));
  });

  it('survives a localStorage that throws', () => {
    (globalThis as any).localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(readMaxTokens()).toBe(DEFAULT_MAX_TOKENS);
    expect(writeMaxTokens(50000)).toBe(50000);
  });
});
