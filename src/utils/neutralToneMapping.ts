import * as THREE from 'three';

type RGB = [number, number, number];

/**
 * Khronos PBR Neutral, the curve three's NeutralToneMapping and the viewport's
 * BodyToneMapping apply. Linear in, linear out.
 */
export function neutralToneMap([r, g, b]: RGB): RGB {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let c: RGB = [r - offset, g - offset, b - offset];
  const peak = Math.max(...c);
  if (peak < startCompression) return c;
  const d = 1 - startCompression;
  const newPeak = 1 - (d * d) / (peak + d - startCompression);
  c = c.map(v => (v * newPeak) / peak) as RGB;
  const t = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return c.map(v => v + (newPeak - v) * t) as RGB;
}

/**
 * The colour to draw so that it *comes out of* Neutral tone mapping as `css`.
 * The path-traced render tone maps the whole frame, sky included, and the curve
 * pulls the light theme's near-white down to a visible grey. The answer can sit
 * well above 1.0 (about 2.6 for the light theme).
 *
 * Only for a backdrop nothing is composited over. The raster viewport's shadow
 * catcher darkens what is behind it by a fraction, and a fraction of 2.6 is still
 * far above white, so there it hid the floor shadows; that is why the raster
 * path leaves the backdrop out of tone mapping instead (BodyToneMapping). In the
 * path-traced render the floor is real geometry and the sky is only ever seen
 * directly, so the trick is safe.
 *
 * neutralToneMap run backwards. The compressed peak is the brightest output
 * channel, and that gives back the input peak and the desaturation; undoing
 * those gives the offset colour, and its darkest channel gives back the offset.
 * Not iterated: the peak couples the channels, and a per-channel solver walks
 * off to infinity on a near-grey. Pure white has no preimage, so the peak is
 * held just under 1.
 */
export function preToneMappedColor(css: string): THREE.Color {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  const d = 1 - startCompression;
  const target = new THREE.Color(css); // linear working space
  let c: RGB = [target.r, target.g, target.b];
  const newPeak = Math.min(Math.max(...c), 0.999);
  if (newPeak >= startCompression) {
    const peak = (d * d) / (1 - newPeak) - d + startCompression;
    const t = 1 - 1 / (desaturation * (peak - newPeak) + 1);
    c = c.map(v => (((v - newPeak * t) / (1 - t)) * peak) / newPeak) as RGB;
  }
  const m = Math.sqrt(Math.max(0, Math.min(...c)) / 6.25);
  const offset = m < 0.08 ? m - 6.25 * m * m : 0.04;
  return new THREE.Color().setRGB(c[0] + offset, c[1] + offset, c[2] + offset, THREE.LinearSRGBColorSpace);
}
