import type { PreviewMove } from './toolpathPreviewPath';

/**
 * A depth ramp: where the tool is on the surface, and where it is at the floor.
 *
 * Sampled from viridis, which is perceptually uniform — equal steps in depth
 * look like equal steps in colour — and keeps its ordering when read by a
 * colourblind eye or printed in grey. That matters more here than prettiness:
 * the whole reason to colour a relief by depth is to be able to see, at a
 * glance, that the tool goes deepest where the model is highest, and a ramp
 * with a bright band in the middle of it invents a feature that is not there.
 */
export const DEPTH_RAMP: readonly [number, number, number][] = [
  [0.267, 0.005, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318],
  [0.741, 0.873, 0.150],
  [0.993, 0.906, 0.144],
];

/** Precomputed CSS linear-gradient string for the depth ramp legend. */
export const DEPTH_RAMP_GRADIENT = `linear-gradient(to left, ${DEPTH_RAMP.map(
  ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`,
).join(',')})`;

// Linear RGB equivalents of THREE.Color(0xf59e0b), 0x3b82f6, 0x475569 (sRGB -> linear).
function srgbChannelToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
function hexToLinearRgb(hex: number): [number, number, number] {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}

const ROUGH_RGB = hexToLinearRgb(0xf59e0b);
const FINISH_RGB = hexToLinearRgb(0x3b82f6);
const TRAVEL_RGB = hexToLinearRgb(0x475569);

/**
 * The deepest cutting move in the path — the far end of the depth ramp.
 * Rapids are excluded so retract heights above the stock do not wash out the scale.
 */
export function computeDeepestCutZ(moves: readonly PreviewMove[]): number {
  let z = 0;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m.rapid) continue;
    if (m.z1 < z) z = m.z1;
    if (m.z2 < z) z = m.z2;
  }
  return z;
}

/**
 * Fill line-segment vertex positions (`x1,y1,z1, x2,y2,z2` per move) directly
 * into a Float32Array with zero per-move allocations.
 */
export function fillToolpathPositions(
  moves: readonly PreviewMove[],
  target?: Float32Array,
): Float32Array {
  const needed = moves.length * 6;
  const positions = target && target.length === needed ? target : new Float32Array(needed);
  for (let i = 0, o = 0; i < moves.length; i++, o += 6) {
    const m = moves[i];
    positions[o] = m.x1;
    positions[o + 1] = m.y1;
    positions[o + 2] = m.z1;
    positions[o + 3] = m.x2;
    positions[o + 4] = m.y2;
    positions[o + 5] = m.z2;
  }
  return positions;
}

/**
 * Fill line-segment vertex colours directly into a Float32Array with zero
 * per-move array or `THREE.Color` allocations. Can refill an existing buffer
 * in place when toggling between `'depth'` and `'operation'` modes.
 */
export function fillToolpathColours(
  moves: readonly PreviewMove[],
  colourMode: 'depth' | 'operation',
  deepest: number,
  target?: Float32Array,
): Float32Array {
  const needed = moves.length * 6;
  const colours = target && target.length === needed ? target : new Float32Array(needed);
  const tr = TRAVEL_RGB[0], tg = TRAVEL_RGB[1], tb = TRAVEL_RGB[2];

  if (colourMode === 'operation') {
    const rr = ROUGH_RGB[0], rg = ROUGH_RGB[1], rb = ROUGH_RGB[2];
    const fr = FINISH_RGB[0], fg = FINISH_RGB[1], fb = FINISH_RGB[2];
    for (let i = 0, o = 0; i < moves.length; i++, o += 6) {
      const m = moves[i];
      if (m.rapid) {
        colours[o] = tr; colours[o + 1] = tg; colours[o + 2] = tb;
        colours[o + 3] = tr; colours[o + 4] = tg; colours[o + 5] = tb;
      } else if (m.pass === 'roughing') {
        colours[o] = rr; colours[o + 1] = rg; colours[o + 2] = rb;
        colours[o + 3] = rr; colours[o + 4] = rg; colours[o + 5] = rb;
      } else {
        colours[o] = fr; colours[o + 1] = fg; colours[o + 2] = fb;
        colours[o + 3] = fr; colours[o + 4] = fg; colours[o + 5] = fb;
      }
    }
    return colours;
  }

  const span = Math.abs(deepest);
  const invSpan = span > 1e-6 ? 1 / span : 0;
  const maxIdx = DEPTH_RAMP.length - 2;
  const rampScale = DEPTH_RAMP.length - 1;

  for (let i = 0, o = 0; i < moves.length; i++, o += 6) {
    const m = moves[i];
    if (m.rapid) {
      colours[o] = tr; colours[o + 1] = tg; colours[o + 2] = tb;
      colours[o + 3] = tr; colours[o + 4] = tg; colours[o + 5] = tb;
      continue;
    }
    // Endpoint 1 — clamp cuts above Z=0 (e.g. plunge start) to the surface end
    // of the ramp rather than reflecting positive Z through Math.abs.
    let t = invSpan > 0 ? 1 - Math.max(0, -m.z1) * invSpan : 1;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    let pos = t * rampScale;
    let idx = Math.floor(pos);
    if (idx > maxIdx) idx = maxIdx;
    let f = pos - idx;
    let a = DEPTH_RAMP[idx];
    let b = DEPTH_RAMP[idx + 1];
    colours[o] = a[0] + (b[0] - a[0]) * f;
    colours[o + 1] = a[1] + (b[1] - a[1]) * f;
    colours[o + 2] = a[2] + (b[2] - a[2]) * f;

    // Endpoint 2
    t = invSpan > 0 ? 1 - Math.max(0, -m.z2) * invSpan : 1;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    pos = t * rampScale;
    idx = Math.floor(pos);
    if (idx > maxIdx) idx = maxIdx;
    f = pos - idx;
    a = DEPTH_RAMP[idx];
    b = DEPTH_RAMP[idx + 1];
    colours[o + 3] = a[0] + (b[0] - a[0]) * f;
    colours[o + 4] = a[1] + (b[1] - a[1]) * f;
    colours[o + 5] = a[2] + (b[2] - a[2]) * f;
  }
  return colours;
}
