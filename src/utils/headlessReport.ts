/**
 * Turning a headless run's raw result into what physics_run_headless replies.
 *
 * The trajectory is keyed by body id, and the `bodies` filter used to be
 * matched against those keys only: a body asked for by its name ("output" for
 * id "gear_a4"), or by a typo, matched nothing and every frame came back with
 * `bodies: {}`. Worse, `final` was then judged from those empty frames, so a
 * gear train still spinning at 25 rad/s came back `settled: true`. Here the
 * filter takes names or ids, says which entries matched nothing, and `final`
 * is judged on every body and joint before anything is filtered out.
 */
import type { SceneGraph, SceneNode } from '../types/scene';
import type { HistoryEntry } from '../workers/physicsWorkerProtocol';
import { summarizeTrajectory, type TrajectorySummary } from './trajectorySummary';

export interface BodyFilter {
  /** Body ids to keep, or null to keep them all. */
  ids: Set<string> | null;
  /** Requested entries that are neither a body's id nor its name. */
  unknown: string[];
}

const walk = (nodes: SceneNode[] | undefined, fn: (n: SceneNode) => void) => {
  for (const n of nodes || []) { fn(n); walk(n.children, fn); }
};

/** Match each requested entry against body ids first, then names. */
export function resolveBodyFilter(graph: SceneGraph, requested: unknown): BodyFilter {
  if (!Array.isArray(requested) || requested.length === 0) return { ids: null, unknown: [] };
  const byId = new Set<string>();
  const byName = new Map<string, string[]>();
  walk(graph.nodes, (n) => {
    byId.add(n.id);
    byName.set(n.name, [...(byName.get(n.name) ?? []), n.id]);
  });
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const raw of requested) {
    const key = String(raw);
    if (byId.has(key)) ids.add(key);
    else if (byName.has(key)) byName.get(key)!.forEach((id) => ids.add(id));
    else unknown.push(key);
  }
  return { ids, unknown };
}

/** Joint types by joint name, so a slide's speed is judged in m/s and a hinge's in rad/s. */
export function jointTypes(graph: SceneGraph): Record<string, string> {
  const out: Record<string, string> = {};
  walk(graph.nodes, (n) => n.joints?.forEach((j) => { out[j.name] = j.type; }));
  return out;
}

/** Bodies in the scene, at any depth. */
export function countSceneBodies(graph: SceneGraph): number {
  let n = 0;
  walk(graph.nodes, () => { n++; });
  return n;
}

/** The refusal for a run of a scene with nothing in it, or null when there is something. */
export function emptySceneRefusal(graph: SceneGraph) {
  if (countSceneBodies(graph) > 0) return null;
  return {
    ok: false as const,
    error: 'The scene is empty: there is nothing to simulate, so a run could not settle or fail. Build a scene first (physics_build_scene or physics_load_preset).',
    warnings: [] as string[],
  };
}

interface RawResult {
  ok: boolean;
  trajectory?: HistoryEntry[];
  warnings?: string[];
  [k: string]: unknown;
}

export type HeadlessReply<R> = R & {
  warnings: string[];
  trajectory?: HistoryEntry[];
  final?: TrajectorySummary | null;
};

/**
 * The reply: `final` from the whole run, then the trajectory and `final.bodies`
 * cut down to the bodies asked for, with a warning for any that matched nothing.
 */
export function reportHeadless<R extends RawResult>(result: R, graph: SceneGraph, requestedBodies: unknown): HeadlessReply<R> {
  const filter = resolveBodyFilter(graph, requestedBodies);
  const rest = result;
  const warnings = [...(rest.warnings ?? [])];
  if (filter.unknown.length) {
    const names: string[] = [];
    walk(graph.nodes, (n) => names.push(n.name === n.id ? n.id : `${n.name} (${n.id})`));
    warnings.push(
      `bodies: no body has the name or id ${filter.unknown.map((u) => `"${u}"`).join(', ')}, so ${filter.unknown.length === 1 ? 'it was' : 'they were'} left out. The scene's bodies are ${names.join(', ')}.`,
    );
  }
  if (!rest.ok || !rest.trajectory) return { ...rest, warnings };

  const summary = summarizeTrajectory(rest.trajectory, { jointTypes: jointTypes(graph) });
  const final = summary;
  if (summary) {
    // A body's id says nothing to whoever named it; give the name alongside.
    const nameOf = new Map<string, string>();
    walk(graph.nodes, (n) => nameOf.set(n.id, n.name));
    for (const [id, b] of Object.entries(summary.bodies)) {
      const name = nameOf.get(id);
      if (name && name !== id) b.name = name;
    }
    if (filter.ids) {
      summary.bodies = Object.fromEntries(Object.entries(summary.bodies).filter(([id]) => filter.ids!.has(id)));
    }
  }
  const trajectory = filter.ids
    ? rest.trajectory.map((fr) => ({
        ...fr,
        bodies: Object.fromEntries(Object.entries(fr.bodies || {}).filter(([k]) => filter.ids!.has(k))),
      }))
    : rest.trajectory;
  return { ...rest, trajectory, warnings, final };
}
