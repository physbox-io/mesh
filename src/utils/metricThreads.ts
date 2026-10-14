// ---------------------------------------------------------------------------
// ISO metric coarse threads
//
// One table for every place a thread is chosen by its bolt size: the Thread
// menu on a cylinder or a hole, and the hardware parts, whose size menus run
// over the same names. Anything not here is typed as a pitch.
// ---------------------------------------------------------------------------

import type { SceneGeom } from '../types/scene';

/** A coarse thread by name: [name, major diameter mm, pitch mm]. */
export type MetricThread = readonly [name: string, diameterMm: number, pitchMm: number];

export const METRIC_THREADS: readonly MetricThread[] = [
  ['M2', 2, 0.4], ['M2.5', 2.5, 0.45], ['M3', 3, 0.5], ['M4', 4, 0.7], ['M5', 5, 0.8],
  ['M6', 6, 1], ['M8', 8, 1.25], ['M10', 10, 1.5], ['M12', 12, 1.75], ['M14', 14, 2],
  ['M16', 16, 2], ['M20', 20, 2.5], ['M24', 24, 3],
];

export function metricThread(name: string): MetricThread | undefined {
  return METRIC_THREADS.find(([n]) => n === name);
}

/**
 * The standard size a threaded cylinder is, or undefined when its diameter and
 * pitch match none — which is what a menu shows as "Custom".
 */
export function metricThreadOf(geom: SceneGeom): MetricThread | undefined {
  const pitch = geom.thread?.pitch;
  if (!pitch) return undefined;
  const diameterMm = (geom.size?.[0] ?? 0) * 2000;
  return METRIC_THREADS.find(([, d, p]) => Math.abs(d - diameterMm) < 1e-3 && Math.abs(p - pitch * 1000) < 1e-3);
}

/** The thread a menu offers for a cylinder of this diameter: the nearest standard size's pitch, as a start to type over. */
export function pitchForDiameterMm(diameterMm: number): number {
  let best = METRIC_THREADS[0];
  for (const t of METRIC_THREADS) if (Math.abs(t[1] - diameterMm) < Math.abs(best[1] - diameterMm)) best = t;
  return best[2];
}

/** A thread as the panel and the MCP bridge state it: millimetres, not the scene's metres. */
export interface GeomThreadSpec {
  pitchMm: number;
  left?: boolean;
  /** Diametral clearance: off a rod, onto a hole. */
  fitMm?: number;
}
