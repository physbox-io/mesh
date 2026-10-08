import { Effect, EffectAttribute } from 'postprocessing';
import { wrapEffect } from '@react-three/postprocessing';

/**
 * Khronos PBR Neutral tone mapping, applied only where something wrote depth.
 *
 * The composer turns off the renderer's own tone mapping and draws into a
 * half-float buffer, so without a pass like this the studio lighting's
 * highlights clipped straight to white. Neutral rather than ACES or AgX because
 * it leaves a body's colour as picked and only rolls off the highlights.
 *
 * Not postprocessing's own ToneMapping effect, because that maps the whole
 * frame, backdrop included. The backdrop is matched to the page around the
 * canvas, and the curve pulls near-white down to a visible grey. Drawing the
 * backdrop brighter to compensate (above 2.0) hid the floor shadows: the shadow
 * catcher darkens the backdrop by a third, which is still far above white, and
 * the curve squeezed it back to near-white. So the backdrop and everything drawn
 * over it without writing depth (the grid, the shadow catcher) skip the curve
 * and come out exactly as they do with Hi-Res off. Background pixels read depth
 * 1.0 even with the logarithmic depth buffer, which is the far plane either way.
 */
const fragmentShader = /* glsl */ `
vec3 pbrNeutral(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec3 color = depth < 1.0 ? pbrNeutral(inputColor.rgb) : inputColor.rgb;
  outputColor = vec4(color, inputColor.a);
}
`;

class BodyToneMappingEffect extends Effect {
  constructor() {
    super('BodyToneMappingEffect', fragmentShader, { attributes: EffectAttribute.DEPTH });
  }
}

export const BodyToneMapping = wrapEffect(BodyToneMappingEffect);
