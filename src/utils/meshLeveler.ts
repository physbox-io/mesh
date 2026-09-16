/**
 * Auto grid mesh levelling.
 *
 * Now `@physbox-io/machining`, shared with Etch and Volt — all three had their
 * own copy of the same bilinear interpolation and G-code warper, and Volt's had
 * grown several things this one never got. Re-exported under the old path so
 * the modules that use it keep their imports.
 *
 * The shared warper carries words it does not interpret (`S`, `M`, `T`) through
 * a split move instead of dropping them, which this copy did not. That matters
 * here: a laser program puts its power on the motion line.
 */
export {
  createEmptyGrid,
  findUnwarpableCommands,
  getGridStats,
  gridFromPoints,
  gridOffPlaneMm,
  interpolateGridZ,
  normalizeGrid,
  suggestProbeGrid,
  warpGcode,
  type GridStats,
  type ProbeGrid,
  type ProbePoint,
  type WarpOptions,
} from '@physbox-io/machining';
