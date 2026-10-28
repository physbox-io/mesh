import type { StoreApi } from 'zustand';
import type { PhysicsState } from './useStore';

/** What a slice of the store is built from: the store's own set (see sharingUnchangedNodes) and get. */
export interface SliceDeps {
  set: StoreApi<PhysicsState>['setState'];
  get: () => PhysicsState;
}
