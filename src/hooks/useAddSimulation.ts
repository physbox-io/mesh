// Add Simulation, from a modal or from the MCP bridge.
//
// The cut runs on its own export worker, started for the job and stopped after
// it, so a simulation never queues behind the dialog's next re-plan and the
// dialog's own worker is not held up by it. The body then goes into the scene
// as one undo step, with a note card saying what it is.

import { useCallback, useState } from 'react';
import { ExportWorkerClient } from '../utils/exportWorkerClient';
import {
  simulatedBody,
  type SimulationJobOptions,
  type SimulationJobResult,
  type SimulationPlacement,
} from '../utils/simulatedPart';
import type { StockTransform } from '../utils/reliefCarveExporter';
import type { SceneNode } from '../types/scene';
import { useStore } from '../store/useStore';
import { physicsGlobals } from '../physicsGlobals';
import { withUniqueNames } from '../utils/uniqueNames';

export interface AddSimulationRequest {
  job: SimulationJobOptions;
  transform: StockTransform;
  kind: NonNullable<SceneNode['simulation']>['kind'];
  /** What the program is, for the body's name: "Relief carve". */
  label: string;
  placement: SimulationPlacement;
  /** Lines for the note card: tools, run time. */
  details?: string[];
}

export interface AddedSimulation {
  id: string;
  name: string;
  result: SimulationJobResult;
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const cm3 = (mm3: number) => `${(mm3 / 1000).toFixed(mm3 < 10_000 ? 1 : 0)} cm³`;

export async function addSimulationToScene(
  req: AddSimulationRequest,
  onProgress?: (fraction: number) => void
): Promise<AddedSimulation> {
  const client = new ExportWorkerClient();
  let result: SimulationJobResult;
  try {
    result = await client.run('simulate', { nodes: [] }, req.job, onProgress);
  } finally {
    client.dispose();
  }

  const store = useStore.getState();
  const now = new Date();
  const id = `sim_${Math.random().toString(36).substring(2, 10)}`;
  const node = simulatedBody(
    result,
    { widthMm: req.job.widthMm, depthMm: req.job.depthMm, thicknessMm: req.job.thicknessMm },
    req.transform,
    {
      id,
      name: `Simulated: ${req.label} ${stamp(now)}`,
      kind: req.kind,
      placement: req.placement,
      existing: store.sceneGraph.nodes.filter((n) => n.simulation),
      createdAt: now.toISOString(),
    }
  );
  // Named here as the store would rename it on the way in, so the card and
  // the caller have the name it ends up with.
  const named = withUniqueNames({ ...store.sceneGraph, nodes: [...store.sceneGraph.nodes, node] });
  const name = named.nodes[named.nodes.length - 1].name;
  store.addHardwareComponentNode({ ...node, name });

  const lines = [
    `# ${name}`,
    '',
    `What the ${req.label.toLowerCase()} program leaves, cut back out of a ` +
      `${req.job.widthMm} × ${req.job.depthMm} × ${req.job.thicknessMm} mm block` +
      (req.placement === 'overlay' ? ', laid over the model.' : ', at full size beside the model.'),
    '',
    ...(req.details ?? []).map((d) => `- ${d}`),
    `- Removes ${cm3(result.stockVolumeMm3 - result.volumeMm3)} of ${cm3(result.stockVolumeMm3)}`,
    `- Simulated on a ${result.cellMm.toFixed(2)} mm grid, drawn to within ${result.toleranceMm.toFixed(3)} mm`,
    ...(result.rapidCuts > 0
      ? [`- **${result.rapidCuts} rapid move${result.rapidCuts === 1 ? '' : 's'} cut material**, up to ${result.deepestRapidMm.toFixed(2)} mm deep`]
      : []),
  ];
  const cards = physicsGlobals._physics_getNoteCards?.() ?? [];
  physicsGlobals._physics_setNoteCards?.([
    ...cards,
    { id: `note_card_${id}`, markdown: lines.join('\n'), minimized: true, x: 16 + 24 * cards.length, y: 16 + 24 * cards.length },
  ]);

  return { id, name, result };
}

/** `addSimulationToScene` with the progress, the last body added and any failure, for a dialog to show. */
export function useAddSimulation() {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const add = useCallback(async (req: AddSimulationRequest) => {
    setError(null);
    setAdded(null);
    setProgress(0);
    try {
      const done = await addSimulationToScene(req, setProgress);
      setAdded(done.name);
      return done;
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      return null;
    } finally {
      setProgress(null);
    }
  }, []);
  return { add, progress, error, added };
}
