/**
 * Shared unit-conversion helpers for the MCP protocol boundary.
 *
 * Internally, Three.js and MuJoCo store all lengths and positions in SI metres.
 * At the MCP boundary (v1.0.0+), all spatial inputs and camera/position outputs
 * use millimetres (mm) consistently across every tool.
 */

/** Convert a scalar length from millimetres to internal SI metres. */
export const mmToM = (mm: number): number => mm / 1000;

/** Convert an internal SI metre scalar to millimetres (rounded to 1 µm). */
export const mToMm = (m: number): number => Math.round(m * 1e6) / 1e3;

/** Convert a numeric coordinate tuple/array from millimetres to internal SI metres. */
export const vecMmToM = <T extends readonly number[]>(v: T): number[] =>
  v.map((x) => x / 1000);

/** Convert a numeric coordinate tuple/array from internal SI metres to millimetres. */
export const vecMToMm = <T extends readonly number[]>(v: T): number[] =>
  v.map(mToMm);
