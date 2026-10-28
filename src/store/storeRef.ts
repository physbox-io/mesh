import type { StoreApi } from 'zustand';
import type { PhysicsState } from './useStore';

/*
 * The store, for the modules useStore is built from. They cannot import
 * useStore back (that is a cycle, and a cycle in an import graph that reaches a
 * worker has broken the production build before), so useStore hands itself
 * over here once it exists. Nothing calls store() before that: it is only
 * reached from callbacks and actions, which run after the store is made.
 */
let api: StoreApi<PhysicsState> | null = null;

export function bindStore(store: StoreApi<PhysicsState>) {
  api = store;
}

export function store(): StoreApi<PhysicsState> {
  if (!api) throw new Error('the store is not made yet');
  return api;
}
