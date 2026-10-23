// ---------------------------------------------------------------------------
// The heavy exports, in one place a worker can run them from
// ---------------------------------------------------------------------------
//
// Planning a router job — a relief carved into a board, or a part cut out of a
// block — is the heaviest thing this app computes: it samples the model onto a
// grid and machines the surface, roughing, tool change and finishing, and the
// solid version does that twice. Run on the main thread it freezes the tab hard
// enough that the browser offers to kill the page.
//
// So each of these runs on a worker (see `exportWorker.ts` and its client). This
// module is the registry both ends share: one function that dispatches a job by
// name, used inside the worker and as the inline fallback where there is no
// Worker at all. A new heavy export is added here and becomes a worker job for
// free — no second worker, no second client.

import type { SceneGraph } from '../types/scene';
import {
  generateReliefCarveGcode,
  type ReliefCarveOptions,
  type ReliefCarveResult,
} from './reliefCarveExporter';
import {
  generateSolidMachining,
  type SolidMachiningOptions,
  type SolidMachiningResult,
} from './solidMachiningExporter';
import {
  exportLaserCutSvg,
  type LaserCutOptions,
  type LaserCutResult,
} from './laserCutExporter';
import {
  exportContourSliceSvg,
  type ContourSliceOptions,
  type ContourSliceResult,
} from './contourSliceExporter';
import {
  generateCastPattern,
  type CastOptions,
  type CastResult,
} from './castPatternExporter';
import {
  runSimulationJob,
  type SimulationJobOptions,
  type SimulationJobResult,
} from './simulatedPart';
import { runSheetJob, type SheetJobOptions, type SheetJobResult } from './sheetSimulation';
import {
  generateContourSliceGcode,
  type GcodeExportOptions,
  type GcodeExportResult,
} from './gcodeExporter';
import { warpGcode, type ProbeGrid } from './meshLeveler';
import { loadManifold } from './sculptCut';
import {
  decomposeSolidIntoPlanks,
  type TimberPlankBreakdownOutcome,
  type TimberPlankOptions,
} from './timberBreakdown';
import {
  synthesizeTimberJoinery,
  type TimberBreakdownOutcome,
  type TimberJoineryOptions,
} from './timberJoinery';
import { buildTimberCutPlan, type TimberCutPlan } from './timberCutList';

export interface ContourGcodeJobOptions {
  sliceResult: ContourSliceResult;
  gcodeOptions: GcodeExportOptions;
  probedGrid?: ProbeGrid | null;
}

export interface TimberJobOptions {
  mode?: 'frame' | 'planks';
  soups: Float64Array[];
  joineryOptions?: TimberJoineryOptions;
  plankOptions?: TimberPlankOptions;
  cncBedMm: [number, number, number];
  defaultStockLengthMm: number;
}

export interface TimberJobResult {
  outcome: TimberBreakdownOutcome;
  cutPlan: TimberCutPlan | null;
  plankOutcome: TimberPlankBreakdownOutcome | null;
}

/** Which export a job runs. Add a case here and in `runExportJob`. */
export type ExportJobKind =
  | 'relief'
  | 'solid'
  | 'cast'
  | 'laser'
  | 'contour'
  | 'contourGcode'
  | 'simulate'
  | 'simulateSheets'
  | 'timber';

/** The options and result each job takes and returns. */
export interface ExportJobMap {
  relief: { options: ReliefCarveOptions; result: ReliefCarveResult };
  solid: { options: SolidMachiningOptions; result: SolidMachiningResult };
  cast: { options: CastOptions; result: CastResult };
  laser: { options: LaserCutOptions; result: LaserCutResult };
  contour: { options: ContourSliceOptions; result: ContourSliceResult };
  contourGcode: { options: ContourGcodeJobOptions; result: GcodeExportResult };
  /** Add Simulation: cuts a program out of a block. Takes the program, not the scene. */
  simulate: { options: SimulationJobOptions; result: SimulationJobResult };
  /** The same for sheet parts: outlines extruded at the stock's thickness. */
  simulateSheets: { options: SheetJobOptions; result: SheetJobResult };
  /** Timber joinery synthesis (Manifold 3D CSG) and CNC/bandsaw cut-list planning. */
  timber: { options: TimberJobOptions; result: TimberJobResult };
}

export type ExportJobOptions<K extends ExportJobKind> = Partial<ExportJobMap[K]['options']>;
export type ExportJobResult<K extends ExportJobKind> = ExportJobMap[K]['result'];

/**
 * Runs one export job, by name. The only place that knows every job's exporter.
 * `onProgress`, from 0 to 1, is called by the jobs long enough to need it.
 */
export function runExportJob(
  kind: 'timber',
  scene: SceneGraph,
  options: ExportJobOptions<'timber'>,
  onProgress?: (fraction: number) => void
): Promise<ExportJobResult<'timber'>>;
export function runExportJob<K extends Exclude<ExportJobKind, 'timber'>>(
  kind: K,
  scene: SceneGraph,
  options: ExportJobOptions<K>,
  onProgress?: (fraction: number) => void
): ExportJobResult<K>;
export function runExportJob<K extends ExportJobKind>(
  kind: K,
  scene: SceneGraph,
  options: ExportJobOptions<K>,
  onProgress?: (fraction: number) => void
): ExportJobResult<K> | Promise<ExportJobResult<K>>;
export function runExportJob<K extends ExportJobKind>(
  kind: K,
  scene: SceneGraph,
  options: ExportJobOptions<K>,
  onProgress?: (fraction: number) => void
): ExportJobResult<K> | Promise<ExportJobResult<K>> {
  switch (kind) {
    case 'relief':
      return generateReliefCarveGcode(scene, options as ExportJobOptions<'relief'>) as ExportJobResult<K>;
    case 'solid':
      return generateSolidMachining(scene, options as ExportJobOptions<'solid'>) as ExportJobResult<K>;
    case 'cast':
      return generateCastPattern(scene, options as ExportJobOptions<'cast'>) as ExportJobResult<K>;
    case 'laser':
      return exportLaserCutSvg(scene, options as ExportJobOptions<'laser'>) as ExportJobResult<K>;
    case 'contour':
      return exportContourSliceSvg(scene, options as ExportJobOptions<'contour'>) as ExportJobResult<K>;
    case 'contourGcode': {
      const { sliceResult, gcodeOptions, probedGrid } = options as ContourGcodeJobOptions;
      const res = generateContourSliceGcode(sliceResult, gcodeOptions);
      if (res.success && gcodeOptions.machineMode === 'cnc' && probedGrid) {
        res.gcode = warpGcode(res.gcode, probedGrid);
      }
      return res as ExportJobResult<K>;
    }
    case 'simulate':
      return runSimulationJob(options as SimulationJobOptions, onProgress) as ExportJobResult<K>;
    case 'simulateSheets':
      return runSheetJob(options as SheetJobOptions, onProgress) as ExportJobResult<K>;
    case 'timber': {
      const {
        mode,
        soups = [],
        joineryOptions = {},
        plankOptions = {},
        cncBedMm = [300, 300, 80],
        defaultStockLengthMm = 1800,
      } = options as TimberJobOptions;
      return loadManifold().then((wasm) => {
        const outcome: TimberBreakdownOutcome =
          mode === 'planks'
            ? { ok: false, error: 'Plank mode active' }
            : synthesizeTimberJoinery(wasm, soups, joineryOptions);
        const cutPlan =
          outcome.ok && mode !== 'planks'
            ? buildTimberCutPlan(outcome, { cncBedMm, defaultStockLengthMm })
            : null;
        const hasFrameRails =
          outcome.ok &&
          outcome.parts.length > 1 &&
          outcome.parts.some((p) => p.member.role === 'rail');
        const plankOutcome: TimberPlankBreakdownOutcome | null =
          mode === 'planks' || (!hasFrameRails && mode !== 'frame')
            ? decomposeSolidIntoPlanks(wasm, soups, plankOptions)
            : null;
        return { outcome, cutPlan, plankOutcome } as ExportJobResult<K>;
      });
    }
    default: {
      // Exhaustive: a new kind that forgets its case is a compile error here.
      const never: never = kind;
      throw new Error(`Unknown export job: ${String(never)}`);
    }
  }
}
