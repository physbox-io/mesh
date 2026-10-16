// api.state: the per-body object a control script keeps its state in.
//
// The worker builds a fresh `api` object for every call and compiles each
// script once with `new Function('api', src)`, so a script's local variables
// die with each step. These drive that exact calling convention against the
// store the worker uses, and pin the contract the native desktop app shares:
// the state lasts, cannot be replaced wholesale, is carried by a worker
// recycle's seed, and is emptied by a Reset.

import { describe, it, expect, vi } from 'vitest';
import { ScriptStateStore, attachScriptState, scriptStateForBuild } from '../src/utils/scriptState';

// One worker step for one body: a fresh api, as physicsWorker.ts builds it.
const step = (fn: (api: Record<string, unknown>) => void, store: ScriptStateStore, nodeId: string, log: unknown[]) => {
  const api: Record<string, unknown> = { id: nodeId, log: (m: unknown) => log.push(m) };
  attachScriptState(api, store, nodeId);
  fn(api);
};

const counter = new Function('api', `
  api.state.n = (api.state.n || 0) + 1;
  var local = (typeof local === 'undefined' ? 0 : local) + 1;
  api.state = { n: -1000 };
  api.log(api.state.n + ':' + local);
`) as (api: Record<string, unknown>) => void;

describe('api.state', () => {
  it('keeps its contents from one step to the next, where locals do not', () => {
    const store = new ScriptStateStore();
    const log: unknown[] = [];
    for (let i = 0; i < 3; i++) step(counter, store, 'cart', log);
    expect(log).toEqual(['1:1', '2:1', '3:1']);
  });

  it('cannot be replaced wholesale', () => {
    const store = new ScriptStateStore();
    const api: Record<string, unknown> = {};
    attachScriptState(api, store, 'cart');
    const strict = new Function('api', `'use strict'; api.state = {};`);
    expect(() => strict(api)).toThrow(TypeError);
    expect(api.state).toBe(store.stateFor('cart'));
  });

  it('is per body', () => {
    const store = new ScriptStateStore();
    const log: unknown[] = [];
    step(counter, store, 'a', log);
    step(counter, store, 'a', log);
    step(counter, store, 'b', log);
    expect(log).toEqual(['1:1', '2:1', '1:1']);
  });

  it('survives a rebuild that keeps the simulation running, and a recycle seed', () => {
    const store = new ScriptStateStore();
    const log: unknown[] = [];
    step(counter, store, 'cart', log);
    step(counter, store, 'cart', log);

    // An edit mid-play: BUILD with preserveState and no seed.
    scriptStateForBuild(store, true, undefined);
    step(counter, store, 'cart', log);
    expect(log.at(-1)).toBe('3:1');

    // A worker recycle: the old worker's frame carried a snapshot, the new
    // worker (a fresh store) is built from a seed holding it.
    const seed = { scriptState: store.snapshot() };
    const fresh = new ScriptStateStore();
    scriptStateForBuild(fresh, false, seed);
    step(counter, fresh, 'cart', log);
    expect(log.at(-1)).toBe('4:1');
  });

  it('is emptied by a Reset or a preset load', () => {
    const store = new ScriptStateStore();
    const log: unknown[] = [];
    step(counter, store, 'cart', log);
    step(counter, store, 'cart', log);
    // resetSimulation() rebuilds without preserveState and without a seed.
    scriptStateForBuild(store, false, undefined);
    step(counter, store, 'cart', log);
    expect(log.at(-1)).toBe('1:1');
  });

  it('snapshots as an independent copy, and only when there is something to carry', () => {
    const store = new ScriptStateStore();
    expect(store.snapshot()).toBeUndefined();
    store.stateFor('idle');
    expect(store.snapshot()).toBeUndefined();
    store.stateFor('cart').history = [1, 2, 3];
    const snap = store.snapshot()!;
    (store.stateFor('cart').history as number[]).push(4);
    expect(snap).toEqual({ cart: { history: [1, 2, 3] } });
  });

  it('leaves behind, with one warning, a state that cannot cross a worker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ScriptStateStore();
    store.stateFor('cart').fn = () => 1;
    expect(store.snapshot()).toBeUndefined();
    expect(store.snapshot()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps a headless run apart from the live scene', () => {
    // physics_run_headless swaps in a fresh store for the run and puts the
    // live one back afterwards; this is what that swap protects.
    const live = new ScriptStateStore();
    const headless = new ScriptStateStore();
    const log: unknown[] = [];
    step(counter, live, 'cart', log);
    step(counter, headless, 'cart', log);
    step(counter, headless, 'cart', log);
    step(counter, live, 'cart', log);
    expect(log).toEqual(['1:1', '1:1', '2:1', '2:1']);
  });
});
