// A picture as a surface pattern: decoded once into a grey grid, then built
// onto any board, and wrapped once round a cylinder with the picture's middle
// on the point picked.
import { describe, it, expect } from 'vitest';
import { IMAGE_PATTERN, decodeImageGrid, edgeMismatch, imageGridOptions, IMAGE_MAX_PX } from '../src/utils/imagePattern';
import { applySurfaceTextures, type SurfaceTexture } from '../src/utils/surfaceTexture';
import { texturedSurfaceKey } from '../src/utils/geomSurface';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGeom } from '../src/types/scene';

/** RGBA pixels from a grey function of (x, y), y = 0 the top row. */
function rgba(w: number, h: number, grey: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round(grey(x, y) * 255);
      out.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return out;
}

const optionsFor = (w: number, h: number, grey: (x: number, y: number) => number, more: Record<string, string | number> = {}) =>
  ({ ...IMAGE_PATTERN.defaults, ...imageGridOptions(rgba(w, h, grey), w, h), ...more });

const board = { widthM: 0.04, depthM: 0.02 };

describe('the picture as a grid', () => {
  it('keeps the picture as grey bytes, at most IMAGE_MAX_PX a side', () => {
    const o = optionsFor(64, 32, (x) => x / 63);
    const g = decodeImageGrid(o)!;
    expect([g.width, g.height]).toEqual([64, 32]);
    expect(g.data[0]).toBe(0);
    expect(g.data[63]).toBe(1);
    const big = optionsFor(3000, 1500, () => 0.5);
    expect([big.imageW, big.imageH]).toEqual([IMAGE_MAX_PX, IMAGE_MAX_PX / 2]);
    expect(String(big.imageGrid).length).toBeLessThan(1.4e6);
  });

  it('says how far a picture’s edges are from meeting round a wrap', () => {
    expect(edgeMismatch(decodeImageGrid(optionsFor(32, 8, (x) => x / 31))!)).toBe(1);
    expect(edgeMismatch(decodeImageGrid(optionsFor(32, 8, (x) => Math.sin((x / 32) * Math.PI) ** 2))!)).toBeLessThan(0.02);
  });

  it('refuses to prepare with no picture', async () => {
    await expect(IMAGE_PATTERN.prepare!({ ...IMAGE_PATTERN.defaults })).rejects.toThrow(/picture/);
  });

  it('keeps a prepared grid as it is', async () => {
    const o = optionsFor(8, 8, () => 1);
    expect(await IMAGE_PATTERN.prepare!(o)).toEqual(o);
  });
});

describe('building the picture onto a board', () => {
  it('fills the board, light high, the top of the picture up the face', () => {
    // Light at the top of the picture, dark at its bottom.
    const o = optionsFor(16, 16, (_x, y) => 1 - y / 15);
    const cols = 41, rows = 21;
    const h = IMAGE_PATTERN.build(cols, rows, board, o);
    expect(h[(rows - 1) * cols + 20]).toBeCloseTo(1, 2);
    expect(h[20]).toBeCloseTo(0, 2);
    const dark = IMAGE_PATTERN.build(cols, rows, board, { ...o, mapping: 'white-low' });
    expect(dark[(rows - 1) * cols + 20]).toBeCloseTo(0, 2);
  });

  it('reads left to right as the picture does', () => {
    const o = optionsFor(16, 4, (x) => x / 15);
    const h = IMAGE_PATTERN.build(41, 3, board, o);
    expect(h[41]).toBeCloseTo(0, 2);
    expect(h[41 + 40]).toBeCloseTo(1, 2);
    for (let c = 1; c < 41; c++) expect(h[41 + c]).toBeGreaterThanOrEqual(h[41 + c - 1]);
  });

  it('keeps its shape when asked, and leaves the face plain round it', () => {
    // A square white picture on a 40 x 20 mm board: 20 mm wide in the middle.
    const o = optionsFor(8, 8, () => 1, { fit: 'contain' });
    const h = IMAGE_PATTERN.build(41, 21, board, o);
    const row = 10 * 41;
    expect(h[row + 20]).toBe(1);
    expect(h[row + 5]).toBe(0);
    expect(h[row + 35]).toBe(0);
    let lit = 0;
    for (let c = 0; c < 41; c++) if (h[row + c] > 0.5) lit++;
    expect(lit).toBeGreaterThanOrEqual(20);
    expect(lit).toBeLessThanOrEqual(22);
    // Set to 10 mm wide and moved 10 mm right.
    const moved = IMAGE_PATTERN.build(41, 21, board, { ...o, fit: 'width', widthMm: 10, offsetXMm: 10 });
    expect(moved[row + 30]).toBe(1);
    expect(moved[row + 20]).toBe(0);
  });

  it('smooths a hard edge when asked', () => {
    const o = optionsFor(32, 4, (x) => (x < 16 ? 0 : 1));
    const sharp = IMAGE_PATTERN.build(65, 3, board, o);
    const soft = IMAGE_PATTERN.build(65, 3, board, { ...o, blurPx: 3 });
    // A pixel either side of the step, the smoothed one is part way.
    const near = 65 + 28;
    expect(sharp[near]).toBe(0);
    expect(soft[near]).toBeGreaterThan(0.05);
  });
});

describe('a picture on a cylinder', () => {
  // A closed cylinder along z, outward-wound, with shared vertices.
  function cylinder(r: number, hz: number, segments: number) {
    const positions: number[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      positions.push(r * Math.cos(t), r * Math.sin(t), -hz, r * Math.cos(t), r * Math.sin(t), hz);
    }
    const bottom = positions.length / 3;
    positions.push(0, 0, -hz, 0, 0, hz);
    const top = bottom + 1;
    const faces: number[] = [];
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1;
      faces.push(b0, b1, t1, b0, t1, t0, top, t0, t1, bottom, b1, b0);
    }
    return { positions, faces };
  }
  const R = 0.015;
  const cyl = cylinder(R, 0.03, 96);
  // A white band down the middle of the picture, a tenth of its width.
  const band = optionsFor(200, 20, (x) => (Math.abs(x - 99.5) < 10 ? 1 : 0));
  const texture: SurfaceTexture = {
    pattern: 'image', options: band, depthM: 0.001, cellM: 0.0008,
    seedAt: [R, 0, 0], seedNormal: [1, 0, 0], maxTiltDeg: 180,
  };

  it('goes round once, its middle on the point picked, raised by the depth', () => {
    const out = applySurfaceTextures(cyl.positions, cyl.faces, [texture]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.projection).toBe('cylindrical');
    expect(r.wrap).toEqual({ scaled: 1, blended: false });
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed && check.consistentlyWound && check.volume > 0).toBe(true);
    // Round the middle of the side: proud by 1 mm at the pick (+x), plain opposite.
    let atPick = 0, opposite = Infinity;
    for (let i = 0; i < out.vertices.length; i += 3) {
      const [x, y, z] = [out.vertices[i], out.vertices[i + 1], out.vertices[i + 2]];
      if (Math.abs(z) > 0.002) continue;
      const a = Math.atan2(y, x), rr = Math.hypot(x, y);
      if (Math.abs(a) < 0.05) atPick = Math.max(atPick, rr);
      if (Math.abs(Math.abs(a) - Math.PI) < 0.3) opposite = Math.min(opposite, rr);
    }
    expect(atPick).toBeCloseTo(R + 0.001, 4);
    expect(opposite).toBeCloseTo(R, 4);
    // The band is a tenth of the way round: about 9.4 mm of a 94 mm circumference.
    let proud = 0, ring = 0;
    for (let i = 0; i < out.vertices.length; i += 3) {
      const [x, y, z] = [out.vertices[i], out.vertices[i + 1], out.vertices[i + 2]];
      if (Math.abs(z) > 0.0005) continue;
      ring++;
      if (Math.hypot(x, y) > R + 0.0005) proud++;
    }
    expect(proud / ring).toBeGreaterThan(0.07);
    expect(proud / ring).toBeLessThan(0.14);
  });
});

describe('the cache key', () => {
  it('stands for the picture by a tag, not by its whole base64', () => {
    const geom = { name: 'g', type: 'box', size: [0.01, 0.01, 0.01] } as SceneGeom;
    const a = optionsFor(400, 400, (x, y) => ((x ^ y) & 1 ? 1 : 0));
    const b = optionsFor(400, 400, (x, y) => ((x ^ y) & 2 ? 1 : 0));
    const key = (o: Record<string, unknown>) =>
      texturedSurfaceKey({ ...geom, textures: [{ pattern: 'image', options: o, depthM: 0.001, seedAt: [0, 0, 0.01], seedNormal: [0, 0, 1] } as SurfaceTexture] });
    expect(key(a).length).toBeLessThan(1000);
    expect(key(a)).not.toBe(key(b));
    expect(key(a)).toBe(key({ ...a }));
  });
});
