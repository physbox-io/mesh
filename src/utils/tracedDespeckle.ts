import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * 3x3 morphological outlier / firefly cleanup pass for GPU path-traced renders.
 *
 * `DenoiseMaterial` is an edge-stopping bilateral filter: a single-pixel glossy
 * firefly or black/NaN pit has a large step in colour against all 8 neighbours,
 * so the bilateral filter treats it as a sharp edge and preserves it even at
 * 512 samples.
 *
 * Checking the 2nd-highest and 2nd-lowest of the 8 surrounding pixels separates
 * isolated 1-2 px impulses from genuine 1 px lines, shadow edges, and specular
 * rims (which connect to at least 2 neighbour pixels).
 */

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
uniform vec2 texel;
uniform float strength;
varying vec2 vUv;

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

bool validChannel(float x) {
  return x >= 0.0 && x < 65500.0;
}

vec3 safeRgb(vec3 c) {
  return vec3(
    validChannel(c.r) ? c.r : 0.0,
    validChannel(c.g) ? c.g : 0.0,
    validChannel(c.b) ? c.b : 0.0
  );
}

void main() {
  vec4 centerRaw = texture2D(map, vUv);
  bool centerValid = validChannel(centerRaw.r) && validChannel(centerRaw.g) && validChannel(centerRaw.b);
  vec3 center = safeRgb(centerRaw.rgb);
  float alpha = validChannel(centerRaw.a) ? clamp(centerRaw.a, 0.0, 1.0) : 1.0;

  vec3 sumRgb = vec3(0.0);
  vec3 max1Rgb = vec3(0.0);
  vec3 min1Rgb = vec3(0.0);
  float max1 = -1.0;
  float max2 = -1.0;
  float min1 = 1e9;
  float min2 = 1e9;

  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec3 s = safeRgb(texture2D(map, vUv + vec2(float(dx), float(dy)) * texel).rgb);
      float l = luma(s);
      sumRgb += s;
      if (l > max1) {
        max2 = max1;
        max1 = l;
        max1Rgb = s;
      } else if (l > max2) {
        max2 = l;
      }
      if (l < min1) {
        min2 = min1;
        min1 = l;
        min1Rgb = s;
      } else if (l < min2) {
        min2 = l;
      }
    }
  }

  // Trimmed mean of the 6 middle neighbours (drops single brightest & darkest neighbour).
  vec3 trimmedMean = max(vec3(0.0), (sumRgb - max1Rgb - min1Rgb) / 6.0);

  if (!centerValid) {
    gl_FragColor = vec4(trimmedMean, alpha);
    return;
  }

  float cLum = luma(center);
  vec3 outRgb = center;

  // 1. Isolated white / overly shiny firefly impulse: exceeds 2nd-brightest neighbour.
  float highCap = max2 * 1.75 + 0.08;
  if (cLum > highCap) {
    vec3 scaled = center * (highCap / max(cLum, 1e-5));
    vec3 target = mix(scaled, trimmedMean, 0.35);
    float w = clamp((cLum - highCap) / max(highCap, 0.08), 0.0, 1.0) * strength;
    outRgb = mix(center, target, w);
  } else if (min2 > 0.04 && cLum < min2 * 0.28) {
    // 2. Isolated dead / black speck surrounded by lit neighbours.
    float lowFloor = min2 * 0.28;
    float w = clamp((lowFloor - cLum) / max(lowFloor, 1e-4), 0.0, 1.0) * strength;
    outRgb = mix(center, trimmedMean, w);
  }

  gl_FragColor = vec4(outRgb, alpha);
}
`;

/** CPU reference of the 3x3 outlier filter (used by unit tests to verify impulse rejection vs. 1 px edge preservation). */
export function despecklePixel3x3(
  center: [number, number, number],
  neighbours: ReadonlyArray<[number, number, number]>,
  strength = 1.0,
): [number, number, number] {
  const luma = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const valid = (x: number) => Number.isFinite(x) && x >= 0 && x < 65500;
  const safe = (c: [number, number, number]): [number, number, number] => [
    valid(c[0]) ? c[0] : 0,
    valid(c[1]) ? c[1] : 0,
    valid(c[2]) ? c[2] : 0,
  ];

  let sumR = 0, sumG = 0, sumB = 0;
  let max1 = -1, max2 = -1;
  let min1 = 1e9, min2 = 1e9;
  let max1Rgb: [number, number, number] = [0, 0, 0];
  let min1Rgb: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < 8; i++) {
    const s = safe(neighbours[i]);
    const l = luma(s);
    sumR += s[0];
    sumG += s[1];
    sumB += s[2];
    if (l > max1) {
      max2 = max1;
      max1 = l;
      max1Rgb = s;
    } else if (l > max2) {
      max2 = l;
    }
    if (l < min1) {
      min2 = min1;
      min1 = l;
      min1Rgb = s;
    } else if (l < min2) {
      min2 = l;
    }
  }

  const trimmed: [number, number, number] = [
    Math.max(0, (sumR - max1Rgb[0] - min1Rgb[0]) / 6),
    Math.max(0, (sumG - max1Rgb[1] - min1Rgb[1]) / 6),
    Math.max(0, (sumB - max1Rgb[2] - min1Rgb[2]) / 6),
  ];

  if (!valid(center[0]) || !valid(center[1]) || !valid(center[2])) {
    return trimmed;
  }

  const c = safe(center);
  const cLum = luma(c);
  const highCap = max2 * 1.75 + 0.08;
  if (cLum > highCap) {
    const scale = highCap / Math.max(cLum, 1e-5);
    const tR = c[0] * scale * 0.65 + trimmed[0] * 0.35;
    const tG = c[1] * scale * 0.65 + trimmed[1] * 0.35;
    const tB = c[2] * scale * 0.65 + trimmed[2] * 0.35;
    const w = Math.min(1, Math.max(0, (cLum - highCap) / Math.max(highCap, 0.08))) * strength;
    return [c[0] + (tR - c[0]) * w, c[1] + (tG - c[1]) * w, c[2] + (tB - c[2]) * w];
  }
  if (min2 > 0.04 && cLum < min2 * 0.28) {
    const lowFloor = min2 * 0.28;
    const w = Math.min(1, Math.max(0, (lowFloor - cLum) / Math.max(lowFloor, 1e-4))) * strength;
    return [
      c[0] + (trimmed[0] - c[0]) * w,
      c[1] + (trimmed[1] - c[1]) * w,
      c[2] + (trimmed[2] - c[2]) * w,
    ];
  }
  return c;
}

export class TracedDespeckle {
  private target: THREE.WebGLRenderTarget | null = null;
  private mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      map: { value: null },
      texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      strength: { value: 1.0 },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.NoBlending,
  });
  private quad = new FullScreenQuad(this.mat);

  private ensureTarget(width: number, height: number): THREE.WebGLRenderTarget {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    if (!this.target || this.target.width !== w || this.target.height !== h) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    return this.target;
  }

  filter(
    renderer: THREE.WebGLRenderer,
    image: THREE.Texture,
    width: number,
    height: number,
    strength = 1.0,
  ): THREE.Texture {
    const out = this.ensureTarget(width, height);
    const prevTarget = renderer.getRenderTarget();
    this.mat.uniforms.map.value = image;
    this.mat.uniforms.texel.value.set(1 / out.width, 1 / out.height);
    this.mat.uniforms.strength.value = strength;
    renderer.setRenderTarget(out);
    this.quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    return out.texture;
  }

  dispose() {
    this.target?.dispose();
    this.target = null;
    this.mat.dispose();
    this.quad.dispose();
  }
}
