// How many builds with cloth in them the physics worker is still on, for the
// viewport's "Fabric rendering" pill. A build with cloth models every garment
// and settles it before the first frame comes back, which takes seconds to
// minutes (a scene opened, Run pressed on an edited one, a dress form deleted
// from under its clothes), and until then nothing said anything was happening.
//
// A store of its own rather than a slice of useStore: the worker client sets
// it, and editing useStore reloads the app and the scene with it.

import { create } from 'zustand';
import type { SceneGraph, SceneNode } from '../types/scene';

export const useFabricBuild = create<{ count: number }>(() => ({ count: 0 }));

/** Whether a scene has cloth anywhere in it. */
export function sceneHasCloth(graph: SceneGraph): boolean {
  const walk = (nodes: SceneNode[] | undefined): boolean => (nodes ?? []).some((n) => (n as { cloth?: unknown }).cloth != null || walk(n.children));
  return walk(graph.nodes);
}

export const fabricBuildStarted = () => useFabricBuild.setState((s) => ({ count: s.count + 1 }));
export const fabricBuildEnded = () => useFabricBuild.setState((s) => ({ count: Math.max(0, s.count - 1) }));
