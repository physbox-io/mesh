// Whether a bed probe grid still describes the work in front of the machine.
//
// A grid is heights at work positions, measured against the work zero in force
// and over the stock on the bed when it was taken. A re-zero of X, Y or Z moves
// every point of it, and a different stock is a different surface; applied
// after either, it warps the cut by the error instead of correcting it.

/** What a grid was measured against. */
export interface ProbedGridStamp {
  /** `MachineState.datumEpoch` when the grid finished. */
  datumEpoch: number;
  /** The stock it was measured over, as a comparable key. */
  stock: string;
}

export function probedGridStamp(datumEpoch: number, stock: unknown): ProbedGridStamp {
  return { datumEpoch, stock: JSON.stringify(stock ?? null) };
}

/** The grid, while what it was measured against still holds; otherwise null. */
export function gridStillHolds<G>(held: { grid: G; stamp: ProbedGridStamp } | null, now: ProbedGridStamp): G | null {
  if (!held) return null;
  return held.stamp.datumEpoch === now.datumEpoch && held.stamp.stock === now.stock ? held.grid : null;
}
