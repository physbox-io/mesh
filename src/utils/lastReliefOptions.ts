// ---------------------------------------------------------------------------
// The relief carve as the dialog last planned it
// ---------------------------------------------------------------------------
//
// The relief dialog keeps its options in component state: the stock, the fit,
// the cutters, any feed the operator typed over. An agent asked to export or
// look into a relief carve has to start from that same plan, or it is studying
// a different job from the one at the machine. The dialog writes its settled
// options here each time it plans; the MCP export reads them back.
//
// A module variable rather than the store: nothing renders from it, and it
// has no business in the undo history or a saved scene.

import type { ReliefCarveOptions } from './reliefCarveExporter';

/** Not part of the plan: the machine's own figures, which the reader fills in afresh. */
type Planned = Omit<ReliefCarveOptions, 'motionProfile' | 'meshLevelGrid'>;

let last: Planned | null = null;

export function rememberReliefOptions(options: ReliefCarveOptions): void {
  const { motionProfile: _motion, meshLevelGrid: _grid, ...planned } = options;
  void _motion;
  void _grid;
  last = planned;
}

/** The options the relief dialog last planned with, or null when it has not this session. */
export function lastReliefOptions(): Planned | null {
  return last ? { ...last } : null;
}
