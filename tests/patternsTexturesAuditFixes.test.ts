import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMmSvg, tileSvgForHomePrint } from '../src/utils/tiledPaperPrint';
import { decodeImageGrid, IMAGE_PATTERN, imageGridOptions } from '../src/utils/imagePattern';
import { applySurfaceTextures } from '../src/utils/surfaceTexture';
import { clamp01, normaliseGrid } from '../src/utils/patternNoise';
import { patternById } from '../src/utils/surfacePatterns';
import { buildLaidOut, fadeToEdge, soften } from '../src/utils/patternLayout';
import { baseSurfaceKey, texturedSurfaceKey } from '../src/utils/geomSurface';
import type { SceneGeom } from '../src/types/scene';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function extractDiamondCenters(svg: string): Array<[number, number]> {
  const centers: Array<[number, number]> = [];
  const re = /<polygon points="([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+),([-\d.]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const cx = (parseFloat(m[3]) + parseFloat(m[7])) / 2;
    const cy = (parseFloat(m[2]) + parseFloat(m[6])) / 2;
    centers.push([Number(cx.toFixed(2)), Number(cy.toFixed(2))]);
  }
  return centers;
}

describe('Section 4B audit fixes: 2D Tiled Print', () => {
  it('P0 #1: places mating registration diamonds at identical source coordinates across adjacent sheets', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400mm" height="550mm" viewBox="0 0 400 550"><rect x="0" y="0" width="400" height="550"/></svg>`;
    const doc = tileSvgForHomePrint(svg, { paper: 'a4', title: 'Test Pattern' });
    expect(doc.cols).toBeGreaterThanOrEqual(2);
    expect(doc.rows).toBeGreaterThanOrEqual(2);

    const mx = doc.paper.marginMm;
    const my = doc.paper.marginMm;
    const toSource = (page: (typeof doc.pages)[number], pt: [number, number]): [number, number] => [
      Number((page.srcX + (pt[0] - mx)).toFixed(2)),
      Number((page.srcY + (pt[1] - my)).toFixed(2)),
    ];

    const p00 = doc.pages.find((p) => p.row === 1 && p.col === 1)!;
    const p01 = doc.pages.find((p) => p.row === 1 && p.col === 2)!;
    const p10 = doc.pages.find((p) => p.row === 2 && p.col === 1)!;
    const p11 = doc.pages.find((p) => p.row === 2 && p.col === 2)!;

    // Diamonds are emitted in order: TL, TR, BL, BR.
    const d00 = extractDiamondCenters(p00.svg);
    const d01 = extractDiamondCenters(p01.svg);
    const d10 = extractDiamondCenters(p10.svg);
    const d11 = extractDiamondCenters(p11.svg);
    expect(d00).toHaveLength(4);

    // Horizontal seam: p00 TR === p01 TL, and p00 BR === p01 BL in source mm.
    expect(toSource(p00, d00[1])).toEqual(toSource(p01, d01[0]));
    expect(toSource(p00, d00[3])).toEqual(toSource(p01, d01[2]));

    // Vertical seam: p00 BL === p10 TL, and p00 BR === p10 TR in source mm.
    expect(toSource(p00, d00[2])).toEqual(toSource(p10, d10[0]));
    expect(toSource(p00, d00[3])).toEqual(toSource(p10, d10[1]));

    // 4-way corner: all 4 sheets' interior corner diamonds land on the exact same source point.
    const sharedCorner = toSource(p00, d00[3]);
    expect(toSource(p01, d01[2])).toEqual(sharedCorner);
    expect(toSource(p10, d10[1])).toEqual(sharedCorner);
    expect(toSource(p11, d11[0])).toEqual(sharedCorner);

    // Outer edges stay at the printable margin (mx, my).
    expect(d00[0]).toEqual([mx, my]);
  });

  it('P2 #7: parseMmSvg handles XML prologs, comma viewBox, and non-zero minX/minY', () => {
    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- exported pattern -->',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-25.5, 10, 120, 80">',
      '  <rect x="-25.5" y="10" width="120" height="80"/>',
      '</svg>',
    ].join('\n');

    const parsed = parseMmSvg(svg);
    expect(parsed.minX).toBeCloseTo(-25.5);
    expect(parsed.minY).toBeCloseTo(10);
    expect(parsed.widthMm).toBe(120);
    expect(parsed.heightMm).toBe(80);
    expect(parsed.inner).not.toContain('<svg');
    expect(parsed.inner).toContain('<rect x="-25.5" y="10" width="120" height="80"/>');

    const doc = tileSvgForHomePrint(svg, { paper: 'a4' });
    // mx = 12, srcX = 0, minX = -25.5 => translate X = 37.5; my = 12, srcY = 0, minY = 10 => translate Y = 2.
    expect(doc.pages[0].svg).toContain('transform="translate(37.5, 2)"');
  });
});

describe('Section 4B audit fixes: Image Pattern', () => {
  it('P1 #5: decodeImageGrid catches malformed base64 and keys cache on dimensions', () => {
    expect(decodeImageGrid({ imageGrid: '!!!not-valid-base64!!!', imageW: 2, imageH: 2 })).toBeNull();

    // 6 bytes = 2x3 or 3x2: changing imageW/imageH with the same base64 must not return stale dimensions.
    const b64 = btoa(String.fromCharCode(0, 64, 128, 192, 255, 100));
    const g23 = decodeImageGrid({ imageGrid: b64, imageW: 2, imageH: 3 });
    expect(g23?.width).toBe(2);
    expect(g23?.height).toBe(3);

    const g32 = decodeImageGrid({ imageGrid: b64, imageW: 3, imageH: 2 });
    expect(g32?.width).toBe(3);
    expect(g32?.height).toBe(2);
  });

  it('P1 #4: imagePattern guards zero-extent faces and caps supersampling', () => {
    const rgba = new Uint8ClampedArray(16 * 16 * 4).fill(255);
    const opts = imageGridOptions(rgba, 16, 16);

    // Zero extent must return finite zeros (no NaN / division by zero).
    const zeroOut = IMAGE_PATTERN.build(8, 8, { widthM: 0, depthM: 0.1 }, { ...IMAGE_PATTERN.defaults, ...opts, fit: 'stretch' });
    expect(Array.from(zeroOut).every((v) => Number.isFinite(v) && v === 0)).toBe(true);

    // Tiny widthMm on a huge face must finish quickly with capped supersampling.
    const t0 = performance.now();
    const out = IMAGE_PATTERN.build(
      128,
      128,
      { widthM: 2.0, depthM: 2.0 },
      { ...IMAGE_PATTERN.defaults, ...opts, fit: 'width', widthMm: 0.1 }
    );
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(Array.from(out).every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('Section 4B audit fixes: Surface Texture & Pattern Generators', () => {
  it('P1 #6: applySurfaceTextures skips degenerate zero-area faces without RangeError', () => {
    // Degenerate collinear triangles (zero area)
    const positions = [0, 0, 0, 0.1, 0, 0, 0.2, 0, 0];
    const faces = [0, 1, 2];
    const res = applySurfaceTextures(positions, faces, [
      { pattern: 'knurl', depthM: -0.001, seedAt: [0.05, 0, 0], seedNormal: [0, 0, 1] },
    ]);
    expect(res.regions).toHaveLength(1);
    expect(res.regions[0].applied).toBe(false);
  });

  it('P2 #9: thaiTiles avoids NaN at zero inner radius, and clamp01/normaliseGrid sanitize non-finite values', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1.5)).toBe(1);

    const dirty = new Float32Array([NaN, 2, Infinity, 6, -Infinity]);
    normaliseGrid(dirty);
    expect(Array.from(dirty)).toEqual([0, 0, 0, 1, 0]);

    const thai = patternById('thai_tiles')!;
    const grid = thai.build(
      32,
      32,
      { widthM: 0.1, depthM: 0.1 },
      { ...thai.defaults, tileMm: 100, borderMm: 49.25, gutterMm: 1.5, layoutAlign: 'free' }
    );
    expect(Array.from(grid).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  });

  it('P2 #10: masonry Flemish bond has consistent course parity across y = 0 under centre alignment', () => {
    const masonry = patternById('masonry')!;
    // Zero jitter so courses with identical parity have identical horizontal profiles.
    const cols = 121;
    const rows = 41;
    const grid = masonry.build(
      cols,
      rows,
      { widthM: 0.18, depthM: 0.10 },
      {
        ...masonry.defaults,
        brickLengthMm: 60,
        brickHeightMm: 20,
        mortarMm: 5,
        bond: 'flemish',
        jitter: 0,
        layoutAlign: 'centre',
      }
    );
    // With y in [-0.05, +0.05] and courseH = 0.025:
    // r = 15 => y = -0.0125 (middle of course -1, odd)
    // r = 35 => y = +0.0375 (middle of course +1, odd)
    // Both odd courses must have the exact same horizontal brick/mortar layout.
    let maxDiff = 0;
    for (let c = 0; c < cols; c++) {
      maxDiff = Math.max(maxDiff, Math.abs(grid[15 * cols + c] - grid[35 * cols + c]));
    }
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('P2 #12: patternLayout.buildLaidOut uses separate cellX and cellY on anisotropic grids', () => {
    const flatZero = {
      id: 'test-flat',
      label: 'Test',
      blurb: '',
      defaults: {},
      fields: [],
      build: (c: number, r: number) => new Float32Array(c * r),
    };
    // 101x21 grid over 100mm x 100mm => cellX = 1mm, cellY = 5mm.
    // A 10mm frame should be 10 cols on left/right and 2 rows on top/bottom.
    const framed = buildLaidOut(flatZero, 101, 21, { widthM: 0.1, depthM: 0.1 }, { frameMm: 10, frameStyle: 'plain' });
    // Row 1 (y = 5mm < 10mm) is inside top frame => 1.
    expect(framed[1 * 101 + 50]).toBe(1);
    // Row 2 (y = 10mm) at col 50 (x = 50mm) is inside the pattern => 0.
    expect(framed[2 * 101 + 50]).toBe(0);
    // Row 10 at col 9 (x = 9mm < 10mm) is inside left frame => 1; col 10 is inside pattern => 0.
    expect(framed[10 * 101 + 9]).toBe(1);
    expect(framed[10 * 101 + 10]).toBe(0);

    // Anisotropic fadeToEdge and soften accept separate X/Y parameters cleanly.
    const g = new Float32Array(11 * 11);
    fadeToEdge(g, 11, 11, 4, 1);
    expect(g[1 * 11 + 5]).toBe(0); // row 1 >= cellsY=1, col 5 >= cellsX=4 => unfaded
    expect(g[5 * 11 + 1]).toBeGreaterThan(0); // col 1 < cellsX=4 => faded
    const blurred = soften(g, 11, 11, 2, 0);
    expect(blurred.length).toBe(121);
  });

  it('P2 #13: foliage bounding-box rasterizer finishes rapidly at max iterations (11)', () => {
    const foliage = patternById('foliage')!;
    const t0 = performance.now();
    const grid = foliage.build(
      180,
      180,
      { widthM: 0.2, depthM: 0.2 },
      { ...foliage.defaults, iterations: 11, seed: 7, layoutAlign: 'free' }
    );
    expect(performance.now() - t0).toBeLessThan(1500);
    let maxVal = 0;
    for (let i = 0; i < grid.length; i++) {
      expect(Number.isFinite(grid[i])).toBe(true);
      if (grid[i] > maxVal) maxVal = grid[i];
    }
    expect(maxVal).toBeGreaterThan(0.5);
  });

  it('P3 #17: baseSurfaceKey ignores texture edits while tracking shape and faceSplits', () => {
    const baseGeom: SceneGeom = {
      name: 'box1',
      type: 'box',
      size: [0.05, 0.05, 0.05],
      textures: [{ pattern: 'knurl', depthM: -0.001, seedAt: [0, 0, 0.05] }],
    };
    const editedTex: SceneGeom = {
      ...baseGeom,
      textures: [{ pattern: 'fluted', depthM: -0.002, seedAt: [0, 0, 0.05] }],
    };
    const splitGeom: SceneGeom = {
      ...baseGeom,
      faceSplits: [{ at: [0, 0, 0.05], normal: [1, 0, 0], seeds: [[0, 0, 0.05]] }],
    };
    expect(baseSurfaceKey(baseGeom)).toBe(baseSurfaceKey(editedTex));
    expect(texturedSurfaceKey(baseGeom)).not.toBe(texturedSurfaceKey(editedTex));
    expect(baseSurfaceKey(baseGeom)).not.toBe(baseSurfaceKey(splitGeom));
  });
});

describe('Section 4B audit fixes: Worker Clients', () => {
  it('P1 #3 & P2 #8: textureClient propagates errors, supersedes queued same-geom jobs, and drops worker on postMessage throw', async () => {
    vi.resetModules();
    let failNextPost = false;
    class FakeTexWorker {
      static instances: FakeTexWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeTexWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) {
        if (failNextPost) {
          failNextPost = false;
          throw new Error('DataCloneError');
        }
        this.sent.push(msg);
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeTexWorker);

    const { requestTexturedSurfaceWithStatus } = await import('../src/utils/textureClient');
    const makeGeom = (depthM: number): SceneGeom => ({
      name: 'panel',
      type: 'box',
      size: [0.05, 0.05, 0.05],
      textures: [{ pattern: 'knurl', depthM, seedAt: [0, 0, 0.05] }],
    });

    // 1) Active job + two queued jobs for the same geom name -> middle job superseded.
    const p1 = requestTexturedSurfaceWithStatus(makeGeom(-0.001));
    const p2 = requestTexturedSurfaceWithStatus(makeGeom(-0.002));
    const p3 = requestTexturedSurfaceWithStatus(makeGeom(-0.003));

    // p2 was superseded in the queue before ever reaching the worker.
    await expect(p2).resolves.toEqual({ surface: null, error: null });

    const w1 = FakeTexWorker.instances[0];
    expect(w1.sent).toHaveLength(1);
    // Fail p1 with TEXTURE_FAILED -> error propagated cleanly.
    w1.onmessage?.({ data: { type: 'TEXTURE_FAILED', id: w1.sent[0].id, error: 'Mesh folded' } } as MessageEvent);
    await expect(p1).resolves.toEqual({ surface: null, error: 'Mesh folded' });

    // p3 should now be sent to w1 (skipping superseded p2).
    expect(w1.sent).toHaveLength(2);
    w1.onmessage?.({
      data: {
        type: 'TEXTURE_DONE',
        id: w1.sent[1].id,
        packed: {
          vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          faces: new Uint32Array([0, 1, 2]),
          regions: [],
          warnings: [],
        },
      },
    } as MessageEvent);
    const res3 = await p3;
    expect(res3.error).toBeNull();
    expect(res3.surface?.vertices).toBeInstanceOf(Float64Array);
    expect(res3.surface?.faces).toBeInstanceOf(Uint32Array);

    // 2) postMessage throw drops & terminates the worker and propagates error.
    failNextPost = true;
    const p4 = requestTexturedSurfaceWithStatus(makeGeom(-0.004));
    await expect(p4).resolves.toEqual({ surface: null, error: 'DataCloneError' });
    expect(w1.terminated).toBe(true);
  });

  it('P3 #18: silhouetteClient drops worker when postMessage throws', async () => {
    vi.resetModules();
    class FailingPostWorker {
      static instances: FailingPostWorker[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FailingPostWorker.instances.push(this); }
      postMessage() {
        throw new Error('postMessage failed');
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FailingPostWorker);

    const { bestViewOffThread } = await import('../src/utils/silhouetteClient');
    const tris = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const photo = new Uint8Array(64);
    await expect(bestViewOffThread(tris, photo)).rejects.toThrow('postMessage failed');
    expect(FailingPostWorker.instances[0].terminated).toBe(true);
  });
});
