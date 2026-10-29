// ---------------------------------------------------------------------------
// Add Simulation, one step of a solid job at a time
// ---------------------------------------------------------------------------
//
// Step 0 is the block as it goes on the machine (only the registration pins
// bored); step k is the block after setups 1 to k, stood as it stands on the
// bed for setup k. Each is its own body, added in order, so the job can be
// watched from stock to part, turn by turn. The dialog and the MCP bridge
// both build their steps here.

import { faceUpLabel } from './orient';
import { reliefSimulationTools } from './simulatedPart';
import { sidesAsSetups, simulationSetups, type SolidSetupResult } from './solidSetups';
import type { SolidMachiningResult } from './solidMachiningExporter';
import type { AddSimulationRequest } from '../hooks/useAddSimulation';
import type { SceneNode } from '../types/scene';

/** Which plan a step belongs to: its programs, hashed, so a re-plan is a new key. */
export function solidPlanKey(setups: Pick<SolidSetupResult, 'gcode'>[]): string {
  // FNV-1a over every program.
  let h = 0x811c9dc5;
  for (const s of setups) {
    for (let i = 0; i < s.gcode.length; i++) {
      h ^= s.gcode.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** What a step is called: "Stock" or "Setup 2, front up". */
export function stepTitle(setups: Pick<SolidSetupResult, 'upFace'>[], stage: number): string {
  if (stage <= 0) return 'Stock';
  return `Setup ${stage}, ${faceUpLabel(setups[stage - 1].upFace).toLowerCase()}`;
}

/** The next step to add for this plan, from the steps already in the scene; `setups.length + 1` when all are. */
export function nextStep(nodes: SceneNode[], planKey: string): number {
  let next = 0;
  for (const n of nodes) {
    const s = n.simulation;
    if (s?.planKey === planKey && s.stage !== undefined) next = Math.max(next, s.stage + 1);
  }
  return next;
}

/** The request that adds one step of a planned solid job. */
export function solidStepRequest(
  result: SolidMachiningResult,
  tooling: Parameters<typeof reliefSimulationTools>[0],
  stage: number,
  planKey?: string
): AddSimulationRequest {
  // A plan asked for by `sides` alone comes without setups; its sides are two.
  if (!result.setups) result = sidesAsSetups(result, tooling);
  const setups = result.setups ?? [];
  planKey ??= solidPlanKey(setups);
  if (!result.success || !result.stockTransform || setups.length === 0) throw new Error('There is no plan to simulate.');
  const k = Math.max(0, Math.min(setups.length, Math.floor(stage)));
  // Step 0 stands as the block goes on for setup 1, which may be on an end.
  const machineFrame = setups[Math.max(0, k - 1)].rotation;
  const details: string[] = [];
  if (k === 0 && setups[0].gcode.includes('Datum notch')) {
    details.push('The datum notch the turned setups are zeroed on is cut in setup 1');
  }
  if (k > 0) {
    const s = setups[k - 1];
    details.push(...s.instructions);
    details.push(`About ${Math.round(s.estimatedTimeSeconds / 60)} min on the machine`);
  }
  return {
    job: {
      gcode: setups[0].gcode,
      setups: simulationSetups(result),
      stage: k,
      widthMm: result.stock.widthMm,
      depthMm: result.stock.depthMm,
      thicknessMm: result.stock.thicknessMm,
      ...reliefSimulationTools(tooling),
    },
    transform: result.stockTransform,
    kind: 'machining',
    label: 'Solid part',
    placement: 'beside',
    details,
    step: { index: k, of: setups.length + 1, planKey, machineFrame, title: stepTitle(setups, k) },
  };
}
