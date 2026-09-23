// One analysis per scene, however many views of it are open.
//
// The DFM panel, the heatmap drawn on the parts and the weak-spot markers all
// analyse the same scene graph, and each did so for itself: with the lens open,
// one tick of a slider ran analyseDfm twice and the structural checks twice,
// synchronously on the main thread. Every edit makes a new graph object and a
// graph object is never edited in place, so its identity is a sound key — the
// same one each view already memoised on.

import type { SceneGraph } from '../types/scene';
import { analyseDfm, type DfmBench, type DfmLimits, type DfmProcess, type DfmReport } from './dfm';
import { analyzeSceneMechanicalWeaknesses } from './printAnalysis';

const dfmReports = new WeakMap<SceneGraph, Map<string, DfmReport>>();

export function analyseDfmShared(
  scene: SceneGraph,
  process: DfmProcess,
  bench: Partial<DfmBench & DfmLimits> = {},
): DfmReport {
  let byArgs = dfmReports.get(scene);
  if (!byArgs) {
    byArgs = new Map();
    dfmReports.set(scene, byArgs);
  }
  const key = JSON.stringify([process, bench]);
  let report = byArgs.get(key);
  if (!report) {
    report = analyseDfm(scene, process, bench);
    byArgs.set(key, report);
  }
  return report;
}

const weaknessReports = new WeakMap<SceneGraph, ReturnType<typeof analyzeSceneMechanicalWeaknesses>>();

export function analyzeWeaknessesShared(scene: SceneGraph): ReturnType<typeof analyzeSceneMechanicalWeaknesses> {
  let result = weaknessReports.get(scene);
  if (!result) {
    result = analyzeSceneMechanicalWeaknesses(scene);
    weaknessReports.set(scene, result);
  }
  return result;
}
