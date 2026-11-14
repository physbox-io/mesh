import * as THREE from 'three';
import type { BackgroundId } from '../types/scene';

// Precomputed sRGB byte (0..255) -> linear float and IEEE 754 half-float lookup tables.
const SRGB_TO_LINEAR = new Float32Array(256);
const SRGB_TO_HALF = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  SRGB_TO_LINEAR[i] = lin;
  SRGB_TO_HALF[i] = THREE.DataUtils.toHalfFloat(lin);
}
const ONE_HALF = THREE.DataUtils.toHalfFloat(1.0);

/** Deterministic integer-lattice hash in [0, 1). */
export function hash2(ix: number, iy: number, seed = 0): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 2D value noise in [0, 1]. */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Multi-octave fractal Brownian motion in roughly [0, 1]. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise2(fx, fy, seed + i * 97);
    norm += amp;
    amp *= 0.5;
    // Slight rotation between octaves breaks axis-aligned grid artifacts.
    const nx = fx * 1.6 + fy * 1.2;
    const ny = -fx * 1.2 + fy * 1.6;
    fx = nx;
    fy = ny;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged multifractal 2D noise in [0, 1] for sharp alpine crests and rock strata. */
export function ridged2(x: number, y: number, octaves = 5, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let weight = 1.0;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(fx, fy, seed + i * 131) * 2 - 1);
    const signal = n * n * weight;
    weight = Math.min(1, Math.max(0.15, signal * 1.8));
    sum += signal * amp;
    norm += amp;
    amp *= 0.5;
    const nx = fx * 1.68 + fy * 1.12;
    const ny = -fx * 1.12 + fy * 1.68;
    fx = nx;
    fy = ny;
  }
  return norm > 0 ? Math.min(1, sum / norm) : 0;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * C²-continuous 2D value noise that tiles seamlessly over integer periods
 * (`periodX`, `periodY`) with zero mirror symmetry or border seams.
 */
export function periodicNoise2(u: number, v: number, periodX: number, periodY: number, seed = 0): number {
  const x = u * periodX;
  const y = v * periodY;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ix0 = ((ix % periodX) + periodX) % periodX;
  const ix1 = (ix0 + 1) % periodX;
  const iy0 = ((iy % periodY) + periodY) % periodY;
  const iy1 = (iy0 + 1) % periodY;
  const a = hash2(ix0, iy0, seed);
  const b = hash2(ix1, iy0, seed);
  const c = hash2(ix0, iy1, seed);
  const d = hash2(ix1, iy1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Seamless tileable multi-octave FBM on u, v in [0, 1). */
export function periodicFbm2(
  u: number,
  v: number,
  freqX: number,
  freqY: number,
  octaves = 4,
  seed = 0,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = Math.max(1, Math.round(freqX));
  let py = Math.max(1, Math.round(freqY));
  for (let i = 0; i < octaves; i++) {
    sum += amp * periodicNoise2(u, v, px, py, seed + i * 137);
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Seamless tileable ridged multifractal noise on u, v in [0, 1). */
export function periodicRidged2(
  u: number,
  v: number,
  freqX: number,
  freqY: number,
  octaves = 4,
  seed = 0,
): number {
  let sum = 0;
  let amp = 0.5;
  let weight = 1.0;
  let norm = 0;
  let px = Math.max(1, Math.round(freqX));
  let py = Math.max(1, Math.round(freqY));
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(periodicNoise2(u, v, px, py, seed + i * 173) * 2 - 1);
    const signal = n * n * weight;
    weight = Math.min(1, Math.max(0.15, signal * 1.8));
    sum += signal * amp;
    norm += amp;
    amp *= 0.5;
    px *= 2;
    py *= 2;
  }
  return norm > 0 ? Math.min(1, sum / norm) : 0;
}

/**
 * Seamless tileable Worley (cellular) stone/gravel clast noise on u, v in [0, 1):
 * returns `{ cellHeight, cellId }` so individual gravel pebbles get distinct
 * mineral tints and rounded relief with zero border seams.
 */
const _cellOut = { height: 0, idHash: 0 };

function periodicGravelCells(
  u: number,
  v: number,
  cellsX: number,
  cellsY: number,
  seed: number,
): { height: number; idHash: number } {
  const gx = u * cellsX;
  const gy = v * cellsY;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let d1Sq = 1e9;
  let d2Sq = 1e9;
  let bestCx = 0;
  let bestCy = 0;

  for (let dy = -1; dy <= 1; dy++) {
    const cy = ((iy + dy) % cellsY + cellsY) % cellsY;
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ((ix + dx) % cellsX + cellsX) % cellsX;
      const ddx = gx - (ix + dx + 0.14 + 0.72 * hash2(cx, cy, seed));
      const ddy = gy - (iy + dy + 0.14 + 0.72 * hash2(cx, cy, seed + 31));
      const distSq = ddx * ddx + ddy * ddy;
      if (distSq < d1Sq) {
        d2Sq = d1Sq;
        d1Sq = distSq;
        bestCx = cx;
        bestCy = cy;
      } else if (distSq < d2Sq) {
        d2Sq = distSq;
      }
    }
  }
  const d1 = Math.sqrt(d1Sq);
  const d2 = Math.sqrt(d2Sq);
  // Edge gap between adjacent stones gives natural dark crevices; dome gives stone crown.
  const edge = smoothstep(0.02, 0.28, d2 - d1);
  const crown = Math.max(0, 1 - d1 * 1.25);
  _cellOut.height = edge * (0.45 + 0.55 * crown);
  _cellOut.idHash = hash2(bestCx, bestCy, seed + 79);
  return _cellOut;
}

/** Convert a wrap-around heightfield in [0, 1] into a tangent-space normal DataTexture. */
export function heightToNormalTexture(
  heights: Float32Array,
  width: number,
  height: number,
  strength: number,
  repeat: [number, number] = [1, 1],
): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const ym = (y - 1 + height) % height;
    const yp = (y + 1) % height;
    for (let x = 0; x < width; x++) {
      const xm = (x - 1 + width) % width;
      const xp = (x + 1) % width;
      const dx = (heights[y * width + xp] - heights[y * width + xm]) * strength;
      const dy = (heights[yp * width + x] - heights[ym * width + x]) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const nx = -dx * invLen;
      const ny = dy * invLen;
      const nz = invLen;
      const idx = (y * width + x) * 4;
      data[idx] = Math.round((nx * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function makeAlbedoDataTexture(
  data: Uint8Array,
  width: number,
  height: number,
  repeat: [number, number] = [1, 1],
  clamp = false,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

function get2dCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  return { canvas, ctx };
}

export interface SkyboxPair {
  /** Clamped linear skybox for `scene.background` (crisp 360° panorama). */
  background: THREE.DataTexture;
  /** HDR-boosted linear equirectangular map for `scene.environment` & GPU path tracer GI. */
  environment: THREE.DataTexture;
}

interface HotSpot {
  /** Azimuth in [0, 1) around the equirectangular width. */
  u: number;
  /** Row fraction in [0, 1] from top (zenith = 0, horizon = 0.5, nadir = 1). */
  v: number;
  /** Angular radius in UV units. */
  radius: number;
  /** Peak linear RGB boost added into `environment`. */
  hdrRgb: [number, number, number];
}

function createEquirectFromPixels(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  hotSpots: HotSpot[],
  envGain: { sky: number; ground: number } = { sky: 1.6, ground: 1.38 },
): SkyboxPair {
  const count = width * height * 4;
  const bgData = new Uint16Array(count);
  const envData = new Uint16Array(count);

  // Precompute per-row environment radiance gain so sky & ground diffuse IBL match
  // outdoor/studio exposure in both live PBR and GPU path-traced Render mode while
  // keeping `bgData` clamped <= 1.0 linear for crisp unclipped skyboxes.
  const rowGain = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const dy = Math.cos((1 - v) * Math.PI);
    const tSky = smoothstep(-0.08, 0.12, dy);
    rowGain[y] = envGain.ground * (1 - tSky) + envGain.sky * tSky;
  }

  for (let y = 0; y < height; y++) {
    const gain = rowGain[y];
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowBase + x * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      bgData[i] = SRGB_TO_HALF[r];
      bgData[i + 1] = SRGB_TO_HALF[g];
      bgData[i + 2] = SRGB_TO_HALF[b];
      bgData[i + 3] = ONE_HALF;
      envData[i] = THREE.DataUtils.toHalfFloat(SRGB_TO_LINEAR[r] * gain);
      envData[i + 1] = THREE.DataUtils.toHalfFloat(SRGB_TO_LINEAR[g] * gain);
      envData[i + 2] = THREE.DataUtils.toHalfFloat(SRGB_TO_LINEAR[b] * gain);
      envData[i + 3] = ONE_HALF;
    }
  }

  // Add smooth HDR sun / window / lamp radiance to the environment map so glossy
  // metals, plastics and ceramics pick up realistic specular highlights.
  for (const spot of hotSpots) {
    const minY = Math.max(0, Math.floor((spot.v - spot.radius * 2) * height));
    const maxY = Math.min(height - 1, Math.ceil((spot.v + spot.radius * 2) * height));
    const spanX = Math.ceil(spot.radius * 2.5 * width);
    const cx = Math.round(spot.u * width);
    for (let y = minY; y <= maxY; y++) {
      const gain = rowGain[y];
      const dv = (y + 0.5) / height - spot.v;
      const sinTheta = Math.max(0.15, Math.sin(((y + 0.5) / height) * Math.PI));
      for (let dxPx = -spanX; dxPx <= spanX; dxPx++) {
        const x = ((cx + dxPx) % width + width) % width;
        const du = (dxPx / width) * sinTheta;
        const d = Math.hypot(du, dv) / spot.radius;
        if (d >= 1.8) continue;
        const falloff = Math.exp(-d * d * 2.4);
        const idx = (y * width + x) * 4;
        const lr = SRGB_TO_LINEAR[rgba[idx]] * gain + spot.hdrRgb[0] * falloff;
        const lg = SRGB_TO_LINEAR[rgba[idx + 1]] * gain + spot.hdrRgb[1] * falloff;
        const lb = SRGB_TO_LINEAR[rgba[idx + 2]] * gain + spot.hdrRgb[2] * falloff;
        envData[idx] = THREE.DataUtils.toHalfFloat(lr);
        envData[idx + 1] = THREE.DataUtils.toHalfFloat(lg);
        envData[idx + 2] = THREE.DataUtils.toHalfFloat(lb);
      }
    }
  }

  const configure = (arr: Uint16Array) => {
    const tex = new THREE.DataTexture(arr, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // DataTexture uploads ArrayBufferView unflipped in WebGL2 (row 0 -> uv.y = 0
    // nadir, row height-1 -> uv.y = 1 zenith); flipY = false keeps Three.js and
    // three-gpu-pathtracer's EquirectHdrInfoUniform in exact agreement.
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    background: configure(bgData),
    environment: configure(envData),
  };
}

/**
 * Build a Render-mode-only HalfFloat equirectangular copy of `src` (`background`
 * or `environment`) with daylight-balanced desaturation, linear exposure scale,
 * and optional soft-knee clamping of baked solar hotspots (since `PathTracedView`
 * already models the sun with a physical `ShapedAreaLight` disc).
 */
export function buildTracedEquirectTexture(
  src: THREE.DataTexture,
  options: { desaturate: number; scale: number; hotspotClamp?: number },
): THREE.DataTexture {
  const srcArr = src.image.data as Uint16Array;
  const width = src.image.width;
  const height = src.image.height;
  const dstArr = new Uint16Array(srcArr.length);
  const desat = Math.max(0, Math.min(1, options.desaturate));
  const keep = 1 - desat;
  const scale = options.scale;
  const clamp = options.hotspotClamp;

  for (let i = 0; i < srcArr.length; i += 4) {
    let r = THREE.DataUtils.fromHalfFloat(srcArr[i]);
    let g = THREE.DataUtils.fromHalfFloat(srcArr[i + 1]);
    let b = THREE.DataUtils.fromHalfFloat(srcArr[i + 2]);
    if (clamp !== undefined) {
      const peak = Math.max(r, g, b);
      if (peak > clamp) {
        const compressed = (clamp + (peak - clamp) * 0.18) / peak;
        r *= compressed;
        g *= compressed;
        b *= compressed;
      }
    }
    // Blend Rec.709 luminance with equal-energy channel mean so deep azure/cobalt
    // skies stay airy and luminous when desaturated rather than turning dark grey.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mean = (r + g + b) / 3;
    const neutral = 0.55 * lum + 0.45 * mean;
    dstArr[i] = THREE.DataUtils.toHalfFloat((r * keep + neutral * desat) * scale);
    dstArr[i + 1] = THREE.DataUtils.toHalfFloat((g * keep + neutral * desat) * scale);
    dstArr[i + 2] = THREE.DataUtils.toHalfFloat((b * keep + neutral * desat) * scale);
    dstArr[i + 3] = srcArr[i + 3];
  }

  const tex = new THREE.DataTexture(dstArr, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Equirectangular UV mapping for a Three.js Y-up world direction (dx, dy, dz):
 * row 0 (v = 0) is nadir (dy = -1) and row height-1 (v = 1) is zenith (dy = +1).
 */
function directionToUv(dx: number, dy: number, dz: number): { u: number; v: number } {
  const len = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / len;
  const ny = Math.max(-1, Math.min(1, dy / len));
  const nz = dz / len;
  const u = ((Math.atan2(nz, nx) / (2 * Math.PI)) + 0.5 + 1) % 1;
  const v = 1 - Math.acos(ny) / Math.PI;
  return { u, v };
}

/** Build a realistic 360° equirectangular skybox + HDR lighting environment. */
export function buildEquirectSkybox(preset: Exclude<BackgroundId, 'studio'>): SkyboxPair {
  const width = 1024;
  const height = 512;
  const rgba = new Uint8Array(width * height * 4);

  if (preset === 'meadow') {
    const sun = directionToUv(2.4, 3.1, 1.8);
    const sunDir = new THREE.Vector3(2.4, 3.1, 1.8).normalize();
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const theta = (1 - v) * Math.PI;
      const dy = Math.cos(theta);
      const sinT = Math.sin(theta);
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const phi = (u - 0.5) * 2 * Math.PI;
        const dx = sinT * Math.cos(phi);
        const dz = sinT * Math.sin(phi);
        const sunDot = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);

        let r: number, g: number, b: number;
        if (dy >= -0.02) {
          const h = Math.max(0, dy);
          const skyT = Math.pow(h, 0.58);
          // Radiant, hyper-vivid summer sky: luminous cyan-aqua horizon to electric cerulean zenith.
          r = 202 * (1 - skyT) + 20 * skyT;
          g = 244 * (1 - skyT) + 148 * skyT;
          b = 255 * (1 - skyT) + 255 * skyT;

          // Warm golden-white solar corona + dazzling solar disc.
          const mie = Math.pow(sunDot, 5) * 0.52 + Math.pow(sunDot, 56) * 0.78;
          r += mie * 255;
          g += mie * 242;
          b += mie * 188;

          // Billowing pure-white sunlit cumulus clouds wrapped seamlessly in 3D direction space.
          if (h > 0.03) {
            const cx = (dx / (h + 0.22)) * 2.2;
            const cz = (dz / (h + 0.22)) * 2.2;
            const cloudBase = fbm2(cx + 3.1, cz - 1.7, 5, 41);
            const cloudDetail = fbm2(cx * 2.7 - 5.2, cz * 2.7 + 2.4, 4, 83);
            const density = smoothstep(0.54, 0.76, cloudBase * 0.78 + cloudDetail * 0.22) * smoothstep(0.03, 0.16, h);
            if (density > 0.001) {
              const lit = 0.88 + 0.16 * smoothstep(0.45, 0.78, cloudDetail) + 0.14 * Math.pow(sunDot, 3);
              const cr = Math.min(255, 250 * lit + 8);
              const cg = Math.min(255, 251 * lit + 6);
              const cb = Math.min(255, 255 * lit + 4);
              r = r * (1 - density * 0.92) + cr * (density * 0.92);
              g = g * (1 - density * 0.92) + cg * (density * 0.92);
              b = b * (1 - density * 0.92) + cb * (density * 0.92);
            }
          }

          // Sun-drenched emerald-chartreuse distant hills right on the horizon.
          const ridgeH = 0.018 + 0.038 * fbm2(Math.cos(phi) * 3.5 + 4, Math.sin(phi) * 3.5 + 4, 4, 19);
          if (dy < ridgeH) {
            const blend = smoothstep(ridgeH, ridgeH - 0.012, dy);
            r = r * (1 - blend) + 114 * blend;
            g = g * (1 - blend) + 222 * blend;
            b = b * (1 - blend) + 66 * blend;
          }
        } else {
          // Lower hemisphere: glowing sunlit chartreuse-emerald grass bounce for vivid GI on undersides.
          const gT = smoothstep(0, -0.65, dy);
          r = 124 * (1 - gT) + 84 * gT;
          g = 226 * (1 - gT) + 182 * gT;
          b = 52 * (1 - gT) + 34 * gT;
        }

        const idx = (y * width + x) * 4;
        rgba[idx] = Math.min(255, Math.max(0, Math.round(r)));
        rgba[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
        rgba[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
        rgba[idx + 3] = 255;
      }
    }
    return createEquirectFromPixels(
      rgba,
      width,
      height,
      [{ u: sun.u, v: sun.v, radius: 0.035, hdrRgb: [8.4, 7.6, 5.8] }],
      { sky: 2.95, ground: 2.45 },
    );
  }

  if (preset === 'mountains') {
    const sunDir = new THREE.Vector3(-2.2, 3.5, 2.0).normalize();
    const sun = directionToUv(sunDir.x, sunDir.y, sunDir.z);
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const theta = (1 - v) * Math.PI;
      const dy = Math.cos(theta);
      const sinT = Math.sin(theta);
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const phi = (u - 0.5) * 2 * Math.PI;
        const dx = sinT * Math.cos(phi);
        const dz = sinT * Math.sin(phi);
        const sunDot = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);

        let r: number, g: number, b: number;
        const h = Math.max(0, dy);
        const skyT = Math.pow(h, 0.62);
        // Bright, luminous high-altitude alpine azure sky.
        r = 228 * (1 - skyT) + 46 * skyT;
        g = 244 * (1 - skyT) + 132 * skyT;
        b = 255 * (1 - skyT) + 248 * skyT;

        const mie = Math.pow(sunDot, 8) * 0.44 + Math.pow(sunDot, 84) * 0.82;
        r += mie * 255;
        g += mie * 250;
        b += mie * 238;

        // High sunlit cirrus streaks.
        if (dy > 0.08) {
          const wx = (dx / (dy + 0.25)) * 3.4;
          const wz = (dz / (dy + 0.25)) * 1.1;
          const cirrus = smoothstep(0.58, 0.84, fbm2(wx + 7.2, wz - 3.4, 4, 211)) * smoothstep(0.08, 0.28, dy) * 0.48;
          r = r * (1 - cirrus) + 254 * cirrus;
          g = g * (1 - cirrus) + 255 * cirrus;
          b = b * (1 - cirrus) + 255 * cirrus;
        }

        // Far 360° gleaming snow-mantled alpine range silhouettes along the horizon.
        const farPeak =
          0.045 +
          0.13 * ridged2(Math.cos(phi) * 2.6 + 8.1, Math.sin(phi) * 2.6 - 4.3, 5, 307) *
          (0.65 + 0.35 * valueNoise2(Math.cos(phi) * 1.3, Math.sin(phi) * 1.3, 99));
        if (dy < farPeak && dy > -0.12) {
          const snow = smoothstep(0.042, 0.105, dy + 0.03 * fbm2(phi * 9, dy * 24, 3, 55));
          const sunFacing = 0.5 + 0.5 * (Math.cos(phi) * sunDir.x + Math.sin(phi) * sunDir.z);
          const rockR = 136 + 38 * sunFacing;
          const rockG = 152 + 36 * sunFacing;
          const rockB = 182 + 30 * sunFacing;
          const snowR = 240 + 15 * sunFacing;
          const snowG = 246 + 9 * sunFacing;
          const snowB = 255;
          const mr = rockR * (1 - snow) + snowR * snow;
          const mg = rockG * (1 - snow) + snowG * snow;
          const mb = rockB * (1 - snow) + snowB * snow;
          // Bright sunlit alpine atmospheric perspective haze.
          r = mr * 0.72 + 216 * 0.28;
          g = mg * 0.72 + 234 * 0.28;
          b = mb * 0.72 + 252 * 0.28;
        } else if (dy <= -0.12) {
          // Bright sunlit pale granite & snow ground bounce.
          const gT = smoothstep(-0.12, -0.75, dy);
          r = 188 * (1 - gT) + 148 * gT;
          g = 196 * (1 - gT) + 156 * gT;
          b = 210 * (1 - gT) + 170 * gT;
        }

        const idx = (y * width + x) * 4;
        rgba[idx] = Math.min(255, Math.max(0, Math.round(r)));
        rgba[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
        rgba[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
        rgba[idx + 3] = 255;
      }
    }
    return createEquirectFromPixels(
      rgba,
      width,
      height,
      [{ u: sun.u, v: sun.v, radius: 0.03, hdrRgb: [8.2, 7.8, 7.2] }],
      { sky: 2.7, ground: 2.25 },
    );
  }

  if (preset === 'urban') {
    const sunDir = new THREE.Vector3(2.6, 2.3, 2.1).normalize();
    const sun = directionToUv(sunDir.x, sunDir.y, sunDir.z);
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const theta = (1 - v) * Math.PI;
      const dy = Math.cos(theta);
      const sinT = Math.sin(theta);
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const phi = (u - 0.5) * 2 * Math.PI;
        const dx = sinT * Math.cos(phi);
        const dz = sinT * Math.sin(phi);
        const sunDot = Math.max(0, dx * sunDir.x + dy * sunDir.y + dz * sunDir.z);

        let r: number, g: number, b: number;
        if (dy >= -0.02) {
          const h = Math.max(0, dy);
          const skyT = Math.pow(h, 0.55);
          // Warm golden-hour urban haze at the horizon into slate-blue sky above.
          r = 242 * (1 - skyT) + 54 * skyT;
          g = 204 * (1 - skyT) + 92 * skyT;
          b = 176 * (1 - skyT) + 148 * skyT;

          const mie = Math.pow(sunDot, 6) * 0.45 + Math.pow(sunDot, 64) * 0.6;
          r += mie * 255;
          g += mie * 195;
          b += mie * 130;

          // Layered urban skyline blocks around the horizon.
          const sector = Math.floor(((u * 48) % 48 + 48) % 48);
          const bldH = 0.04 + 0.16 * hash2(sector, 3, 701) + (hash2(sector, 9, 701) > 0.75 ? 0.09 : 0);
          const farSector = Math.floor(((u * 74 + 0.4) % 74 + 74) % 74);
          const farBldH = 0.06 + 0.18 * hash2(farSector, 5, 733);
          if (dy < bldH) {
            const rim = Math.max(0, dx * sunDir.x + dz * sunDir.z);
            r = 58 + 34 * Math.max(0, rim);
            g = 56 + 26 * Math.max(0, rim);
            b = 66 + 18 * Math.max(0, rim);
            // Subtle sunlit / lit office windows.
            const winX = ((u * 48 * 7) % 1 + 1) % 1;
            const winY = ((dy * 95) % 1 + 1) % 1;
            if (winX > 0.25 && winX < 0.72 && winY > 0.28 && winY < 0.72 && dy < bldH - 0.008) {
              const lit = hash2(Math.floor(u * 336), Math.floor(dy * 95), 911);
              if (lit > 0.72) {
                r += 115;
                g += 88;
                b += 46;
              }
            }
          } else if (dy < farBldH) {
            r = r * 0.48 + 96 * 0.52;
            g = g * 0.48 + 94 * 0.52;
            b = b * 0.48 + 108 * 0.52;
          }
        } else {
          const gT = smoothstep(-0.02, -0.7, dy);
          r = 104 * (1 - gT) + 68 * gT;
          g = 98 * (1 - gT) + 65 * gT;
          b = 98 * (1 - gT) + 68 * gT;
        }

        const idx = (y * width + x) * 4;
        rgba[idx] = Math.min(255, Math.max(0, Math.round(r)));
        rgba[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
        rgba[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
        rgba[idx + 3] = 255;
      }
    }
    return createEquirectFromPixels(
      rgba,
      width,
      height,
      [{ u: sun.u, v: sun.v, radius: 0.036, hdrRgb: [5.6, 4.3, 2.9] }],
      { sky: 1.85, ground: 1.5 },
    );
  }

  if (preset === 'workbench') {
    const lamp1 = directionToUv(0.6, 2.8, 0.8);
    const lamp2 = directionToUv(-0.8, 2.6, 0.4);
    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const theta = (1 - v) * Math.PI;
      const dy = Math.cos(theta);
      const sinT = Math.sin(theta);
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        const phi = (u - 0.5) * 2 * Math.PI;
        const dx = sinT * Math.cos(phi);
        const dz = sinT * Math.sin(phi);

        let r: number, g: number, b: number;
        if (dy > 0.35) {
          // Workshop ceiling with bright warm-neutral LED shop-light panels.
          r = 68;
          g = 72;
          b = 80;
          const px = dx / (dy + 0.05);
          const pz = dz / (dy + 0.05);
          const stripA = Math.abs(px - 0.22) < 0.42 && Math.abs(pz - 0.18) < 0.14;
          const stripB = Math.abs(px + 0.35) < 0.42 && Math.abs(pz + 0.22) < 0.14;
          if (stripA || stripB) {
            r = 252;
            g = 248;
            b = 238;
          }
        } else if (dy >= -0.15) {
          // Studio/workshop walls with warm mid-tone acoustic/painted concrete band.
          const wallNoise = fbm2(Math.cos(phi) * 6, dy * 8, 3, 503);
          const windowGlow = dx > 0.55 && Math.abs(dz - 0.35) < 0.38 && dy > 0.02 && dy < 0.32;
          if (windowGlow) {
            r = 236;
            g = 242;
            b = 248;
          } else {
            r = 92 + wallNoise * 18;
            g = 96 + wallNoise * 18;
            b = 104 + wallNoise * 16;
          }
        } else {
          // Warm oak & shop concrete floor bounce.
          const gT = smoothstep(-0.15, -0.8, dy);
          r = 126 * (1 - gT) + 78 * gT;
          g = 104 * (1 - gT) + 74 * gT;
          b = 82 * (1 - gT) + 72 * gT;
        }

        const idx = (y * width + x) * 4;
        rgba[idx] = Math.min(255, Math.max(0, Math.round(r)));
        rgba[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
        rgba[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
        rgba[idx + 3] = 255;
      }
    }
    return createEquirectFromPixels(rgba, width, height, [
      { u: lamp1.u, v: lamp1.v, radius: 0.065, hdrRgb: [3.8, 3.7, 3.4] },
      { u: lamp2.u, v: lamp2.v, radius: 0.055, hdrRgb: [2.6, 2.6, 2.5] },
    ]);
  }

  // 'coffee_table': sunlit cozy living room interior.
  const win = directionToUv(2.2, 1.4, 1.2);
  const warmLamp = directionToUv(-1.8, 0.9, -1.1);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const theta = (1 - v) * Math.PI;
    const dy = Math.cos(theta);
    const sinT = Math.sin(theta);
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * 2 * Math.PI;
      const dx = sinT * Math.cos(phi);
      const dz = sinT * Math.sin(phi);

      let r: number, g: number, b: number;
      if (dy > 0.48) {
        // Warm matte plaster ceiling catching afternoon window bounce.
        const bounce = 0.5 + 0.5 * Math.max(0, dx * 0.7 + dz * 0.4);
        r = 216 + 22 * bounce;
        g = 207 + 20 * bounce;
        b = 194 + 18 * bounce;
      } else if (dy >= -0.14) {
        // Sunlit living room window on the +X/+Z side, warm plaster & soft lamp opposite.
        const inWindow = dx > 0.52 && dz > -0.15 && dz < 0.78 && dy > -0.02 && dy < 0.42;
        if (inWindow) {
          // Mullion bars + lush sunlit garden outside.
          const mullion = Math.abs(dz - 0.31) < 0.018 || Math.abs(dy - 0.2) < 0.014;
          if (mullion) {
            r = 210;
            g = 198;
            b = 182;
          } else {
            const foliage = fbm2(dz * 12, dy * 12, 4, 617);
            const skyPart = smoothstep(0.14, 0.32, dy);
            r = (182 + foliage * 44) * (1 - skyPart) + 252 * skyPart;
            g = (206 + foliage * 36) * (1 - skyPart) + 244 * skyPart;
            b = (158 + foliage * 30) * (1 - skyPart) + 224 * skyPart;
          }
        } else {
          const plaster = fbm2(Math.cos(phi) * 5, dy * 6, 3, 811);
          const lampGlow = Math.max(0, (-dx * 0.72 - dz * 0.45 + dy * 0.2));
          const warm = Math.pow(lampGlow, 5) * 55;
          r = 196 + plaster * 16 + warm;
          g = 184 + plaster * 15 + warm * 0.74;
          b = 168 + plaster * 14 + warm * 0.42;
        }
      } else {
        // Warm walnut & honey-oak floor bounce.
        const gT = smoothstep(-0.14, -0.8, dy);
        r = 152 * (1 - gT) + 108 * gT;
        g = 122 * (1 - gT) + 82 * gT;
        b = 92 * (1 - gT) + 56 * gT;
      }

      const idx = (y * width + x) * 4;
      rgba[idx] = Math.min(255, Math.max(0, Math.round(r)));
      rgba[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
      rgba[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
      rgba[idx + 3] = 255;
    }
  }
  return createEquirectFromPixels(rgba, width, height, [
    { u: win.u, v: win.v, radius: 0.085, hdrRgb: [4.2, 3.7, 2.9] },
    { u: warmLamp.u, v: warmLamp.v, radius: 0.055, hdrRgb: [2.0, 1.35, 0.7] },
  ]);
}

// ---------------------------------------------------------------------------
// Surface Material Textures (Albedo + Tangent-Space Normal Maps)
// ---------------------------------------------------------------------------

/** Seamless high-key sunlit turf/clover detail for Meadow (boosts green saturation when multiplied by vertexColors). */
export function buildMeadowGroundTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const coarse = periodicFbm2(u, v, 5, 5, 4, 17);
      const fine = periodicFbm2(u, v, 22, 22, 4, 53);
      const blade = hash2(x, y, 91) * 0.14;
      const h = coarse * 0.46 + fine * 0.4 + blade;
      heights[y * size + x] = h;
      const idx = (y * size + x) * 4;
      const shade = 238 + Math.round((h - 0.5) * 38);
      data[idx] = Math.min(255, Math.max(185, shade - 12));
      data[idx + 1] = Math.min(255, Math.max(218, shade + 14));
      data[idx + 2] = Math.min(255, Math.max(125, shade - 44));
      data[idx + 3] = 255;
    }
  }
  // UVs in buildMeadowGeometries are metres / 3.4 -> [1, 1] repeat = 3.4 m seamless tile.
  return {
    map: makeAlbedoDataTexture(data, size, size, [1, 1]),
    normalMap: heightToNormalTexture(heights, size, size, 1.65, [1, 1]),
  };
}

/**
 * Seamless sunlit alpine granite & multi-scale talus gravel texture for Mountains.
 * Uses domain-warped periodic FBM/ridged + 3-tier cellular pebble relief over a
 * wide 4.8 m tile so there are zero mirror creases, zero tile joins, and bright
 * high-altitude granite reflectance.
 */
export function buildGraniteTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      // Smooth periodic domain warp bends gravel pockets & fractures organically while staying 100% tile-seamless.
      const du = (periodicFbm2(u, v, 3, 3, 2, 137) - 0.5) * 0.065;
      const dv = (periodicFbm2(u, v, 3, 3, 2, 149) - 0.5) * 0.065;
      const wu = ((u + du) % 1 + 1) % 1;
      const wv = ((v + dv) % 1 + 1) % 1;

      const microRock = periodicFbm2(wu, wv, 9, 9, 3, 141);
      const fractures = periodicRidged2(wu, wv, 11, 11, 3, 157);
      // Patches where talus/gravel collects in hollows vs exposed solid granite slab.
      const gravelMix = smoothstep(0.42, 0.68, periodicFbm2(wu, wv, 5, 5, 2, 193));
      const coarseCell = periodicGravelCells(wu, wv, 34, 34, 211);
      const coarseH = coarseCell.height;
      const coarseId = coarseCell.idHash;
      const midCell = periodicGravelCells(wu, wv, 76, 76, 233);
      const midH = midCell.height;
      const midId = midCell.idHash;
      const fineH = periodicGravelCells(u, v, 144, 144, 251).height;
      const crystal = hash2(x, y, 277);
      const mineralSpeck = crystal < 0.07 ? -16 : crystal > 0.88 ? 16 : 0;

      const slabH = microRock * 0.46 + fractures * 0.41 + crystal * 0.13;
      const gravelH = coarseH * 0.46 + midH * 0.34 + fineH * 0.2;
      const h = slabH * (1 - gravelMix * 0.68) + gravelH * (gravelMix * 0.68);
      heights[y * size + x] = h;

      // Subtle mineral tint per gravel clast (warm feldspar, cool slate, pale quartz),
      // keeping macro luminance bright so sunlit alpine granite gleams cleanly.
      const clastWarmth = ((coarseId - 0.5) * 16 + (midId - 0.5) * 10) * gravelMix;
      const shade =
        232 +
        Math.round((h - 0.5) * 48) +
        Math.round((microRock - 0.5) * 12) +
        mineralSpeck;
      const idx = (y * size + x) * 4;
      data[idx] = Math.min(255, Math.max(148, Math.round(shade + clastWarmth * 0.72)));
      data[idx + 1] = Math.min(255, Math.max(150, Math.round(shade + 1 + clastWarmth * 0.25)));
      data[idx + 2] = Math.min(255, Math.max(154, Math.round(shade + 5 - clastWarmth * 0.6)));
      data[idx + 3] = 255;
    }
  }
  return {
    map: makeAlbedoDataTexture(data, size, size, [1, 1]),
    normalMap: heightToNormalTexture(heights, size, size, 2.2, [1, 1]),
  };
}

export type GraffitiWallVariant = 'center' | 'left_alley' | 'right_wing';

/**
 * Seamless periodic running-bond clay brickwork texture (1.80 m x 1.80 m world tile =
 * 8 bricks wide x 24 courses tall at exact 225 mm x 75 mm pitch with 10 mm recessed mortar)
 * so every flanking wall, pilaster, corner return, and wall back in Urban has crisp brick.
 */
export function buildTileableBrickTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const size = 512;
  const cols = 8; // 8 * 0.225 m = 1.80 m
  const rows = 24; // 24 * 0.075 m = 1.80 m
  const mortarFracX = 0.01 / 0.225;
  const mortarFracY = 0.01 / 0.075;
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const rowFloat = v * rows;
    const row = Math.floor(rowFloat) % rows;
    const fy = rowFloat - Math.floor(rowFloat);
    const stagger = (row & 1) * 0.5;
    const dyEdge = Math.min(fy, 1 - fy);

    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const colFloat = u * cols + stagger;
      const col = ((Math.floor(colFloat) % cols) + cols) % cols;
      const fx = colFloat - Math.floor(colFloat);
      const dxEdge = Math.min(fx, 1 - fx);
      const inMortar = dxEdge < mortarFracX * 0.5 || dyEdge < mortarFracY * 0.5;

      const brickSeed = hash2(col, row, 461);
      const kilnTint = hash2(col * 3 + 5, row * 7 + 2, 479);
      const surfaceNoise = periodicFbm2(u, v, 16, 16, 3, 487);
      const idx = (y * size + x) * 4;

      if (inMortar) {
        const m = 156 + Math.round((surfaceNoise - 0.5) * 30);
        data[idx] = m;
        data[idx + 1] = m - 3;
        data[idx + 2] = m - 8;
        data[idx + 3] = 255;
        heights[y * size + x] = 0.16 + surfaceNoise * 0.1;
      } else {
        const edgeBevel =
          smoothstep(mortarFracX * 0.5, mortarFracX * 1.4, dxEdge) *
          smoothstep(mortarFracY * 0.5, mortarFracY * 1.4, dyEdge);
        const shade = (brickSeed - 0.5) * 44 + (surfaceNoise - 0.5) * 24;
        const burnt = kilnTint > 0.86 ? -26 : kilnTint < 0.14 ? 14 : 0;
        data[idx] = Math.min(255, Math.max(66, Math.round(172 + shade + burnt)));
        data[idx + 1] = Math.min(255, Math.max(48, Math.round(101 + shade * 0.68 + burnt * 0.72)));
        data[idx + 2] = Math.min(255, Math.max(40, Math.round(79 + shade * 0.54 + burnt * 0.6)));
        data[idx + 3] = 255;
        heights[y * size + x] = 0.56 + 0.34 * edgeBevel + surfaceNoise * 0.1;
      }
    }
  }

  return {
    map: makeAlbedoDataTexture(data, size, size, [1, 1]),
    normalMap: heightToNormalTexture(heights, size, size, 3.4, [1, 1]),
  };
}

/**
 * True-scale running-bond brick wall (~28 courses of 215 x 65 mm bricks with 10 mm
 * recessed mortar) painted with one of three distinct street-art murals so every
 * wall bay in the Urban scene features brick relief and differing graffiti.
 */
export function buildGraffitiBrickWallTextures(
  variant: GraffitiWallVariant = 'center',
): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const width = 1024;
  const height = 512;
  const wallW = variant === 'left_alley' ? 5.4 : 6.4;
  const wallH = 2.85;
  const brickPitchX = 0.225; // 215 mm brick + 10 mm mortar
  const brickPitchY = 0.075; // 65 mm brick + 10 mm mortar
  const mortarFracX = 0.01 / brickPitchX;
  const mortarFracY = 0.01 / brickPitchY;
  const variantSeed = variant === 'center' ? 401 : variant === 'left_alley' ? 509 : 613;

  const baseRgba = new Uint8Array(width * height * 4);
  const heights = new Float32Array(width * height);

  // 1. Underlying clay brickwork + recessed mortar heightfield (subtle kiln warmth shift per wall).
  const brickBaseR = variant === 'left_alley' ? 162 : variant === 'right_wing' ? 174 : 168;
  const brickBaseG = variant === 'left_alley' ? 104 : variant === 'right_wing' ? 102 : 97;
  const brickBaseB = variant === 'left_alley' ? 82 : variant === 'right_wing' ? 76 : 77;

  for (let py = 0; py < height; py++) {
    const wy = (1 - py / height) * wallH;
    const row = Math.floor(wy / brickPitchY);
    const fy = (wy / brickPitchY) - row;
    for (let px = 0; px < width; px++) {
      const wx = (px / width) * wallW;
      const stagger = (row & 1) * 0.5;
      const col = Math.floor(wx / brickPitchX + stagger);
      const fx = (wx / brickPitchX + stagger) - col;

      const dxEdge = Math.min(fx, 1 - fx);
      const dyEdge = Math.min(fy, 1 - fy);
      const inMortar = dxEdge < mortarFracX * 0.5 || dyEdge < mortarFracY * 0.5;

      const brickSeed = hash2(col, row, variantSeed);
      const surfaceNoise = fbm2(wx * 18, wy * 18, 3, variantSeed + 18);
      const idx = (py * width + px) * 4;

      if (inMortar) {
        const m = 152 + Math.round((surfaceNoise - 0.5) * 32);
        baseRgba[idx] = m;
        baseRgba[idx + 1] = m - 3;
        baseRgba[idx + 2] = m - 8;
        baseRgba[idx + 3] = 255;
        heights[py * width + px] = 0.18 + surfaceNoise * 0.1;
      } else {
        const edgeBevel =
          smoothstep(mortarFracX * 0.5, mortarFracX * 1.35, dxEdge) *
          smoothstep(mortarFracY * 0.5, mortarFracY * 1.35, dyEdge);
        const shade = (brickSeed - 0.5) * 42 + (surfaceNoise - 0.5) * 26;
        // Weathering grime near ground level (wy < 0.45 m).
        const damp = (1 - smoothstep(0.05, 0.5, wy)) * 28;
        baseRgba[idx] = Math.min(255, Math.max(70, Math.round(brickBaseR + shade - damp)));
        baseRgba[idx + 1] = Math.min(255, Math.max(52, Math.round(brickBaseG + shade * 0.68 - damp)));
        baseRgba[idx + 2] = Math.min(255, Math.max(44, Math.round(brickBaseB + shade * 0.55 - damp)));
        baseRgba[idx + 3] = 255;
        heights[py * width + px] = 0.55 + 0.35 * edgeBevel + surfaceNoise * 0.1;
      }
    }
  }

  // 2. Overlay vibrant street-art mural on a 2D canvas, then composite over the brick relief
  // so mortar crevices and weathered brick grain still peek organically through the spray paint.
  const c2d = get2dCanvas(width, height);
  if (c2d) {
    const { ctx } = c2d;
    ctx.clearRect(0, 0, width, height);

    if (variant === 'center') {
      // Sweeping teal/cyan aerosol aura + solar disc + interlocking geometric wildstyle chevrons.
      const aura = ctx.createRadialGradient(width * 0.5, height * 0.62, 20, width * 0.5, height * 0.6, width * 0.38);
      aura.addColorStop(0, 'rgba(20, 184, 166, 0.88)');
      aura.addColorStop(0.48, 'rgba(14, 116, 144, 0.72)');
      aura.addColorStop(0.82, 'rgba(88, 28, 135, 0.42)');
      aura.addColorStop(1, 'rgba(88, 28, 135, 0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, width, height);

      ctx.save();
      ctx.beginPath();
      ctx.arc(width * 0.54, height * 0.56, height * 0.27, 0, Math.PI * 2);
      const sunGrad = ctx.createLinearGradient(0, height * 0.28, 0, height * 0.84);
      sunGrad.addColorStop(0, 'rgba(251, 191, 36, 0.95)');
      sunGrad.addColorStop(0.55, 'rgba(249, 115, 22, 0.92)');
      sunGrad.addColorStop(1, 'rgba(225, 29, 72, 0.9)');
      ctx.fillStyle = sunGrad;
      ctx.fill();
      ctx.lineWidth = 9;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.stroke();
      ctx.restore();

      const shapes: Array<{ pts: [number, number][]; fill: string }> = [
        {
          pts: [[0.24, 0.78], [0.36, 0.38], [0.45, 0.58], [0.55, 0.32], [0.64, 0.74], [0.52, 0.68], [0.44, 0.82]],
          fill: '#38bdf8',
        },
        {
          pts: [[0.48, 0.80], [0.60, 0.42], [0.73, 0.36], [0.78, 0.64], [0.66, 0.82]],
          fill: '#f43f5e',
        },
        {
          pts: [[0.30, 0.66], [0.43, 0.48], [0.58, 0.54], [0.49, 0.76]],
          fill: '#facc15',
        },
      ];
      for (const s of shapes) {
        ctx.beginPath();
        s.pts.forEach(([ux, uy], i) => {
          const x = ux * width + 10;
          const y = uy * height + 12;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fill();

        ctx.beginPath();
        s.pts.forEach(([ux, uy], i) => {
          const x = ux * width;
          const y = uy * height;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      for (const [x0, y0, x1, y1] of [
        [0.365, 0.41, 0.435, 0.56],
        [0.605, 0.44, 0.715, 0.39],
        [0.32, 0.64, 0.42, 0.50],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x0 * width, y0 * height);
        ctx.lineTo(x1 * width, y1 * height);
        ctx.stroke();
      }

      const rng = mulberry32(1337);
      for (let i = 0; i < 22; i++) {
        const dx = (0.25 + rng() * 0.53) * width;
        const dy = (0.62 + rng() * 0.18) * height;
        const len = 14 + rng() * 44;
        ctx.strokeStyle =
          i % 3 === 0 ? 'rgba(56, 189, 248, 0.85)' : i % 3 === 1 ? 'rgba(244, 63, 94, 0.85)' : 'rgba(15, 23, 42, 0.85)';
        ctx.lineWidth = 2 + rng() * 2.5;
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.lineTo(dx, dy + len);
        ctx.stroke();
      }
    } else if (variant === 'left_alley') {
      // Left alley / left wing mural: sweeping electric magenta, ultraviolet, acid-lime & cyan
      // retro-wave ribbons, bold overlapping street-art bubble lobes, and stencil starbursts.
      const aura = ctx.createRadialGradient(width * 0.46, height * 0.56, 18, width * 0.48, height * 0.56, width * 0.42);
      aura.addColorStop(0, 'rgba(168, 85, 247, 0.86)');
      aura.addColorStop(0.5, 'rgba(236, 72, 153, 0.68)');
      aura.addColorStop(0.85, 'rgba(30, 27, 75, 0.38)');
      aura.addColorStop(1, 'rgba(30, 27, 75, 0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, width, height);

      // Sweeping S-curve neon ribbons across the brick courses.
      const ribbons: Array<{ color: string; yOff: number; thick: number }> = [
        { color: '#1e1b4b', yOff: 14, thick: 46 },
        { color: '#22d3ee', yOff: 0, thick: 34 },
        { color: '#a3e635', yOff: -24, thick: 24 },
        { color: '#f472b6', yOff: 26, thick: 20 },
      ];
      for (const rib of ribbons) {
        ctx.beginPath();
        ctx.moveTo(width * 0.08, height * 0.72 + rib.yOff);
        ctx.bezierCurveTo(
          width * 0.32,
          height * 0.24 + rib.yOff,
          width * 0.64,
          height * 0.88 + rib.yOff,
          width * 0.92,
          height * 0.36 + rib.yOff,
        );
        ctx.strokeStyle = rib.color;
        ctx.lineWidth = rib.thick;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Bold bubble-letter / organic pop-art capsules with 3D black extrusions.
      const bubbles: Array<[number, number, number, number, number, string]> = [
        [0.24, 0.58, 0.075, 0.17, -0.22, '#ec4899'],
        [0.37, 0.52, 0.082, 0.2, 0.14, '#a3e635'],
        [0.51, 0.57, 0.085, 0.18, -0.12, '#38bdf8'],
        [0.65, 0.51, 0.078, 0.19, 0.2, '#facc15'],
        [0.77, 0.58, 0.068, 0.15, -0.18, '#c084fc'],
      ];
      for (const [bx, by, rx, ry, rot, fill] of bubbles) {
        ctx.save();
        ctx.translate(bx * width + 11, by * height + 13);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * width, ry * height, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(bx * width, by * height);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx * width, ry * height, 0, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();

        // Glossy white aerosol shine arc inside each bubble.
        ctx.beginPath();
        ctx.ellipse(-rx * width * 0.28, -ry * height * 0.28, rx * width * 0.28, ry * height * 0.36, -0.3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.fill();
        ctx.restore();
      }

      // Crisp white 4-point street-art sparkles & neon drips.
      const rng = mulberry32(2089);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      for (const [sx, sy, sr] of [[0.16, 0.36, 18], [0.58, 0.28, 22], [0.84, 0.68, 16]]) {
        const px = sx * width;
        const py = sy * height;
        ctx.beginPath();
        ctx.moveTo(px, py - sr);
        ctx.quadraticCurveTo(px, py, px + sr, py);
        ctx.quadraticCurveTo(px, py, px, py + sr);
        ctx.quadraticCurveTo(px, py, px - sr, py);
        ctx.quadraticCurveTo(px, py, px, py - sr);
        ctx.fill();
      }
      for (let i = 0; i < 24; i++) {
        const dx = (0.16 + rng() * 0.68) * width;
        const dy = (0.62 + rng() * 0.18) * height;
        ctx.strokeStyle = i % 2 === 0 ? 'rgba(163, 230, 53, 0.88)' : 'rgba(236, 72, 153, 0.88)';
        ctx.lineWidth = 2.2 + rng() * 2.4;
        ctx.beginPath();
        ctx.moveTo(dx, dy);
        ctx.lineTo(dx, dy + 16 + rng() * 42);
        ctx.stroke();
      }
    } else {
      // 'right_wing': bold cobalt-blue, amber-gold, coral & mint geometric Bauhaus / street-sunburst mural.
      const aura = ctx.createLinearGradient(width * 0.12, height * 0.22, width * 0.88, height * 0.82);
      aura.addColorStop(0, 'rgba(37, 99, 235, 0.85)');
      aura.addColorStop(0.52, 'rgba(13, 148, 136, 0.78)');
      aura.addColorStop(1, 'rgba(245, 158, 11, 0.82)');
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(width * 0.12, height * 0.24, width * 0.76, height * 0.58, 36);
      ctx.fillStyle = aura;
      ctx.fill();
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)';
      ctx.stroke();
      ctx.restore();

      // Concentric stepped arches & diagonal sunburst wedges.
      const cx = width * 0.48;
      const cy = height * 0.78;
      for (let w = 0; w < 9; w++) {
        const a0 = -Math.PI + (w / 9) * Math.PI;
        const a1 = a0 + Math.PI / 13;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, width * 0.34, a0, a1);
        ctx.closePath();
        ctx.fillStyle = w % 2 === 0 ? 'rgba(251, 191, 36, 0.88)' : 'rgba(251, 113, 133, 0.86)';
        ctx.fill();
      }

      const rings: Array<[number, string]> = [
        [height * 0.36, '#0f172a'],
        [height * 0.31, '#fb7185'],
        [height * 0.22, '#fef08a'],
        [height * 0.13, '#2563eb'],
      ];
      for (const [rad, col] of rings) {
        ctx.beginPath();
        ctx.arc(cx, cy, rad, Math.PI, 0);
        ctx.closePath();
        ctx.fillStyle = col;
        ctx.fill();
      }

      // Floating geometric Mint & Cobalt arrow/lightning blocks on the right half.
      const blocks: Array<{ pts: [number, number][]; fill: string }> = [
        { pts: [[0.58, 0.30], [0.82, 0.34], [0.72, 0.54], [0.85, 0.58], [0.62, 0.76], [0.66, 0.52], [0.54, 0.48]], fill: '#6ee7b7' },
        { pts: [[0.17, 0.34], [0.33, 0.28], [0.29, 0.56], [0.16, 0.62]], fill: '#fbbf24' },
      ];
      for (const b of blocks) {
        ctx.beginPath();
        b.pts.forEach(([ux, uy], i) => {
          if (i === 0) ctx.moveTo(ux * width + 9, uy * height + 10);
          else ctx.lineTo(ux * width + 9, uy * height + 10);
        });
        ctx.closePath();
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
        ctx.fill();

        ctx.beginPath();
        b.pts.forEach(([ux, uy], i) => {
          if (i === 0) ctx.moveTo(ux * width, uy * height);
          else ctx.lineTo(ux * width, uy * height);
        });
        ctx.closePath();
        ctx.fillStyle = b.fill;
        ctx.fill();
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#0f172a';
        ctx.stroke();
      }
    }

    // Blend mural onto brickwork, letting recessed mortar stay slightly darker/textured.
    const paint = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const pa = (paint[idx + 3] / 255) * (heights[i] < 0.32 ? 0.72 : 0.92);
      if (pa <= 0.004) continue;
      // Modulate paint slightly by brick micro-grain so it reads as painted brick, not vinyl.
      const grain = 0.9 + 0.18 * heights[i];
      baseRgba[idx] = Math.min(255, Math.round(baseRgba[idx] * (1 - pa) + paint[idx] * grain * pa));
      baseRgba[idx + 1] = Math.min(255, Math.round(baseRgba[idx + 1] * (1 - pa) + paint[idx + 1] * grain * pa));
      baseRgba[idx + 2] = Math.min(255, Math.round(baseRgba[idx + 2] * (1 - pa) + paint[idx + 2] * grain * pa));
    }
  } else {
    // Headless test fallback when 2D canvas is absent: tint distinct mural zones per variant.
    const bandColor: [number, number, number] =
      variant === 'center' ? [34, 190, 224] : variant === 'left_alley' ? [228, 72, 168] : [48, 118, 240];
    for (let py = Math.floor(height * 0.3); py < Math.floor(height * 0.75); py++) {
      for (let px = Math.floor(width * 0.2); px < Math.floor(width * 0.8); px++) {
        const idx = (py * width + px) * 4;
        baseRgba[idx] = Math.round(baseRgba[idx] * 0.35 + bandColor[0] * 0.65);
        baseRgba[idx + 1] = Math.round(baseRgba[idx + 1] * 0.35 + bandColor[1] * 0.65);
        baseRgba[idx + 2] = Math.round(baseRgba[idx + 2] * 0.35 + bandColor[2] * 0.65);
      }
    }
  }

  // Flip rows vertically because makeAlbedoDataTexture sets flipY = true and baseRgba was drawn top-down.
  const flipped = new Uint8Array(width * height * 4);
  const flippedH = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = height - 1 - y;
    flipped.set(baseRgba.subarray(sy * width * 4, (sy + 1) * width * 4), y * width * 4);
    flippedH.set(heights.subarray(sy * width, (sy + 1) * width), y * width);
  }
  const map = makeAlbedoDataTexture(flipped, width, height, [1, 1], true);
  map.flipY = false;
  const normalMap = heightToNormalTexture(flippedH, width, height, 3.8, [1, 1]);
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
  normalMap.wrapT = THREE.ClampToEdgeWrapping;
  return { map, normalMap };
}

/** Brushed concrete sidewalk slabs with 1.2 m expansion joints for Urban. */
export function buildConcreteSidewalkTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const size = 512;
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const mottling = periodicFbm2(u, v, 4, 4, 4, 557);
      const speck = hash2(x, y, 563);
      const jx = Math.min(u, 1 - u);
      const jy = Math.min(v, 1 - v);
      const joint = smoothstep(0.003, 0.012, Math.min(jx, jy));
      const h = (0.55 + mottling * 0.25 + speck * 0.2) * joint;
      heights[y * size + x] = h;
      const base = Math.round((166 + (mottling - 0.5) * 30 + (speck - 0.5) * 22) * (0.62 + 0.38 * joint));
      const idx = (y * size + x) * 4;
      data[idx] = Math.min(255, Math.max(55, base + 2));
      data[idx + 1] = Math.min(255, Math.max(55, base));
      data[idx + 2] = Math.min(255, Math.max(55, base - 4));
      data[idx + 3] = 255;
    }
  }
  return {
    map: makeAlbedoDataTexture(data, size, size, [20, 20]),
    normalMap: heightToNormalTexture(heights, size, size, 2.6, [20, 20]),
  };
}

/**
 * Laminated oak butcher-block wood top, oiled American black walnut tabletop,
 * or staggered-plank honey-oak hardwood flooring with seamless wrap-around joints.
 */
export function buildWoodTextures(style: 'butcher_oak' | 'walnut' | 'oak_floor'): {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
} {
  if (style === 'oak_floor') {
    // 512 (lengthwise along X) x 1024 (across 20 plank rows -> 51.2 px per 140 mm plank).
    const width = 512;
    const height = 1024;
    const data = new Uint8Array(width * height * 4);
    const heights = new Float32Array(width * height);
    const rows = 20;
    const rowCuts: Array<[number, number, number]> = [];
    const boardSeeds = new Float32Array(rows * 3);
    const warmShifts = new Float32Array(rows * 3);
    for (let r = 0; r < rows; r++) {
      const base = ((r * 0.37 + 0.19 * hash2(r, 1, 709)) % 1 + 1) % 1;
      const p0 = base;
      const p1 = (base + 0.31 + 0.08 * hash2(r, 2, 709)) % 1;
      const p2 = (base + 0.66 + 0.08 * hash2(r, 3, 709)) % 1;
      const sorted = [p0, p1, p2].sort((a, b) => a - b) as [number, number, number];
      rowCuts.push(sorted);
      for (let p = 0; p < 3; p++) {
        boardSeeds[r * 3 + p] = hash2(r * 7 + p, p * 13 + r, 727);
        warmShifts[r * 3 + p] = (hash2(r, p, 739) - 0.5) * 14;
      }
    }

    for (let y = 0; y < height; y++) {
      const v = (y + 0.5) / height;
      const rowFloat = v * rows;
      const row = Math.floor(rowFloat) % rows;
      const rowLocal = rowFloat - Math.floor(rowFloat);
      const sideDist = Math.min(rowLocal, 1 - rowLocal);
      const sideBevel = smoothstep(0.0, 0.028, sideDist);
      const [c0, c1, c2] = rowCuts[row];

      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width;
        let plankIdx: number;
        let endDist: number;
        if (u >= c0 && u < c1) {
          plankIdx = 0;
          endDist = Math.min(u - c0, c1 - u);
        } else if (u >= c1 && u < c2) {
          plankIdx = 1;
          endDist = Math.min(u - c1, c2 - u);
        } else {
          plankIdx = 2;
          const dToC2 = u >= c2 ? u - c2 : u + 1 - c2;
          const dToC0 = u < c0 ? c0 - u : 1 - u + c0;
          endDist = Math.min(dToC2, dToC0);
        }

        const endBevel = smoothstep(0.0, 0.0022, endDist);
        const seam = Math.min(sideBevel, endBevel);

        const boardSeed = boardSeeds[row * 3 + plankIdx];
        const warmShift = warmShifts[row * 3 + plankIdx];
        const gu = (u + boardSeed * 0.73) % 1;
        const gv = (rowLocal * 0.25 + boardSeed * 0.41) % 1;
        const warp = periodicFbm2(gu, gv, 3, 6, 3, 751 + plankIdx * 19);
        const fineGrain = periodicFbm2(gu, v, 24, 96, 2, 769);
        const rings = 0.5 + 0.5 * Math.sin((rowLocal * 2.8 + warp * 5.2 + boardSeed * 6.0) * Math.PI);
        const pores = hash2(x, y >> 1, 787) > 0.91 ? 0.07 : 0;

        const tone =
          (0.79 + 0.17 * rings + 0.06 * (fineGrain - 0.5) + (boardSeed - 0.5) * 0.16 - pores) *
          (0.58 + 0.42 * seam);
        const rCol = 192 * tone + warmShift * 0.6;
        const gCol = 148 * tone + warmShift * 0.35;
        const bCol = 102 * tone + warmShift * 0.15;

        heights[y * width + x] = (0.55 + rings * 0.2 + fineGrain * 0.12 - pores) * (0.35 + 0.65 * seam);
        const idx = (y * width + x) * 4;
        data[idx] = Math.min(255, Math.max(28, Math.round(rCol)));
        data[idx + 1] = Math.min(255, Math.max(20, Math.round(gCol)));
        data[idx + 2] = Math.min(255, Math.max(14, Math.round(bCol)));
        data[idx + 3] = 255;
      }
    }

    return {
      map: makeAlbedoDataTexture(data, width, height, [2, 2]),
      normalMap: heightToNormalTexture(heights, width, height, 1.45, [2, 2]),
    };
  }

  const size = 512;
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);

  const staves = style === 'butcher_oak' ? 16 : 5;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const staveIdx = Math.floor(v * staves);
      const staveLocal = v * staves - staveIdx;
      const seam = style === 'walnut'
        ? 1
        : smoothstep(0.0, 0.018, Math.min(staveLocal, 1 - staveLocal));
      const staveSeed = hash2(staveIdx, 7, style === 'walnut' ? 601 : 613);
      const gu = (u + staveSeed * 0.61) % 1;
      const warp = periodicFbm2(gu, v, 3, 12, 4, 631);
      const rings = 0.5 + 0.5 * Math.sin((v * staves * 4.0 + warp * 4.4 + staveSeed * 6) * Math.PI);
      const pores = hash2(x, Math.floor(y * 0.5), 647);

      let r: number, g: number, b: number;
      if (style === 'walnut') {
        const tone = 0.68 + 0.32 * rings + (staveSeed - 0.5) * 0.08 - (pores > 0.9 ? 0.11 : 0);
        r = 108 * tone + 16;
        g = 72 * tone + 10;
        b = 48 * tone + 7;
      } else {
        const tone = (0.78 + 0.22 * rings + (staveSeed - 0.5) * 0.18 - (pores > 0.92 ? 0.1 : 0)) * (0.78 + 0.22 * seam);
        r = 204 * tone;
        g = 158 * tone;
        b = 108 * tone;
      }

      heights[y * size + x] = (0.5 + rings * 0.25 - (pores > 0.9 ? 0.2 : 0)) * seam;
      const idx = (y * size + x) * 4;
      data[idx] = Math.min(255, Math.max(20, Math.round(r)));
      data[idx + 1] = Math.min(255, Math.max(15, Math.round(g)));
      data[idx + 2] = Math.min(255, Math.max(10, Math.round(b)));
      data[idx + 3] = 255;
    }
  }
  return {
    map: makeAlbedoDataTexture(data, size, size, [1, 1]),
    normalMap: heightToNormalTexture(heights, size, size, style === 'walnut' ? 1.0 : 1.6, [1, 1]),
  };
}

/**
 * Physically accurate 600 mm x 450 mm (A2) self-healing cutting mat texture:
 * every square is 10 mm x 10 mm in world metres, with 50 mm major lines,
 * border millimetre ticks, and 30° / 45° / 60° angle guides.
 */
export function buildCuttingMatTexture(): THREE.Texture {
  const width = 1200; // 2 px per mm across 600 mm
  const height = 900; // 2 px per mm across 450 mm
  const c2d = get2dCanvas(width, height);
  if (!c2d) {
    const fallback = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < fallback.length; i += 4) {
      fallback[i] = 29;
      fallback[i + 1] = 91;
      fallback[i + 2] = 76;
      fallback[i + 3] = 255;
    }
    return makeAlbedoDataTexture(fallback, 16, 16, [1, 1], true);
  }

  const { canvas, ctx } = c2d;
  // Matte teal-emerald ESD cutting mat base.
  ctx.fillStyle = '#1d5b4c';
  ctx.fillRect(0, 0, width, height);

  // Subtle matte vinyl micro-speckle around perimeter.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  for (let y = 0; y < height; y += 6) {
    for (let x = (y % 12 === 0 ? 0 : 3); x < width; x += 6) {
      ctx.fillRect(x, y, 2, 2);
    }
  }

  // Printed grid covers central 560 x 400 mm (20 mm margin left/right, 25 mm top/bottom).
  const marginX = 40; // 20 mm * 2 px/mm
  const marginY = 50; // 25 mm * 2 px/mm
  const gridW = width - marginX * 2; // 1120 px = 560 mm
  const gridH = height - marginY * 2; // 800 px = 400 mm
  const cx = width / 2;
  const cy = height / 2;

  // Minor 10 mm lines (20 px spacing) centered on (cx, cy).
  ctx.strokeStyle = 'rgba(212, 243, 232, 0.34)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let mm = -280; mm <= 280; mm += 10) {
    if (mm % 50 === 0) continue;
    const x = cx + mm * 2;
    ctx.moveTo(x, marginY);
    ctx.lineTo(x, height - marginY);
  }
  for (let mm = -200; mm <= 200; mm += 10) {
    if (mm % 50 === 0) continue;
    const y = cy + mm * 2;
    ctx.moveTo(marginX, y);
    ctx.lineTo(width - marginX, y);
  }
  ctx.stroke();

  // Major 50 mm lines (100 px spacing).
  ctx.strokeStyle = 'rgba(226, 250, 241, 0.68)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let mm = -250; mm <= 250; mm += 50) {
    const x = cx + mm * 2;
    ctx.moveTo(x, marginY);
    ctx.lineTo(x, height - marginY);
  }
  for (let mm = -200; mm <= 200; mm += 50) {
    const y = cy + mm * 2;
    ctx.moveTo(marginX, y);
    ctx.lineTo(width - marginX, y);
  }
  ctx.stroke();

  // Outer border frame + 5 mm tick marks.
  ctx.strokeStyle = 'rgba(232, 252, 245, 0.82)';
  ctx.lineWidth = 2.2;
  ctx.strokeRect(marginX, marginY, gridW, gridH);

  ctx.lineWidth = 1.1;
  ctx.beginPath();
  for (let mm = -280; mm <= 280; mm += 5) {
    const x = cx + mm * 2;
    const tick = mm % 10 === 0 ? 10 : 6;
    ctx.moveTo(x, height - marginY);
    ctx.lineTo(x, height - marginY + tick);
    ctx.moveTo(x, marginY);
    ctx.lineTo(x, marginY - tick);
  }
  ctx.stroke();

  // Subtle 45° & 30° protractor lines near bottom-left corner, plus centre target circle.
  ctx.save();
  ctx.strokeStyle = 'rgba(212, 243, 232, 0.25)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1.2;
  for (const deg of [30, 45, 60]) {
    const rad = (deg * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(marginX, height - marginY);
    ctx.lineTo(marginX + Math.cos(rad) * 240, height - marginY - Math.sin(rad) * 240);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2); // Ø 20 mm origin ring
  ctx.stroke();
  ctx.restore();

  // Centimetre ruler numbers along the front/bottom border.
  ctx.fillStyle = 'rgba(226, 250, 241, 0.8)';
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.textAlign = 'center';
  for (let cm = -25; cm <= 25; cm += 5) {
    const x = cx + cm * 20;
    ctx.fillText(`${cm === 0 ? '0 cm' : Math.abs(cm)}`, x, height - marginY + 24);
  }
  ctx.fillText('A2  600 × 450 mm  •  10 mm GRID', width - 175, marginY - 16);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Perforated workshop pegboard texture (6 mm holes on a true 25.4 mm / 1-inch grid). */
export function buildPegboardTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const dy = (y + 0.5) / size - 0.5;
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const r = Math.hypot(dx, dy);
      const hole = 1 - smoothstep(0.11, 0.145, r);
      const rim = smoothstep(0.11, 0.16, r) * (1 - smoothstep(0.16, 0.22, r));
      const base = 214 - hole * 172 - rim * 18 + (hash2(x, y, 881) - 0.5) * 8;
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(base);
      data[idx + 1] = Math.round(base - 2);
      data[idx + 2] = Math.round(base - 7);
      data[idx + 3] = 255;
    }
  }
  // 1.60 m x 0.85 m board at 25.4 mm pitch -> 63 x 33 holes!
  return makeAlbedoDataTexture(data, size, size, [63, 33]);
}

/** Woven bouclé / jute living-room area rug texture for Cozy Coffee Table. */
export function buildWovenRugTextures(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = 0.5 + 0.5 * Math.sin((x / 3.2) * Math.PI * 2);
      const weft = 0.5 + 0.5 * Math.sin((y / 3.2) * Math.PI * 2);
      const weave = ((Math.floor(x / 3.2) + Math.floor(y / 3.2)) & 1) === 0 ? warp : weft;
      const fleck = (hash2(x, y, 991) - 0.5) * 20;
      heights[y * size + x] = 0.35 + weave * 0.55 + hash2(x, y, 997) * 0.1;
      const base = 212 + (weave - 0.5) * 28 + fleck;
      const idx = (y * size + x) * 4;
      data[idx] = Math.min(255, Math.max(120, Math.round(base)));
      data[idx + 1] = Math.min(255, Math.max(110, Math.round(base - 11)));
      data[idx + 2] = Math.min(255, Math.max(95, Math.round(base - 26)));
      data[idx + 3] = 255;
    }
  }
  return {
    map: makeAlbedoDataTexture(data, size, size, [26, 18]),
    normalMap: heightToNormalTexture(heights, size, size, 2.1, [26, 18]),
  };
}
