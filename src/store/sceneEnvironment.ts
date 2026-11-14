// ---------------------------------------------------------------------------
// The environment a scene is saved and loaded with
//
// Gravity, wind, air density and the floor live in the store's own fields,
// not on the scene graph, so every save, file and share link used to leave
// them behind: a scene built for the Moon opened at -9.81. They now travel as
// `SceneGraph.environment`, stamped on the way out and taken off on the way in.
// ---------------------------------------------------------------------------

import type { BackgroundId, SceneEnvironment, SceneGraph } from '../types/scene';

export interface BackgroundOption {
  id: BackgroundId;
  label: string;
  description: string;
}

export const BACKGROUND_OPTIONS: ReadonlyArray<BackgroundOption> = [
  { id: 'studio', label: 'Studio', description: 'Neutral photo cyclorama with reference grid' },
  { id: 'meadow', label: 'Meadow', description: 'Sunlit grassy clearing, wildflowers, and rolling hills' },
  { id: 'mountains', label: 'Mountains', description: 'Granite alpine outcrop overlooking snow-capped peaks' },
  { id: 'urban', label: 'Urban / Graffiti Wall', description: 'Concrete sidewalk before a painted brick alley wall' },
  { id: 'workbench', label: 'Lab / Workbench', description: 'Butcher-block maker bench with true-scale ESD cutting mat' },
  { id: 'coffee_table', label: 'Cozy Coffee Table', description: 'Mid-century walnut coffee table in a sunlit living room' },
];

const BACKGROUND_ID_SET = new Set<string>(BACKGROUND_OPTIONS.map((o) => o.id));

export function isBackgroundId(value: unknown): value is BackgroundId {
  return typeof value === 'string' && BACKGROUND_ID_SET.has(value);
}

export const DEFAULT_ENVIRONMENT: SceneEnvironment = {
  gravityZ: -9.81,
  windX: 0,
  windY: 0,
  density: 0,
  floorFriction: 1.0,
  floorBounce: 0.0,
  background: 'studio',
};

const NUMERIC_KEYS = ['gravityZ', 'windX', 'windY', 'density', 'floorFriction', 'floorBounce'] as const;

/** The environment fields out of the store's state (or anything carrying them). */
export function readEnvironment(state: SceneEnvironment): SceneEnvironment {
  return {
    gravityZ: state.gravityZ,
    windX: state.windX,
    windY: state.windY,
    density: state.density,
    floorFriction: state.floorFriction,
    floorBounce: state.floorBounce,
    background: isBackgroundId(state.background) ? state.background : 'studio',
  };
}

/** The graph as it is written out: the live graph, with the environment on it. */
export function withEnvironment<G extends SceneGraph>(graph: G, state: SceneEnvironment): G {
  return { ...graph, environment: readEnvironment(state) };
}

/**
 * The environment a saved scene asks for: what it says, and the defaults for
 * whatever it does not. A field that is not a finite number (or a known
 * background id) is ignored rather than handed to the MJCF writer or viewport.
 */
export function environmentOf(saved: Partial<SceneEnvironment> | null | undefined): SceneEnvironment {
  const env: SceneEnvironment = { ...DEFAULT_ENVIRONMENT };
  for (const k of NUMERIC_KEYS) {
    const v = saved?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) env[k] = v;
  }
  if (isBackgroundId(saved?.background)) {
    env.background = saved.background;
  }
  return env;
}

/** Splits a loaded graph into the graph the store keeps and the environment it asked for, if any. */
export function takeEnvironment<G extends SceneGraph>(graph: G): { graph: G; environment: SceneEnvironment | null } {
  if (!('environment' in graph)) return { graph, environment: null };
  const { environment, ...rest } = graph;
  return { graph: rest as G, environment: environment ? environmentOf(environment) : null };
}
