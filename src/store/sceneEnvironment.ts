// ---------------------------------------------------------------------------
// The environment a scene is saved and loaded with
//
// Gravity, wind, air density and the floor live in the store's own fields,
// not on the scene graph, so every save, file and share link used to leave
// them behind: a scene built for the Moon opened at -9.81. They now travel as
// `SceneGraph.environment`, stamped on the way out and taken off on the way in.
// ---------------------------------------------------------------------------

import type { SceneEnvironment, SceneGraph } from '../types/scene';

export const DEFAULT_ENVIRONMENT: SceneEnvironment = {
  gravityZ: -9.81,
  windX: 0,
  windY: 0,
  density: 0,
  floorFriction: 1.0,
  floorBounce: 0.0,
};

const KEYS = Object.keys(DEFAULT_ENVIRONMENT) as Array<keyof SceneEnvironment>;

/** The environment fields out of the store's state (or anything carrying them). */
export function readEnvironment(state: SceneEnvironment): SceneEnvironment {
  const env = {} as SceneEnvironment;
  for (const k of KEYS) env[k] = state[k];
  return env;
}

/** The graph as it is written out: the live graph, with the environment on it. */
export function withEnvironment<G extends SceneGraph>(graph: G, state: SceneEnvironment): G {
  return { ...graph, environment: readEnvironment(state) };
}

/**
 * The environment a saved scene asks for: what it says, and the defaults for
 * whatever it does not. A field that is not a finite number is ignored rather
 * than handed to the MJCF writer.
 */
export function environmentOf(saved: Partial<SceneEnvironment> | null | undefined): SceneEnvironment {
  const env = { ...DEFAULT_ENVIRONMENT };
  for (const k of KEYS) {
    const v = saved?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) env[k] = v;
  }
  return env;
}

/** Splits a loaded graph into the graph the store keeps and the environment it asked for, if any. */
export function takeEnvironment<G extends SceneGraph>(graph: G): { graph: G; environment: SceneEnvironment | null } {
  if (!('environment' in graph)) return { graph, environment: null };
  const { environment, ...rest } = graph;
  return { graph: rest as G, environment: environment ? environmentOf(environment) : null };
}
