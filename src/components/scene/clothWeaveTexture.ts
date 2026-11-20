/**
 * Each fabric's surface, as a normal map drawn once and shared: the knit of
 * jersey and rib, the over-and-under of a plain weave, denim's twill, the
 * grid of a ripstop shell, leather's grain. Laid on the cloth by its flat
 * pattern in metres (the `uv1` channel), so a tile is a real size of cloth
 * and every panel of a garment shows the same weave at the same scale.
 * Without it every fabric read as smooth plastic up close.
 */
import * as THREE from 'three';
import type { ClothMaterialName } from '../../types/cloth';

const SIZE = 128;

interface Weave {
  /** Metres of cloth one tile covers. */
  tile: number;
  /** How strongly it shows. */
  depth: number;
  /** Height of the surface at (x, y) in [0, 1) of the tile, about 0..1. */
  height: (x: number, y: number) => number;
}

/** A hash in [0, 1), for grain. */
const hash = (i: number, j: number) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
/** Smooth value noise, tiling with period `p` cells. */
function noise(x: number, y: number, p: number) {
  const fx = x * p, fy = y * p, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const w = (a: number) => ((a % p) + p) % p;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(w(i), w(j)), b = hash(w(i + 1), w(j)), c = hash(w(i), w(j + 1)), d = hash(w(i + 1), w(j + 1));
  return a + (b - a) * s(u) + (c - a) * s(v) + (a - b - c + d) * s(u) * s(v);
}
/** A thread's rounded profile across it, t in [0, 1). */
const thread = (t: number) => Math.sin(Math.PI * (t - Math.floor(t)));

/** Knit: columns of interlocking V loops, `cols` across and `rows` up a tile. */
const knit = (cols: number, rows: number) => (x: number, y: number) => {
  const c = x * cols, r = y * rows, side = c - Math.floor(c) < 0.5 ? 1 : -1;
  // Each loop leans out from its column's middle, a V.
  return thread(c * 2 + side * (r - Math.floor(r)) * 0.6) * (0.6 + 0.4 * thread(r));
};
/** Plain weave: warp and weft over and under, `n` threads a tile. */
const plain = (n: number) => (x: number, y: number) => {
  const i = Math.floor(x * n), j = Math.floor(y * n);
  return (i + j) % 2 ? thread(x * n) * 0.9 + 0.1 * thread(y * n) : thread(y * n) * 0.9 + 0.1 * thread(x * n);
};
/** Twill: diagonal ribs, `n` threads a tile, warp over three under one. */
const twill = (n: number) => (x: number, y: number) => 0.75 * thread(x * n + y * n) + 0.25 * thread(y * n) + 0.15 * noise(x, y, 16);

const WEAVES: Record<ClothMaterialName, Weave> = {
  jersey: { tile: 0.012, depth: 0.6, height: knit(8, 10) },
  rib: { tile: 0.016, depth: 0.9, height: (x, y) => 0.7 * thread(x * 6) + 0.3 * knit(12, 12)(x, y) },
  spandex: { tile: 0.006, depth: 0.3, height: knit(8, 10) },
  woven: { tile: 0.008, depth: 0.45, height: plain(16) },
  canvas: { tile: 0.012, depth: 0.8, height: plain(12) },
  // Marine ripstop nylon: tight 70D plain weave crossed every 5 mm by crisp reinforcing rip-arrest ribs.
  ripstop: {
    tile: 0.02,
    depth: 0.55,
    height: (x, y) => 0.45 * plain(32)(x, y) + 0.55 * Math.max(Math.pow(thread(x * 4), 10), Math.pow(thread(y * 4), 10)),
  },
  shadeCloth: { tile: 0.02, depth: 0.9, height: plain(8) },
  denim: { tile: 0.012, depth: 0.8, height: twill(12) },
  leather: { tile: 0.04, depth: 0.5, height: (x, y) => 0.6 * noise(x, y, 24) + 0.4 * noise(x, y, 48) },
  // A ripstop shell: a fine weave with a heavier thread every 6 mm, barely
  // proud of it (stronger, a puffer read as waffle).
  taffeta: { tile: 0.024, depth: 0.25, height: (x, y) => 0.6 * plain(48)(x, y) + 0.4 * Math.max(Math.pow(thread(x * 4), 8), Math.pow(thread(y * 4), 8)) },
  velvet: { tile: 0.01, depth: 0.25, height: (x, y) => noise(x, y, 32) },
};

const cache = new Map<ClothMaterialName, THREE.DataTexture>();

/** The fabric's normal map, shared by every panel of it; its repeat in metres is `1 / weaveTile(name)`. */
export function weaveTexture(name: ClothMaterialName): THREE.DataTexture {
  let tex = cache.get(name);
  if (tex) return tex;
  const w = WEAVES[name] ?? WEAVES.woven;
  const h = new Float32Array(SIZE * SIZE);
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) h[j * SIZE + i] = w.height(i / SIZE, j / SIZE);
  const px = new Uint8Array(SIZE * SIZE * 4);
  const at = (i: number, j: number) => h[((j + SIZE) % SIZE) * SIZE + ((i + SIZE) % SIZE)];
  const k = w.depth * 4;
  for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) {
    const dx = (at(i + 1, j) - at(i - 1, j)) * k, dy = (at(i, j + 1) - at(i, j - 1)) * k;
    const l = Math.hypot(dx, dy, 1), o = 4 * (j * SIZE + i);
    px[o] = Math.round((0.5 - dx / l / 2) * 255); px[o + 1] = Math.round((0.5 - dy / l / 2) * 255); px[o + 2] = Math.round((0.5 + 0.5 / l) * 255); px[o + 3] = 255;
  }
  tex = new THREE.DataTexture(px, SIZE, SIZE, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.channel = 1;
  tex.repeat.set(1 / w.tile, 1 / w.tile);
  tex.needsUpdate = true;
  cache.set(name, tex);
  return tex;
}
