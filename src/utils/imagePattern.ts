// ---------------------------------------------------------------------------
// A picture as a surface pattern: a height map or any image, raised from a
// face or cut into it, the way the image-to-relief import makes a slab but on
// the body itself -- round a candle, across a lid, over a revolved vase.
//
// The picture is only needed once: `prepare` decodes it in the browser and
// saves it in the options as a grey grid (`imageGrid`, one byte a pixel,
// base64, at most IMAGE_MAX_PX a side). `build` resamples that grid onto
// whatever grid it is asked for, in the worker, and needs nothing else. The
// original file is not kept: a scene stays a few hundred kilobytes heavier,
// not the size of the photo.
//
// On a surface that goes all the way round, the picture is placed once and
// stretched to the circumference (`wraps`), so a height map drawn as the
// unrolled side of a cylinder closes on itself.
// ---------------------------------------------------------------------------

import { num, str, type PatternOptions, type PatternSpec } from './patternKit';
import { sampleLuminanceGrid } from './heightmapMesh';

/** The longest side kept. 0.1 mm a pixel round a 45 mm candle is 1414; this is 0.14. */
export const IMAGE_MAX_PX = 1024;

export interface ImageGrid {
  width: number;
  height: number;
  /** 0..1, row-major, row 0 the top of the picture. */
  data: Float32Array;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * The options to save for decoded RGBA pixels: the picture as grey, scaled to
 * at most IMAGE_MAX_PX a side. Transparent pixels count as black, as in the
 * image-to-relief import.
 */
export function imageGridOptions(data: Uint8ClampedArray, width: number, height: number): PatternOptions {
  const scale = Math.min(1, IMAGE_MAX_PX / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const grey = sampleLuminanceGrid(data, width, height, w, h);
  const bytes = new Uint8Array(w * h);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(Math.max(0, Math.min(1, grey[i])) * 255);
  return { imageGrid: toBase64(bytes), imageW: w, imageH: h };
}

// The last grid decoded, and the last one blurred: `build` runs once per
// rebuild with the same options, and a megabyte of base64 is worth decoding once.
let decoded: { key: string; grid: ImageGrid } | null = null;
let blurred: { key: string; blur: number; grid: ImageGrid } | null = null;

export function decodeImageGrid(opts: PatternOptions): ImageGrid | null {
  const b64 = str(opts, 'imageGrid', '');
  const width = num(opts, 'imageW', 0), height = num(opts, 'imageH', 0);
  if (!b64 || width < 1 || height < 1) return null;
  if (decoded?.key !== b64) {
    const bytes = fromBase64(b64);
    if (bytes.length !== width * height) return null;
    const data = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) data[i] = bytes[i] / 255;
    decoded = { key: b64, grid: { width, height, data } };
  }
  return decoded.grid;
}

/** A box blur of `radius` pixels, run twice (close to a Gaussian). */
function blurGrid(g: ImageGrid, radius: number): ImageGrid {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return g;
  const { width: w, height: h } = g;
  let src = g.data;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; }
        }
        tmp[y * w + x] = s / n;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; }
        }
        out[y * w + x] = s / n;
      }
    }
    src = out;
  }
  return { width: w, height: h, data: src };
}

function sourceGrid(opts: PatternOptions): ImageGrid | null {
  const g = decodeImageGrid(opts);
  if (!g) return null;
  const blur = num(opts, 'blurPx', 0);
  if (blur <= 0) return g;
  const key = str(opts, 'imageGrid', '');
  if (blurred?.key !== key || blurred.blur !== blur) blurred = { key, blur, grid: blurGrid(g, blur) };
  return blurred.grid;
}

/** Bilinear, `x` and `y` in pixels, clamped to the picture. */
function at(g: ImageGrid, x: number, y: number): number {
  const fx = Math.min(g.width - 1, Math.max(0, x));
  const fy = Math.min(g.height - 1, Math.max(0, y));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(g.width - 1, x0 + 1), y1 = Math.min(g.height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const d = g.data, w = g.width;
  return (d[y0 * w + x0] * (1 - tx) + d[y0 * w + x1] * tx) * (1 - ty) + (d[y1 * w + x0] * (1 - tx) + d[y1 * w + x1] * tx) * ty;
}

/** How far apart the picture's left and right edges are, 0..1: what a wrap would show as a step. */
export function edgeMismatch(g: ImageGrid): number {
  let worst = 0;
  for (let y = 0; y < g.height; y++) {
    worst = Math.max(worst, Math.abs(g.data[y * g.width] - g.data[y * g.width + g.width - 1]));
  }
  return worst;
}

export const IMAGE_PATTERN: PatternSpec = {
  id: 'image',
  label: 'Image / height map',
  blurb: 'A picture raised from the face or cut into it: light parts high, dark parts low. Round a cylinder it wraps once.',
  group: 'Ornament',
  wraps: true,
  depthFraction: 0.25,
  defaults: {
    image: '',
    imageName: '',
    imageGrid: '',
    imageW: 0,
    imageH: 0,
    mapping: 'white-high',
    fit: 'stretch',
    widthMm: 40,
    offsetXMm: 0,
    offsetYMm: 0,
    blurPx: 0,
  },
  fields: [
    { kind: 'image', key: 'image', label: 'Picture', hint: 'PNG or JPG. A grey height map works best: white is the highest point, black the face.' },
    {
      kind: 'choice', key: 'mapping', label: 'Height', options: [
        { value: 'white-high', label: 'Light is high' },
        { value: 'white-low', label: 'Dark is high' },
      ],
    },
    {
      kind: 'choice', key: 'fit', label: 'Size', options: [
        { value: 'stretch', label: 'Fill the face' },
        { value: 'contain', label: 'Fit, keep its shape' },
        { value: 'width', label: 'Set width' },
      ],
      hint: 'Fill stretches the picture over the face, and once round a cylinder.',
    },
    { kind: 'number', key: 'widthMm', label: 'Width', min: 1, max: 2000, step: 1, unit: 'mm', when: { key: 'fit', is: ['width'] } },
    { kind: 'number', key: 'offsetXMm', label: 'Move across', min: -2000, max: 2000, step: 0.5, unit: 'mm', when: { key: 'fit', is: ['contain', 'width'] } },
    { kind: 'number', key: 'offsetYMm', label: 'Move up', min: -2000, max: 2000, step: 0.5, unit: 'mm', when: { key: 'fit', is: ['contain', 'width'] } },
    { kind: 'number', key: 'blurPx', label: 'Smooth', min: 0, max: 8, step: 1, unit: 'px', hint: 'Softens pixel steps and photo noise.' },
  ],
  async prepare(opts) {
    const o = { ...IMAGE_PATTERN.defaults, ...opts };
    const src = str(o, 'image', '');
    if (!src) {
      if (!decodeImageGrid(o)) throw new Error('Choose a picture first.');
      return o;
    }
    const { decodeImageUrl } = await import('./decodeImage');
    const img = await decodeImageUrl(src, IMAGE_MAX_PX * 2);
    // The picture itself is not kept: the grid is everything `build` needs.
    return { ...o, ...imageGridOptions(img.data, img.width, img.height), image: '' };
  },
  build(cols, rows, extent, opts) {
    const out = new Float32Array(cols * rows);
    const g = sourceGrid(opts);
    if (!g || cols < 1 || rows < 1) return out;
    const W = extent.widthM * 1000, D = extent.depthM * 1000;
    const fit = str(opts, 'fit', 'stretch');
    // The picture's rectangle on the board, mm, about the board's middle.
    let pw = W, ph = D;
    if (fit === 'contain') {
      const s = Math.min(W / g.width, D / g.height);
      pw = g.width * s; ph = g.height * s;
    } else if (fit === 'width') {
      pw = Math.max(0.1, num(opts, 'widthMm', 40));
      ph = (pw * g.height) / g.width;
    }
    const shift = fit === 'stretch' ? [0, 0] : [num(opts, 'offsetXMm', 0), num(opts, 'offsetYMm', 0)];
    const left = (W - pw) / 2 + shift[0], bottom = (D - ph) / 2 + shift[1];
    const invert = str(opts, 'mapping', 'white-high') === 'white-low';
    const dx = cols > 1 ? W / (cols - 1) : 0, dy = rows > 1 ? D / (rows - 1) : 0;
    for (let r = 0; r < rows; r++) {
      // Board y runs up the face; the picture's row 0 is its top.
      const ty = (r * dy - bottom) / ph;
      if (ty < 0 || ty > 1) continue;
      const py = (1 - ty) * (g.height - 1);
      for (let c = 0; c < cols; c++) {
        const tx = (c * dx - left) / pw;
        if (tx < 0 || tx > 1) continue;
        const v = at(g, tx * (g.width - 1), py);
        out[r * cols + c] = invert ? 1 - v : v;
      }
    }
    return out;
  },
};
