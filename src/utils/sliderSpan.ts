/**
 * Bounds and step for a slider that must always be able to show its value.
 *
 * A slider covers the range people usually want, but a value can go past it:
 * typed into the number beside it, dragged with the gizmo, set by an agent. A
 * fixed-range slider then pins its handle to the end and the next nudge snaps
 * the value back inside. So the span stretches to take the value in, rounded
 * out to whole steps so the stops stay on round numbers.
 */
export function sliderSpan(value: number, lo: number, hi: number, step = 0.01): { min: number; max: number; step: number } {
  const v = Number.isFinite(value) ? value : lo;
  return {
    min: Math.min(lo, Math.floor(v / step + 1e-9) * step),
    max: Math.max(hi, Math.ceil(v / step - 1e-9) * step),
    step,
  };
}

/** Where a body or sub-geom sits: -4 m to 4 m in 10 mm steps. */
export const offsetSpan = (value: number) => sliderSpan(value, -4, 4);

/** A dimension: 10 mm to 4 m in 10 mm steps. */
export const lengthSpan = (value: number) => sliderSpan(value, 0.01, 4);
