// The halo round a glowing geom in the path traced image.
//
// The raster view's Bloom is a pass of the composer, and the traced image is
// drawn over the composer's frame, so Render mode had no halo at all and a neon
// tube came out as a pale bar. This does the same job on the tracer's own
// high-range image: take what only a light source reaches, blur it down a chain
// of half-size buffers and back up, and add it over the picture.
//
// What counts is bright AND saturated. Brightness alone will not do: in the
// white studio a lit floor reads above 1 too, and would haze the whole frame.
// So a white glow has no halo here; its own light on what is near it still shows.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const LEVELS = 6;
const BRIGHT = 1.2;
const STRENGTH = 0.5;
/** A traced firefly is one pixel at any brightness; held here, it cannot flare. */
const MOST = 8;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const extract = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(map, vUv).rgb;
  float peak = max(c.r, max(c.g, c.b));
  float low = min(c.r, min(c.g, c.b));
  float bright = smoothstep(${BRIGHT.toFixed(2)}, ${(BRIGHT * 1.4).toFixed(2)}, peak);
  float vivid = smoothstep(0.35, 0.7, (peak - low) / max(peak, 0.001));
  gl_FragColor = vec4(min(c, vec3(${MOST.toFixed(1)})) * bright * vivid, 1.0);
}
`;

/** Four taps a pixel out on the diagonals: a soft halving, and a soft doubling. */
const blur = /* glsl */ `
uniform sampler2D map;
uniform vec2 texel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(map, vUv + texel * vec2(-1.0, -1.0)).rgb
    + texture2D(map, vUv + texel * vec2(1.0, -1.0)).rgb
    + texture2D(map, vUv + texel * vec2(-1.0, 1.0)).rgb
    + texture2D(map, vUv + texel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}
`;

const add = /* glsl */ `
uniform sampler2D map;
uniform float strength;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(map, vUv).rgb * strength, 1.0);
  #include <colorspace_fragment>
}
`;

const material = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>, additive: boolean) =>
  new THREE.ShaderMaterial({
    vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false,
    ...(additive ? { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation, transparent: true } : { blending: THREE.NoBlending }),
  });

export class TracedGlow {
  private targets: THREE.WebGLRenderTarget[] = [];
  private extract = material(extract, { map: { value: null } }, false);
  private down = material(blur, { map: { value: null }, texel: { value: new THREE.Vector2() } }, false);
  private up = material(blur, { map: { value: null }, texel: { value: new THREE.Vector2() } }, true);
  private add = material(add, { map: { value: null }, strength: { value: STRENGTH } }, true);
  private quad = new FullScreenQuad(this.extract);

  private sized(width: number, height: number) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
    if (this.targets[0]?.width === w && this.targets[0]?.height === h) return;
    for (const t of this.targets) t.dispose();
    this.targets = Array.from({ length: LEVELS }, (_, i) => new THREE.WebGLRenderTarget(Math.max(1, w >> i), Math.max(1, h >> i), {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    }));
  }

  private pass(renderer: THREE.WebGLRenderer, m: THREE.ShaderMaterial, map: THREE.Texture, into: THREE.WebGLRenderTarget | null, clear: boolean) {
    m.uniforms.map.value = map;
    renderer.setRenderTarget(into);
    if (clear) renderer.clear(true, false, false);
    this.quad.material = m;
    this.quad.render(renderer);
  }

  /** Adds the halo over what is on the canvas. `opacity` is the tracer's fade-in. */
  render(renderer: THREE.WebGLRenderer, image: THREE.Texture, width: number, height: number, opacity: number) {
    this.sized(width, height);
    const { targets } = this;
    const canvas = renderer.getRenderTarget();
    this.pass(renderer, this.extract, image, targets[0], true);
    for (let i = 1; i < LEVELS; i++) {
      this.down.uniforms.texel.value.set(0.5 / targets[i - 1].width, 0.5 / targets[i - 1].height);
      this.pass(renderer, this.down, targets[i - 1].texture, targets[i], true);
    }
    for (let i = LEVELS - 1; i > 0; i--) {
      this.up.uniforms.texel.value.set(0.5 / targets[i].width, 0.5 / targets[i].height);
      this.pass(renderer, this.up, targets[i].texture, targets[i - 1], false);
    }
    this.add.uniforms.strength.value = STRENGTH * opacity;
    this.pass(renderer, this.add, targets[0].texture, canvas, false);
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    this.extract.dispose();
    this.down.dispose();
    this.up.dispose();
    this.add.dispose();
    this.quad.dispose();
  }
}
