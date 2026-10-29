// Add Simulation one step at a time, for the Solid Machining dialog.
//
// Which step comes next is read from the scene (the step bodies already there
// for this plan), so closing and reopening the dialog carries on where it
// stopped, deleting a step adds it again, and a re-plan starts over.

import { useCallback, useMemo, useState } from 'react';
import { addSimulationToScene, useAddSimulation } from './useAddSimulation';
import { useStore } from '../store/useStore';
import { nextStep, solidPlanKey, solidStepRequest, stepTitle } from '../utils/solidSimulationSteps';
import type { SolidMachiningResult } from '../utils/solidMachiningExporter';

export function useSimulationSteps(
  result: SolidMachiningResult | null | undefined,
  tooling: Parameters<typeof solidStepRequest>[1]
) {
  const { add, progress, error } = useAddSimulation();
  const setups = useMemo(() => (result?.success ? result.setups ?? [] : []), [result]);
  // Hashes every program, so only when the plan changes.
  const planKey = useMemo(() => solidPlanKey(setups), [setups]);
  const nodes = useStore((s) => s.sceneGraph.nodes);
  const next = useMemo(() => nextStep(nodes, planKey), [nodes, planKey]);
  /** The step being worked on while a run of them is added. */
  const [adding, setAdding] = useState<number | null>(null);

  /** Adds every step from the next one up to `last` (0 is the stock, k after setup k). */
  const addUpTo = useCallback(async (last: number) => {
    if (!result?.success || adding !== null) return;
    try {
      for (let k = nextStep(useStore.getState().sceneGraph.nodes, planKey); k <= last; k++) {
        setAdding(k);
        // Only the last is selected, so the view ends on it.
        const done = await add({ ...solidStepRequest(result, tooling, k, planKey), select: k === last });
        if (!done) return;
      }
    } finally {
      setAdding(null);
    }
  }, [result, tooling, planKey, add, adding]);

  return {
    /** Steps there are: the stock and one per setup. */
    total: setups.length + 1,
    next,
    nextTitle: next <= setups.length ? stepTitle(setups, next) : null,
    addUpTo,
    adding,
    progress,
    error,
  };
}

/**
 * The MCP's `stage`: one step (0 the stock, k after setup k), or "all" for
 * every step not yet in the scene. Answers with what each step left.
 */
export async function addMcpSimulationSteps(
  result: SolidMachiningResult,
  tooling: Parameters<typeof solidStepRequest>[1],
  stage: unknown
) {
  // Through the request, which turns a plan asked for by sides into setups.
  const first = solidStepRequest(result, tooling, 0);
  const of = first.step!.of;
  const planKey = first.step!.planKey;
  let wanted: number[];
  if (stage === 'all') {
    wanted = [];
    for (let k = nextStep(useStore.getState().sceneGraph.nodes, planKey); k < of; k++) wanted.push(k);
    if (!wanted.length) return { ok: true, steps: [], note: 'Every step of this plan is in the scene already.' };
  } else if (typeof stage === 'number' && Number.isInteger(stage) && stage >= 0 && stage < of) {
    wanted = [stage];
  } else {
    return { ok: false, error: `stage is 0 (the stock) to ${of - 1} (after the last setup), or "all".` };
  }
  const steps = [];
  for (const k of wanted) {
    const req = solidStepRequest(result, tooling, k, planKey);
    const added = await addSimulationToScene({ ...req, select: k === wanted[wanted.length - 1] });
    const m = added.milled!;
    steps.push({
      stage: k,
      title: req.step!.title,
      id: added.id,
      name: added.name,
      volumeMm3: Math.round(m.volumeMm3),
      removedMm3: Math.round(m.stockVolumeMm3 - m.volumeMm3),
      rapidMovesThatCut: m.rapidCuts,
      deepestRapidCutMm: +m.deepestRapidMm.toFixed(3),
    });
  }
  return { ok: true, kind: 'machining', placement: 'beside', stages: of, planKey, steps, warnings: result.warnings ?? [] };
}
