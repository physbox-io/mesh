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
  generateCastPattern,
  type CastOptions,
  type CastResult,
} from './castPatternExporter';

/** Which export a job runs. Add a case here and in `runExportJob`. */
export type ExportJobKind = 'relief' | 'solid' | 'cast';

/** The options and result each job takes and returns. */
export interface ExportJobMap {
  relief: { options: ReliefCarveOptions; result: ReliefCarveResult };
  solid: { options: SolidMachiningOptions; result: SolidMachiningResult };
  cast: { options: CastOptions; result: CastResult };
}

export type ExportJobOptions<K extends ExportJobKind> = Partial<ExportJobMap[K]['options']>;
export type ExportJobResult<K extends ExportJobKind> = ExportJobMap[K]['result'];

/** Runs one export job, by name. The only place that knows every job's exporter. */
export function runExportJob<K extends ExportJobKind>(
  kind: K,
  scene: SceneGraph,
  options: ExportJobOptions<K>
): ExportJobResult<K> {
  switch (kind) {
    case 'relief':
      return generateReliefCarveGcode(scene, options as ExportJobOptions<'relief'>) as ExportJobResult<K>;
    case 'solid':
      return generateSolidMachining(scene, options as ExportJobOptions<'solid'>) as ExportJobResult<K>;
    case 'cast':
      return generateCastPattern(scene, options as ExportJobOptions<'cast'>) as ExportJobResult<K>;
    default: {
      // Exhaustive: a new kind that forgets its case is a compile error here.
      const never: never = kind;
      throw new Error(`Unknown export job: ${String(never)}`);
    }
  }
}
