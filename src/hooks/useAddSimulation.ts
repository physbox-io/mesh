// Add Simulation, from a modal or from the MCP bridge.
//
// The cut runs on its own export worker, started for the job and stopped after
// it, so a simulation never queues behind the dialog's next re-plan and the
// dialog's own worker is not held up by it. The body then goes into the scene
// as one undo step, with a section on the scene's note card saying what it is.

import { useCallback, useState } from 'react';
import { ExportWorkerClient } from '../utils/exportWorkerClient';
import {
  simulatedBody,
  type SimulationJobOptions,
  type SimulationJobResult,
  type SimulationPlacement,
} from '../utils/simulatedPart';
import type { SheetJobOptions, SheetJobResult } from '../utils/sheetSimulation';
import type { IndexedMesh } from '../utils/stlMesh';
import { enclosedVolume } from '../utils/simulationMesh';
import { collectSceneTriangles } from '../utils/contourSliceExporter';
import type { StockTransform } from '../utils/reliefCarveExporter';
import type { SceneNode } from '../types/scene';
import { useStore } from '../store/useStore';
import { physicsGlobals } from '../physicsGlobals';
import { withUniqueNames } from '../utils/uniqueNames';

export interface AddSimulationRequest {
  /**
   * What to add, one of three: a milling program to cut out of a block, sheet
   * parts to extrude, or a mesh an exporter made already (mm, Z up).
   */
  job?: SimulationJobOptions;
  sheets?: SheetJobOptions;
  mesh?: IndexedMesh;
  transform: StockTransform;
  kind: NonNullable<SceneNode['simulation']>['kind'];
  /** What the program is, for the body's name: "Relief carve". */
  label: string;
  placement: SimulationPlacement;
  /** Lines for the note card: tools, run time. */
  details?: string[];
  /** The model's own volume at the size cut, to set against what `job.measureMask` measures. */
  modelVolumeMm3?: number;
}

export interface AddedSimulation {
  id: string;
  name: string;
  /** Volume of the part as simulated, mm³. */
  volumeMm3: number;
  /** A milling job's own figures; absent for sheet parts. */
  milled?: SimulationJobResult;
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
  let mesh: Pick<SimulationJobResult, 'positions' | 'faces' | 'cellMm' | 'toleranceMm' | 'volumeMm3'>;
  let milled: SimulationJobResult | undefined;
  let sheets: SheetJobResult | undefined;
  try {
    if (req.job) {
      milled = await client.run('simulate', { nodes: [] }, req.job, onProgress);
      mesh = milled;
    } else if (req.mesh) {
      mesh = { ...req.mesh, cellMm: 0, toleranceMm: 0, volumeMm3: enclosedVolume(req.mesh.positions, req.mesh.faces) };
    } else if (req.sheets) {
      sheets = await client.run('simulateSheets', { nodes: [] }, req.sheets, onProgress);
      mesh = { ...sheets, cellMm: 0, toleranceMm: 0 };
    } else {
      throw new Error('Nothing to simulate.');
    }
  } finally {
    client.dispose();
  }

  const store = useStore.getState();
  const now = new Date();
  const id = `sim_${Math.random().toString(36).substring(2, 10)}`;
  const node = simulatedBody(
    mesh,
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

  const where = req.placement === 'overlay' ? ', laid over the model.' : ', at full size beside the model.';
  const lines = [`## ${name}`, ''];
  if (milled && req.job) {
    lines.push(
      `What the ${req.label.toLowerCase()} program leaves, cut back out of a ` +
        `${+req.job.widthMm.toFixed(1)} × ${+req.job.depthMm.toFixed(1)} × ${+req.job.thicknessMm.toFixed(1)} mm block${where}`,
      '',
      ...(req.details ?? []).map((d) => `- ${d}`),
      `- Removes ${cm3(milled.stockVolumeMm3 - milled.volumeMm3)} of ${cm3(milled.stockVolumeMm3)}`,
      ...(milled.measuredVolumeMm3 !== undefined && req.modelVolumeMm3
        ? [`- The part itself: ${cm3(milled.measuredVolumeMm3)}, against ${cm3(req.modelVolumeMm3)} in the model, inside its outline`]
        : []),
      milled.drawnCellMm > milled.cellMm * 1.01
        ? `- Simulated on a ${milled.cellMm.toFixed(2)} mm grid, drawn on a ${milled.drawnCellMm.toFixed(2)} mm one: too much detail to draw finer`
        : `- Simulated on a ${milled.cellMm.toFixed(2)} mm grid, drawn to within ${milled.toleranceMm.toFixed(3)} mm`,
      ...(milled.rapidCuts > 0
        ? [`- **${milled.rapidCuts} rapid move${milled.rapidCuts === 1 ? '' : 's'} cut material**, up to ${milled.deepestRapidMm.toFixed(2)} mm deep`]
        : []),
    );
  } else if (req.mesh) {
    lines.push(
      `The ${req.label.toLowerCase()} as exported${where}`,
      '',
      ...(req.details ?? []).map((d) => `- ${d}`),
      `- ${cm3(mesh.volumeMm3)}`,
    );
  } else if (sheets && req.sheets) {
    const lost = sheets.drawnAreaMm2 - sheets.cutAreaMm2;
    lines.push(
      `The ${req.label.toLowerCase()} parts as they come off the machine, ${req.sheets.parts.length} of them${where}`,
      '',
      ...(req.details ?? []).map((d) => `- ${d}`),
      `- ${cm3(sheets.volumeMm3)} of material in the parts`,
      ...(req.sheets.routerRadiusMm
        ? [Math.abs(lost) > 0.5
          ? `- The ${(req.sheets.routerRadiusMm * 2).toFixed(2)} mm bit leaves ${Math.round(-lost)} mm² more than drawn, in inside corners and slots it cannot enter`
          : '- The bit reaches every corner as drawn']
        : []),
    );
  }
  // The scene has one note card; the body gets a section at the end of it.
  const [card, ...rest] = physicsGlobals._physics_getNoteCards?.() ?? [];
  const section = lines.join('\n');
  physicsGlobals._physics_setNoteCards?.(card
    ? [{ ...card, markdown: `${card.markdown.trimEnd()}\n\n${section}` }, ...rest]
    : [{ id: `note_card_${id}`, markdown: section, minimized: true, x: 16, y: 16 }]);

  return { id, name, volumeMm3: mesh.volumeMm3, milled };
}

/** `addSimulationToScene` with the progress and any failure, for a dialog to show. */
export function useAddSimulation() {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = useCallback(async (req: AddSimulationRequest) => {
    setError(null);
    setProgress(0);
    try {
      return await addSimulationToScene(req, setProgress);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
      return null;
    } finally {
      setProgress(null);
    }
  }, []);
  return { add, progress, error };
}

/**
 * Where the scene's own parts are, as a transform that changes nothing: for a
 * mesh an exporter made at the model's size, which is only ever put beside it.
 */
export function sceneStockTransform(): StockTransform {
  const tris = collectSceneTriangles(useStore.getState().sceneGraph).tris;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], tris[i] * 1000);
    hi[i % 3] = Math.max(hi[i % 3], tris[i] * 1000);
  }
  if (!tris.length) {
    lo.fill(0);
    hi.fill(0);
  }
  return {
    modelOriginMm: [0, 0, 0],
    workOriginMm: [0, 0, 0],
    scale: [1, 1, 1],
    modelMinMm: lo as [number, number, number],
    modelMaxMm: hi as [number, number, number],
  };
}
